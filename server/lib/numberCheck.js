// NUMBER FIDELITY GUARD. A wrong power of ten in a capacity figure ("5만 톤"
// for a source that says 50만 톤 / 0.5 Mt) is the most damaging error this
// archive can show. The model's figures are therefore checked against the
// materials it cited, in a unit-aware way, and corrected from the source when
// the mismatch is a scale slip:
//   * a figure is GROUNDED when a same-class quantity in the cited materials
//     (or the sum of up to three of them) matches within 3%;
//   * not grounded + same digits as a source quantity at another magnitude
//     (a x10 / x100 / x1000 slip, or a 만/천/Mt confusion) -> replaced by the
//     source's own wording;
//   * not grounded, no match -> marked "(원문 수치 확인 필요)" instead of shown;
//   * a class with no counterpart in the materials (e.g. the model converted
//     gallons to tonnes) cannot be verified and is left alone.
const KO_SCALE = { 백만: 1e6, 천만: 1e7, 십만: 1e5, 만: 1e4, 억: 1e8, 조: 1e12, 천: 1e3, 백: 1e2 };
const EN_SCALE = { thousand: 1e3, k: 1e3, million: 1e6, mn: 1e6, m: 1e6, billion: 1e9, bn: 1e9, b: 1e9 };
const TOLERANCE = 0.03;
const MARK_UNVERIFIED = '⚠원문 수치 확인 필요';
// Explicit physical conversions (stated to the reader, never hidden): SAF/renewable fuel density 0.8 kg/L.
const DENSITY_T_PER_M3 = 0.8; // fuels; edible oils (~0.92) are also accepted when grounding converted figures
const DENSITIES = [0.8, 0.92];
const DERIVED_TOLERANCE = 0.08;
function toTons(value, cls, density = DENSITY_T_PER_M3) {
  const litres = cls === 'gal' ? value * 3.785411784 : cls === 'bbl' ? value * 158.987 : cls === 'bpd' ? value * 365 * 158.987 : cls === 'liter' ? value : null;
  return litres === null ? null : (litres * density) / 1000;
}

// [regex source, multiplier, class] — Korean units (no word boundary needed) then English.
const KO_UNITS = [
  ['킬로톤', 1e3, 'mass'], ['메가톤', 1e6, 'mass'], ['톤', 1, 'mass'],
  ['갤런', 1, 'gal'], ['배럴', 1, 'bbl'], ['킬로리터', 1e3, 'liter'], ['리터', 1, 'liter'],
  ['달러', 1, 'usd'], ['유로', 1, 'eur'], ['원', 1, 'krw'],
];
const EN_UNITS = [
  [/^(?:metric\s+)?tonnes?\b|^(?:metric\s+)?tons?\b|^t\b/i, 1, 'mass'],
  [/^kt\b/i, 1e3, 'mass'], [/^Mt\b/, 1e6, 'mass'],
  [/^mmgy\b/i, 1e6, 'gal'], [/^gal(?:lons?)?\b/i, 1, 'gal'],
  [/^b\/d\b|^bpd\b/i, 1, 'bpd'], [/^bbls?\b|^barrels?\b/i, 1, 'bbl'],
  [/^(?:liters?|litres?)\b|^l\b/i, 1, 'liter'], [/^m³|^m3\b/i, 1e3, 'liter'],
  [/^usd\b/i, 1, 'usd'], [/^eur\b/i, 1, 'eur'],
];
const NUM_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

function parseNumber(s) { return Number(String(s).replace(/,/g, '')); }

