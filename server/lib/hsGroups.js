// Items that the tariff only separates BELOW the 6-digit subheading (or only by name), so a plain HS prefix cannot select them:
//   유채유 vs 겨자유 (HS 1514: the Korean 10-digit codes say "유채유" / "겨자유"), 해바라기유 vs 홍화유(잇꽃유) (HS 1512.11/.19), 면실유 (HS 1512.2x).
// A group is a rule over the 10-digit catalog (name and code), resolved to the list of 10-digit codes that currently match, so a code added later
// by a tariff revision joins the right group by its name. Each group says what is available where the data is coarser:
//   country: the HS6 subheadings whose partner-country rows can stand in for it (null = cannot be separated, so no country breakdown),
//   comtrade: the HS6 codes UN Comtrade can query for it (null = cannot be separated there).
const GROUPS = [
  {
    id: 'RAPESEED', name: '유채유', parent: '1514', aliases: ['유채유', '카놀라유', '카놀라', '채종유', '유채', 'rapeseed oil', 'canola oil'],
    rule: { under: '1514', nameLike: '%유채%', hs6In: ['151411', '151419'] },
    country: { hs6: ['151411', '151419'], note: '국가별은 저에루크산 유채유(소호 1514.11·1514.19) 기준입니다. 겨자유와 섞인 소호는 제외했습니다.' },
    comtrade: { cmds: ['151411', '151419'], note: '저에루크산 유채유(HS 1514.11·1514.19) 기준입니다. 겨자유와 섞인 소호(1514.91·1514.99)는 포함하지 않습니다.' },
  },
  {
    id: 'MUSTARD', name: '겨자유', parent: '1514', aliases: ['겨자유', '머스터드유', 'mustard oil'],
    rule: { under: '1514', nameLike: '%겨자%' },
    country: null, comtrade: null,
    countryNote: '겨자유는 유채유와 같은 소호(HS 6자리)에 묶여 있어 국가별로는 나눌 수 없습니다.',
  },
  {
    id: 'SUNFLOWER', name: '해바라기유', parent: '1512', aliases: ['해바라기유', '해바라기씨유', '해바라기', 'sunflower oil'],
    rule: { under: '1512', nameLike: '%해바라기%' },
    country: { hs6: ['151211', '151219'], note: '국가별은 해바라기유·홍화유가 함께 집계된 소호(1512.11·1512.19) 기준입니다(홍화유 비중은 매우 작습니다).' },
    comtrade: { cmds: ['151211', '151219'], note: 'HS 6자리에서는 해바라기유와 홍화유가 한 소호(1512.11·1512.19)로 묶여 있어 홍화유가 함께 집계됩니다.' },
  },
  {
    id: 'SAFFLOWER', name: '홍화유(잇꽃유)', parent: '1512', aliases: ['홍화유', '잇꽃유', '잇꽃', '홍화', 'safflower oil'],
    rule: { under: '1512', nameLike: '%잇꽃%' },
    country: null, comtrade: null,
    countryNote: '홍화유는 해바라기유와 같은 소호(HS 6자리)에 묶여 있어 국가별로는 나눌 수 없습니다.',
  },
  {
    id: 'COTTONSEED', name: '면실유', parent: '1512', aliases: ['면실유', '목화씨유', '면화씨유', 'cottonseed oil'],
    rule: { under: '1512', prefix: '15122' },
    country: { hs6: ['151221', '151229'], note: '' },
    comtrade: { cmds: ['151221', '151229'], note: '' },
  },
];
const BY_ID = new Map(GROUPS.map((g) => [g.id, g]));
const groupById = (id) => BY_ID.get(String(id)) || null;
const isGroupId = (id) => BY_ID.has(String(id));
const groupsUnder = (heading) => GROUPS.filter((g) => g.parent === heading);

// The 10-digit codes a group currently contains (cached for a few minutes: the catalog only changes when the sync adds items).
const cache = new Map();
async function groupCodes(db, g) {
  const hit = cache.get(g.id);
  if (hit && Date.now() - hit.at < 600000) return hit.codes;
  const r = g.rule;
  const { rows } = await db.query(
    `SELECT hs_code FROM hs_catalog WHERE length(hs_code) = 10 AND hs_code LIKE $1
       AND (($2::text IS NOT NULL AND name LIKE $2) OR left(hs_code, 6) = ANY($3::text[]) OR ($4::text IS NOT NULL AND hs_code LIKE $4))`,
    [`${r.under}%`, r.nameLike || null, r.hs6In || [], r.prefix ? `${r.prefix}%` : null]);
  const codes = rows.map((x) => x.hs_code);
  cache.set(g.id, { codes, at: Date.now() });
  return codes;
}
const _clearGroupCache = () => cache.clear();

module.exports = { GROUPS, groupById, isGroupId, groupsUnder, groupCodes, _clearGroupCache };
