/**
 * Jarvis — l'interlocuteur du Second cerveau.
 *
 * Les agents travaillent dans des salons ; Jarvis, lui, vit dans la carte. Il
 * ne produit rien, ne délègue rien : il *sait*. On lui donne la mémoire
 * partagée en entier et l'état du graphe, et il répond sur ce que
 * l'organisation est en train de faire.
 *
 * Son cerveau se change à la voix — « change ton cerveau sur Opus 5 ». C'est un
 * outil, pas une commande analysée à la main : le modèle comprend la phrase
 * quelle que soit sa tournure, là où une expression régulière n'aurait attrapé
 * que les formulations prévues.
 *
 * Son modèle vit dans `settings`, pas dans la table des agents : Jarvis n'a ni
 * rang, ni pôle, et l'inscrire parmi les agents l'aurait fait apparaître comme
 * une étoile de plus dans la carte qu'il est censé commenter.
 */
import { Settings, Providers, Notes, Agents, Channels, Tasks } from './db.js';
import { streamChat } from './llm.js';
import { layerCounts, buildGraph } from './graph.js';
import { skillsCatalogue, skillBody } from './skills.js';
import { TOOL_DEFS, runTool } from './tools.js';

const CLE_PROVIDER = 'jarvis_provider';
const CLE_MODEL = 'jarvis_model';

const MAX_QUESTION = 2000;
const MAX_HISTORIQUE = 8;
// Chercher puis lire fait déjà deux tours ; quatre laissent de la marge sans
// permettre à une boucle d'outils de tourner indéfiniment.
const MAX_TOURS = 4;

const utilisable = (p) => Boolean(p && p.enabled && p.base_url && (!p.needs_key || p.api_key));

/**
 * Le cerveau courant.
 *
 * Tant que rien n'a été choisi, Jarvis emprunte celui du CEO plutôt que le
 * premier fournisseur de la liste : celui-là peut très bien être branché sans
 * être capable de répondre — le fournisseur Hermes, par exemple, existe et
 * paraît utilisable alors qu'il n'a aucun moteur d'inférence derrière.
 */
export function cerveau() {
  const voulu = Settings.get(CLE_PROVIDER, '');
  const modele = Settings.get(CLE_MODEL, '');

  let p = voulu ? Providers.get(voulu) : null;
  let m = modele;

  if (!utilisable(p)) {
    const ceo = Agents.all().find((a) => a.rank === 'ceo');
    const herite = ceo ? Providers.get(ceo.provider) : null;
    if (utilisable(herite)) { p = herite; m = ceo.model; }
    else { p = Providers.all().find(utilisable) || null; m = ''; }
  }

  if (!p) return { provider: null, model: '', label: '', configured: false };
  const choisi = m && p.models.includes(m) ? m : (p.default_model || p.models[0] || '');
  return { provider: p.id, model: choisi, label: p.label, configured: true };
}

/**
 * Retrouve un modèle à partir d'un bout de phrase — « Opus 5 », « gemini
 * flash », « le gros Claude ». On compare sur les caractères alphanumériques
 * seuls, pour que « Opus 5 » rejoigne « claude-opus-5 ».
 *
 * Le score favorise, dans l'ordre : l'égalité, l'inclusion, puis le nombre de
 * fragments retrouvés. À égalité, le modèle le plus court gagne — « opus-5 »
 * plutôt que « opus-5-preview-20260101 », qui n'est presque jamais ce qu'on
 * voulait dire.
 */
export function trouverModele(demande) {
  const nu = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const cible = nu(demande);
  if (!cible) return null;
  const fragments = String(demande).toLowerCase().split(/[^a-z0-9]+/i).filter((f) => f.length > 1);

  let best = null;
  for (const p of Providers.all()) {
    if (!utilisable(p)) continue;
    for (const m of p.models) {
      const cand = nu(m);
      let score = 0;
      if (cand === cible) score = 1000;
      else if (cand.includes(cible)) score = 500;
      else {
        const trouves = fragments.filter((f) => cand.includes(nu(f)));
        // Exiger tous les fragments : « opus 5 » ne doit pas tomber sur
        // « opus-4 » au prétexte qu'il contient « opus ».
        if (trouves.length && trouves.length === fragments.length) score = 100 + trouves.length;
      }
      if (!score) continue;
      const mieux = !best || score > best.score
        || (score === best.score && m.length < best.model.length);
      if (mieux) best = { score, provider: p.id, model: m, label: p.label };
    }
  }
  return best;
}

