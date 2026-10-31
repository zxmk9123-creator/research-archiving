// Daily operations digest, sent by e-mail (and the webhook, if set) after noon KST. It gathers what the health check, the AI router probe,
// the reader votes and the Doctor already know; it changes nothing. buildDigest() is pure; runDigest() does the reads and the single send.
const ICON = { ok: '정상', warn: '주의', failed: '장애', unknown: '확인불가' };

function buildDigest({ day, health, router, feedback, doctor }) {
  const status = health ? health.status : 'unknown';
  const worst = [health && health.status, router && router.status === 'fail' ? 'failed' : router && router.status === 'warn' ? 'warn' : null].filter(Boolean);
  const overall = worst.includes('failed') ? 'failed' : worst.includes('warn') ? 'warn' : status;
  const lines = [`운영 현황 ${day}: ${ICON[overall] || ICON.unknown}`, ''];
  lines.push(`■ 파이프라인 (${ICON[status] || status})`);
  lines.push(health ? health.summary : '확인 불가: 점검을 실행하지 못했습니다.');
  lines.push('', `■ AI 라우터 (${router ? router.status : '확인불가'})`);
  lines.push(router && router.check ? router.check.detail : '확인 불가: 프로브를 실행하지 못했습니다.');
  lines.push('', '■ 답변 평가(👍/👎)');
  if (feedback && feedback.total) {
    lines.push(`최근 180일 ${feedback.total}건 중 호평 ${feedback.liked}건(${Math.round(feedback.likeRate * 100)}%), 싫어요 ${feedback.disliked}건`);
    for (const f of (feedback.findings || []).slice(0, 4)) lines.push(`- ${f}`);
  } else lines.push(feedback ? '아직 수집된 평가가 없습니다.' : '확인 불가.');
  lines.push('', '■ Doctor');
  if (doctor) lines.push(`최근 실행 ${doctor.at}: ${doctor.outcome}${doctor.humanNeeded ? ' — 사람 확인 필요' : ''}`);
  else lines.push('기록된 실행이 없습니다.');
  return { status: overall, subject: lines[0], text: lines.join('\n') };
}

async function runDigest({ now = new Date(), send, health, router, feedback, doctor } = {}) {
  const pool = require('../db/pool');
  const safe = async (fn) => { try { return await fn(); } catch (err) { console.error('ops digest read failed:', err.message); return null; } };
  const kstDay = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  const parts = {
    health: health !== undefined ? health : await safe(() => require('./pipelineHealth').runHealthCheck(now)),
    router: router !== undefined ? router : await safe(() => require('./aiRouterHealth').runAiRouterCheck({ now: now.getTime() })),
    feedback: feedback !== undefined ? feedback : await safe(async () => { const af = require('./answerFeedback'); return af.analyze(await af.loadFeedback(pool, { days: 180 })); }),
    doctor: doctor !== undefined ? doctor : await safe(async () => {
      const r = (await pool.query("SELECT last_totals FROM scheduler_jobs WHERE job_name = 'ops_doctor'")).rows[0];
      const list = (r && r.last_totals && r.last_totals.reports) || [];
      return list.length ? list[list.length - 1] : null;
    }),
  };
  const d = buildDigest({ day: kstDay, ...parts });
  const dispatch = send || ((alerts) => require('./opsAlerts').dispatchAlerts(alerts));
  const delivery = await dispatch([{ key: `digest-${kstDay}`, text: d.text, urgent: d.status === 'failed', subject: d.subject }]);
  return { status: d.status, delivery, subject: d.subject };
}

module.exports = { buildDigest, runDigest };
