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
  'Rechercher un agent, un pôle…': 'Search an agent, a unit…',
  'Rechercher (Ctrl K)': 'Search (Ctrl K)',
  'Ouvrir le menu': 'Open menu',
  'Voir les tâches': 'View tasks',
  'Tâches': 'Tasks',
  'Passer en clair': 'Switch to light',
  'Passer en sombre': 'Switch to dark',
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
  'Écris un message… (@ pour appeler un agent)': 'Write a message… (@ to call an agent)',
  'Message': 'Message',
  'Joindre un fichier': 'Attach a file',
  'Dicter': 'Dictate',
  'envoie': 'sends',
  'saute une ligne': 'new line',
  'Exporter en Markdown': 'Export as Markdown',
  'Vider la conversation': 'Clear conversation',
  'Modifier le pôle': 'Edit unit',
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
  'Pôles': 'Units',
  'Pôle': 'Unit',
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
  'Rien à cartographier pour l\'instant.': 'Nothing to map yet.',
  'Rien en mémoire pour l\'instant.': 'Nothing in memory yet.',
  'Aucun agent sur la période.': 'No agent in this period.',
  'Agrandir': 'Enlarge',
  'aucun': 'none',
  'Chercher': 'Search',

  // Ce qu'on lit quand il n'y a rien : c'est là qu'une interface à moitié
  // traduite se remarque le plus, et c'est aussi ce qu'on voit en premier
  // sur une installation neuve — donc avant qu'un modèle soit configuré.
  'Aucun pôle pour le moment. Un pôle, c\'est un salon où une équipe d\'agents travaille ensemble.':
    'No unit yet. A unit is a channel where a team of agents works together.',
  'Aucune tâche déléguée pour l’instant.': 'No delegated task yet.',
  'Aucun appel sur cette période. Écris à un pôle et les compteurs se rempliront.':
    'No calls in this period. Write to a unit and the counters will fill up.',
  'Aucun modèle appelé pour l\'instant.': 'No model called yet.',
  'Aucune sauvegarde pour l\'instant.': 'No backup yet.',
  'Aucun déclenchement programmé.': 'No scheduled run.',
  'Aucun tarif renseigné pour ce modèle': 'No price set for this model',
  'Écris une note, ou active un autre calque.': 'Write a note, or turn on another layer.',
  'Rien dans le contenu non plus.': 'Nothing in the content either.',
  'Rien à exporter dans ce salon.': 'Nothing to export in this channel.',
  'Rien à déclencher (salon ou consigne vide).': 'Nothing to trigger (empty channel or instruction).',
  'La conversation est déjà vide.': 'The conversation is already empty.',
  'La carte n\'a pas pu être chargée.': 'The map could not be loaded.',
  'Les skills d\'Hermes ne sont pas visibles d\'ici.': 'Hermes\'s skills are not visible from here.',

  // messages courts
  'Trop de tentatives. Réessaie dans un instant.': 'Too many attempts. Try again in a moment.',
  'Les deux mots de passe ne correspondent pas.': 'The two passwords do not match.',
  'La confirmation ne correspond pas.': 'The confirmation does not match.',
  'Accès créé. Ton mot de passe est enregistré.': 'Access created. Your password is saved.',
  'URL copiée. Traite-la comme un mot de passe.': 'URL copied. Treat it like a password.',
  'Serveur injoignable — vérifie ta connexion.': 'Server unreachable — check your connection.',
  'Copie refusée par le navigateur.': 'The browser refused to copy.',
  'Copie refusée — voici la commande': 'Copy refused — here is the command',
  'Déclencheur créé — copie son URL.': 'Trigger created — copy its URL.',
  'Le navigateur a refusé les notifications.': 'The browser refused notifications.',
  'Une URL de base est nécessaire.': 'A base URL is required.',
  'La consigne ne peut pas être vide.': 'The instruction cannot be empty.',
  'Garde au moins un calque affiché.': 'Keep at least one layer visible.',
  'Génération d\'images désactivée.': 'Image generation turned off.',
  'Tes agents peuvent maintenant dessiner.': 'Your agents can now draw.',
  'Tes agents peuvent créer des images.': 'Your agents can create images.',
  'Les agents ne produisent plus que du texte.': 'Agents now produce text only.',
  'Les agents écrivent directement en mémoire.': 'Agents write straight to memory.',
  'Les notes des agents attendront ta validation.': 'Agent notes will wait for your approval.',
  'Rien n\'entre en mémoire sans ton accord.': 'Nothing enters memory without your approval.',
  'Un agent porte déjà ce nom — les @mentions seraient ambiguës.':
    'An agent already has this name — @mentions would be ambiguous.',
  'Cette instance vient d\'être configurée. Recharge la page.':
    'This instance has just been set up. Reload the page.',
  'Cette information disparaîtra du contexte de tous tes agents.':
    'This information will disappear from every agent\'s context.',
  'Son URL cessera immédiatement de fonctionner.': 'Its URL will stop working immediately.',

  // microphone
  'Microphone': 'Microphone',
  'Entrée audio': 'Audio input',
  'Tester le micro': 'Test the microphone',
  'Arrêter le test': 'Stop the test',
  'Recherche des entrées…': 'Looking for inputs…',
  'Vérification…': 'Checking…',
  'Indisponible': 'Unavailable',
  'Aucune entrée détectée': 'No input detected',
  'Entrée par défaut du système': 'System default input',
  'Ouverture du micro…': 'Opening the microphone…',
  'Parle : le niveau doit bouger.': 'Speak: the level should move.',
  'Aucun son détecté. Parle plus fort, ou choisis une autre entrée.':
    'No sound detected. Speak louder, or choose another input.',
  'Ce navigateur ne donne pas accès aux entrées audio.':
    'This browser gives no access to audio inputs.',
  'Autorisation refusée. Ouvre les réglages du site dans ton navigateur et autorise le micro.':
    'Permission refused. Open this site\'s settings in your browser and allow the microphone.',
  'Aucun micro branché — le système n\'en voit aucun.':
    'No microphone plugged in — the system sees none.',
  'Le micro est occupé par une autre application.':
    'The microphone is busy in another application.',
  'Cette entrée a disparu. Relance un test pour rafraîchir la liste.':
    'This input is gone. Run a test again to refresh the list.',
  'La dictée utilise l\'entrée par défaut du système.':
    'Dictation uses the system default input.',
  'Ton choix sert au test : l\'API de dictée du navigateur ne permet pas d\'en changer.':
    'Your choice is for the test: the browser\'s dictation API does not allow changing it.',
  'Lance un test : le navigateur demandera l\'autorisation, et les noms des entrées apparaîtront.':
    'Run a test: the browser will ask for permission, and the input names will appear.',
  'Le micro est refusé pour ce site : autorise-le dans les réglages du navigateur.':
    'The microphone is blocked for this site: allow it in your browser settings.',
  'Le micro est refusé pour ce site. Autorise-le dans les réglages du navigateur.':
    'The microphone is blocked for this site. Allow it in your browser settings.',
  'Le navigateur a bloqué la dictée alors que le micro est autorisé. Recharge la page, puis teste ton micro dans Réglages.':
    'The browser blocked dictation even though the microphone is allowed. Reload the page, then test your microphone in Settings.',
  'La dictée a besoin du micro. Réessaie et accepte la demande du navigateur.':
    'Dictation needs the microphone. Try again and accept the browser prompt.',
  'Aucun micro détecté. Teste-le dans Réglages → Microphone.':
    'No microphone detected. Test it in Settings → Microphone.',
  'Le service vocal du navigateur est injoignable. Va dans Réglages → Microphone et lance la recherche : AgentHub transcrira lui-même, sans lui.':
    'The browser\'s speech service is unreachable. Go to Settings → Microphone and run the search: AgentHub will transcribe itself, without it.',
  'Transcription': 'Transcription',
  'Transcription en place.': 'Transcription ready.',
  'Aucun service de transcription configuré.': 'No transcription service set up.',
  'Chercher un service de transcription': 'Look for a transcription service',
  'Chercher à nouveau': 'Search again',
  'Essai de tes services, un modèle après l\'autre…': 'Trying your services, one model after another…',
  'Enregistrement trop court.': 'Recording too short.',
  'Ce navigateur ne sait pas enregistrer d\'audio.': 'This browser cannot record audio.',
  'Ce navigateur ne sait pas dicter. Configure un service de transcription dans Réglages → Microphone.':
    'This browser cannot dictate. Set up a transcription service in Settings → Microphone.',
  'Enregistrement — reclique pour transcrire.': 'Recording — click again to transcribe.',
  'Transcription…': 'Transcribing…',

  // libellés de formulaire et explications courtes
  'Nom (un seul mot, sert aux @mentions)': 'Name (one word, used for @mentions)',
  'Rôle / instructions (system prompt)': 'Role / instructions (system prompt)',
  'Ton nom (affiché dans « Salut … »)': 'Your name (shown in “Hi …”)',
  'Alerte de dépense quotidienne (€)': 'Daily spend alert (€)',
  'Mémoire injectée à chaque appel': 'Memory injected on every call',
  'Enregistrer le mot de passe en base': 'Save the password in the database',
  'Ce que tous tes agents doivent savoir…': 'What all your agents need to know…',
  'ex: Contexte de l\'organisation': 'e.g. Organisation context',
  'ex : Fais-moi la veille du secteur, 5 points maximum, avec les sources.':
    'e.g. Give me the sector news, 5 bullets max, with sources.',
  'Séparés par des virgules. Servent à filtrer, pas au contexte des agents.':
    'Comma-separated. Used for filtering, not for agent context.',
  'Décris sa mission, son ton et ses limites. C\'est ce qui définit l\'agent.':
    'Describe its mission, tone and limits. This is what defines the agent.',
  'Stockée sur ton serveur uniquement, jamais renvoyée au navigateur.':
    'Stored on your server only, never sent back to the browser.',
  'Heure du serveur, pas celle de ton navigateur.': 'Server time, not your browser\'s.',
  'Chiffres renvoyés directement par le fournisseur.': 'Figures reported directly by the provider.',
  'Les modèles de ce service dont le nom évoque une image.':
    'The models of this service whose name suggests images.',
  'La liste se remplit quand la connexion aboutit.': 'The list fills in once the connection succeeds.',
  'Trouvé chez tes services déjà connectés': 'Found among your connected services',
  'Seulement lorsque l\'onglet est en arrière-plan.': 'Only when the tab is in the background.',
  'M\'avertir dans le navigateur quand un long traitement se termine':
    'Notify me in the browser when a long run finishes',
  'Ce qui apparaît dans la galaxie': 'What appears in the galaxy',
  'Changer le modèle de cette conversation': 'Change this conversation\'s model',
  'Retour aux modèles de chaque agent.': 'Back to each agent\'s own model.',
  'Revenir aux réglages des agents': 'Back to the agents\' settings',
  'Vérification de la configuration': 'Checking the configuration',
  'Chargement de la consommation': 'Loading usage',
  'Épingler — cette note passe en premier dans le contexte':
    'Pin — this note comes first in the context',
  'Un agent lancé à heure fixe dans un salon.': 'An agent run at a fixed time in a channel.',
  'Une fois créé, poste dessus :': 'Once created, post to it:',
  'CEO — pilote tout, délègue aux managers': 'CEO — runs everything, delegates to managers',
  'Manager — délègue aux workers': 'Manager — delegates to workers',
  'Le membre le plus haut placé reçoit les messages du salon et délègue aux autres.':
    'The most senior member receives the channel messages and delegates to the others.',
  'Le message arrive dans le salon et les agents répondent comme si tu l\'avais écrit.':
    'The message lands in the channel and the agents reply as if you had written it.',
  'Le message est retiré de la conversation et du contexte envoyé aux agents.':
    'The message is removed from the conversation and from the context sent to agents.',
  'Ce que ton Hermes sait faire.': 'What your Hermes can do.',
  'Ce que tes agents ont réellement consommé auprès des fournisseurs.':
    'What your agents actually spent with the providers.',
  'Tout ce que ton organisation a fait, du plus récent au plus ancien.':
    'Everything your organisation has done, newest first.',
  'Du plus récemment utilisé au plus ancien — une note remonte quand tu l\'ouvres ou qu\'un agent s\'en sert.':
    'Most recently used first — a note rises when you open it or an agent uses it.',
  'Ta session actuelle est conservée. Utile si tu as ouvert AgentHub sur une machine que tu ne contrôles plus.':
    'Your current session is kept. Useful if you left AgentHub open on a machine you no longer control.',
  'Les agents qui l\'utilisaient basculeront sur un autre fournisseur disponible.':
    'Agents using it will switch to another available provider.',
  'Laisse vide pour ne pas être prévenu. L\'alerte n\'arrête rien, elle avertit.':
    'Leave empty for no warning. The alert stops nothing, it warns.',
  'glisser pour tourner · molette pour zoomer · clic sur une étoile · double-clic met en pause':
    'drag to rotate · wheel to zoom · click a star · double-click pauses',
  'Tous les messages et toutes les tâches de ce salon seront définitivement effacés. Les agents, eux, sont conservés.':
    'Every message and task in this channel will be permanently erased. The agents themselves are kept.',

  // assistant de première ouverture
  'Choisis ton mot de passe pour prendre la main.': 'Choose your password to take control.',
  'Quatre étapes pour que ton organisation d\'agents se mette au travail. Compte trois minutes.':
    'Four steps to get your agent organisation working. Allow three minutes.',
  'Chaque agent pourra ensuite utiliser le service et le modèle de ton choix. Il en faut au moins un pour continuer.':
    'Each agent can then use the service and model you choose. At least one is required to continue.',
  'Il sera appliqué à tes agents existants. Tu pourras toujours en changer agent par agent depuis sa fiche.':
    'It will apply to your existing agents. You can still change it agent by agent from its card.',
  'Ce service n\'a listé aucun modèle. Retourne à l\'étape précédente et teste la connexion.':
    'This service listed no model. Go back a step and test the connection.',
  'Une seule clé pour le texte et les images. C\'est la voie que je recommande.':
    'One key for both text and images. This is the route I recommend.',
  'Clé gratuite sur Google AI Studio.': 'Free key on Google AI Studio.',
  'Clé gratuite sur Google AI Studio, avec un quota de départ confortable.':
    'Free key on Google AI Studio, with a generous starting quota.',
  'Crée une clé sur ton tableau de bord OpenRouter.': 'Create a key on your OpenRouter dashboard.',
  'Crée une clé dans la console OpenAI.': 'Create a key in the OpenAI console.',
  'Crée une clé dans la console Groq.': 'Create a key in the Groq console.',
  'Crée une clé dans les réglages Together AI.': 'Create a key in the Together AI settings.',
  'Si tu veux qu\'ils produisent des illustrations, des logos ou des maquettes dans les conversations, il leur faut un modèle d\'image. C\'est facultatif — tout le reste fonctionne sans.':
    'If you want them to produce illustrations, logos or mock-ups in conversations, they need an image model. It is optional — everything else works without it.',
  'L\'outil de dessin restera indisponible, et tes agents le diront au lieu de promettre une image qui n\'arrivera pas.':
    'The drawing tool will stay unavailable, and your agents will say so instead of promising an image that never comes.',

  // Hermes
  'Recherche d\'Hermes sur ton serveur…': 'Looking for Hermes on your server…',
  'Hermes enregistré, mais sa passerelle ne répond pas. Diagnostic…':
    'Hermes saved, but its gateway is not responding. Diagnosing…',
  'C\'est la seule chose qui manque.': 'That is the only thing missing.',
  'Les deux conteneurs partagent-ils un réseau ?': 'Do the two containers share a network?',
  'Lance plutôt ceci sur ton serveur — c\'est exactement ce qu\'AgentHub ferait :':
    'Run this on your server instead — it is exactly what AgentHub would do:',
  'Tu peux aussi passer cette étape : AgentHub marche très bien sans Hermes, avec n\'importe quel autre service.':
    'You can also skip this step: AgentHub works fine without Hermes, with any other service.',
  'Hermes apporte la continuité de session, ses outils et sa mémoire persistante. AgentHub fonctionne sans, mais c\'est mieux avec.':
    'Hermes brings session continuity, its tools and its persistent memory. AgentHub works without it, but it is better with.',
  'AgentHub peut la démarrer pour toi. C\'est instantané, et sans effet sur la configuration d\'Hermes.':
    'AgentHub can start it for you. It is instant, and leaves Hermes\'s configuration untouched.',
  'L\'installation se fait côté Hermes, qui applique ses propres contrôles (analyse de sécurité, provenance, épinglage). AgentHub ne touche pas à ses fichiers.':
    'Installation happens on the Hermes side, which applies its own checks (security scan, provenance, pinning). AgentHub does not touch its files.',
  'Ce skill est déjà actif : tes agents branchés sur Hermes peuvent s\'en servir.':
    'This skill is already active: your agents connected to Hermes can use it.',
  'Skills invisibles : les dossiers d\'Hermes ne sont pas montés dans le conteneur.':
    'Skills not visible: Hermes\'s folders are not mounted in the container.',
};

