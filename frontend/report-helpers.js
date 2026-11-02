import { formatRoute, taskIdentity } from './helpers.js';

/** @typedef {{from?: string | number | Date, to?: string | number | Date}} ReportDates */
/** @typedef {{week?: string, from?: string, to?: string}} ReportDateSelection */
/** @typedef {{week: string, from: string, to: string, agent: string, project: string, kind: string, repo: string, purpose?: string, by: string[]}} ReportRoute */
/** @typedef {{purpose: string | null, agent: number, project: number, kind: number, repo: string | null}} ReportDimensions */

const dayMs = 86400000;
const dimensions = ['agent', 'project', 'kind', 'repo'];
const purposeDimensions = ['purpose', ...dimensions];
const tokenFields = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
const reportTaskKey = (entry, ownerScoped = false) => ownerScoped ? taskIdentity(entry) : JSON.stringify([entry.user_id, entry.task_id == null ? 'entry' : 'task', entry.task_id ?? entry.id]);
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const ms = value => new Date(value).getTime();
const localDay = value => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Date/number callers and URL date strings require distinct parsing paths.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : new Date(NaN);
  }
  return new Date(value);
};
const dayStart = value => {
  const result = localDay(value);
  result.setHours(0, 0, 0, 0);
  return result.getTime();
};
const dayEnd = value => {
  if (!value) return Infinity;
  const result = new Date(dayStart(value));
  result.setDate(result.getDate() + 1);
  return result.getTime() - 1;
};
/** @param {{begin: string}} entry
 * @param {ReportDates} range */
const inRange = (entry, { from, to }) => ms(entry.begin) >= (from ? dayStart(from) : -Infinity) && ms(entry.begin) <= dayEnd(to);
const tokens = entry => (entry.tokens_input ?? 0) + (entry.tokens_output ?? 0) + (entry.tokens_reasoning ?? 0) + (entry.tokens_cache_read ?? 0) + (entry.tokens_cache_write ?? 0);
const sunday = date => {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  result.setDate(result.getDate() - result.getDay());
  return result;
};
const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const durationMs = (entry, now) => Math.max(0, ms(entry.end === null ? now : entry.end ?? entry.begin) - ms(entry.begin));
/** @param {ReportDates} range */
const bounds = ({ from, to }) => [from ? dayStart(from) : -Infinity, to ? dayEnd(to) + 1 : Infinity];
const overlap = (entry, start, end, now) => Math.max(0, Math.min(ms(entry.end === null ? now : entry.end ?? entry.begin), end) - Math.max(ms(entry.begin), start));

export function overlapDurationMs(entry, options = {}) {
  return overlap(entry, ...bounds(options), options.now ?? Date.now());
}

export const matchesReportDimensions = (entry, options) => (!options.agent || String(entry.user_id) === options.agent)
  && (!options.project || String(entry.project_id) === options.project)
  && (!options.kind || String(entry.activity_id) === options.kind)
  && (!options.purpose || (entry.purpose ?? 'unclassified') === options.purpose)
  && (!options.repo || JSON.stringify(entry.repo || null) === options.repo);

export function filterReportEntries(entries, options = {}) {
  const [start, end] = bounds(options), now = options.now ?? Date.now();
  return entries.filter(entry => matchesReportDimensions(entry, options)
    && (overlap(entry, start, end, now) > 0 || ms(entry.begin) >= start && ms(entry.begin) < end && durationMs(entry, now) === 0));
}

/** @param {ReportDateSelection} selection */
export function reportRange({ week, from = '', to = '' }, now = Date.now()) {
  const start = weekStart(week, now), end = new Date(start); end.setDate(end.getDate() + 6);
  from ||= dateKey(start); to ||= dateKey(end);
  const valid = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(dayStart(value));
  const error = !valid(from) || !valid(to) ? 'Enter valid From and To dates.' : from > to ? 'From date must not be after To date.' : '';
  return { from, to, error };
}

