// TABLE / VISUALIZATION CONSISTENCY GUARD. numberCheck.js makes each figure
// match its source; this module makes the PRESENTATION of figures coherent:
//   * a numeric column that holds one kind of quantity (mass, gallons, money…)
//     is rewritten into ONE unit and one number format, exactly (a conversion
//     that would round away more than 0.5% is skipped), so "0.5 Mt", "50만 톤"
//     and "340 kt" never sit side by side in the same column;
//   * a column that mixes kinds (톤 / 갤런 / b/d) is left as is and an explicit
//     "단위 혼재" note is appended below the table;
//   * malformed numbers ("1.2.5", "1,2 Mt", "0.5.") are never displayed;
//   * chart values are reconciled with the table row of the same entity, so the
//     chart cannot contradict the table.
const { extractQuantities } = require('./numberCheck');

const SCALES = [[1e12, '조'], [1e8, '억'], [1e4, '만'], [1, '']];
const BASE_LABEL = { mass: '톤', gal: '갤런', bbl: '배럴', liter: '리터', usd: '달러', eur: '유로', krw: '원', bpd: 'b/d' };
const CLS_NAME = { mass: '톤', gal: '갤런', bbl: '배럴', bpd: 'b/d', liter: '리터', usd: '달러', eur: '유로', krw: '원' };

function fmtNum(x) {
  const abs = Math.abs(x);
  const dec = abs >= 100 ? 1 : abs >= 10 ? 2 : 3;
  const rounded = Number(x.toFixed(dec));
  return rounded.toLocaleString('en-US', { maximumFractionDigits: dec });
}
function pickScale(values, cls) {
  if (cls === 'bpd') return [1, ''];
  const sorted = values.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return SCALES.find(([div]) => median >= div) || SCALES[SCALES.length - 1];
}
const render = (value, [div, word], cls) => `${fmtNum(value / div)}${word ? word : ''} ${BASE_LABEL[cls]}`.replace(/\s+$/, '');

function splitRow(line) {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split('|').map((c) => c.trim());
}
const joinRow = (cells) => `| ${cells.join(' | ')} |`;
const isSep = (line) => /^\|?\s*:?-{2,}/.test(line.trim()) && /^[\s|:\-]+$/.test(line.trim());

const MALFORMED = /\d+(?:\.\d+){2,}(?:\s*(?:만|억|천|Mt|kt|톤|gal|갤런))?|\d+,\d{1,2}(?!\d)(?=\s*(?:만|억|천|Mt|kt|톤|t\b|gal|갤런))|\d\.(?=\s|$|\|)(?=\s*(?:만|억|Mt|kt|톤))/;

