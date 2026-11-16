// netlify/functions/steps.js
// Phone step counts. An iPhone Shortcut POSTs today's total (iPhone source only, so no Garmin
// double counting); the app GETs the last 3 weeks. Stored in Netlify Blobs, which needs the
// @netlify/blobs dependency in package.json.
//
//   POST {"date":"YYYY-MM-DD","steps":12345}   header x-app-key: <GARMIN_APP_SECRET>   -> saves (latest wins)
//   GET                                          header x-app-key (if the secret is set) -> { days: { date: { steps, at } } }
//
// Env: GARMIN_APP_SECRET, the same passphrase the app and garmin.js use. Required for POST.

const crypto = require('crypto');

const STORE = 'phone-steps';
const KEY = 'days';
const KEEP_DAYS = 90;
const RETURN_DAYS = 21;
const DEFAULT_TZ = 'Australia/Sydney';

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

function parseBody(event) {
  let raw = event.body || '';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { /* fall through to form encoding */ }
  return Object.fromEntries(new URLSearchParams(raw));
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
    const steps = parseSteps(body.steps);
    if (steps === null || steps < 0 || steps > 200000) return respond(400, { ok: false, code: 'bad_steps', error: `Couldn't read a step count from "${String(body.steps ?? '').slice(0, 40)}"` });
    const date = validDate(body.date) ? body.date : todayIn(body.tz || DEFAULT_TZ);
    try {
      const store = getStoreFor(event);
      const days = (await store.get(KEY, { type: 'json' })) || {};
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
