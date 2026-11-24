// netlify/functions/steps.js
// Phone step counts (iPhone source only, so no Garmin double counting). The app GETs the last 3 weeks.
// Stored in Netlify Blobs, which needs the @netlify/blobs dependency in package.json.
//
// POST, header x-app-key: <GARMIN_APP_SECRET>. Any of these bodies (latest value for a day wins):
//   {"date":"YYYY-MM-DD","steps":12345}                one day (missing date = today)
//   {"batch":"2026-11-20 14210\n2026-11-21 9876"}      one line per day: the Shortcut's 7-day backfill
//   {"days":{"2026-11-20":14210}} or {"days":[{"date":..,"steps":..}]}
//   Health Auto Export JSON ({"data":{"metrics":[{"name":"step_count","data":[{date,qty,source}]}]}}):
//     summed per day, iPhone samples only
// Batch days of 0 are skipped (a locked phone reads as 0), and only the last 60 days are accepted.
// Past days keep the higher count: a day's phone total only grows, and a rolling "last 7 days" window
// can start partway through its oldest day. Today takes the latest value.
//
//   GET  header x-app-key (if the secret is set) -> { days: { date: { steps, at } } }
//
// Env: GARMIN_APP_SECRET, the same passphrase the app and garmin.js use. Required for POST.

const crypto = require('crypto');

const STORE = 'phone-steps';
const KEY = 'days';
const KEEP_DAYS = 90;
const RETURN_DAYS = 21;
const DEFAULT_TZ = 'Australia/Sydney';
const BACKFILL_DAYS = 60;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-app-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function respond(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS }, body: JSON.stringify(body) };
}

let blobs = null;
function getStoreFor(event) {
  if (exports._testStore) return exports._testStore;
  blobs = blobs || require('@netlify/blobs');
  blobs.connectLambda(event); // Lambda-style functions must hand the event to Blobs first
  // Default (eventual) consistency: strong reads need an uncachedEdgeURL that Lambda-style
  // functions don't get, so they'd throw. A fresh count can take up to a minute to show.
  return blobs.getStore(STORE);
}

function keyMatches(event, secret) {
  const h = event.headers || {};
  const sent = String(h['x-app-key'] || h['X-App-Key'] || '');
  const a = crypto.createHash('sha256').update(sent).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

function todayIn(tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }
}
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

