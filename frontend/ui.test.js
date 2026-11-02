import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('task details popup uses minimal connected timeline styling', async () => {
  const [app, styles] = await Promise.all([
    readFile(new URL('./app.js', import.meta.url), 'utf8'),
    readFile(new URL('./styles.css', import.meta.url), 'utf8'),
  ]);

  assert.match(app, /class="modal task-detail"/);
  assert.match(styles, /\.task-detail \.modal-head\s*\{[^}]*padding-bottom:\s*var\(--s2\)[^}]*border-bottom:\s*0/s);
  assert.match(styles, /\.task-detail \.modal-body\s*\{[^}]*padding-top:\s*var\(--s2\)/s);
  assert.match(styles, /\.task-detail \.detail-section-label\s*\{[^}]*margin-top:\s*var\(--s6\)/s);
  assert.match(styles, /\.task-detail \.timeline-item\s*\{[^}]*border-bottom:\s*0/s);
  assert.match(styles, /\.task-detail \.timeline-item::before\s*\{[^}]*width:\s*1px[^}]*background:\s*var\(--border\)[^}]*opacity:\s*\.65/s);
  assert.match(styles, /\.task-detail \.timeline-item:first-child::before\s*\{[^}]*top:\s*50%/s);
  assert.match(styles, /\.task-detail \.timeline-item:last-child::before\s*\{[^}]*bottom:\s*50%/s);
});

test('entity bars reuse project breakdown tooltips without chart deletion', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');

  assert.match(app, /const perEntity = state\.users\.map\(u => \{\s*const parts = state\.projects\.map/s);
  assert.match(app, /class="bar-group" role="group" tabindex="0" aria-label=/);
  assert.match(app, /\$\{r\.parts \? `<div class="bar-tooltip"[\s\S]*?\$\{r\.parts\.filter\(x => x\[key\]\)/);
  assert.match(app, /stacked \? r\.parts\.filter/);
  assert.doesNotMatch(app, /class="tooltip-delete"/);
  assert.match(app, /data-delete-project="\$\{p\.id\}"/);
});

test('activity page renders a heatmap grid per entity plus a total', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');

  assert.match(app, /\['activity', 'activity', 'Activity'\]/);
  assert.match(app, /state\.page === 'activity'\s*\?\s*renderActivityPage\(\)/);
  assert.match(app, /const grids = \[\{ label: 'Total', userId: null \}, \.\.\.state\.users\.map/);
  assert.match(app, /class="activity-cell" data-activity-cell data-level="\$\{level\}" tabindex=/);
});

test('agents page is routed from the nav and built on agentActivity', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');

  assert.match(app, /\['agents', 'agents', 'Agents'\]/);
  assert.match(app, /state\.page === 'agents' \? renderAgentsPage\(\)/);
  assert.match(app, /agentActivity\(state\.entries, state\.users\.filter\(u => u\.username !== 'admin'\)/);
});

test('activity heatmaps use one roving-tabindex grid with accessible cells', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');

  assert.match(app, /class="activity-grid" role="grid" aria-label=/);
  assert.match(app, /tabindex="\$\{cellIndex === 0 \? 0 : -1\}" role="gridcell" aria-label="\$\{escapeHtml\(label\)\}"/);
  assert.match(app, /\[data-activity-cell\]/);
  assert.match(app, /\['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'\]/);
});

test('activity cells show an instant styled tooltip on hover, not a native title', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8');

  assert.match(app, /class="activity-tooltip"><strong>\$\{escapeHtml\(formatDay\(d\.toISOString\(\)\)\)\}<\/strong>/);
  assert.doesNotMatch(app, /class="activity-cell" data-level="\$\{level\}"[^>]*title=/);
  assert.match(styles, /\.activity-cell:hover \.activity-tooltip, \.activity-cell:focus-visible \.activity-tooltip \{ opacity: 1/);
});

test('calendar page renders a 24-hour block grid filtered by the entity checkbox row', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');

  assert.match(app, /\['calendar', 'calendar', 'Calendar'\]/);
  assert.match(app, /state\.page === 'calendar' \? renderCalendarPage\(\)/);
  assert.match(app, /const visibleEntries = state\.calendarEntities \? state\.entries\.filter\(e => state\.calendarEntities\.has\(e\.user_id\)\) : state\.entries;/);
  assert.match(app, /const dayColumns = days\.map\(d => packColumns\(visibleEntries\.map\(e => clipToDay\(e, d, now\)\)\.filter\(Boolean\)\)\);/);
  assert.match(app, /data-calendar-entity="\$\{u\.id\}"/);
});

test('calendar blocks route into the existing task detail modal, day headers still drill into Timesheet', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');

  assert.match(app, /const id = escapeHtml\(taskKey\(b\.entry\)\);/);
  assert.match(app, /data-detail="\$\{id\}"/);
  assert.match(app, /class="cal-day-head\$\{key === todayKey \? ' is-today' : ''\}" data-calendar-day="\$\{key\}"/);
  assert.match(app, /location\.hash = `#\/\?date=\$\{el\.dataset\.calendarDay\}`/);
  assert.match(app, /const ranged = state\.dateFilter\s*\?\s*state\.entries\.filter\(e => dayKey\(new Date\(e\.begin\)\) === state\.dateFilter\)/);
  assert.match(app, /data-clear-date/);
});

test('calendar hour height is defined once and published to the gridline CSS', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');

  // One source of truth in JS...
  const declared = app.match(/const CAL_ROW_HEIGHT = (\d+);/);
  assert.ok(declared, 'CAL_ROW_HEIGHT must be declared in app.js');

  // ...published to CSS on the element that sizes the grid...
  assert.match(app, /--cal-row-h:\$\{CAL_ROW_HEIGHT\}px/);
  assert.match(app, /height:\$\{24 \* CAL_ROW_HEIGHT\}px/);

  // ...and consumed by the gridlines, never re-hardcoded.
  assert.match(css, /transparent var\(--cal-row-h[^)]*\)\)/);
  const gridline = css.match(/repeating-linear-gradient\(to bottom[^;]*;/)[0];
  assert.ok(!/transparent \d+px\)/.test(gridline),
    'gridline spacing must come from --cal-row-h, not a hardcoded px value');
});

