// Détection et installation d'Hermes Agent.
//
// Deux niveaux, volontairement séparés.
//
// **Détection** — toujours active, sans aucun privilège. AgentHub sonde les
// noms d'hôte usuels sur son réseau Docker et reconnaît une passerelle Hermes
// à sa réponse. C'est suffisant pour dire « il est là » ou « il n'y est pas ».
//
// **Installation** — nécessite le socket Docker, et le socket Docker équivaut à
// donner les droits root sur l'hôte au conteneur qui l'obtient : qui peut
// parler à ce socket peut démarrer un conteneur privilégié montant `/`. C'est
// pour ça que ce n'est PAS activé par défaut, que docker-compose.yml le laisse
// commenté avec l'avertissement, et que l'interface propose toujours la voie
// manuelle en premier. Quand le socket est là, AgentHub s'en sert aussi pour
// lire l'`API_SERVER_KEY` du Hermes déjà installé — la valeur qu'on passe
// sinon dix minutes à chercher.
//
// Rien n'est fait par surprise : aucune installation ne démarre sans un appel
// explicite déclenché par un clic.

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';

const SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const API = 'v1.43';                    // largement compatible, Docker négocie à la baisse
const HERMES_IMAGE = process.env.HERMES_IMAGE || 'nousresearch/hermes-agent:latest';
const HERMES_PORT = 8642;

// Noms sous lesquels une passerelle Hermes se présente le plus souvent. Servent
// à la détection sans socket, et à choisir un nom libre à l'installation.
const CANDIDATE_HOSTS = ['hermes-agent', 'hermes', 'hermes-gateway', 'hermes-agent-1'];

// ---- dialogue avec le moteur Docker ----------------------------------------

function dockerRequest(method, path, body, { stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      socketPath: SOCKET,
      path: `/${API}${path}`,
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: stream ? 600000 : 20000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          let message = data.slice(0, 300);
          try { message = JSON.parse(data).message || message; } catch { /* texte brut */ }
          const err = new Error(message);
          err.status = res.statusCode;
          return reject(err);
        }
        if (!data) return resolve(null);
        // Le flux de `images/create` est une suite d'objets JSON, pas un JSON.
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('le moteur Docker ne répond pas')));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Le socket est-il monté, et le moteur répond-il ? */
export async function dockerStatus() {
  if (!fs.existsSync(SOCKET)) {
    return {
      available: false,
      reason: 'socket-absent',
      detail: `Le socket Docker n'est pas monté dans le conteneur (${SOCKET}).`,
    };
  }
  try {
    const v = await dockerRequest('GET', '/version');
    return { available: true, version: v.Version, api: v.ApiVersion };
  } catch (err) {
    return {
      available: false,
      reason: 'socket-refuse',
      detail: `Le socket existe mais le moteur refuse : ${err.message}`,
    };
  }
}

// ---- détection --------------------------------------------------------------

/**
 * Une passerelle Hermes répond-elle à cette adresse ?
 *
 * Un 401 vaut une découverte : le service est là, il réclame simplement une
 * clé. C'est même le cas le plus fréquent, et le confondre avec une absence
 * enverrait l'utilisateur réinstaller ce qu'il a déjà.
 */
async function probeHttp(baseUrl, timeoutMs = 2500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${baseUrl}/v1/models`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (r.status === 401 || r.status === 403) return { alive: true, needsKey: true };
    if (r.ok) {
      let models = [];
      try {
        const j = await r.json();
        models = (j.data || j.models || []).map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean);
      } catch { /* peu importe */ }
      return { alive: true, needsKey: false, models };
    }
    return { alive: false };
  } catch {
    clearTimeout(timer);
    return { alive: false };
  }
}

/**
 * Cherche Hermes, par le moteur Docker s'il est accessible, par le réseau
 * sinon. La voie Docker en dit beaucoup plus — dont la clé.
 */
export async function discover() {
  const docker = await dockerStatus();

  if (docker.available) {
    try {
      const found = await discoverViaDocker();
      if (found.length) return { via: 'docker', docker, found };
      // Le moteur répond mais ne connaît aucun Hermes : inutile de sonder le
      // réseau, on sait déjà qu'il n'y en a pas.
      return { via: 'docker', docker, found: [] };
    } catch (err) {
      // On retombe sur le réseau plutôt que d'échouer.
      console.warn('Détection Hermes par Docker impossible :', err.message);
    }
  }

  const found = [];
  for (const host of CANDIDATE_HOSTS) {
    const base = `http://${host}:${HERMES_PORT}`;
    const r = await probeHttp(base);
    if (r.alive) {
      found.push({
        name: host, source: 'réseau', running: true,
        base_url: base, reachable: true, needsKey: r.needsKey,
        models: r.models || [], key: null, networks: [], shared: true,
      });
      break;                               // le premier qui répond suffit
    }
  }
  return { via: 'http', docker, found };
}