/**
 * La phrase demande-t-elle une bascule vers une cible nommée ?
 *
 * Exiger une cible évite de confondre « change ton cerveau sur Opus 5 » avec
 * « quel modèle utilises-tu ? » : la première désigne un but, la seconde pose
 * une question.
 */
export function veutBasculer(phrase) {
  const s = String(phrase || '');
  return /\b(?:cerveau|mod[eè]les?|brain)\b[^.?!]{0,24}\b(?:sur|en|vers|pour)\b\s*\S+/i.test(s)
    || /\b(?:deviens|devenez)\b\s+\S+/i.test(s)
    || /\b(?:passe|passez|bascule|basculez|switch)\b\s+(?:sur|en|vers|to)\b\s*\S+/i.test(s);
}

/**
 * Les skills qui répondent à une requête, les actifs d'abord.
 *
 * Le catalogue en compte près de deux cents : les lister tous noierait la
 * réponse. On rend les dix meilleurs, avec de quoi décider lequel ouvrir.
 */
export function chercherSkills(requete) {
  const nu = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const q = nu(requete).trim();
  if (!q) return 'Précise ce que tu cherches.';
  const mots = q.split(/[^a-z0-9]+/).filter((m) => m.length > 2);

  const { skills } = skillsCatalogue();
  const notes = [];
  for (const s of skills) {
    const foin = nu(`${s.name} ${s.title} ${s.description} ${s.category} ${(s.tags || []).join(' ')}`);
    let score = 0;
    if (nu(s.name) === q) score = 1000;
    else if (foin.includes(q)) score = 400;
    else score = mots.filter((m) => foin.includes(m)).length * 60;
    if (!score) continue;
    if (s.installed) score += 45;             // ce qu'il a vraiment sous la main d'abord
    notes.push({ s, score });
  }
  if (!notes.length) return `Aucun skill ne correspond à « ${String(requete).slice(0, 60)} ».`;

  notes.sort((a, b) => b.score - a.score);
  return notes.slice(0, 10).map(({ s }) =>
    `- ${s.name}${s.installed ? '' : ' (au catalogue, non installé)'} — ${s.description.slice(0, 160)}`).join('\n')
    + '\n\nOuvre le plus pertinent avec `utiliser_skill`, puis applique-le.';
}

/** Ce que Jarvis voit de la carte, en quelques lignes. */
function etatDuGraphe() {
  const c = layerCounts();
  const lignes = [
    `Notes en mémoire : ${c.notes}. Agents : ${c.agents}. Pôles : ${c.channels}. `
      + `Tâches récentes : ${c.tasks}. Skills au catalogue : ${c.skills}.`,
  ];

  const agents = Agents.all();
  if (agents.length) {
    lignes.push('Effectif : ' + agents.map((a) => `${a.name} (${a.rank})`).join(', ') + '.');
  }
  const salons = Channels.all();
  if (salons.length) {
    lignes.push('Pôles : ' + salons.map((s) => `${s.name} — ${s.msg_count || 0} message(s)`).join(' · ') + '.');
  }

  const taches = Tasks.recent(12);
  if (taches.length) {
    lignes.push('Dernières tâches : ' + taches.map((t) => `« ${t.title.slice(0, 60)} » (${t.status})`).join(' · ') + '.');
  }

  // Les amas de la mémoire, c'est-à-dire les tags : le classement que
  // l'utilisateur a lui-même posé.
  const tags = Notes.tags().slice(0, 10);
  if (tags.length) {
    lignes.push('Thèmes de la mémoire : ' + tags.map((t) => `#${t.tag} (${t.count})`).join(', ') + '.');
  }

  return lignes.join('\n');
}

/**
 * Les outils web des agents, empruntés tels quels.
 *
 * Jarvis connaît l'organisation, pas le monde : sans eux, tout ce qui s'est
 * passé après son entraînement lui est invisible. Ces deux-là ne demandent
 * aucun contexte de salon — ils ne font que du réseau — et ils portent déjà les
 * garde-fous de `tools.js`, dont le refus des adresses internes.
 */
const OUTILS_WEB = TOOL_DEFS.filter((t) => ['recherche_web', 'lire_url'].includes(t.function.name));
const NOMS_WEB = new Set(OUTILS_WEB.map((t) => t.function.name));

