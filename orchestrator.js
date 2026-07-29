// Multi-agent orchestration: routes user messages to agents, lets a manager
// delegate down the hierarchy, tracks tasks, and streams everything live.
//
// Delegation is genuinely recursive: a CEO can hand work to a manager, who can
// in turn hand it to a worker. Delegation targets are looked up in the channel
// first and then across the whole organisation, so a pôle is not a hard wall.

import { Agents, Channels, Messages, Tasks, Notes, Usage, Attachments, Settings, notesBudget } from './db.js';
import { streamChat } from './llm.js';
import { activeToolDefs, runTool, describeCall } from './tools.js';

const MAX_HISTORY = 30;           // messages of context sent to each agent
const MAX_DELEGATION_DEPTH = 3;   // ceo -> manager -> worker
const MAX_TURNS_PER_MESSAGE = 12; // hard ceiling on model calls per user message
const MAX_DELEGATIONS_PER_TURN = 4;
const MAX_TOOL_ROUNDS = 4;        // tool → answer → tool → … before we stop

/**
 * Plafond approximatif du prompt, en caractères.
 *
 * Il n'y en avait aucun : trente messages d'historique plus jusqu'à 4 000
 * caractères par tâche déléguée, sans rien pour borner le total. Sur une
 * conversation chargée ça déborde la fenêtre du modèle, et le fournisseur
 * répond par un 400 qui n'explique rien. Quatre caractères par token, la même
 * approximation que le compteur de consommation.
 *
 * Réglable, et jamais inférieur à la mémoire partagée : un budget de notes
 * supérieur au budget de contexte ferait tronquer l'historique à néant avant
 * même la première réplique.
 */
const CONTEXT_BUDGET_DEFAULT = 240000;
const CONTEXT_BUDGET_MAX = 800000;

