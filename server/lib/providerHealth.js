// Shared (cross-instance) health + metrics for the search providers, kept in the existing scheduler_jobs table (job 'provider_health').
// Serverless instances do not share memory, so a Brave key that hit its quota must be remembered here or every cold start re-tries it.
// Keys are only ever identified by a short hash, never the key itself. Persistence is best-effort and never throws.
const crypto = require('node:crypto');

const JOB = 'provider_health';
const KEEP_DAYS = 7;
const CACHE_MS = 30000;
// How long a key/provider is skipped after each failure category, then it is probed again (recovery policy).
const PARK_MS = { quota: 6 * 3600000, rate: 2 * 60000, auth: 24 * 3600000 };

const keyId = (key) => crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 8);

function classify(status) {
  if (status === 402) return 'quota';
  if (status === 429) return 'rate';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500) return 'server';
  return 'other';
}

let store = null; // { read(): Promise<obj|null>, mutate(fn): Promise<boolean> }
function defaultStore() {
  if (!process.env.DATABASE_URL) return null;
  const pool = require('../db/pool');
  const { mutateJobState } = require('./jobState');
  return {
    async read() { const { rows } = await pool.query('SELECT last_totals FROM scheduler_jobs WHERE job_name = $1', [JOB]); return rows[0] ? rows[0].last_totals : null; },
    mutate: (fn) => mutateJobState(JOB, fn), // atomic: concurrent instances cannot overwrite each other's counters or parks
  };
}
const getStore = () => store || (store = defaultStore());

let cache = null; // { at, data: { parked, days } }
let delta = { counts: {}, parked: {} }; // not yet flushed
const today = () => new Date().toISOString().slice(0, 10);
const emptyData = () => ({ parked: {}, days: {} });

async function load(force = false) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  let data = emptyData();
  try {
    const s = getStore();
    const raw = s && (await s.read());
    if (raw && typeof raw === 'object') data = { parked: raw.parked || {}, days: raw.days || {} };
  } catch (err) { console.error('provider health read failed:', err.message); }
  cache = { at: Date.now(), data };
  return data;
}

// Is this key/provider currently parked? Considers both persisted and not-yet-flushed local parks.
async function isParked(provider, kid = '') {
  const data = await load();
  const id = `${provider}:${kid}`;
  const until = Math.max((data.parked[id] || {}).until || 0, (delta.parked[id] || {}).until || 0);
  return until > Date.now();
}

function parkedInfo(provider, kid = '') {
  const id = `${provider}:${kid}`;
  return (delta.parked[id] || (cache && cache.data.parked[id]) || null);
}

// outcome: success | quota | rate | auth | server | other | fallback_ok | fallback_fail
function record(provider, outcome, { kid = '', retryAfterMs = 0, note = '' } = {}) {
  const c = delta.counts[provider] || (delta.counts[provider] = {});
  if (outcome !== 'fallback_ok' && outcome !== 'fallback_fail') c.requests = (c.requests || 0) + 1;
  c[outcome] = (c[outcome] || 0) + 1;
  if (kid) { const k = c.keys || (c.keys = {}); k[kid] = (k[kid] || 0) + 1; }
  const ms = PARK_MS[outcome];
  if (ms) {
    const wait = outcome === 'rate' && retryAfterMs ? Math.min(Math.max(retryAfterMs, ms), 600000) : ms;
    delta.parked[`${provider}:${kid}`] = { until: Date.now() + wait, reason: outcome, at: new Date().toISOString(), note: String(note).slice(0, 80) };
  }
  if (outcome !== 'success' && outcome !== 'fallback_ok') c.lastError = { at: new Date().toISOString(), outcome, note: String(note).slice(0, 120) };
}

// Folds this instance's unflushed counters/parks into the shared document. The merge is applied inside an atomic read-modify-write
// (store.mutate), so it is re-run on the latest document if another instance wrote in between.
function mergeInto(data, mine) {
  const now = Date.now();
  const parked = { ...(data.parked || {}) };
  for (const [id, v] of Object.entries(parked)) if (!v || v.until < now - 86400000) delete parked[id];
  for (const [id, v] of Object.entries(mine.parked)) if (!parked[id] || parked[id].until < v.until) parked[id] = v;
  const days = { ...(data.days || {}) };
  const day = days[today()] || (days[today()] = {});
  for (const [p, c] of Object.entries(mine.counts)) {
    const d = day[p] || (day[p] = {});
    for (const [k, v] of Object.entries(c)) {
      if (k === 'keys') { d.keys = d.keys || {}; for (const [kk, n] of Object.entries(v)) d.keys[kk] = (d.keys[kk] || 0) + n; }
      else if (k === 'lastError') d.lastError = v;
      else d[k] = (d[k] || 0) + v;
    }
  }
  for (const dk of Object.keys(days).sort().slice(0, -KEEP_DAYS)) delete days[dk];
  return { parked, days };
}

async function flush() {
  const mine = delta;
  delta = { counts: {}, parked: {} };
  if (!Object.keys(mine.counts).length && !Object.keys(mine.parked).length) return;
  let ok = false;
  try {
    const s = getStore();
    if (!s) return;
    let written;
    ok = await s.mutate((data) => (written = mergeInto(data, mine)));
    if (ok && written) cache = { at: Date.now(), data: written };
  } catch (err) {
    console.error('provider health write failed:', err.message);
  }
  if (!ok) {
    // not persisted: keep the parks locally (cooldowns must still hold on this instance) and put the counters back for the next flush
    for (const [id, v] of Object.entries(mine.parked)) if (!delta.parked[id] || delta.parked[id].until < v.until) delta.parked[id] = v;
    for (const [p, c] of Object.entries(mine.counts)) {
      const d = delta.counts[p] || (delta.counts[p] = {});
      for (const [k, v] of Object.entries(c)) {
        if (k === 'keys') { d.keys = d.keys || {}; for (const [kk, n] of Object.entries(v)) d.keys[kk] = (d.keys[kk] || 0) + n; }
        else if (k === 'lastError') d.lastError = d.lastError || v;
        else d[k] = (d[k] || 0) + v;
      }
    }
  }
}

// Test hooks
function _setStoreForTests(s) { store = s; cache = null; delta = { counts: {}, parked: {} }; }
function _resetForTests() { store = null; cache = null; delta = { counts: {}, parked: {} }; }

module.exports = { keyId, classify, isParked, parkedInfo, record, flush, load, PARK_MS, _setStoreForTests, _resetForTests };