/**
 * Retrouve un élément de la carte à partir d'un bout de phrase — « ma
 * présentation », « l'agent Adonis », « la tâche du site ». Même logique floue
 * que pour les modèles : égalité, inclusion, puis mots retrouvés.
 */
export function trouverNoeud(demande) {
  const nu = (s) => String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  const cible = nu(demande);
  if (!cible) return null;
  // Les articles ne désignent rien : les garder ferait matcher n'importe quoi.
  const VIDES = new Set(['le', 'la', 'les', 'un', 'une', 'des', 'ma', 'mon', 'mes', 'sur', 'de', 'du', 'agent', 'tache', 'note', 'pole']);
  const mots = cible.split(' ').filter((m) => m.length > 1 && !VIDES.has(m));

  const note = (cand) => {
    if (cand === cible) return 1000;
    if (cand.includes(cible) || cible.includes(cand)) return 500;
    if (!mots.length) return 0;
    const trouves = mots.filter((m) => cand.includes(m));
    if (trouves.length && trouves.length >= Math.ceil(mots.length / 2)) {
      return 100 + trouves.length * 20 - cand.length * 0.05;
    }
    return 0;
  };

  const graphe = buildGraph();
  let best = null;
  for (const n of graphe.nodes) {
    if (n.stub) continue;                          // une note absente ne se vise pas
    const score = note(nu(n.title));
    if (score && (!best || score > best.score)) {
      best = { score, id: n.id, title: n.title, layer: n.layer };
    }
  }
  // Les amas aussi : « les tâches terminées », « la mémoire », « les agents »
  // désignent un groupe entier, pas un nœud.
  for (const g of graphe.groups) {
    const score = note(nu(g.label));
    if (score && (!best || score > best.score)) {
      best = { score, id: g.id, title: g.label, layer: g.layer, group: true };
    }
  }
  return best;
}

const OUTIL_SKILL_CHERCHE = {
  type: 'function',
  function: {
    name: 'chercher_skill',
    description: "Cherche dans le catalogue de skills d'Hermes — des modes d'emploi écrits par des "
      + "spécialistes, sur des sujets précis. À utiliser avant de répondre de mémoire sur un domaine "
      + "technique : il existe peut-être un skill qui dit exactement comment faire.",
    parameters: {
      type: 'object',
      properties: {
        requete: { type: 'string', description: 'Le sujet cherché. Ex : « diagramme », « pdf », « github », « débogage ».' },
      },
      required: ['requete'],
    },
  },
};

const OUTIL_SKILL_OUVRE = {
  type: 'function',
  function: {
    name: 'utiliser_skill',
    description: "Ouvre un skill et te donne son mode d'emploi complet, que tu appliques ensuite pour "
      + "répondre. À appeler dès qu'un skill trouvé paraît pertinent, et dès qu'on te demande "
      + "d'utiliser un skill nommé.\n"
      + "Tu n'as ni terminal ni système de fichiers : quand un skill demande de lancer des commandes, "
      + "tu expliques la marche à suivre et donnes les commandes exactes, sans prétendre les avoir "
      + 'exécutées. Ce que tu peux appliquer toi-même — méthode, structure, rédaction, analyse — tu '
      + "l'appliques directement.",
    parameters: {
      type: 'object',
      properties: {
        nom: { type: 'string', description: 'Le nom du skill, tel qu\'il apparaît au catalogue. Ex : « architecture-diagram ».' },
      },
      required: ['nom'],
    },
  },
};

const OUTIL_ZOOM = {
  type: 'function',
  function: {
    name: 'zoomer_carte',
    description: "Centre et zoome la carte sur un élément nommé — une note de la mémoire, un agent, "
      + "un pôle, une tâche ou un skill. À appeler dès qu'on te demande de zoomer sur quelque chose, "
      + 'de le montrer, de le retrouver ou de centrer la carte dessus.',
    parameters: {
      type: 'object',
      properties: {
        cible: { type: 'string', description: "L'élément visé, tel que la personne l'a nommé. Ex : « ma présentation », « Adonis », « les tâches terminées »." },
      },
      required: ['cible'],
    },
  },
};

