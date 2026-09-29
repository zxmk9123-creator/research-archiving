// Translates the raw last_error string stored by server/lib/collector.js
// (e.g. "fetch failed: 404", or a DOMException message for an
// AbortSignal.timeout abort) into a compact, human-readable status for the
// UI, without ever changing what collector.js stores. The HTTP status (or
// "timeout") is kept as secondary technical detail, never the primary text.
const TRANSLATIONS = {
  404: '수집 주소에서 자료를 찾지 못했어요',
  403: '접근 권한이 없어 자료를 가져오지 못했어요',
  429: '요청이 많아 잠시 후 다시 확인할게요',
  timeout: '응답 시간이 너무 길어 확인하지 못했어요',
};
const FALLBACK_MESSAGE = '자료를 가져오는 중 문제가 발생했어요';
const SERVER_ERROR_MESSAGE = '제공처에서 응답하지 않았어요';

function translateSourceError(rawError) {
  if (!rawError) return { message: FALLBACK_MESSAGE, detail: null };

  const statusMatch = rawError.match(/(\d{3})/);
  const status = statusMatch ? Number(statusMatch[1]) : null;

  if (status && TRANSLATIONS[status]) return { message: TRANSLATIONS[status], detail: status };
  if (status && status >= 500 && status < 600) return { message: SERVER_ERROR_MESSAGE, detail: status };
  if (/timeout/i.test(rawError)) return { message: TRANSLATIONS.timeout, detail: 'timeout' };
  if (status) return { message: FALLBACK_MESSAGE, detail: status };
  return { message: FALLBACK_MESSAGE, detail: null };
}

(function () {
  const exported = { translateSourceError };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else {
    window.SourceErrors = exported;
  }
})();
