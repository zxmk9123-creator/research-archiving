// Pure helpers for the hierarchical sector tree filter. No DOM dependency,
// so this same file is used by the browser (via <script>) and by node:test.
(function (root, factory) {
  const exported = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else {
    root.SectorTree = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Derives parent->children groupings and an id->node index from the flat
  // sectors list (id, name, parent_id) returned by GET /api/sectors. This is
  // the taxonomy's single source of truth, reshaped — no separate copy.
  function buildSectorMaps(sectors) {
    const byParent = new Map();
    const byId = new Map();
    for (const s of sectors) {
      byId.set(s.id, s);
      const key = s.parent_id ?? null;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(s);
    }
    return { byParent, byId };
  }

  // Ids from root down to (and including) `id`, by walking parent_id.
  function sectorAncestryPath(byId, id) {
    const path = [];
    let cur = byId.get(Number(id));
    while (cur) {
      path.unshift(cur.id);
      cur = cur.parent_id ? byId.get(cur.parent_id) : null;
    }
    return path;
  }

  // Builds the column layout renderTree() draws: column 0 is always the
  // roots; each subsequent column is the children of activePath[level], and
  // stops (no empty column) once a node has no children.
  function buildColumns(byParent, activePath) {
    const columns = [];
    let levelNodes = byParent.get(null) || [];
    let level = 0;
    while (levelNodes && levelNodes.length) {
      columns.push({ level, nodes: levelNodes });
      const activeId = activePath[level];
      if (activeId === undefined) break;
      levelNodes = byParent.get(activeId) || [];
      level++;
    }
    return columns;
  }

  return { buildSectorMaps, sectorAncestryPath, buildColumns };
});