async function discoverViaDocker() {
  const containers = await dockerRequest('GET', '/containers/json?all=1');
  const mine = await selfContainer(containers);
  const myNetworks = mine ? Object.keys(mine.NetworkSettings?.Networks || {}) : [];

  const out = [];
  for (const c of containers) {
    const names = (c.Names || []).map((n) => n.replace(/^\//, ''));

    /*
     * Le tri se fait sur l'IMAGE, jamais sur le nom.
     *
     * Docker préfixe les noms par celui du projet Compose : sur une
     * installation réelle, la passerelle s'appelait
     * `hermes-webui-yowj-hermes-agent-1`. Exclure ce qui contient « webui »
     * — ce que je faisais — écartait donc précisément l'agent recherché. Et
     * l'interface web porte elle aussi API_SERVER_KEY dans son environnement,
     * puisqu'elle s'en sert pour parler à l'agent : les variables ne
     * distinguent rien non plus. L'image, si.
     */
    if (/webui|web-ui/i.test(c.Image)) continue;
    const looksLikeAgent = /hermes-agent/i.test(c.Image);
    if (!looksLikeAgent && !/hermes/i.test(`${names.join(' ')} ${c.Image}`)) continue;

    let info;
    try { info = await dockerRequest('GET', `/containers/${c.Id}/json`); } catch { continue; }
    const env = Object.fromEntries((info.Config?.Env || []).map((e) => {
      const i = e.indexOf('=');
      return [e.slice(0, i), e.slice(i + 1)];
    }));
    // Un conteneur Hermes sans serveur d'API n'est pas une passerelle.
    if (!looksLikeAgent && !env.API_SERVER_PORT) continue;

    const networks = Object.keys(info.NetworkSettings?.Networks || {});
    const port = Number(env.API_SERVER_PORT) || HERMES_PORT;
    const name = names[0] || c.Id.slice(0, 12);
    const shared = networks.some((n) => myNetworks.includes(n));
    const base_url = `http://${name}:${port}`;

    // On ne vérifie l'accès que si un réseau est réellement partagé : sinon le
    // nom ne résout pas et l'échec ne prouverait rien.
    let reachable = false;
    let models = [];
    if (shared && c.State === 'running') {
      const r = await probeHttp(base_url);
      reachable = r.alive;
      models = r.models || [];
    }

    out.push({
      name, source: 'docker', image: c.Image, running: c.State === 'running',
      base_url, port, networks, shared, reachable, models,
      key: env.API_SERVER_KEY || null,
      apiEnabled: env.API_SERVER_ENABLED !== 'false',
    });
  }
  return out;
}

/** Notre propre conteneur, pour connaître nos réseaux. */
async function selfContainer(containers) {
  const id = os.hostname();
  const hit = (containers || []).find((c) => c.Id.startsWith(id));
  if (!hit) return null;
  try { return await dockerRequest('GET', `/containers/${hit.Id}/json`); } catch { return null; }
}

/**
 * Raccorde AgentHub au réseau d'un Hermes existant.
 *
 * Le cas est fréquent et invisible sans le socket : Hermes tourne, mais dans un
 * autre projet Compose, donc sur un autre réseau. Son nom ne résout pas, et
 * l'enregistrer tel quel donnerait un fournisseur mort. Puisqu'on a le socket,
 * autant régler le problème au lieu de se contenter de le signaler.
 */
export async function connectToNetwork(network) {
  const status = await dockerStatus();
  if (!status.available) return { ok: false, error: status.detail };

  const containers = await dockerRequest('GET', '/containers/json?all=1');
  const mine = await selfContainer(containers);
  if (!mine) {
    return { ok: false, error: "AgentHub n'a pas réussi à s'identifier parmi les conteneurs." };
  }
  if (Object.keys(mine.NetworkSettings?.Networks || {}).includes(network)) {
    return { ok: true, already: true, network };
  }
  try {
    await dockerRequest('POST', `/networks/${network}/connect`, { Container: mine.Id });
  } catch (err) {
    if (!/already exists|already attached/i.test(err.message)) {
      return { ok: false, error: `Raccordement impossible : ${err.message}` };
    }
  }
  return { ok: true, already: false, network };
}

// ---- passerelle arrêtée : diagnostiquer, puis démarrer ----------------------

/**
 * Pourquoi la passerelle ne répond-elle pas, alors que le conteneur tourne ?
 *
 * « Injoignable : fetch failed » est vrai et inutile. Avec le socket, on peut
 * distinguer les causes, et celle qu'on rencontre en pratique est précise :
 * l'image Hermes distribuée par certains hébergeurs ne lance `hermes gateway
 * run` que si un `config.yaml` existe déjà. Sur une installation neuve il
 * n'existe pas, donc l'API n'écoute jamais — alors qu'elle démarrerait très
 * bien sans lui.
 */
export async function diagnoseGateway(name) {
  const status = await dockerStatus();
  if (!status.available) {
    return { cause: 'sans-docker', fixable: false,
      detail: "Sans accès au moteur Docker, AgentHub ne peut pas dire pourquoi la passerelle se tait." };
  }

  const containers = await dockerRequest('GET', '/containers/json?all=1');
  const c = containers.find((x) => (x.Names || []).some((n) => n.replace(/^\//, '') === name));
  if (!c) return { cause: 'introuvable', fixable: false, detail: `Aucun conteneur nommé ${name}.` };
  if (c.State !== 'running') {
    return { cause: 'arrete', fixable: false,
      detail: `Le conteneur ${name} est ${c.State}. Démarre-le : docker start ${name}` };
  }

  const info = await dockerRequest('GET', `/containers/${c.Id}/json`);
  const env = Object.fromEntries((info.Config?.Env || []).map((e) => {
    const i = e.indexOf('=');
    return [e.slice(0, i), e.slice(i + 1)];
  }));

  if (env.API_SERVER_ENABLED === 'false' || (!env.API_SERVER_ENABLED && !env.API_SERVER_PORT)) {
    return {
      cause: 'api-desactivee', fixable: false, id: c.Id,
      detail: "Le serveur d'API n'est pas activé dans la configuration d'Hermes. Ajoute "
            + 'API_SERVER_ENABLED=true, API_SERVER_HOST=0.0.0.0, API_SERVER_PORT=8642 et une '
            + 'API_SERVER_KEY à son environnement, puis redémarre-le.',
    };
  }

  // Le processus tourne-t-il ?
  const ps = await execIn(c.Id, ['sh', '-c', 'ps ax 2>/dev/null | grep -c "[g]ateway run"']);
  const running = Number(String(ps.output).trim()) > 0;
  if (running) {
    return {
      cause: 'demarrage-en-cours', fixable: false, id: c.Id,
      detail: "La passerelle tourne mais n'a pas encore fini de se préparer. Reteste dans un moment.",
    };
  }

  return {
    cause: 'passerelle-arretee', fixable: true, id: c.Id,
    port: Number(env.API_SERVER_PORT) || HERMES_PORT,
    detail: "Hermes tourne, son serveur d'API est configuré, mais le processus de passerelle "
          + "n'a pas été lancé. Sur les images qui n'attendent qu'un fichier de configuration "
          + 'pour le faire, cela arrive sur une installation neuve.',
  };
}

/**
 * Lance `hermes gateway run` dans le conteneur.
 *
 * Exécuté sous l'utilisateur `hermes` et non root : le journal appartient à cet
 * utilisateur, et un fichier créé par root le rend inécrivable — c'est
 * exactement l'erreur observée au premier essai, un `PermissionError` sur
 * gateway.log qui tuait le démarrage sans rapport avec la passerelle elle-même.
 */
export async function startGateway(name, { onProgress = () => {} } = {}) {
  const d = await diagnoseGateway(name);

  // Elle a pu se lever entre le diagnostic et le clic — et surtout, la détection
  // de processus passe par `ps` dans le conteneur, ce qui n'est pas infaillible.
  // Une sonde HTTP tranche sans ambiguïté et évite d'en démarrer une seconde.
  const port = d.port || HERMES_PORT;
  const already = await probeHttp(`http://${name}:${port}`, 2500);
  if (already.alive) return { ok: true, base_url: `http://${name}:${port}`, seconds: 0, already: true };

  if (!d.fixable) return { ok: false, ...d };

  onProgress('Préparation du journal…');
  // On répare d'abord les droits, au cas où un lancement précédent (ou un
  // outil externe) ait laissé un fichier appartenant à root.
  await execIn(d.id, ['sh', '-c', 'mkdir -p /opt/data/logs && chown -R hermes:hermes /opt/data/logs 2>/dev/null || true']);

  onProgress('Démarrage de la passerelle…');
  await execIn(d.id, ['sh', '-c', 'nohup hermes gateway run >>/opt/data/logs/gateway.log 2>&1 </dev/null &'], 'hermes');

  const base = `http://${name}:${d.port}`;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const p = await probeHttp(base, 2500);
    if (p.alive) return { ok: true, base_url: base, seconds: (i + 1) * 3 };
    if (i % 3 === 2) onProgress(`Toujours en cours (${(i + 1) * 3} s)…`);
  }

  // Le dernier mot revient au journal d'Hermes : il dit précisément ce qui a
  // coincé, et le recopier vaut mieux qu'un « échec » sans explication.
  const log = await execIn(d.id, ['sh', '-c', 'tail -6 /opt/data/logs/gateway.log 2>/dev/null']);
  return {
    ok: false, cause: 'demarrage-echoue',
    detail: "La passerelle n'a pas répondu en une minute.",
    log: String(log.output || '').slice(-800),
  };
}

/** Exécute une commande dans un conteneur et renvoie sa sortie. */
/**
 * Exécute une commande dans un conteneur, par le socket Docker.
 *
 * Exporté parce que le catalogue MCP en a besoin : ses manifestes vivent dans
 * l'image d'Hermes, à un chemin qu'aucun montage d'AgentHub ne couvre. Lire par
 * ici évite de demander à l'utilisateur de modifier son docker-compose.yml.
 */
export async function execIn(containerId, cmd, user) {
  const created = await dockerRequest('POST', `/containers/${containerId}/exec`, {
    AttachStdout: true, AttachStderr: true, Tty: false, Cmd: cmd,
    ...(user ? { User: user } : {}),
  });
  const output = await execStart(created.Id);
  return { output };
}

/**
 * `exec/start` répond en flux multiplexé : chaque bloc est précédé d'un en-tête
 * de huit octets qu'il faut retirer, sinon la sortie est parasitée.
 */
function execStart(execId) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ Detach: false, Tty: false });
    const req = http.request({
      socketPath: SOCKET,
      path: `/${API}/exec/${execId}/start`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const parts = [];
        while (buf.length >= 8) {
          const len = buf.readUInt32BE(4);
          parts.push(buf.slice(8, 8 + len).toString('utf8'));
          buf = buf.slice(8 + len);
        }
        resolve(parts.join('') || buf.toString('utf8'));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('exec: délai dépassé')));
    req.write(payload);
    req.end();
  });
}