test('day groups collapse past a preview count, and search bypasses the collapse', async () => {
  const [app, styles] = await Promise.all([
    readFile(new URL('./app.js', import.meta.url), 'utf8'),
    readFile(new URL('./styles.css', import.meta.url), 'utf8'),
  ]);

  assert.match(app, /const DAY_PREVIEW = \d+/);
  assert.match(app, /const collapsible = !state\.search\.trim\(\)/);
  assert.match(app, /const collapsed = collapsible && !expanded && dayTasks\.length > DAY_PREVIEW/);
  assert.match(app, /data-day-toggle="\$\{escapeHtml\(key\)\}" aria-expanded="\$\{expanded\}"/);
  assert.match(app, /state\.expandedDays\.has\(key\) \? state\.expandedDays\.delete\(key\) : state\.expandedDays\.add\(key\)/);
  assert.match(styles, /\.day-more\s*\{/);
});

test('live tick updates elapsed text without re-rendering the page', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');

  assert.match(app, /data-elapsed="\$\{id\}"/);
  assert.match(app, /function tickElapsed\(\) \{[\s\S]*document\.querySelectorAll\('\[data-elapsed\]'\)/);
  assert.match(app, /setInterval\(tickElapsed, 1000\);/);
  assert.doesNotMatch(app, /setInterval\(\(\) => \{[^}]*render\(\);?[^}]*\}, 1000\)/);
});

test('modals expose dialog semantics, trap focus, restore their opener', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');

  assert.match(app, /role="dialog" aria-modal="true" aria-labelledby="modal-title"/);
  assert.match(app, /function trapModalFocus\(event\)/);
  assert.match(app, /modalOpener.*\.focus\(\)/s);
});

test('pulse animation respects reduced-motion preference', async () => {
  const styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8');

  assert.match(styles, /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*animation: pulse 1\.4s infinite/s);
});

test('background reload does not rebuild the DOM while a field is focused', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');

  assert.match(app, /const typingInField = \(\) => \$app\.contains\(document\.activeElement\) && document\.activeElement\.matches\('input, select, textarea'\)/);
  // both the success and the failure path of load() must honor it
  assert.equal(app.match(/if \(!\(silent && typingInField\(\)\)\) render\(\)/g)?.length, 2);
});

test('opening a modal moves focus into it so the focus trap engages', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');

  assert.match(app, /modal\.querySelector\('input, select, button\.close'\)\?\.focus\(\)/);
});

test('stats and charts are open by default above the mobile breakpoint and remember toggling', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');

  assert.match(app, /state\.statsOpen \?\? !matchMedia\('\(max-width: 600px\)'\)\.matches/);
  assert.match(app, /addEventListener\('toggle'/);
});

test('new tasks and favorites select a work kind, defaulting to Assigned Task', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');

  assert.match(app, /<label>Kind<select name="activity" required>/);
  assert.match(app, /data-recommended-activity="\$\{t\.id\}"/);
  assert.match(app, /a\.name === 'Assigned Task' \? ' selected' : ''/);
  assert.match(app, /activity:Number\(data\.get\('activity'\)\)/);
  assert.match(app, /activity: Number\(el\.parentElement\.querySelector\('\[data-recommended-activity\]'\)\.value\)/);
});

test('task details show the selected work kind', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');

  assert.match(app, /const activity = state\.activities\.find\(item => item\.id === task\.segments\.at\(-1\)\.activity_id\);/);
  assert.match(app, /\$\{escapeHtml\(activity\?\.name \|\| 'Assigned Task'\)\}/);
});

test('reports page has its own header instead of the timesheet filters', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');

  assert.match(app, /state\.page === 'reports'\) return `<header class="topbar"><h1>Reports<\/h1><\/header>`/);
});
