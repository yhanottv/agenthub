// Multi-agent orchestration: routes user messages to agents, lets a manager
// delegate down the hierarchy, tracks tasks, and streams everything live.
//
// Delegation is genuinely recursive: a CEO can hand work to a manager, who can
// in turn hand it to a worker. Delegation targets are looked up in the channel
// first and then across the whole organisation, so a pôle is not a hard wall.

import { Agents, Channels, Messages, Tasks, Notes, Usage } from './db.js';
import { streamChat } from './llm.js';

const MAX_HISTORY = 30;           // messages of context sent to each agent
const MAX_DELEGATION_DEPTH = 3;   // ceo -> manager -> worker
const MAX_TURNS_PER_MESSAGE = 12; // hard ceiling on model calls per user message
const MAX_DELEGATIONS_PER_TURN = 4;

const RANK_LEVEL = { ceo: 0, manager: 1, worker: 2 };
const rankLevel = (a) => RANK_LEVEL[a?.rank] ?? 2;
const canDelegateRank = (a) => rankLevel(a) < 2; // ceo or manager

const normalize = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
const noSpace = (s) => String(s || '').replace(/\s+/g, '');
const firstLine = (s) => String(s || '').split('\n')[0].slice(0, 120);

class Aborted extends Error {
  constructor() { super('aborted'); this.name = 'Aborted'; }
}

export class Orchestrator {
  constructor(broadcast) {
    this.broadcast = broadcast;      // (event) => void — fan out to WS clients
    this.chains = new Map();         // channelId -> promise (serialises turns)
    this.controllers = new Map();    // channelId -> AbortController
  }

  isBusy(channelId) { return this.controllers.has(channelId); }

  /** Cancel the run in flight for a channel. Returns true if something was cancelled. */
  stop(channelId) {
    const ctrl = this.controllers.get(channelId);
    if (!ctrl) return false;
    ctrl.abort();
    return true;
  }

  /**
   * Public entry: a human posted `text` in `channel`.
   * Turns are serialised per channel — two quick messages can no longer
   * interleave their delegation chains and corrupt each other's context.
   */
  handleUserMessage(channel, text) {
    const prev = this.chains.get(channel.id) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.#runTurn(channel, text));
    this.chains.set(channel.id, next);
    next.catch(() => {}).finally(() => {
      if (this.chains.get(channel.id) === next) this.chains.delete(channel.id);
    });
    return next;
  }

  async #runTurn(channel, text) {
    // Re-read the channel: it may have been edited or deleted while queued.
    const fresh = Channels.get(channel.id);
    if (!fresh) return;

    const controller = new AbortController();
    this.controllers.set(channel.id, controller);
    const ctx = { signal: controller.signal, turns: 0, touched: new Set() };

