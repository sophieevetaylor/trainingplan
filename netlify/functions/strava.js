const https = require("https");

function req(url, opts) {
  return new Promise(function(resolve, reject) {
    var parsed = new URL(url);
    var o = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: opts.method || "GET",
      headers: opts.headers || {}
    };
    var r = https.request(o, function(res) {
      var d = "";
      res.on("data", function(c) { d += c; });
      res.on("end", function() {
        try { resolve(JSON.parse(d)); }
        catch(e) { resolve(d); }
      });
    });
    r.on("error", reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

exports.handler = async function(event) {
  var headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json"
  };
  try {
    var body = JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: process.env.STRAVA_REFRESH_TOKEN,
      grant_type: "refresh_token"
    });
    var token = await req("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: {"Content-Type": "application/json", "Content-Length": "" + Buffer.byteLength(body)},
      body: body
    });
    if (!token || !token.access_token) {
      return {statusCode: 401, headers: headers, body: JSON.stringify({error: "token failed", detail: token})};
    }
    var acts = await req("https://www.strava.com/api/v3/athlete/activities?per_page=30&page=1", {
      method: "GET",
      headers: {Authorization: "Bearer " + token.access_token}
    });
    if (!Array.isArray(acts)) {
      return {statusCode: 500, headers: headers, body: JSON.stringify({error: "bad response", detail: acts})};
    }
    var result = acts.map(function(a) {
      var dist = (a.distance || 0) / 1000;
      var mt = a.moving_time || 0;
      var pace = null;
      if (dist > 0.1) {
        var s = mt / dist;
        pace = Math.floor(s / 60) + ":" + String(Math.round(s % 60)).padStart(2, "0");
      }
      return {
        name: a.name || "Activity",
        type: a.type || "Unknown",
        sport_type: a.sport_type || a.type || "Unknown",
        date: a.start_date_local || "",
        distance_km: Math.round(dist * 100) / 100,
        moving_time_min: Math.round(mt / 60),
        elapsed_time_min: Math.round((a.elapsed_time || 0) / 60),
        pace_per_km: pace,
        avg_hr: a.average_heartrate || null,
        max_hr: a.max_heartrate || null,
        elevation_gain: a.total_elevation_gain || 0,
        suffer_score: a.suffer_score || null
      };
    });
    return {statusCode: 200, headers: headers, body: JSON.stringify({activities: result})};
  } catch(err) {
    return {statusCode: 500, headers: headers, body: JSON.stringify({error: err.message})};
  }
};
