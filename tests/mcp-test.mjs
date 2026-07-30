/**
 * Le catalogue MCP : lecture des manifestes, etat reel, et forme constante.
 *
 * Ce qui se figerait mal autrement : un lecteur YAML ecrit a la main pour quatre
 * formes, et deux chemins de lecture (montage, socket Docker) qui doivent rendre
 * exactement la meme structure. Un champ present d'un cote et absent de l'autre,
 * et la page s'arrete sur un `undefined`.
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = '/tmp/ah-mcp-' + Date.now();
fs.mkdirSync(path.join(DIR, 'cat'), { recursive: true });
fs.mkdirSync(path.join(DIR, 'home'), { recursive: true });
process.env.HERMES_MCP_DIR = path.join(DIR, 'cat');
process.env.HERMES_HOME_DIR = path.join(DIR, 'home');

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { console.log(`✓ ${label}`); pass++; }
  else { console.log(`✗ ${label}${extra ? '\n    ' + extra : ''}`); fail++; }
};

const write = (name, body) => {
  fs.mkdirSync(path.join(DIR, 'cat', name), { recursive: true });
  fs.writeFileSync(path.join(DIR, 'cat', name, 'manifest.yaml'), body);
};

// Les quatre formes que les manifestes reels emploient, et rien de plus.
write('blender', `manifest_version: 1
name: blender
description: Pilote une session Blender.
source: https://github.com/ahujasid/blender-mcp
transport:
  type: stdio
  command: "uvx"
  args:
    - "blender-mcp==1.6.4"
  version: "1.6.4"
  env:
    DISABLE_TELEMETRY: "true"
auth:
  type: none
tools:
  default_enabled:
    - get_scene_info
    - execute_blender_code
post_install: |
  Ouvre Blender AVANT la session.
    1. Installe addon.py
  Fin.
`);
write('linear', `name: linear
description: Gere les tickets Linear.
transport:
  type: http
  url: https://mcp.linear.app/mcp
auth:
  type: oauth
`);
write('n8n', `name: n8n
description: Inspecte les flux n8n.
transport:
  type: stdio
  command: "python"
  args:
    - "server.py"
install:
  type: git
  url: https://example.invalid/x.git
auth:
  type: api_key
  env:
    - name: N8N_BASE_URL
    - name: N8N_API_KEY
`);

const { parseYaml, mcpCatalogue, invalidateMcp } = await import('/app/mcp.js');

// ---- le lecteur YAML -------------------------------------------------------
const y = parseYaml(fs.readFileSync(path.join(DIR, 'cat', 'blender', 'manifest.yaml'), 'utf8'));
ok('un scalaire est lu', y.name === 'blender');
ok('les guillemets sont retirés', y.transport.command === 'uvx');
ok('UNE MAP IMBRIQUÉE EST LUE', y.transport && y.transport.type === 'stdio');
ok('une liste est lue', Array.isArray(y.transport.args) && y.transport.args[0] === 'blender-mcp==1.6.4');
ok('une map dans une map est lue', y.transport.env.DISABLE_TELEMETRY === 'true');
ok('UN BLOC LITTÉRAL GARDE SES LIGNES',
  y.post_install.split('\n').length === 3 && /^Ouvre Blender/.test(y.post_install), JSON.stringify(y.post_install));
ok('et son indentation relative', /^ {2}1\. Installe/m.test(y.post_install), JSON.stringify(y.post_install));
ok('un commentaire est ignoré', !('#' in y));

// ---- le catalogue, sans configuration --------------------------------------
let r = await mcpCatalogue();
ok('les trois manifestes sont lus', r.servers.length === 3, `${r.servers.length}`);
ok('lus par le montage', r.via === 'montage', r.via);
ok('aucune configuration détectée', r.configVia === 'aucune-config', r.configVia);
ok('donc rien de branché', r.counts.installed === 0 && r.counts.enabled === 0);

const par = Object.fromEntries(r.servers.map((s) => [s.id, s]));
ok('UN TRANSPORT STDIO MONTRE SA COMMANDE', par.blender.endpoint === 'uvx blender-mcp==1.6.4', par.blender.endpoint);
ok('UN TRANSPORT HTTP MONTRE SON URL', par.linear.endpoint === 'https://mcp.linear.app/mcp', par.linear.endpoint);
ok('les variables à renseigner sont nommées, jamais leurs valeurs',
  par.n8n.authEnv.join(',') === 'N8N_BASE_URL,N8N_API_KEY', JSON.stringify(par.n8n.authEnv));
ok('une valeur d\'environnement ne traverse pas',
  !JSON.stringify(r).includes('DISABLE_TELEMETRY') || !JSON.stringify(r).includes('"true"'));
ok('le mode d\'installation est signalé', par.n8n.install === 'git');
ok('les outils par défaut sont listés', par.blender.defaultTools.length === 2);

// ---- avec une configuration ------------------------------------------------
fs.writeFileSync(path.join(DIR, 'home', 'config.yaml'), `model: opus
mcp_servers:
  blender:
    enabled: true
  linear:
    enabled: false
  touchdesigner:
    transport:
      type: stdio
`);
invalidateMcp();
r = await mcpCatalogue();
const p2 = Object.fromEntries(r.servers.map((s) => [s.id, s]));
ok('LA CONFIGURATION EST LUE', r.configVia === 'lu', r.configVia);
ok('un serveur branché et actif est reconnu', p2.blender.installed && p2.blender.enabled);
ok('UN SERVEUR MIS EN PAUSE SE DISTINGUE', p2.linear.installed && !p2.linear.enabled);
ok('un serveur non branché reste au catalogue', !p2.n8n.installed);
ok('UN SERVEUR HORS CATALOGUE APPARAÎT QUAND MÊME',
  Boolean(p2.touchdesigner) && p2.touchdesigner.offCatalogue === true);
ok('et il a la MÊME forme que les autres',
  ['endpoint', 'authEnv', 'defaultTools', 'install', 'auth'].every((k) => k in p2.touchdesigner),
  Object.keys(p2.touchdesigner).join(','));
ok('les comptes suivent', r.counts.installed === 3 && r.counts.enabled === 2, JSON.stringify(r.counts));
ok('les branchés passent devant', r.servers[0].installed === true);

// ---- rien à lire -----------------------------------------------------------
// Les chemins sont figés à l'import du module : on vide donc les dossiers plutôt
// que de changer les variables d'environnement, qui ne seraient plus relues.
for (const n of ['blender', 'linear', 'n8n']) {
  fs.rmSync(path.join(DIR, 'cat', n), { recursive: true, force: true });
}
fs.rmSync(path.join(DIR, 'home', 'config.yaml'), { force: true });
invalidateMcp();
r = await mcpCatalogue();
ok('SANS RIEN À LIRE, LA PAGE LE DIT AU LIEU DE MENTIR',
  r.via === 'indisponible' && r.servers.length === 0, `${r.via} / ${r.servers.length}`);
ok('et un dossier présent mais vide ne se confond pas avec une lecture ratée',
  r.configVia === 'aucune-config', r.configVia);

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* verrou */ }
process.exit(fail ? 1 : 0);
