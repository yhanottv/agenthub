'use strict';

/* ============================================================================
   Langue de l'interface.

   Le français est la langue source. Traduire consiste donc à remplacer, dans le
   DOM rendu, chaque texte connu par son équivalent — plutôt qu'à envelopper
   cinq cents chaînes dans des appels `t()` répartis sur cinq mille lignes de
   gabarits. Deux raisons à ce choix :

   - le rendu passe par `innerHTML` partout, et il n'existe pas de point de
     passage unique où intercepter une chaîne avant affichage ;
   - une chaîne inconnue reste en français. L'interface n'est jamais trouée,
     jamais cassée, et la couverture s'améliore d'elle-même.

   Un observateur suit les nœuds ajoutés, ce qui couvre aussi ce qui arrive après
   coup : messages en streaming, boîtes de dialogue, panneaux.

   Ce qui manque au dictionnaire est demandé au serveur, traduit une fois par le
   modèle déjà configuré, puis conservé. Le noyau ci-dessous est écrit à la main
   pour que la navigation et les boutons soient justes du premier coup, sans
   attendre un aller-retour.
   ========================================================================== */

const LANGS = { fr: 'Français', en: 'English' };

// Noyau : ce qu'on lit en permanence. Traduit à la main, donc fiable et immédiat.
const CORE_EN = {
  // navigation et barre du haut
  'Accueil': 'Home',
  'Mon équipe': 'My team',
  'Second cerveau': 'Second brain',
  'Skills': 'Skills',
  'Consommation': 'Usage',
  'Journal': 'Journal',
  'Réglages': 'Settings',
  'Rechercher un agent, un pôle…': 'Search an agent, a pôle…',
  'Rechercher (Ctrl K)': 'Search (Ctrl K)',
  'Ouvrir le menu': 'Open menu',
  'Voir les tâches': 'View tasks',
  'Tâches': 'Tasks',
  'Passer en clair': 'Switch to light',
  'Passer en sombre': 'Switch to dark',
  'Traducteur': 'Translator',
  'Langue': 'Language',
  'Langue de l\'interface': 'Interface language',

  // actions courantes
  'Enregistrer': 'Save',
  'Annuler': 'Cancel',
  'Fermer': 'Close',
  'Retour': 'Back',
  'Suivant': 'Next',
  'Terminer': 'Finish',
  'Créer': 'Create',
  'Modifier': 'Edit',
  'Supprimer': 'Delete',
  'Tester': 'Test',
  'Copier': 'Copy',
  'Actualiser': 'Refresh',
  'Revérifier': 'Check again',
  'Tout voir': 'See all',
  'Recentrer': 'Recentre',
  'Pause': 'Pause',
  'Reprendre': 'Resume',
  'Envoyer': 'Send',
  'Arrêter': 'Stop',
  'Télécharger': 'Download',
  'Configurer plus tard': 'Set up later',
  'Configurer à la main': 'Set up manually',
  'Commencer': 'Start',
  'Ajouter': 'Add',
  'Refuser': 'Reject',
  'Tester et lister les modèles': 'Test and list models',

  // chat
  'Écris un message…  (@ pour appeler un agent)': 'Write a message…  (@ to call an agent)',
  'Message': 'Message',
  'Joindre un fichier': 'Attach a file',
  'Dicter': 'Dictate',
  'envoie': 'sends',
  'saute une ligne': 'new line',
  'Exporter en Markdown': 'Export as Markdown',
  'Vider la conversation': 'Clear conversation',
  'Modifier le pôle': 'Edit pôle',
  'Tâches déléguées': 'Delegated tasks',
  'Messages du salon': 'Channel messages',
  'Revenir en bas': 'Back to bottom',
  'Raisonnement': 'Reasoning',
  'réfléchit': 'thinking',
  'recherche': 'searching',
  'travaille': 'working',
  'disponible': 'available',
  'Toi': 'You',
  'Système': 'System',

  // second cerveau
  'Récent': 'Recent',
  'Notes': 'Notes',
  'Graph': 'Graph',
  'Nouvelle note': 'New note',
  'Titre': 'Title',
  'Contenu': 'Content',
  'Tags': 'Tags',
  'Mémoire': 'Memory',
  'Agents': 'Agents',
  'Pôles': 'Pôles',
  'À écrire': 'To write',
  'Dernières mémoires': 'Latest memories',
  'Épingler': 'Pin',
  'Désépingler': 'Unpin',
  'Créer la note': 'Create note',
  'Supprimer cette note': 'Delete this note',
  'Note vide': 'Empty note',
  'tout': 'all',
  'toutes': 'all',
  'Ajouter à la mémoire': 'Add to memory',

  // skills
  'Chercher par nom, description ou tag…': 'Search by name, description or tag…',
  'Chercher un skill': 'Search a skill',
  'Tous': 'All',
  'Actifs': 'Active',
  'À installer': 'To install',
  'actif': 'active',
  'à installer': 'to install',
  'Effacer la recherche': 'Clear search',
  'Filtrer par état': 'Filter by state',

  // consommation
  'Dépense': 'Spend',
  'Tokens envoyés': 'Tokens sent',
  'Tokens reçus': 'Tokens received',
  'Appels modèle': 'Model calls',
  'Par modèle': 'By model',
  'Par agent': 'By agent',
  'Par salon': 'By channel',
  'Évolution': 'Trend',
  '24 heures': '24 hours',
  '7 jours': '7 days',
  '30 jours': '30 days',
  'contexte + instructions': 'context + instructions',
  'réponses des agents': 'agent replies',
  'requêtes envoyées': 'requests sent',
  'estimation': 'estimated',

  // réglages
  'Identité de l\'organisation': 'Organisation identity',
  'Mot de passe': 'Password',
  'Fournisseurs de modèles': 'Model providers',
  'Outils des agents': 'Agent tools',
  'Images': 'Images',
  'Sauvegardes': 'Backups',
  'Déclenchements programmés': 'Scheduled runs',
  'Déclencheurs entrants': 'Incoming triggers',
  'Notifications et sessions': 'Notifications and sessions',
  'Nom': 'Name',
  'Identifiant': 'Identifier',
  'URL de base': 'Base URL',
  'Clé API': 'API key',
  'Modèle par défaut': 'Default model',
  'Modèle': 'Model',
  'Modèle d\'image': 'Image model',
  'Service': 'Service',
  'En-têtes supplémentaires': 'Extra headers',
  'Relancer l\'assistant': 'Restart the wizard',
  'Sauvegarder maintenant': 'Back up now',
  'Changer le mot de passe': 'Change password',
  'Nouveau mot de passe': 'New password',
  'Mot de passe actuel': 'Current password',
  'Confirmation': 'Confirmation',
  'Déconnecter les autres navigateurs': 'Sign out other browsers',
  'Tarifs des modèles et alerte de dépense': 'Model prices and spend alert',
  'Jours': 'Days',
  'Heure': 'Hour',
  'Minute': 'Minute',
  'Actif': 'Active',
  'clé requise': 'key required',
  'à configurer': 'to configure',
  'local': 'local',
  'connecté': 'connected',

  // assistant
  'Bienvenue': 'Welcome',
  'Hermes': 'Hermes',
  'Services': 'Services',
  'Bienvenue dans AgentHub.': 'Welcome to AgentHub.',
  'Hermes Agent': 'Hermes Agent',
  'Connecte tes services': 'Connect your services',
  'Le modèle par défaut': 'The default model',
  'Faire dessiner tes agents': 'Let your agents draw',
  'Détecter Hermes automatiquement': 'Detect Hermes automatically',
  'Configurer Hermes': 'Configure Hermes',
  'Installer Hermes': 'Install Hermes',
  'Utiliser cet Hermes': 'Use this Hermes',
  'Démarrer la passerelle': 'Start the gateway',
  'Hermes répond': 'Hermes is responding',
  'Hermes ne répond pas': 'Hermes is not responding',
  'Hermes n\'est pas configuré': 'Hermes is not configured',
  'Il manque la clé d\'Hermes': 'Hermes\'s key is missing',
  'Aucun modèle d\'image': 'No image model',
  'Dans l\'ordre :': 'In order:',

  // états vides et divers
  'Chargement…': 'Loading…',
  'Connexion…': 'Connecting…',
  'Traduction…': 'Translating…',
  'Aucun résultat': 'No results',
  'Rien à cartographier pour l\'instant.': 'Nothing to map yet.',
  'La galaxie est vide.': 'The galaxy is empty.',
  'Rien en mémoire pour l\'instant.': 'Nothing in memory yet.',
  'Aucun agent sur la période.': 'No agent in this period.',
  'Agrandir': 'Enlarge',
  'aucun': 'none',
  'Chercher': 'Search',
};

