const https = require("https");

// Module-level cache. Netlify reuses warm containers, so a token fetched on one
// invocation can be reused on the next — this halves the calls we make to Strava
// and keeps us well inside the rate limit.
let cachedToken = null; // { access_token, expires_at }  (expires_at = unix seconds)

function httpsRequest(url, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const payload =
      body == null ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: { ...headers },
      timeout: 9000 // fail fast instead of letting Netlify kill the whole function
    };
    if (payload != null) {
      options.headers["Content-Type"] = "application/json";
      options.headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = https.request(options, (res) => {
      res.setEncoding("utf8"); // correct multibyte decoding across chunk boundaries
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let data = null;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch (e) {
          return reject(
            new Error("JSON parse failed (" + res.statusCode + "): " + raw.slice(0, 120))
          );
        }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("Request timed out")); });
    if (payload != null) req.write(payload);
    req.end();
  });
}

exports.handler = async function (event) {
  const CORS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  };
  try {
    // Step 1: get a valid access token (reuse the cached one on warm invocations)
    let accessToken = null;
    const now = Math.floor(Date.now() / 1000);
    if (cachedToken && cachedToken.expires_at - 60 > now) {
      accessToken = cachedToken.access_token;
    } else {
      const tok = await httpsRequest("https://www.strava.com/oauth/token", {
        method: "POST",
        body: {
          client_id: process.env.STRAVA_CLIENT_ID,
          client_secret: process.env.STRAVA_CLIENT_SECRET,
          refresh_token: process.env.STRAVA_REFRESH_TOKEN,
          grant_type: "refresh_token"
        }
      });
      if (tok.status !== 200 || !tok.data || !tok.data.access_token) {
        return {
          statusCode: 502,
          headers: CORS,
          body: JSON.stringify({
            error: "Token refresh failed",
            status: tok.status,
            detail: tok.data
          })
        };
      }
      accessToken = tok.data.access_token;
      cachedToken = {
        access_token: accessToken,
        expires_at: tok.data.expires_at || now + 18000
      };
    }

    // Step 2: fetch activities, with one retry on a transient failure / rate limit
    const fetchActivities = () =>
      httpsRequest(
        "https://www.strava.com/api/v3/athlete/activities?per_page=60",
        { headers: { Authorization: "Bearer " + accessToken } }
      );

    let act = await fetchActivities();
    if (act.status === 429 || act.status >= 500) {
      await new Promise((r) => setTimeout(r, 1500));
      act = await fetchActivities();
    }

    if (act.status !== 200 || !Array.isArray(act.data)) {
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({
          error: "Activities fetch failed",
          status: act.status,
          detail: act.data
        })
      };
    }
    const rawActivities = act.data;

    // Step 3: Normalise
    const activities = rawActivities.map((a) => {
      const raw = new Date(a.start_date_local || a.start_date);
      const dateStr =
        raw.getFullYear() +
        "-" +
        String(raw.getMonth() + 1).padStart(2, "0") +
        "-" +
        String(raw.getDate()).padStart(2, "0");
      let pace_per_km = "";
      if (a.moving_time && a.distance && a.distance > 0) {
        const secPerKm = (a.moving_time / a.distance) * 1000;
        const mins = Math.floor(secPerKm / 60);
        const secs = Math.round(secPerKm % 60);
        pace_per_km = mins + ":" + String(secs).padStart(2, "0");
      }
      return {
        id: a.id,
        name: a.name,
        type: a.type,
        sport_type: a.sport_type || a.type,
        date: dateStr,
        distance_km: a.distance ? Math.round(a.distance / 100) / 10 : 0,
        moving_time_min: a.moving_time ? Math.round(a.moving_time / 60) : 0,
        pace_per_km,
        avg_hr: a.average_heartrate || null,
        total_elevation_gain: a.total_elevation_gain || 0
      };
    });

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ activities })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: "Function error", detail: err.message })
    };
  }
};
