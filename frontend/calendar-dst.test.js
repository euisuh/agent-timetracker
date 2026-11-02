import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const inZone = (zone, body) => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { clipToDay, groupByDay, wallClockBlocks, packCalendarColumns } from './helpers.js';
    const wall = (day, begin, end) => {
      const entry = { begin, end }, clipped = clipToDay(entry, day);
      const before = structuredClone(clipped);
      const [block] = wallClockBlocks([clipped], day);
      assert.deepEqual(clipped, before);
      assert.equal(block.entry, entry);
      return [block.startMin, block.endMin, block.clipStartMin, block.clipEndMin].map(value => Math.round(value * 1000) / 1000);
    };
    ${body}
  `], { cwd: new URL('.', import.meta.url), env: { ...process.env, TZ: zone }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};

test('spring clock positions preserve the clipped elapsed interval', () => inZone('America/New_York', `
  const d = new Date(2026, 2, 8);
  assert.deepEqual(wall(d, '2026-03-08T12:00:00-04:00', '2026-03-08T13:00:00-04:00'), [720, 780, 660, 720]);
  assert.deepEqual(wall(d, '2026-03-08T01:30:00-05:00', '2026-03-08T03:30:00-04:00'), [90, 210, 90, 150]);
  assert.deepEqual(wall(d, '2026-03-08T23:30:00-04:00', '2026-03-09T00:00:00-04:00'), [1410, 1440, 1350, 1380]);
`));

test('fall repeated hour keeps positive envelopes and late work within the clock axis', () => inZone('America/New_York', `
  const d = new Date(2026, 10, 1);
  for (const [begin, end, expected] of [
    ['23:30:00-05:00', 'next', [1410, 1440, 1470, 1500]],
    ['01:10:00-04:00', '01:40:00-04:00', [70, 100, 70, 100]],
    ['01:10:00-05:00', '01:40:00-05:00', [70, 100, 130, 160]],
    ['00:30:00-04:00', '01:10:00-05:00', [30, 120, 30, 130]],
    ['01:30:00-04:00', '01:10:00-05:00', [60, 120, 90, 130]],
    ['01:00:00-04:00', '01:00:00-05:00', [60, 120, 60, 120]],
    ['00:00:00-04:00', 'next', [0, 1440, 0, 1500]],
  ]) assert.deepEqual(wall(d, '2026-11-01T' + begin, end === 'next' ? '2026-11-02T00:00:00-05:00' : '2026-11-01T' + end), expected);
`));

test('midnight DST boundaries do not leak into the next local day', () => inZone('America/Havana', `
  const spring = new Date(2026, 2, 8), next = new Date(2026, 2, 9);
  assert.deepEqual(wall(spring, spring.toISOString(), next.toISOString()), [60, 1440, 0, 1380]);
  assert.equal(clipToDay({ begin: next.toISOString(), end: new Date(2026, 2, 9, 0, 30).toISOString() }, spring), null);
  assert.deepEqual(wall(new Date(2026, 2, 7), '2026-03-07T23:30:00-05:00', spring.toISOString()), [1410, 1440, 1410, 1440]);
  const entry = { begin: '2026-03-08T23:30:00-04:00', end: '2026-03-09T00:30:00-04:00' };
  assert.deepEqual([...groupByDay([entry], null, next.getTime() + 3600000)], [['2026-03-08', 1800000], ['2026-03-09', 1800000]]);
  const fall = new Date(2026, 10, 1);
  assert.deepEqual(wall(fall, fall.toISOString(), new Date(2026, 10, 2).toISOString()), [0, 1440, 0, 1500]);
  const clips = ['-04:00', '-05:00'].map(offset => clipToDay({ begin: '2026-11-01T00:10:00' + offset, end: '2026-11-01T00:40:00' + offset }, fall));
  assert.deepEqual(packCalendarColumns(wallClockBlocks(clips, fall), 21.6).map(b => [b.col, b.columns]), [[0, 2], [1, 2]]);
`));

test('DST day sweeps preserve positive wall envelopes and elapsed metadata', () => {
  for (const [zone, days] of [
    ['America/New_York', [[2, 8], [10, 1]]],
    ['America/Havana', [[2, 7], [2, 8], [2, 9], [10, 1]]],
    ['Australia/Lord_Howe', [[3, 5], [9, 4]]],
  ]) inZone(zone, `
    for (const [month, date] of ${JSON.stringify(days)}) {
      const d = new Date(2026, month, date), next = new Date(2026, month, date + 1), minutes = (next - d) / 60000;
      for (let m = -60; m < minutes + 60; m += 5) for (const duration of [1, 15, 60, 120, 600]) {
        const clipped = clipToDay({ begin: new Date(d.getTime() + m * 60000).toISOString(), end: new Date(d.getTime() + (m + duration) * 60000).toISOString() }, d);
        if (!clipped) continue;
        const [block] = wallClockBlocks([clipped], d);
        assert.ok(block.startMin >= 0 && block.endMin <= 1440 + 1e-6 && block.endMin > block.startMin, JSON.stringify(block));
        assert.equal(block.clipStartMin, clipped.startMin);
        assert.equal(block.clipEndMin, clipped.endMin);
      }
    }
  `);
});

test('ordinary Seoul clock geometry is unchanged', () => inZone('Asia/Seoul', `
  assert.deepEqual(wall(new Date(2026, 2, 8), '2026-03-08T12:00:00+09:00', '2026-03-08T13:00:00+09:00'), [720, 780, 720, 780]);
`));
