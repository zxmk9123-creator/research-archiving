// Delivers operational warnings to ONE optional channel: a webhook that accepts {"text": "..."} (Slack/Discord-compatible), configured by
// the ALERT_WEBHOOK_URL environment variable. Nothing is sent, and nothing is claimed as sent, when it is not set. Delivery outcomes are
// kept in scheduler_jobs ('ops_alerts') so an incident alerts once, a failed delivery is retried a bounded number of times, and a
// different incident (different key) alerts again.
const { mutateJobState } = require('./jobState');

const JOB = 'ops_alerts';
const RETRY_AFTER_MS = 30 * 60000;
const MAX_ATTEMPTS = 3;
const KEEP_MS = 7 * 86400000;

const keyOf = (text, day) => `${day}:${String(text).replace(/\d+/g, '#').slice(0, 80)}`;

// alerts: [{ key, text }]. Returns { configured, sent, failed, skipped }.
async function dispatchAlerts(alerts, { url = process.env.ALERT_WEBHOOK_URL, fetchImpl = fetch, now = Date.now() } = {}) {
  const result = { configured: Boolean(url), sent: 0, failed: 0, skipped: 0 };
  if (!url || !alerts.length) return result;
  let due = [];
  // if the delivery state cannot be read, alert anyway: silence is worse than a possible repeat
  due = alerts;
  await mutateJobState(JOB, (doc) => {
    doc.sent = doc.sent || {};
    due = alerts.filter((a) => {
      const prev = doc.sent[a.key];
      if (!prev) return true;
      if (prev.ok) return false;
      return prev.attempts < MAX_ATTEMPTS && now - prev.at >= RETRY_AFTER_MS;
    });
    return undefined; // read-only pass
  }).then((ok) => { if (!ok) due = alerts; });
  result.skipped = alerts.length - due.length;
  const outcomes = {};
  for (const a of due) {
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `[Research Archiving] ${a.text}` }), signal: AbortSignal.timeout(8000) });
      outcomes[a.key] = { ok: Boolean(res && res.ok), status: res && res.status };
    } catch (err) {
      outcomes[a.key] = { ok: false, error: String(err.message).slice(0, 80) };
    }
    if (outcomes[a.key].ok) result.sent++; else result.failed++;
  }
  if (Object.keys(outcomes).length) {
    await mutateJobState(JOB, (doc) => {
      doc.sent = doc.sent || {};
      for (const [key, o] of Object.entries(outcomes)) doc.sent[key] = { ...o, at: now, attempts: ((doc.sent[key] && doc.sent[key].attempts) || 0) + 1 };
      for (const [k, v] of Object.entries(doc.sent)) if (now - v.at > KEEP_MS) delete doc.sent[k];
      return doc;
    });
  }
  return result;
}

module.exports = { dispatchAlerts, keyOf, JOB, MAX_ATTEMPTS, RETRY_AFTER_MS };
