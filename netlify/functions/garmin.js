// netlify/functions/garmin.js
// Garmin Connect Personal API -> normalised daily health data for index.html.
//
// Env vars (Netlify > Site configuration > Environment variables):
//   GARMIN_API_KEY     required. Personal API key from connect.garmin.com/app/settings/personalApiToken
//   GARMIN_APP_SECRET  recommended. If set, requests must send it in an x-app-key header,
//                      so your health data isn't readable by anyone who finds the function URL.
//
// Query params:
//   date=YYYY-MM-DD    the app's local date (defaults to today in tz)
//   tz=Area/City       used only when date is missing (default Australia/Sydney)
//   raw=1              return Garmin's raw payloads, for checking field mappings
//
// Auth flow (from Garmin's official client): POST the key to the token endpoint with
// "Authorization: ApiKey <key>"; the response body is a JWT valid for up to 24h. No refresh
// tokens, so we just request a new one. Token is cached at module scope while the function is warm.
//
// Steps are deliberately not used by the app: step counts come from the phone (steps.js).

const https = require('https');
const http = require('http');
const crypto = require('crypto');

const BASE_URL = process.env.GARMIN_BASE_URL || 'https://personal.connectapi.garmin.com';
const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
const REFRESH_WINDOW_MS = 60 * 60 * 1000; // renew when under 1h left, as Garmin's client does
const BUDGET_MS = 8500;                   // stay inside Netlify's 10s limit, with cold-start headroom
const PER_REQUEST_MS = 5000;
const DEFAULT_TZ = 'Australia/Sydney';
const HISTORY_DAYS = 28;                  // 4 weeks for the Monday check; falls back to 7 if Garmin refuses

// Daily recovery thresholds
const SLEEP_TARGET_S = 8 * 3600;  // 8h+ target, especially before Strength A and quality runs
const SLEEP_SHORT_S = 7 * 3600;   // flag below 7h
const SLEEP_SCORE_POOR = 60;
const RHR_ELEVATED_BPM = 5;       // flag at 5+ bpm over the prior 6-day average
const RHR_LUTEAL_ALLOWANCE = 2;   // resting HR typically runs a few beats higher in the luteal phase
const BB_PEAK_LOW = 40;           // flag if Body Battery never charged above this
// Garmin's resting HR is only meaningful from nights the watch was worn. Without one it falls back to a
// daytime estimate that runs much higher, so those days stay out of every baseline and trend.
const RHR_MIN_NIGHTS = 3;         // overnight readings needed in the prior 6 days before resting HR has a baseline

// Weekly (Monday check) thresholds: last 7 days vs the 21 before
const WK_RHR_UP_BPM = 3;
const WK_HRV_DOWN_PCT = 10;
const WK_SLEEP_SHORT_S = 7 * 3600;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-app-key',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

let tokenCache = null; // { token, expiresAt, keyHash }