// Parses "[scale][unit]" at the start of `rest`; returns {len, mult, cls, scaleText, unitText} or null.
function parseUnitAt(rest) {
  let m = rest.match(/^(\s*)(백만|천만|십만|만|억|조|천|백)?(\s*)(킬로톤|메가톤|톤|갤런|배럴|킬로리터|리터|달러|유로|원)/);
  if (m) {
    const unit = KO_UNITS.find((u) => u[0] === m[4]);
    return { len: m[0].length, mult: (m[2] ? KO_SCALE[m[2]] : 1) * unit[1], cls: unit[2], scaleText: m[2] || '', unitText: m[4], hasScale: Boolean(m[2]) };
  }
  // English scale word in front of a Korean unit ("850 million 달러", "3 billion 원")
  m = rest.match(/^(\s*)(thousand|million|billion|mn|bn)\s*(킬로톤|메가톤|톤|갤런|배럴|킬로리터|리터|달러|유로|원)/i);
  if (m) {
    const unit = KO_UNITS.find((u) => u[0] === m[3]);
    return { len: m[0].length, mult: EN_SCALE[m[2].toLowerCase()] * unit[1], cls: unit[2], scaleText: m[2].toLowerCase(), unitText: m[3], hasScale: true };
  }
  m = rest.match(/^(\s*)(thousand|million|billion|mn|bn|k|m|b)?(\s*)(?=\S)/i);
  const lead = m ? m[0].length : 0;
  const scaleWord = m && m[2] ? m[2].toLowerCase() : '';
  for (const tryScale of scaleWord ? [false, true] : [false]) { // whole unit first ("Mt", "kt", "b/d"), then scale+unit ("million tonnes")
    const start = tryScale ? lead : (m ? m[1].length : 0);
    const tail = rest.slice(start);
    for (const [re, mult, cls] of EN_UNITS) {
      const u = tail.match(re);
      if (u) {
        const scaleMult = tryScale ? EN_SCALE[scaleWord] : 1;
        return { len: start + u[0].length, mult: scaleMult * mult, cls, scaleText: tryScale ? scaleWord : '', unitText: u[0], hasScale: tryScale };
      }
    }
  }
  return null;
}

// Extracts every unit-bearing quantity (ranges give both endpoints; an
// endpoint without its own unit inherits the one that follows the range).
function extractQuantities(text) {
  const src = String(text || '');
  const raw = [];
  let m;
  NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(src)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    // years / list numbers / citation indices are not quantities
    if (src[start - 1] === '[' && src[end] === ']') continue;
    const before = src.slice(Math.max(0, start - 2), start);
    const cur = /[$€]\s*$/.test(before) ? (before.includes('$') ? 'usd' : 'eur') : null;
    let unit = parseUnitAt(src.slice(end));
    let value = parseNumber(m[0]);
    let spanEnd = end;
    if (!unit) {
      // Korean composite numerals: "2만 5,000톤" = 25,000 톤, "1억 2,000만 톤" handled as 1억 + "2,000만"
      const comp = src.slice(end).match(/^\s*(만|억)\s+(\d{1,3}(?:,\d{3})+|\d{1,4})(?!\d)/);
      if (comp) {
        const tailUnit = parseUnitAt(src.slice(end + comp[0].length));
        if (tailUnit && !tailUnit.scaleText) {
          value = value * KO_SCALE[comp[1]] + parseNumber(comp[2]);
          unit = { ...tailUnit, len: comp[0].length + tailUnit.len };
          spanEnd = end;
          NUM_RE.lastIndex = end + unit.len;
        }
      }
    }
    raw.push({ start, end: spanEnd, value, unit, cur });
  }
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i];
    let unit = q.unit;
    let inherited = false;
    let rangeEnd = null;
    if (!unit) {
      const next = raw[i + 1];
      const between = next ? src.slice(q.end, next.start) : '';
      if (next && next.unit && /^\s*(?:백만|천만|십만|만|억|조|천|백)?\s*[~∼\-–]\s*$/.test(between)) {
        const sc = between.match(/^\s*(백만|천만|십만|만|억|조|천|백)?/)[1] || '';
        unit = { ...next.unit, mult: (sc ? KO_SCALE[sc] : (next.unit.hasScale ? next.unit.mult / (next.unit.mult / (next.unit.mult)) : 1)) * 1, scaleText: sc };
        // multiplier = own scale (if any) * base unit multiplier
        const base = KO_UNITS.find((u) => u[0] === next.unit.unitText) || EN_UNITS.find(([re]) => re.test(next.unit.unitText));
        unit.mult = (sc ? KO_SCALE[sc] : (next.unit.scaleText && next.unit.scaleText in KO_SCALE ? KO_SCALE[next.unit.scaleText] : 1)) * (base ? base[1] : 1);
        inherited = true;
        rangeEnd = next;
      } else if (q.cur) {
        const sm = src.slice(q.end).match(/^\s*(thousand|million|billion|mn|bn|k|m|b)\b/i);
        unit = { len: sm ? sm[0].length : 0, mult: sm ? EN_SCALE[sm[1].toLowerCase()] : 1, cls: q.cur, scaleText: sm ? sm[1].toLowerCase() : '', unitText: '' };
      } else continue;
    }
    const surfaceEnd = inherited ? q.end + (unit.scaleText ? (src.slice(q.end).match(/^\s*(백만|천만|십만|만|억|조|천|백)/) || [''])[0].length : 0) : q.end + unit.len;
    out.push({
      value: q.value * unit.mult, cls: unit.cls, start: q.start, end: surfaceEnd,
      surface: src.slice(q.start, surfaceEnd), unitText: unit.unitText, inherited,
      numberPart: src.slice(q.start, q.end) + (unit.scaleText ? (src.slice(q.end).match(/^\s*(백만|천만|십만|만|억|조|천|백|thousand|million|billion|mn|bn|k|m|b)/i) || [''])[0] : ''),
    });
  }
  return out;
}

