# AgentHub

Une interface web pour faire travailler **plusieurs agents IA ensemble**, plutôt qu'un
chat de plus avec un seul modèle.

Tu recrutes des agents, tu leur donnes un rang — CEO, manager, worker — et tu les
regroupes en **pôles**. Quand tu écris dans un pôle, le membre le plus haut placé
répond, et il peut **déléguer** le travail vers le bas, y compris à des agents d'un
autre pôle. Chaque tâche déléguée est suivie, chaque réponse arrive en streaming.

Aucune étape de build : Node, du JavaScript vanilla, et SQLite.

![Node](https://img.shields.io/badge/node-%E2%89%A520-3e5faf)
![Docker](https://img.shields.io/badge/docker-compose-3e5faf)
![License](https://img.shields.io/badge/license-MIT-3e5faf)

---

## Sommaire

- [Ce que ça fait](#ce-que-ça-fait)
- [Installation](#installation)
- [Premier démarrage](#premier-démarrage)
- [Configuration](#configuration)
- [Mise à jour, sauvegarde, dépannage](#mise-à-jour)
- [Architecture](#architecture)
- [Tests](#tests)

---

## Ce que ça fait

**Une organisation, pas une liste de prompts.** Les rangs sont réels : un manager ne
peut déléguer qu'à des agents strictement moins gradés, jamais à lui-même, jamais en
boucle. La chaîne CEO → manager → worker fonctionne sur trois niveaux, et un manager
peut emprunter un worker à un autre pôle.

**Un second cerveau.** Des notes que tu écris une fois et qui sont injectées dans le
prompt de *tous* tes agents, quel que soit leur fournisseur. Tu ne répètes plus le
contexte de ton activité à chaque conversation.

**Plusieurs fournisseurs, au choix par agent.** Hermes, AgentRouter, OpenRouter,
OpenAI, Groq, Together, Ollama, ou n'importe quel endpoint compatible OpenAI. Chaque
agent a son service et son modèle — et tu peux surcharger le tout **pour une seule
conversation**, effort de raisonnement compris, sans toucher aux fiches.

**Une consommation qui ne ment pas.** Une ligne par appel modèle, tokens entrants et
sortants, répartition par modèle et par agent, courbe d'évolution au survol. Quand le
fournisseur renvoie un décompte réel il est utilisé ; sinon c'est une estimation,
explicitement étiquetée comme telle.

**Temps réel.** WebSocket avec reconnexion et resynchronisation, streaming
token-par-token, statut des agents, arrêt d'un run en cours.

**Soigné.** Thème clair et sombre, contraste WCAG AA vérifié sur les deux, navigation
au clavier, mobile, `prefers-reduced-motion`.

---

## Installation

### Ce qu'il te faut

- **Ton propre serveur** — un VPS, une machine locale, peu importe. AgentHub
  s'installe chez toi et ne dépend d'aucun service hébergé par qui que ce soit.
- **Docker** avec Compose (la voie recommandée) — ou Node ≥ 20 en direct.
- **Un service de modèles** compatible OpenAI :
  - [Nous Hermes Agent](https://github.com/NousResearch/hermes-agent) sur le même
    serveur — le compagnon pour lequel AgentHub est pensé ;
  - ou une clé [OpenRouter](https://openrouter.ai), OpenAI, Groq, Together… ;
  - ou [Ollama](https://ollama.com) en local, sans clé ni connexion sortante.

Hermes n'est pas obligatoire, mais c'est lui qui apporte la continuité de session,
ses outils et sa mémoire persistante. Le reste du guide part du principe que tu l'as
déjà sur ton serveur.

### En deux commandes

```bash
git clone https://github.com/yhanottv/agenthub.git
cd agenthub
docker compose up -d --build
```

C'est tout. **Aucun fichier de configuration à créer.**

Ouvre **http://localhost:8090** : le site te demande de choisir ton mot de passe, puis
un assistant te fait brancher ton service de modèles. Le secret de session est généré
tout seul au premier démarrage et conservé dans la base.

> ⚠️ **Prends la main tout de suite.** Tant que personne n'a choisi de mot de passe,
> le premier visiteur peut le faire. Ouvre l'application depuis ta machine avant
> d'exposer le port sur Internet. Une fois le mot de passe défini, toute nouvelle
> tentative est refusée.

### Si Hermes tourne déjà sur ce serveur

C'est le cas le plus courant, et **la seule étape qui demande un peu d'attention**.
Les deux conteneurs doivent partager un réseau Docker, sinon AgentHub ne peut pas
joindre Hermes par son nom.

Trouve le réseau d'Hermes :

```bash
docker inspect <conteneur-hermes> \
  --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}'
```

Décommente ensuite les deux blocs `networks:` de `docker-compose.yml` en y mettant ce
nom, puis relance `docker compose up -d`.

Il te faudra aussi la clé du gateway Hermes : c'est la valeur de `API_SERVER_KEY`
dans sa configuration. L'assistant te la demande à l'étape 2, teste la connexion et
liste les modèles disponibles.

> Si le nom de ton conteneur n'est pas `hermes-agent` ou si son port n'est pas 8642,
> corrige simplement l'URL depuis l'assistant — rien n'est figé dans le code.

### Sans Docker

```bash
npm install
DATA_DIR=./data node server.js
```

`better-sqlite3` se compile à l'installation ; il te faut Python 3 et un compilateur
C++ si aucun binaire précompilé ne correspond à ta plateforme.

### Derrière un nom de domaine (HTTPS)

Le `docker-compose.yml` publie le port 8090 **en HTTP clair**. Pour un serveur exposé
sur Internet, mets un reverse proxy devant et **retire la section `ports:`** — sinon
le mot de passe circule en clair. Le fichier contient les labels
[Traefik](https://traefik.io) prêts à décommenter ; avec Caddy ou nginx, fais pointer
le proxy sur le port 8090 du conteneur.

### Où vivent tes données

Tout reste chez toi : la base SQLite dans un volume Docker, les clés API dans cette
base, les conversations aussi. AgentHub ne contacte que les services de modèles que
tu as toi-même configurés. Aucune télémétrie, aucun serveur central, rien qui
remonte à l'auteur du projet.

---

## Premier démarrage

Tout se passe sur le site, rien en ligne de commande.

**Ton mot de passe d'abord.** Le premier écran te le fait choisir et confirmer — huit
caractères minimum. Il est haché avant d'être stocké : il n'apparaît en clair nulle
part, ni dans un fichier, ni dans la base. Il n'y a donc **aucune récupération
possible**, note-le. Tu pourras le changer plus tard depuis Réglages.

**Puis l'assistant**, en quatre étapes :

1. **Bienvenue** — ce qui va être configuré.
2. **Hermes** — il sonde réellement le gateway et affiche le verdict, avec l'erreur
   exacte et des pistes si ça ne répond pas. Tu peux passer cette étape si tu
   n'utilises pas Hermes.
3. **Services** — connecte au moins un fournisseur. Tu colles la clé, tu cliques
   **Tester**, et AgentHub interroge `/v1/models` pour lister ce qui est réellement
   disponible. Tu choisis dans la liste plutôt que de taper un nom au hasard.
4. **Modèle par défaut** — appliqué d'un coup à tous tes agents.

L'organisation par défaut est créée au premier lancement : un CEO, deux managers,
cinq workers, trois pôles et un salon Hermes. Tout est modifiable, rien n'est figé.

> **À propos du test de connexion.** Certains services — OpenRouter par exemple —
> publient leur catalogue **sans authentification**. Obtenir une liste de modèles ne
> prouve donc pas que ta clé est valide. AgentHub refuse de tester un service qui
> exige une clé quand aucune n'est fournie, et quand le catalogue s'avère public il te
> le dit franchement au lieu d'afficher une coche verte trompeuse.

---

## Configuration

Tout se règle depuis l'interface : mot de passe, services, modèles, identité de
l'organisation. La base de données fait foi.

### Variables d'environnement (toutes facultatives)

Tu n'en as besoin **que** si tu veux scripter une installation sans passer par les
écrans. Copie alors `.env.example` en `.env` et remplis ce qui t'intéresse.

| Variable (`.env`) | Lue par le serveur sous le nom | Rôle |
|---|---|---|
| `AGENTHUB_PASSWORD` | `APP_PASSWORD` | Fige le mot de passe. **Le rend non modifiable depuis l'interface.** |
| `AGENTHUB_SECRET` | `APP_SECRET` | Fige la clé de signature des sessions. Sinon générée et conservée en base. |
| `HERMES_API_URL` / `HERMES_API_KEY` / `HERMES_MODEL` | identiques | Pré-remplit le fournisseur Hermes. |
| `AGENTROUTER_API_URL` / `AGENTROUTER_API_KEY` / `AGENTROUTER_MODEL` | identiques | Pré-remplit le fournisseur AgentRouter. |
| `OWNER_NAME` / `ORG_NAME` | identiques | Ton nom et celui de l'organisation, au tout premier démarrage. |
| `TRUST_PROXY` | identique | À mettre à `1` **uniquement** derrière un reverse proxy. Voir plus bas. |
| `DATA_DIR` | identique | Emplacement de la base SQLite. Défaut : `/data` en Docker, `./data` sinon. |
| `PORT` | identique | Port d'écoute. Défaut : `8090`. |
| `TRAEFIK_HOST` | — | Domaine servi, utilisé par les labels Traefik du compose. |

Les noms `AGENTHUB_*` sont ceux de ton `.env` : c'est `docker-compose.yml` qui les
traduit. **Si tu lances `node server.js` à la main, exporte directement
`APP_PASSWORD` et `APP_SECRET`** — sinon tes variables ne servent à rien et
l'instance reste ouverte au premier visiteur.

Il n'existe pas de variable pour choisir le fournisseur par défaut : quand celui d'un
agent n'est pas utilisable, AgentHub retombe sur le premier fournisseur configuré et
actif.

Elles ne servent qu'au **tout premier démarrage** : ensuite les réglages vivent en
base et l'interface prend le dessus.

### `TRUST_PROXY`

Par défaut AgentHub ne fait **pas** confiance à l'en-tête `X-Forwarded-For`. C'est
volontaire : cet en-tête est la seule clé du verrouillage après huit tentatives, et
tant que rien ne filtre devant, n'importe qui peut le forger pour deviner ton mot de
passe sans jamais être bloqué.

Si — et seulement si — un reverse proxy est réellement devant, mets `TRUST_PROXY=1`
pour que les journaux et le verrouillage voient la vraie adresse du client. Le
drapeau `Secure` du cookie ne dépend pas de ce réglage : il est posé dès que la
requête arrive en HTTPS, proxy ou pas.

### Changer de mot de passe

**Réglages → Mot de passe.** L'ancien est demandé. Si `APP_PASSWORD` est défini dans
l'environnement du serveur (via `AGENTHUB_PASSWORD` dans ton `.env` si tu passes par
Compose), cette section explique qu'il faut retirer la variable pour reprendre la
main.

> ⚠️ Retire-la **avant** d'avoir choisi un mot de passe dans l'interface, jamais
> après coup sur une instance en service : AgentHub garde une trace durable du fait
> qu'elle a été revendiquée, et refusera de rouvrir la porte. Si tu te retrouves
> verrouillé, remets la variable, connecte-toi, puis définis ton mot de passe depuis
> Réglages pour qu'il soit stocké en base — tu pourras retirer la variable ensuite.

### Changer de modèle en cours de conversation

La pastille sous le champ de saisie indique sur quoi tourne la conversation. Un clic
permet de choisir un autre service, un autre modèle, et un **effort de raisonnement**
(rapide / équilibré / approfondi). Le réglage ne vaut que pour ce salon et ne modifie
aucune fiche d'agent.

L'effort est envoyé au service sous le nom `reasoning_effort`. Tous ne le gèrent pas :
si le tien le refuse, tu obtiens une erreur explicite et il suffit de revenir sur
« automatique ».

---

## Mise à jour

```bash
git pull
docker compose up -d --build
```

Tes données vivent dans un volume Docker, elles survivent aux reconstructions. Le
schéma se met à jour tout seul au démarrage.

### Sauvegarder

Toute la base tient dans un fichier SQLite :

```bash
docker run --rm -v agenthub_agenthub-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/agenthub-$(date +%F).tar.gz -C /data .
```

### Dépannage

| Symptôme | Piste |
|---|---|
| Le conteneur redémarre en boucle | `docker logs agenthub` — en général le volume `/data` n'est pas inscriptible, ou la compilation de `better-sqlite3` a échoué |
| « Aucun fournisseur configuré » | Réglages → Fournisseurs, ou relance l'assistant |
| Les agents répondent « clé refusée » | La clé est invalide ou expirée côté service |
| L'interface semble figée après une mise à jour | Recharge de force (`Ctrl+Shift+R`) |
| Hermes injoignable | Vérifie que les deux conteneurs partagent un réseau Docker |

---

## Architecture

```
navigateur ──REST──▶ server.js ──▶ orchestrator.js ──▶ llm.js ──▶ fournisseur
     ▲                   │              (délégation)      (SSE)
     └──── WebSocket ────┘
                         └──▶ db.js (SQLite/WAL)
```

| Fichier | Rôle |
|---|---|
| `server.js` | API REST, WebSocket, auth par cookie signé, assets versionnés |
| `orchestrator.js` | Routage, délégation, tâches, sérialisation et annulation par salon |
| `llm.js` | Client SSE, registre des fournisseurs, découverte de modèles |
| `db.js` | Schéma SQLite et dépôts |
| `public/` | Le front, sans build ni dépendance |

Environ 3 500 lignes en tout.

### Choix qui méritent une explication

**Interpolation cubique monotone** pour la courbe de consommation, plutôt qu'un
Catmull-Rom : elle ne peut mathématiquement pas dépasser, donc une plage de zéros
reste collée à la ligne de base au lieu de plonger dessous.

**Assets versionnés par empreinte.** Le serveur calcule un hash de `app.js` et
`styles.css` au démarrage et réécrit le shell HTML pour pointer dessus. Sans ça, un
`max-age` laisse un déploiement live mais invisible pendant une heure.

**Les clés ne transitent jamais.** L'API expose `keyConfigured` et un indice masqué.
Enregistrer un fournisseur sans retaper la clé conserve celle stockée : le formulaire
n'a jamais besoin de la détenir.

---

## Tests

Deux suites, à lancer contre l'image construite :

```bash
docker build -t agenthub:latest .
docker run --rm -v "$PWD/tests:/test:ro" agenthub:latest node /test/boot-test.mjs
docker run --rm -v "$PWD/tests:/test:ro" agenthub:latest node /test/integration-test.mjs
```

`boot-test` démarre réellement le serveur et exerce HTTP et WebSocket — il attrape
les erreurs qu'une simple vérification de syntaxe ne voit pas. `integration-test`
monte un faux gateway SSE et fait tourner l'orchestrateur pour de vrai : délégation
sur trois niveaux, refus des délégations illégales, annulation, mémoire partagée,
comptabilité des tokens, surcharge de modèle par conversation.

> Lance-les **dans le conteneur**, pas sur ta machine : l'image tourne sur Node 20, et
> du code accepté par Node 24 peut y échouer.

---

## Ce qui manque encore

- Les agents produisent du texte, ils **n'agissent pas** — pas encore d'outils ni de
  function-calling. C'est le plus gros écart avec un véritable espace de travail.
- Le second cerveau est écrit à la main ; les agents ne s'y ajoutent rien eux-mêmes.
- Les sessions sont révocables à la déconnexion (nonce aléatoire par login), mais un cookie volé reste valide jusqu'à la prochaine expiration de 30 jours si l'utilisateur ne se déconnecte pas.
- Un seul utilisateur, un seul mot de passe. Pas de multi-comptes.

---

## Licence

MIT
