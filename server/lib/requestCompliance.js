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
const VISUAL_WORDS = /(시각|도식|다이어그램|이미지로|그림으로|한눈에|chart|graph|plot|diagram|visuali)/i;
const TABLE_WORDS = /(표로|표\s*(형태|형식|정리|만들|작성)|테이블|table|도표)/i;
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
  // "Top10 기업", "상위 5개 업체" -> a ranking of N; "생산능력만 도표로" -> the table and nothing else
  const topMatch = q.match(/(?:top\s*|상위\s*)(\d{1,2})(?![0-9])|(\d{1,2})\s*(?:대|위까지|개)\s*(?:기업|업체|회사)/i);
  const topN = topMatch ? Number(topMatch[1] || topMatch[2]) : null;
  const wantsChartWord = CHART_WORDS.test(q);
  const wantsTableWord = TABLE_WORDS.test(q);
  const onlyWord = /(만\s*(?:도표|표|정리|작성|제작|보여|알려)|(?:도표|표)\s*(?:로)?\s*만)/.test(q);
  return {
    topN,
    tableOnly: wantsTableWord && !wantsChartWord && (onlyWord || Boolean(topN)),
    wantsChart: CHART_WORDS.test(q),
    wantsTable: TABLE_WORDS.test(q),
    // ANY visual request: the answer must contain a table or a chart (see ensureVisual in routes/search.js)
    wantsVisual: CHART_WORDS.test(q) || TABLE_WORDS.test(q) || VISUAL_WORDS.test(q),
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

// Subtotal/total rows would double-count their own parts in a chart.
const TOTAL_ROW = /(합계|총계|총\s*생산|소계|전체\s*합|^총$|subtotal|grand total)/i;

// Builds a chart block from the first table that has numeric columns of one
// quantity class (up to 3 columns become series). Rows with a range use the upper
// bound; rows with no figure in ANY chosen column are skipped (they stay in the
// table); total/subtotal rows are skipped.
function chartFromTable(text, req) {
  const lines = String(text || '').split('\n');
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i]) || !isSep(lines[i + 1])) continue;
    let j = i + 2;
    const rows = [];
    while (j < lines.length && /^\s*\|/.test(lines[j])) { rows.push(splitRow(lines[j])); j++; }
    const header = splitRow(lines[i]);
    const cols = [];
    for (let c = 1; c < header.length; c++) {
      const cells = rows.map((r) => (r[c] ? extractQuantities(r[c]) : []));
      const classes = new Set(cells.flat().map((q) => q.cls));
      if (classes.size === 1 && cells.filter((q) => q.length).length >= 2) cols.push({ c, cls: [...classes][0], cells });
    }
    if (!cols.length) continue;
    const cls = cols[0].cls;
    const use = cols.filter((x) => x.cls === cls).slice(0, 3);
    const keep = rows.map((r, ri) => ({ r, ri })).filter(({ r, ri }) => !TOTAL_ROW.test(r[0].replace(/[*_`]/g, '').trim()) && use.some((u) => u.cells[ri].length)).slice(0, 30);
    if (keep.length < 3) continue;
    const toTons = req.unitTons && cls === 'mass';
    const scaleDiv = toTons ? 1 : cls === 'mass' ? 1e4 : 1;
    const unit = toTons ? '톤' : cls === 'mass' ? '만 톤' : ({ gal: '갤런', bbl: '배럴', bpd: 'b/d', liter: '리터', usd: '달러', eur: '유로', krw: '원' })[cls];
    const chart = {
      type: req.chartType || (keep.length > 6 ? 'hbar' : 'bar'),
      title: `${header[use[0].c].replace(/\*+/g, '')} (표 기준)`,
      unit,
      labels: keep.map(({ r }) => r[0].replace(/[*_`]/g, '').trim()),
      series: use.map((u) => ({
        name: header[u.c].replace(/\*+/g, ''),
        data: keep.map(({ ri }) => (u.cells[ri].length ? Math.round((Math.max(...u.cells[ri].map((q) => q.value)) / scaleDiv) * 1000) / 1000 : null)),
      })),
    };
    return { chart, insertAfter: j };
  }
  return null;
}

// Completeness requests: when the model's chart shows fewer items than the table
// lists (a top-N cut, or a chart that mixes totals with parts), the chart is rebuilt
// from the table so every row is shown.
function enforceCompleteChart(text, req) {
  if (!req.completeness || !req.wantsChart) return { text, rebuilt: false };
  const built = chartFromTable(text, req);
  if (!built) return { text, rebuilt: false };
  const m = String(text).match(/```chart[^\n]*\n([\s\S]*?)```/);
  let existing = null;
  if (m) { try { existing = JSON.parse(m[1]); } catch (_) { existing = null; } }
  if (existing && existing.auto === 'dataset') return { text, rebuilt: false }; // already built in code from verified records
  const existingN = existing && Array.isArray(existing.labels) ? existing.labels.length : 0;
  const hasTotalBar = existing && existing.labels.some((l) => TOTAL_ROW.test(String(l)));
  if (existing && existingN >= built.chart.labels.length && !hasTotalBar) return { text, rebuilt: false };
  if (existing && existing.title) built.chart.title = String(existing.title).replace(/[\s\-–—,]*상위\s*\d+\s*개?[^\s,)]*/g, '').trim() || built.chart.title;
  const block = `\`\`\`chart\n${JSON.stringify(built.chart)}\n\`\`\``;
  if (m) return { text: String(text).replace(m[0], block), rebuilt: true };
  const lines = String(text).split('\n');
  lines.splice(built.insertAfter, 0, '', block, '');
  return { text: lines.join('\n'), rebuilt: true };
}

function ensureChartPresent(text, req) {
  if (!req.wantsChart || /```chart/.test(text)) return { text, built: false };
  const built = chartFromTable(text, req);
  if (!built) return { text, built: false };
  const lines = String(text).split('\n');
  lines.splice(built.insertAfter, 0, '', '```chart', JSON.stringify(built.chart), '```', '');
  return { text: lines.join('\n'), built: true };
}

const isVisualWord = (w) => CHART_WORDS.test(w) || TABLE_WORDS.test(w) || VISUAL_WORDS.test(w);

module.exports = { isVisualWord, enforceCompleteChart, parseRequest, applyChartCompliance, chartFromTable, ensureChartPresent, COMPLETENESS_RE };