// ---- installation -----------------------------------------------------------

/**
 * Ce qu'il faut lancer pour installer Hermes soi-même.
 * Toujours proposé, même quand l'installation automatique est possible : c'est
 * la voie qui ne demande aucun privilège, et certains préféreront la lire avant
 * de laisser une application créer des conteneurs chez eux.
 */
export function installPlan(network = 'agenthub-net') {
  const key = crypto.randomBytes(16).toString('hex');
  return {
    key,
    network,
    compose: [
      'services:',
      '  hermes-agent:',
      `    image: ${HERMES_IMAGE}`,
      '    command: gateway run',
      '    container_name: hermes-agent',
      '    restart: unless-stopped',
      '    environment:',
      '      HERMES_HOME: /home/hermes/.hermes',
      '      HERMES_UID: "1000"',
      '      HERMES_GID: "1000"',
      '      API_SERVER_ENABLED: "true"',
      '      API_SERVER_HOST: "0.0.0.0"',
      `      API_SERVER_PORT: "${HERMES_PORT}"`,
      `      API_SERVER_KEY: "${key}"`,
      '    volumes:',
      '      - hermes-home:/home/hermes/.hermes',
      '      - hermes-src:/opt/hermes',
      '    networks:',
      `      - ${network}`,
      '',
      'networks:',
      `  ${network}:`,
      '    external: true',
      '',
      'volumes:',
      '  hermes-home:',
      '  hermes-src:',
    ].join('\n'),
    commands: [
      `docker network create ${network} 2>/dev/null || true`,
      'docker compose -f hermes-agent.yml up -d',
    ],
  };
}