    try {
      const members = Channels.members(fresh.id);
      if (!members.length) {
        this.postSystem(fresh, "⚠️ Ce salon n'a aucun membre. Ajoute au moins un agent pour lui parler.");
        return;
      }

      const mentioned = resolveMentions(text, members);
      let targets = mentioned;
      if (!targets.length) {
        if (fresh.kind === 'hermes') {
          targets = members.slice(0, 1);
        } else {
          // Route to the most senior member so "parle au pôle" works.
          targets = [[...members].sort((a, b) => rankLevel(a) - rankLevel(b))[0]];
        }
      }

      for (const agent of targets) {
        await this.runAgent(fresh, agent, { trigger: text, depth: 0, chain: [], ctx });
      }
    } catch (err) {
      if (err instanceof Aborted) {
        this.postSystem(fresh, '⏹️ Exécution arrêtée.');
      } else {
        console.error('orchestration error:', err);
        this.postSystem(fresh, "⚠️ Une erreur interne est survenue — consultez les logs du serveur.");
      }
    } finally {
      // Never leave an agent stuck in "thinking" on the client.
      for (const agentId of ctx.touched) {
        this.broadcast({ type: 'agent.status', agentId, channelId: channel.id, status: 'idle' });
      }
      this.controllers.delete(channel.id);
    }
  }

  /** Run one agent turn: stream tokens, persist, then handle delegation. */
  async runAgent(channel, agent, { trigger, depth, chain, ctx, allowDelegate }) {
    if (ctx.signal.aborted) throw new Aborted();
    if (ctx.turns >= MAX_TURNS_PER_MESSAGE) {
      this.postSystem(channel, `⚠️ Limite de ${MAX_TURNS_PER_MESSAGE} exécutions atteinte pour ce message — arrêt pour éviter une boucle.`);
      return { text: '', error: 'turn budget exhausted' };
    }
    ctx.turns++;
    ctx.touched.add(agent.id);

    const canDelegate =
      (allowDelegate ?? true) && canDelegateRank(agent) && depth < MAX_DELEGATION_DEPTH;

    this.broadcast({ type: 'agent.status', agentId: agent.id, channelId: channel.id, status: 'thinking' });

    const messages = this.buildContext(channel, agent, canDelegate, trigger, chain);

    const msg = Messages.create({
      channel_id: channel.id,
      author_type: 'agent',
      author_id: agent.id,
      author_name: agent.name,
      author_emoji: agent.emoji,
      author_color: agent.color,
      content: '',
      status: 'streaming',
    });
    this.broadcast({ type: 'message.new', message: msg });

    // Throttled delta flush so a fast stream cannot flood the socket.
    let buf = '';
    let acc = '';
    let flushTimer = null;
    const flush = () => {
      if (!buf) return;
      const delta = buf;
      buf = '';
      this.broadcast({ type: 'message.delta', id: msg.id, channelId: channel.id, delta });
    };
    const onDelta = (d) => {
      acc += d;
      buf += d;
      if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 40);
    };

    let result;
    try {
      result = await streamChat({
        agent,                       // carries provider + model
        // Conversation-level settings win over the agent's own.
        override: channel.provider_override
          ? { provider: channel.provider_override, model: channel.model_override }
          : null,
        effort: channel.effort || '',
        sessionKey: `agenthub:${channel.id}:${agent.id}`,
        messages,
        onDelta,
        signal: ctx.signal,
      });
    } finally {
      clearTimeout(flushTimer);
      flush();
    }

    // Book the cost of the call whatever its outcome — a failed run still burned
    // prompt tokens upstream, and hiding that would make the meter lie.
    if (result.usage) {
      Usage.record({
        agent_id: agent.id,
        channel_id: channel.id,
        provider: result.provider,
        model: result.model,
        tokens_in: result.usage.tokensIn,
        tokens_out: result.usage.tokensOut,
        estimated: result.usage.estimated,
      });
    }

    const { text, error, aborted } = result;

    if (aborted) {
      const shown = (acc.trim() ? `${acc.trim()}\n\n` : '') + '> ⏹️ Arrêté.';
      Messages.setContent(msg.id, shown, 'complete');
      this.broadcast({ type: 'message.update', id: msg.id, channelId: channel.id, content: shown, status: 'complete' });
      this.broadcast({ type: 'agent.status', agentId: agent.id, channelId: channel.id, status: 'idle' });
      throw new Aborted();
    }

    if (error) {
      const shown = acc.trim() ? `${acc.trim()}\n\n> ⚠️ ${error}` : `⚠️ ${error}`;
      Messages.setContent(msg.id, shown, 'error');
      this.broadcast({ type: 'message.update', id: msg.id, channelId: channel.id, content: shown, status: 'error' });
      this.broadcast({ type: 'agent.status', agentId: agent.id, channelId: channel.id, status: 'idle' });
      return { text: acc, error };
    }

    // Separate the delegation block from the visible reply.
    const { visible, delegations } = extractDelegations(text);
    const finalVisible = visible.trim() || (delegations.length ? '_(délégation en cours…)_' : '(réponse vide)');
    Messages.setContent(msg.id, finalVisible, 'complete');
    this.broadcast({ type: 'message.update', id: msg.id, channelId: channel.id, content: finalVisible, status: 'complete' });
    this.broadcast({ type: 'agent.status', agentId: agent.id, channelId: channel.id, status: 'idle' });

    if (canDelegate && delegations.length) {
      await this.runDelegations(channel, agent, delegations.slice(0, MAX_DELEGATIONS_PER_TURN), depth, chain, ctx);
    }

    return { text: finalVisible, error: null };
  }

  async runDelegations(channel, manager, delegations, depth, chain, ctx) {
    const results = [];
    const nextChain = [...chain, manager.id];

    for (const d of delegations) {
      if (ctx.signal.aborted) throw new Aborted();

      const { employee, borrowed, reason } = this.#resolveEmployee(d.name, channel, manager, nextChain);
      if (!employee) {
        this.postSystem(channel, `⚠️ ${manager.name} a voulu déléguer à « ${d.name} » — ${reason}`);
        continue;
      }

      const task = Tasks.create({
        channel_id: channel.id,
        title: d.task,
        assigner_id: manager.id,
        assignee_id: employee.id,
        status: 'in_progress',
      });
      this.broadcast({ type: 'task.update', task });
      this.postSystem(
        channel,
        `🧭 **${manager.name}** confie une tâche à **${employee.name}**${borrowed ? ' _(renfort d\'un autre pôle)_' : ''} : ${d.task}`,
        task.id,
      );

      const trigger =
        `${manager.name} (${manager.title || manager.rank}) te confie cette tâche à exécuter maintenant :\n\n` +
        `${d.task}\n\nExécute-la et rends un résultat clair et complet.`;

      let res;
      try {
        res = await this.runAgent(channel, employee, {
          trigger,
          depth: depth + 1,
          chain: nextChain,
          ctx,
        });
      } catch (err) {
        // Mark the task before unwinding an abort, so the board stays truthful.
        const stopped = Tasks.update(task.id, { status: 'failed', result: 'Arrêté.' });
        this.broadcast({ type: 'task.update', task: stopped });
        throw err;
      }

      const done = Tasks.update(task.id, {
        status: res.error ? 'failed' : 'done',
        result: (res.text || '').slice(0, 4000),
      });
      this.broadcast({ type: 'task.update', task: done });
      results.push({ employee: employee.name, task: d.task, result: res.text, error: res.error });
    }

    // Synthesis pass: hand the results back to the manager, no further delegation.
    if (results.length) {
      const summary = results
        .map((r) => `• ${r.employee} — tâche « ${r.task} » :\n${r.error ? '[échec] ' + r.error : r.result}`)
        .join('\n\n');
      const trigger =
        `Les agents ont terminé les tâches que tu as déléguées. Voici leurs résultats :\n\n${summary}\n\n` +
        `Fais une synthèse finale claire et directement utile pour l'utilisateur. Ne délègue plus.`;
      await this.runAgent(channel, manager, {
        trigger,
        depth: depth + 1,
        chain: nextChain,
        ctx,
        allowDelegate: false,
      });
    }
  }

  /**
   * Find the agent a manager wants to delegate to.
   * Channel members win; otherwise the agent is "borrowed" from the wider org.
   * Guards against self-delegation, upward delegation and cycles.
   */
  #resolveEmployee(name, channel, manager, chain) {
    const target = normalize(name);
    const members = Channels.members(channel.id);

    let employee = members.find((m) => normalize(m.name) === target);
    let borrowed = false;
    if (!employee) {
      employee = Agents.all().find((m) => normalize(m.name) === target);
      borrowed = Boolean(employee);
    }

    if (!employee) return { employee: null, reason: "aucun agent de ce nom n'existe." };
    if (employee.id === manager.id) return { employee: null, reason: 'un agent ne peut pas se déléguer à lui-même.' };
    if (chain.includes(employee.id)) return { employee: null, reason: 'cet agent est déjà dans la chaîne de délégation (boucle évitée).' };
    if (rankLevel(employee) <= rankLevel(manager)) {
      return { employee: null, reason: `${employee.name} n'est pas sous ses ordres.` };
    }
    return { employee, borrowed };
  }

  postSystem(channel, content, taskId) {
    const m = Messages.create({
      channel_id: channel.id,
      author_type: 'system',
      author_name: 'Système',
      content,
      task_id: taskId || null,
      status: 'complete',
    });
    this.broadcast({ type: 'message.new', message: m });
    return m;
  }

  /** Assemble the OpenAI-style message array for one agent. */
  buildContext(channel, agent, canDelegate, trigger, chain) {
    const members = Channels.members(channel.id);
    const system = buildSystemPrompt(channel, agent, members, canDelegate, chain);

    // Messages.list now returns the MOST RECENT rows (oldest-first), so agents
    // actually see the current conversation rather than the channel's opening.
    const history = Messages.list(channel.id, MAX_HISTORY);

    const msgs = [{ role: 'system', content: system }];
    for (const m of history) {
      if (!m.content) continue;
      if (m.author_type === 'agent' && m.author_id === agent.id) {
        msgs.push({ role: 'assistant', content: m.content });
      } else if (m.author_type === 'system') {
        msgs.push({ role: 'user', content: `[système] ${m.content}` });
      } else if (m.author_type === 'user') {
        msgs.push({ role: 'user', content: m.content });
      } else {
        msgs.push({ role: 'user', content: `[${m.author_name}] ${m.content}` });
      }
    }

    // Append the current trigger unless it is already the last thing said.
    if (trigger) {
      const last = msgs[msgs.length - 1];
      if (!last || last.content !== trigger) msgs.push({ role: 'user', content: trigger });
    }
    return msgs;
  }
}

