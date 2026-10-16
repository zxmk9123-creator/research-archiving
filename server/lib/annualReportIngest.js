// Annual report -> stored facts. Pages are selected locally (lib/annualReport.js), only those pages are
// extracted, every figure is verified against its page, then stored twice: as structured rows
// (annual_report_facts, with page + definition + fiscal year) and as ONE Published archive item whose text
// states the same verified figures, so the chatbot's normal retrieval, number checks and footnotes see them.
const pool = require('../db/pool');
const { fetchPdfBuffer, extractPdfPages } = require('./pdfExtract');
const ar = require('./annualReport');
const provider = require('./ai/provider');
const { matchCompanies } = require('./companyMatch');

const fmt = (n) => Number(n).toLocaleString('en-US');
const valueText = (r) => (r.value_max > 0 ? `${fmt(r.value)}~${fmt(r.value_max)} ${r.unit}` : `${fmt(r.value)} ${r.unit}`);

// Deterministic text of the verified facts (no AI): the archive item's body.
function buildReportText(entity, fiscalYear, records, url) {
  const lines = [`${entity} ${fiscalYear ? `FY${fiscalYear} ` : ''}연차보고서 기준 팜유(CPO)·플랜테이션·설비 현황 (원문: ${url}):`];
  for (const r of records) {
    const where = r.location ? `${r.location} ` : '';
    lines.push(`- [${r.segment}] ${where}${r.metric}: ${valueText(r)}${r.definition ? ` (기준: ${r.definition})` : ''} — 보고서 p.${r.page}`);
  }
  return lines.join('\n');
}

async function ensureSource() {
  const name = 'Annual Report Extraction (one-off)';
  const { rows } = await pool.query('SELECT id FROM sources WHERE name = $1 LIMIT 1', [name]);
  if (rows[0]) return rows[0].id;
  const ins = await pool.query(
    `INSERT INTO sources (name, publisher, method, frequency_days, trust_grade, is_active) VALUES ($1, 'Company annual report', 'crawl', 9999, 'A', false) RETURNING id`,
    [name]
  );
  return ins.rows[0].id;
}

// Tracking params are removed; a Google Drive "view" link is turned into its direct download link.
function cleanUrl(raw) {
  const u = new URL(String(raw).trim());
  for (const k of Array.from(u.searchParams.keys())) if (/^utm_/i.test(k)) u.searchParams.delete(k);
  const drive = u.hostname === 'drive.google.com' && u.pathname.match(/\/file\/d\/([^/]+)/);
  return drive ? `https://drive.google.com/uc?export=download&id=${drive[1]}` : u.toString();
}

async function ingestAnnualReport({ url: rawUrl, entity, publishedAt = null, store = true }) {
  const url = cleanUrl(rawUrl);
  const pages = await extractPdfPages(await fetchPdfBuffer(url, 60 * 1024 * 1024));
  const selected = ar.selectPages(pages);
  const user = selected.map((p) => `[page ${p.n}]\n${p.text}`).join('\n\n');
  let records = [];
  const chunkErrors = [];
  for (const chunk of ar.chunkPages(selected)) {
    try {
      const result = await provider.callProviderWithFallback({ system: ar.EXTRACTION_SYSTEM, user: `[Company] ${entity}\n\n${chunk.map((p) => `[page ${p.n}]\n${p.text}`).join('\n\n')}` });
      records = records.concat(ar.parseRecordsLoose(result.text));
    } catch (err) { chunkErrors.push(`${chunk[0].n}-${chunk[chunk.length - 1].n}: ${String(err.message).slice(0, 80)}`); }
  }
  const verified = ar.verifyAgainstPages(Array.isArray(records) ? records : [], selected);
  const kept = ar.fillAreaDefinitions(verified.kept, selected);
  const dropped = verified.dropped;
  const years = kept.map((r) => Number(r.fiscal_year)).filter((y) => y > 2000);
  const fiscalYear = years.length ? Math.max(...years) : null;
  const out = { chunkErrors, totalPages: pages.length, selectedPages: selected.map((p) => p.n), sentChars: user.length, extracted: records.length, verified: kept.length, dropped, fiscalYear, records: kept };
  if (!store || !kept.length) return { ...out, stored: false };

  for (const r of kept) {
    await pool.query(
      `INSERT INTO annual_report_facts (entity, fiscal_year, segment, scope, location, metric, value, value_max, unit, definition, page, source_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (entity, COALESCE(fiscal_year, 0), COALESCE(segment, ''), COALESCE(scope, ''), COALESCE(location, ''), metric, COALESCE(definition, ''), source_url)
       DO UPDATE SET value = EXCLUDED.value, value_max = EXCLUDED.value_max, unit = EXCLUDED.unit, page = EXCLUDED.page`,
      [entity, r.fiscal_year || fiscalYear, r.segment, r.scope, r.location || null, r.metric, r.value, r.value_max > 0 ? r.value_max : null, r.unit, r.definition || null, r.page, url]
    );
  }
  const body = buildReportText(entity, fiscalYear, kept, url);
  const itemUrl = `${url}#annual-report-facts`;
  const published = publishedAt || (fiscalYear ? `${fiscalYear}-12-31` : null);
  const sourceId = await ensureSource();
  const { rows } = await pool.query(
    `INSERT INTO items (title, source_url, published_at, source_id, type, status, summary, ai_summary, ai_status, content_category, facts_status)
     VALUES ($1,$2,$3,$4,'보고서','Published',$5,$5,'completed','archive','done')
     ON CONFLICT (source_url) DO UPDATE SET summary = EXCLUDED.summary, ai_summary = EXCLUDED.ai_summary, published_at = EXCLUDED.published_at
     RETURNING id`,
    [`${entity} ${fiscalYear ? `FY${fiscalYear} ` : ''}연차보고서 — 팜유 플랜테이션·설비 수치`, itemUrl, published, sourceId, body]
  );
  await matchCompanies(rows[0].id, `${entity} ${body}`);
  return { ...out, stored: true, itemId: rows[0].id };
}

module.exports = { cleanUrl, ingestAnnualReport, buildReportText, valueText };
