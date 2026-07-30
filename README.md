# AgentHub

Une interface web pour faire travailler **plusieurs agents IA ensemble**, plutôt qu'un
chat de plus avec un seul modèle.

Tu recrutes des agents, tu leur donnes un rang — CEO, manager, worker — et tu les
regroupes en **pôles**. Quand tu écris dans un pôle, le membre le plus haut placé
répond, et il peut **déléguer** le travail vers le bas, y compris à des agents d'un
autre pôle. Chaque tâche déléguée est suivie, chaque réponse arrive en streaming.

Tes agents ne se contentent pas d'écrire : ils cherchent sur le web, lisent des pages,
fouillent leur propre mémoire, calculent, lisent tes fichiers et créent des images.

Aucune étape de build : Node, du JavaScript vanilla, et SQLite.

![Node](https://img.shields.io/badge/node-%E2%89%A520-3e5faf)
![Docker](https://img.shields.io/badge/docker-compose-3e5faf)
![Dépendances](https://img.shields.io/badge/d%C3%A9pendances-3-3e5faf)
![License](https://img.shields.io/badge/license-MIT-3e5faf)

---

## Sommaire

- [Ce que ça fait](#ce-que-ça-fait)
- [Installation](#installation)
- [Premier démarrage](#premier-démarrage)
- [Configuration](#configuration)
- [Sécurité](#sécurité)
- [Mise à jour, sauvegarde, dépannage](#mise-à-jour)
- [Architecture](#architecture)
- [Tests](#tests)

---

## Ce que ça fait

**Une organisation, pas une liste de prompts.** Les rangs sont réels : un manager ne
peut déléguer qu'à des agents strictement moins gradés, jamais à lui-même, jamais en
boucle. La chaîne CEO → manager → worker fonctionne sur trois niveaux, et un manager
peut emprunter un worker à un autre pôle.

**Des agents qui agissent.** Recherche web, lecture de pages, fouille de la mémoire et
de l'historique, calcul exact, lecture des fichiers déposés dans le salon, création
d'images. Chaque appel d'outil est affiché au-dessus de la réponse : une affirmation
appuyée sur une vraie recherche ne se confond pas avec la même phrase inventée.

**Un second cerveau, et une carte pour s'y retrouver.** Des notes écrites une fois,
injectées dans le prompt de *tous* tes agents. Relie-les avec des `[[doubles crochets]]`
et la vue **Graph** cartographie tout l'espace de travail en galaxie navigable : notes,
agents, pôles, tâches et **skills Hermes**, groupés en amas, chaque famille activable.
Tes agents alimentent eux-mêmes cette mémoire — automatiquement, ou après ta validation
si tu préfères.

**Les skills de ton Hermes, visibles depuis AgentHub.** L'onglet **Skills** montre le catalogue officiel Nous
Research au complet, groupé par catégorie, avec ce qui est déjà actif chez toi.
Recherche, filtres, et la commande exacte pour activer ce qui t'intéresse.

**Les connexions MCP, au même endroit.** L'onglet **MCP** montre ce que ton Hermes peut
piloter à distance — Blender, Unreal Engine, n8n, Linear — avec le transport, ce qu'il
faut préparer côté logiciel, les variables à renseigner, et l'état réel : branché, en
pause, ou seulement au catalogue. Aucun montage à configurer : AgentHub lit le catalogue
d'Hermes par le socket Docker qu'il utilise déjà pour le détecter. Rien n'est branché
depuis ici — donner à un agent le droit d'ouvrir Blender passe par Hermes et ses propres
contrôles ; AgentHub rend la commande, préfixée du `docker exec` qui la rend utilisable.

**Le code produit sort de la conversation.** Chaque bloc de code se copie et se télécharge
sous son vrai nom de fichier. Une page complète s'ouvre dans un **panneau à droite**, la
conversation restant utilisable à gauche : on corrige, on relance, on regarde. Un site à
plusieurs fichiers fonctionne — feuille de style, scripts, liens internes — même livré en
archive `.zip`, qu'AgentHub sait rouvrir pour l'afficher. Le code d'un modèle tourne dans
une iframe cloisonnée, en origine opaque, sans accès à ta session, et ne peut joindre que
ses propres fichiers.

**Dicter, et une interface bilingue.** Le micro écrit dans le composeur : par l'API du
navigateur quand elle répond, sinon en enregistrant et en faisant transcrire par le
service que tu as déjà configuré — plus fiable, et ça vise l'entrée audio de ton choix.
Un globe dans la barre du haut bascule toute l'interface en anglais ; ce que le
dictionnaire ne couvre pas est traduit une fois par ton modèle, puis conservé.

**Plusieurs fournisseurs, au choix par agent.** Hermes, AgentRouter, OpenRouter, OpenAI,
Google Gemini, Groq, Together, Ollama, ou n'importe quel endpoint compatible OpenAI.
Chaque agent a son service et son modèle — et tu peux surcharger le tout **pour une
seule conversation**, effort de raisonnement compris.

**Une consommation qui ne ment pas.** Une ligne par appel modèle, tokens entrants et
sortants, **coût en euros**, répartition par modèle, par agent et par salon. Un modèle
sans tarif renseigné n'est pas compté zéro en silence : il est signalé, et le total
s'annonce comme un plancher. Seuil d'alerte quotidien qui prévient sans rien couper.

**Retrouver.** Recherche plein texte (SQLite FTS5) sur les conversations et la mémoire,
depuis la palette `Ctrl K`, termes surlignés.

**Des fichiers.** Dépôt par bouton ou glisser-déposer, jusqu'à 10 Mo. Les fichiers texte
sont réellement lisibles par les agents. Export d'une conversation en Markdown.

**Ça tourne tout seul.** Sauvegardes automatiques, déclenchements programmés (« tous les
matins à 8 h 30, Chercheur me fait la veille »), webhooks entrants, notifications
navigateur en fin de traitement long.

**Temps réel.** WebSocket avec reconnexion et resynchronisation, streaming
token-par-token, raisonnement du modèle affiché à part et replié, statut des agents,
arrêt d'un run en cours.

**Soigné.** Thème clair et sombre, contraste WCAG AA vérifié sur les deux, navigation au
clavier, mobile, `prefers-reduced-motion`.

---

## Installation

### Ce qu'il te faut

- **Ton propre serveur** — un VPS, une machine locale, peu importe. AgentHub s'installe
  chez toi et ne dépend d'aucun service hébergé par qui que ce soit.
- **Docker** avec Compose (la voie recommandée) — ou Node ≥ 20 en direct.
- **Au moins une clé API.** Une seule clé [OpenRouter](https://openrouter.ai) couvre à
  la fois le texte et les images : c'est le chemin le plus court. Une clé
  [Google Gemini](https://aistudio.google.com/apikey), gratuite, fait aussi les deux.
  [Ollama](https://ollama.com) fonctionne en local, sans clé ni connexion sortante.

### En deux commandes

```bash
git clone https://github.com/yhanottv/agenthub.git
cd agenthub && docker compose up -d --build
```

C'est tout. **Aucun fichier de configuration à créer.**

Ouvre **http://localhost:8090** : le site te demande de choisir ton mot de passe, puis un
assistant en cinq étapes te fait tout brancher. Le secret de session est généré au
premier démarrage et conservé dans la base.

#### Sur un serveur distant

AgentHub n'écoute que sur la boucle locale (`127.0.0.1:8090`). Ce n'est pas une
limitation à contourner : tant que personne n'a choisi de mot de passe, le premier
visiteur peut le faire, et un port ouvert sur Internet pendant cette fenêtre laisse un
inconnu s'emparer de l'instance — avec tes conversations et tes clés API.

Monte donc un tunnel depuis ta machine :

```bash
ssh -L 8090:localhost:8090 utilisateur@ton-serveur
```

puis ouvre **http://localhost:8090**. Le tunnel n'est nécessaire que pour la première
prise en main ; pour un accès permanent, passe par un nom de domaine (voir plus bas),
ce qui te donne aussi HTTPS.

### Hermes Agent

[Hermes Agent](https://github.com/NousResearch/hermes-agent) apporte la continuité de
session, ses outils et sa mémoire persistante, plus un catalogue de skills. **Il n'est
pas obligatoire** — AgentHub fonctionne très bien avec n'importe quel autre service.

L'assistant s'en occupe : à l'étape 2, un bouton **Détecter Hermes automatiquement**.

- **Hermes est déjà là** → AgentHub le trouve sur le réseau Docker, et si le socket
  Docker lui est accessible, il lit même sa clé `API_SERVER_KEY` directement dans sa
  configuration. Un clic, c'est branché.
- **Hermes n'est pas là** → AgentHub propose de l'installer (voir
  [Sécurité](#installer-hermes-depuis-agenthub)), ou te donne le fichier `compose` et
  les commandes exactes à lancer toi-même.

Pour voir les **skills** d'Hermes dans AgentHub, monte ses dossiers en lecture seule —
`docker-compose.yml` contient le bloc tout prêt, il n'y a que le nom du volume à
ajuster.

### Derrière un nom de domaine (HTTPS)

C'est la bonne façon d'y accéder au quotidien : ton mot de passe ne circule plus en
clair, et le tunnel SSH n'est plus nécessaire.

Mets un reverse proxy devant, **retire la section `ports:`** (le proxy joint le
conteneur par le réseau Docker) et ajoute `TRUST_PROXY=1` à ton `.env` pour que le
verrouillage après huit tentatives voie la vraie adresse des visiteurs. Le
`docker-compose.yml` contient les labels [Traefik](https://traefik.io) prêts à
décommenter ; avec Caddy ou nginx, fais pointer le proxy sur le port 8090 du conteneur.

### Sans Docker

```bash
npm install
DATA_DIR=./data node server.js
```

`better-sqlite3` se compile à l'installation ; il te faut Python 3 et un compilateur C++
si aucun binaire précompilé ne correspond à ta plateforme.

### Où vivent tes données

Tout reste chez toi : la base SQLite dans un volume Docker, les clés API dans cette
base, les conversations et les fichiers déposés aussi. AgentHub ne contacte que les
services que tu as toi-même configurés. Aucune télémétrie, aucun serveur central.

---

## Premier démarrage

Tout se passe sur le site, rien en ligne de commande.

**Ton mot de passe d'abord.** Huit caractères minimum, haché avant d'être stocké : il
n'apparaît en clair nulle part. Il n'y a donc **aucune récupération possible**, note-le.

**Puis l'assistant**, en cinq étapes :

1. **Bienvenue** — ce qu'il te faut avoir sous la main.
2. **Hermes** — détection automatique, installation ou configuration manuelle. Passable.
3. **Services** — connecte au moins un fournisseur. Tu colles la clé, tu cliques
   **Tester**, et AgentHub interroge `/v1/models` pour lister ce qui est réellement
   disponible. Chaque service indique où trouver sa clé, avec un lien direct.
4. **Modèle par défaut** — appliqué d'un coup à tous tes agents.
5. **Images** — le modèle qui dessinera. Facultatif, avec des couples service + modèle
   connus pour fonctionner et leur prix à l'image.

L'organisation par défaut est créée au premier lancement : un CEO, deux managers, cinq
workers, trois pôles et un salon Hermes. Tout est modifiable.

> **À propos du test de connexion.** Certains services — OpenRouter par exemple —
> publient leur catalogue **sans authentification**. Obtenir une liste de modèles ne
> prouve donc pas que ta clé est valide. AgentHub refuse de tester un service qui exige
> une clé quand aucune n'est fournie, et quand le catalogue s'avère public il te le dit
> franchement au lieu d'afficher une coche verte trompeuse.

---

## Configuration

Tout se règle depuis l'interface : mot de passe, services, modèles, images, mémoire,
tarifs, sauvegardes, planification. La base de données fait foi.

### Variables d'environnement (toutes facultatives)

Tu n'en as besoin **que** pour scripter une installation sans passer par les écrans.
Copie alors `.env.example` en `.env`.

| Variable (`.env`) | Rôle |
|---|---|
| `AGENTHUB_PASSWORD` | Mot de passe d'amorçage. Remplaçable depuis Réglages, puis retirable. |
| `AGENTHUB_SECRET` | Clé de signature des sessions. Sinon générée et conservée en base. |
| `HERMES_API_URL` / `HERMES_API_KEY` / `HERMES_MODEL` | Pré-remplit le fournisseur Hermes. |
| `AGENTROUTER_API_URL` / `AGENTROUTER_API_KEY` / `AGENTROUTER_MODEL` | Pré-remplit AgentRouter. |
| `HERMES_SKILLS_DIR` / `HERMES_OPTIONAL_SKILLS_DIR` | Où lire les skills d'Hermes. |
| `OWNER_NAME` / `ORG_NAME` | Ton nom et celui de l'organisation, au premier démarrage. |
| `TRUST_PROXY` | À mettre à `1` **uniquement** derrière un reverse proxy. |
| `DATA_DIR` | Emplacement de la base. Défaut : `/data` en Docker, `./data` sinon. |
| `PORT` | Port d'écoute. Défaut : `8090`. |
| `TRAEFIK_HOST` | Domaine servi, utilisé par les labels Traefik du compose. |

Elles ne servent qu'au **premier démarrage** : ensuite les réglages vivent en base.

### Changer de mot de passe

**Réglages → Mot de passe.** L'ancien est demandé.

Si ton mot de passe vient de `AGENTHUB_PASSWORD`, **fais-le passer en base sans
attendre** : donne la valeur de la variable comme mot de passe actuel, choisis-en un
nouveau, et retire la variable ensuite. L'écran te le rappelle tant que ce n'est pas
fait.

> ⚠️ Pourquoi c'est important : une instance protégée par la seule variable est marquée
> comme revendiquée sans stocker aucun hash. Perdre ce `.env` la verrouillerait
> **définitivement**. Un mot de passe enregistré en base l'emporte sur la variable, ce
> qui rend celle-ci retirable sans risque.

### La mémoire partagée

**Second cerveau → Notes.** Le budget injecté dans chaque prompt est réglable, 60 000
caractères par défaut (environ 15 000 tokens), jusqu'à 400 000. Cette mémoire part avec
**chaque** message de **chaque** agent : la doubler double la part de contexte facturée
à chaque tour.

### Les connexions MCP

L'onglet **MCP** n'a rien à configurer. AgentHub lit le catalogue d'Hermes et sa
configuration de deux façons, dans cet ordre :

1. **Par le socket Docker** — celui qu'il utilise déjà pour détecter Hermes. Le catalogue
   vit dans l'image d'Hermes, à un chemin qu'aucun montage ne couvre par défaut : passer
   par là évite de te demander de modifier `docker-compose.yml` juste pour voir quelque
   chose. C'est la voie normale.
2. **Par un montage en lecture seule**, s'il existe : instantané, aucun appel. Les deux
   volumes sont ceux déjà documentés pour les skills — le catalogue est dans
   `/hermes-src/optional-mcps`, les serveurs branchés sous la clé `mcp_servers` de
   `/hermes-home/config.yaml`.

Un serveur configuré à la main, hors catalogue, apparaît quand même : la page ne doit pas
mentir sur ce qui tourne. Et un dossier d'Hermes présent sans `config.yaml` veut dire
« aucun serveur configuré », pas « lecture impossible » — les deux se ressemblent et ne se
disent pas pareil.

Ce qui traverse vers le navigateur : les **noms** des variables à renseigner, jamais leurs
valeurs.

---

## Sécurité

Ce projet s'installe sur ta machine et manipule tes clés API. Voici ce qu'il fait pour
les protéger, et les deux endroits où c'est à toi de décider.

**Les clés ne transitent jamais.** L'API expose `keyConfigured` et un indice masqué.
Enregistrer un fournisseur sans retaper la clé conserve celle stockée : le formulaire
n'a jamais besoin de la détenir.

**Aucune adresse interne n'est joignable par un outil.** Les agents peuvent lire des
pages web ; `tools.js` résout le nom lui-même, refuse boucle locale, RFC 1918,
link-local, CGNAT et ULA, et revalide chaque redirection. Sans ça, « lis
http://<voisin>:8318 » suffirait à faire recracher la configuration des conteneurs
voisins, clés comprises.

**Les images générées ne s'exécutent pas.** Seuls PNG, JPEG, WebP et GIF sont servis en
ligne, et le type est déduit des octets, jamais de ce que le service annonce. SVG est
volontairement exclu : c'est un document exécutable, l'afficher le ferait tourner sur
ton origine.

**Le reste** : CSP stricte, cookie signé `HttpOnly` `SameSite=Lax`, sessions en base
avec expiration et révocation, protection CSRF, vérification d'origine sur le WebSocket,
verrouillage après huit tentatives, mot de passe haché en scrypt.

### Le port publié

Par défaut AgentHub n'écoute que sur `127.0.0.1`. Publier `8090:8090` ouvrirait le port
sur toutes les interfaces — **en passant devant ufw**, car Docker écrit ses propres
règles iptables. Passe par un reverse proxy plutôt que par un port publié.

### Installer Hermes depuis AgentHub

L'assistant peut installer Hermes en un clic, mais cela demande de monter le socket
Docker dans le conteneur. **Ce n'est pas « un accès à Docker »** : qui peut parler à ce
socket peut démarrer un conteneur privilégié qui monte `/`. Le donner à AgentHub revient
à lui donner les droits root sur la machine.

C'est pour ça que le montage est **commenté par défaut** dans `docker-compose.yml`. Sans
lui, AgentHub sait quand même détecter Hermes et te donne les commandes exactes — la
même installation, à un copier-coller près. Ne l'active que sur une machine dont tu es
seul maître.

### ufw et Docker

Si tu actives `ufw`, vérifie d'abord `/etc/default/ufw` :

```
DEFAULT_FORWARD_POLICY="ACCEPT"
```

Avec la valeur `DROP` par défaut d'Ubuntu, activer ufw peut couper le trafic **entre
conteneurs et vers l'extérieur**, donc l'accès de tes agents à leurs fournisseurs.

---

## Mise à jour

```bash
git pull && docker compose up -d --build
```

Tes données vivent dans un volume Docker, elles survivent aux reconstructions. Le schéma
se met à jour tout seul au démarrage.

### Sauvegarder

AgentHub prend un instantané au démarrage puis une fois par jour, en conserve quatorze,
et les propose au téléchargement depuis **Réglages → Sauvegardes**.

Pour une copie manuelle, passe par l'API de SQLite et non par une copie de fichier : en
mode WAL, l'essentiel des écritures récentes vit dans le journal, et copier
`agenthub.db` seul peut ne restaurer presque rien.

```bash
docker exec agenthub node -e "import('/app/db.js').then(m => m.db.backup('/data/backup.db'))"
docker cp agenthub:/data/backup.db ./agenthub-$(date +%F).db
```

### Dépannage

| Symptôme | Piste |
|---|---|
| Le conteneur redémarre en boucle | `docker logs agenthub` — souvent le volume `/data` non inscriptible, ou la compilation de `better-sqlite3` |
| « Aucun fournisseur configuré » | Réglages → Fournisseurs, ou relance l'assistant |
| « … refuse cette clé » | La clé vient d'un autre service : elles ne sont pas interchangeables |
| Un modèle disparaît | Le fournisseur l'a retiré de son catalogue. AgentHub le rafraîchit toutes les six heures et bascule les agents concernés |
| L'interface semble figée après une mise à jour | Recharge de force (`Ctrl+Shift+R`) |
| Hermes injoignable | Les deux conteneurs partagent-ils un réseau Docker ? |
| Les skills n'apparaissent pas | Les volumes d'Hermes ne sont pas montés — voir `docker-compose.yml` |

---

## Architecture

```
navigateur ──REST──▶ server.js ──▶ orchestrator.js ──▶ llm.js ──▶ fournisseur
     ▲                   │           (délégation,        (SSE)
     └──── WebSocket ────┘            outils)
                         ├──▶ tools.js   (web, mémoire, images, archives)
                         ├──▶ skills.js  (catalogue Hermes)
                         ├──▶ mcp.js     (serveurs MCP d'Hermes)
                         ├──▶ archive.js (écriture et lecture de .zip)
                         ├──▶ hermes.js  (détection, installation, exec Docker)
                         └──▶ db.js      (SQLite/WAL, FTS5)
```

| Fichier | Rôle |
|---|---|
| `server.js` | API REST, WebSocket, auth, planificateur, sauvegardes, assets versionnés |
| `orchestrator.js` | Routage, délégation, boucle d'outils, tâches, annulation par salon |
| `llm.js` | Client SSE, retry, fournisseurs, découverte de modèles, images |
| `tools.js` | Outils exécutables par les agents, et les garde-fous réseau |
| `skills.js` | Lecture du catalogue de skills Hermes |
| `mcp.js` | Catalogue MCP d'Hermes et serveurs branchés, plus un lecteur YAML du strict nécessaire |
| `archive.js` | Écriture et lecture de `.zip`, sans dépendance, et audit d'un site livré |
| `hermes.js` | Détection et installation d'Hermes |
| `graph.js` | Groupes et liens de la carte |
| `db.js` | Schéma SQLite, dépôts, index de recherche |
| `public/` | Le front, sans build ni dépendance |

Trois dépendances en tout : `express`, `ws`, `better-sqlite3`.

### Choix qui méritent une explication

**Interpolation cubique monotone** pour la courbe de consommation, plutôt qu'un
Catmull-Rom : elle ne peut mathématiquement pas dépasser, donc une plage de zéros reste
collée à la ligne de base au lieu de plonger dessous.

**Assets versionnés par empreinte.** Le serveur calcule un hash de `app.js` et
`styles.css` au démarrage et réécrit le shell HTML. Sans ça, un `max-age` laisse un
déploiement live mais invisible pendant une heure.

**La carte est calculée une fois, puis figée.** L'empilement des amas est écrit à la
main — aucune dépendance, et la politique de sécurité interdit de charger three.js
depuis un CDN. Le placement est déterministe : on ne se repère pas dans un espace qui
change à chaque ouverture.

**Le délai avant le premier octet est à 90 secondes.** Mesuré en production sur une
passerelle multi-fournisseurs : 2,7 s, 3,2 s, 15,4 s, 3,2 s sur des requêtes quasi
identiques. Un modèle à raisonnement peut légitimement réfléchir longtemps ; 30 s
coupait des requêtes saines.

**Le coût est figé sur chaque appel.** Re-tarifer un modèle plus tard ne doit pas
réécrire ce que le mois dernier a coûté. Seuls les appels jamais tarifés sont rattrapés.

---

## Tests

Neuf suites, à lancer contre l'image construite :

```bash
docker build -t agenthub:latest . && npm test
```

| Suite | Ce qu'elle empêche de casser |
|---|---|
| `boot` | Le serveur démarre pour de vrai, et répond en HTTP comme en WebSocket |
| `integration` | Délégation sur trois niveaux, refus des délégations illégales, annulation, mémoire partagée, comptabilité des tokens, transcription |
| `password` | Un mot de passe posé dans l'environnement peut passer en base, et l'ancien cesse alors de fonctionner |
| `search` | L'index de recherche se reconstruit sur une base déjà remplie — le cas où le défaut se cache |
| `i18n` | Chaque libellé traduit existe encore à l'écran : un libellé reformulé rend son entrée morte, et la phrase repasse en français sans bruit |
| `archive` | Les `.zip` se relisent octet pour octet, une remontée de dossier est neutralisée, une bombe de décompression refusée |
| `preview` | En HTTP contre le vrai serveur : un site à modules tourne sans compilation, rien ne sort de l'aperçu, on ne remonte pas hors du site |
| `mcp` | Le lecteur YAML forme par forme, l'état réel d'un serveur, et le fait qu'une valeur d'environnement ne traverse jamais |
| `readme` | Ce fichier ne promet rien qui n'existe : fichiers cités, suites annoncées, variables documentées, liens du sommaire |

Les deux dernières existent parce que la prévisualisation a cassé deux fois de suite d'une
manière qu'aucun test unitaire n'aurait vue : une politique de sécurité qui refuse une
feuille de style sans un mot, un chemin qui pointe vers la racine du serveur. Ça ne se
voit qu'en demandant vraiment les fichiers.

> Lance-les **dans le conteneur**, pas sur ta machine : l'image tourne sur Node 20, et du
> code accepté par Node 24 peut y échouer.

---

## Ce qui manque encore

- **Un seul utilisateur, un seul mot de passe.** Pas de multi-comptes ni de rôles.
- Un cookie volé reste valide jusqu'à son expiration si personne ne se déconnecte.
  « Déconnecter les autres navigateurs » les révoque toutes, mais rien ne détecte un vol.
- La recherche web passe par le HTML de DuckDuckGo, sans clé : pas de quota, mais un
  balisage qui peut changer sans prévenir. Quand ça arrive, l'outil renvoie une liste
  vide et le dit, au lieu d'inventer.
- Les agents ne s'écrivent pas entre eux hors délégation, et ne planifient pas leur
  propre travail.
- **L'aperçu ne compile pas.** Il rebranche : chemins absolus ramenés vers le site,
  dépendances par nom résolues par une carte d'imports, feuille de style importée depuis un
  module réinjectée dans la page. Un projet qui a réellement besoin d'être compilé — JSX,
  TypeScript, Sass — ne s'ouvrira pas, et l'outil d'archive le dit à l'agent au moment où
  il peut encore corriger.
- **AgentHub ne parle pas MCP lui-même.** Il montre ce que ton Hermes peut piloter et rend
  la commande ; c'est Hermes qui se connecte.

---

## Licence

MIT — voir [LICENSE](LICENSE).
