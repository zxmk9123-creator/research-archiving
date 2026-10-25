// Optional, server-side market-data adapter. Exchange data is never exposed
// unless both an API key and explicit display/redistribution approval are
// configured. Keeping the provider here prevents browser-side key exposure
// and gives us one place to cache, validate, and replace the vendor later.
const API_BASE = 'https://ondemand.websol.barchart.com';
const QUOTE_TTL_MS = 60 * 1000;
const HISTORY_TTL_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 7000;
const HISTORY_DAYS = 5;

const INSTRUMENTS = [
  { id: 'palm-oil', label: '팜유 선물', symbol: 'KO*0', unit: 'MYR/metric ton', sourceUrl: 'https://www.barchart.com/futures/quotes/KO%2A0/overview' },
  { id: 'soybean-oil', label: '대두유 선물', symbol: 'ZL*0', unit: 'US cents/lb', sourceUrl: 'https://www.barchart.com/futures/quotes/ZL%2A0/overview' },
];

let quoteCache = { expiresAt: 0, value: null };
let historyCache = { expiresAt: 0, value: null };
let quoteInFlight = null;
let historyInFlight = null;

function isEnabled() {
  return Boolean(process.env.BARCHART_ONDEMAND_API_KEY)
    && process.env.BARCHART_DATA_DISPLAY_ENABLED === 'true';
}

function formatDate(date) {
  return [date.getUTCFullYear(), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')].join('');
}

async function requestJson(endpoint, params) {
  const url = new URL(`${API_BASE}/${endpoint}.json`);
  url.searchParams.set('apikey', process.env.BARCHART_ONDEMAND_API_KEY);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`market provider HTTP ${response.status}`);
    const body = await response.json();
    if (body?.status?.code && Number(body.status.code) !== 200) {
      throw new Error(`market provider status ${body.status.code}`);
    }
    if (!Array.isArray(body?.results)) throw new Error('market provider returned an invalid result');
    return body.results;
  } finally {
    clearTimeout(timer);
  }
}

function finiteOrNull(value) {
  const number = Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(number) ? null : number;
}

async function getQuotes() {
  if (quoteCache.value && quoteCache.expiresAt > Date.now()) return quoteCache.value;
  if (quoteInFlight) return quoteInFlight;
  quoteInFlight = (async () => {
    const symbols = INSTRUMENTS.map((entry) => entry.symbol).join(',');
    const rows = await requestJson('getQuote', {
      symbols,
      fields: 'symbol,name,mode,lastPrice,tradeTimestamp,netChange,percentChange,unitCode,open,high,low,close,volume',
    });
    const bySymbol = new Map(rows.map((row) => [row.symbol, row]));
    const value = INSTRUMENTS.map((instrument) => {
      const row = bySymbol.get(instrument.symbol);
      return {
        ...instrument,
        available: Boolean(row && finiteOrNull(row.lastPrice) !== null),
        price: finiteOrNull(row?.lastPrice),
        change: finiteOrNull(row?.netChange),
        changePercent: finiteOrNull(row?.percentChange),
        mode: typeof row?.mode === 'string' ? row.mode : 'unknown',
        timestamp: row?.tradeTimestamp || row?.serverTimestamp || null,
        high: finiteOrNull(row?.high),
        low: finiteOrNull(row?.low),
        volume: finiteOrNull(row?.volume),
      };
    });
    quoteCache = { value, expiresAt: Date.now() + QUOTE_TTL_MS };
    return value;
  })();
  try {
    return await quoteInFlight;
  } finally {
    quoteInFlight = null;
  }
}

async function getHistory() {
  if (historyCache.value && historyCache.expiresAt > Date.now()) return historyCache.value;
  if (historyInFlight) return historyInFlight;
  historyInFlight = (async () => {
    const end = new Date();
    const start = new Date(end.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000);
    const entries = await Promise.all(INSTRUMENTS.map(async (instrument) => {
      const rows = await requestJson('getHistory', {
        symbol: instrument.symbol,
        type: 'minutes',
        startDate: formatDate(start),
        endDate: formatDate(end),
        interval: 60,
        maxRecords: HISTORY_DAYS * 24,
        order: 'asc',
      });
      const bars = rows.map((row) => ({
        timestamp: row.timestamp || null,
        tradingDay: row.tradingDay || null,
        close: finiteOrNull(row.close),
      })).filter((row) => row.timestamp && row.close !== null);
      return [instrument.id, bars];
    }));
    const value = Object.fromEntries(entries);
    historyCache = { value, expiresAt: Date.now() + HISTORY_TTL_MS };
    return value;
  })();
  try {
    return await historyInFlight;
  } finally {
    historyInFlight = null;
  }
}

async function getMarketData() {
  if (!isEnabled()) {
    return {
      configured: false,
      provider: 'Barchart OnDemand',
      historyInterval: '60-minute',
      generatedAt: new Date().toISOString(),
      reason: 'provider_not_enabled',
      instruments: INSTRUMENTS.map((instrument) => ({ ...instrument, available: false, price: null, bars: [] })),
    };
  }

  const [quotesResult, historyResult] = await Promise.allSettled([getQuotes(), getHistory()]);
  const quotes = quotesResult.status === 'fulfilled' ? quotesResult.value : quoteCache.value;
  const history = historyResult.status === 'fulfilled' ? historyResult.value : (historyCache.value || {});
  const instruments = INSTRUMENTS.map((instrument) => {
    const quote = quotes?.find((row) => row.id === instrument.id);
    return {
      ...instrument,
      available: Boolean(quote?.available),
      price: quote?.price ?? null,
      change: quote?.change ?? null,
      changePercent: quote?.changePercent ?? null,
      mode: quote?.mode || 'unknown',
      timestamp: quote?.timestamp || null,
      high: quote?.high ?? null,
      low: quote?.low ?? null,
      volume: quote?.volume ?? null,
      bars: history[instrument.id] || [],
    };
  });
  const errors = [];
  if (quotesResult.status === 'rejected') errors.push('quotes_unavailable');
  if (historyResult.status === 'rejected') errors.push('history_unavailable');
  return {
    configured: true,
    provider: 'Barchart OnDemand',
    historyInterval: '60-minute',
    generatedAt: new Date().toISOString(),
    stale: errors.length > 0 && Boolean(quotes || Object.keys(history).length > 0),
    errors,
    instruments,
  };
}

module.exports = { getMarketData, INSTRUMENTS };
