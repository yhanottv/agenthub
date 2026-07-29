// Assemblage du graphe affiché par la vue en bulles.
//
// Le client ne décide de rien : il reçoit des groupes déjà constitués, chacun
// avec ses éléments, plus la liste des liens réels. C'est ici que se décide ce
// qui fait groupe — par tag pour la mémoire, par catégorie pour les skills —
// parce que ce découpage dépend des données, pas de l'affichage.

import { Notes, Agents, Channels, Tasks, db } from './db.js';
import { skillsCatalogue } from './skills.js';

export const GRAPH_LAYERS = ['notes', 'agents', 'channels', 'tasks', 'skills'];

export const LAYER_META = {
  notes: { label: 'Mémoire', color: '#8ea2ff' },
  agents: { label: 'Agents', color: '#63c8d3' },
  channels: { label: 'Pôles', color: '#63d3a0' },
  tasks: { label: 'Tâches', color: '#e0b464' },
  skills: { label: 'Skills', color: '#c98ad3' },
};

const TASK_LABEL = { done: 'terminée', failed: 'échouée', in_progress: 'en cours', pending: 'en attente' };
// Le groupe parle de plusieurs tâches, l'élément d'une seule : deux libellés.
const TASK_GROUP = { done: 'Tâches terminées', failed: 'Tâches échouées', in_progress: 'Tâches en cours', pending: 'Tâches en attente' };
const RANK_LABEL = { ceo: 'CEO', manager: 'Manager', worker: 'Worker' };

/** Identifiant de groupe stable, pour que la carte ne se réorganise pas seule. */
const groupId = (layer, key) => `${layer}:${String(key).toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`;

