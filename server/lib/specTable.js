// SPEC TABLES: one row per company and one unit (tons per year) in the capacity column. The model writes the table; this
// pass (code, no AI) converts every parsable capacity to tons/year, keeps the best row per company (running > under
// construction > planned > target, then the latest year) and moves the other rows below the table as "참고" lines.
const LITERS = { gal: 3.785411784, bbl: 158.987, liter: 1 };
const RANK = (s) => (/가동|현재|운영|current/i.test(s) ? 3 : /건설/.test(s) ? 2 : /계획|예정|확보/.test(s) ? 1 : /목표/.test(s) ? 0 : 1);

// -> { tons, converted } | null
function parseCapacity(cell, density = 0.8) {
  const t = String(cell || '').replace(/\[\d+\]/g, '').replace(/⚠[^|]*/g, '').replace(/\s+/g, ' ')
    .replace(/(\d[\d,]*)\s*만\s*(\d[\d,]*)(?=\s*(?:톤|t\b|배럴|갤런|리터))/g, (_, a, b) => String(Number(a.replace(/,/g, '')) * 1e4 + Number(b.replace(/,/g, '')))); // "4만 2,000톤"

  const m = t.match(/([\d][\d,]*(?:\.\d+)?)\s*(만|억|천|k|m)?\s*(톤|t\b|kt\b|mt\b|ktpa|tpa|tons?\b|tonnes?\b|bpd|b\/d|bbl\/d|배럴\s*\/?\s*일|일일\s*배럴|배럴|barrels?|갤런|gallons?|gal\b|리터|liters?|litres?|l\b)/i);
  if (!m) return null;
  let v = Number(m[1].replace(/,/g, ''));
  const mult = { 만: 1e4, 억: 1e8, 천: 1e3 }[m[2]];
  let unit = m[3].toLowerCase();
  if (mult) v *= mult;
  if (/^k$/i.test(m[2] || '') && !/^kt/.test(unit)) v *= 1e3;
  if (/^m$/i.test(m[2] || '') && !/^mt/.test(unit)) v *= 1e6;
  if (/^kt/.test(unit)) return { tons: v * 1000, converted: false };
  if (/^(톤|t|mt|tpa|tons?|tonnes?)$/.test(unit)) return { tons: v, converted: false };
  const daily = /bpd|b\/d|bbl\/d|일/.test(unit) || /\/\s*일|per day|일일|daily/i.test(t);
  let liters;
  if (/배럴|bpd|b\/d|bbl|barrel/.test(unit)) liters = v * LITERS.bbl * (daily ? 365 : 1);
  else if (/갤런|gal/.test(unit)) liters = v * LITERS.gal * (daily ? 365 : 1);
  else liters = v;
  return { tons: (liters * density) / 1000, converted: true };
}

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const splitCells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const keyOf = (name) => String(name || '').replace(/\[\d+\]/g, '').replace(/\(.*?\)|（.*?）/g, '').replace(/\b(inc|corp|co|ltd|plc|s\.p\.a|sa|ag|gmbh|group)\b\.?/gi, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const yearOf = (s) => { const m = String(s || '').match(/(20\d\d)/); return m ? Number(m[1]) : 0; };

function normalizeSpecTables(text, { density = 0.8 } = {}) {
  const lines = String(text || '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i]) || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) { out.push(lines[i++]); continue; }
    let j = i + 2;
    while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) j++;
    const head = splitCells(lines[i]);
    const capIdx = head.findIndex((h) => /생산\s*능력|capacity|용량/i.test(h));
    if (capIdx < 1) { out.push(...lines.slice(i, j)); i = j; continue; }
    const stIdx = head.findIndex((h) => /상태|status/i.test(h));
    const yrIdx = head.findIndex((h) => /시점|연도|기준|year/i.test(h));
    const groups = new Map();
    const order = [];
    for (const l of lines.slice(i + 2, j)) {
      const cells = splitCells(l);
      if (cells.length !== head.length) { order.push({ raw: l }); continue; }
      const cap = parseCapacity(cells[capIdx], density);
      const key = keyOf(cells[0]);
      const row = { cells, cap, rank: RANK(stIdx >= 0 ? cells[stIdx] : (yrIdx >= 0 ? cells[yrIdx] : cells.join(' '))), year: yearOf(yrIdx >= 0 ? cells[yrIdx] : cells.join(' ')), key };
      if (!groups.has(key)) { groups.set(key, []); order.push({ key }); }
      groups.get(key).push(row);
    }
    const refs = [];
    const conv = [];
    const body = [];
    for (const o of order) {
      if (o.raw) { body.push(o.raw); continue; }
      const rows = groups.get(o.key);
      const withCap = rows.filter((r) => r.cap);
      const pool = withCap.length ? withCap : rows;
      const best = pool.slice().sort((a, b) => b.rank - a.rank || b.year - a.year || (b.cap ? b.cap.tons : 0) - (a.cap ? a.cap.tons : 0))[0];
      const cells = best.cells.slice();
      if (best.cap) {
        const orig = cells[capIdx].replace(/\s*\[\d+\]/g, '').replace(/⚠[^|]*/g, '').replace(/\s*※/g, '').trim();
        const cites = (cells[capIdx].match(/\[\d+\]/g) || []).join('');
        cells[capIdx] = `${fmt(best.cap.tons)}${best.cap.converted ? ' ※' : ''}${cites ? ` ${cites}` : ''}`;
        if (best.cap.converted) conv.push(`- ${cells[0].replace(/[*_`]/g, '')}: 원문 ${orig}`);
      }
      body.push(`| ${cells.join(' | ')} |`);
      for (const r of rows) {
        if (r === best) continue;
        const stat = stIdx >= 0 ? r.cells[stIdx] : '';
        if (!r.cap) continue;
        const when = yrIdx >= 0 ? r.cells[yrIdx] : '';
        const val = r.cap ? `${fmt(r.cap.tons)} 톤/년` : r.cells[capIdx];
        if (!r.cap && !r.cells[capIdx]) continue;
        refs.push(`- ${r.cells[0]}: ${val}${stat || when ? ` (${[stat, when].filter(Boolean).join(', ')})` : ''}`);
      }
    }
    const newHead = head.map((h, k) => (k === capIdx && !/톤/.test(h) ? `${h.replace(/\s*\(.*?\)\s*$/, '')} (톤/년)` : h));
    out.push(`| ${newHead.join(' | ')} |`, lines[i + 1], ...body);
    if (conv.length) out.push('', '※ 환산한 값 (갤런·배럴·리터→톤, 일 단위는 ×365, 밀도 가정 포함)', ...conv);
    if (refs.length) out.push('', '**참고 (표에 올리지 않은 같은 업체의 다른 값)**', ...refs);
    i = j;
  }
  return out.join('\n');
}

module.exports = { normalizeSpecTables, parseCapacity };