/** @returns {ReportRoute} */
export function parseReportRoute(hash) {
  const params = new URL(hash.replace(/^#/, '') || '/reports', 'https://timesheet.local').searchParams;
  // The fixed date/dimension key list supplies every route string field.
  return {
    .../** @type {Omit<ReportRoute, 'by' | 'purpose'>} */ (Object.fromEntries(['week', 'from', 'to', ...dimensions].map(key => [key, params.get(`report_${key}`) || '']))),
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve omission of purpose in legacy route round trips during this type-only change.
    ...(params.has('report_purpose') ? { purpose: params.get('report_purpose') || '' } : {}),
    by: params.has('report_by') ? [...new Set(params.get('report_by').split(',').filter(key => purposeDimensions.includes(key)))] : [...dimensions],
  };
}

export function formatReportRoute(state, hash = '', options = {}) {
  const params = new URL(hash.replace(/^#/, '') || '/reports', 'https://timesheet.local').searchParams;
  for (const key of ['week', 'from', 'to', 'by', ...purposeDimensions]) params.delete(`report_${key}`);
  for (const key of ['week', 'from', 'to', ...purposeDimensions]) if (state[key]) params.set(`report_${key}`, state[key]);
  if (options.includePurpose || state.by.join(',') !== dimensions.join(',')) params.set('report_by', state.by.join(','));
  return `#/reports${params.size ? `?${params}` : ''}`;
}

export function reportCoverage(entries, options = {}) {
  const begun = entries.filter(entry => inRange(entry, options));
  return {
    segments: entries.length,
    // Existing callers retain their coverage contract; the purpose UI opts in.
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Legacy coverage objects omit this property unless the caller opts in.
    ...(options.includePurpose ? { unclassified: entries.filter(entry => entry.purpose == null).length } : {}),
    missingRepo: entries.filter(entry => !entry.repo).length,
    recordedTokens: begun.filter(entry => tokenFields.some(key => entry[key] != null)).length,
    missingTokens: begun.filter(entry => tokenFields.every(key => entry[key] == null)).length,
    partialTokens: begun.filter(entry => tokenFields.some(key => entry[key] == null) && tokenFields.some(key => entry[key] != null)).length,
    zeroTokens: begun.filter(entry => tokenFields.some(key => entry[key] != null) && tokens(entry) === 0).length,
  };
}

export function rawReportCsv(entries, options = {}) {
  const fields = ['id', 'task_id', 'user_id', 'project_id', 'activity_id', 'repo', 'description', 'begin', 'end', 'end_reason', 'auto_closed', ...tokenFields];
  return toCsv([...fields, 'overlap_hours', ...(options.includePurpose ? ['purpose'] : [])], filterReportEntries(entries, options).map(entry => [...fields.map(key => entry[key]), overlapDurationMs(entry, options) / 3600000, ...(options.includePurpose ? [entry.purpose ?? null] : [])]));
}

export function weekStart(value, now = Date.now()) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Non-string week inputs must retain the existing fallback before regex parsing.
  const match = typeof value === 'string' && /^(\d{4})-W(0[1-9]|[1-4]\d|5[0-3])$/.exec(value);
  if (!match) return sunday(now);
  const [year, number] = match.slice(1).map(Number);
  const jan4 = new Date(year, 0, 4);
  return new Date(year, 0, 3 - ((jan4.getDay() + 6) % 7) + (number - 1) * 7);
}

export function weekValue(date) {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  const thursday = new Date(monday); thursday.setDate(thursday.getDate() + 3 - ((thursday.getDay() + 6) % 7));
  const jan4 = new Date(thursday.getFullYear(), 0, 4);
  const firstMonday = new Date(jan4); firstMonday.setDate(firstMonday.getDate() - ((firstMonday.getDay() + 6) % 7));
  return `${thursday.getFullYear()}-W${String(1 + Math.round((monday.getTime() - firstMonday.getTime()) / 604800000)).padStart(2, '0')}`;
}

export const taskHref = (entry, { ownerScoped = false } = {}) => formatRoute({ page: 'timesheet', modal: ownerScoped ? taskIdentity(entry) : String(entry.task_id ?? entry.id) });

export function summarize(entries, options = {}) {
  const by = options.by ?? dimensions;
  const groups = new Map();
  for (const entry of filterReportEntries(entries, options)) {
    const values = { purpose: entry.purpose ?? null, agent: entry.user_id, project: entry.project_id, kind: entry.activity_id, repo: entry.repo || null };
    const key = JSON.stringify(by.map(name => values[name]));
    if (!groups.has(key)) groups.set(key, { values, entries: [] });
    groups.get(key).entries.push(entry);
  }
  return [...groups.values()].map(({ values, entries: group }) => {
    const tasks = new Map();
    for (const entry of group) {
      const key = reportTaskKey(entry, options.ownerScoped);
      if (!tasks.has(key)) tasks.set(key, []);
      tasks.get(key).push(entry);
    }
    const taskRows = [...tasks.values()].map(parts => ({
      durationMs: parts.reduce((sum, entry) => sum + overlapDurationMs(entry, options), 0),
      tokens: parts.filter(entry => inRange(entry, options)).reduce((sum, entry) => sum + tokens(entry), 0),
      recorded: parts.some(entry => inRange(entry, options) && tokenFields.some(key => entry[key] != null)),
    }));
    // oxlint-disable-next-line anti-slop/no-array-filter-map -- Preserve the audited recorded-only median calculation in this type-only change.
    const recordedTaskTokens = taskRows.filter(task => task.recorded).map(task => task.tokens);
    const begun = group.filter(entry => inRange(entry, options));
    const input = begun.reduce((sum, entry) => sum + (entry.tokens_input ?? 0), 0);
    const output = begun.reduce((sum, entry) => sum + (entry.tokens_output ?? 0) + (entry.tokens_reasoning ?? 0), 0);
    const cache = begun.reduce((sum, entry) => sum + (entry.tokens_cache_read ?? 0) + (entry.tokens_cache_write ?? 0), 0);
    // Only the selected grouping dimensions are present in each summary row.
    return {
      .../** @type {Partial<ReportDimensions>} */ (Object.fromEntries(by.map(name => [name, values[name]]))), tasks: taskRows.length,
      durationMs: taskRows.reduce((sum, task) => sum + task.durationMs, 0), tokens: input + output + cache, input, output, cache,
      medianDurationMs: median(taskRows.map(task => task.durationMs)), medianTokens: recordedTaskTokens.length ? median(recordedTaskTokens) : 0,
      coverage: reportCoverage(group, options),
    };
  }).sort((a, b) => by.map(name => String(a[name]).localeCompare(String(b[name]))).find(Boolean) || 0);
}

/** @param {{activity_id: number, begin: string, end?: string | null}[]} entries
 * @param {ReportDates & {end?: Date, weeks?: number, now?: number}} options */
export function weeklySeries(entries, { end = new Date(), weeks = 12, now = Date.now(), from, to } = {}) {
  const last = sunday(end);
  const starts = Array.from({ length: weeks }, (_, index) => {
    const start = new Date(last);
    start.setDate(start.getDate() - (weeks - index - 1) * 7);
    return start;
  });
  const [rangeStart, rangeEnd] = bounds({ from, to });
  const kinds = new Map();
  for (const entry of entries) {
    starts.forEach((start, index) => {
      const stop = new Date(start); stop.setDate(stop.getDate() + 7);
      const duration = overlap(entry, Math.max(start.getTime(), rangeStart), Math.min(stop.getTime(), rangeEnd), now);
      if (!(duration > 0)) return;
      const id = entry.activity_id;
      if (!kinds.has(id)) kinds.set(id, Array(weeks).fill(0));
      kinds.get(id)[index] += duration;
    });
  }
  return [...kinds].sort(([a], [b]) => Number(a) - Number(b)).map(([activity_id, durations]) => ({
    activity_id, weeks: starts.map((start, index) => ({ start: dateKey(start), durationMs: durations[index] })),
  }));
}

/** @param {{user_id: number, begin: string, end?: string | null}[]} entries
 * @param {ReportDates & {minMs?: number, maxMs?: number, now?: number}} options */
export function idleGaps(entries, { from, to, minMs = 0, maxMs = Infinity, now = Date.now() } = {}) {
  const gaps = [];
  const users = new Map();
  for (const entry of entries) {
    const begin = ms(entry.begin), end = entry.end === null ? Math.max(begin, now) : ms(entry.end);
    if (!Number.isFinite(begin) || !Number.isFinite(end)) continue;
    if (!users.has(entry.user_id)) users.set(entry.user_id, []);
    users.get(entry.user_id).push({ entry, begin, end });
  }
  for (const [user_id, own] of users) {
    const sorted = own.sort((a, b) => a.begin - b.begin);
    let lastEnd = -Infinity;
    for (const { entry, begin, end } of sorted) {
      const durationMs = begin - lastEnd;
      if (begin > lastEnd && lastEnd > -Infinity && lastEnd >= (from ? dayStart(from) : -Infinity) && begin <= dayEnd(to) && durationMs >= minMs && durationMs <= maxMs) gaps.push({ user_id, begin: new Date(lastEnd).toISOString(), end: entry.begin, durationMs });
      lastEnd = Math.max(lastEnd, end);
    }
  }
  return gaps.sort((a, b) => ms(a.begin) - ms(b.begin));
}

function latestSegments(entries, ownerScoped = false) {
  const tasks = new Map();
  for (const entry of entries) {
    const key = reportTaskKey(entry, ownerScoped), last = tasks.get(key);
    if (!last || ms(entry.begin) > ms(last.begin) || ms(entry.begin) === ms(last.begin) && entry.id > last.id) tasks.set(key, entry);
  }
  return [...tasks.values()];
}

export function unclassifiedTasks(entries, options = {}) {
  const classified = new Set(entries.filter(entry => entry.purpose != null).map(entry => reportTaskKey(entry, options.ownerScoped)));
  const missing = filterReportEntries(entries, options).filter(entry => entry.purpose == null);
  return latestSegments(missing, options.ownerScoped)
    .sort((a, b) => ms(b.begin) - ms(a.begin) || b.id - a.id)
    .map(entry => ({ entry, partiallyClassified: classified.has(reportTaskKey(entry, options.ownerScoped)) }));
}

export function longRunning(entries, now = Date.now(), options = {}) {
  return latestSegments(entries, options.ownerScoped).filter(entry => entry.end === null
    ? now - ms(entry.begin) > 4 * 3600000
    : entry.end_reason === 'paused' && now - ms(entry.end) > 24 * 3600000);
}

export function needsAttention(entries, now = Date.now(), filters = {}) {
  const current = latestSegments(entries, filters.ownerScoped).filter(entry => matchesReportDimensions(entry, filters));
  const auto = current.filter(entry => (entry.auto_closed || entry.end_reason === 'auto') && now >= ms(entry.end) && now - ms(entry.end) <= 14 * dayMs)
    .sort((a, b) => ms(b.end) - ms(a.end)).slice(0, 25).map(entry => ({ entry, reason: 'auto-closed' }));
  return [...auto, ...longRunning(current, now, filters).map(entry => ({ entry, reason: entry.end === null ? 'running >4h' : 'paused >24h' }))];
}

export function toCsv(headers, rows) {
  const escape = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const cell = value => {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- CSV formula escaping applies to strings; numeric negatives must retain their values.
    const text = typeof value === 'string' && /^[=+\-@\t\r\n]/.test(value) ? `'${value}` : String(value ?? '');
    return /[",\r\n]/.test(text) ? escape(text) : text;
  };
  return [headers, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
