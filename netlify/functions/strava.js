const https = require("https");

function httpsPost(url, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const body = typeof data === "string" ? data : JSON.stringify(data);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => raw += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error("JSON parse failed: " + raw.slice(0, 100))); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      headers: headers || {}
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => raw += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error("JSON parse failed: " + raw.slice(0, 100))); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

exports.handler = async function(event) {
  const CORS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  };

  try {
    // Step 1: Refresh access token
    const tokenData = await httpsPost("https://www.strava.com/oauth/token", {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: process.env.STRAVA_REFRESH_TOKEN,
      grant_type: "refresh_token"
    });

    if (!tokenData.access_token) {
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ error: "Token refresh failed", detail: tokenData })
      };
    }

    // Step 2: Fetch activities
    const rawActivities = await httpsGet(
      "https://www.strava.com/api/v3/athlete/activities?per_page=60",
      { "Authorization": "Bearer " + tokenData.access_token }
    );

    if (!Array.isArray(rawActivities)) {
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ error: "Activities not array", detail: rawActivities })
      };
    }

    // Step 3: Normalise
    const activities = rawActivities.map(a => {
      const raw = new Date(a.start_date_local || a.start_date);
      const dateStr = raw.getFullYear() + "-" +
        String(raw.getMonth() + 1).padStart(2, "0") + "-" +
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
