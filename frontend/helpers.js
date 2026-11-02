export const purposeChoices = [['research', 'Research'], ['career', 'Developer & career'], ['business', 'Business & assets'], ['support', 'Support & life']];
export const purposeLabel = value => purposeChoices.find(([key]) => key === value)?.[1] || 'Unclassified';

export const taskKey = e => String(e.task_id);
export const taskIdentity = e => `${e.user_id}:${e.task_id ?? e.id}`;
export function groupIntoTasks(entries, { ownerScoped = false } = {}) {
  const map = new Map();
  for (const e of entries) {
    const key = ownerScoped ? taskIdentity(e) : taskKey(e);
    if (!map.has(key)) map.set(key, { key, user_id: e.user_id, project_id: e.project_id, description: e.description, segments: [] });
    map.get(key).segments.push(e);
  }
  return [...map.values()].map(t => {
    t.segments.sort((a, b) => new Date(a.begin).getTime() - new Date(b.begin).getTime());
    const last = t.segments.at(-1);
    return { ...t, isRunning: last.end === null, firstBegin: t.segments[0].begin, lastEnd: last.end };
  }).sort((a, b) => new Date(b.firstBegin).getTime() - new Date(a.firstBegin).getTime());
}
export function resolveTask(tasks, key) {
  const matches = tasks.filter(task => task.key === key || !key.includes(':') && String(task.segments[0].task_id ?? task.segments[0].id) === key);
  return matches.length === 1 ? matches[0] : null;
}
export const segmentDurationMs = (s, now = Date.now()) => Math.max(0, (s.end ? new Date(s.end).getTime() : now) - new Date(s.begin).getTime());
export const taskDurationMs = (t, now = Date.now()) => t.segments.reduce((sum, s) => sum + segmentDurationMs(s, now), 0);
export const taskStatus = task => {
  const last = task.segments.at(-1);
  return last.end === null ? 'running' : last.end_reason === 'paused' ? 'paused' : last.end_reason === 'auto' || last.auto_closed ? 'auto' : 'completed';
};
export const liveTasks = (tasks, now = Date.now(), pausedMaxHours = 24) => tasks.filter(task => {
  const status = taskStatus(task);
  return status === 'running' || status === 'paused' && new Date(task.segments.at(-1).end).getTime() >= now - pausedMaxHours * 3600000;
});
export const taskMeta = (task, entity, project, activity) => {
  const repo = task.segments.at(-1).repo;
  return [entity, project, activity === 'Assigned Task' ? null : activity, repo === project ? null : repo].filter(Boolean);
};
export const matchesSearch = (task, query, meta = []) => !query.trim() || [task.description, ...meta].some(value => value.toLowerCase().includes(query.trim().toLowerCase()));
export function matchesRepoKind(task, repoFilter, kindFilter) {
  const last = task.segments.at(-1);
  return (repoFilter == null || (last.repo ?? '') === repoFilter)
    && (kindFilter == null || String(last.activity_id) === kindFilter);
}
export const repoOptions = tasks => [...new Set(tasks.map(task => task.segments.at(-1).repo).filter(Boolean))].sort();
export const stableColorById = (id, palette) => palette[Math.abs(Number(id)) % palette.length];
export function hoursByKindEntity(entries, activityIds, entityIds, now = Date.now()) {
  return activityIds.map(activityId => {
    const entities = entityIds.map(id => ({
      id,
      hours: entries.filter(e => e.activity_id === activityId && e.user_id === id)
        .reduce((total, entry) => total + segmentDurationMs(entry, now) / 3600000, 0),
    }));
    return { activityId, entities, hours: entities.reduce((total, entity) => total + entity.hours, 0) };
  });
}
export function sevenDayHoursByAgent(entries, agentIds, now = Date.now()) {
  const start = now - 7 * 86400000;
  return new Map(agentIds.map(id => [id, entries.filter(e => e.user_id === id).reduce((total, entry) => {
    const end = entry.end ? new Date(entry.end).getTime() : now;
    return total + Math.max(0, Math.min(end, now) - Math.max(new Date(entry.begin).getTime(), start)) / 3600000;
  }, 0)]));
}
export function formatDuration(ms) {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60), h = Math.floor(minutes / 60), m = minutes % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  const s = totalSeconds % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}
export const formatClock = iso => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const formatDay = iso => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
export const rangeStartMs = (range, now = Date.now()) => range === 'day'
  ? new Date(now).setHours(0, 0, 0, 0)
  : now - ({ week: 7, month: 30 }[range] * 86400000);
