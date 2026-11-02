import { activityGridWeeks, clipToDay, dayKey, filterEntriesInRange, formatClock, formatDay, formatDuration, groupByDay, groupIntoTasks, groupTasksByDay, packColumns, segmentDurationMs, agentActivity, splitEntities, startOfWeek, taskKey, taskDurationMs, formatRoute, parseRoute, stableColorById, hoursByKindEntity, sevenDayHoursByAgent, taskStatus, liveTasks, taskMeta, matchesSearch, matchesRepoKind, repoOptions, purposeChoices, purposeLabel, taskIdentity, resolveTask, rangeStartMs, clipEntriesToWindow, packCalendarColumns, wallClockBlocks, zeroDurationEntriesInWindow } from './helpers.js';
import { renderReports } from './reports.js';

/** @typedef {{id: number, name: string, description?: string | null, archived?: boolean}} DashboardProject */
/** @typedef {{id: number, username: string, role?: string, active?: boolean, label: string, short: string, color: string}} DashboardUser */
/** @typedef {{id: number, name: string}} DashboardActivity */
/** @typedef {{id: number, project_id: number, description: string, created_at: string}} FavoriteTask */
/**
 * Serialized segment fields consumed by the dashboard; nullable counters remain unknown.
 * @typedef {object} TimesheetSegment
 * @property {number} id
 * @property {number | null} task_id
 * @property {number} user_id
 * @property {number} project_id
 * @property {number} activity_id
 * @property {string | null} repo
 * @property {string | null} purpose
 * @property {string} description
 * @property {string} begin
 * @property {string | null} end
 * @property {string | null} end_reason
 * @property {boolean} auto_closed
 * @property {number | null} tokens_input
 * @property {number | null} tokens_output
 * @property {number | null} tokens_reasoning
 * @property {number | null} tokens_cache_read
 * @property {number | null} tokens_cache_write
 * @property {{user_id: number, input: number | null, output: number | null, reasoning: number | null, cache_read: number | null, cache_write: number | null, counter_format?: string}[]} tokens_by_agent
 */
/**
 * @typedef {ReturnType<typeof parseRoute> & {
 * repoFilter: string | null, kindFilter: string | null, purposeFilter: string | null,
 * calendarEntities: Set<number> | null, expandedDays: Set<string>, chartMetric: string,
 * error: string, lastUpdated: number | null, stale: boolean, statsOpen?: boolean,
 * pending: Set<string>, activityScroll: Map<string, {left: number, recent: boolean}>,
 * activityFocus: Map<string, string>, projects: DashboardProject[], users: DashboardUser[],
 * activities: DashboardActivity[], entries: TimesheetSegment[], recommendedTasks: FavoriteTask[]
 * }} DashboardState
 */
/** Generated focus targets are HTML controls; only text inputs expose selection methods.
 * @typedef {HTMLElement & Partial<Pick<HTMLInputElement, 'selectionStart' | 'selectionEnd' | 'setSelectionRange'>>} FocusTarget
 */
/** The favorite action row contains the two named select controls beside its Start button.
 * @typedef {HTMLButtonElement & {parentElement: HTMLElement & {querySelector(selectors: '[data-recommended-activity]'): HTMLSelectElement; querySelector(selectors: '[data-recommended-purpose]'): HTMLSelectElement}}} FavoriteStartButton
 */

const $app = document.querySelector('#app');
const colors = ['var(--ent-1)', 'var(--ent-2)', 'var(--ent-3)', 'var(--ent-4)', 'var(--ent-5)'];
const initialRoute = parseRoute(location.hash);
/** @type {DashboardState} */
const state = {
  repoFilter: null, kindFilter: null, purposeFilter: null,
  ...initialRoute,
  calendarEntities: initialRoute.entityFilter.size ? new Set(initialRoute.entityFilter) : null, expandedDays: new Set(),
  chartMetric: 'hours', error: '', lastUpdated: null, stale: false,
  pending: new Set(), activityScroll: new Map(), activityFocus: new Map(),
  projects: [], users: [], activities: [], entries: [], recommendedTasks: [],
};

