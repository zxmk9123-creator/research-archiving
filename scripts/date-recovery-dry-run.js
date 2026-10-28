// Usage: node scripts/date-recovery-dry-run.js [--days=7] [--limit=200] [--csv]
// READ-ONLY: one SELECT plus HTTP GETs; prints the report. It never updates any record.
const { buildDateRecoveryReport, loadEligibleRows } = require('../server/lib/dateRecovery');

(async () => {
  const arg = (name, dflt) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? Number(a.split('=')[1]) : dflt; };
  const rows = await loadEligibleRows({ days: arg('days', 7), limit: arg('limit', 200) });
  const report = await buildDateRecoveryReport({ rows });
  if (process.argv.includes('--csv')) {
    const cols = ['id', 'status', 'type', 'human_reviewed', 'source_domain', 'candidate_date', 'precision', 'method', 'evidence', 'outcome', 'reason', 'proposed_action'];
    console.log(cols.join(','));
    for (const r of report.rows) console.log(cols.map((c) => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  process.exit(0);
})().catch((err) => { console.error(err.message); process.exit(1); });