// ---- prompt building -------------------------------------------------------
function buildSystemPrompt(channel, agent, members, canDelegate, chain = []) {
  const RANK_LABEL = { ceo: 'CEO', manager: 'Manager', worker: 'Worker' };
  const lines = [];

  lines.push(agent.role_prompt?.trim() || `Tu es ${agent.name}, un assistant IA.`);
  lines.push('');
  lines.push(`Tu participes au salon « ${channel.name} » d'un espace de travail collaboratif. Réponds en français, de façon claire et utile.`);
  lines.push('');
  lines.push("Règle absolue : n'annonce jamais une action sans l'exécuter dans la même réponse. Si tu dois chercher, analyser ou produire quelque chose, fais-le immédiatement — ne dis jamais « je vais chercher », « je lance la recherche » ou « je vais analyser » sans livrer le résultat dans ce même message. Un message qui annonce sans produire est une faute.");

  // Second cerveau : mémoire partagée, identique pour tous les agents.
  const notes = Notes.forContext();
  if (notes.length) {
    lines.push('');
    lines.push('## Mémoire partagée de l\'organisation');
    lines.push('Ces informations font autorité. Appuie-toi dessus et ne les contredis pas.');
    lines.push('');
    lines.push(notes.join('\n\n'));
  }

  const others = members.filter((m) => m.id !== agent.id);
  if (others.length) {
    lines.push('');
    lines.push('Autres membres de ce pôle :');
    for (const m of others) {
      lines.push(`- ${m.name} (${RANK_LABEL[m.rank] || 'Worker'}${m.title ? ' · ' + m.title : ''}) : ${firstLine(m.role_prompt) || 'agent'}`);
    }
  }

  if (!canDelegate) return lines.join('\n');

  // Only strictly-lower-authority agents can receive work, and never someone
  // already in the current delegation chain.
  const isDelegable = (m) =>
    m.id !== agent.id && !chain.includes(m.id) && (RANK_LEVEL[m.rank] ?? 2) > (RANK_LEVEL[agent.rank] ?? 2);

  const here = others.filter(isDelegable);
  const memberIds = new Set(members.map((m) => m.id));
  const elsewhere = Agents.all().filter((m) => !memberIds.has(m.id) && isDelegable(m));

  lines.push('');
  lines.push(`Tu es ${agent.rank === 'ceo' ? 'le CEO' : 'un Manager'} de cette organisation. Tu peux répondre toi-même aux demandes simples, ou déléguer aux agents sous tes ordres.`);
  lines.push('Pour déléguer, termine ta réponse par UN bloc au format exact :');
  lines.push('```delegate');
  lines.push('@NomAgent | description autonome et précise de la tâche');
  lines.push('@AutreAgent | autre tâche si besoin');
  lines.push('```');

  if (here.length) lines.push(`Agents de ce pôle que tu peux solliciter : ${here.map((e) => '@' + noSpace(e.name)).join(', ')}.`);
  if (elsewhere.length) {
    lines.push(`Tu peux aussi appeler en renfort des agents d'autres pôles : ${elsewhere.map((e) => '@' + noSpace(e.name)).join(', ')}.`);
  }
  if (!here.length && !elsewhere.length) {
    lines.push("Aucun agent n'est actuellement sous tes ordres : réponds toi-même.");
  }
  lines.push("N'invente jamais de nom. Une tâche déléguée doit être compréhensible seule, sans contexte implicite.");
  lines.push('Après avoir délégué, arrête-toi : tu recevras les résultats pour faire la synthèse.');

  return lines.join('\n');
}

// ---- parsing ---------------------------------------------------------------
export function resolveMentions(text, members) {
  const found = [];
  const re = /@([\p{L}0-9_-]+)/gu;
  let m;
  while ((m = re.exec(text)) !== null) {
    const token = normalize(m[1]);
    const agent = members.find((mem) => normalize(mem.name) === token);
    if (agent && !found.includes(agent)) found.push(agent);
  }
  return found;
}

/** Pull a ```delegate ... ``` block out of the agent text. */
export function extractDelegations(text) {
  const re = /```delegate\s*([\s\S]*?)```/i;
  const match = String(text || '').match(re);
  if (!match) return { visible: String(text || ''), delegations: [] };

  const delegations = [];
  for (const raw of match[1].split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // "@name | task", "@name: task" or "@name - task"
    const mm = line.match(/^@?([\p{L}0-9_-]+)\s*(?:\||:|-)?\s*(.+)$/u);
    if (mm && mm[2] && mm[2].trim()) delegations.push({ name: mm[1], task: mm[2].trim() });
  }
  return { visible: String(text).replace(re, '').trim(), delegations };
}