const DICTS = { en: { ...CORE_EN } };

const state = {
  lang: localStorage.getItem('ah_lang') || 'fr',
  missing: new Set(),
  pending: null,
  observer: null,
};

const dict = () => DICTS[state.lang] || null;

/** Traduction d'une chaîne, ou null si inconnue. */
function lookup(raw) {
  const d = dict();
  if (!d) return null;
  const text = raw.trim();
  if (text.length < 2) return null;
  if (d[text] !== undefined) return d[text];

  // Beaucoup de libellés portent une ponctuation ou un emoji collés. On tente le
  // cœur du texte et on lui rend son habillage, ce qui évite d'avoir à stocker
  // « Enregistrer », « Enregistrer… » et « Enregistrer ? » séparément.
  const m = text.match(/^([^\p{L}\p{N}]*)(.*?)([\s.:!?…]*)$/su);
  if (m && m[2] && d[m[2]] !== undefined) return m[1] + d[m[2]] + m[3];

  if (text.length <= 400 && /\p{L}{3}/u.test(text)) state.missing.add(text);
  return null;
}

// Contenus qui n'appartiennent pas à l'interface : jamais touchés.
const SKIP_CLOSEST = '.msg-content, .msg-image, .reasoning-body, .tr-text, .scan-log, '
  + '.note-preview, .recent-prev, .skill-desc, pre, code, textarea, input, .galaxy-wrap';
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE', 'CANVAS']);

function translateNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const parent = node.parentElement;
    if (!parent || SKIP_TAGS.has(parent.tagName)) return;
    if (parent.closest(SKIP_CLOSEST)) return;
    const t = lookup(node.nodeValue);
    if (t !== null && t !== node.nodeValue.trim()) {
      node.nodeValue = node.nodeValue.replace(node.nodeValue.trim(), t);
    }
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  if (SKIP_TAGS.has(node.tagName)) return;

  for (const attr of ['placeholder', 'title', 'aria-label']) {
    const v = node.getAttribute?.(attr);
    if (!v) continue;
    const t = lookup(v);
    if (t !== null && t !== v) node.setAttribute(attr, t);
  }

  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  for (const n of texts) translateNode(n);

  for (const el of node.querySelectorAll('[placeholder], [title], [aria-label]')) {
    for (const attr of ['placeholder', 'title', 'aria-label']) {
      const v = el.getAttribute(attr);
      if (!v) continue;
      const t = lookup(v);
      if (t !== null && t !== v) el.setAttribute(attr, t);
    }
  }
}

/** Demande au serveur ce qui manque, une fois, groupé. */
function flushMissing() {
  if (state.lang === 'fr' || !state.missing.size) return;
  clearTimeout(state.pending);
  state.pending = setTimeout(async () => {
    const batch = [...state.missing].slice(0, 60);
    state.missing = new Set([...state.missing].slice(60));
    try {
      const r = await fetch(`/api/i18n/${state.lang}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ missing: batch }),
      });
      if (!r.ok) return;
      const { translations } = await r.json();
      if (translations && Object.keys(translations).length) {
        Object.assign(DICTS[state.lang], translations);
        applyLang(document.body);
      }
    } catch { /* on retentera au prochain rendu */ }
    if (state.missing.size) flushMissing();
  }, 900);
}

function applyLang(root) {
  if (state.lang === 'fr' || !root) return;
  translateNode(root);
  flushMissing();
}

function currentLang() { return state.lang; }


async function setLang(lang) {
  if (!LANGS[lang] || lang === state.lang) return;
  state.lang = lang;
  localStorage.setItem('ah_lang', lang);
  document.documentElement.lang = lang;

  if (lang !== 'fr') {
    if (!DICTS[lang]) DICTS[lang] = {};
    try {
      const r = await fetch(`/api/i18n/${lang}`);
      if (r.ok) {
        const { translations } = await r.json();
        // Le noyau écrit à la main l'emporte sur ce qui a été traduit par le
        // modèle : c'est le seul endroit dont la formulation est garantie.
        DICTS[lang] = { ...(translations || {}), ...(lang === 'en' ? CORE_EN : {}) };
      }
    } catch { /* le noyau suffit pour démarrer */ }
  }

  // Le français est la source : y revenir demande de re-rendre depuis les
  // gabarits, aucune traduction inverse n'existe.
  if (lang === 'fr') { location.reload(); return; }

  applyLang(document.body);
  start();
}

/** Suit les nœuds ajoutés : messages en streaming, modales, panneaux. */
function start() {
  if (state.observer || state.lang === 'fr') return;
  state.observer = new MutationObserver((records) => {
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) translateNode(node);
      }
    }
    flushMissing();
  });
  state.observer.observe(document.body, { childList: true, subtree: true });
}

async function initLang() {
  document.documentElement.lang = state.lang;
  if (state.lang === 'fr') return;
  DICTS[state.lang] = DICTS[state.lang] || {};
  try {
    const r = await fetch(`/api/i18n/${state.lang}`);
    if (r.ok) {
      const { translations } = await r.json();
      DICTS[state.lang] = { ...(translations || {}), ...(state.lang === 'en' ? CORE_EN : {}) };
    }
  } catch { /* le noyau suffit */ }
  applyLang(document.body);
  start();
}

// Une seule surface globale, exposee a app.js qui n'est pas un module.
window.I18N = { applyLang, setLang, initLang, currentLang, LANGS };