const OUTIL_CERVEAU = {
  type: 'function',
  function: {
    name: 'changer_de_cerveau',
    description: "Change le modèle de langage qui te fait fonctionner. À appeler dès qu'on te demande "
      + "de changer de cerveau, de modèle, de passer sur un autre modèle, ou « deviens Opus 5 ». "
      + "N'annonce pas le changement avant d'avoir appelé cet outil : c'est lui qui l'effectue.",
    parameters: {
      type: 'object',
      properties: {
        modele: {
          type: 'string',
          description: "Le modèle demandé, tel que la personne l'a nommé. Ex. « Opus 5 », "
            + '« gemini flash », « claude-sonnet-5 ». Inutile de deviner son identifiant exact.',
        },
      },
      required: ['modele'],
    },
  },
};

/** Les modèles vers lesquels Jarvis peut basculer, groupés par fournisseur. */
function modelesDisponibles(max = 60) {
  const out = [];
  for (const p of Providers.all()) {
    if (!utilisable(p)) continue;
    const liste = p.models.slice(0, max);
    if (liste.length) out.push(`${p.label} : ${liste.join(', ')}${p.models.length > liste.length ? ', …' : ''}`);
  }
  return out;
}

export function promptSysteme() {
  const c = cerveau();
  const lignes = [
    "Tu es JARVIS, l'intelligence du Second cerveau d'AgentHub.",
    '',
    "Tu vis dans la carte de l'espace de travail, pas dans un salon. Tu ne produis ni fichier, ni "
      + "image, et tu ne délègues rien : les agents s'en chargent. Ton rôle est de savoir, et de "
      + "répondre à ce qu'on te demande sur l'organisation.",
    '',
    `Ton cerveau actuel : ${c.model || 'aucun'} (${c.label || 'aucun fournisseur'}).`,
    '',
    "RÈGLE ABSOLUE : tu réponds **toujours en français**, quelle que soit la langue de la question "
      + "ou celle des pages que tu consultes. Jamais un mot d'anglais, jamais une phrase traduite "
      + 'ensuite : le français directement.',
    '',
    'Réponds brièvement — deux à cinq phrases. Ta réponse est lue à voix haute par une synthèse '
      + "vocale : écris donc en texte simple. Pas de listes à puces, pas de gras, pas de tableaux, "
      + "pas de tirets décoratifs, aucune URL — nomme le site plutôt que de coller son adresse. "
      + "Ton registre est celui d'un majordome : posé, précis, un peu spirituel, jamais bavard.",
    '',
    "Tu as accès au web : `recherche_web` puis `lire_url` dès qu'une information est récente, "
      + "chiffrée, ou que tu n'en es pas sûr. Sers-t'en plutôt que de dire que tu ne sais pas, et "
      + 'cite brièvement ta source. Ta réponse sera lue à voix haute : reste court, et ne colle '
      + "jamais d'URL entière dans une phrase — nomme le site.",
    '',
    "Ce qui suit est l'état réel de cet espace de travail, relevé à l'instant. C'est ta source pour "
      + "tout ce qui touche à l'organisation : appuie-toi dessus, et ne dis jamais qu'on ne t'a rien "
      + 'fourni. Si une information précise manque, dis en une phrase ce qui manque.',
    '',
    "## État de l'espace de travail",
    etatDuGraphe(),
  ];

  // Les skills : les noms seulement. Deux cents descriptions noieraient le
  // prompt, et `chercher_skill` est là pour le détail.
  try {
    const cat = skillsCatalogue();
    const actifs = cat.skills.filter((s) => s.installed).map((s) => s.name);
    if (actifs.length) {
      lignes.push('');
      lignes.push('## Tes skills');
      lignes.push(`Tu disposes de ${actifs.length} skills actifs — des modes d'emploi écrits par des `
        + `spécialistes — et de ${cat.counts.available} autres au catalogue. Devant une demande `
        + "technique, cherche d'abord s'il en existe un plutôt que de répondre de mémoire : "
        + '`chercher_skill` pour trouver, `utiliser_skill` pour lire et appliquer.');
      lignes.push('');
      lignes.push(`Actifs : ${actifs.join(', ')}.`);
    }
  } catch { /* dossiers non montés : Jarvis s'en passe */ }

  const dispo = modelesDisponibles();
  if (dispo.length) {
    lignes.push('');
    lignes.push('## Cerveaux disponibles');
    // Sans cette liste, un modèle refuse de basculer vers un modèle plus récent
    // que lui au motif qu'il « n'existe pas » — ce qu'il ne peut pas savoir.
    lignes.push("Cette liste vient des fournisseurs configurés par l'utilisateur. Elle fait foi, "
      + "même si un modèle t'est inconnu ou te paraît postérieur à toi.");
    lignes.push(dispo.join('\n'));
    lignes.push("Quand on te demande de changer de cerveau, appelle toujours `changer_de_cerveau` "
      + "sans discuter de l'existence du modèle : l'outil tranche, et te dira s'il n'a rien trouvé.");
  }

  const notes = Notes.forContext();
  if (notes.length) {
    lignes.push('');
    lignes.push('## Mémoire partagée');
    lignes.push('Ces notes font autorité. Les `[[doubles crochets]]` renvoient à d\'autres notes.');
    lignes.push('');
    lignes.push(notes.join('\n\n'));
  }

  return lignes.join('\n');
}

