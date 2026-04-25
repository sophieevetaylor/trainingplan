exports.handler = async (event) => {
const headers = {
“Access-Control-Allow-Origin”: “*”,
“Content-Type”: “application/json”,
};

try {
// Step 1: Refresh the access token
const tokenRes = await fetch(“https://www.strava.com/oauth/token”, {
method: “POST”,
headers: { “Content-Type”: “application/json” },
body: JSON.stringify({
client_id: process.env.STRAVA_CLIENT_ID,
client_secret: process.env.STRAVA_CLIENT_SECRET,
refresh_token: process.env.STRAVA_REFRESH_TOKEN,
grant_type: “refresh_token”,
}),
});

```
const tokenData = await tokenRes.json();

if (!tokenData.access_token) {
  return {
    statusCode: 401,
    headers,
    body: JSON.stringify({ error: "Failed to refresh token", detail: tokenData }),
  };
}

// Step 2: Fetch recent activities (last 30)
const activitiesRes = await fetch(
  "https://www.strava.com/api/v3/athlete/activities?per_page=30&page=1",
  {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  }
);

const activities = await activitiesRes.json();

// Step 3: Return simplified data — include all activity types
const simplified = activities
  .map((a) => ({
    name: a.name,
    type: a.type,
    sport_type: a.sport_type,
    date: a.start_date_local,
    distance_km: Math.round((a.distance / 1000) * 100) / 100,
    moving_time_min: Math.round(a.moving_time / 60),
    elapsed_time_min: Math.round(a.elapsed_time / 60),
    pace_per_km: a.distance > 0
      ? Math.floor(a.moving_time / (a.distance / 1000) / 60) +
        ":" +
        String(
          Math.round((a.moving_time / (a.distance / 1000)) % 60)
        ).padStart(2, "0")
      : null,
    avg_hr: a.average_heartrate || null,
    max_hr: a.max_heartrate || null,
    elevation_gain: a.total_elevation_gain,
    suffer_score: a.suffer_score || null,
  }));

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