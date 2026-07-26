# AgentHub

Une interface web pour faire travailler **plusieurs agents IA ensemble**, plutôt qu'un
chat de plus avec un seul modèle.

Tu recrutes des agents, tu leur donnes un rang — CEO, manager, worker — et tu les
regroupes en **pôles**. Quand tu écris dans un pôle, le membre le plus haut placé
répond, et il peut **déléguer** le travail vers le bas, y compris à des agents d'un
autre pôle. Chaque tâche déléguée est suivie, chaque réponse arrive en streaming.

Aucune étape de build : Node, du JavaScript vanilla, et SQLite.

![Node](https://img.shields.io/badge/node-%E2%89%A520-3e5faf)
![License](https://img.shields.io/badge/license-%C3%A0%20d%C3%A9finir-lightgrey)

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
agent a son service et son modèle. Les clés sont stockées côté serveur et ne sont
jamais renvoyées au navigateur.

**Une consommation qui ne ment pas.** Une ligne par appel modèle, tokens entrants et
sortants, répartition par modèle et par agent, courbe d'évolution. Quand le
fournisseur renvoie un décompte réel il est utilisé ; sinon c'est une estimation,
explicitement étiquetée comme telle.

**Temps réel.** WebSocket avec reconnexion et resynchronisation, streaming
token-par-token, statut des agents, arrêt d'un run en cours.

**Soigné.** Thème clair et sombre, contraste WCAG AA vérifié sur les deux, navigation
au clavier, mobile, `prefers-reduced-motion`.

---

## Démarrer

Il te faut Docker et un service de modèles compatible OpenAI.

```bash
git clone https://github.com/<toi>/agenthub.git
cd agenthub
cp .env.example .env
```

Ouvre `.env` et renseigne au minimum le mot de passe et le secret de session :

```bash
# un secret solide, pas un mot choisi à la main
openssl rand -hex 32
```

Puis :

```bash
docker compose up -d --build
```

Rends-toi sur **http://localhost:8090**. Au premier accès, un assistant vérifie ton
installation et te fait connecter un service en quatre étapes.

### Sans Docker

```bash
npm install
AGENTHUB_PASSWORD=... AGENTHUB_SECRET=... DATA_DIR=./data node server.js
```

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

### Un mot sur le test de connexion

Certains services — OpenRouter par exemple — publient leur catalogue de modèles
**sans authentification**. Obtenir une liste de modèles ne prouve donc pas que ta clé
est valide. AgentHub refuse de tester un service qui exige une clé quand aucune n'est
fournie, et quand le catalogue s'avère public il le dit franchement plutôt que
d'afficher une coche verte trompeuse.

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
comptabilité des tokens.

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