/**
 * Une question posée à Jarvis.
 *
 * `historique` est le fil de la conversation en cours, borné : Jarvis répond à
 * chaud, il n'a pas à porter toute une journée d'échanges.
 */
export async function demander({ question, historique = [], signal, onStep = () => {} } = {}) {
  const q = String(question || '').trim().slice(0, MAX_QUESTION);
  if (!q) return { ok: false, text: 'Pose-moi une question.' };

  const c = cerveau();
  if (!c.configured) {
    return { ok: false, text: "Aucun fournisseur de modèles n'est configuré. Ouvre Réglages → Fournisseurs." };
  }

  const messages = [
    { role: 'system', content: promptSysteme() },
    ...historique.slice(-MAX_HISTORIQUE).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, MAX_QUESTION),
    })),
    { role: 'user', content: q },
  ];

  const commun = {
    agent: { provider: c.provider, model: c.model },
    sessionKey: 'agenthub:jarvis',
    signal,
  };

  // Un modèle refuse de basculer vers plus récent que lui — « Opus 5 n'existe
  // pas » — et il ne peut pas savoir le contraire : sa connaissance s'arrête
  // avant. Quand la phrase désigne clairement une cible, on impose donc
  // l'appel : c'est l'outil qui tranche, pas ses souvenirs. Les tournures
  // inhabituelles restent servies par le choix libre.
  const forcer = veutBasculer(q)
    ? { type: 'function', function: { name: 'changer_de_cerveau' } }
    : null;

  const outils = [OUTIL_CERVEAU, OUTIL_ZOOM, OUTIL_SKILL_CHERCHE, OUTIL_SKILL_OUVRE, ...OUTILS_WEB];
  let agent = { provider: c.provider, model: c.model };
  let change = null;
  let focus = null;
  let r = null;

  // Une boucle plutôt qu'un aller-retour unique : chercher sur le web puis lire
  // une page, ça fait déjà deux tours avant de pouvoir répondre.
  for (let tour = 0; tour < MAX_TOURS; tour++) {
    const impose = tour === 0 ? forcer : null;
    r = await streamChat({ ...commun, agent, messages, tools: outils, toolChoice: impose });
    // Tous les fournisseurs n'acceptent pas qu'on impose un outil : plutôt que
    // d'échouer, on refait le tour en choix libre.
    if (r.error && impose) r = await streamChat({ ...commun, agent, messages, tools: outils });
    if (r.error) {
      return change
        ? { ok: true, text: `Cerveau basculé sur ${change.model}.`, change, brain: cerveau() }
        : { ok: false, text: r.error };
    }

    const appels = r.toolCalls || [];
    if (!appels.length) break;

    // La forme rendue par `llm.js` est `{ id, name, args }` — pas celle de
    // l'API OpenAI. Elle n'est remise au format `tool_calls` qu'ici, au moment
    // de renvoyer l'historique au fournisseur.
    messages.push({
      role: 'assistant',
      content: r.text || null,
      tool_calls: appels.map((t, i) => ({
        id: t.id || `call_${tour}_${i}`,
        type: 'function',
        function: { name: t.name, arguments: t.args || '{}' },
      })),
    });

    // Une réponse par appel : l'API refuse un tour où un `tool_call` reste sans
    // `tool` correspondant.
    for (const [i, t] of appels.entries()) {
      let contenu;
      if (t.name === 'changer_de_cerveau') {
        // Un seul changement par tour : deux basculements dans la même réponse
        // laisseraient l'interface incapable de dire lequel a gagné.
        contenu = change
          ? 'Ignoré : un seul changement de cerveau par tour.'
          : (() => {
            const issue = basculer(t, agent);
            if (issue.change) { change = issue.change; agent = { provider: change.provider, model: change.model }; }
            return issue.texte;
          })();
      } else if (t.name === 'zoomer_carte') {
        let args = {};
        try { args = JSON.parse(t.args || '{}'); } catch { /* arguments illisibles */ }
        const noeud = trouverNoeud(args.cible);
        if (noeud) {
          focus = { id: noeud.id, title: noeud.title, layer: noeud.layer, group: Boolean(noeud.group) };
          onStep(`zoome sur « ${noeud.title.slice(0, 40)} »…`);
          contenu = `La carte est maintenant centrée sur « ${noeud.title} ». Dis-le en une phrase, sans redécrire l'élément.`;
        } else {
          contenu = `Rien dans la carte ne s'appelle « ${String(args.cible || '').slice(0, 60)} ». Dis-le simplement.`;
        }
      } else if (t.name === 'chercher_skill') {
        let args = {};
        try { args = JSON.parse(t.args || '{}'); } catch { /* arguments illisibles */ }
        onStep('cherche un skill…');
        contenu = chercherSkills(args.requete);
      } else if (t.name === 'utiliser_skill') {
        let args = {};
        try { args = JSON.parse(t.args || '{}'); } catch { /* arguments illisibles */ }
        const lu = skillBody(args.nom);
        if (!lu.ok) contenu = lu.error;
        else {
          onStep(`applique le skill « ${lu.skill.name} »…`);
          contenu = `Mode d'emploi du skill « ${lu.skill.name} »`
            + `${lu.skill.installed ? ' (actif chez Hermes)' : ' (au catalogue, non installé)'} :\n\n`
            + lu.contenu
            + (lu.compagnons.length ? `\n\nFichiers fournis avec ce skill : ${lu.compagnons.join(', ')}.` : '')
            + "\n\nApplique-le maintenant pour répondre. Tu n'as pas de terminal : ce qui demande une "
            + 'commande se donne à lancer, le reste se fait directement.';
        }
      } else if (NOMS_WEB.has(t.name)) {
        // L'appelant relaie ce pas vers l'interface : une recherche web au
        // milieu d'une réflexion, ça doit se voir, pas ressembler à une panne.
        onStep(t.name === 'recherche_web' ? 'cherche sur le web…' : 'lit une page…');
        const sortie = await runTool(t.name, t.args, { signal });
        contenu = String(sortie.text || '').slice(0, 12000);
      } else {
        contenu = `Outil inconnu : ${t.name}.`;
      }
      messages.push({ role: 'tool', tool_call_id: t.id || `call_${tour}_${i}`, name: t.name, content: contenu });
    }
  }

  return { ok: true, text: r?.text || '…', change, focus, brain: cerveau() };
}