export const filterEntriesInRange = (entries, range, now = Date.now()) => entries.filter(e => new Date(e.begin).getTime() >= rangeStartMs(range, now) && new Date(e.begin).getTime() <= now);
export function clipEntriesToWindow(entries, from, to, now = Date.now()) {
  return entries.flatMap(entry => {
    const begin = Math.max(new Date(entry.begin).getTime(), from);
    const end = Math.min(entry.end ? new Date(entry.end).getTime() : now, to, now);
    return begin < end ? [{ ...entry, begin: new Date(begin).toISOString(), end: entry.end === null && end === now ? null : new Date(end).toISOString() }] : [];
  });
}

export function zeroDurationEntriesInWindow(entries, from, to) {
  return entries.filter(entry => {
    const begin = Date.parse(entry.begin), end = Date.parse(entry.end);
    return entry.end !== null && Number.isFinite(begin) && Number.isFinite(end)
      && begin === end && from <= begin && begin < to;
  });
}

const routePages = new Set(['timesheet', 'calendar', 'activity', 'agents', 'projects', 'favorites', 'reports']);
const routeAliases = { management: 'projects', recommended: 'favorites' };
export function parseRoute(hash) {
  const url = new URL(hash.replace(/^#/, '') || '/', 'https://timesheet.local');
  const path = url.pathname.replace(/^\/+|\/+$/g, '') || 'timesheet';
  const page = routeAliases[path] || path;
  const params = url.searchParams;
  const purpose = params.get('purpose');
  const range = params.get('range'), week = Number(params.get('week'));
  const date = params.get('date'), parsedDate = new Date(`${date}T00:00:00Z`);
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date || '') && !date.startsWith('0000-') && Number.isFinite(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === date;
  const route = {
    page: routePages.has(page) ? page : 'not-found',
    range: ['day', 'week', 'month'].includes(range) ? range : 'week',
    projectFilter: params.get('project') || 'all',
    entityFilter: new Set((params.get('entity') || '').split(',').filter(Boolean).map(Number).filter(Number.isFinite)),
    search: params.get('q') || '',
    calendarWeekOffset: Number.isInteger(week) && Math.abs(week) <= 5200 ? week : 0,
    dateFilter: validDate ? date : null,
    modal: params.get('task'),
  };
  if (params.has('repo')) route.repoFilter = params.get('repo');
  if (params.get('kind')) route.kindFilter = params.get('kind');
  if (purpose === 'unclassified' || purposeChoices.some(([value]) => value === purpose)) route.purposeFilter = purpose;
  return route;
}
export function formatRoute(state) {
  const page = routePages.has(state.page) ? state.page : 'timesheet';
  const params = new URLSearchParams();
  if (state.range && state.range !== 'week') params.set('range', state.range);
  if (state.projectFilter && state.projectFilter !== 'all') params.set('project', state.projectFilter);
  const entities = [...(state.entityFilter || [])];
  if (entities.length) params.set('entity', entities.join(','));
  if (state.search) params.set('q', state.search);
  if (state.calendarWeekOffset) params.set('week', state.calendarWeekOffset);
  if (state.dateFilter) params.set('date', state.dateFilter);
  if (state.modal && !['new', 'new-project', 'new-recommended'].includes(state.modal) && !state.modal.startsWith('rename-project:')) params.set('task', state.modal);
  if (state.repoFilter != null) params.set('repo', state.repoFilter);
  if (state.purposeFilter) params.set('purpose', state.purposeFilter);
  if (state.kindFilter != null && state.kindFilter !== '') params.set('kind', state.kindFilter);
  const query = params.toString();
  return `#/${page === 'timesheet' ? '' : page}${query ? `?${query}` : ''}`;
}

export const dayKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export function groupByDay(entries, userId = null, now = Date.now()) {
  const map = new Map();
  for (const e of entries) {
    if (userId != null && e.user_id !== userId) continue;
    const end = Math.min(e.end ? new Date(e.end).getTime() : now, now);
    let begin = new Date(e.begin).getTime();
    while (begin < end) {
      const day = new Date(begin), next = new Date(begin);
      next.setDate(next.getDate() + 1);
      next.setHours(0, 0, 0, 0);
      const stop = Math.min(end, next.getTime()), key = dayKey(day);
      map.set(key, (map.get(key) || 0) + stop - begin);
      begin = stop;
    }
  }
  return map;
}

// Tasks are already sorted newest-first, so insertion order gives day sections
// in descending order without a second sort.
export function groupTasksByDay(tasks) {
  const days = new Map();
  for (const t of tasks) {
    const key = dayKey(new Date(t.firstBegin));
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(t);
  }
  return [...days];
}

// The stat row shows a fixed set of entities plus one "Etc" bucket, so adding
// an agent widens the bucket instead of adding a sixth tile.
export function splitEntities(perEntity, featured) {
  return {
    featured: featured.map(username => perEntity.find(u => u.username === username)).filter(Boolean),
    rest: perEntity.filter(u => !featured.includes(u.username)),
  };
}

export function activityGridWeeks(end = new Date()) {
  const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  const start = new Date(endDay);
  start.setDate(start.getDate() - 364);
  start.setDate(start.getDate() - start.getDay());
  const weeks = [];
  let cur = new Date(start);
  while (cur <= endDay) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      week.push(cur > endDay ? null : new Date(cur));
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

export function startOfWeek(date) {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  day.setDate(day.getDate() - day.getDay());
  return day;
}

export function clipToDay(entry, day, now = Date.now()) {
  const dayStart = day.getTime();
  const nextDay = new Date(day);
  nextDay.setDate(nextDay.getDate() + 1);
  nextDay.setHours(0, 0, 0, 0);
  const dayEnd = nextDay.getTime();
  const beginMs = new Date(entry.begin).getTime();
  const endMs = entry.end ? new Date(entry.end).getTime() : now;
  const startMs = Math.max(beginMs, dayStart);
  const stopMs = Math.min(endMs, dayEnd);
  if (startMs >= stopMs) return null;
  return { entry, startMin: (startMs - dayStart) / 60000, endMin: (stopMs - dayStart) / 60000 };
}

// Calendar's axis shows local clock labels; clipping and recorded durations stay elapsed.
export function wallClockBlocks(blocks, day) {
  const clock = ms => {
    const date = new Date(ms);
    return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60 + date.getMilliseconds() / 60000;
  };
  // The exclusive endpoint belongs to the preceding instant, even at a fold or midnight.
  const clockEnd = ms => clock(ms - 1) + 1 / 60000;
  const dayStart = day.getTime(), nextDay = new Date(day);
  nextDay.setDate(nextDay.getDate() + 1);
  nextDay.setHours(0, 0, 0, 0);
  const dayEnd = nextDay.getTime(), offset = ms => new Date(ms).getTimezoneOffset();
  let transition = null;
  if (offset(dayStart) !== offset(dayEnd - 1)) {
    let lo = dayStart, hi = dayEnd - 1;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (offset(mid) === offset(dayStart)) lo = mid;
      else hi = mid;
    }
    transition = hi;
  }
  return blocks.map(block => {
    const begin = Math.round(dayStart + block.startMin * 60000), end = Math.round(dayStart + block.endMin * 60000);
    let startMin = clock(begin), endMin = clockEnd(end);
    if (transition !== null && begin < transition && transition < end) {
      startMin = Math.min(startMin, clock(transition));
      endMin = Math.max(endMin, clockEnd(transition));
    }
    return { ...block, startMin, endMin, clipStartMin: block.startMin, clipEndMin: block.endMin };
  });
}

export function packColumns(blocks) {
  const sorted = [...blocks].sort((a, b) => a.startMin - b.startMin);
  const columnEnds = [];
  for (const block of sorted) {
    let col = columnEnds.findIndex(end => end <= block.startMin);
    if (col === -1) { col = columnEnds.length; columnEnds.push(block.endMin); }
    else columnEnds[col] = block.endMin;
    block.col = col;
  }
  return { blocks: sorted, maxColumns: columnEnds.length || 1 };
}

export function packCalendarColumns(blocks, minimumMinutes) {
  const displayed = blocks.map(block => ({ ...block, actualEndMin: block.endMin, endMin: Math.max(block.endMin, Math.min(1440, block.startMin + minimumMinutes)) })).sort((a, b) => a.startMin - b.startMin);
  const clusters = [];
  for (const block of displayed) {
    const cluster = clusters.at(-1);
    if (!cluster || block.startMin >= cluster.end) clusters.push({ end: block.endMin, blocks: [block] });
    else { cluster.blocks.push(block); cluster.end = Math.max(cluster.end, block.endMin); }
  }
  return clusters.flatMap(cluster => {
    const { blocks, maxColumns } = packColumns(cluster.blocks);
    return blocks.map(({ actualEndMin, ...block }) => ({ ...block, displayEndMin: block.endMin, endMin: actualEndMin, columns: maxColumns }));
  });
}

// Live per-agent status from raw entries. Working = has an open entry (the
// server already auto-closes entries past TIMETRACKER_STALE_HOURS on list);
// idle = seen in history with nothing open. Agents never seen are left out.
export function agentActivity(entries, agentIds) {
  const agents = agentIds.map(id => {
    const own = entries.filter(e => e.user_id === id);
    if (!own.length) return null;
    const open = own.filter(e => e.end === null);
    const last = own.reduce((a, b) => (new Date(b.begin) > new Date(a.begin) ? b : a));
    return { id, working: open.length > 0, open, projectIds: [...new Set(open.map(e => e.project_id))], last };
  }).filter(Boolean);
  const perProject = new Map();
  for (const a of agents) for (const p of a.projectIds) perProject.set(p, (perProject.get(p) || 0) + 1);
  const working = agents.filter(a => a.working).length;
  return { agents, perProject: [...perProject].sort((a, b) => b[1] - a[1]), working, idle: agents.length - working };
}
