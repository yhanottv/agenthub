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
![License](https://img.shields.io/badge/license-%C3%A0%20d%C3%A9finir-lightgrey)

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

- **Docker** avec Compose (la voie recommandée) — ou Node ≥ 20 en direct
- **Un service de modèles** compatible OpenAI. Au choix :
  - une clé [OpenRouter](https://openrouter.ai) — le plus simple pour démarrer,
    des centaines de modèles derrière une seule clé ;
  - une clé OpenAI, Groq, Together… ;
  - [Ollama](https://ollama.com) en local, sans clé ni connexion sortante ;
  - un gateway [Nous Hermes Agent](https://github.com/NousResearch/hermes-agent)
    si tu en as déjà un.

Tu n'as **pas** besoin d'Hermes : AgentHub fonctionne avec n'importe lequel de ces
services. Hermes apporte simplement en plus sa continuité de session, ses outils et
sa mémoire persistante.

### En trois commandes

```bash
git clone https://github.com/<ton-compte>/agenthub.git
cd agenthub
cp .env.example .env
```

Ouvre `.env` et renseigne les deux seules variables obligatoires :

```bash
AGENTHUB_PASSWORD=le-mot-de-passe-pour-entrer
AGENTHUB_SECRET=<colle ici le résultat de la commande ci-dessous>
```

Génère le secret, ne l'invente pas — il signe tes cookies de session :

```bash
openssl rand -hex 32
```

<details>
<summary>Sous Windows, sans openssl</summary>

```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
```
</details>

Puis lance :

```bash
docker compose up -d --build
```

Ouvre **http://localhost:8090**. Un assistant t'accueille pour brancher un service.

> Le conteneur refuse de démarrer si `AGENTHUB_PASSWORD` ou `AGENTHUB_SECRET`
> manquent. C'est volontaire : une valeur par défaut serait une porte ouverte.

### Sans Docker

```bash
npm install
AGENTHUB_PASSWORD=... AGENTHUB_SECRET=... DATA_DIR=./data node server.js
```

`better-sqlite3` se compile à l'installation ; il te faut Python 3 et un compilateur
C++ si aucun binaire précompilé ne correspond à ta plateforme.

### Derrière un nom de domaine (HTTPS)

Le `docker-compose.yml` publie le port 8090 **en HTTP clair**. Pour un serveur exposé
sur Internet, mets un reverse proxy devant et **retire la section `ports:`** — sinon
le mot de passe circule en clair. Le fichier contient les labels
[Traefik](https://traefik.io) prêts à décommenter ; avec Caddy ou nginx, fais pointer
le proxy sur le port 8090 du conteneur.

### À côté d'un Hermes existant

Si Hermes tourne déjà en Docker, attache AgentHub à son réseau pour qu'il le joigne
par son nom de conteneur. Trouve le nom du réseau :

```bash
docker inspect <conteneur-hermes> --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}'
```

Puis décommente les blocs `networks:` dans `docker-compose.yml` en y mettant ce nom.

---

## Premier démarrage

L'assistant s'ouvre tout seul et déroule quatre étapes :

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

Tout se règle depuis l'interface, dans **Réglages → Fournisseurs**. Les variables
d'environnement ne servent qu'à amorcer la base au tout premier démarrage ; ensuite
c'est la base de données qui fait foi.

| Variable | Rôle |
|---|---|
| `AGENTHUB_PASSWORD` | Mot de passe d'accès à l'interface. **Obligatoire.** |
| `AGENTHUB_SECRET` | Clé de signature des sessions. **Obligatoire.** |
| `HERMES_API_URL` / `HERMES_GATEWAY_API_KEY` | Amorce le fournisseur Hermes. |
| `AGENTROUTER_API_URL` / `AGENTROUTER_API_KEY` | Amorce le fournisseur AgentRouter. |
| `AGENTHUB_DEFAULT_PROVIDER` | Fournisseur des agents qui n'en précisent pas. |
| `DATA_DIR` | Emplacement de la base SQLite. Défaut : `/data`. |
| `TRAEFIK_HOST` | Domaine servi, si tu utilises les labels Traefik. |

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
| Le conteneur redémarre en boucle | `docker logs agenthub` — souvent `.env` incomplet |
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
- Session non révocable sans changer `AGENTHUB_SECRET`.
- Un seul utilisateur, un seul mot de passe. Pas de multi-comptes.

---

## Licence

À définir avant publication. Sans fichier `LICENSE`, le dépôt reste « tous droits
réservés » et personne ne peut légalement le réutiliser — ajoute une licence (MIT ou
Apache-2.0 sont les choix habituels) si tu veux que les gens s'en servent.
