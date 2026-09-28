const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSectorMaps, sectorAncestryPath, buildColumns } = require('../public/sectorTree');

// Mirrors the shape of GET /api/sectors: 2-level MECE tree, but the helpers
// must not assume any fixed depth.
const sectors = [
  { id: 1, name: '식용유지', parent_id: null },
  { id: 2, name: '비식용유지', parent_id: null },
  { id: 3, name: '팜유', parent_id: 1 },
  { id: 4, name: '대두유', parent_id: 1 },
  { id: 5, name: '유채씨유', parent_id: 1 },
  { id: 6, name: 'UCO', parent_id: 2 },
  { id: 7, name: 'SAF', parent_id: 2 },
];

test('buildSectorMaps groups children by parent_id, roots under null', () => {
  const { byParent, byId } = buildSectorMaps(sectors);
  assert.equal(byParent.get(null).length, 2);
  assert.deepEqual(byParent.get(null).map((s) => s.name), ['식용유지', '비식용유지']);
  assert.equal(byParent.get(1).length, 3);
  assert.equal(byId.get(3).name, '팜유');
});

test('sectorAncestryPath walks root -> leaf', () => {
  const { byId } = buildSectorMaps(sectors);
  assert.deepEqual(sectorAncestryPath(byId, 3), [1, 3]);
  assert.deepEqual(sectorAncestryPath(byId, 1), [1]);
});

test('buildColumns: root categories always render as column 0', () => {
  const { byParent } = buildSectorMaps(sectors);
  const columns = buildColumns(byParent, []);
  assert.equal(columns.length, 1);
  assert.deepEqual(columns[0].nodes.map((s) => s.id), [1, 2]);
});

test('buildColumns: selecting/navigating a root exposes its children in column 1', () => {
  const { byParent } = buildSectorMaps(sectors);
  const columns = buildColumns(byParent, [1]);
  assert.equal(columns.length, 2);
  assert.deepEqual(columns[1].nodes.map((s) => s.id), [3, 4, 5]);
});

test('buildColumns: deeper levels render correctly when a level-1 node is active', () => {
  const { byParent } = buildSectorMaps(sectors);
  const columns = buildColumns(byParent, [2]);
  assert.equal(columns.length, 2);
  assert.deepEqual(columns[1].nodes.map((s) => s.id), [6, 7]);
});

test('buildColumns: navigating into a leaf node does not create an empty column', () => {
  const { byParent } = buildSectorMaps(sectors);
  // 3 ('팜유') has no children.
  const columns = buildColumns(byParent, [1, 3]);
  assert.equal(columns.length, 2);
  assert.equal(columns[columns.length - 1].nodes.some((s) => s.id === 3), true);
});

test('buildColumns: switching to a different root truncates and replaces later columns', () => {
  const { byParent } = buildSectorMaps(sectors);
  let activePath = [1, 3]; // drilled into 식용유지 > 팜유
  activePath = activePath.slice(0, 0);
  activePath[0] = 2; // navigate to 비식용유지 instead
  const columns = buildColumns(byParent, activePath);
  assert.equal(columns.length, 2);
  assert.deepEqual(columns[1].nodes.map((s) => s.id), [6, 7]);
});

test('multi-select: selected ids across branches stay unique via Set semantics', () => {
  const selected = new Set();
  selected.add(3); // 식용유지 > 팜유
  selected.add(6); // 비식용유지 > UCO
  selected.add(3); // re-select same node (e.g. re-checking) must not duplicate
  assert.deepEqual([...selected], [3, 6]);
  assert.equal([...selected].join(','), '3,6');
});