export function buildGraph(layers = GRAPH_LAYERS) {
  const on = (l) => layers.includes(l);
  const groups = new Map();
  const nodes = [];
  const links = [];
  const present = new Set();

  const group = (layer, key, label) => {
    const id = groupId(layer, key);
    if (!groups.has(id)) groups.set(id, { id, layer, label, color: LAYER_META[layer].color, count: 0 });
    return id;
  };
  const push = (node) => {
    nodes.push(node);
    present.add(node.id);
    groups.get(node.group).count++;
  };
  // Une arête n'a de sens que si ses deux extrémités sont affichées.
  const link = (a, b, kind) => {
    if (a !== b && present.has(a) && present.has(b)) links.push({ source: a, target: b, kind });
  };

  if (on('notes')) {
    for (const n of Notes.all()) {
      // Le premier tag fait le groupe : c'est le classement que l'utilisateur a
      // lui-même posé. Sans tag, tout retombe dans « Mémoire ».
      const key = n.tags[0] || 'memoire';
      const label = n.tags[0] ? '#' + n.tags[0] : 'Mémoire';
      push({
        id: n.id, layer: 'notes', group: group('notes', key, label),
        title: n.title, subtitle: n.tags.length ? n.tags.map((t) => '#' + t).join(' ') : 'note',
        weight: 1 + Math.min(4, (n.content || '').length / 1500),
        touched_at: n.touched_at || n.updated_at,
        meta: `${(n.content || '').length.toLocaleString('fr-FR')} caractères`,
        pinned: Boolean(n.pinned), stub: false,
      });
    }

    for (const l of db.prepare('SELECT from_id, to_id FROM note_links').all()) link(l.from_id, l.to_id, 'wikilink');

    // Une note citée mais pas encore écrite : elle a sa place, en creux.
    const stubs = db.prepare('SELECT from_id, title FROM note_stubs').all();
    const seen = new Map();
    for (const s of stubs) {
      const key = s.title.toLowerCase();
      if (!seen.has(key)) {
        const id = 'stub_' + Buffer.from(key).toString('hex').slice(0, 24);
        seen.set(key, id);
        push({
          id, layer: 'notes', group: group('notes', 'a-ecrire', 'À écrire'),
          title: s.title, subtitle: 'note absente', weight: 1, touched_at: 0,
          meta: 'clic pour la créer', pinned: false, stub: true,
        });
      }
      link(s.from_id, seen.get(key), 'wikilink');
    }
  }

  if (on('agents')) {
    for (const a of Agents.all()) {
      push({
        id: a.id, layer: 'agents', group: group('agents', 'agents', 'Agents'),
        title: a.name, subtitle: a.title || RANK_LABEL[a.rank] || 'Agent',
        weight: a.rank === 'ceo' ? 3 : a.rank === 'manager' ? 2.2 : 1.6,
        touched_at: a.created_at, meta: RANK_LABEL[a.rank] || 'Worker',
        color: a.color, emoji: a.emoji, pinned: a.rank === 'ceo', stub: false,
      });
    }
  }

  if (on('channels')) {
    for (const c of Channels.all()) {
      push({
        id: c.id, layer: 'channels', group: group('channels', 'poles', 'Pôles'),
        title: c.name, subtitle: c.topic || (c.kind === 'hermes' ? 'salon direct' : 'pôle'),
        weight: 1.8 + Math.min(2.5, (c.msg_count || 0) / 40),
        touched_at: c.last_activity || c.created_at,
        meta: `${(c.msg_count || 0).toLocaleString('fr-FR')} message${(c.msg_count || 0) > 1 ? 's' : ''}`,
        color: c.color, emoji: c.emoji, pinned: false, stub: false,
      });
    }
  }

  if (on('tasks')) {
    // Bornées aux plus récentes : l'historique complet noierait le reste.
    for (const t of Tasks.recent(120)) {
      push({
        id: t.id, layer: 'tasks', group: group('tasks', t.status, TASK_GROUP[t.status] || `Tâches (${t.status})`),
        title: t.title.slice(0, 70), subtitle: TASK_LABEL[t.status] || t.status,
        weight: 1.2, touched_at: t.updated_at,
        meta: t.result ? `${t.result.length.toLocaleString('fr-FR')} caractères de résultat` : 'sans résultat',
        status: t.status, pinned: false, stub: false, channel_id: t.channel_id,
      });
    }
    for (const t of Tasks.recent(120)) {
      if (on('channels')) link(t.id, t.channel_id, 'in');
      if (on('agents')) {
        if (t.assignee_id) link(t.assignee_id, t.id, 'assignee');
        if (t.assigner_id) link(t.assigner_id, t.id, 'assigner');
      }
    }
  }

  if (on('notes') && on('agents')) {
    for (const p of db.prepare(
      "SELECT agent_id, note_id FROM note_proposals WHERE status='accepted' AND note_id IS NOT NULL AND agent_id IS NOT NULL").all()) {
      link(p.agent_id, p.note_id, 'wrote');
    }
  }

  if (on('agents') && on('channels')) {
    for (const m of db.prepare('SELECT channel_id, agent_id FROM channel_members').all()) {
      link(m.agent_id, m.channel_id, 'member');
    }
  }

  let skills = null;
  if (on('skills')) {
    skills = skillsCatalogue();
    for (const s of skills.skills) {
      push({
        id: s.id, layer: 'skills', group: group('skills', s.category, s.category),
        title: s.title, subtitle: s.description.slice(0, 120) || s.name,
        weight: s.installed ? 2.4 : 1.4,
        // Un skill n'a pas de date d'usage : la fraîcheur ne veut rien dire ici,
        // et l'inventer donnerait une carte qui ment.
        touched_at: null,
        meta: s.installed ? `actif · v${s.version || '?'}` : `disponible · ${s.install}`,
        installed: s.installed, name: s.name, version: s.version,
        author: s.author, license: s.license, tags: s.tags,
        pinned: Boolean(s.installed), stub: false,
      });
    }
  }

  return {
    groups: [...groups.values()].sort((a, b) =>
      GRAPH_LAYERS.indexOf(a.layer) - GRAPH_LAYERS.indexOf(b.layer) || b.count - a.count || a.label.localeCompare(b.label)),
    nodes,
    links,
    layers,
    skills: skills ? { counts: skills.counts, mounted: skills.mounted, sources: skills.sources } : null,
  };
}

/** Ce que chaque calque apporterait, pour l'afficher sur son bouton. */
export function layerCounts() {
  let skills = 0;
  try { skills = skillsCatalogue().counts.total; } catch { skills = 0; }
  return {
    notes: Notes.count(),
    agents: Agents.count(),
    channels: Channels.count(),
    tasks: Math.min(120, db.prepare('SELECT COUNT(*) n FROM tasks').get().n),
    skills,
  };
}
