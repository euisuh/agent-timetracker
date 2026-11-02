import test from 'node:test';
import assert from 'node:assert/strict';
import { packCalendarColumns, packColumns } from './helpers.js';

test('calendar short-task footprints use distinct columns without changing actual intervals', () => {
  const rows = [{ startMin: 540, endMin: 541 }, { startMin: 542, endMin: 543 }];
  const original = structuredClone(rows);
  const packed = packCalendarColumns(rows, 21.6);
  assert.deepEqual(packed.map(row => [row.col, row.columns, row.startMin, row.endMin]), [[0, 2, 540, 541], [1, 2, 542, 543]]);
  assert.equal(packed[0].displayEndMin, 561.6);
  assert.deepEqual(rows, original);
  assert.equal(packColumns(rows).maxColumns, 1);
});

test('calendar overlap widths are local to a cluster and retain real overlap packing', () => {
  const packed = packCalendarColumns([{ startMin: 60, endMin: 120 }, { startMin: 70, endMin: 130 }, { startMin: 240, endMin: 300 }], 21.6);
  assert.deepEqual(packed.map(row => [row.col, row.columns]), [[0, 2], [1, 2], [0, 1]]);
  assert.equal(packColumns([{ startMin: 60, endMin: 120 }, { startMin: 70, endMin: 130 }, { startMin: 240, endMin: 300 }]).maxColumns, 2);
});

test('calendar display footprints stay within midnight at the true task start', () => {
  const packed = packCalendarColumns([{ startMin: 1437, endMin: 1438 }, { startMin: 1439, endMin: 1440 }], 21.6);
  assert.deepEqual(packed.map(row => [row.startMin, row.endMin, row.displayEndMin, row.col]), [[1437, 1438, 1440, 0], [1439, 1440, 1440, 1]]);
});

test('calendar packing never shortens a real interval beyond the nominal 24-hour axis', () => {
  const [block] = packCalendarColumns([{ startMin: 1470, endMin: 1500 }], 21.6);
  assert.equal(block.displayEndMin, 1500);
  assert.equal(block.endMin, 1500);
  assert.ok(block.displayEndMin > block.startMin);
});
