/**
 * L'aperçu d'un site, de bout en bout, par HTTP.
 *
 * Cette fonctionnalité a cassé deux fois de suites, et chaque fois d'une manière
 * qu'aucun test unitaire n'aurait vue : une politique de sécurité qui refuse la
 * feuille de style sans un mot, un chemin absolu qui pointe vers la racine du
 * serveur au lieu du site. Les deux ne se voient qu'en demandant vraiment les
 * fichiers au vrai serveur. Le test démarre donc l'application et l'interroge.
 *
 * Ce qu'il fige, dans l'ordre d'importance :
 *
 * - un site à modules tourne sans étape de construction : dépendances par nom
 *   résolues, feuille de style importée par un script réinjectée, chemins
 *   absolus ramenés vers le site ;
 * - l'isolation tient : rien ne sort, et on ne remonte pas hors du site.
 */
import fs from 'node:fs';

const DATA_DIR = '/tmp/ah-preview-' + Date.now();
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.APP_PASSWORD = 'sonde-apercu';
process.env.PORT = '8757';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { console.log(`✓ ${label}`); pass++; }
  else { console.log(`✗ ${label}${extra ? '\n    ' + extra : ''}`); fail++; }
};

await import('/app/server.js');
await new Promise((r) => setTimeout(r, 700));

const ROOT = 'http://127.0.0.1:8757';
let cookie = '';
const get = (path, init = {}) => fetch(ROOT + path, { ...init, headers: { cookie, ...(init.headers || {}) } });

// ---- session ---------------------------------------------------------------
const login = await fetch(`${ROOT}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'sonde-apercu' }),
});
cookie = (login.headers.get('set-cookie') || '').split(';')[0];
ok('le serveur démarre et ouvre une session', login.status === 200 && cookie.startsWith('ah_session='));

// ---- un site tel qu'un agent l'écrit --------------------------------------
// index.html minuscule, tout construit par un module, dépendances par nom, et un
// chemin absolu depuis la racine : la forme exacte que produit un outil moderne.
const SITE = [
  {
    path: 'package.json',
    content: JSON.stringify({ dependencies: { three: '^0.169.0' }, devDependencies: { vite: '^5.4.0' } }),
  },
  {
    path: 'index.html',
    content: '<!doctype html><html><head><title>S</title>'
      + '<link rel="stylesheet" href="/theme.css"></head>'
      + '<body><a class="skip" href="#m">Aller au contenu</a><div id="app"></div>'
      + '<script src="/legacy.js"></script>'
      + '<script type="module" src="/src/main.js"></script></body></html>',
  },
  { path: 'theme.css', content: 'body{background:#0b0d10}' },
  { path: 'legacy.js', content: 'window.LEGACY = 1;' },
  { path: 'src/styles.css', content: '.tag{color:#b7f34a}' },
  {
    path: 'src/main.js',
    content: "import * as THREE from 'three';\nimport './styles.css';\nimport { helper } from '/src/util.js';\n"
      + "document.querySelector('#app').textContent = THREE.REVISION + helper();\n",
  },
  { path: 'src/util.js', content: 'export const helper = () => "ok";' },
];

const reg = await get('/api/preview', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ files: SITE }),
});
const site = await reg.json();
ok('le site est accepté', reg.status === 200 && site.files.length === 7, JSON.stringify(site).slice(0, 160));
ok('la page d\'entrée est index.html', site.entry === 'index.html', site.entry);
ok('LES DÉPENDANCES PAR NOM SONT SIGNALÉES',
  (site.notes || []).some((n) => /esm\.sh/.test(n) && /three/.test(n)), JSON.stringify(site.notes));
ok('la feuille importée par un module est signalée',
  (site.notes || []).some((n) => /style/i.test(n)), JSON.stringify(site.notes));

// ---- la page servie --------------------------------------------------------
const pageRes = await get(site.url);
const page = await pageRes.text();
ok('la page se sert', pageRes.status === 200 && /text\/html/.test(pageRes.headers.get('content-type')));

const map = page.match(/<script type="importmap">(.*?)<\/script>/s);
ok('UNE CARTE D\'IMPORTS EST POSÉE', Boolean(map), page.slice(0, 200));
if (map) {
  const imports = JSON.parse(map[1]).imports;
  ok('elle vise esm.sh avec la version déclarée', imports.three === 'https://esm.sh/three@0.169.0', imports.three);
  ok('et couvre les sous-chemins du paquet', imports['three/'] === 'https://esm.sh/three@0.169.0/', imports['three/']);
  ok('ELLE PRÉCÈDE LE MODULE QUI EN A BESOIN',
    page.indexOf('importmap') < page.indexOf('src/main.js'));
}

ok('UN CHEMIN ABSOLU EST RAMENÉ VERS LE SITE',
  /src=["']src\/main\.js["']/.test(page) && !/src=["']\/src\/main\.js["']/.test(page),
  (page.match(/src=["'][^"']*main\.js["']/) || ['aucun'])[0]);
ok('un module reste une requête, jamais mis en ligne',
  /<script[^>]*type=["']module["'][^>]*src=/.test(page));
ok('la feuille de style de la page est mise en ligne',
  page.includes('background:#0b0d10') && !/<link[^>]*stylesheet/i.test(page));
ok('un script classique est mis en ligne', page.includes('window.LEGACY = 1;'));
ok('LA FEUILLE IMPORTÉE PAR LE MODULE ENTRE DANS LA PAGE', page.includes('.tag{color:#b7f34a}'));

// ---- le module servi -------------------------------------------------------
const modRes = await get(`/api/preview/${site.id}/src/main.js`);
const mod = await modRes.text();
ok('le module se sert comme du JavaScript',
  /javascript/.test(modRes.headers.get('content-type') || ''), modRes.headers.get('content-type'));
ok('L\'IMPORT DE FEUILLE DE STYLE EST RETIRÉ', !/\.css/.test(mod), mod.slice(0, 120));
ok('l\'import par nom est conservé tel quel', /from 'three'/.test(mod));
ok('un import absolu est ramené au bon niveau', /from '\.\.\/src\/util\.js'/.test(mod),
  (mod.match(/from '[^']*util[^']*'/) || ['aucun'])[0]);

// ---- la politique servie ---------------------------------------------------
const csp = pageRes.headers.get('content-security-policy') || '';
ok('RIEN NE PEUT SORTIR DE L\'APERÇU', /connect-src 'none'/.test(csp), csp.slice(0, 120));
ok('les bibliothèques publiques sont autorisées', /esm\.sh/.test(csp) && /cdn\.jsdelivr\.net/.test(csp));

// Une texture refusée laissait un site noir sans le moindre message. Les
// ressources inertes viennent donc d'où le site les demande — le code, non.
ok('UNE IMAGE PEUT VENIR DE N\'IMPORTE QUEL HÔTE',
  /img-src[^;]*\bhttps:/.test(csp), (csp.match(/img-src[^;]*/) || [''])[0]);
ok('les polices et les sons aussi',
  /font-src[^;]*\bhttps:/.test(csp) && /media-src[^;]*\bhttps:/.test(csp));
ok('MAIS LE CODE RESTE LIMITÉ À LA LISTE NOMMÉE',
  !/script-src[^;]*\bhttps:\s/.test(csp) && /script-src[^;]*cdn\.jsdelivr\.net/.test(csp),
  (csp.match(/script-src[^;]*/) || [''])[0]);
ok('notre origine est nommée sans schéma, pour ne pas dépendre du proxy',
  csp.includes(`127.0.0.1:8757/api/preview/${site.id}/`)
  && !csp.includes(`http://127.0.0.1:8757/api/preview/${site.id}/`),
  (csp.match(/script-src[^;]*/) || [''])[0]);