function maxContextChars() {
  const raw = Number(Settings.get('context_budget', '')) || Number(process.env.MAX_CONTEXT_CHARS) || 0;
  const wanted = raw > 0 ? raw : CONTEXT_BUDGET_DEFAULT;
  const floor = notesBudget() + 20000;   // la mémoire, plus de quoi converser
  return Math.min(CONTEXT_BUDGET_MAX, Math.max(floor, Math.round(wanted)));
}

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
    const startedAt = Date.now();

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
      // The end of a run is the only moment worth a notification: individual
      // messages arrive constantly while a delegation chain unfolds.
      this.broadcast({
        type: 'run.done',
        channelId: channel.id,
        channelName: fresh.name,
        turns: ctx.turns,
        ms: Date.now() - startedAt,
      });
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

    // Reasoning is streamed on its own channel: it belongs beside the answer,
    // never mixed into it.
    let reasoning = '';
    let rbuf = '';
    let rTimer = null;
    const rflush = () => {
      if (!rbuf) return;
      const delta = rbuf;
      rbuf = '';
      this.broadcast({ type: 'message.reasoning', id: msg.id, channelId: channel.id, delta });
    };
    const onReasoning = (d) => {
      reasoning += d;
      rbuf += d;
      if (!rTimer) rTimer = setTimeout(() => { rTimer = null; rflush(); }, 120);
    };

    const onRetry = ({ attempt, of, error }) => {
      this.broadcast({
        type: 'message.notice', id: msg.id, channelId: channel.id,
        notice: `Le service n'a pas répondu (${error}) — nouvelle tentative ${attempt}/${of}…`,
      });
    };

    const override = channel.provider_override
      ? { provider: channel.provider_override, model: channel.model_override }
      : null;
    const common = {
      agent,                       // carries provider + model
      override,                    // conversation-level settings win over the agent's own
      effort: channel.effort || '',
      sessionKey: `agenthub:${channel.id}:${agent.id}`,
      onDelta, onReasoning, onRetry,
      signal: ctx.signal,
    };

    const toolsOn = Settings.get('tools_enabled', '1') === '1';
    const convo = [...messages];
    const toolTrace = [];
    let result;
    let useTools = toolsOn;
    let rounds = 0;

    try {
      for (;;) {
        result = await streamChat({ ...common, messages: convo, tools: useTools ? activeToolDefs() : null });

        // Book the cost of every round whatever its outcome — a failed call
        // still burned prompt tokens upstream, and hiding that would make the
        // meter lie.
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
          this.checkBudget();
        }

        // Not every provider accepts a `tools` array. Rather than fail the turn,
        // drop the tools and ask again — the agent answers from what it knows.
        if (useTools && result.error && !acc && /tool|function/i.test(result.error)) {
          console.warn(`${result.provider} refuse les outils — nouvel essai sans.`);
          useTools = false;
          continue;
        }

        if (result.aborted || result.error || !result.toolCalls?.length) break;

        if (++rounds > MAX_TOOL_ROUNDS) {
          convo.push({
            role: 'user',
            content: `[système] Limite de ${MAX_TOOL_ROUNDS} séries d'outils atteinte. Réponds maintenant avec ce que tu as.`,
          });
          useTools = false;
          continue;
        }

        // Echo the model's own tool_calls back before the results, exactly as
        // the API expects, then one `tool` message per call.
        convo.push({
          role: 'assistant',
          content: result.text || null,
          tool_calls: result.toolCalls.map((t, i) => ({
            id: t.id || `call_${rounds}_${i}`,
            type: 'function',
            function: { name: t.name, arguments: t.args || '{}' },
          })),
        });

        for (const [i, call] of result.toolCalls.entries()) {
          if (ctx.signal.aborted) throw new Aborted();
          let args = {};
          try { args = JSON.parse(call.args || '{}'); } catch { /* reported by runTool */ }
          const label = describeCall(call.name, args);

          this.broadcast({
            type: 'tool.call', id: msg.id, channelId: channel.id,
            agentId: agent.id, name: call.name, label,
          });
          this.broadcast({ type: 'agent.status', agentId: agent.id, channelId: channel.id, status: 'working' });

          const r = await runTool(call.name, call.args, {
            agent,
            channel,
            // Une image produite pendant ce tour appartient à ce message-là :
            // sans cet identifiant elle flotterait sans attache et le nettoyage
            // des dépôts abandonnés l'emporterait au bout de six heures.
            messageId: msg.id,
            signal: ctx.signal,
            onFile: (a) => this.broadcast({
              type: 'message.attachment',
              id: msg.id,
              channelId: channel.id,
              attachment: { id: a.id, name: a.name, mime: a.mime, bytes: a.bytes },
            }),
            onProposal: (r) => {
              if (r.auto && r.note) {
                // Entrée directe en mémoire : le graphe et la liste des notes
                // ont changé, il faut le dire à tout le monde.
                this.broadcast({ type: 'note.change', note: r.note });
                this.broadcast({ type: 'graph.dirty' });
                this.broadcast({
                  type: 'memory.learned',
                  title: r.note.title,
                  agent: r.proposal.agent_name || agent.name,
                });
              } else {
                this.broadcast({ type: 'proposal.new', proposal: r.proposal });
              }
            },
          });
          toolTrace.push({ name: call.name, label, ok: r.ok });

          convo.push({
            role: 'tool',
            tool_call_id: call.id || `call_${rounds}_${i}`,
            name: call.name,
            content: String(r.text || '').slice(0, 20000),
          });
        }

        this.broadcast({ type: 'agent.status', agentId: agent.id, channelId: channel.id, status: 'thinking' });
      }
    } finally {
      clearTimeout(flushTimer);
      clearTimeout(rTimer);
      flush();
      rflush();
    }

    if (reasoning.trim()) Messages.setReasoning(msg.id, reasoning);
    if (toolTrace.length) {
      Messages.setTools(msg.id, toolTrace);
      this.broadcast({ type: 'message.tools', id: msg.id, channelId: channel.id, tools: toolTrace });
    }

    const { error, aborted } = result;
    // With tools, the answer was streamed across several rounds: the running
    // accumulator is the whole reply, `result.text` only the last leg.
    const text = acc || result.text;

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

  /**
   * Prévient une fois par jour quand la dépense passe le seuil.
   *
   * Prévenir, pas bloquer : couper les agents en plein travail parce qu'un
   * chiffre est dépassé ferait plus de dégâts que le dépassement lui-même.
   */
  checkBudget() {
    const limit = Number(Settings.get('daily_budget', '')) || 0;
    if (limit <= 0) return;
    const spent = Usage.todayCost();
    if (spent < limit) return;
    const today = new Date().toISOString().slice(0, 10);
    if (Settings.get('budget_alerted_on') === today) return;
    Settings.set('budget_alerted_on', today);
    this.broadcast({
      type: 'budget.alert',
      spent, limit,
      message: `Dépense du jour : ${spent.toFixed(2)} € — le seuil de ${limit.toFixed(2)} € est atteint.`,
    });
    console.warn(`Seuil de dépense atteint : ${spent.toFixed(2)} € / ${limit.toFixed(2)} €.`);
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

    const turns = [];
    for (const m of history) {
      if (!m.content) continue;
      if (m.author_type === 'agent' && m.author_id === agent.id) {
        turns.push({ role: 'assistant', content: m.content });
      } else if (m.author_type === 'system') {
        turns.push({ role: 'user', content: `[système] ${m.content}` });
      } else if (m.author_type === 'user') {
        turns.push({ role: 'user', content: m.content });
      } else {
        turns.push({ role: 'user', content: `[${m.author_name}] ${m.content}` });
      }
    }

    // Files dropped in the channel, listed by name so the agent knows what it
    // can ask to read. The bytes stay out of the prompt on purpose.
    const files = Attachments.list(channel.id).slice(0, 20);
    const preamble = [{ role: 'system', content: system }];
    if (files.length) {
      preamble.push({
        role: 'system',
        content: 'Fichiers disponibles dans ce salon (utilise `lire_piece_jointe` pour en lire un) :\n'
          + files.map((f) => `- ${f.name} (${Math.round(f.bytes / 1024)} Ko)`).join('\n'),
      });
    }

    // Trim from the oldest turn until the whole prompt fits. The system block
    // and the trigger are never dropped: without them the agent no longer knows
    // who it is nor what was asked.
    const triggerMsg = trigger ? { role: 'user', content: trigger } : null;
    const fixed = preamble.reduce((n, m) => n + m.content.length, 0)
      + (triggerMsg ? triggerMsg.content.length : 0);
    let budget = maxContextChars() - fixed;
    const kept = [];
    for (let i = turns.length - 1; i >= 0; i--) {
      const cost = turns[i].content.length + 16;   // rough per-message overhead
      if (cost > budget) break;
      budget -= cost;
      kept.unshift(turns[i]);
    }
    if (kept.length < turns.length) {
      preamble.push({
        role: 'system',
        content: `[Contexte tronqué : les ${turns.length - kept.length} messages les plus anciens de ce salon ont été retirés pour tenir dans la fenêtre du modèle.]`,
      });
    }

    const msgs = [...preamble, ...kept];
    // Append the current trigger unless it is already the last thing said.
    if (triggerMsg) {
      const last = msgs[msgs.length - 1];
      if (!last || last.content !== trigger) msgs.push(triggerMsg);
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

  if (Settings.get('tools_enabled', '1') === '1') {
    lines.push('');
    lines.push('Tu disposes d\'outils réels — sers-t\'en plutôt que de deviner :');
    lines.push('- `recherche_web` puis `lire_url` dès qu\'une information est récente, chiffrée, ou que tu n\'en es pas sûr. Cite tes sources.');
    lines.push('- `chercher_memoire` avant de dire que tu ignores quelque chose : c\'est peut-être déjà écrit.');
    lines.push('- `calculer` pour tout calcul, même simple.');
    lines.push('- `proposer_note` quand tu apprends un fait durable sur l\'organisation. Jamais pour un détail de la conversation.');
    if (activeToolDefs().some((t) => t.function.name === 'generer_image')) {
      lines.push("- `generer_image` dès qu'on te demande un visuel. L'image apparaît seule dans la conversation : ne la décris pas après coup, commente-la.");
    }
    lines.push('Ne prétends jamais avoir utilisé un outil que tu n\'as pas appelé.');
  }

  // Second cerveau : mémoire partagée, identique pour tous les agents.
  const notes = Notes.forContext();
  if (notes.length) {
    lines.push('');
    lines.push('## Mémoire partagée de l\'organisation');
    lines.push('Ces informations font autorité. Appuie-toi dessus et ne les contredis pas.');
    lines.push('Les `[[doubles crochets]]` sont des renvois vers d\'autres notes de cette mémoire.');
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

/**
 * Pull every ```delegate ... ``` block out of the agent text.
 *
 * The regex used to be non-global, so only the first block was read: a model
 * that emitted two — which happens when it delegates, comments, then delegates
 * again — had its second batch silently dropped *and* left visible as raw
 * markup in the channel.
 */
export function extractDelegations(text) {
  const re = /```delegate\s*([\s\S]*?)```/gi;
  const src = String(text || '');
  const delegations = [];
  let found = false;
  let match;

  while ((match = re.exec(src)) !== null) {
    found = true;
    for (const raw of match[1].split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      // "@name | task", "@name: task" or "@name - task"
      const mm = line.match(/^@?([\p{L}0-9_-]+)\s*(?:\||:|-)?\s*(.+)$/u);
      if (mm && mm[2] && mm[2].trim()) delegations.push({ name: mm[1], task: mm[2].trim() });
    }
  }
  if (!found) return { visible: src, delegations: [] };
  // Every block goes, including one that parsed to nothing — leaving raw
  // markup in the channel would be worse than dropping it.
  return { visible: src.replace(/```delegate\s*[\s\S]*?```/gi, '').trim(), delegations };
}
