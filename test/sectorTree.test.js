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

// Regression: the real bug (fixed at the DB layer in schema.sql) was
// duplicate ROWS with different ids and the same name — e.g. a corrupted
// /api/sectors response returning two distinct '식용유지' root rows. These
// must NOT be merged by buildSectorMaps: they are legitimately different
// nodes and both must remain selectable/navigable by their own id.
test('buildSectorMaps: does not merge distinct ids that share a display name', () => {
  const corrupted = [
    { id: 1, name: '식용유지', parent_id: null },
    { id: 34, name: '식용유지', parent_id: null }, // different id, same label — real duplicate row from the old bug
    { id: 3, name: '팜유', parent_id: 1 },
    { id: 41, name: '팜유', parent_id: 34 },
  ];
  const { byParent, byId } = buildSectorMaps(corrupted);
  assert.equal(byParent.get(null).length, 2, 'both distinct root ids must still be present');
  assert.equal(byId.size, 4);
  assert.equal(byParent.get(1).length, 1);
  assert.equal(byParent.get(34).length, 1);
});

// Regression: identity is the id, never the array position or the label. A
// literal duplicate ROW (exact same id appearing twice in the API response,
// e.g. from a bad JOIN) must be deduped, since it is not a new node.
test('buildSectorMaps: dedupes an exact-id duplicate row instead of double-counting it', () => {
  const withRepeatedRow = [
    { id: 1, name: '식용유지', parent_id: null },
    { id: 1, name: '식용유지', parent_id: null }, // same row served twice
    { id: 3, name: '팜유', parent_id: 1 },
  ];
  const { byParent, byId } = buildSectorMaps(withRepeatedRow);
  assert.equal(byId.size, 2);
  assert.equal(byParent.get(null).length, 1);
});