const mantissa = (v) => { const e = Math.floor(Math.log10(v)); return Math.round((v / 10 ** e) * 1000) / 1000; };
const close = (a, b) => Math.abs(a - b) <= Math.max(a, b) * TOLERANCE;

function isGrounded(value, pool) {
  if (pool.some((m) => Math.abs(value - m.value) <= Math.max(value, m.value) * (m.derived ? DERIVED_TOLERANCE : TOLERANCE))) return true;
  const vals = [...new Set(pool.filter((m) => !m.derived).map((m) => m.value))].slice(0, 24);
  for (let i = 0; i < vals.length; i++) {
    for (let j = i; j < vals.length; j++) {
      if (close(value, vals[i] + vals[j]) || (vals[i] !== vals[j] && close(value, Math.abs(vals[i] - vals[j])))) return true; // sums and differences (e.g. an expansion increment)
      for (let k = j; k < vals.length; k++) if (close(value, vals[i] + vals[j] + vals[k])) return true;
    }
  }
  return false;
}
function findSlipMatch(value, pool) {
  if (!(value > 0)) return null;
  const mv = mantissa(value);
  const hits = pool.filter((m) => !m.derived && m.value > 0 && Math.abs(mantissa(m.value) - mv) < 0.006 && !close(value, m.value));
  if (!hits.length) return null;
  return hits.sort((a, b) => Math.abs(Math.log10(a.value / value)) - Math.abs(Math.log10(b.value / value)))[0];
}

// Corrects one answer line against the pooled source quantities.
function guardLine(line, pools) {
  const qs = extractQuantities(line).filter((q) => pools[q.cls] && pools[q.cls].length);
  if (!qs.length) return { line, fixed: 0, flagged: 0 };
  let out = line;
  let fixed = 0;
  let flagged = 0;
  // replace from the end so earlier offsets stay valid
  for (let i = qs.length - 1; i >= 0; i--) {
    const q = qs[i];
    const pool = pools[q.cls];
    if (isGrounded(q.value, pool)) continue;
    const match = findSlipMatch(q.value, pool);
    let replacement;
    if (match) {
      // keep one shared unit in "A ~ B 톤" ranges: an endpoint without its own unit takes only the number part
      replacement = q.inherited ? match.numberPart : match.surface;
      fixed++;
    } else {
      replacement = MARK_UNVERIFIED;
      flagged++;
    }
    out = out.slice(0, q.start) + replacement + out.slice(q.end);
  }
  // A model-derived figure in parentheses ("(연간 약 …)") that could not be grounded is
  // dropped together with its parenthesis instead of leaving a visible warning mid-sentence.
  if (flagged) out = out.replace(/\s*[(（][^()（）]*⚠원문 수치 확인 필요[^()（）]*[)）]/g, '');
  return { line: out, fixed, flagged };
}