ok('l\'aperçu peut être encadré par nous seuls',
  pageRes.headers.get('x-frame-options') === 'SAMEORIGIN' && /frame-ancestors 'self'/.test(csp));
ok('rien n\'est mis en cache', /no-store/.test(pageRes.headers.get('cache-control') || ''));

// ---- on ne sort pas du site ------------------------------------------------
const evade = await get(`/api/preview/${site.id}/..%2f..%2fserver.js`);
const evadeBody = await evade.text();
ok('ON NE REMONTE PAS HORS DU SITE',
  evade.status === 404 && !/express|requireAuth/.test(evadeBody), `HTTP ${evade.status}`);

const absent = await get(`/api/preview/${site.id}/inexistant.css`);
ok('un fichier absent le dit clairement', absent.status === 404);

const expire = await get('/api/preview/pv_jamaisvu/index.html');
ok('un aperçu expiré le dit clairement',
  expire.status === 404 && /expir/i.test(await expire.text()));

// ---- la carte du site fait autorité ----------------------------------------
// Une page n'accepte qu'une seule carte d'imports : la seconde est ignorée.
// Poser la nôtre par-dessus celle de l'agent effaçait donc la sienne — et la
// sienne était juste, sous-chemins compris, ce que nous ne savons pas deviner.
// Le site restait bloqué à 0 %, son script n'ayant jamais pu se charger.
const SIEN = [
  {
    path: 'index.html',
    content: '<!doctype html><html><head><script type="importmap">'
      + '{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",'
      + '"three/addons/":"https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"}}</script>'
      + '</head><body><div id="l">0%</div>'
      + '<script type="module" src="src/app.js"></script></body></html>',
  },
  {
    path: 'src/app.js',
    content: "import * as THREE from 'three';\n"
      + "import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';\n"
      + "document.querySelector('#l').textContent = '100%';\n",
  },
];
const own = await get('/api/preview', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ files: SIEN }),
});
const ownPv = await own.json();
ok('une carte déjà écrite est reconnue',
  (ownPv.notes || []).some((n) => /respectée/.test(n)), JSON.stringify(ownPv.notes));

const ownPage = await (await get(ownPv.url)).text();
const nbMaps = (ownPage.match(/<script type="importmap">/g) || []).length;
ok('LA PAGE NE PORTE QU\'UNE SEULE CARTE D\'IMPORTS', nbMaps === 1, `${nbMaps} carte(s)`);
ok('ET C\'EST CELLE DU SITE',
  ownPage.includes('cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/') && !ownPage.includes('esm.sh'),
  (ownPage.match(/<script type="importmap">[^<]{0,120}/) || [''])[0]);

// ---- une page seule reste possible ----------------------------------------
const one = await get('/api/preview', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ html: '<!doctype html><h1>seul</h1>' }),
});
const onePv = await one.json();
ok('une page unique fonctionne encore', one.status === 200 && onePv.entry === 'index.html');
ok('et se sert telle quelle', (await (await get(onePv.url)).text()).includes('<h1>seul</h1>'));

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* verrou */ }
process.exit(fail ? 1 : 0);
