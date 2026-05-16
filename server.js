const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// You can change this in Render environment variables if SondeHub changes the URL.
// Common Tawhiri-style API path is /api/v1/
const TAWHIRI_API_URL =
  process.env.TAWHIRI_API_URL || "https://predict.sondehub.org/api/v1/";

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const EARTH_RADIUS_KM = 6371;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

function normalizeLongitudeForTawhiri(lon) {
  // Tawhiri docs expect longitude from 0 to 360.
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

function getFinalPredictionPoint(prediction) {
  if (!Array.isArray(prediction)) {
    throw new Error("Unexpected Tawhiri response: prediction was not an array.");
  }

  // Standard profile usually includes ascent and descent stages.
  const lastStage = prediction[prediction.length - 1];
  if (!lastStage || !Array.isArray(lastStage.trajectory)) {
    throw new Error("Unexpected Tawhiri response: missing trajectory.");
  }

  const finalPoint = lastStage.trajectory[lastStage.trajectory.length - 1];
  if (!finalPoint) {
    throw new Error("Unexpected Tawhiri response: empty trajectory.");
  }

  return {
    lat: Number(finalPoint.latitude),
    lon: normalizeLongitudeForMap(Number(finalPoint.longitude)),
    altitude: Number(finalPoint.altitude),
    datetime: finalPoint.datetime,
  };
}

async function runTawhiriPrediction(launch, params) {
  const url = new URL(TAWHIRI_API_URL);

  url.searchParams.set("profile", "standard_profile");
  url.searchParams.set("launch_latitude", String(launch.lat));
  url.searchParams.set("launch_longitude", String(normalizeLongitudeForTawhiri(launch.lon)));
  url.searchParams.set("launch_datetime", params.launchDatetime);
  url.searchParams.set("launch_altitude", String(params.launchAltitude));
  url.searchParams.set("ascent_rate", String(params.ascentRate));
  url.searchParams.set("burst_altitude", String(params.burstAltitude));
  url.searchParams.set("descent_rate", String(params.descentRate));

  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Reverse-HAB-Launch-Finder/1.0 non-commercial educational use"
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Tawhiri error ${response.status}: ${text.slice(0, 300)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Tawhiri did not return JSON. First response text: ${text.slice(0, 300)}`);
  }

  if (data.error) {
    throw new Error(`Tawhiri returned an error: ${JSON.stringify(data.error)}`);
  }

  const landing = getFinalPredictionPoint(data.prediction);
  return {
    launch,
    landing,
    rawMetadata: data.metadata || null,
    rawRequest: data.request || null,
  };
}

function validateNumber(value, name, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return n;
}

app.post("/api/reverse", async (req, res) => {
  try {
    const body = req.body || {};

    const target = {
      lat: validateNumber(body.targetLat, "targetLat", -90, 90),
      lon: validateNumber(body.targetLon, "targetLon", -180, 180),
    };

    const params = {
      launchDatetime: body.launchDatetime || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      launchAltitude: validateNumber(body.launchAltitude ?? 520, "launchAltitude", -500, 5000),
      ascentRate: validateNumber(body.ascentRate ?? 5, "ascentRate", 0.1, 20),
      burstAltitude: validateNumber(body.burstAltitude ?? 30000, "burstAltitude", 1000, 45000),
      descentRate: validateNumber(body.descentRate ?? 7, "descentRate", 0.1, 50),
    };

    const searchRadiusKm = validateNumber(body.searchRadiusKm ?? 120, "searchRadiusKm", 5, 500);
    const gridStepKm = validateNumber(body.gridStepKm ?? 20, "gridStepKm", 2, 100);
    const topN = Math.min(validateNumber(body.topN ?? 12, "topN", 1, 25), 25);

    // To be kind to the public API, cap how many forward predictions we run per request.
    // Start coarse. If this works, you can lower gridStepKm or add refinement.
    const maxPredictions = Math.min(validateNumber(body.maxPredictions ?? 90, "maxPredictions", 1, 150), 150);

    let candidates = buildCandidateLaunches(target, searchRadiusKm, gridStepKm);

    // Prefer closer-to-target launches first so the cap still gives reasonable nearby options.
    candidates = candidates
      .sort((a, b) => a.distanceFromTargetKm - b.distanceFromTargetKm)
      .slice(0, maxPredictions);

    const results = [];
    const failures = [];

    // Run in small batches to avoid hammering the public predictor.
    const batchSize = 5;

    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);

      const batchResults = await Promise.allSettled(
        batch.map(async (launch) => {
          const prediction = await runTawhiriPrediction(launch, params);
          const missKm = haversineKm(prediction.landing, target);

          return {
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
            metadata: prediction.rawMetadata,
          };
        })
      );

      for (const r of batchResults) {
        if (r.status === "fulfilled") results.push(r.value);
        else failures.push(String(r.reason?.message || r.reason).slice(0, 300));
      }
    }

    results.sort((a, b) => a.missKm - b.missKm);

    res.json({
      target,
      settings: {
        ...params,
        searchRadiusKm,
        gridStepKm,
        maxPredictions,
        predictionApi: TAWHIRI_API_URL,
      },
      totalTested: candidates.length,
      failures: failures.slice(0, 5),
      results: results.slice(0, topN),
    });
  } catch (err) {
    res.status(400).json({
      error: err.message || "Unknown error",
    });
  }
});

app.get("/health", (req, res) => {
  res.json({ ok: true, predictionApi: TAWHIRI_API_URL });
});

console.log("Server is running")

app.listen(PORT, () => {
  console.log(`Reverse HAB wrapper running on port ${PORT}`);
});