const initialTheme = localStorage.getItem('ttd-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.dataset.theme = initialTheme;
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.modal) closeModal();
});
window.addEventListener('hashchange', () => {
  if (state.pending.has('modal-form')) {
    history.pushState(null, '', formatRoute(state));
    return;
  }
  const closing = state.modal && !parseRoute(location.hash).modal;
  Object.assign(state, { repoFilter: null, kindFilter: null, purposeFilter: null }, parseRoute(location.hash));
  state.calendarEntities = state.entityFilter.size ? new Set(state.entityFilter) : null;
  render();
  if (closing) restoreModalFocus();
  if (state.page === 'activity' && history.state?.activityOpener) {
    const opener = [.../** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-activity-cell]'))].find(cell => cell.dataset.focusId === history.state.activityOpener);
    opener?.focus({ preventScroll: true });
  }
});
let lastFocusedModal = null;
let renderedModal = null;
let skipDraft = false;
let modalOpener = null;
function updateRoute(next, push = false) {
  const closing = state.modal && 'modal' in next && !next.modal;
  Object.assign(state, next);
  history[push ? 'pushState' : 'replaceState'](null, '', formatRoute(state));
  render();
  if (closing) restoreModalFocus();
}
function openModal(modal, opener) {
  modalOpener = opener?.dataset.focusId || null;
  updateRoute({ modal }, true);
}
function restoreModalFocus() {
  const opener = [.../** @type {NodeListOf<FocusTarget>} */ (document.querySelectorAll('[data-focus-id]'))].find(el => el.dataset.focusId === modalOpener);
  modalOpener = null;
  opener?.focus();
}
function closeModal() { if (!state.pending.has('modal-form')) updateRoute({ modal: null }); }

const api = async (path, options) => {
  const res = await fetch(path, { ...options, credentials: 'same-origin', headers: { 'content-type': 'application/json', ...options?.headers } });
  if (!res.ok || res.type === 'opaqueredirect' || res.redirected) {
    const text = await res.text();
    let message;
    try { message = JSON.parse(text).detail; } catch { message = text; }
    throw new Error(res.status === 401 || res.type === 'opaqueredirect' || res.redirected ? 'Access session expired, reload' : message || `Request failed (${res.status})`);
  }
  return res.status === 204 ? undefined : res.json();
};
const user = id => state.users.find(x => x.id === id) || { id, username: String(id), label: String(id), short: String(id), color: '#888' };
const project = id => state.projects.find(x => x.id === id) || { id, name: String(id) };
const activeProjects = () => state.projects.filter(p => !p.archived);
const activityOptions = selected => state.activities.map(a => `<option value="${a.id}"${a.id === selected || selected == null && a.name === 'Assigned Task' ? ' selected' : ''}>${escapeHtml(a.name)}</option>`).join('');
const purposeOptions = selected => `<option value="">Unclassified</option>${purposeChoices.map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}`;
const stableId = task => task.key;
const status = task => task.currentStatus ?? taskStatus(task);
const isAdminTask = task => user(task.user_id).username === 'admin';
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const ENTITY_LABELS = { 'admin': 'You', 'agent-claude-code': 'Claude', 'agent-codex': 'Codex', 'agent-hermes': 'Hermes' };
const entityLabel = username => ENTITY_LABELS[username] ?? username;
// The stat row is five tiles wide, always. These three get a tile of their own;
// every other entity (Hermes today, whatever agent comes next) folds into "Etc",
// so adding an agent never reflows the row.
const FEATURED_ENTITIES = ['admin', 'agent-claude-code', 'agent-codex'];
const projectColor = id => `var(--cat-${(Number(id) % 6) + 1})`;
const dateFromKey = key => new Date(`${key}T00:00:00`);
function timesheetWindow(now) {
  if (!state.dateFilter) return [rangeStartMs(state.range, now), now];
  const from = dateFromKey(state.dateFilter), to = dateFromKey(state.dateFilter);
  to.setDate(to.getDate() + 1);
  to.setHours(0, 0, 0, 0);
  return [from.getTime(), Math.min(to.getTime(), now)];
}
function formatTokens(n) {
  if (n >= 1000000) return `${Math.round(n / 100000) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`;
  return String(n);
}
const TOKEN_FIELDS = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
const segmentTokens = seg => TOKEN_FIELDS.reduce((sum, key) => sum + (seg[key] ?? 0), 0);
function tokenBreakdown(seg) {
  const parts = [
    ['in', seg.tokens_input],
    ['out', seg.tokens_output],
    ['reasoning', seg.tokens_reasoning],
    ['cache r', seg.tokens_cache_read],
    ['cache w', seg.tokens_cache_write],
  ];
  return parts.flatMap(([label, tokens]) => tokens ? [`${label} ${formatTokens(tokens)}`] : []).join(' · ');
}
function taskTokenTotals(task) {
  return task.segments.reduce((acc, seg) => {
    acc.input += seg.tokens_input ?? 0;
    acc.output += seg.tokens_output ?? 0;
    acc.reasoning += seg.tokens_reasoning ?? 0;
    acc.cacheRead += seg.tokens_cache_read ?? 0;
    acc.cacheWrite += seg.tokens_cache_write ?? 0;
    return acc;
  }, { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
}
function renderTokenStats(task) {
  const t = taskTokenTotals(task);
  const items = [['Input', t.input], ['Output', t.output], ['Reasoning', t.reasoning], ['Cache read', t.cacheRead], ['Cache write', t.cacheWrite]];
  return `<div class="detail-section-label">Recorded token counters</div><p class="hint">Native cache and reasoning counters may overlap input and output. Counters do not measure human typing or effort.</p><div class="token-grid">${items.map(([label, n]) =>
    `<div class="token-stat"><span class="hint">${label}</span><strong>${formatTokens(n)}</strong></div>`).join('')}</div>`;
}

// Keep typing and modal drafts intact across successful or failed background reloads.
const typingInField = () => $app.contains(document.activeElement) && document.activeElement.matches('input, select, textarea') || !!document.querySelector('.modal form');
let loadSeq = 0;
async function load(silent = false) {
  const seq = ++loadSeq;
  try {
    const [projects, activities, users, entries, recommendedTasks] = await Promise.all([
      api('/api/projects'), api('/api/activities'), api('/api/users'), api('/api/timesheets'), api('/api/recommended-tasks'),
    ]);
    if (seq !== loadSeq) return;
    state.projects = projects;
    state.activities = activities;
    state.users = users.map(u => ({ ...u, label: entityLabel(u.username), short: entityLabel(u.username), color: stableColorById(u.id, colors) }));
    state.entries = entries;
    state.recommendedTasks = recommendedTasks;
    state.error = '';
    state.lastUpdated = Date.now();
    state.stale = false;
    if (!state.pending.has('modal-form')) {
      if (!(silent && typingInField())) render();
    }
  } catch (error) {
    if (seq !== loadSeq) return;
    state.error = `Could not load live data: ${error.message}`;
    state.stale = silent;
    if (!state.pending.has('modal-form')) {
      if (!(silent && typingInField())) render();
    }
  }
}

function entityBadge(u) {
  return `<span class="badge" style="--entity:${u.color}">${escapeHtml(u.short)}</span>`;
}
function bars(rows, stacked = false, key = 'ms', fmt = formatDuration) {
  rows = rows.filter(row => row[key] > 0);
  if (!rows.length) return '<div class="empty">No non-zero values to display.</div>';
  const max = Math.max(1, ...rows.map(r => r[key]));
  return `<div class="bars">${rows.map(r => `<div class="bar-group" role="group" tabindex="0" aria-label="${escapeHtml(r.label)}, ${fmt(r[key])} total"><span class="bar-total">${fmt(r[key])}</span><div class="column" style="height:${Math.max(4, r[key] / max * 180)}px">${stacked ? r.parts.filter(x => x[key]).map(x => `<i style="flex:${x[key]};background:${x.color}"></i>`).join('') : `<i style="height:100%;background:${r.color}"></i>`}</div><span class="bar-label">${escapeHtml(r.short || r.label)}</span>${r.parts ? `<div class="bar-tooltip"><strong>${escapeHtml(r.label)}</strong><span class="hint">${fmt(r[key])} total</span>${r.parts.filter(x => x[key]).map(x => `<div class="tooltip-row"><i style="background:${x.color}"></i>${escapeHtml(x.short || x.label)}<span>${fmt(x[key])}</span></div>`).join('')}</div>` : ''}</div>`).join('')}</div>`;
}
function taskActions(task, currentStatus) {
  if (!isAdminTask(task)) return '';
  const id = escapeHtml(stableId(task));
  const pending = state.pending.has(stableId(task));
  const pauseResume = currentStatus === 'running' ? `<button class="icon-action${pending ? ' is-pending' : ''}" data-action="pause" data-id="${id}" title="Pause" aria-label="Pause"${pending ? ' disabled' : ''}>⏸</button>`
    : currentStatus === 'paused' ? `<button class="icon-action${pending ? ' is-pending' : ''}" data-action="resume" data-id="${id}" title="Resume" aria-label="Resume"${pending ? ' disabled' : ''}>▶</button>` : '';
  const end = currentStatus !== 'completed' ? `<button class="icon-action${pending ? ' is-pending' : ''}" data-action="end" data-id="${id}" title="End" aria-label="End"${pending ? ' disabled' : ''}>⏹</button>` : '';
  return `<div class="actions">${pauseResume}${end}</div>`;
}
// Nav only. Filters live in the topbar, next to the list they filter.
function renderSidebar(theme) {
  const views = [['timesheet', '', 'Timesheet'], ['calendar', 'calendar', 'Calendar'], ['activity', 'activity', 'Activity'], ['agents', 'agents', 'Agents'], ['reports', 'reports', 'Reports']];
  const manage = [['projects', 'projects', 'Projects'], ['favorites', 'favorites', 'Favorites']];
  const links = pages => pages.map(([id, , label]) => `<a class="nav-item ${state.page === id ? 'active' : ''}" href="${formatRoute({ ...state, page: id, modal: null })}">${label}</a>`).join('');
  return `<nav class="sidenav">
    <div class="nav-brand"><span class="brand-dot"></span>Timesheet</div>
    <div class="nav-section"><span class="hint">Views</span>${links(views)}</div>
    <div class="nav-section"><span class="hint">Manage</span>${links(manage)}</div>
    <div class="nav-foot">
      <button class="icon-btn" data-theme aria-label="Toggle theme">${theme === 'dark' ? '☾' : '☀'}</button>
    </div>
  </nav>`;
}
function renderTimesheetFilters(range) {
  const repos = repoOptions(groupIntoTasks(state.entries, { ownerScoped: true }));
  const unknownRepo = state.repoFilter && !repos.includes(state.repoFilter);
  if (unknownRepo) repos.push(state.repoFilter);
  const unknownKind = state.kindFilter != null && !state.activities.some(a => String(a.id) === state.kindFilter);
  return `<div class="filters">
    ${state.dateFilter
      ? `<button class="chip active" data-clear-date>${escapeHtml(formatDay(dateFromKey(state.dateFilter).toISOString()))} ✕</button>`
      : `<div class="segmented">${['day', 'week', 'month'].map(r => `<button class="${range === r ? 'active' : ''}" data-range="${r}" data-focus-id="range:${r}">${r[0].toUpperCase() + r.slice(1)}</button>`).join('')}</div>`}
    <select class="filter-select" data-project-filter aria-label="Filter project"><option value="all">All projects</option>${activeProjects().map(p => `<option value="${p.id}" ${state.projectFilter === String(p.id) ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}${state.projects.some(p => p.archived) ? `<optgroup label="Archived">${state.projects.filter(p => p.archived).map(p => `<option value="${p.id}" ${state.projectFilter === String(p.id) ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</optgroup>` : ''}</select>
  </div>
  <select class="filter-select" data-repo-filter data-focus-id="repo-filter" aria-label="Filter repository"><option value="all"${state.repoFilter == null ? ' selected' : ''}>All repositories</option><option value="repo:"${state.repoFilter === '' ? ' selected' : ''}>Unspecified</option>${repos.map(repo => `<option value="repo:${escapeHtml(repo)}"${state.repoFilter === repo ? ' selected' : ''}>${unknownRepo && state.repoFilter === repo ? 'Unknown: ' : ''}${escapeHtml(repo)}</option>`).join('')}</select>
  <select class="filter-select" data-purpose-filter data-focus-id="purpose-filter" aria-label="Filter purpose"><option value="">All purposes</option><option value="unclassified"${state.purposeFilter === 'unclassified' ? ' selected' : ''}>Unclassified</option>${purposeChoices.map(([value, label]) => `<option value="${value}"${state.purposeFilter === value ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>
  <select class="filter-select" data-kind-filter data-focus-id="kind-filter" aria-label="Filter kind"><option value="all"${state.kindFilter == null ? ' selected' : ''}>All kinds</option>${state.activities.map(a => `<option value="${a.id}"${state.kindFilter === String(a.id) ? ' selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}${unknownKind ? `<option value="${escapeHtml(state.kindFilter)}" selected>Unknown: ${escapeHtml(state.kindFilter)}</option>` : ''}</select>`;
}
function renderTopbar() {
  if (state.page === 'projects') return `<header class="topbar">
    <h1>Projects</h1>
    <div class="topbar-actions"><button class="primary" data-open-new-project data-focus-id="new-project">＋ New project</button></div>
  </header>`;
  if (state.page === 'favorites') return `<header class="topbar">
    <h1>Favorites</h1>
    <div class="topbar-actions"><button class="primary" data-open-new-recommended data-focus-id="new-recommended">＋ Add favorite</button></div>
  </header>`;
  if (state.page === 'activity') return `<header class="topbar"><h1>Activity</h1></header>`;
  if (state.page === 'reports') return `<header class="topbar"><h1>Reports</h1></header>`;
  if (state.page === 'agents') {
    const { working, idle } = agentsSummary();
    return `<header class="topbar"><h1>Agents</h1><div class="topbar-actions"><span class="status running"><i class="status-dot"></i>${working} working</span><span class="status completed"><i class="status-dot"></i>${idle} idle</span></div></header>`;
  }
  if (state.page === 'not-found') return `<header class="topbar"><h1>Page not found</h1></header>`;
  if (state.page === 'calendar') {
    const days = calendarWeekDays();
    const [start, end] = [days[0], days[6]];
    const sameMonth = start.getMonth() === end.getMonth();
    const rangeLabel = sameMonth
      ? `${MONTH_NAMES[start.getMonth()]} ${start.getDate()}–${end.getDate()}, ${end.getFullYear()}`
      : `${MONTH_NAMES[start.getMonth()]} ${start.getDate()} – ${MONTH_NAMES[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
    return `<header class="topbar">
      <h1>Calendar</h1>
      <div class="topbar-actions week-nav">
        <button class="icon-btn" data-week-nav="-1" aria-label="Previous week">‹</button>
        <span class="week-range">${escapeHtml(rangeLabel)}</span>
        <button class="icon-btn" data-week-nav="1" aria-label="Next week">›</button>
        ${state.calendarWeekOffset !== 0 ? `<button class="action" data-week-nav="0">This week</button>` : ''}
      </div>
    </header>`;
  }
  return `<header class="topbar">
    <h1>Timesheet</h1>
    <div class="topbar-actions">
      ${renderTimesheetFilters(state.range)}
      <div class="search"><input data-search data-focus-id="search" value="${escapeHtml(state.search)}" placeholder="Search tasks" aria-label="Search tasks"></div>
      <button class="primary" data-open-new data-focus-id="new">＋ New task</button>
    </div>
  </header>`;
}
function renderManagementPage() {
  return `<section class="panel">
    <div class="panel-head"><strong>${state.projects.length}</strong> project${state.projects.length === 1 ? '' : 's'}</div>
    <div class="table-wrap"><table class="tasks">
      <colgroup><col><col><col style="width:120px"></colgroup>
      <thead><tr><th>Project</th><th>Description</th><th></th></tr></thead>
      <tbody>${state.projects.length ? state.projects.map(p => `<tr>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.description)}</td>
        <td><div class="actions"><button class="action" data-archive-project="${p.id}">${p.archived ? 'Unarchive' : 'Archive'}</button><button class="icon-action" data-rename-project="${p.id}" data-focus-id="rename:${p.id}" title="Rename" aria-label="Rename ${escapeHtml(p.name)}">✎</button><button class="icon-action" data-delete-project="${p.id}" data-project-name="${escapeHtml(p.name)}" title="Delete" aria-label="Delete project ${escapeHtml(p.name)}">×</button></div></td>
      </tr>`).join('') : `<tr><td colspan="3"><div class="empty">No projects yet.</div></td></tr>`}</tbody>
    </table></div>
  </section>`;
}
function renderRecommendedPage() {
  if (!activeProjects().length) return `<div class="empty">Add a project first.</div>`;
  return activeProjects().map(p => {
    const tasks = state.recommendedTasks.filter(t => t.project_id === p.id);
    return `<section class="card reco-group">
      <h2>${escapeHtml(p.name)}</h2>
      ${tasks.length ? `<div class="reco-list">${tasks.map(t => `<div class="reco-item"><span>${escapeHtml(t.description)}</span><div class="actions"><label>Purpose<select data-recommended-purpose="${t.id}">${purposeOptions()}</select></label><label>Kind<select data-recommended-activity="${t.id}">${activityOptions()}</select></label><button class="action${state.pending.has(`reco:${t.id}`) ? ' is-pending' : ''}" data-start-recommended="${t.id}" data-project-id="${p.id}" data-description="${escapeHtml(t.description)}"${state.pending.has(`reco:${t.id}`) ? ' disabled' : ''}>Start</button><button class="icon-action" data-delete-recommended="${t.id}" title="Remove" aria-label="Remove favorite ${escapeHtml(t.description)}">×</button></div></div>`).join('')}</div>` : `<div class="empty">No favorite tasks for this project yet.</div>`}
    </section>`;
  }).join('');
}
const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
// Height of one hour row. Published to CSS as --cal-row-h so the day-column
// gridlines cannot drift out of step with the block positions computed here.
const CAL_ROW_HEIGHT = 64;
const CAL_MIN_HEIGHT = 1.5;
const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' }));
function calendarWeekDays() {
  const start = startOfWeek(new Date());
  start.setDate(start.getDate() + state.calendarWeekOffset * 7);
  start.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); d.setHours(0, 0, 0, 0); return d; });
}
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function activityHeatLevel(ms, max) {
  if (!ms) return 0;
  return Math.max(1, Math.min(4, Math.ceil(ms / max * 4)));
}
function restoreActivityScroll(scroll) {
  const key = scroll.dataset.activityScroll, saved = state.activityScroll.get(key);
  scroll.scrollLeft = saved && !saved.recent ? saved.left : scroll.scrollWidth;
}
window.addEventListener('resize', () => document.querySelectorAll('[data-activity-scroll]').forEach(restoreActivityScroll));
function activityGrid(dayMap, weeks, gridLabel, gridKey) {
  const max = Math.max(0, ...weeks.flat().filter(Boolean).map(d => dayMap.get(dayKey(d)) || 0));
  const monthLabels = weeks.map((week, i) => {
    const first = week.find(Boolean);
    if (!first) return '';
    const prevFirst = i > 0 ? weeks[i - 1].find(Boolean) : null;
    return (!prevFirst || prevFirst.getMonth() !== first.getMonth()) ? MONTH_NAMES[first.getMonth()] : '';
  });
  return `<div class="activity-scroll" data-activity-scroll="${gridKey}">
    <div class="activity-months">${monthLabels.map(m => `<span>${m}</span>`).join('')}</div>
    <div class="activity-row">
      <div class="activity-weekdays"><span></span><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span></div>
      <div class="activity-grid" role="grid" aria-label="${escapeHtml(gridLabel)} activity">${weeks.map((week, weekIndex) => `<div class="activity-week" role="row">${week.map((d, dayIndex) => {
        if (!d) return `<div class="activity-cell is-future"></div>`;
        const ms = dayMap.get(dayKey(d)) || 0;
        const level = activityHeatLevel(ms, max);
        const label = `${formatDay(d.toISOString())}: ${formatDuration(ms)}`;
        const cellIndex = weekIndex * 7 + dayIndex;
        return `<div class="activity-cell" data-activity-cell data-level="${level}" tabindex="${cellIndex === 0 ? 0 : -1}" role="gridcell" aria-label="${escapeHtml(label)}" data-focus-id="activity:${gridKey}:${dayKey(d)}" data-activity-day="${dayKey(d)}"${gridKey === 'all' ? '' : ` data-activity-owner="${gridKey}"`}><div class="activity-tooltip"><strong>${escapeHtml(formatDay(d.toISOString()))}</strong><span class="hint">${escapeHtml(formatDuration(ms))}</span></div></div>`;
      }).join('')}</div>`).join('')}</div>
    </div>
  </div>`;
}
function renderActivityPage() {
  const weeks = activityGridWeeks();
  const grids = [{ label: 'Total', userId: null }, ...state.users.map(u => ({ label: u.label, userId: u.id }))];
  return grids.map(g => `<section class="card activity-card"><h2>${escapeHtml(g.label)}</h2>${activityGrid(groupByDay(state.entries, g.userId), weeks, g.label, g.userId ?? 'all')}</section>`).join('');
}
function agentsSummary() {
  return agentActivity(state.entries, state.users.filter(u => u.username !== 'admin').map(u => u.id));
}
function renderAgentsPage() {
  const { agents, perProject, working } = agentsSummary();
  if (!agents.length) return `<section class="card"><div class="empty">No agent activity yet.</div></section>`;
  const hours = sevenDayHoursByAgent(state.entries, agents.map(a => a.id));
  const rows = [...agents].sort((a, b) => b.working - a.working).map(a => {
    const u = user(a.id);
    const open = a.open.at(-1);
    const activity = open && state.activities.find(x => x.id === open.activity_id);
    const hint = open
      ? `${activity?.name || 'Assigned Task'} · ${open.repo || project(open.project_id).name}`
      : `Last: ${project(a.last.project_id).name} · ${formatDay(a.last.begin)} ${formatClock(a.last.begin)}`;
    return `<a class="agent-row" href="#/?entity=${a.id}" style="color:inherit;text-decoration:none">
      <span class="status ${a.working ? 'running' : 'completed'}"><i class="status-dot"></i>${a.working ? 'Working' : 'Idle'}</span>
      <div class="trow-main"><strong><i class="dot" style="--entity:${u.color}"></i>${escapeHtml(u.label)}</strong><span class="hint">${escapeHtml(open ? open.description : hint)}</span>${open ? `<span class="hint">${escapeHtml(hint)}</span>` : ''}</div>
      <strong class="agent-hours">${hours.get(a.id).toFixed(1)}h <span class="hint">7d</span></strong>
      ${open ? `<span class="trow-dur" data-elapsed="${escapeHtml(taskKey(open))}" data-task-key="${escapeHtml(taskIdentity(open))}">${formatDuration(taskDurationMs({ segments: state.entries.filter(e => taskIdentity(e) === taskIdentity(open)) }))}</span>` : ''}
    </a>`;
  }).join('');
  // Scale against all working agents, so a full bar means "every working agent is here".
  const max = Math.max(1, working);
  const projectRows = perProject.length ? perProject.map(([id, n]) => `<div class="agent-proj">
      <span>${escapeHtml(project(id).name)}</span>
      <div class="agent-proj-track"><i style="width:${n / max * 100}%;background:${projectColor(id)}"></i></div>
      <strong>${n}</strong>
    </div>`).join('') : `<div class="empty">No agents working right now.</div>`;
  return `<section class="card agents-card"><h2>Agents</h2><div class="agent-rows">${rows}</div></section>
    <section class="card agents-card"><h2>Working by project</h2><span class="hint">agents with an open entry, out of ${working} working</span>${projectRows}</section>`;
}
function calendarEntityToggle() {
  return `<div class="cal-entities">${state.users.map(u => {
    const checked = !state.calendarEntities || state.calendarEntities.has(u.id);
    return `<label class="cal-entity-check"><input type="checkbox" data-calendar-entity="${u.id}" data-focus-id="calendar-entity:${u.id}"${checked ? ' checked' : ''}><i class="dot" style="--entity:${u.color}"></i>${escapeHtml(u.short)}</label>`;
  }).join('')}</div>`;
}
function renderCalendarPage() {
  const days = calendarWeekDays();
  const todayKey = dayKey(new Date());
  const now = Date.now();
  const visibleEntries = state.calendarEntities ? state.entries.filter(e => state.calendarEntities.has(e.user_id)) : state.entries;
  const dayColumns = days.map(d => packColumns(visibleEntries.map(e => clipToDay(e, d, now)).filter(Boolean)));
  dayColumns.forEach((day, i) => { day.blocks = packCalendarColumns(wallClockBlocks(day.blocks, days[i]), CAL_MIN_HEIGHT / 100 * 1440); });
  const clockNow = new Date(now);
  const nowMin = clockNow.getHours() * 60 + clockNow.getMinutes() + clockNow.getSeconds() / 60 + clockNow.getMilliseconds() / 60000;
  return `<section class="card">
    ${calendarEntityToggle()}
    <div class="cal-scroll">
      <div class="cal-head-row">
        <div></div>
        ${days.map(d => { const key = dayKey(d); return `<button class="cal-day-head${key === todayKey ? ' is-today' : ''}" data-calendar-day="${key}"><span>${DAY_NAMES[d.getDay()]}</span><span class="hint">${escapeHtml(formatDay(d.toISOString()))}</span></button>`; }).join('')}
      </div>
      <div class="cal-body" style="height:${24 * CAL_ROW_HEIGHT}px;--cal-row-h:${CAL_ROW_HEIGHT}px">
        <div class="cal-gutter">${HOUR_LABELS.map((label, h) => `<span class="cal-hour-label" style="top:${h / 24 * 100}%">${label}</span>`).join('')}</div>
        ${days.map((d, i) => {
          const key = dayKey(d);
          const { blocks } = dayColumns[i];
          return `<div class="cal-day-col">
            ${key === todayKey ? `<div class="cal-now-line" style="top:${nowMin / 1440 * 100}%"></div>` : ''}
            ${blocks.map(b => {
              const u = user(b.entry.user_id);
              const id = escapeHtml(taskKey(b.entry));
              const running = b.entry.end === null;
              const top = b.startMin / 1440 * 100;
              const height = (b.displayEndMin - b.startMin) / 1440 * 100;
              const left = b.col / b.columns * 100;
              const width = 100 / b.columns;
              return `<div class="cal-block${running ? ' is-running' : ''}${b.displayEndMin - b.startMin < 4 * 60 / CAL_ROW_HEIGHT ? ' is-tiny' : ''}" style="top:${top}%;height:${height}%;left:${left}%;width:${width}%;--entity:${u.color}" data-detail="${id}" data-task-key="${escapeHtml(taskIdentity(b.entry))}" data-focus-id="detail:${escapeHtml(taskIdentity(b.entry))}" tabindex="0" role="button" aria-label="${escapeHtml(u.label)}: ${escapeHtml(b.entry.description)}">${running ? '<span class="cal-block-dot"></span>' : ''}${escapeHtml(b.entry.description)}</div>`;
            }).join('')}
          </div>`;
        }).join('')}
      </div>
    </div>
  </section>`;
}
// One row shape for every task, live or logged: entity dot, description,
// "Entity · project" meta, duration. The live card and the day groups differ
// only in what wraps them.
function taskRow(t, now, scoped = false) {
  const u = user(t.user_id), s = status(t), id = escapeHtml(taskKey(t.segments.at(-1))), identity = escapeHtml(stableId(t));
  const activity = state.activities.find(item => item.id === t.segments.at(-1).activity_id);
  const meta = [...taskMeta(t, u.label, project(t.project_id).name, activity?.name || 'Assigned Task'), purposeLabel(t.segments.at(-1).purpose)];
  return `<div class="trow${s === 'running' ? ' is-running' : ''}" data-detail="${id}" data-task-key="${identity}" data-focus-id="detail:${identity}" tabindex="0" role="button" aria-label="${escapeHtml(u.label)}: ${escapeHtml(t.description)}">
    <span class="trow-dot" style="--entity:${u.color}"></span>
    <div class="trow-main"><strong>${escapeHtml(t.description)}</strong><span class="hint">${escapeHtml(meta.join(' · '))}</span></div>
    ${s === 'completed' ? '' : `<span class="status ${s}"><i class="status-dot"></i>${s === 'auto' ? 'auto-closed' : s}</span>`}
    ${taskActions(t, s === 'auto' ? 'completed' : s)}
    <span class="trow-dur" data-elapsed="${id}" data-task-key="${identity}"${scoped ? ' data-elapsed-scope="selected"' : ''}>${formatDuration(taskDurationMs(t, now))}</span>
  </div>`;
}
function renderLive(live, now) {
  return live.length ? `<section class="card live">
    <h2><span class="pulse"></span> &nbsp;Live now</h2>
    <div class="trows">${live.map(t => taskRow(t, now)).join('')}</div>
  </section>` : '';
}
// Each tile is also the entity filter — the sidebar used to list the same
// durations again just to be clickable.
/**
 * @param {string} label
 * @param {number} ms
 * @param {number | null} total
 * @param {{color?: string, title?: string, ids?: number[], clears?: boolean}} options
 */
function statTile(label, ms, total, { color, title, ids = [], clears = false } = {}) {
  const selected = ids.length > 0 && ids.every(id => state.entityFilter.has(id));
  const attrs = clears ? 'data-clear-entities' : ids.length ? `data-entity="${ids.join(',')}"` : 'disabled';
  return `<button class="stat${selected ? ' is-selected' : ''}" ${attrs} aria-pressed="${selected}"${title ? ` title="${escapeHtml(title)}"` : ''}>
    <span>${color ? `<i class="dot" style="--entity:${color}"></i>` : ''}${escapeHtml(label)}</span>
    <strong${ms ? '' : ' class="is-zero"'}>${formatDuration(ms)}</strong>
    ${total !== null ? `<span class="hint">${total ? Math.round(ms / total * 100) : 0}% of total</span>` : ''}
  </button>`;
}
function renderStats(perEntity, total) {
  const { featured, rest } = splitEntities(perEntity, FEATURED_ENTITIES);
  const restMs = rest.reduce((n, u) => n + u.ms, 0);
  return `<section class="card statbar${state.entityFilter.size ? ' has-filter' : ''}">
    ${statTile('Total logged', total, null, { clears: true, title: state.entityFilter.size ? 'Show all entities' : '' })}
    ${featured.map(u => statTile(u.label, u.ms, total, { color: u.color, ids: [u.id] })).join('')}
    ${statTile('Etc', restMs, total, {
      color: 'var(--muted)',
      ids: rest.map(u => u.id),
      title: rest.length ? rest.map(u => `${u.label}: ${formatDuration(u.ms)}`).join('\n') : 'No other entities yet',
    })}
  </section>`;
}
function renderCharts(perProject, perEntity, kindRows, perProjectTokens, perEntityTokens) {
  const tokens = state.chartMetric === 'tokens';
  const key = tokens ? 'tokens' : 'ms';
  const fmt = tokens ? formatTokens : formatDuration;
  const projectRows = tokens ? perProjectTokens : perProject;
  const entityRows = tokens ? perEntityTokens : perEntity;
  return `<section class="charts-head"><h2>Breakdown</h2><div class="segmented"><button class="${tokens ? '' : 'active'}" data-chart-metric="hours" data-focus-id="chart:hours">Hours</button><button class="${tokens ? 'active' : ''}" data-chart-metric="tokens" data-focus-id="chart:tokens">Tokens</button></div></section>${tokens ? '<p class="hint">Recorded counters follow agent attribution or entry ownership. Native cache and reasoning counters may overlap input and output; these totals do not measure human typing.</p>' : ''}
    <section class="charts"><article class="card chart"><div class="chart-title"><div><h2>${tokens ? 'Tokens' : 'Hours'} by project</h2><span class="hint">split by entity</span></div></div>${bars(projectRows, true, key, fmt)}</article><article class="card chart"><div class="chart-title"><div><h2>${tokens ? 'Tokens' : 'Hours'} by entity</h2><span class="hint">who logged it</span></div></div>${bars(entityRows, false, key, fmt)}</article>${tokens ? '' : `<article class="card chart"><div class="chart-title"><div><h2>Hours by kind × entity</h2><span class="hint">ways of working</span></div></div>${bars(kindRows, true)}</article>`}</section>`;
}
function dayHeading(key, now) {
  const today = dayKey(new Date(now));
  const yesterday = dayKey(new Date(now - 86400000));
  const date = dateFromKey(key);
  const label = formatDay(date.toISOString());
  if (key === today) return `Today — ${label}`;
  if (key === yesterday) return `Yesterday — ${label}`;
  return `${date.toLocaleDateString([], { weekday: 'long' })} — ${label}`;
}
const DAY_PREVIEW = 6;
function renderTaskGroups(tasks, now) {
  if (!tasks.length) return `<section class="panel card"><div class="empty">${state.entries.length ? 'No tasks match the current filters.' : 'No entries yet'}</div></section>`;
  // A search is a hunt for a specific row — collapsing would hide the hit.
  const collapsible = !state.search.trim();
  return groupTasksByDay(tasks).map(([key, dayTasks]) => {
    const expanded = state.expandedDays.has(key);
    const collapsed = collapsible && !expanded && dayTasks.length > DAY_PREVIEW;
    const visible = collapsed ? dayTasks.slice(0, DAY_PREVIEW) : dayTasks;
    const hidden = dayTasks.length - visible.length;
    return `<section class="day-group">
      <div class="day-head">${escapeHtml(dayHeading(key, now))} <span>· ${dayTasks.length} task${dayTasks.length === 1 ? '' : 's'}</span></div>
      <div class="card trows">${visible.map(t => taskRow(t, now, true)).join('')}</div>
      ${collapsible && dayTasks.length > DAY_PREVIEW ? `<button class="day-more" data-day-toggle="${escapeHtml(key)}" aria-expanded="${expanded}" data-focus-id="day:${escapeHtml(key)}">${collapsed ? `▾ ${hidden} more` : '▴ Show less'}</button>` : ''}
    </section>`;
  }).join('');
}
function renderTimesheetPage(allTasks, now) {
  const matchesPurpose = task => !state.purposeFilter || (task.segments.at(-1).purpose ?? 'unclassified') === state.purposeFilter;
  const live = liveTasks(allTasks, now).filter(matchesPurpose);
  const selectedTasks = allTasks.filter(task => {
    const last = task.segments.at(-1);
    if (!matchesPurpose(task) || !matchesRepoKind(task, state.repoFilter, state.kindFilter)) return false;
    if (state.projectFilter !== 'all' && String(last.project_id) !== state.projectFilter) return false;
    const activity = state.activities.find(item => item.id === last.activity_id);
    return matchesSearch({ ...task, description: last.description }, state.search, taskMeta(task, user(task.user_id).label, project(last.project_id).name, activity?.name || 'Assigned Task'));
  });
  const selectedIds = new Set(selectedTasks.map(stableId));
  const allTasksById = new Map(allTasks.map(task => [stableId(task), task]));
  const ranged = state.dateFilter
    ? state.entries.filter(e => dayKey(new Date(e.begin)) === state.dateFilter)
    : filterEntriesInRange(state.entries, state.range, now);
  const [from, to] = timesheetWindow(now);
  const selectedEntries = clipEntriesToWindow(state.entries, from, to, now).filter(entry => selectedIds.has(taskIdentity(entry)));
  const positiveIds = new Set(selectedEntries.map(taskIdentity));
  // Preserve existing clipped-task metadata when zero segments share a task.
  const zeroEntries = zeroDurationEntriesInWindow(state.entries, from, to)
    .filter(entry => selectedIds.has(taskIdentity(entry)) && !positiveIds.has(taskIdentity(entry)));
  const tokenEntries = ranged.filter(entry => selectedIds.has(taskIdentity(entry)));
  const perEntity = state.users.map(u => {
    const parts = state.projects.map(p => ({ label: p.name, color: projectColor(p.id), ms: selectedEntries.filter(e => e.user_id === u.id && e.project_id === p.id).reduce((n, e) => n + segmentDurationMs(e, now), 0) }));
    return { ...u, parts, ms: parts.reduce((n, x) => n + x.ms, 0) };
  });
  const total = perEntity.reduce((n, u) => n + u.ms, 0);
  const perProject = state.projects.map(p => {
    const parts = state.users.map(u => ({ label: u.label, color: u.color, ms: selectedEntries.filter(e => e.project_id === p.id && e.user_id === u.id).reduce((n, e) => n + segmentDurationMs(e, now), 0) }));
    return { id: p.id, label: p.name, short: p.name, color: projectColor(p.id), parts, ms: parts.reduce((n, x) => n + x.ms, 0) };
  });
  const entityTokenSum = (u, entries) => entries.reduce((sum, entry) => {
    if (entry.tokens_by_agent?.length) {
      const row = entry.tokens_by_agent.find(item => item.user_id === u.id);
      return sum + (row ? ['input', 'output', 'reasoning', 'cache_read', 'cache_write'].reduce((total, key) => total + (row[key] ?? 0), 0) : 0);
    }
    return sum + (entry.user_id === u.id ? segmentTokens(entry) : 0);
  }, 0);
  const perEntityTokens = state.users.map(u => {
    const parts = state.projects.map(p => ({ label: p.name, color: projectColor(p.id), tokens: entityTokenSum(u, tokenEntries.filter(e => e.project_id === p.id)) }));
    return { ...u, parts, tokens: parts.reduce((n, x) => n + x.tokens, 0) };
  });
  const perProjectTokens = state.projects.map(p => {
    const projectEntries = tokenEntries.filter(e => e.project_id === p.id);
    const parts = state.users.map(u => ({ label: u.label, color: u.color, tokens: entityTokenSum(u, projectEntries) }));
    return { id: p.id, label: p.name, short: p.name, color: projectColor(p.id), parts, tokens: parts.reduce((n, x) => n + x.tokens, 0) };
  });
  const kindRows = hoursByKindEntity(selectedEntries, state.activities.map(a => a.id), state.users.map(u => u.id), now).map(row => {
    const activity = state.activities.find(a => a.id === row.activityId);
    const parts = row.entities.map(entity => {
      const u = user(entity.id);
      return { label: u.label, short: u.short, color: u.color, ms: entity.hours * 3600000 };
    });
    return { label: activity?.name || String(row.activityId), short: activity?.name || String(row.activityId), color: stableColorById(row.activityId, colors), parts, ms: row.hours * 3600000 };
  });
  let tasks = groupIntoTasks([...selectedEntries, ...zeroEntries], { ownerScoped: true }).map(task => ({ ...task, currentStatus: taskStatus(allTasksById.get(stableId(task))) }));
  if (state.entityFilter.size) tasks = tasks.filter(t => state.entityFilter.has(t.user_id));
  const liveIds = new Set(live.map(stableId));
  const paused = tasks.filter(t => status(t) === 'paused' && !liveIds.has(stableId(t)));
  tasks = tasks.filter(t => !liveIds.has(stableId(t)) && !paused.includes(t));

  return `${renderLive(live, now)}${paused.length ? `<details class="card paused-group"><summary>Paused (${paused.length})</summary><div class="trows">${paused.map(t => taskRow(t, now, true)).join('')}</div></details>` : ''}${renderTaskGroups(tasks, now)}<details class="dashboard-stats"${(state.statsOpen ?? !matchMedia('(max-width: 600px)').matches) ? ' open' : ''}><summary>Stats and charts</summary><p class="hint">Totals and charts follow the selected dates and task filters across all entities. Entity tiles filter the logged task list. Live now shows current tasks across dates and filters, except purpose.</p>${renderStats(perEntity, total)}${renderCharts(perProject, perEntity, kindRows, perProjectTokens, perEntityTokens)}</details>`;
}
function render() {
  const active = /** @type {FocusTarget} */ (document.activeElement);
  const focusId = active?.dataset.focusId;
  /** @type {[number | null | undefined, number | null | undefined] | null} */
  const selection = active?.selectionStart === null ? null : [active?.selectionStart, active?.selectionEnd];
  if (!state.users.length) {
    $app.innerHTML = `<div class="loading">${escapeHtml(state.error || 'Loading timesheet…')}${state.error ? '<button class="action" data-retry>Retry</button>' : ''}</div>`;
    document.querySelector('[data-retry]')?.addEventListener('click', () => load());
    return;
  }
  const now = Date.now();
  const allTasks = groupIntoTasks(state.entries, { ownerScoped: true });

  const pageBody = state.page === 'projects' ? renderManagementPage()
    : state.page === 'favorites' ? renderRecommendedPage()
    : state.page === 'activity' ? renderActivityPage()
    : state.page === 'calendar' ? renderCalendarPage()
    : state.page === 'agents' ? renderAgentsPage()
    : state.page === 'reports' ? renderReports(state, { includePurpose: true, ownerScoped: true })
    : state.page === 'not-found' ? `<section class="card"><div class="empty">Page not found.</div></section>`
    : renderTimesheetPage(allTasks, now);

  /** @type {HTMLFormElement} */
  const draftForm = document.querySelector('.modal form');
  const formType = draftForm?.getAttributeNames().find(name => name.startsWith('data-') && name.endsWith('-form'));
  const draft = !skipDraft && renderedModal === state.modal && formType ? {
    selector: `[${formType}]`, projectId: draftForm.dataset.projectId, taskId: draftForm.dataset.taskId,
    values: [.../** @type {NodeListOf<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>} */ (draftForm.querySelectorAll('[name]'))]
      .flatMap(control => ['hidden', 'file'].includes(control.type) ? [] : [{ name: control.name, value: control.value, base: control instanceof HTMLSelectElement
        ? [...control.options].find(option => option.defaultSelected)?.value ?? control.options[0]?.value
        : control.defaultValue }]),
  } : null;
  skipDraft = false;

  $app.innerHTML = `<div class="shell">
    ${renderSidebar(document.documentElement.dataset.theme)}
    <div class="content">
      ${renderTopbar()}
      <div class="content-body">
        <div aria-live="polite">${state.stale ? `<div class="stale">Updated ${formatClock(new Date(state.lastUpdated))} · <button class="action" data-retry>Retry</button></div>` : state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}</div>
        ${pageBody}
      </div>
    </div>
  </div>${renderModal(allTasks)}`;
  bind(allTasks);
  /** @type {HTMLFormElement} */
  const restoredForm = draft && document.querySelector(draft.selector);
  if (restoredForm && restoredForm.dataset.projectId === draft.projectId && restoredForm.dataset.taskId === draft.taskId) {
    for (const { name, value, base } of draft.values) {
      const control = /** @type {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement} */ (restoredForm.elements.namedItem(name));
      if (!control || value === base) continue;
      if (control instanceof HTMLSelectElement && ![...control.options].some(option => option.value === value)) continue;
      control.value = value;
    }
  }
  const focusTarget = focusId && [.../** @type {NodeListOf<FocusTarget>} */ (document.querySelectorAll('[data-focus-id]'))].find(el => el.dataset.focusId === focusId);
  if (focusTarget) {
    focusTarget.focus({ preventScroll: focusTarget.matches('[data-activity-cell]') });
    if (selection) focusTarget.setSelectionRange?.(...selection);
  }
  // This modal selector contains only input/select controls and its close button.
  /** @type {HTMLDivElement & {querySelector(selectors: 'input, select, button.close'): HTMLInputElement | HTMLSelectElement | HTMLButtonElement}} */
  const modal = document.querySelector('.modal');
  if (modal && !modal.contains(document.activeElement)) modal.querySelector('input, select, button.close')?.focus();
  renderedModal = state.modal;
}

function renderModal(tasks) {
  if (!state.modal) return '';
  if (state.modal === 'new') return `<div class="modal-bg" data-close><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><h2 id="modal-title">Start a new task</h2><button class="close" aria-label="Close" data-close>×</button></div><form data-new-form><div class="modal-body"><div class="detail-section-label">Who</div><div class="notice">You (admin) · New tasks are admin-only</div><label>Project<select name="project" required>${activeProjects().map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}</select></label><label>Purpose<select name="purpose">${purposeOptions()}</select></label><label>Kind<select name="activity" required>${activityOptions()}</select></label><label>Task description<input name="description" required maxlength="240" placeholder="What's the task?"></label></div><div class="modal-actions"><button type="button" class="action" data-close>Cancel</button><button class="primary">Start task</button></div></form></div></div>`;
  if (state.modal === 'new-project') return `<div class="modal-bg" data-close><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><h2 id="modal-title">New project</h2><button class="close" aria-label="Close" data-close>×</button></div><form data-new-project-form><div class="modal-body"><label>Project name<input name="name" required maxlength="120" placeholder="e.g. mobile-app"></label></div><div class="modal-actions"><button type="button" class="action" data-close>Cancel</button><button class="primary">Create project</button></div></form></div></div>`;
  if (state.modal === 'new-recommended') return `<div class="modal-bg" data-close><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><h2 id="modal-title">Add favorite task</h2><button class="close" aria-label="Close" data-close>×</button></div><form data-new-recommended-form><div class="modal-body"><label>Project<select name="project" required>${activeProjects().map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}</select></label><label>Description<input name="description" required maxlength="240" placeholder="e.g. Research this topic"></label></div><div class="modal-actions"><button type="button" class="action" data-close>Cancel</button><button class="primary">Add</button></div></form></div></div>`;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Keep the route/state boundary guard before calling a string method.
  if (typeof state.modal === 'string' && state.modal.startsWith('rename-project:')) {
    const proj = state.projects.find(p => p.id === Number(state.modal.split(':')[1]));
    if (!proj) return '';
    return `<div class="modal-bg" data-close><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><h2 id="modal-title">Rename project</h2><button class="close" aria-label="Close" data-close>×</button></div><form data-rename-project-form data-project-id="${proj.id}"><div class="modal-body"><label>Project name<input name="name" required maxlength="120" value="${escapeHtml(proj.name)}"></label><label>Project description<input name="description" maxlength="240" value="${escapeHtml(proj.description ?? '')}"></label></div><div class="modal-actions"><button type="button" class="action" data-close>Cancel</button><button class="primary">Save</button></div></form></div></div>`;
  }
  const task = resolveTask(tasks, state.modal);
  if (!task) return `<div class="modal-bg" data-close><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><h2 id="modal-title">Task unavailable</h2><button class="close" aria-label="Close" data-close>×</button></div><div class="modal-body"><p class="error" role="alert">Task link is missing or ambiguous. Close this window and choose a task from the list.</p></div></div></div>`;
  const s = status(task), u = user(task.user_id);
  const tokensTotal = task.segments.reduce((sum, seg) => sum + segmentTokens(seg), 0);
  const activity = state.activities.find(item => item.id === task.segments.at(-1).activity_id);
  return `<div class="modal-bg" data-close><div class="modal task-detail" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><h2 id="modal-title">Task details</h2><button class="close" aria-label="Close" data-close>×</button></div>
    <div class="modal-body">
    <h3 class="detail-title">${escapeHtml(task.description)}</h3>
    <div class="detail-meta">${entityBadge(u)}<span class="status ${s}"><i class="status-dot"></i>${s === 'auto' ? 'Auto-closed' : s[0].toUpperCase() + s.slice(1)}</span><span class="hint">${escapeHtml(project(task.project_id).name)}</span>${activity?.name === 'Assigned Task' ? '' : `<span class="hint">${escapeHtml(activity?.name || 'Assigned Task')}</span>`}${task.segments.at(-1).repo ? `<span class="hint">${escapeHtml(task.segments.at(-1).repo)}</span>` : ''}<span class="hint">${escapeHtml(purposeLabel(task.segments.at(-1).purpose))}</span><span class="hint">${formatDuration(taskDurationMs(task))} logged</span>${tokensTotal > 0 ? `<span class="hint">${formatTokens(tokensTotal)} tokens</span>` : ''}</div>
    ${tokensTotal > 0 ? renderTokenStats(task) : ''}
    <div class="detail-section-label">History</div>
    <div class="timeline">${task.segments.map((seg, i) => {
      const tokens = segmentTokens(seg), breakdown = tokenBreakdown(seg);
      return `<div class="timeline-item"><span class="timeline-dot ${seg.end ? '' : 'is-live'}"></span><span>Segment ${i + 1}</span><span class="hint">${formatDay(seg.begin)} ${formatClock(seg.begin)} → ${seg.end ? formatClock(seg.end) : 'running'}</span><span class="duration">${formatDuration(segmentDurationMs(seg))}</span>${tokens > 0 ? `<span class="tokens"${breakdown ? ` title="${escapeHtml(breakdown)}"` : ''}>${formatTokens(tokens)} tokens</span>` : ''}</div>`;
    }).join('')}</div>
    <form data-edit-task-form data-task-id="${escapeHtml(stableId(task))}"><div class="detail-section-label">Edit task</div><label>Project<select name="project" required>${state.projects.filter(p => !p.archived || p.id === task.project_id).map(p => `<option value="${p.id}"${p.id === task.project_id ? ' selected' : ''}>${escapeHtml(p.name)}${p.archived ? ' (archived)' : ''}</option>`).join('')}</select></label><label>Purpose<select name="purpose">${purposeOptions(task.segments.at(-1).purpose)}</select></label><label>Kind<select name="activity" required>${activityOptions(task.segments.at(-1).activity_id)}</select></label><label>Task description<input name="description" required maxlength="240" value="${escapeHtml(task.description)}"></label><label>Repository<input name="repo" value="${escapeHtml(task.segments.at(-1).repo ?? '')}"></label><div class="error" data-edit-error role="alert" hidden></div><div class="modal-actions"><button class="primary">Save changes</button></div></form>
    </div>
    ${isAdminTask(task) ? `<div class="modal-actions">
      ${s === 'completed' ? `<button class="action${state.pending.has(stableId(task)) ? ' is-pending' : ''}" data-action="reopen" data-id="${escapeHtml(stableId(task))}"${state.pending.has(stableId(task)) ? ' disabled' : ''}>Reopen task</button>` : ''}
      <button class="action danger${state.pending.has(stableId(task)) ? ' is-pending' : ''}" data-delete-task="${escapeHtml(stableId(task))}"${state.pending.has(stableId(task)) ? ' disabled' : ''}>Delete task</button>
    </div>` : ''}
    </div></div>`;
}

async function mutate(task, action) {
  const id = stableId(task);
  if (state.pending.has(id)) return;
  state.pending.add(id);
  render();
  try {
    if (!isAdminTask(task)) return;
    if ((action === 'resume' || action === 'reopen') && !task.isRunning) await api('/api/timesheets', { method: 'POST', body: JSON.stringify({ resume_of: task.segments.at(-1).id }) });
    else await api(`/api/timesheets/${task.segments.at(-1).id}`, { method: 'PATCH', body: JSON.stringify({ end_reason: action === 'pause' ? 'paused' : 'done' }) });
    if (action === 'reopen') state.modal = null;
    await load();
  } catch (error) { state.error = error.message; }
  finally { state.pending.delete(id); render(); }
}

function bind(tasks) {
  document.querySelectorAll('[data-range]').forEach((/** @type {HTMLElement} */ el) => el.onclick = () => updateRoute({ range: el.dataset.range }));
  document.querySelectorAll('[data-week-nav]').forEach((/** @type {HTMLElement} */ el) => el.onclick = () => { const v = el.dataset.weekNav; updateRoute({ calendarWeekOffset: v === '0' ? 0 : state.calendarWeekOffset + Number(v) }); });
  document.querySelectorAll('[data-calendar-day]').forEach((/** @type {HTMLElement} */ el) => el.onclick = () => { location.hash = `#/?date=${el.dataset.calendarDay}`; });
  document.querySelector('[data-clear-date]')?.addEventListener('click', () => updateRoute({ dateFilter: null }));
  document.querySelectorAll('[data-calendar-entity]').forEach((/** @type {HTMLInputElement} */ el) => el.onchange = () => {
    const id = Number(el.dataset.calendarEntity);
    if (!state.calendarEntities) state.calendarEntities = new Set(state.users.map(u => u.id));
    if (el.checked) state.calendarEntities.add(id);
    else state.calendarEntities.delete(id);
    updateRoute({ entityFilter: state.calendarEntities.size === state.users.length ? new Set() : new Set(state.calendarEntities) });
  });
  document.querySelector('.dashboard-stats')?.addEventListener('toggle', /** @param {Event & {currentTarget: HTMLDetailsElement}} e */ e => { state.statsOpen = e.currentTarget.open; });
  document.querySelectorAll('[data-chart-metric]').forEach((/** @type {HTMLElement} */ el) => el.onclick = () => { state.chartMetric = el.dataset.chartMetric; render(); });
  /** @type {HTMLButtonElement} */ (document.querySelector('button[data-theme]')).onclick = () => { const next=document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme=next; localStorage.setItem('ttd-theme',next); render(); };
  document.querySelector('[data-open-new]')?.addEventListener('click', e => openModal('new', e.currentTarget));
  document.querySelector('[data-open-new-project]')?.addEventListener('click', e => openModal('new-project', e.currentTarget));
  document.querySelector('[data-open-new-recommended]')?.addEventListener('click', e => openModal('new-recommended', e.currentTarget));
  /** @type {HTMLInputElement} */
  const searchInput = document.querySelector('[data-search]');
  if (searchInput) searchInput.oninput = /** @param {InputEvent & {target: HTMLInputElement}} e */ e => updateRoute({ search: e.target.value });
  document.querySelector('[data-project-filter]')?.addEventListener('change', /** @param {Event & {target: HTMLSelectElement}} e */ e => updateRoute({ projectFilter: e.target.value }));
  document.querySelector('[data-repo-filter]')?.addEventListener('change', /** @param {Event & {target: HTMLSelectElement}} e */ e => updateRoute({ repoFilter: e.target.value === 'all' ? null : e.target.value.slice(5) }, true));
  document.querySelector('[data-purpose-filter]')?.addEventListener('change', /** @param {Event & {target: HTMLSelectElement}} e */ e => updateRoute({ purposeFilter: e.target.value || null }, true));
  document.querySelector('[data-kind-filter]')?.addEventListener('change', /** @param {Event & {target: HTMLSelectElement}} e */ e => updateRoute({ kindFilter: e.target.value === 'all' ? null : e.target.value }, true));
  document.querySelectorAll('[data-entity]').forEach((/** @type {HTMLElement} */ el) => el.onclick = () => {
    // One tile can stand for several entities (the "Etc" bucket), so toggle the
    // whole set together: select unless every id is already selected.
    const ids = el.dataset.entity.split(',').map(Number);
    const selected = ids.every(id => state.entityFilter.has(id));
    const entities = new Set(state.entityFilter);
    ids.forEach(id => selected ? entities.delete(id) : entities.add(id));
    updateRoute({ entityFilter: entities });
  });
  document.querySelector('[data-clear-entities]')?.addEventListener('click', () => updateRoute({ entityFilter: new Set() }));
  document.querySelectorAll('[data-day-toggle]').forEach((/** @type {HTMLElement} */ el) => el.onclick = () => {
    const key = el.dataset.dayToggle;
    void (state.expandedDays.has(key) ? state.expandedDays.delete(key) : state.expandedDays.add(key));
    render();
  });
  document.querySelectorAll('[data-rename-project]').forEach((/** @type {HTMLElement} */ el) => el.onclick = e => openModal(`rename-project:${el.dataset.renameProject}`, e.currentTarget));
  document.querySelectorAll('[data-archive-project]').forEach((/** @type {HTMLElement} */ el) => el.onclick = async () => { const p=state.projects.find(project => project.id === Number(el.dataset.archiveProject)); if (!p) return; try { await api(`/api/projects/${p.id}`,{method:'PATCH',body:JSON.stringify({archived: !p.archived})}); await load(); } catch(error) { state.error=error.message; render(); } });
  document.querySelectorAll('[data-start-recommended]').forEach((/** @type {FavoriteStartButton} */ el) => el.onclick = async e => {
    e.stopPropagation();
    const id = `reco:${el.dataset.startRecommended}`;
    if (state.pending.has(id)) return;
    const body = { project: Number(el.dataset.projectId), activity: Number(el.parentElement.querySelector('[data-recommended-activity]').value), description: el.dataset.description };
    const purpose = el.parentElement.querySelector('[data-recommended-purpose]').value;
    if (purpose) body.purpose = purpose;
    state.pending.add(id); render();
    try {
      await api('/api/timesheets', { method: 'POST', body: JSON.stringify(body) });
      await load();
    } catch (error) { state.error = error.message; }
    finally { state.pending.delete(id); render(); }
  });
  document.querySelectorAll('[data-delete-recommended]').forEach((/** @type {HTMLElement} */ el) => el.onclick = async e => {
    e.stopPropagation();
    if (!confirm('Remove this favorite task?')) return;
    try { await api(`/api/recommended-tasks/${el.dataset.deleteRecommended}`, { method: 'DELETE' }); await load(); }
    catch (error) { state.error = error.message; render(); }
  });
  document.querySelectorAll('[data-detail]').forEach((/** @type {HTMLElement} */ el) => el.onclick = e => { e.stopPropagation(); openModal(el.dataset.taskKey || el.dataset.detail, e.currentTarget); });
  document.querySelectorAll('[data-detail][tabindex]').forEach((/** @type {HTMLElement} */ el) => el.onkeydown = e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); openModal(el.dataset.taskKey || el.dataset.detail, e.currentTarget); } });
  document.querySelectorAll('[data-delete-project]').forEach((/** @type {HTMLElement} */ el) => el.onclick = async e => { e.stopPropagation(); if (!confirm(`Delete project "${el.dataset.projectName}"? This cannot be undone.`)) return; try { await api(`/api/projects/${el.dataset.deleteProject}`, { method: 'DELETE' }); await load(); } catch(error) { state.error=error.message; render(); } });
  document.querySelectorAll('[data-delete-task]').forEach((/** @type {HTMLElement} */ el) => el.onclick = async e => {
    e.stopPropagation();
    const id = el.dataset.deleteTask;
    if (state.pending.has(id)) return;
    const task = tasks.find(t => stableId(t) === id);
    if (!task || !confirm('Delete this task? This removes all its logged time and cannot be undone.')) return;
    state.pending.add(id); render();
    try {
      await Promise.all(task.segments.map(seg => api(`/api/timesheets/${seg.id}`, { method: 'DELETE' })));
      state.modal = null;
      await load();
    } catch (error) { state.error = error.message; }
    finally { state.pending.delete(id); render(); }
  });
  document.querySelectorAll('[data-action]').forEach((/** @type {HTMLElement} */ el) => el.onclick = e => { e.stopPropagation(); if (!state.pending.has(el.dataset.id)) mutate(tasks.find(t => stableId(t) === el.dataset.id), el.dataset.action); });
  document.querySelectorAll('[data-close]').forEach((/** @type {HTMLElement} */ el) => el.onclick = e => { if (e.target === el || el.matches('button')) closeModal(); });
  document.querySelector('[data-retry]')?.addEventListener('click', () => load());
  document.querySelector('.modal')?.addEventListener('click', e => e.stopPropagation());
  document.querySelector('.modal')?.addEventListener('keydown', trapModalFocus);
  document.querySelectorAll('[data-activity-cell]').forEach((/** @type {HTMLElement} */ el) => { el.onkeydown = moveActivityFocus; el.onclick = () => drillDown(el); });
  document.querySelectorAll('[data-activity-scroll]').forEach((/** @type {HTMLElement} */ scroll) => {
    const key = scroll.dataset.activityScroll;
    scroll.onscroll = () => { if (scroll.isConnected && scroll.scrollWidth > scroll.clientWidth) state.activityScroll.set(key, { left: scroll.scrollLeft, recent: scroll.scrollLeft >= scroll.scrollWidth - scroll.clientWidth - 1 }); };
    const grid = scroll.querySelector('[role="grid"]'), cells = [.../** @type {NodeListOf<HTMLElement>} */ (grid.querySelectorAll('[data-activity-cell]'))];
    const selected = cells.find(cell => cell.dataset.focusId === state.activityFocus.get(key)) || cells.at(-1);
    cells.forEach(cell => { cell.tabIndex = cell === selected ? 0 : -1; });
    restoreActivityScroll(scroll);
    grid.addEventListener('focusin', /** @param {FocusEvent & {target: HTMLElement}} event */ event => {
      /** @type {HTMLElement} */
      const cell = event.target.closest('[data-activity-cell]');
      if (!cell) return;
      state.activityFocus.set(key, cell.dataset.focusId);
      cells.forEach(item => { item.tabIndex = item === cell ? 0 : -1; });
    });
  });
  /** @param {HTMLFormElement} form */
  const reportFormError = (form, selector, modal, message) => {
    let live = form;
    if (!form.isConnected) {
      /** @type {HTMLFormElement} */
      const next = state.modal === modal ? document.querySelector(selector) : null;
      const same = next && next.dataset.projectId === form.dataset.projectId && next.dataset.taskId === form.dataset.taskId;
      live = same ? next : null;
    }
    if (!live) return;
    /** @type {HTMLElement} */
    let alert = live.querySelector('[data-edit-error], [data-form-error]');
    if (!alert) {
      alert = document.createElement('div');
      alert.className = 'error';
      alert.dataset.formError = '';
      alert.setAttribute('role', 'alert');
      live.append(alert);
    }
    alert.textContent = message;
    alert.hidden = false;
  };
  const submitForm = (selector, path, payload, method = 'POST') => {
    const form = document.querySelector(selector);
    if (!form) return;
    form.onsubmit = async e => {
      e.preventDefault();
      if (state.pending.has('modal-form')) return;
      const data = new FormData(form), modal = state.modal;
      const controls = [...form.closest('.modal').querySelectorAll('input, select, button')];
      let errorMessage = form.querySelector('[data-form-error]');
      if (!errorMessage) {
        errorMessage = document.createElement('div');
        errorMessage.className = 'error';
        errorMessage.dataset.formError = '';
        errorMessage.setAttribute('role', 'alert');
        form.append(errorMessage);
      }
      errorMessage.hidden = true;
      state.pending.add('modal-form');
      controls.forEach(control => { control.disabled = true; });
      try {
        await api(path(form), { method, body: JSON.stringify(payload(data, form)) });
        state.pending.delete('modal-form');
        if (state.modal === modal) state.modal = null;
        await load();
      } catch (error) {
        reportFormError(form, selector, modal, error.message);
      } finally {
        state.pending.delete('modal-form');
        controls.forEach(control => { control.disabled = false; });
      }
    };
  };
  submitForm('[data-new-form]', () => '/api/timesheets', data => {
    const payload = {project:Number(data.get('project')), activity:Number(data.get('activity')), description:data.get('description').trim()};
    if (data.get('purpose')) payload.purpose = data.get('purpose');
    return payload;
  });
  submitForm('[data-new-project-form]', () => '/api/projects', data => ({name:data.get('name').trim()}));
  submitForm('[data-rename-project-form]', form => `/api/projects/${form.dataset.projectId}`, (data, form) => {
    const payload = {name:data.get('name').trim()}, description = data.get('description').trim();
    const proj = state.projects.find(p => p.id === Number(form.dataset.projectId));
    if (description !== (proj.description ?? '')) payload.description = description;
    return payload;
  }, 'PATCH');
  submitForm('[data-new-recommended-form]', () => '/api/recommended-tasks', data => ({project:Number(data.get('project')), description:data.get('description').trim()}));
  /** @type {HTMLFormElement} */
  const editForm=document.querySelector('[data-edit-task-form]');
  if (editForm) editForm.onsubmit = async e => {
    e.preventDefault();
    /** @type {HTMLButtonElement} */
    const submit = editForm.querySelector('button[type=submit], button.primary');
    if (submit.disabled) return;
    if (state.pending.has('modal-form')) return;
    const task = tasks.find(t => stableId(t) === editForm.dataset.taskId), data = new FormData(editForm), modal = state.modal;
    if (!task) return;
    /** @type {HTMLElement} */
    const errorMessage = editForm.querySelector('[data-edit-error]');
    errorMessage.hidden = true;
    state.pending.add('modal-form');
    const controls = [.../** @type {NodeListOf<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>} */ (editForm.querySelectorAll('input, select, button'))];
    controls.forEach(control => { control.disabled = true; });
    try {
      // The generated edit form supplies description through a required text input.
      const body = {}, project = Number(data.get('project')), activity = Number(data.get('activity')), description = /** @type {string} */ (data.get('description')).trim();
      if (project !== task.project_id) body.project = project;
      if (activity !== task.segments.at(-1).activity_id) body.activity = activity;
      if (description !== task.description) body.description = description;
      const repo = /** @type {string} */ (data.get('repo')).trim() || null;
      if (repo !== (task.segments.at(-1).repo ?? null)) body.repo = repo;
      const purpose = data.get('purpose') || null;
      const purposeChanged = purpose !== (task.segments.at(-1).purpose ?? null);
      if (!Object.keys(body).length && !purposeChanged) return;
      if (Object.keys(body).length) await Promise.all(task.segments.map(seg => api(`/api/timesheets/${seg.id}`, { method: 'PATCH', body: JSON.stringify(body) })));
      if (purposeChanged) await api(`/api/timesheets/${task.segments.at(-1).id}`, { method: 'PATCH', body: JSON.stringify({ purpose }) });
      state.pending.delete('modal-form');
      skipDraft = true;
      await load();
    } catch (error) {
      reportFormError(editForm, '[data-edit-task-form]', modal, error.message);
    } finally { state.pending.delete('modal-form'); controls.forEach(control => { control.disabled = false; }); }
  };
  if (state.modal !== lastFocusedModal) {
    lastFocusedModal = state.modal;
    /** @type {HTMLInputElement | HTMLButtonElement} */ (document.querySelector('.modal input') || document.querySelector('.modal button.close'))?.focus();
  }
}

function trapModalFocus(event) {
  if (event.key !== 'Tab') return;
  const focusable = [...event.currentTarget.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])')].filter(el => !el.disabled);
  if (!focusable.length) return;
  const [first] = focusable, last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

/** @param {HTMLElement} cell */
function drillDown(cell) {
  cell.focus({ preventScroll: true });
  history.replaceState({ activityOpener: cell.dataset.focusId }, '', location.href);
  updateRoute({ page: 'timesheet', dateFilter: cell.dataset.activityDay, entityFilter: new Set(cell.dataset.activityOwner ? [Number(cell.dataset.activityOwner)] : []), projectFilter: 'all', search: '', repoFilter: null, kindFilter: null, purposeFilter: null }, true);
}

function moveActivityFocus(event) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    drillDown(event.currentTarget);
    return;
  }
  if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
  const cells = [...event.currentTarget.closest('[role="grid"]').querySelectorAll('[data-activity-cell]')];
  const index = cells.indexOf(event.currentTarget);
  const offset = event.key === 'ArrowRight' ? 7 : event.key === 'ArrowLeft' ? -7 : event.key === 'ArrowDown' ? 1 : -1;
  const next = cells[(index + offset + cells.length) % cells.length];
  event.preventDefault();
  event.currentTarget.tabIndex = -1;
  next.tabIndex = 0;
  next.focus();
}

function tickElapsed() {
  const labels = document.querySelectorAll('[data-elapsed]');
  if (!labels.length) return;
  const tasks = new Map(groupIntoTasks(state.entries, { ownerScoped: true }).map(task => [stableId(task), task]));
  const now = Date.now(), [from, to] = timesheetWindow(now);
  const scopedTasks = new Map(groupIntoTasks(clipEntriesToWindow(state.entries, from, to, now), { ownerScoped: true }).map(task => [stableId(task), task]));
  labels.forEach((/** @type {HTMLElement} */ el) => {
    const task = (el.dataset.elapsedScope ? scopedTasks : tasks).get(el.dataset.taskKey || el.dataset.elapsed);
    if (task) el.textContent = formatDuration(taskDurationMs(task));
  });
}

await load();
setInterval(tickElapsed, 1000);
setInterval(() => load(true), 300000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(true); });
