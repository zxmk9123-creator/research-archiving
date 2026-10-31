// Delivers operational warnings to up to two optional channels: a webhook that accepts {"text": "..."} (Slack/Discord-compatible, ALERT_WEBHOOK_URL)
// and a mobile push (ALERT_PUSH_URL = an ntfy topic URL, e.g. https://ntfy.sh/<secret-topic>; the ntfy phone app shows it as a push notification).
// An alert counts as delivered when at least one configured channel accepted it. Nothing is sent, and nothing is claimed as sent, when it is not set. Delivery outcomes are
// kept in scheduler_jobs ('ops_alerts') so an incident alerts once, a failed delivery is retried a bounded number of times, and a
// different incident (different key) alerts again.
const { mutateJobState } = require('./jobState');

const JOB = 'ops_alerts';
const RETRY_AFTER_MS = 30 * 60000;
const MAX_ATTEMPTS = 3;
const KEEP_MS = 7 * 86400000;

const keyOf = (text, day) => `${day}:${String(text).replace(/\d+/g, '#').slice(0, 80)}`;

// alerts: [{ key, text }]. Returns { configured, sent, failed, skipped }.
async function dispatchAlerts(alerts, { url = process.env.ALERT_WEBHOOK_URL, pushUrl = process.env.ALERT_PUSH_URL, fetchImpl = fetch, now = Date.now() } = {}) {
  const result = { configured: Boolean(url || pushUrl), sent: 0, failed: 0, skipped: 0 };
  if (!(url || pushUrl) || !alerts.length) return result;
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
    const tries = [];
    if (url) tries.push(() => fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `[Research Archiving] ${a.text}` }), signal: AbortSignal.timeout(8000) }));
    if (pushUrl) tries.push(() => fetchImpl(pushUrl, { method: 'POST', headers: { Title: 'Research Archiving', Priority: a.urgent ? 'high' : 'default', Tags: a.urgent ? 'warning' : 'information_source' }, body: String(a.text).slice(0, 900), signal: AbortSignal.timeout(8000) }));
    let last = { ok: false };
    for (const send of tries) {
      try {
        const res = await send();
        const o = { ok: Boolean(res && res.ok), status: res && res.status };
        if (o.ok) { last = o; break; }
        last = o;
      } catch (err) {
        last = { ok: false, error: String(err.message).slice(0, 80) };
      }
    }
    outcomes[a.key] = last;
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
