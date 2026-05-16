const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const TAWHIRI_API_URL =
  process.env.TAWHIRI_API_URL || "https://predict.sondehub.org/api/v1/";

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const EARTH_RADIUS_KM = 6371;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

function normalizeLongitudeForTawhiri(lon) {
  return ((lon % 360) + 360) % 360;
}

function normalizeLongitudeForMap(lon) {
  return ((lon + 540) % 360) - 180;
}

function movePoint(lat, lon, distanceKm, bearingDeg) {
  const brng = toRad(bearingDeg);
  const d = distanceKm / EARTH_RADIUS_KM;
  const lat1 = toRad(lat);
  const lon1 = toRad(lon);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) +
      Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
  );

  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );

  return {
    lat: toDeg(lat2),
    lon: normalizeLongitudeForMap(toDeg(lon2)),
  };
}

function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

function buildCandidateLaunches(target, searchRadiusKm, gridStepKm) {
  const candidates = [];
  const steps = Math.ceil(searchRadiusKm / gridStepKm);

  for (let x = -steps; x <= steps; x++) {
    for (let y = -steps; y <= steps; y++) {
      const eastKm = x * gridStepKm;
      const northKm = y * gridStepKm;
      const radius = Math.sqrt(eastKm ** 2 + northKm ** 2);
      if (radius > searchRadiusKm) continue;

      const bearing = (toDeg(Math.atan2(eastKm, northKm)) + 360) % 360;
      const launch = movePoint(target.lat, target.lon, radius, bearing);

      candidates.push({
        lat: launch.lat,
        lon: launch.lon,
        distanceFromTargetKm: radius,
      });
    }
  }

  return candidates;
}

function getFinalPredictionPoint(data) {
  if (!data || !Array.isArray(data.prediction)) {
    throw new Error("Unexpected predictor response: missing prediction array.");
  }

  const finalStage = data.prediction[data.prediction.length - 1];
  if (!finalStage || !Array.isArray(finalStage.trajectory)) {
    throw new Error("Unexpected predictor response: missing trajectory.");
  }

  const finalPoint = finalStage.trajectory[finalStage.trajectory.length - 1];
  if (!finalPoint) {
    throw new Error("Unexpected predictor response: empty trajectory.");
  }

  return {
    lat: Number(finalPoint.latitude),
    lon: normalizeLongitudeForMap(Number(finalPoint.longitude)),
    altitude: Number(finalPoint.altitude),
    datetime: finalPoint.datetime,
  };
}

function buildTawhiriUrl(launch, params) {
  const url = new URL(TAWHIRI_API_URL);

  url.searchParams.set("profile", "standard_profile");
  url.searchParams.set("launch_latitude", String(launch.lat));
  url.searchParams.set("launch_longitude", String(normalizeLongitudeForTawhiri(launch.lon)));
  url.searchParams.set("launch_datetime", params.launchDatetime);
  url.searchParams.set("launch_altitude", String(params.launchAltitude));
  url.searchParams.set("ascent_rate", String(params.ascentRate));
  url.searchParams.set("burst_altitude", String(params.burstAltitude));
  url.searchParams.set("descent_rate", String(params.descentRate));

  return url;
}

