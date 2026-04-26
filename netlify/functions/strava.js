const https = require(“https”);

function httpsRequest(url, options = {}) {
return new Promise((resolve, reject) => {
const parsedUrl = new URL(url);
const reqOptions = {
hostname: parsedUrl.hostname,
path: parsedUrl.pathname + parsedUrl.search,
method: options.method || “GET”,
headers: options.headers || {},
};
const req = https.request(reqOptions, (res) => {
let data = “”;
res.on(“data”, (chunk) => (data += chunk));
res.on(“end”, () => {
try {
resolve({ status: res.statusCode, data: JSON.parse(data) });
} catch (e) {
resolve({ status: res.statusCode, data: data });
}
});
});
req.on(“error”, reject);
if (options.body) req.write(options.body);
req.end();
});
}

exports.handler = async (event) => {
const headers = {
“Access-Control-Allow-Origin”: “*”,
“Content-Type”: “application/json”,
};

try {
// Step 1: Refresh the access token
const tokenBody = JSON.stringify({
client_id: process.env.STRAVA_CLIENT_ID,
client_secret: process.env.STRAVA_CLIENT_SECRET,
refresh_token: process.env.STRAVA_REFRESH_TOKEN,
grant_type: “refresh_token”,
});

```
const tokenRes = await httpsRequest("https://www.strava.com/oauth/token", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(tokenBody),
  },
  body: tokenBody,
});

const tokenData = tokenRes.data;

if (!tokenData || !tokenData.access_token) {
  return {
    statusCode: 401,
    headers,
    body: JSON.stringify({ error: "Failed to refresh token", detail: tokenData }),
  };
}

// Step 2: Fetch recent activities (last 30)
const activitiesRes = await httpsRequest(
  "https://www.strava.com/api/v3/athlete/activities?per_page=30&page=1",
  {
    method: "GET",
    headers: { Authorization: "Bearer " + tokenData.access_token },
  }
);

const activities = activitiesRes.data;

if (!Array.isArray(activities)) {
  return {
    statusCode: 500,
    headers,
    body: JSON.stringify({ error: "Unexpected response from Strava", detail: activities }),
  };
}

// Step 3: Return simplified data — all activity types
const simplified = activities.map((a) => {
  const distance = a.distance || 0;
  const movingTime = a.moving_time || 0;
  const distKm = distance / 1000;
  let pacePerKm = null;
  if (distKm > 0.1) {
    const totalSec = movingTime / distKm;
    const mins = Math.floor(totalSec / 60);
    const secs = Math.round(totalSec % 60);
    pacePerKm = mins + ":" + String(secs).padStart(2, "0");
  }
  return {
    name: a.name || "Activity",
    type: a.type || "Unknown",
    sport_type: a.sport_type || a.type || "Unknown",
    date: a.start_date_local || "",
    distance_km: Math.round(distKm * 100) / 100,
    moving_time_min: Math.round(movingTime / 60),
    elapsed_time_min: Math.round((a.elapsed_time || 0) / 60),
    pace_per_km: pacePerKm,
    avg_hr: a.average_heartrate || null,
    max_hr: a.max_heartrate || null,
    elevation_gain: a.total_elevation_gain || 0,
    suffer_score: a.suffer_score || null,
  };
});

return {
  statusCode: 200,
  headers,
  body: JSON.stringify({ activities: simplified }),
};
```

} catch (err) {
return {
statusCode: 500,
headers,
body: JSON.stringify({ error: err.message }),
};
}
};