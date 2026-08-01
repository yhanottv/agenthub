/**
 * La passerelle d'inference : choix du fournisseur, et garde de la route.
 *
 * Ce qui se figerait mal autrement, et qui s'est reellement produit :
 *
 *   - Le repli « premier fournisseur utilisable » designait Hermes, qui est
 *     justement l'appelant. Sa question repartait vers lui, revenait ici, et
 *     ne finissait jamais. Vu de dehors, ca ne ressemblait pas a une erreur de
 *     routage mais a une lenteur.
 *   - La garde comparait des longueurs de CHAINE puis passait les tampons a
 *     `timingSafeEqual`, qui exige des longueurs en OCTETS. Un jeton accentue
 *     de la bonne longueur en caracteres levait une exception, rendue en 500.
 *
 * Les deux sont invisibles a la lecture et evidents une fois ecrits.
 */
import fs from 'node:fs';
import http from 'node:http';

const DATA_DIR = '/tmp/ah-inference-' + Date.now();
fs.mkdirSync(DATA_DIR, { recursive: true });
const PORT = 8791;

process.env.DATA_DIR = DATA_DIR;
process.env.PORT = String(PORT);
delete process.env.APP_PASSWORD;
delete process.env.APP_SECRET;
delete process.env.AGENTROUTER_API_KEY;
process.env.HERMES_API_URL = 'http://127.0.0.1:9';
process.env.HERMES_API_KEY = 'test-key-inference';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { console.log(`✓ ${label}`); pass++; }
  else { console.log(`✗ ${label}${extra ? '\n    ' + extra : ''}`); fail++; }
};

const { Providers, Settings } = await import('/app/db.js');
const { fournisseurPour, modelePour, jetonInference, CHEMIN_INFERENCE } =
  await import('/app/inference.js');

// ---- 1. la boucle ----------------------------------------------------------
// Hermes seul : c'est la situation d'une installation neuve, ou l'assistant
// cree ce fournisseur en premier et ou l'utilisateur n'en a pas encore ajoute.
Providers.upsert({
  id: 'hermes', label: 'Hermes', base_url: 'http://hermes-agent:8642',
  api_key: 'k-hermes', default_model: 'hermes-agent', models: ['hermes-agent'], sort: 0,
});

ok('Hermes seul : la passerelle ne relaie rien plutot que de boucler',
  fournisseurPour() === null);
ok('meme designe explicitement, Hermes est refuse',
  fournisseurPour('hermes') === null,
  'le designer par en-tete ne doit pas rouvrir la boucle');

// ---- 2. le choix -----------------------------------------------------------
Providers.upsert({
  id: 'agentrouter', label: 'AgentRouter', base_url: 'https://agentrouter.org/v1',
  api_key: 'k-ar', default_model: 'claude-opus-5',
  models: ['claude-opus-5', 'claude-sonnet-5'], sort: 1,
});
Providers.upsert({
  id: 'openrouter', label: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1',
  api_key: 'k-or', default_model: 'x-ai/grok-4', models: ['x-ai/grok-4'], sort: 2,
});

ok('le repli saute Hermes et prend le suivant',
  fournisseurPour()?.id === 'agentrouter',
  `obtenu : ${fournisseurPour()?.id}`);
ok('un fournisseur nomme est respecte',
  fournisseurPour('openrouter')?.id === 'openrouter');
ok('un nom inconnu retombe sur le choix par defaut',
  fournisseurPour('nexiste-pas')?.id === 'agentrouter');

Settings.set('inference_provider', 'openrouter');
ok('le reglage designe le fournisseur quand rien n\'est demande',
  fournisseurPour()?.id === 'openrouter');
Settings.set('inference_provider', 'hermes');
ok('le reglage ne peut pas designer Hermes',
  fournisseurPour()?.id === 'agentrouter',
  'un reglage errone ne doit pas rouvrir la boucle');
Settings.set('inference_provider', '');

// Un fournisseur desactive, ou sans cle, ne doit pas etre choisi.
Providers.upsert({ id: 'agentrouter', enabled: 0 });
ok('un fournisseur desactive est ignore', fournisseurPour()?.id === 'openrouter');
Providers.upsert({ id: 'agentrouter', enabled: 1 });