// ---- la voix ----------------------------------------------------------------
// La synthèse du navigateur dépend des voix installées sur la machine : sans
// voix française elle prend une voix anglaise, écorche le texte et épelle les
// nombres. On passe donc par un modèle audio, côté serveur, dont le rendu est
// le même pour tout le monde.
//
// Le format doit être `pcm16` : l'API refuse le mp3 en streaming, et le
// streaming est obligatoire pour une sortie audio. On reçoit donc des
// échantillons bruts, qu'on habille d'un en-tête WAV avant de les rendre.

const TTS_MODEL = 'openai/gpt-audio-mini';
const TTS_VOIX_DEFAUT = 'ash';
export const TTS_VOIX = ['alloy', 'ash', 'ballad', 'verse', 'sage', 'cedar'];
const TTS_ECHANT = 24000;                     // Hz, mono — ce que rend le modèle
const TTS_MAX = 1500;

export function voixConfig() {
  const v = Settings.get('jarvis_voice', '');
  return {
    voix: TTS_VOIX.includes(v) ? v : TTS_VOIX_DEFAUT,
    actif: Settings.get('jarvis_tts', '1') === '1',
    disponible: Boolean(Providers.get('openrouter')?.api_key),
  };
}

/** Un en-tête WAV pour des échantillons PCM 16 bits mono. */
function enteteWav(octets) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + octets, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);                    // taille du bloc fmt
  h.writeUInt16LE(1, 20);                     // PCM non compressé
  h.writeUInt16LE(1, 22);                     // mono
  h.writeUInt32LE(TTS_ECHANT, 24);
  h.writeUInt32LE(TTS_ECHANT * 2, 28);        // octets par seconde
  h.writeUInt16LE(2, 32);                     // octets par échantillon
  h.writeUInt16LE(16, 34);                    // bits par échantillon
  h.write('data', 36);
  h.writeUInt32LE(octets, 40);
  return h;
}