function normalizeTablesInText(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  let normalized = 0;
  let warnings = 0;
  let i = 0;
  while (i < lines.length) {
    if (!/^\s*\|/.test(lines[i]) || i + 1 >= lines.length || !isSep(lines[i + 1])) { out.push(lines[i]); i++; continue; }
    let j = i + 2;
    while (j < lines.length && /^\s*\|/.test(lines[j])) j++;
    const header = splitRow(lines[i]);
    const rows = lines.slice(i + 2, j).map(splitRow);
    const width = header.length;
    const notes = [];
    for (let c = 1; c < width; c++) {
      // malformed number text in any cell of the column
      rows.forEach((r) => {
        if (r[c] !== undefined && MALFORMED.test(r[c])) { r[c] = r[c].replace(MALFORMED, '(원문 수치 확인 필요)'); warnings++; }
      });
      const cellQs = rows.map((r) => (r[c] !== undefined ? extractQuantities(r[c]) : []));
      const classes = new Set(cellQs.flat().map((q) => q.cls));
      if (classes.size > 1) {
        notes.push(`※ '${header[c].replace(/\*+/g, '')}' 열에 서로 다른 단위(${[...classes].map((k) => CLS_NAME[k]).join(' / ')})가 섞여 있어 열 안의 값을 직접 비교할 수 없습니다.`);
        warnings++;
        continue;
      }
      if (classes.size !== 1) continue;
      const cls = [...classes][0];
      const all = cellQs.flat().map((q) => q.value).filter((v) => v > 0);
      if (all.length < 2) continue;
      const scale = pickScale(all, cls);
      rows.forEach((r, ri) => {
        const qs = cellQs[ri];
        if (!qs.length) return;
        let cell = r[c];
        // rebuild from the end; a range (inherited first endpoint) is rewritten as one span
        for (let k = qs.length - 1; k >= 0; k--) {
          const q = qs[k];
          let spanStart = q.start;
          let spanEnd = q.end;
          let text;
          let valuesIn = [q.value];
          if (!q.inherited && k > 0 && qs[k - 1].inherited) {
            const first = qs[k - 1];
            spanStart = first.start;
            valuesIn = [first.value, q.value];
            k--;
          } else if (q.inherited) continue;
          const rendered = valuesIn.map((v) => Number(fmtNum(v / scale[0]).replace(/,/g, '')) * scale[0]);
          // skip when rounding would change the figure by more than 0.5%
          if (rendered.some((rv, idx) => Math.abs(rv - valuesIn[idx]) > Math.abs(valuesIn[idx]) * 0.005)) continue;
          // keep an explicit "per year" marker that follows the unit ("Mt/a", "/y", "/년")
          const per = cell.slice(spanEnd).match(/^\/(?:a|y|yr|year|년)\b/i);
          if (per) spanEnd += per[0].length;
          const suffix = per ? '/년' : '';
          text = valuesIn.length === 2
            ? `${fmtNum(valuesIn[0] / scale[0])}${scale[1]} ~ ${render(valuesIn[1], scale, cls)}${suffix}`
            : `${render(valuesIn[0], scale, cls)}${suffix}`;
          if (cell.slice(spanStart, spanEnd) === text) continue;
          cell = cell.slice(0, spanStart) + text + cell.slice(spanEnd);
          normalized++;
        }
        r[c] = cell;
      });
    }
    out.push(joinRow(header), lines[i + 1]);
    rows.forEach((r) => out.push(joinRow(r.length < width ? [...r, ...Array(width - r.length).fill('-')] : r)));
    notes.forEach((n) => { out.push(''); out.push(n); });
    i = j;
  }
  return { text: out.join('\n'), normalized, warnings };
}

// label -> quantities found in that table row (cells after the first)
function tableRowQuantities(text) {
  const map = new Map();
  const lines = String(text || '').split('\n');
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i]) || !isSep(lines[i + 1])) continue;
    for (let j = i + 2; j < lines.length && /^\s*\|/.test(lines[j]); j++) {
      const cells = splitRow(lines[j]);
      const label = cells[0].replace(/[*_`]/g, '').trim().toLowerCase();
      if (!label) continue;
      const qs = cells.slice(1).flatMap((c) => extractQuantities(c));
      if (qs.length) map.set(label, (map.get(label) || []).concat(qs));
    }
  }
  return map;
}

// Chart vs table: when a chart label names a table row and the chart value
// matches none of that row's quantities, the row's single same-class figure wins.
function reconcileChartWithTable(chart, rowMap, unitMult, unitCls) {
  if (!chart || !Array.isArray(chart.series) || !Array.isArray(chart.labels) || !rowMap.size || !unitMult) return { chart, fixed: 0 };
  let fixed = 0;
  const entityKey = (i) => String((Array.isArray(chart.groups) && chart.groups[i]) || chart.labels[i]).toLowerCase();
  const series = chart.series.map((s) => ({
    ...s,
    data: (Array.isArray(s.data) ? s.data : []).map((v, i) => {
      if (v === null || !Number.isFinite(Number(v))) return v;
      const label = String(chart.labels[i]).toLowerCase();
      const row = [...rowMap.keys()].find((k) => k === label || label.includes(k) || k.includes(label) || (entityKey(i) === k && !chart.combine));
      if (!row) return v;
      const same = rowMap.get(row).filter((q) => q.cls === unitCls);
      if (!same.length) return v;
      const base = Number(v) * unitMult;
      if (same.some((q) => Math.abs(q.value - base) <= Math.max(q.value, base) * 0.03)) return v;
      if (same.length === 1) { fixed++; return Math.round((same[0].value / unitMult) * 1000) / 1000; }
      return v;
    }),
  }));
  return { chart: { ...chart, series }, fixed };
}

module.exports = { normalizeTablesInText, tableRowQuantities, reconcileChartWithTable };