async function runTawhiriPrediction(launch, params) {
  const url = buildTawhiriUrl(launch, params);

  const response = await fetch(url, {
    headers: {
      "Accept": "application/json,text/plain,*/*",
      "User-Agent": "Mozilla/5.0 Reverse-HAB-Launch-Finder educational non-commercial use",
      "Referer": "https://predict.sondehub.org/"
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Predictor HTTP ${response.status}: ${text.slice(0, 350)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Predictor did not return JSON. First response text: ${text.slice(0, 350)}`);
  }

  if (data.error) {
    throw new Error(`Predictor returned error: ${JSON.stringify(data.error)}`);
  }

  const landing = getFinalPredictionPoint(data);

  return {
    launch,
    landing,
    metadata: data.metadata || null,
    source: "live-api",
    apiUrlUsed: url.toString().replace(params.launchDatetime, encodeURIComponent(params.launchDatetime)),
  };
}

function runSimpleFallbackPrediction(launch, params) {
  const ascentHours = params.burstAltitude / params.ascentRate / 3600;
  const descentHours = params.burstAltitude / params.descentRate / 3600;
  const totalHours = ascentHours + descentHours;

  const windBearing = Number(params.fallbackWindBearing ?? 95);
  const windSpeed = Number(params.fallbackWindSpeed ?? 12);
  const effectiveWindKmh = windSpeed * 3.6 * 1.25;
  const driftKm = effectiveWindKmh * totalHours;
  const landing = movePoint(launch.lat, launch.lon, driftKm, windBearing);

  return {
    launch,
    landing: {
      lat: landing.lat,
      lon: landing.lon,
      altitude: 0,
      datetime: null,
    },
    metadata: {
      note: "Simple fallback model only. Not real weather data.",
      windBearing,
      windSpeed,
      driftKm,
      totalHours,
    },
    source: "simple-fallback",
  };
}

function validateNumber(value, name, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return n;
}

function getParams(body) {
  return {
    launchDatetime: body.launchDatetime || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    launchAltitude: validateNumber(body.launchAltitude ?? 520, "launchAltitude", -500, 5000),
    ascentRate: validateNumber(body.ascentRate ?? 5, "ascentRate", 0.1, 20),
    burstAltitude: validateNumber(body.burstAltitude ?? 30000, "burstAltitude", 1000, 45000),
    descentRate: validateNumber(body.descentRate ?? 7, "descentRate", 0.1, 50),
    fallbackWindBearing: validateNumber(body.fallbackWindBearing ?? 95, "fallbackWindBearing", 0, 359),
    fallbackWindSpeed: validateNumber(body.fallbackWindSpeed ?? 12, "fallbackWindSpeed", 1, 80),
  };
}

function getTarget(body) {
  return {
    lat: validateNumber(body.targetLat, "targetLat", -90, 90),
    lon: validateNumber(body.targetLon, "targetLon", -180, 180),
  };
}

app.post("/api/test-one", async (req, res) => {
  try {
    const body = req.body || {};
    const target = getTarget(body);
    const params = getParams(body);

    // Test launch point is the target itself, just to see if the live predictor answers.
    const testLaunch = {
      lat: target.lat,
      lon: target.lon,
      distanceFromTargetKm: 0,
    };

    try {
      const prediction = await runTawhiriPrediction(testLaunch, params);
      const missKm = haversineKm(prediction.landing, target);

      res.json({
        ok: true,
        liveApiWorks: true,
        predictionApi: TAWHIRI_API_URL,
        result: {
          launch: prediction.launch,
          predictedLanding: prediction.landing,
          missKm: Number(missKm.toFixed(3)),
          source: prediction.source,
        },
      });
    } catch (err) {
      const fallback = runSimpleFallbackPrediction(testLaunch, params);
      const missKm = haversineKm(fallback.landing, target);

      res.json({
        ok: true,
        liveApiWorks: false,
        predictionApi: TAWHIRI_API_URL,
        liveApiError: String(err.message || err).slice(0, 600),
        fallbackResult: {
          launch: fallback.launch,
          predictedLanding: fallback.landing,
          missKm: Number(missKm.toFixed(3)),
          source: fallback.source,
          metadata: fallback.metadata,
        },
      });
    }
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || "Unknown error" });
  }
});

app.post("/api/reverse", async (req, res) => {
  try {
    const body = req.body || {};
    const useFallbackWhenBlocked = body.useFallbackWhenBlocked !== false;

    const target = getTarget(body);
    const params = getParams(body);

    const searchRadiusKm = validateNumber(body.searchRadiusKm ?? 120, "searchRadiusKm", 5, 500);
    const gridStepKm = validateNumber(body.gridStepKm ?? 20, "gridStepKm", 2, 100);
    const topN = Math.min(validateNumber(body.topN ?? 12, "topN", 1, 25), 25);
    const maxPredictions = Math.min(validateNumber(body.maxPredictions ?? 40, "maxPredictions", 1, 120), 120);
    const requestDelayMs = Math.min(validateNumber(body.requestDelayMs ?? 500, "requestDelayMs", 0, 5000), 5000);

    let candidates = buildCandidateLaunches(target, searchRadiusKm, gridStepKm)
      .sort((a, b) => a.distanceFromTargetKm - b.distanceFromTargetKm)
      .slice(0, maxPredictions);

    const results = [];
    const failures = [];
    let liveApiSuccesses = 0;
    let fallbackUses = 0;

    for (const launch of candidates) {
      let prediction;

      try {
        prediction = await runTawhiriPrediction(launch, params);
        liveApiSuccesses++;
      } catch (err) {
        failures.push(String(err.message || err).slice(0, 500));

        if (!useFallbackWhenBlocked) {
          await sleep(requestDelayMs);
          continue;
        }

        prediction = runSimpleFallbackPrediction(launch, params);
        fallbackUses++;
      }

      const missKm = haversineKm(prediction.landing, target);

      results.push({
        launch: {
          lat: Number(launch.lat.toFixed(6)),
          lon: Number(launch.lon.toFixed(6)),
        },
        predictedLanding: {
          lat: Number(prediction.landing.lat.toFixed(6)),
          lon: Number(prediction.landing.lon.toFixed(6)),
          altitude: prediction.landing.altitude,
          datetime: prediction.landing.datetime,
        },
        missKm: Number(missKm.toFixed(3)),
        launchDistanceFromTargetKm: Number(launch.distanceFromTargetKm.toFixed(3)),
        source: prediction.source,
        metadata: prediction.metadata,
      });

      await sleep(requestDelayMs);
    }

    results.sort((a, b) => a.missKm - b.missKm);

    res.json({
      ok: true,
      target,
      settings: {
        ...params,
        searchRadiusKm,
        gridStepKm,
        maxPredictions,
        requestDelayMs,
        predictionApi: TAWHIRI_API_URL,
        useFallbackWhenBlocked,
      },
      totalTested: candidates.length,
      liveApiSuccesses,
      fallbackUses,
      failures: [...new Set(failures)].slice(0, 5),
      results: results.slice(0, topN),
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || "Unknown error" });
  }
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "Reverse HAB wrapper debug/fallback version is running.",
    predictionApi: TAWHIRI_API_URL,
  });
});

app.listen(PORT, () => {
  console.log(`Reverse HAB wrapper debug/fallback running on port ${PORT}`);
});