const poolsOf = (texts) => {
  const pools = {};
  for (const q of extractQuantities(texts.join('\n'))) {
    (pools[q.cls] = pools[q.cls] || []).push(q);
    for (const density of DENSITIES) {
      const tons = toTons(q.value, q.cls, density);
      if (tons) (pools.mass = pools.mass || []).push({ ...q, value: tons, cls: 'mass', derived: true });
    }
  }
  return pools;
};

// text: the model answer with ORIGINAL [N] markers; candidates: rows sent to the model.
function guardAnswerNumbers(text, candidates, extractCitedIndices, materialText) {
  let fixedTotal = 0;
  let flaggedTotal = 0;
  const allPools = poolsOf(candidates.map(materialText));
  const lines = String(text || '').split('\n');
  let inChart = false;
  const result = lines.map((line) => {
    if (/^```/.test(line.trim())) { inChart = !inChart; return line; }
    if (inChart || !/\d/.test(line)) return line;
    // a line that states the conversion factors/assumptions is method text, not a data claim
    if (/환산|conversion|밀도|density|가정|assum/i.test(line)) return line;
    const cited = extractCitedIndices(line, candidates.length);
    const pools = cited.length ? poolsOf(cited.map((i) => materialText(candidates[i - 1]))) : allPools;
    // a cited material set that lacks a class entirely is verified against all materials instead
    for (const cls of Object.keys(allPools)) if (!pools[cls]) pools[cls] = cited.length ? [] : allPools[cls];
    const r = guardLine(line, pools);
    fixedTotal += r.fixed; flaggedTotal += r.flagged;
    return r.line;
  });
  return { text: result.join('\n'), fixed: fixedTotal, flagged: flaggedTotal };
}

// Chart data: values are in `chart.unit`; check them against all materials.
function guardChartNumbers(chart, candidates, materialText) {
  if (!chart || !Array.isArray(chart.series) || !chart.unit) return { chart, fixed: 0, dropped: 0 };
  const probe = extractQuantities(`1${/^[\s]*[가-힣]/.test(chart.unit) ? '' : ' '}${chart.unit}`);
  const unitInfo = probe[0];
  if (!unitInfo) return { chart, fixed: 0, dropped: 0 };
  const mult = unitInfo.value; // value of "1 <unit>" in base units
  const pools = poolsOf(candidates.map(materialText));
  const pool = pools[unitInfo.cls];
  if (!pool || !pool.length) return { chart, fixed: 0, dropped: 0 };
  let fixed = 0; let dropped = 0;
  const series = chart.series.map((s) => ({
    ...s,
    data: (Array.isArray(s.data) ? s.data : []).map((v) => {
      if (v === null || !Number.isFinite(Number(v))) return v;
      const base = Number(v) * mult;
      if (base <= 0 || isGrounded(base, pool)) return v;
      const match = findSlipMatch(base, pool);
      if (match) { fixed++; return Math.round((match.value / mult) * 1000) / 1000; }
      dropped++;
      return null;
    }),
  }));
  return { chart: { ...chart, series }, fixed, dropped };
}

// "만 톤" / "kt" / "백만 갤런" -> {mult, cls} (value of one such unit in base units), or null.
function unitMultiplier(unitText) {
  const t = String(unitText || '').trim();
  if (!t) return null;
  const probe = extractQuantities(`1${/^[가-힣]/.test(t) ? '' : ' '}${t}`)[0];
  return probe ? { mult: probe.value, cls: probe.cls } : null;
}

module.exports = { MARK_UNVERIFIED, toTons, DENSITY_T_PER_M3, unitMultiplier, extractQuantities, guardLine, guardAnswerNumbers, guardChartNumbers, isGrounded, findSlipMatch, TOLERANCE };