/**
 * Installe et démarre Hermes via le moteur Docker.
 *
 * `onProgress` reçoit des lignes lisibles : télécharger l'image prend plusieurs
 * minutes et un écran figé pendant ce temps passe pour une panne.
 */
export async function installHermes({ onProgress = () => {} } = {}) {
  const status = await dockerStatus();
  if (!status.available) {
    return { ok: false, error: status.detail, reason: status.reason };
  }

  // Ne jamais écraser un Hermes existant.
  const existing = await discoverViaDocker().catch(() => []);
  if (existing.length) {
    return { ok: false, reason: 'deja-installe', error: `Hermes est déjà là (${existing[0].name}).`, found: existing };
  }

  const containers = await dockerRequest('GET', '/containers/json?all=1');
  if (containers.some((c) => (c.Names || []).includes('/hermes-agent'))) {
    return { ok: false, reason: 'nom-pris', error: 'Un conteneur nommé hermes-agent existe déjà.' };
  }

  // 1. Un réseau partagé avec nous : sans lui, le nom ne résoudrait pas.
  const mine = await selfContainer(containers);
  const myNetworks = Object.keys(mine?.NetworkSettings?.Networks || {})
    .filter((n) => !['host', 'none'].includes(n));
  let network = myNetworks[0];
  if (!network) {
    network = 'agenthub-net';
    onProgress(`Création du réseau ${network}…`);
    try { await dockerRequest('POST', '/networks/create', { Name: network, Driver: 'bridge' }); }
    catch (err) { if (!/already exists/i.test(err.message)) throw err; }
    if (mine) {
      onProgress('Raccordement d\'AgentHub à ce réseau…');
      await dockerRequest('POST', `/networks/${network}/connect`, { Container: mine.Id });
    }
  }
  onProgress(`Réseau partagé : ${network}`);

  // 2. L'image. C'est l'étape longue — près de 4 Go.
  onProgress(`Téléchargement de ${HERMES_IMAGE} — plusieurs minutes, c'est normal…`);
  await pullImage(HERMES_IMAGE, onProgress);

  // 3. Le conteneur.
  const key = crypto.randomBytes(16).toString('hex');
  onProgress('Création du conteneur hermes-agent…');
  const created = await dockerRequest('POST', '/containers/create?name=hermes-agent', {
    Image: HERMES_IMAGE,
    Cmd: ['gateway', 'run'],
    Env: [
      'HERMES_HOME=/home/hermes/.hermes',
      'HERMES_UID=1000',
      'HERMES_GID=1000',
      'API_SERVER_ENABLED=true',
      'API_SERVER_HOST=0.0.0.0',
      `API_SERVER_PORT=${HERMES_PORT}`,
      `API_SERVER_KEY=${key}`,
    ],
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped' },
      // Aucun port publié : Hermes n'est joignable que par le réseau Docker.
      // L'exposer sur l'hôte offrirait une passerelle d'agents à Internet.
      Binds: ['hermes-home:/home/hermes/.hermes', 'hermes-src:/opt/hermes'],
    },
    NetworkingConfig: { EndpointsConfig: { [network]: {} } },
  });

  onProgress('Démarrage…');
  await dockerRequest('POST', `/containers/${created.Id}/start`);

  // 4. Attendre que la passerelle réponde vraiment.
  const base_url = `http://hermes-agent:${HERMES_PORT}`;
  onProgress('Attente de la passerelle…');
  let reachable = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const p = await probeHttp(base_url, 2000);
    if (p.alive) { reachable = true; break; }
    if (i % 5 === 4) onProgress(`Toujours en cours de démarrage (${(i + 1) * 3} s)…`);
  }

  return {
    ok: true,
    reachable,
    container: created.Id.slice(0, 12),
    name: 'hermes-agent',
    base_url,
    key,
    network,
    warning: reachable ? null
      : "Le conteneur tourne mais la passerelle n'a pas encore répondu. Hermes met parfois "
        + 'plusieurs minutes à se préparer au premier démarrage — reteste la connexion dans un moment.',
  };
}

/** POST /images/create renvoie un flux de lignes JSON, pas un document. */
function pullImage(image, onProgress) {
  const [name, tag = 'latest'] = image.split(':');
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: SOCKET,
      path: `/${API}/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`,
      method: 'POST',
      timeout: 1800000,                    // une image de 4 Go, sur une ligne lente
    }, (res) => {
      if (res.statusCode >= 400) {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => reject(new Error(`téléchargement refusé (HTTP ${res.statusCode}) ${d.slice(0, 200)}`)));
        return;
      }
      let buffer = '';
      let lastAt = 0;
      res.on('data', (chunk) => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i).trim();
          buffer = buffer.slice(i + 1);
          if (!line) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          if (obj.error) return reject(new Error(obj.error));
          // Une ligne par couche et par pourcent noierait tout : on résume.
          const now = Date.now();
          if (obj.status && now - lastAt > 4000) {
            lastAt = now;
            onProgress(`${obj.status}${obj.id ? ` (${obj.id})` : ''}`);
          }
        }
      });
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('téléchargement interrompu (délai dépassé)')));
    req.end();
  });
}
