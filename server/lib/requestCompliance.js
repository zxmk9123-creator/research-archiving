// REQUEST COMPLIANCE (대원칙): what the user explicitly asked for is enforced in
// code, not left to the model's discretion —
//   * chart kind ("가로 막대", "꺾은선", "원형" …)  -> the chart is switched to it
//     when the data shape allows;
//   * unit ("톤 단위로 통일")                       -> chart values/unit are
//     converted to that unit exactly;
//   * a chart was requested but the model drew none -> one is built from the
//     answer's own table;
//   * completeness ("누락 없이", "전체", "모든")      -> flagged so retrieval and
//     the company-coverage guard run in their strictest mode.
const { extractQuantities, unitMultiplier } = require('./numberCheck');

const CHART_WORDS = /(그래프|차트|시각화|도식|막대|꺾은선|꺾은 선|선 그래프|원형|파이|도넛|산점도|면적|영역 그래프|chart|graph|plot|visuali[sz])/i;
const COMPLETENESS_RE = /(누락\s*없|빠짐\s*없|빠뜨리지|전수|모든|전체|전부|all\b|every|complete|exhaustive|entire)/i;
const TONS_RE = /(톤\s*(단위|으로|기준)|단위를?\s*톤|in\s+(metric\s+)?tonn?es?|in\s+tons)/i;

function parseRequest(question) {
  const q = String(question || '');
  let chartType = null;
  if (/가로\s*(막대|바)|horizontal\s*bar/i.test(q)) chartType = 'hbar';
  else if (/누적/.test(q) && /막대|bar/i.test(q)) chartType = 'stacked';
  else if (/세로\s*막대|막대|bar\s*chart/i.test(q)) chartType = 'bar';
  else if (/꺾은\s*선|선\s*그래프|line\s*(chart|graph)/i.test(q)) chartType = 'line';
  else if (/면적|영역\s*(그래프|차트)|area\s*chart/i.test(q)) chartType = 'area';
  else if (/도넛|donut/i.test(q)) chartType = 'donut';
  else if (/원형|파이|pie/i.test(q)) chartType = 'pie';
  else if (/산점도|scatter/i.test(q)) chartType = 'scatter';
  return {
    wantsChart: CHART_WORDS.test(q),
    chartType,
    unitTons: TONS_RE.test(q),
    completeness: COMPLETENESS_RE.test(q),
  };
}

const compatible = (chart, target) => {
  const n = Array.isArray(chart.series) ? chart.series.length : 0;
  if (target === 'pie' || target === 'donut') return n === 1;
  if (target === 'scatter') return n === 2;
  return n >= 1;
};

function applyChartCompliance(chart, req) {
  if (!chart) return { chart, changed: [] };
  const changed = [];
  let out = { ...chart };
  if (req.chartType && out.type !== req.chartType && compatible(out, req.chartType) && out.combine !== 'sum') {
    out.type = req.chartType; changed.push('type');
  } else if (req.chartType === 'hbar' && out.combine === 'sum' && out.type !== 'hbar') {
    out.type = 'hbar'; changed.push('type');
  }
  if (req.unitTons && out.unit && out.unit !== '톤') {
    const um = unitMultiplier(out.unit);
    if (um && um.cls === 'mass') {
      out.series = (out.series || []).map((s) => ({
        ...s,
        data: (Array.isArray(s.data) ? s.data : []).map((v) => (v === null || !Number.isFinite(Number(v)) ? v : Math.round(Number(v) * um.mult * 1000) / 1000)),
      }));
      out.unit = '톤';
      changed.push('unit');
    }
  }
  return { chart: out, changed };
}

const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isSep = (line) => /^[\s|:\-]+$/.test(line.trim()) && /-{2,}/.test(line);

// Builds a chart block from the first table that has a numeric column of one
// quantity class. Rows with a range use the upper bound; rows with no figure
// are skipped (they stay in the table).
function chartFromTable(text, req) {
  const lines = String(text || '').split('\n');
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i]) || !isSep(lines[i + 1])) continue;
    let j = i + 2;
    const rows = [];
    while (j < lines.length && /^\s*\|/.test(lines[j])) { rows.push(splitRow(lines[j])); j++; }
    const header = splitRow(lines[i]);
    for (let c = 1; c < header.length; c++) {
      const cells = rows.map((r) => (r[c] ? extractQuantities(r[c]) : []));
      const classes = new Set(cells.flat().map((q) => q.cls));
      if (classes.size !== 1 || cells.filter((q) => q.length).length < 3) continue;
      const cls = [...classes][0];
      const picked = rows.map((r, ri) => (cells[ri].length ? { label: r[0].replace(/[*_`]/g, '').trim(), value: Math.max(...cells[ri].map((q) => q.value)) } : null)).filter(Boolean).slice(0, 30);
      const toTons = req.unitTons && cls === 'mass';
      const scaleDiv = toTons ? 1 : cls === 'mass' ? 1e4 : 1;
      const unit = toTons ? '톤' : cls === 'mass' ? '만 톤' : ({ gal: '갤런', bbl: '배럴', bpd: 'b/d', liter: '리터', usd: '달러', eur: '유로', krw: '원' })[cls];
      const chart = {
        type: req.chartType || (picked.length > 6 ? 'hbar' : 'bar'),
        title: `${header[c].replace(/\*+/g, '')} (표 기준)`,
        unit,
        labels: picked.map((p) => p.label),
        series: [{ name: header[c].replace(/\*+/g, ''), data: picked.map((p) => Math.round((p.value / scaleDiv) * 1000) / 1000) }],
      };
      return { chart, insertAfter: j };
    }
  }
  return null;
}

function ensureChartPresent(text, req) {
  if (!req.wantsChart || /```chart/.test(text)) return { text, built: false };
  const built = chartFromTable(text, req);
  if (!built) return { text, built: false };
  const lines = String(text).split('\n');
  lines.splice(built.insertAfter, 0, '', '```chart', JSON.stringify(built.chart), '```', '');
  return { text: lines.join('\n'), built: true };
}

module.exports = { parseRequest, applyChartCompliance, chartFromTable, ensureChartPresent, COMPLETENESS_RE };
