import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { XMLParser } from "fast-xml-parser";

import { KNMI_API_KEY } from "./config/knmi.js";


// =====================
// App setup
// =====================
const app = express();
const PORT = process.env.PORT || 3000;

// Als frontend en backend op hetzelfde domein draaien, is CORS vaak niet nodig.
// Maar dit kan geen kwaad; je kunt het later aanscherpen naar je domein.
app.use(cors());

// Static frontend (MapLibre + tools) uit ./public
app.use(express.static("public"));

// =====================
// Paths & cache
// =====================
const ROOT = process.cwd();
const METAR_DIR = path.join(ROOT, "metar");

if (!fs.existsSync(METAR_DIR)) {
  fs.mkdirSync(METAR_DIR, { recursive: true });
}

function saveXml(station, xml) {
  fs.writeFileSync(path.join(METAR_DIR, `${station}.xml`), xml, "utf8");
}

function loadXml(station) {
  const p = path.join(METAR_DIR, `${station}.xml`);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

// =====================
// Stations (NL) - uitbreidbaar
// =====================
const STATIONS = {
  EHAM: { lon: 4.7639, lat: 52.3091 },
  EHRD: { lon: 4.4372, lat: 51.9569 },
  EHGG: { lon: 6.5794, lat: 53.1197 },
  EHEH: { lon: 5.3745, lat: 51.4501 },
  EHBK: { lon: 5.7700, lat: 50.9117 },
  EHLE: { lon: 5.5272, lat: 52.4603 }
};

// =====================
// KNMI API
// =====================
const KNMI_BASE = "https://api.dataplatform.knmi.nl/open-data/v1";
const DATASET = "metar";
const VERSION = "1.0";
const FILES_URL = `${KNMI_BASE}/datasets/${DATASET}/versions/${VERSION}/files`;

function authHeaders() {
  if (!KNMI_API_KEY) throw new Error("KNMI_API_KEY ontbreekt (config/knmi.js)");
  return { Authorization: KNMI_API_KEY };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`KNMI ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json();
}

function stripToXml(text) {
  // Soms zit er WMO-bulletin header vóór de XML
  const i = text.indexOf("<?xml");
  return i >= 0 ? text.slice(i) : text;
}

// =====================
// KNMI: laatste file per station (KNMI-conform)
// =====================
async function fetchLatestFileForStation(station) {
  const params = new URLSearchParams({
    maxKeys: "1",
    orderBy: "created",
    sorting: "desc",
    prefix: `_C_${station}_`
  });

  const data = await fetchJson(`${FILES_URL}?${params.toString()}`);
  return data.files?.[0]?.filename ?? null;
}

async function fetchLatestFilesPerStation(stations) {
  const out = {};
  for (const st of stations) {
    const fn = await fetchLatestFileForStation(st);
    if (fn) out[st] = fn;
  }
  return out;
}

async function downloadXmlByFilename(filename) {
  // KNMI geeft via /url een presigned download URL terug
  const meta = await fetchJson(`${FILES_URL}/${encodeURIComponent(filename)}/url`);
  const url = meta.temporaryDownloadUrl || meta.downloadUrl || meta.url;

  if (!url) throw new Error("Geen download URL ontvangen van KNMI");

  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Download XML mislukt ${res.status}: ${txt.slice(0, 200)}`);
  }

  const text = await res.text();
  return stripToXml(text);
}

// =====================
// Throttling (KNMI niet te vaak raken)
// =====================
let lastUpdate = 0;
const UPDATE_INTERVAL = 4 * 60 * 1000; // 4 minuten

function mayUpdate() {
  const now = Date.now();
  if (now - lastUpdate > UPDATE_INTERVAL) {
    lastUpdate = now;
    return true;
  }
  return false;
}

// =====================
// IWXXM parsing (XML -> properties)
// =====================
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  textNodeName: "text"
});

function deepFind(node, key) {
  if (node == null) return null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const v = deepFind(item, key);
      if (v != null) return v;
    }
    return null;
  }

  if (typeof node === "object") {
    if (Object.prototype.hasOwnProperty.call(node, key)) return node[key];
    for (const k of Object.keys(node)) {
      const v = deepFind(node[k], key);
      if (v != null) return v;
    }
  }

  return null;
}

function asNumber(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "object" && v.text != null) return asNumber(v.text);
  return null;
}

function asText(v) {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "object" && v.text != null) return String(v.text);
  return null;
}

function parseIwxxm(xml) {
  const obj = xmlParser.parse(xml);
  const m = obj?.METAR;
  if (!m) return null;

  const station =
    asText(deepFind(m, "locationIndicatorICAO")) ||
    asText(deepFind(m, "designator")) ||
    null;

  // obsTime: pak de eerste timePosition die je vindt (werkt in jouw XML’s)
  const obsTime = asText(deepFind(m, "timePosition"));

  return {
    station,
    obsTime,
    temperature_c: asNumber(deepFind(m, "airTemperature")),
    dewpoint_c: asNumber(deepFind(m, "dewpointTemperature")),
    qnh_hpa: asNumber(deepFind(m, "qnh")),
    wind_dir_deg: asNumber(deepFind(m, "meanWindDirection")),
    wind_speed: asNumber(deepFind(m, "meanWindSpeed"))
  };
}

// =====================
// Routes
// =====================
app.get("/", (req, res) => {
  res.send("METAR backend draait ✅");
});

/**
 * GeoJSON endpoint:
 * - gebruikt lokale cache altijd als fallback
 * - haalt (gethrottled) nieuwste file per station op en update cache
 * - force=1 om throttling te negeren (handig voor debug)
 */
app.get("/metar.geojson", async (req, res) => {
  try {
    const stations = Object.keys(STATIONS);
    const force = req.query.force === "1";

    let latest = {};

    if (force || mayUpdate()) {
      try {
        latest = await fetchLatestFilesPerStation(stations);
      } catch (e) {
        // KNMI niet bereikbaar → cache gebruiken
      }
    }

    const features = [];

    for (const st of stations) {
      let xml = null;

      // Probeer update als we een latest filename hebben
      if (latest[st]) {
        try {
          xml = await downloadXmlByFilename(latest[st]);
          saveXml(st, xml);
        } catch (e) {
          xml = loadXml(st);
        }
      } else {
        xml = loadXml(st);
      }

      if (!xml) continue;

      const props = parseIwxxm(xml);
      if (!props) continue;

      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [STATIONS[st].lon, STATIONS[st].lat]
        },
        properties: {
          ...props,
          cached: !latest[st] // handig voor styling (grijs bij cache-only)
        }
      });
    }

    res.json({ type: "FeatureCollection", features });
  } catch (err) {
    res.status(500).json({ error: "METAR verwerking mislukt", message: err.message });
  }
});

// ======================
// KNMI proxy endpoints
// ======================

// Lijst METAR bestanden
app.get("/api/metar/files", async (req, res) => {
  try {
    const url = `${FILES_URL}?orderBy=created&sorting=desc`;
    const data = await fetchJson(url);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download-URL voor bestand
app.get("/api/metar/file-url/:filename", async (req, res) => {
  try {
    const filename = req.params.filename;
    const meta = await fetchJson(
      `${FILES_URL}/${encodeURIComponent(filename)}/url`
    );
    res.json(meta);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`METAR backend actief op poort ${PORT}`);
});
