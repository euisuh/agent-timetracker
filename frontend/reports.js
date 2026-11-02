import { purposeChoices, purposeLabel } from './helpers.js';
import { filterReportEntries, formatReportRoute, idleGaps, matchesReportDimensions, needsAttention, parseReportRoute, rawReportCsv, reportCoverage, reportRange, summarize, taskHref, toCsv, unclassifiedTasks, weekStart, weekValue, weeklySeries } from './report-helpers.js';

let data;
let includePurpose = false;
let ownerScoped = false;
const reportState = hash => {
  const next = parseReportRoute(hash);
  const params = new URL(hash.replace(/^#/, '') || '/reports', 'https://timesheet.local').searchParams;
  // Saved dimension-filter URLs predate purpose and keep their original grouping.
  if (includePurpose && !params.has('report_by') && (params.has('report_purpose') || !['agent', 'project', 'kind', 'repo'].some(key => params.has(`report_${key}`)))) next.by = ['purpose'];
  return next;
};
let state = parseReportRoute(globalThis.location?.hash || '');
let view;
const escape = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const duration = ms => `${Math.round(ms / 360000) / 10}h`;
const tokens = value => value >= 1000 ? `${Math.round(value / 100) / 10}k` : String(value);
const name = (items, id, key = 'name') => items.find(item => item.id === id)?.[key] || String(id);
const label = (row, dimension) => dimension === 'purpose' ? purposeLabel(row.purpose) : dimension === 'agent' ? name(data.users, row.agent, 'label') : dimension === 'project' ? name(data.projects, row.project) : dimension === 'kind' ? name(data.activities, row.kind) : row.repo ?? '—';

function filterControl(key, title, choices) {
  if (state[key] && !choices.some(([value]) => value === state[key])) choices.push([state[key], `${state[key]} (unavailable)`]);
  return `<label>${title} <select class="filter-select" data-report-filter="${key}"><option value="">All</option>${choices.map(([value, text]) => `<option value="${escape(value)}"${value === state[key] ? ' selected' : ''}>${escape(text)}</option>`).join('')}</select></label>`;
}

function unclassifiedReview(options) {
  if (!includePurpose) return '';
  const tasks = unclassifiedTasks(data.entries, options);
  return `<details data-report-unclassified><summary class="panel-head">Tasks with unclassified segments · ${tasks.length} tasks</summary><div class="panel-head"><p>Showing ${Math.min(25, tasks.length)} of ${tasks.length}. Selected dates and dimension filters apply to segments with missing purpose. Narrow the dates or filters to review more tasks.</p><p class="hint">Review the full task history before correcting purpose in task details. Existing classified segments are retained until you make a manual correction; that correction applies to the full owned task.</p></div><div class="table-wrap"><table class="tasks"><thead><tr><th scope="col">Task</th><th scope="col">Agent</th><th scope="col">Project</th><th scope="col">Repository</th><th scope="col">Context</th></tr></thead><tbody>${tasks.slice(0, 25).map(({ entry, partiallyClassified }) => `<tr><td><a href="${escape(taskHref(entry, { ownerScoped: ownerScoped && data.entries.some(other => other.user_id !== entry.user_id && (other.task_id ?? other.id) === (entry.task_id ?? entry.id)) }))}">${escape(entry.description)}</a></td><td>${escape(name(data.users, entry.user_id, 'label'))}</td><td>${escape(name(data.projects, entry.project_id))}</td><td>${escape(entry.repo || '(no repository)')}</td><td>${escape(name(data.activities, entry.activity_id))}${partiallyClassified ? ' · Some segments already classified; review full history.' : ''}</td></tr>`).join('') || '<tr><td colspan="5">No tasks with unclassified segments in this selection.</td></tr>'}</tbody></table></div></details>`;
}

function markup() {
  const range = reportRange(state);
  const options = { ...state, ...range, now: Date.now(), includePurpose, ownerScoped };
  const selected = range.error ? [] : filterReportEntries(data.entries, options);
  const rows = range.error ? [] : summarize(selected, options);
  view = { options, rows };
  const repositories = [...new Set(data.entries.map(entry => entry.repo || null))].sort((a, b) => String(a).localeCompare(String(b)));
  const controls = `<div class="panel-head"><strong>${state.from || state.to ? `${escape(range.from)} – ${escape(range.to)}` : `Week of ${escape(weekStart(state.week).toLocaleDateString())}`}</strong><div class="filters" style="flex-wrap:wrap"><label>Week <input data-report-week type="week" value="${weekValue(weekStart(state.week))}"></label><label>From <input data-report-date="from" type="date" value="${escape(state.from)}"></label><label>To <input data-report-date="to" type="date" value="${escape(state.to)}"></label><button class="action" data-report-csv${range.error ? ' disabled' : ''}>Download CSV</button><button class="action" data-report-raw-csv${range.error ? ' disabled' : ''}>Download raw CSV</button></div><p class="hint">Empty dates use the selected week. Times and dates use your local timezone.</p></div>
    <div class="panel-head filters" style="flex-wrap:wrap">${filterControl('purpose', 'Purpose', [['unclassified', 'Unclassified'], ...purposeChoices])}${filterControl('agent', 'Agent', data.users.map(item => [String(item.id), item.label]))}${filterControl('project', 'Project', data.projects.map(item => [String(item.id), item.name]))}${filterControl('kind', 'Kind', data.activities.map(item => [String(item.id), item.name]))}${filterControl('repo', 'Repository', repositories.map(repo => [JSON.stringify(repo), repo ?? '(no repository)']))}</div>
    <div class="panel-head"><fieldset><legend>Group by</legend>${['purpose', 'agent', 'project', 'kind', 'repo'].map(key => `<label><input data-report-by="${key}" type="checkbox"${state.by.includes(key) ? ' checked' : ''}> ${key}</label>`).join(' ')}</fieldset></div>`;
  if (range.error) return `<section id="reports" class="panel">${controls}<p class="error" role="alert">${escape(range.error)}</p></section>`;
  const headers = state.by;
  const filtered = data.entries.filter(entry => matchesReportDimensions(entry, state));
  // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve the full default trend window and only add bounds for an explicit date selection.
  const trend = weeklySeries(filtered, { end: new Date(`${range.to}T12:00:00`), weeks: 12, now: options.now, ...(state.from || state.to ? range : {}) });
  const gaps = idleGaps(data.entries, { ...range, now: options.now, minMs: 15 * 60000, maxMs: 8 * 3600000 }).filter(gap => !state.agent || String(gap.user_id) === state.agent).reverse().slice(0, 20);
  const attention = needsAttention(data.entries, options.now, options);
  const coverage = reportCoverage(selected, options);
  return `<section id="reports" class="panel">
    ${controls}
    <div class="panel-head"><strong>Work directed toward…</strong><p class="hint">Purpose records intended benefit. Logged agent activity does not establish learning, research progress or income.</p></div>
    <div class="panel-head" data-report-coverage><strong>Data coverage</strong><p>${coverage.segments} overlapping segments · ${coverage.missingRepo} without repository${includePurpose ? ` · ${coverage.unclassified} with unclassified purpose` : ''}</p><p>Segments beginning in range: ${coverage.recordedTokens} with token counters · ${coverage.missingTokens} without token counters · ${coverage.partialTokens} with partial counters · ${coverage.zeroTokens} with zero recorded tokens</p><p class="hint">Missing counters are unknown. Zero refers to recorded counters; token medians include only tasks with recorded counters. Tokens are counted once, in the period when each segment began; duration is clipped to the selected dates.</p><p class="hint">Totals sum recorded fields. Older native Codex cache and reasoning counters may overlap input and output; rows recorded in the exclusive counter format do not.</p></div>
    <div class="table-wrap"><table class="tasks" data-report-summary><thead><tr>${headers.map(key => `<th scope="col">${escape(key)}</th>`).join('')}<th scope="col">Hours</th><th scope="col">Tasks</th><th scope="col">Tokens (in/out/cache)</th><th scope="col">Median task duration</th><th scope="col">Median recorded tokens/task</th><th scope="col">Token coverage</th></tr></thead><tbody>${rows.length ? rows.map(row => `<tr>${headers.map(key => `<td>${escape(key === 'repo' && row.repo == null ? '(no repository)' : label(row, key))}</td>`).join('')}<td>${duration(row.durationMs)}</td><td>${row.tasks}</td><td>${row.coverage.recordedTokens ? `${tokens(row.tokens)} (${tokens(row.input)}/${tokens(row.output)}/${tokens(row.cache)})` : 'n/a'}</td><td>${duration(row.medianDurationMs)}</td><td>${row.coverage.recordedTokens ? tokens(row.medianTokens) : 'n/a'}</td><td>${row.coverage.recordedTokens} recorded · ${row.coverage.missingTokens} missing · ${row.coverage.zeroTokens} zero</td></tr>`).join('') : `<tr><td colspan="${headers.length + 6}">${state.from || state.to ? 'No entries in this date range.' : 'No entries this week.'}</td></tr>`}</tbody></table></div>
    ${unclassifiedReview(options)}
    <div class="panel-head"><strong>12-week trend by kind</strong><p class="hint">${state.from || state.to ? 'Dimension filters and selected dates apply. Only the last 12 weeks ending at To are shown.' : 'Dimension filters apply; the selected week ends this 12-week window.'}</p></div><div class="table-wrap"><table class="tasks"><thead><tr><th scope="col">Kind</th>${trend[0]?.weeks.map(item => `<th scope="col">${item.start.slice(5)}</th>`).join('') || ''}</tr></thead><tbody>${trend.map(row => `<tr><th scope="row">${escape(name(data.activities, row.activity_id))}</th>${row.weeks.map(item => `<td>${duration(item.durationMs)}</td>`).join('')}</tr>`).join('') || '<tr><td>No trend data.</td></tr>'}</tbody></table></div>
    <div class="panel-head"><strong>Needs attention</strong><p class="hint">Current task state, across all dates. Dimension filters apply to the latest segment.</p></div><div class="table-wrap"><table class="tasks"><thead><tr><th scope="col">Task</th><th scope="col">Agent</th><th scope="col">Reason</th></tr></thead><tbody>${attention.map(({ entry, reason }) => `<tr><td><a href="${escape(taskHref(entry, { ownerScoped: ownerScoped && data.entries.some(other => other.user_id !== entry.user_id && (other.task_id ?? other.id) === (entry.task_id ?? entry.id)) }))}">${escape(entry.description)}</a></td><td>${escape(name(data.users, entry.user_id, 'label'))}</td><td>${reason}</td></tr>`).join('') || '<tr><td colspan="3">Nothing needs attention.</td></tr>'}</tbody></table></div>
    <div class="panel-head"><strong>Idle gaps per agent</strong><p class="hint">Selected dates and agent; all projects, kinds and repositories count as work.</p></div><div class="table-wrap"><table class="tasks"><thead><tr><th scope="col">Agent</th><th scope="col">Gap</th><th scope="col">Ended</th></tr></thead><tbody>${gaps.map(gap => `<tr><td>${escape(name(data.users, gap.user_id, 'label'))}</td><td>${duration(gap.durationMs)}</td><td>${escape(new Date(gap.end).toLocaleString())}</td></tr>`).join('') || '<tr><td colspan="3">No idle gaps.</td></tr>'}</tbody></table></div>
  </section>`;
}

export function renderReports(next, options = {}) {
  data = { ...next };
  const modeChanged = includePurpose !== !!options.includePurpose || ownerScoped !== !!options.ownerScoped;
  includePurpose = !!options.includePurpose;
  ownerScoped = !!options.ownerScoped;
  if (globalThis.location || includePurpose || modeChanged) state = reportState(globalThis.location?.hash || '');
  return markup();
}

// These delegated change targets are the report's generated input/select controls.
document.addEventListener('change', /** @param {Event & {target: HTMLInputElement | HTMLSelectElement}} event */ event => {
  if (!event.target.matches('[data-report-by], [data-report-week], [data-report-filter], [data-report-date]')) return;
  const { reportBy, reportFilter, reportDate } = event.target.dataset;
  if (reportBy) state.by = /** @type {HTMLInputElement} */ (event.target).checked ? [...state.by, reportBy] : state.by.filter(key => key !== reportBy);
  if ('reportWeek' in event.target.dataset) state.week = event.target.value;
  if (reportFilter || reportDate) state[reportFilter || reportDate] = event.target.value;
  if (globalThis.location) history.pushState(null, '', formatReportRoute(state, location.hash, { includePurpose }));
  const report = document.querySelector('#reports');
  if (report && data) {
    report.outerHTML = markup();
    const selector = reportBy ? `[data-report-by="${reportBy}"]` : reportFilter ? `[data-report-filter="${reportFilter}"]` : reportDate ? `[data-report-date="${reportDate}"]` : '[data-report-week]';
    /** @type {HTMLInputElement | HTMLSelectElement} */ (document.querySelector(selector))?.focus?.();
  }
});
// CSV actions are buttons; nested HTML targets still support the existing selector check.
document.addEventListener('click', /** @param {MouseEvent & {target: HTMLElement}} event */ event => {
  if (!event.target.matches('[data-report-csv], [data-report-raw-csv]') || !data || !view || view.options.error) return;
  const raw = event.target.dataset?.reportRawCsv !== undefined;
  const headers = [...state.by, 'hours', 'tasks', 'tokens', 'input', 'output', 'cache', 'median task minutes', 'median tokens/task', 'token counters recorded', 'token counters missing', 'zero recorded tokens', 'partial token counters', 'missing repository', ...(includePurpose ? ['unclassified purpose'] : [])];
  const content = raw ? rawReportCsv(data.entries, view.options) : toCsv(headers, view.rows.map(row => state.by.map(key => label(row, key)).concat([row.durationMs / 3600000, row.tasks, row.tokens, row.input, row.output, row.cache, row.medianDurationMs / 60000, row.medianTokens, row.coverage.recordedTokens, row.coverage.missingTokens, row.coverage.zeroTokens, row.coverage.partialTokens, row.coverage.missingRepo, ...(includePurpose ? [row.coverage.unclassified] : [])])));
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' })); link.download = raw ? 'timesheet-segments.csv' : 'timesheet-report.csv'; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href));
});