/** Lit un texte à voix haute. Rend un WAV prêt à jouer. */
export async function parler({ texte, voix, signal } = {}) {
  const t = String(texte || '').trim().slice(0, TTS_MAX);
  if (!t) return { ok: false, text: 'Rien à lire.' };

  const p = Providers.get('openrouter');
  if (!p?.api_key) return { ok: false, text: "OpenRouter n'est pas configuré : la voix passe par lui." };

  const conf = voixConfig();
  const choisie = TTS_VOIX.includes(voix) ? voix : conf.voix;

  let res;
  try {
    res = await fetch(`${p.base_url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${p.api_key}`, 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: TTS_MODEL,
        stream: true,
        modalities: ['text', 'audio'],
        audio: { voice: choisie, format: 'pcm16' },
        messages: [
          {
            role: 'system',
            content: "Tu es un lecteur. Tu prononces à voix haute, en français, exactement le texte "
              + "de l'utilisateur, mot pour mot. Tu n'ajoutes rien, tu ne commentes pas, tu ne "
              + 'réponds pas. Ton ton est celui d\'un majordome : posé, chaleureux, naturel.',
          },
          { role: 'user', content: t },
        ],
      }),
    });
  } catch (err) {
    return { ok: false, text: `Service de voix injoignable : ${err.message}` };
  }
  if (!res.ok) {
    return { ok: false, text: `La voix a été refusée (HTTP ${res.status}) : ${(await res.text()).slice(0, 200)}` };
  }

  const morceaux = [];
  let usage = null;
  let reste = '';
  const decodeur = new TextDecoder();
  for await (const bloc of res.body) {
    reste += decodeur.decode(bloc, { stream: true });
    const lignes = reste.split('\n');
    reste = lignes.pop();
    for (const ligne of lignes) {
      const s = ligne.trim();
      if (!s.startsWith('data:')) continue;
      const corps = s.slice(5).trim();
      if (!corps || corps === '[DONE]') continue;
      let m;
      try { m = JSON.parse(corps); } catch { continue; }
      const a = m.choices?.[0]?.delta?.audio;
      if (a?.data) morceaux.push(Buffer.from(a.data, 'base64'));
      if (m.usage) usage = m.usage;
    }
  }

  const pcm = Buffer.concat(morceaux);
  if (!pcm.length) return { ok: false, text: "Le service n'a rendu aucun son." };
  return {
    ok: true,
    wav: Buffer.concat([enteteWav(pcm.length), pcm]),
    secondes: pcm.length / (TTS_ECHANT * 2),
    usage,
    voix: choisie,
  };
}

/**
 * Applique un appel à `changer_de_cerveau`.
 *
 * Le message rendu s'adresse au modèle *suivant* — celui qui vient de prendre
 * la place et n'a pas vécu la bascule. Sans cette précision il répond « mais
 * c'est déjà mon cerveau ».
 */
function basculer(appel, courant) {
  let args = {};
  try { args = JSON.parse(appel.args || '{}'); } catch { /* arguments illisibles */ }

  const cible = trouverModele(args.modele);
  if (!cible) {
    const dispo = Providers.all().filter(utilisable).flatMap((p) => p.models).slice(0, 40);
    return { texte: `Aucun modèle ne correspond à « ${String(args.modele || '').slice(0, 60)} ». `
      + `Modèles disponibles : ${dispo.join(', ') || 'aucun'}.` };
  }
  if (cible.provider === courant.provider && cible.model === courant.model) {
    return { texte: `Tu fonctionnes déjà sur ${cible.model} (${cible.label}). Rien n'a changé.` };
  }

  Settings.set(CLE_PROVIDER, cible.provider);
  Settings.set(CLE_MODEL, cible.model);
  return {
    change: { provider: cible.provider, model: cible.model, label: cible.label, avant: courant.model },
    texte: `Bascule effectuée à l'instant : tu fonctionnais sur ${courant.model}, tu fonctionnes `
      + `désormais sur ${cible.model} (${cible.label}). Annonce ce changement en une phrase, `
      + "au passé, sans le remettre en question et sans dire que rien n'a changé.",
  };
}
