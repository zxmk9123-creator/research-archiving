// Delivers operational warnings to up to two optional channels: a webhook that accepts {"text": "..."} (Slack/Discord-compatible, ALERT_WEBHOOK_URL)
// and an e-mail (Gmail SMTP: ALERT_SMTP_USER + ALERT_SMTP_PASS = a Google app password; ALERT_EMAIL_TO defaults to the sender), sent high-importance.
// An alert counts as delivered when at least one configured channel accepted it. Nothing is sent, and nothing is claimed as sent, when it is not set. Delivery outcomes are
// kept in scheduler_jobs ('ops_alerts') so an incident alerts once, a failed delivery is retried a bounded number of times, and a
// different incident (different key) alerts again.
const { mutateJobState } = require('./jobState');

const JOB = 'ops_alerts';
const RETRY_AFTER_MS = 30 * 60000;
const MAX_ATTEMPTS = 3;
const KEEP_MS = 7 * 86400000;

function emailConfig(env = process.env) {
  const user = (env.ALERT_SMTP_USER || '').trim();
  const pass = (env.ALERT_SMTP_PASS || '').replace(/\s+/g, '');
  if (!user || !pass) return null;
  return { user, pass, to: (env.ALERT_EMAIL_TO || user).trim(), host: env.ALERT_SMTP_HOST || 'smtp.gmail.com' };
}

async function smtpSend(cfg, { subject, text }) {
  const transport = require('nodemailer').createTransport({ host: cfg.host, port: 465, secure: true, auth: { user: cfg.user, pass: cfg.pass }, connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 10000 });
  await transport.sendMail({ from: `Research Archiving <${cfg.user}>`, to: cfg.to, subject, text, priority: 'high', headers: { Importance: 'high', 'X-Priority': '1' } });
}

const keyOf = (text, day) => `${day}:${String(text).replace(/\d+/g, '#').slice(0, 80)}`;

// alerts: [{ key, text }]. Returns { configured, sent, failed, skipped }.
async function dispatchAlerts(alerts, { url = process.env.ALERT_WEBHOOK_URL, email = emailConfig(), sendMail = smtpSend, fetchImpl = fetch, now = Date.now() } = {}) {
  const result = { configured: Boolean(url || email), sent: 0, failed: 0, skipped: 0 };
  if (!(url || email) || !alerts.length) return result;
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
    if (email) tries.push(async () => { await sendMail(email, { subject: `${a.urgent ? '[긴급] ' : ''}[Research Archiving] ${String(a.subject || a.text).slice(0, 80)}`, text: String(a.text) }); return { ok: true, status: 250 }; });
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

module.exports = { emailConfig, dispatchAlerts, keyOf, JOB, MAX_ATTEMPTS, RETRY_AFTER_MS };
