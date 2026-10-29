// Buckets a collection failure message into a reason, so a daily failure count can be read by cause.
function classifyFailure(message) {
  const m = String(message || '');
  const status = /fetch failed: (\d{3})/.exec(m);
  if (status) {
    const code = Number(status[1]);
    if (code === 401 || code === 403) return 'blocked_403';
    if (code === 404 || code === 410) return 'not_found';
    if (code === 429) return 'rate_limited';
    if (code >= 500) return 'server_error';
    return `http_${code}`;
  }
  if (/bot-block/i.test(m)) return 'bot_block';
  if (/timeout|timed out|aborted/i.test(m)) return 'timeout';
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|certificate|EAI_AGAIN/i.test(m)) return 'network';
  if (/^PDF worker asset missing/.test(m)) return 'pdf_worker_missing';
  if (/^PDF invalid/.test(m)) return 'pdf_invalid';
  if (/PDF|no text|scanned/i.test(m)) return 'pdf_unreadable';
  if (/too large|exceeds|bytes/i.test(m)) return 'too_large';
  if (/blocked|private|not allowed|unsafe/i.test(m)) return 'url_blocked';
  if (/No AI provider|provider|rate/i.test(m)) return 'ai_provider';
  return 'other';
}
module.exports = { classifyFailure };