// Shortcuts can send 12345, "12345", "12,345" or "12345 steps"
function parseSteps(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  const n = parseFloat(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
}

const DAY_LINE = /(\d{4}-\d{2}-\d{2})[^\d\n]+([\d][\d,]*(?:\.\d+)?)/g;
function parseBody(event) {
  let raw = event.body || '';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { /* not JSON */ }
  // A plain-text body of "date count" lines is a batch
  if ((raw.match(DAY_LINE) || []).length > 1) return { batch: raw };
  return Object.fromEntries(new URLSearchParams(raw));
}

// Should a new count for this date replace what's stored?
const shouldWrite = (date, steps, prev, today) => !prev || date >= today || steps > prev.steps;
const addDays = (ds, n) => { const d = new Date(`${ds}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Every way of sending several days at once -> [{date, steps}]. Returns null for a single-day body.
function batchEntries(body) {
  if (body && body.data && Array.isArray(body.data.metrics)) {
    const metric = body.data.metrics.find((m) => /step/i.test(String(m && m.name)));
    const items = (metric && Array.isArray(metric.data) ? metric.data : []).filter((x) => x && x.date);
    const hasSource = items.some((x) => x.source);
    // Keep samples from the iPhone alone; a summarised export merges sources as "iPhone|Garmin" and can't be split
    const keep = hasSource ? items.filter((x) => /iphone/i.test(x.source) && !String(x.source).includes('|')) : items;
    if (items.length && !keep.length) return { error: 'merged_sources' };
    const sums = {};
    keep.forEach((x) => { const d = String(x.date).slice(0, 10); const q = parseSteps(x.qty); if (q !== null) sums[d] = (sums[d] || 0) + q; });
    return Object.entries(sums).map(([date, steps]) => ({ date, steps }));
  }
  if (body && body.days) {
    if (Array.isArray(body.days)) return body.days.map((x) => ({ date: x && x.date, steps: parseSteps(x && x.steps) }));
    if (typeof body.days === 'object') return Object.entries(body.days).map(([date, v]) => ({ date, steps: parseSteps(v && typeof v === 'object' ? v.steps : v) }));
  }
  if (body && 'batch' in body) {
    const text = Array.isArray(body.batch) ? body.batch.join('\n') : String(body.batch ?? '');
    return [...text.matchAll(DAY_LINE)].map((m) => ({ date: m[1], steps: parseSteps(m[2]) }));
  }
  return null;
}

function lastDays(days, n, endDate) {
  const keys = Object.keys(days).filter((d) => d <= endDate).sort().slice(-n);
  return Object.fromEntries(keys.map((k) => [k, days[k]]));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const secret = process.env.GARMIN_APP_SECRET || '';
  const method = event.httpMethod || 'GET';

  if (method === 'POST') {
    if (!secret) return respond(500, { ok: false, code: 'not_configured', error: 'Set GARMIN_APP_SECRET in Netlify before sending steps' });
    if (!keyMatches(event, secret)) return respond(401, { ok: false, code: 'app_key_required', error: 'Missing or wrong app key' });
    const body = parseBody(event);
    const batch = batchEntries(body);
    if (batch) {
      if (batch.error) return respond(400, { ok: false, code: 'merged_sources', error: 'Steps arrived merged across sources. In Health Auto Export turn off Summarize Data so iPhone samples can be picked out' });
      const today = todayIn(body.tz || DEFAULT_TZ), oldest = addDays(today, -BACKFILL_DAYS), latest = addDays(today, 1);
      const good = batch.filter((e) => validDate(e.date) && e.date >= oldest && e.date <= latest && e.steps !== null && e.steps > 0 && e.steps <= 200000);
      if (!good.length) return respond(400, { ok: false, code: 'no_days', error: `No usable days in that batch. Each line needs a yyyy-MM-dd date, a space, then the count. Received: "${String(Array.isArray(body.batch) ? body.batch.join(' | ') : body.batch ?? '').slice(0, 80)}"` });
      try {
        const store = getStoreFor(event);
        const days = (await store.get(KEY, { type: 'json' })) || {};
        const at = new Date().toISOString(), saved = {};
        let unchanged = 0;
        good.forEach((e) => { if (shouldWrite(e.date, e.steps, days[e.date], today)) { days[e.date] = { steps: e.steps, at }; saved[e.date] = e.steps; } else unchanged++; });
        const keep = Object.keys(days).sort().slice(-KEEP_DAYS);
        await store.setJSON(KEY, Object.fromEntries(keep.map((k) => [k, days[k]])));
        return respond(200, { ok: true, saved: Object.keys(saved).length, unchanged, skipped: batch.length - good.length, days: saved });
      } catch (err) {
        return respond(500, { ok: false, code: 'storage_unavailable', error: `Couldn't save: ${err.message}` });
      }
    }
    // Nothing in the request at all: usually an empty variable in the Shortcut, so say which one
    if ((body.steps === undefined || body.steps === null || body.steps === '') && !('batch' in body)) {
      return respond(400, { ok: false, code: 'empty', error: 'Nothing to save: the request had no "batch" lines and no "steps". If you send the week, the batch field arrived empty, so check Combined Text in the Shortcut.' });
    }
    const steps = parseSteps(body.steps);
    if (steps === null || steps < 0 || steps > 200000) return respond(400, { ok: false, code: 'bad_steps', error: `Couldn't read a step count from "${String(body.steps ?? '').slice(0, 40)}"` });
    const date = validDate(body.date) ? body.date : todayIn(body.tz || DEFAULT_TZ);
    try {
      const store = getStoreFor(event);
      const days = (await store.get(KEY, { type: 'json' })) || {};
      const today = todayIn(body.tz || DEFAULT_TZ);
      if (!shouldWrite(date, steps, days[date], today)) return respond(200, { ok: true, date, steps: days[date].steps, unchanged: true });
      days[date] = { steps, at: new Date().toISOString() };
      const keep = Object.keys(days).sort().slice(-KEEP_DAYS);
      await store.setJSON(KEY, Object.fromEntries(keep.map((k) => [k, days[k]])));
      return respond(200, { ok: true, date, steps });
    } catch (err) {
      return respond(500, { ok: false, code: 'storage_unavailable', error: `Couldn't save: ${err.message}` });
    }
  }

  if (method === 'GET') {
    if (secret && !keyMatches(event, secret)) return respond(401, { ok: false, code: 'app_key_required', error: 'Missing or wrong app key' });
    const q = event.queryStringParameters || {};
    const end = validDate(q.date) ? q.date : todayIn(q.tz || DEFAULT_TZ);
    try {
      const store = getStoreFor(event);
      const days = (await store.get(KEY, { type: 'json' })) || {};
      return respond(200, { ok: true, days: lastDays(days, RETURN_DAYS, end) });
    } catch (err) {
      return respond(500, { ok: false, code: 'storage_unavailable', error: `Couldn't read steps: ${err.message}` });
    }
  }

  return respond(405, { ok: false, code: 'method', error: 'GET or POST only' });
};
