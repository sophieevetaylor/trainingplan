exports.handler = async function(event) {
  const CORS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  };

  // Step 1: Refresh the access token
  let accessToken;
  try {
    const tokenRes = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        refresh_token: process.env.STRAVA_REFRESH_TOKEN,
        grant_type: "refresh_token"
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ error: "Token refresh failed", detail: tokenData })
      };
    }
    accessToken = tokenData.access_token;
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: "Token request failed", detail: err.message })
    };
  }

  // Step 2: Fetch last 60 activities
  let rawActivities;
  try {
    const activitiesRes = await fetch(
      "https://www.strava.com/api/v3/athlete/activities?per_page=60",
      { headers: { Authorization: "Bearer " + accessToken } }
    );
    rawActivities = await activitiesRes.json();
    if (!Array.isArray(rawActivities)) {
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ error: "Activities not array", detail: rawActivities })
      };
    }
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: "Activities request failed", detail: err.message })
    };
  }

  // Step 3: Normalise to what the app expects
  const activities = rawActivities.map(a => {
    // Normalise date to noon local time to avoid DST off-by-one
    const raw = new Date(a.start_date_local || a.start_date);
    const dateStr = raw.getFullYear() + "-" +
      String(raw.getMonth() + 1).padStart(2, "0") + "-" +
      String(raw.getDate()).padStart(2, "0");

    // Pace: seconds per metre → min:sec per km
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
      pace_per_km: pace_per_km,
      avg_hr: a.average_heartrate || null,
      total_elevation_gain: a.total_elevation_gain || 0
    };
  });

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ activities })
  };
};