// Trouve en ecrivant ce test : `upsert` partiel effacait les champs absents,
// parce que `clampText` rend '' et non `undefined` quand le champ manque. Ne
// changer que `enabled` suffisait a vider l'URL — le fournisseur redevenait
// inutilisable sans que rien ne le dise.
const apresBascule = Providers.get('agentrouter');
ok('une mise a jour partielle ne vide pas les autres champs',
  apresBascule.base_url === 'https://agentrouter.org/v1'
  && apresBascule.default_model === 'claude-opus-5',
  `base_url=${JSON.stringify(apresBascule.base_url)} default_model=${JSON.stringify(apresBascule.default_model)}`);
ok('et le fournisseur redevient choisissable apres reactivation',
  fournisseurPour()?.id === 'agentrouter');

// ---- 3. le modele ----------------------------------------------------------
const ar = fournisseurPour('agentrouter');
ok('un modele servi par le fournisseur est conserve',
  modelePour(ar, 'claude-sonnet-5') === 'claude-sonnet-5');
ok('un modele inconnu retombe sur le defaut du fournisseur',
  modelePour(ar, 'gpt-9-turbo') === 'claude-opus-5',
  'sinon on demande a AgentRouter un modele qu\'il ne sert pas');
ok('sans modele demande, le defaut du fournisseur',
  modelePour(ar, '') === 'claude-opus-5');

// ---- 4. la garde de la route ----------------------------------------------
await import('/app/server.js');
await new Promise((r) => setTimeout(r, 700));

const appel = (headers) => new Promise((resolve) => {
  const corps = JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'x' }] });
  const req = http.request({
    host: '127.0.0.1', port: PORT, method: 'POST',
    path: `${CHEMIN_INFERENCE}/chat/completions`,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corps), ...headers },
  }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', (e) => resolve({ status: 0, body: e.message }));
  req.end(corps);
});

const jeton = jetonInference();
ok('le jeton a la forme attendue', /^ah_[0-9a-f]{48}$/.test(jeton), jeton);

ok('sans jeton : refuse', (await appel({})).status === 401);
ok('jeton faux de meme longueur : refuse',
  (await appel({ Authorization: 'Bearer ' + 'ah_' + 'f'.repeat(48) })).status === 401);
ok('jeton vide : refuse', (await appel({ Authorization: 'Bearer ' })).status === 401);

// Le bug du 500 : meme nombre de CARACTERES que le vrai jeton, mais des
// accents, donc plus d'octets. `timingSafeEqual` levait, Express rendait 500.
const accentue = 'ah_' + 'é'.repeat(48);
ok('jeton accentue de meme longueur en caracteres : refuse, pas 500',
  (await appel({ Authorization: 'Bearer ' + accentue })).status === 401,
  'un 500 ici signifie que la comparaison se fait encore en caracteres');

// Un appel venu du reseau interne SANS jeton doit etre refuse lui aussi :
// c'est tout l'objet du passage d'un refus sur detection a une acceptation
// sur preuve. La requete ci-dessus vient de 127.0.0.1, donc du reseau interne.
ok('le reseau interne seul ne suffit plus',
  (await appel({ 'X-Reel': 'interne' })).status === 401);

// Avec le bon jeton, la garde laisse passer. Ce qui suit depend du vrai
// fournisseur, joint avec une fausse cle : il repond 401 lui aussi. Le statut
// ne distingue donc rien — c'est le CORPS qui dit qui a refuse. La garde rend
// `{"error":"jeton invalide"}`, le fournisseur rend sa propre forme.
const bon = await appel({ Authorization: `Bearer ${jeton}` });
ok('le bon jeton passe la garde',
  !/jeton invalide/.test(bon.body),
  `refus de la passerelle et non du fournisseur : ${bon.status} ${bon.body.slice(0, 120)}`);
ok('la reponse vient bien du fournisseur en amont',
  /Missing Authentication|Unauthorized|error/i.test(bon.body),
  `corps inattendu : ${bon.body.slice(0, 160)}`);

// ---- fin -------------------------------------------------------------------
fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\n${pass} reussis, ${fail} echecs`);
process.exit(fail ? 1 : 0);
