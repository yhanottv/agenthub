/**
 * Passerelle d'inférence : AgentHub parle OpenAI à ses voisins.
 *
 * Hermes a ses propres notions de fournisseur, et elles butent sur les
 * endpoints qui demandent un en-tête maison — AgentRouter exige
 * `Originator`, sans quoi il répond « unauthorized client ». Sa résolution de
 * clé ne consulte pas non plus les variables d'environnement qu'on lui donne.
 * Plutôt que de deviner sa plomberie, on lui présente une façade qu'il sait
 * lire : un `/v1/chat/completions` ordinaire.
 *
 * Tout ce qui est particulier — clé, en-têtes, URL réelle — reste ici, où
 * c'est déjà écrit et déjà éprouvé. Hermes n'a plus qu'une adresse interne et
 * aucun secret. Changer de fournisseur dans AgentHub change ce qu'il utilise,
 * sans toucher à sa configuration.
 *
 * SÉCURITÉ — cette route n'est jamais publiée : le conteneur n'écoute que sur
 * la boucle locale et le réseau Docker, et le reverse proxy ne route que les
 * chemins de l'interface. Elle exige tout de même un jeton, pour qu'un
 * conteneur voisin compromis ne puisse pas dépenser les clés.
 */
import crypto from 'node:crypto';
import { Providers, Settings } from './db.js';

const CLE_JETON = 'inference_token';

/**
 * Le chemin public de la passerelle, défini une seule fois.
 *
 * Il apparaît dans la configuration d'Hermes, dans la route Express et dans la
 * consigne d'installation ; trois copies qui se seraient désynchronisées.
 */
export const CHEMIN_INFERENCE = '/inference/v1';

/** Le jeton attendu, créé au premier besoin et conservé en base. */
export function jetonInference() {
  let t = Settings.get(CLE_JETON, '');
  if (!t) {
    t = 'ah_' + crypto.randomBytes(24).toString('hex');
    Settings.set(CLE_JETON, t);
  }
  return t;
}

/**
 * Le fournisseur `hermes` désigne Hermes lui-même.
 *
 * C'est précisément l'appelant de cette passerelle : le lui servir ferait
 * repartir sa question vers lui, qui la renverrait ici, indéfiniment. La
 * première version choisissait « le premier fournisseur utilisable », et
 * comme Hermes est celui que l'assistant d'installation crée en premier,
 * c'est exactement la boucle qui se produisait — la requête ne revenait
 * jamais et le blocage ne ressemblait pas à une erreur de routage.
 *
 * Écarté partout, y compris quand les réglages le désignent : aucune
 * configuration ne rend cette boucle souhaitable.
 */
const BOUCLE = new Set(['hermes']);

const utilisable = (p) =>
  Boolean(p && p.enabled && p.base_url && (!p.needs_key || p.api_key) && !BOUCLE.has(p.id));

/**
 * Le fournisseur à employer.
 *
 * Choisi par en-tête si l'appelant en désigne un — ce qui permet de faire
 * suivre le modèle de l'agent — sinon celui des réglages, sinon le premier
 * utilisable. Jamais deviné à partir du nom du modèle : deux fournisseurs
 * peuvent servir le même.
 *
 * Rend `null` quand il ne reste rien : un déploiement dont Hermes est le seul
 * fournisseur n'a rien à relayer, et doit le dire plutôt que de boucler.
 */
export function fournisseurPour(nom) {
  const voulu = String(nom || '').trim();
  let p = voulu ? Providers.get(voulu) : null;
  if (!utilisable(p)) p = Providers.get(Settings.get('inference_provider', '')) || null;
  if (!utilisable(p)) p = Providers.all().find(utilisable) || null;
  return utilisable(p) ? p : null;
}

/** Le modèle à demander : celui voulu s'il est servi, sinon le défaut du fournisseur. */
export function modelePour(p, voulu) {
  const m = String(voulu || '').trim();
  if (m && (p.models || []).includes(m)) return m;
  return p.default_model || (p.models || [])[0] || '';
}

const joindre = (base, chemin) => {
  const b = String(base).replace(/\/+$/, '');
  return /\/v\d+$/.test(b) ? `${b}/${chemin}` : `${b}/v1/${chemin}`;
};

/**
 * Relaie un appel de complétion vers le vrai fournisseur.
 *
 * Le corps est transmis tel quel — modèle, outils, streaming compris : c'est
 * ce qui permet à l'agent d'en face de garder toutes ses capacités. Seuls
 * l'adresse et les en-têtes changent.
 */
export async function relayer({ chemin, corps, providerVoulu, signal }) {
  const p = fournisseurPour(providerVoulu);
  if (!p) {
    return {
      ok: false,
      status: 503,
      erreur: "Aucun fournisseur utilisable pour relayer : AgentHub n'en connaît aucun en dehors "
        + "d'Hermes lui-même, et le renvoyer vers Hermes ferait tourner la question en rond. "
        + 'Ajoute un fournisseur dans Réglages.',
    };
  }

  // Les en-têtes libres d'abord : Authorization est posé ensuite et ne peut
  // donc pas être écrasé depuis ce champ.
  const headers = {
    ...(p.headers || {}),
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json',
  };
  if (p.api_key) headers.Authorization = `Bearer ${p.api_key}`;

  let reponse;
  try {
    reponse = await fetch(joindre(p.base_url, chemin), {
      method: 'POST',
      headers,
      body: typeof corps === 'string' ? corps : JSON.stringify(corps),
      signal,
    });
  } catch (err) {
    return { ok: false, status: 502, erreur: `${p.label} injoignable : ${err.message}` };
  }

  return { ok: true, reponse, provider: p };
}

/**
 * De quoi brancher Hermes sur cette passerelle, prêt à coller.
 *
 * Ces valeurs se déduisent toutes de l'état d'AgentHub, mais les retrouver à
 * la main demande de connaître le nom du conteneur, la forme exacte du bloc
 * `custom_providers` et le fait que le fournisseur s'écrit `custom:<nom>` et
 * jamais `custom` tout court. Trois détails, trois façons d'échouer sans
 * message clair — autant les livrer assemblés.
 */
export function consignePasserelle({ hote = 'agenthub', port = 8090 } = {}) {
  const p = fournisseurPour();
  const base = `http://${hote}:${port}${CHEMIN_INFERENCE}`;
  return {
    jeton: jetonInference(),
    base,
    provider: p ? p.id : null,
    providerLabel: p ? p.label || p.id : null,
    modele: p ? (p.default_model || (p.models || [])[0] || '') : '',
    // Le bloc à écrire dans le config.yaml d'Hermes. `custom:agenthub` et non
    // `custom` : sans le suffixe, sa résolution de clé ne trouve pas l'entrée
    // et il présente `no-key-required`, que la passerelle refuse.
    config: [
      'model:',
      `  default: ${p ? (p.default_model || (p.models || [])[0] || 'claude-opus-5') : 'claude-opus-5'}`,
      '  provider: custom:agenthub',
      `  base_url: ${base}`,
      '  api_mode: chat_completions',
      'custom_providers:',
      '- name: agenthub',
      `  base_url: ${base}`,
      '  key_env: AGENTHUB_API_KEY',
      '  api_mode: chat_completions',
    ].join('\n'),
  };
}

/** La liste des modèles, au format OpenAI, telle qu'AgentHub la connaît déjà. */
export function modelesPour(providerVoulu) {
  const p = fournisseurPour(providerVoulu);
  if (!p) return { object: 'list', data: [] };
  return {
    object: 'list',
    data: (p.models || []).map((id) => ({ id, object: 'model', owned_by: p.id, created: 0 })),
  };
}