class GarminError extends Error {
  constructor(message, status = 502, code = 'garmin_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------- HTTP ----------

function request(method, path, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const lib = url.protocol === 'http:' ? http : https;
    const req = lib.request(url, { method, headers: { 'User-Agent': 'fitness-app/1.0', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new GarminError('Garmin request timed out', 504, 'timeout')));
    req.on('error', reject);
    req.end();
  });
}

// One retry on network errors and 5xx, only if there's time left. No retry on 429.
async function call(method, path, headers, deadline, attempt = 0) {
  const left = deadline - Date.now();
  if (left < 500) throw new GarminError('Ran out of time waiting for Garmin', 504, 'timeout');
  const canRetry = () => attempt === 0 && deadline - Date.now() > 2500;
  try {
    const res = await request(method, path, headers, Math.min(PER_REQUEST_MS, left - 200));
    if (res.status >= 500 && canRetry()) return call(method, path, headers, deadline, 1);
    return res;
  } catch (err) {
    if (canRetry()) return call(method, path, headers, deadline, 1);
    throw err;
  }
}

// ---------- Token ----------

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function jwtExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function fetchToken(apiKey, deadline) {
  const res = await call('POST', TOKEN_PATH, { Accept: '*/*', Authorization: `ApiKey ${apiKey}`, 'Content-Length': 0 }, deadline);
  if (res.status === 401 || res.status === 403) {
    tokenCache = null;
    throw new GarminError(
      'Garmin rejected the API key. It may have expired or been deleted: create a new one in Garmin Connect and update GARMIN_API_KEY in Netlify.',
      401, 'key_rejected');
  }
  if (res.status === 429) throw new GarminError('Garmin is rate-limiting token requests. Try again shortly.', 429, 'rate_limited');
  if (res.status !== 200) throw new GarminError(`Garmin token request failed (${res.status})`, 502, 'token_failed');

  let token = res.body.trim();
  if (token.startsWith('{')) { // defensive: in case Garmin ever wraps it in JSON
    try { const j = JSON.parse(token); token = j.access_token || j.accessToken || j.token || ''; } catch { token = ''; }
  }
  token = token.replace(/^"|"$/g, '');
  if (!token) throw new GarminError('Garmin returned an empty token', 502, 'token_failed');

  tokenCache = { token, expiresAt: jwtExpiryMs(token) || Date.now() + 23 * 3600 * 1000, keyHash: sha256(apiKey) };
  return token;
}

async function getToken(apiKey, deadline) {
  if (tokenCache && tokenCache.keyHash === sha256(apiKey) && tokenCache.expiresAt - Date.now() > REFRESH_WINDOW_MS) {
    return tokenCache.token;
  }
  return fetchToken(apiKey, deadline);
}

// ---------- Data ----------

async function getJson(path, params, ctx) {
  const qs = params ? `?${new URLSearchParams(params)}` : '';
  const doGet = () => call('GET', path + qs, { Accept: 'application/json', Authorization: `Bearer ${ctx.token}` }, ctx.deadline);
  let res = await doGet();
  if (res.status === 401) { // token revoked or expired early: get one fresh token, shared across parallel calls
    ctx.token = await ctx.refresh();
    res = await doGet();
  }
  if (res.status === 204 || !res.body) return null;
  if (res.status === 429) throw new GarminError('Rate-limited by Garmin', 429, 'rate_limited');
  if (res.status !== 200) throw new GarminError(`${path} returned ${res.status}`, res.status, 'endpoint_failed');
  try { return JSON.parse(res.body); } catch { throw new GarminError(`${path} returned invalid JSON`, 502, 'bad_json'); }
}

// Ask for 4 weeks; if Garmin rejects the range, fall back to 1 week
async function withFallback(fetchFrom, start28, start7) {
  try {
    return await fetchFrom(start28);
  } catch (err) {
    if (err.status === 400 || err.status === 422) return fetchFrom(start7);
    throw err;
  }
}

// ---------- Normalising ----------

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pos = (v) => (num(v) !== null && v >= 0 ? v : null); // Garmin uses -1/-2 for "not enough data"
const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);
const toKg = (v) => (num(v) === null ? null : round1(v > 500 ? v / 1000 : v)); // weights arrive in grams despite the docs
const avg = (xs) => { const v = xs.filter((x) => x !== null && x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const pad = (n) => String(n).padStart(2, '0');

function hhmm(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : (/^\d+$/.test(String(v)) ? Number(v) : NaN);
  if (Number.isFinite(n)) { const d = new Date(n); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; }
  const m = String(v).match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : null;
}

function normSummary(d) {
  const steps = d.movement?.steps || {};
  const hr = d.heartRate || {};
  const bb = d.bodyBattery || {};
  const st = d.stress || {};
  const im = d.intensityMinutes || {};
  return {
    steps: pos(steps.value),
    stepGoal: pos(steps.goal),
    stepDistanceM: pos(steps.distanceInMeters),
    restingHR: pos(hr.restingValue),
    bodyBattery: {
      latest: pos(bb.latestValue), max: pos(bb.maxValue), min: pos(bb.minValue),
      charged: pos(bb.chargedValue), drained: pos(bb.drainedValue),
    },
    stress: { avg: pos(st.avgLevel), qualifier: st.qualifier && st.qualifier !== 'unknown' ? st.qualifier : null },
    intensityMinutes: { moderate: pos(im.moderate), vigorous: pos(im.vigorous), weeklyGoal: pos(im.goal) },
  };
}

function normSleep(s) {
  const overall = (s.sleepScores || {}).overall || {};
  return {
    seconds: pos(s.sleepTimeSeconds),
    deep: pos(s.deepSleepSeconds), light: pos(s.lightSleepSeconds),
    rem: pos(s.remSleepSeconds), awake: pos(s.awakeSleepSeconds),
    score: pos(overall.value),
    quality: overall.qualifierKey && overall.qualifierKey !== 'INVALID' ? overall.qualifierKey : null,
    bedtime: hhmm(s.sleepStartTimestampLocal),
    wake: hhmm(s.sleepEndTimestampLocal),
    awakeCount: pos(s.awakeCount),
  };
}

function normHrv(h) {
  return {
    lastNight: pos(h.lastNightAvg),
    weeklyAvg: pos(h.weeklyAvg),
    status: h.status && !['NONE', 'INVALID'].includes(h.status) ? h.status : null,
    baselineLow: pos(h.baseline?.balancedLow),
    baselineHigh: pos(h.baseline?.balancedUpper),
  };
}

// Phase is worked out from the day numbers Garmin documents (currentPhase is an undocumented id).
function normCycle(c) {
  if (!c || typeof c !== 'object' || c.pregnancyCycle) return null;
  const day = pos(c.dayInCycle);
  if (!day) return null;
  const len = pos(c.predictedCycleLength) || null;
  const periodLen = pos(c.periodLength) || 5;
  const lutealStart = pos(c.lutealPhaseStart) || (len ? len - 13 : null);
  const phase = day <= periodLen ? 'period' : lutealStart && day >= lutealStart ? 'luteal' : 'follicular';
  const L = len || 28;
  const daysToPeriod = len ? Math.max(0, len - day + 1) : null;
  // Water retention is common in the ~5 days before a period and its first 3 days
  const waterDay = (x) => x <= 3 || x >= L - 4;
  let waterThisWeek = false;
  for (let k = 0; k < 7; k++) {
    let x = day - k;
    if (x < 1) x += L;
    if (waterDay(x)) waterThisWeek = true;
  }
  return { day, phase, cycleLength: len, daysToPeriod, waterToday: waterDay(day), waterThisWeek, predicted: !!c.predictedCycle };
}

// One entry per day (that day's latest weigh-in), oldest first
function weighIns(payload) {
  return (payload?.dailyWeightSummaries || [])
    .filter((d) => d.latestWeight && num(d.latestWeight.weight) !== null)
    .map((d) => {
      const w = d.latestWeight;
      return {
        date: d.summaryDate || w.calendarDate || null,
        kg: toKg(w.weight),
        bodyFatPct: round1(pos(w.bodyFat)),
        muscleKg: toKg(w.muscleMass),
      };
    })
    .filter((w) => w.date)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function byDate(list, key, norm) {
  const out = {};
  for (const item of Array.isArray(list) ? list : []) {
    const d = item && item[key];
    if (d) out[d] = norm(item);
  }
  return out;
}

const fmtDuration = (s) => `${Math.floor(s / 3600)}h${pad(Math.round((s % 3600) / 60))}`;

function assessRecovery(today, baseline, cycle) {
  const reasons = [];
  const context = [];
  let signals = 0;
  const sleep = today.sleep;
  if (sleep && sleep.seconds !== null) {
    signals++;
    if (sleep.seconds < SLEEP_SHORT_S) reasons.push(`Short sleep (${fmtDuration(sleep.seconds)})`);
    else if (sleep.score !== null && sleep.score < SLEEP_SCORE_POOR) reasons.push(`Poor sleep score (${sleep.score})`);
  }
  const hrv = today.hrv;
  if (hrv && hrv.status) {
    signals++;
    if (['LOW', 'POOR'].includes(hrv.status)) reasons.push(`HRV ${hrv.status.toLowerCase()}`);
    else if (hrv.status === 'UNBALANCED') reasons.push('HRV unbalanced');
  }
  const luteal = cycle && cycle.phase === 'luteal';
  const overnight = !!((sleep && sleep.seconds !== null) || (hrv && hrv.lastNight !== null));
  if (overnight && today.restingHR !== null && baseline.restingHR !== null) {
    signals++;
    const diff = Math.round(today.restingHR - baseline.restingHR);
    const limit = RHR_ELEVATED_BPM + (luteal ? RHR_LUTEAL_ALLOWANCE : 0);
    if (diff >= limit) reasons.push(`Resting HR up ${diff} bpm`);
    else if (luteal && diff >= RHR_ELEVATED_BPM) context.push(`Resting HR up ${diff} bpm, normal for the luteal phase`);
  }
  if (today.bodyBattery && today.bodyBattery.max !== null) {
    signals++;
    if (today.bodyBattery.max < BB_PEAK_LOW) reasons.push(`Body Battery peaked at ${today.bodyBattery.max}`);
  }
  if (!signals) return null;
  const level = reasons.length === 0 ? 'good' : reasons.length === 1 ? 'fair' : 'low';
  return { level, reasons, signals, context };
}

// A history row counts as an overnight reading if Garmin has sleep or overnight HRV for it
const isOvernight = (x) => (x.overnight !== undefined ? !!x.overnight : x.sleepSeconds !== null || x.hrv !== null);

// Last 7 days vs the 21 before: is the deficit starting to cost recovery?
function recoveryTrend(history, cycle) {
  if (history.length < 14) return null;
  const recent = history.slice(-7);
  const prior = history.slice(0, -7);
  const val = (x, k) => (k === 'restingHR' && !isOvernight(x) ? null : x[k]);
  const stat = (k, minRecent, minPrior) => {
    const r = recent.map((x) => val(x, k)).filter((v) => v !== null && v !== undefined);
    const p = prior.map((x) => val(x, k)).filter((v) => v !== null && v !== undefined);
    if (r.length < minRecent || p.length < minPrior) return null;
    return { recent: avg(r), prior: avg(p) };
  };
  const out = { restingHR: null, hrv: null, sleepSeconds: null, flags: [], strain: false };
  const rhr = stat('restingHR', 4, 7);
  if (rhr) {
    const delta = round1(rhr.recent - rhr.prior);
    out.restingHR = { recent: round1(rhr.recent), prior: round1(rhr.prior), delta };
    const limit = WK_RHR_UP_BPM + (cycle && cycle.phase === 'luteal' ? RHR_LUTEAL_ALLOWANCE : 0);
    if (delta >= limit) out.flags.push(`Resting HR up ${delta} bpm`);
  }
  const hv = stat('hrv', 4, 7);
  if (hv && hv.prior > 0) {
    const deltaPct = Math.round(((hv.recent - hv.prior) / hv.prior) * 100);
    out.hrv = { recent: Math.round(hv.recent), prior: Math.round(hv.prior), deltaPct };
    if (deltaPct <= -WK_HRV_DOWN_PCT) out.flags.push(`HRV down ${Math.abs(deltaPct)}%`);
  }
  const sl = stat('sleepSeconds', 4, 7);
  if (sl) {
    out.sleepSeconds = { recent: Math.round(sl.recent), prior: Math.round(sl.prior), delta: Math.round(sl.recent - sl.prior) };
    if (sl.recent < WK_SLEEP_SHORT_S) out.flags.push(`Sleep averaging ${fmtDuration(Math.round(sl.recent))}`);
  }
  if (!out.restingHR && !out.hrv && !out.sleepSeconds) return null;
  out.strain = out.flags.length >= 2;
  return out;
}

// ---------- Dates ----------

function todayIn(tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

// ---------- Handler ----------

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
    body: JSON.stringify(body),
  };
}

function secretOk(event) {
  const secret = process.env.GARMIN_APP_SECRET;
  if (!secret) return true;
  const h = event.headers || {};
  const sent = h['x-app-key'] || h['X-App-Key'] || '';
  const a = crypto.createHash('sha256').update(String(sent)).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod && event.httpMethod !== 'GET') return respond(405, { ok: false, code: 'method', error: 'GET only' });
  if (!secretOk(event)) return respond(401, { ok: false, code: 'app_key_required', error: 'Missing or wrong app key' });

  const apiKey = (process.env.GARMIN_API_KEY || '').trim();
  if (!apiKey) return respond(500, { ok: false, code: 'not_configured', error: 'GARMIN_API_KEY is not set in Netlify' });

  const q = event.queryStringParameters || {};
  const date = validDate(q.date) ? q.date : todayIn(q.tz || DEFAULT_TZ);
  const start28 = addDays(date, -(HISTORY_DAYS - 1));
  const start7 = addDays(date, -6);
  const start30 = addDays(date, -29);
  const deadline = Date.now() + BUDGET_MS;

  try {
    const ctx = { deadline, token: await getToken(apiKey, deadline) };
    let refreshing = null;
    ctx.refresh = () => (refreshing ||= fetchToken(apiKey, deadline));

    const sections = {
      summaries: withFallback((s) => getJson('/usersummary-service/v2/dailysummaries', { startDate: s, endDate: date }, ctx), start28, start7),
      sleep: withFallback((s) => getJson('/sleep-service/sleep/dailySleepSummariesByDate', { startDate: s, endDate: date }, ctx), start28, start7),
      hrv: withFallback((s) => getJson(`/hrv-service/hrv/daily/${s}/${date}`, null, ctx), start28, start7),
      weight: getJson(`/weight-service/weight/range/${start30}/${date}`, { includeAll: 'true' }, ctx),
      // Not everyone logs a cycle: a 404 here just means "no cycle data", not an error
      cycle: getJson(`/periodichealth-service/menstrualcycle/summary/${date}`, null, ctx)
        .catch((err) => { if (err.status === 404 || err.status === 400) return null; throw err; }),
    };
    const names = Object.keys(sections);
    const settled = await Promise.allSettled(Object.values(sections));
    const raw = {};
    const errors = {};
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') raw[names[i]] = r.value;
      else errors[names[i]] = r.reason?.message || 'failed';
    });

    if (Object.keys(errors).length === names.length) {
      const first = settled[0].reason;
      return respond(first?.status === 401 ? 401 : 502, { ok: false, code: first?.code || 'garmin_error', error: first?.message, errors });
    }
    if (q.raw === '1') return respond(200, { ok: true, date, raw, errors });

    const summaries = byDate(raw.summaries?.data, 'calendarDate', normSummary);
    const sleeps = byDate(raw.sleep, 'calendarDate', normSleep);
    const hrvs = byDate(raw.hrv?.hrvSummaries, 'calendarDate', normHrv);
    const cycle = normCycle(raw.cycle);

    const days = Array.from({ length: HISTORY_DAYS }, (_, i) => addDays(start28, i));
    // Sleep is filed under the morning you wake, so each row's bedtime is the night before its date
    const history = days.map((d) => {
      const s = sleeps[d] || {};
      const row = {
        date: d,
        steps: summaries[d]?.steps ?? null,
        restingHR: summaries[d]?.restingHR ?? null,
        bodyBatteryMax: summaries[d]?.bodyBattery.max ?? null,
        sleepSeconds: s.seconds ?? null,
        sleepScore: s.score ?? null,
        hrv: hrvs[d]?.lastNight ?? null,
        bedtime: s.bedtime ?? null,
        wake: s.wake ?? null,
        deep: s.deep ?? null,
        rem: s.rem ?? null,
        light: s.light ?? null,
        awake: s.awake ?? null,
        awakeCount: s.awakeCount ?? null,
      };
      row.overnight = isOvernight(row);
      return row;
    });
    const trend = history.slice(-7);
    const prior = trend.slice(0, 6); // the 6 days before today

    const empty = normSummary({});
    const today = {
      ...(summaries[date] || empty),
      sleep: sleeps[date] || null,
      hrv: hrvs[date] || null,
    };
    const priorRhr = prior.filter((t) => t.overnight && t.restingHR !== null).map((t) => t.restingHR);
    const baseline = {
      restingHR: priorRhr.length >= RHR_MIN_NIGHTS ? round1(avg(priorRhr)) : null,
      restingHRNights: priorRhr.length,
      restingHRNightsNeeded: RHR_MIN_NIGHTS,
      steps: Math.round(avg(prior.map((t) => t.steps)) || 0) || null,
      sleepSeconds: Math.round(avg(trend.map((t) => t.sleepSeconds)) || 0) || null,
    };
    const weights = weighIns(raw.weight);
    const hasHistory = history.slice(0, -7).some((h) => h.restingHR !== null || h.hrv !== null || h.sleepSeconds !== null);

    return respond(200, {
      ok: true,
      date,
      fetchedAt: new Date().toISOString(),
      today,
      baseline,
      recovery: assessRecovery(today, baseline, cycle),
      recoveryTrend: hasHistory ? recoveryTrend(history, cycle) : null,
      cycle,
      sleepTargetSeconds: SLEEP_TARGET_S,
      trend,
      history,
      weight: weights.length ? weights[weights.length - 1] : null,
      weights,
      errors,
    });
  } catch (err) {
    const status = err instanceof GarminError ? err.status : 502;
    return respond(status === 401 ? 401 : status === 429 ? 429 : 502, { ok: false, code: err.code || 'garmin_error', error: err.message });
  }
};

// Exposed for tests only
exports._internals = { isOvernight, normSummary, normSleep, normHrv, normCycle, weighIns, assessRecovery, recoveryTrend, hhmm, toKg, addDays, resetToken: () => { tokenCache = null; } };