const DICTS = { en: { ...CORE_EN } };

const state = {
  lang: localStorage.getItem('ah_lang') || 'fr',
  missing: new Set(),
  pending: null,
  observer: null,
};

const dict = () => DICTS[state.lang] || null;

/**
 * Traduction d'une chaîne, ou null si inconnue.
 *
 * Les blancs sont ramenés à un espace simple. Sans ça, une phrase écrite sur
 * deux lignes dans un gabarit arrive avec son retour à la ligne et son
 * indentation au milieu, et ne correspond à aucune clé — ce qui laissait en
 * français la plupart des textes longs de l'assistant, les seuls qu'on prend
 * vraiment le temps de lire.
 */
function lookup(raw) {
  const d = dict();
  if (!d) return null;
  const text = raw.trim().replace(/\s+/g, ' ');
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
const SKIP_CLOSEST = '.msg-content, .msg-image, .reasoning-body, .scan-log, '
  + '.note-preview, .recent-prev, .skill-desc, pre, code, textarea, input, .galaxy-wrap';
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE', 'CANVAS']);

function translateNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const parent = node.parentElement;
    if (!parent || SKIP_TAGS.has(parent.tagName)) return;
    if (parent.closest(SKIP_CLOSEST)) return;
    const raw = node.nodeValue;
    const trimmed = raw.trim();
    if (!trimmed) return;
    // On cherche sur la forme normalisée, mais on remplace le texte tel qu'il
    // est écrit : l'indentation autour reste intacte.
    const t = lookup(raw);
    if (t !== null && t !== trimmed) node.nodeValue = raw.replace(trimmed, t);
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
