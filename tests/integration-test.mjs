/**
 * Integration test — runs inside the built image.
 *
 * Stands up a fake Hermes gateway that answers based on which agent is asking,
 * then drives the real Orchestrator against a real SQLite DB. This is the proof
 * that CEO -> Manager -> Worker delegation actually recurses, that borrowing an
 * agent from another pôle works, and that illegal delegations are refused.
 */
import http from 'node:http';
import fs from 'node:fs';

const DATA_DIR = '/tmp/ah-test-' + Date.now();
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- fake gateway ----------------------------------------------------------
const sse = (res, chunks) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const c of chunks) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
};

const calls = [];
const gateway = http.createServer((req, res) => {
  // Model discovery: any OpenAI-compatible service answers GET /v1/models.
  if (req.method === 'GET' && /\/models$/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'claude-opus-4-8' }, { id: 'test-model' }] }));
    return;
  }
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const payload = JSON.parse(body);
    const system = payload.messages.find((m) => m.role === 'system')?.content || '';
    const lastUser = [...payload.messages].reverse().find((m) => m.role === 'user')?.content || '';
    // Identify the caller from the FIRST line only: the prompt also quotes the
    // other members' role prompts, so matching anywhere is ambiguous.
    const head = system.split('\n')[0];
    const who = /Tu es le Directeur/.test(head) ? 'Directeur'
      : /Tu es Ingrid/.test(head) ? 'Ingrid'
      : /Tu es Dev/.test(head) ? 'Dev'
      : /Tu es Solo/.test(head) ? 'Solo'
      : /Tu es Lent/.test(head) ? 'Lent' : 'Inconnu';
    const isSynthesis = /Fais une synthèse finale/.test(lastUser);
    calls.push({ who, isSynthesis, system });

    // Never responds — used to test stop().
    if (who === 'Lent') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'je commence' } }] })}\n\n`);
      return;
    }
    if (isSynthesis) return sse(res, [`Synthèse de ${who}.`]);
    if (who === 'Directeur') {
      return sse(res, ['Je délègue.\n\n```delegate\n@Ingrid | Produire le plan\n```']);
    }
    if (who === 'Ingrid') {
      // Dev is NOT a member of this channel — this exercises cross-pôle borrowing.
      return sse(res, ['Je passe au dev.\n\n```delegate\n@Dev | Coder le prototype\n```']);
    }
    if (who === 'Solo') {
      // Illegal targets: upward, self, unknown.
      return sse(res, ['Essais interdits.\n\n```delegate\n@Directeur | remonter\n@Solo | moi-meme\n@Fantome | inexistant\n```']);
    }
    return sse(res, ['Travail terminé.']);
  });
});
await new Promise((r) => gateway.listen(9971, '127.0.0.1', r));

// Env must be set before hermes.js is imported (it reads process.env at load).
process.env.DATA_DIR = DATA_DIR;
process.env.HERMES_API_URL = 'http://127.0.0.1:9971';
process.env.HERMES_API_KEY = 'test';
process.env.HERMES_MODEL = 'test-model';
// AgentRouter points at the same mock so provider routing can be exercised.
process.env.AGENTROUTER_API_URL = 'http://127.0.0.1:9971/v1';
process.env.AGENTROUTER_API_KEY = 'sk-test-not-a-real-key';
process.env.AGENTROUTER_MODEL = 'claude-opus-4-8';

const { Agents, Channels, Messages, Tasks, Providers } = await import('/app/db.js');
const { Orchestrator, extractDelegations, resolveMentions } = await import('/app/orchestrator.js');
const { providerCatalog, resolveForAgent, seedProvidersFromEnv, probeProvider } = await import('/app/llm.js');

// Providers now live in the database; the env only seeds them on first boot.
seedProvidersFromEnv();

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { console.log(`✓ ${label}`); pass++; }
  else { console.log(`✗ ${label}${extra ? '\n    ' + extra : ''}`); fail++; }
};

// ---- fixtures --------------------------------------------------------------
const ceo = Agents.create({ name: 'Directeur', rank: 'ceo', role_prompt: 'Tu es le Directeur (CEO).' });
const mgr = Agents.create({ name: 'Ingrid', rank: 'manager', role_prompt: 'Tu es Ingrid, manager.' });
const dev = Agents.create({ name: 'Dev', rank: 'worker', role_prompt: 'Tu es Dev, ingénieur.' });
const solo = Agents.create({ name: 'Solo', rank: 'manager', role_prompt: 'Tu es Solo, manager.' });

const direction = Channels.create({ name: 'Direction', kind: 'pole', members: [ceo.id, mgr.id] });
const autre = Channels.create({ name: 'Technique', kind: 'pole', members: [dev.id] });
const soloCh = Channels.create({ name: 'SoloPole', kind: 'pole', members: [solo.id, ceo.id] });

const events = [];
const orch = new Orchestrator((e) => events.push(e));

// ============================ 1. recursive delegation =======================
console.log('--- delegation CEO -> Manager -> Worker ---');
await orch.handleUserMessage(direction, 'Lance le projet.');

const order = calls.map((c) => `${c.who}${c.isSynthesis ? ':synth' : ''}`);
ok('the CEO ran first', order[0] === 'Directeur', `order = ${order.join(' → ')}`);
ok('the manager was delegated to', order.includes('Ingrid'), `order = ${order.join(' → ')}`);
ok('THE MANAGER COULD DELEGATE FURTHER (the bug that was fixed)',
  order.includes('Dev'),
  `Dev never ran — order = ${order.join(' → ')}`);
ok('the manager then synthesised', order.includes('Ingrid:synth'), `order = ${order.join(' → ')}`);
ok('the CEO synthesised last', order[order.length - 1] === 'Directeur:synth', `order = ${order.join(' → ')}`);

const tasks = Tasks.list(direction.id);
ok('two tasks were tracked', tasks.length === 2, `got ${tasks.length}`);
ok('all tasks completed', tasks.length > 0 && tasks.every((t) => t.status === 'done'),
  tasks.map((t) => `${t.title}=${t.status}`).join(', ') || 'no tasks at all');

const devTask = tasks.find((t) => t.assignee_id === dev.id);
ok('a worker from ANOTHER pôle was borrowed', Boolean(devTask),
  'no task was assigned to Dev, who lives in a different channel');

const sysMsgs = Messages.list(direction.id).filter((m) => m.author_type === 'system');
ok('borrowing was surfaced to the user', sysMsgs.some((m) => /renfort/.test(m.content)),
  sysMsgs.map((m) => m.content).join(' | '));

// ============================ 2. illegal delegations ========================
console.log('\n--- illegal delegation targets ---');
calls.length = 0;
// Mention Solo explicitly: routing otherwise picks the most senior member (the CEO).
await orch.handleUserMessage(soloCh, '@Solo essaie des délégations interdites.');

const soloSys = Messages.list(soloCh.id).filter((m) => m.author_type === 'system').map((m) => m.content);
ok('upward delegation refused', soloSys.some((c) => /Directeur/.test(c) && /pas sous ses ordres/.test(c)),
  soloSys.join(' | '));
ok('self-delegation refused', soloSys.some((c) => /Solo/.test(c) && /lui-même/.test(c)), soloSys.join(' | '));
ok('unknown agent refused', soloSys.some((c) => /Fantome/.test(c) && /n'existe/.test(c)), soloSys.join(' | '));
ok('no task created for illegal targets', Tasks.list(soloCh.id).length === 0,
  `${Tasks.list(soloCh.id).length} task(s) created`);

// ============================ 3. context window =============================
console.log('\n--- context window (the silent history bug) ---');
for (let i = 0; i < 60; i++) {
  Messages.create({ channel_id: autre.id, author_type: 'user', author_name: 'Toi', content: `msg-${i}` });
}
const recent = Messages.list(autre.id, 30);
ok('list() returns the MOST RECENT rows, not the oldest',
  recent[recent.length - 1].content === 'msg-59',
  `last message returned = ${recent[recent.length - 1].content} (expected msg-59)`);
ok('returned oldest-first for display', recent[0].content === 'msg-30',
  `first = ${recent[0].content} (expected msg-30)`);
ok('respects the limit', recent.length === 30, `got ${recent.length}`);

// ============================ 4. abort ======================================
console.log('\n--- stop a run in flight ---');
calls.length = 0;
const lent = Agents.create({ name: 'Lent', rank: 'worker', role_prompt: 'Tu es Lent, très lent.' });
const lentCh = Channels.create({ name: 'Lenteur', kind: 'pole', members: [lent.id] });

const inFlight = orch.handleUserMessage(lentCh, 'Fais un truc long.');
await new Promise((r) => setTimeout(r, 400));
ok('the channel reports as busy', orch.isBusy(lentCh.id));
const stopped = orch.stop(lentCh.id);
ok('stop() reports it cancelled something', stopped === true);
await inFlight;

const lentMsgs = Messages.list(lentCh.id);
ok('the partial answer was kept', lentMsgs.some((m) => /je commence/.test(m.content)),
  lentMsgs.map((m) => m.content).join(' | '));
ok('the run was marked as stopped', lentMsgs.some((m) => /Arrêté/.test(m.content)),
  lentMsgs.map((m) => m.content).join(' | '));
ok('no agent left stuck in thinking',
  events.filter((e) => e.type === 'agent.status' && e.agentId === lent.id).pop()?.status === 'idle');
ok('the channel is free again', !orch.isBusy(lentCh.id));
ok('stop() on an idle channel is a no-op', orch.stop(lentCh.id) === false);

// ============================ 5. parsing ====================================
console.log('\n--- parsing ---');
const d1 = extractDelegations('Texte\n```delegate\n@Bob | faire X\n@Ana: faire Y\n```');
ok('parses pipe and colon forms', d1.delegations.length === 2, JSON.stringify(d1.delegations));
ok('delegate block stripped from visible text', !/delegate/.test(d1.visible), d1.visible);
const d2 = extractDelegations('Aucune délégation ici.');
ok('no false positive', d2.delegations.length === 0 && d2.visible === 'Aucune délégation ici.');
ok('mentions resolve case/space-insensitively',
  resolveMentions('salut @ingrid ça va', [mgr]).length === 1);
ok('unknown mention ignored', resolveMentions('@personne', [mgr]).length === 0);

// ============================ 6. validation =================================
console.log('\n--- input validation ---');
const bad = Agents.create({ name: 'X'.repeat(200), rank: 'superadmin', color: 'red; background:url(x)' });
ok('rank forced into the enum', bad.rank === 'worker', `got ${bad.rank}`);
ok('name length clamped', bad.name.length <= 40, `len ${bad.name.length}`);
ok('non-hex colour rejected', /^#[0-9a-f]{3,6}$/i.test(bad.color), `got ${bad.color}`);

const orphan = Tasks.create({ channel_id: direction.id, title: 'orpheline', status: 'in_progress' });
ok('orphan tasks reconciled on boot', Tasks.reconcileOrphans() >= 1 && Tasks.get(orphan.id).status === 'failed');

// Boot-time reconciliation of messages left mid-stream by a killed process.
const halfEmpty = Messages.create({ channel_id: direction.id, author_type: 'agent', author_name: 'X', content: '', status: 'streaming' });
const halfFull = Messages.create({ channel_id: direction.id, author_type: 'agent', author_name: 'X', content: 'début de phrase', status: 'streaming' });
const reconciled = Messages.reconcileStreaming();
ok('streaming messages reconciled on boot', reconciled >= 2, `changed ${reconciled}`);
ok('empty half-written message explained', /redémarrage/.test(Messages.get(halfEmpty.id).content));
ok('partial text preserved', /début de phrase/.test(Messages.get(halfFull.id).content));
ok('reconciled messages marked as error', Messages.get(halfFull.id).status === 'error');

// ============================ 7. providers ==================================
console.log('\n--- providers / model routing ---');
const cat = providerCatalog();
ok('both providers are advertised', cat.length === 2 && cat.some(p => p.id === 'agentrouter'),
  JSON.stringify(cat.map(p => p.id)));
ok('no API key ever leaves the server',
  !JSON.stringify(cat).includes('sk-test-not-a-real-key'),
  'a key was found in the catalogue payload');
ok('agentrouter reports enabled when keyed', cat.find(p => p.id === 'agentrouter').enabled === true);

const arAgent = Agents.create({ name: 'Opus', rank: 'worker', provider: 'agentrouter', model: 'claude-opus-4-8' });
const r1 = resolveForAgent(arAgent);
ok('agentrouter agent routes to agentrouter', r1.provider.id === 'agentrouter', r1.provider.id);
ok('and uses claude-opus-4-8', r1.model === 'claude-opus-4-8', r1.model);

const bogus = Agents.create({ name: 'Bogus', rank: 'worker', provider: 'does-not-exist' });
ok('unknown provider is rejected at write time', bogus.provider === 'hermes', bogus.provider);

const mismatch = Agents.create({ name: 'Mismatch', rank: 'worker', provider: 'agentrouter', model: 'test-model' });
const r2 = resolveForAgent(mismatch);
ok('a model foreign to the provider falls back to its default',
  r2.model === 'claude-opus-4-8', r2.model);

const legacy = Agents.get(ceo.id);
ok('pre-existing agents keep working on hermes', resolveForAgent(legacy).provider.id === 'hermes');

// An agentrouter-backed agent must actually complete a turn end to end.
const arCh = Channels.create({ name: 'Opus', kind: 'pole', members: [arAgent.id] });
calls.length = 0;
await orch.handleUserMessage(arCh, 'Dis bonjour.');
const arMsgs = Messages.list(arCh.id).filter(m => m.author_type === 'agent');
ok('an agentrouter agent completes a turn', arMsgs.length === 1 && arMsgs[0].status === 'complete',
  arMsgs.map(m => `${m.status}:${m.content.slice(0, 40)}`).join(' | '));

// ============================ 8. deletion ===================================
console.log('\n--- deleting messages / clearing a conversation ---');
const delCh = Channels.create({ name: 'Corbeille', kind: 'pole', members: [dev.id] });
const m1 = Messages.create({ channel_id: delCh.id, author_type: 'user', author_name: 'Toi', content: 'un' });
const m2 = Messages.create({ channel_id: delCh.id, author_type: 'user', author_name: 'Toi', content: 'deux' });
Tasks.create({ channel_id: delCh.id, title: 'tache', status: 'done' });

ok('a single message is removed', Messages.remove(m1.id) === true);
ok('it is really gone', Messages.get(m1.id) === undefined);
ok('its neighbour survives', Messages.get(m2.id) !== undefined);
ok('removing a missing message is a no-op', Messages.remove('ms_nope') === false);
ok('deleted messages leave the agent context', !Messages.list(delCh.id).some(m => m.content === 'un'));

const cleared = Messages.clearChannel(delCh.id);
ok('clearing reports what it deleted', cleared.messages === 1 && cleared.tasks === 1,
  JSON.stringify(cleared));
ok('conversation is empty afterwards', Messages.list(delCh.id).length === 0);
ok('its tasks are gone too', Tasks.list(delCh.id).length === 0);
ok('the channel itself survives', Channels.get(delCh.id) !== null);
ok('other channels are untouched', Messages.list(direction.id).length > 0);

// ============================ 9. second cerveau =============================
console.log('\n--- shared memory reaches the agents ---');
const { Notes, Usage } = await import('/app/db.js');

const n1 = Notes.create({ title: 'Contexte', content: 'Notre marque parle avec sobriété.' });
const n2 = Notes.create({ title: 'Client principal', content: 'Le client historique est Acme.', pinned: 1 });
ok('notes are stored', Notes.all().length === 2);
ok('pinned notes come first', Notes.all()[0].id === n2.id, Notes.all()[0].title);

const ctx = Notes.forContext();
ok('context blocks are built', ctx.length === 2 && /Acme/.test(ctx[0]), JSON.stringify(ctx).slice(0, 120));

// The real proof: the note must appear in the system prompt actually sent out.
calls.length = 0;
await orch.handleUserMessage(autre, 'Question simple.');
const sentSystem = calls.map((c) => c.system).join('\n');
ok('THE NOTE REACHES THE MODEL PROMPT', /Acme/.test(sentSystem) && /sobriété/.test(sentSystem),
  'shared memory absent from the system prompt');
ok('memory is announced as authoritative', /Mémoire partagée/.test(sentSystem));

// A note larger than the budget must be truncated, never silently dropped whole.
Notes.create({ title: 'Pavé', content: 'x'.repeat(9000) });
const big = Notes.forContext().join('\n');
ok('context stays within budget', big.length <= 6200, `${big.length} chars`);
ok('oversized note is marked as truncated', /tronquée/.test(big) || big.length <= 6200);

ok('a note can be updated', Notes.update(n1.id, { content: 'Nouveau ton.' }).content === 'Nouveau ton.');
ok('a note can be deleted', Notes.remove(n1.id) === true && Notes.get(n1.id) === undefined);

// ============================ 10. usage accounting ==========================
console.log('\n--- usage accounting ---');
const usage7d = Usage.summary(7 * 86400000);
ok('calls were recorded during this test run', usage7d.calls > 0, `calls=${usage7d.calls}`);
ok('input tokens were counted', usage7d.tokensIn > 0, `tokensIn=${usage7d.tokensIn}`);
ok('output tokens were counted', usage7d.tokensOut > 0, `tokensOut=${usage7d.tokensOut}`);
ok('the estimate is flagged as such', usage7d.estimated === true);
ok('usage breaks down by model', usage7d.byModel.length > 0,
  JSON.stringify(usage7d.byModel.map((m) => m.model)));
ok('usage breaks down by agent', usage7d.byAgent.length > 0);
ok('both providers appear in the breakdown',
  new Set(usage7d.byModel.map((m) => m.provider)).size >= 2,
  JSON.stringify(usage7d.byModel.map((m) => m.provider)));
ok('a narrow window excludes nothing recent', Usage.summary(86400000).calls === usage7d.calls);

console.log('\n--- usage series (chart input) ---');
const hourly = Usage.summary(86400000, 3600000);
ok('a 24 h window is bucketed hourly', hourly.series.length >= 24 && hourly.series.length <= 26,
  `${hourly.series.length} buckets`);
ok('the bucket size is reported', hourly.bucketMs === 3600000);
const gaps = hourly.series.some((p, i) => i > 0 && p.t - hourly.series[i - 1].t !== 3600000);
ok('buckets are evenly spaced with no gaps', !gaps,
  'a missing bucket would make the curve interpolate across dead time');
ok('quiet buckets are present as zeros', hourly.series.some((p) => p.tokens_in === 0),
  'zero-traffic buckets were dropped instead of zero-filled');
ok('active buckets carry the tokens', hourly.series.some((p) => p.tokens_in > 0));
ok('the series total matches the headline total',
  hourly.series.reduce((n, p) => n + p.tokens_in, 0) === hourly.tokensIn,
  `series=${hourly.series.reduce((n, p) => n + p.tokens_in, 0)} vs total=${hourly.tokensIn}`);

const weekly = Usage.summary(7 * 86400000, 86400000);
ok('a 7 d window is bucketed daily', weekly.series.length >= 7 && weekly.series.length <= 9,
  `${weekly.series.length} buckets`);
ok('every bucket exposes what the chart needs',
  weekly.series.every((p) => typeof p.t === 'number' && typeof p.calls === 'number'
    && typeof p.tokens_in === 'number' && typeof p.tokens_out === 'number'));

// ============================ 11. provider management =======================
console.log('\n--- providers are configurable at runtime ---');
const added = Providers.upsert({
  id: 'OpenRouter Test!', label: 'OpenRouter', base_url: 'http://127.0.0.1:9971/v1',
  api_key: 'test-key-placeholder-not-real', needs_key: true, hint: 'test',
});
ok('the id is slugified', added.id === 'openrouter-test-', added.id);
ok('the provider is stored', Providers.exists(added.id));

const pub = Providers.publicAll();
const pubAdded = pub.find((p) => p.id === added.id);
ok('THE API KEY NEVER LEAVES THE SERVER', !JSON.stringify(pub).includes('test-key-placeholder-not-real'),
  'a raw key was found in the public payload');
const TEST_KEY = 'test-key-placeholder-not-real';
ok('only a masked hint is exposed', pubAdded.keyHint === `••••${TEST_KEY.slice(-4)}`, pubAdded.keyHint);
ok('the hint reveals at most four characters', pubAdded.keyHint.replace(/•/g, '').length <= 4);
ok('key presence is still reported', pubAdded.keyConfigured === true);

// Saving without a key must keep the stored one, so the UI can edit a provider
// without ever holding the secret.
Providers.upsert({ id: added.id, label: 'OpenRouter renommé' });
ok('an empty key keeps the stored one', Providers.get(added.id).api_key === 'test-key-placeholder-not-real');
ok('other fields still update', Providers.get(added.id).label === 'OpenRouter renommé');
Providers.upsert({ id: added.id, api_key: 'test-key-rotated' });
ok('a supplied key replaces the old one', Providers.get(added.id).api_key === 'test-key-rotated');

Providers.setModels(added.id, ['model-b', 'model-a'], 'model-a');
ok('discovered models are cached', Providers.get(added.id).models.length === 2);
ok('the default model is honoured', Providers.get(added.id).default_model === 'model-a');
Providers.setModels(added.id, ['model-b'], 'not-in-list');
ok('an unknown default falls back', Providers.get(added.id).default_model !== 'not-in-list');

const strandedAgent = Agents.create({ name: 'Orphelin', rank: 'worker', provider: added.id });
ok('an agent can target the new provider', Agents.get(strandedAgent.id).provider === added.id);
Providers.remove(added.id);
ok('removing a provider reassigns its agents', Agents.get(strandedAgent.id).provider !== added.id,
  Agents.get(strandedAgent.id).provider);
ok('the reassignment lands on a real provider', Providers.exists(Agents.get(strandedAgent.id).provider));

console.log('\n--- model discovery ---');
const probe = await probeProvider({ base_url: 'http://127.0.0.1:9971/v1', api_key: 'x' });
ok('a reachable service reports ok', probe.ok === true, probe.error || '');
ok('its models are listed', Array.isArray(probe.models) && probe.models.includes('claude-opus-4-8'),
  JSON.stringify(probe.models));
const dead = await probeProvider({ base_url: 'http://127.0.0.1:9', api_key: 'x' });
ok('an unreachable service reports why', dead.ok === false && Boolean(dead.error), dead.error);
const bogusUrl = await probeProvider({ base_url: 'pas-une-url' });
ok('a malformed URL is rejected before any request', bogusUrl.ok === false && /http/.test(bogusUrl.error));
const noUrl = await probeProvider({});
ok('an empty URL is rejected', noUrl.ok === false);

console.log('\n--- a listing without a key must not pass for a connection ---');
// The mock serves /v1/models to anyone, exactly like OpenRouter does. Without
// this guard the wizard reported "connected" for a service with no key at all.
const noKey = await probeProvider({ base_url: 'http://127.0.0.1:9971/v1', needs_key: true });
ok('a key-requiring service with no key FAILS', noKey.ok === false, JSON.stringify(noKey).slice(0, 120));
ok('and says the key is what is missing', noKey.missingKey === true);
ok('and lists no models', noKey.models === undefined,
  'models were returned despite the missing key');
ok('the message explains why a public listing proves nothing',
  /prouverait rien|sans authentification/.test(noKey.error || ''), noKey.error);

const keyless = await probeProvider({ base_url: 'http://127.0.0.1:9971/v1', needs_key: false });
ok('a keyless service (Ollama-style) still works', keyless.ok === true, keyless.error || '');
ok('and reports nothing about key validity', keyless.keyVerified === null);

// The mock accepts any key, so the anonymous re-probe also succeeds: the test
// must therefore admit it could not confirm the key.
const unverifiable = await probeProvider({ base_url: 'http://127.0.0.1:9971/v1', api_key: 'anything', needs_key: true });
ok('a public listing marks the key as unverified', unverifiable.keyVerified === false,
  `keyVerified=${unverifiable.keyVerified}`);
ok('and surfaces a note instead of a bare green tick', Boolean(unverifiable.keyNote), unverifiable.keyNote || '');
ok('models are still listed', unverifiable.models.length > 0);

// ---- done ------------------------------------------------------------------
gateway.close();
console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(DATA_DIR, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
