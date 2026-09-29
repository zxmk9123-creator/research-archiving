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
  //
  // Identity is always the stable id, never array index or name: a row whose
  // id repeats in the input (e.g. an upstream join returning it twice) is
  // deduped here; two different ids that happen to share a display name are
  // NOT merged — they are legitimately distinct nodes.
  function buildSectorMaps(sectors) {
    const byParent = new Map();
    const byId = new Map();
    for (const s of sectors) {
      if (byId.has(s.id)) continue;
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

  // All ids in the subtree rooted at `id`, including `id` itself.
  function collectSubtreeIds(byParent, id) {
    const ids = [id];
    for (const child of byParent.get(id) || []) {
      ids.push(...collectSubtreeIds(byParent, child.id));
    }
    return ids;
  }

  // Cascading checkbox state for a node, derived purely from which ids in
  // its subtree (itself + all descendants) are in selectedSectorIds — no
  // separate "parent selected" flag to keep in sync.
  function getSectorCheckState(byParent, id, selectedSectorIds) {
    const ids = collectSubtreeIds(byParent, id);
    const selectedCount = ids.filter((i) => selectedSectorIds.has(i)).length;
    if (selectedCount === 0) return 'unchecked';
    if (selectedCount === ids.length) return 'checked';
    return 'indeterminate';
  }

  // Selects/deselects a node and its entire subtree in one go (mutates the
  // Set in place, same identity the caller already holds).
  function setSectorSelection(byParent, selectedSectorIds, id, selected) {
    for (const i of collectSubtreeIds(byParent, id)) {
      if (selected) selectedSectorIds.add(i);
      else selectedSectorIds.delete(i);
    }
  }

  return {
    buildSectorMaps,
    sectorAncestryPath,
    buildColumns,
    collectSubtreeIds,
    getSectorCheckState,
    setSectorSelection,
  };
});
