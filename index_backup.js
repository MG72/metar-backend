import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { XMLParser } from "fast-xml-parser";

import { KNMI_API_KEY } from "./config/knmi.js";

function authHeaders() {
  if (!KNMI_API_KEY) {
    throw new Error("KNMI_API_KEY ontbreekt");
  }
  return {
    Authorization: KNMI_API_KEY
  };
}


// =====================
// Basis setup
// =====================
const app = express();
const PORT = process.env.PORT || 3000;

// ✅ CORS: frontend zit op hetzelfde domein → permissief ok
app.use(cors());

// ✅ Static frontend (MapLibre + tools)
app.use(express.static("public"));

// =====================
// Paden & constants
// =====================
const ROOT = process.cwd();
const METAR_DIR = path.join(ROOT, "metar");

if (!fs.existsSync(METAR_DIR)) {
  fs.mkdirSync(METAR_DIR, { recursive: true });
}

const STATIONS = {
  EHAM: { lon: 4.7639, lat: 52.3091 },
  EHRD: { lon: 4.4372, lat: 51.9569 },
  EHGG: { lon: 6.5794, lat: 53.1197 },
  EHEH: { lon: 5.3745, lat: 51.4501 },
  EHBK: { lon: 5.7700, lat: 50.9117 }
};

const KNMI_BASE = "https://api.dataplatform.knmi.nl/open-data/v1";
const DATASET = "metar";
const VERSION = "1.0";
const FILES_URL = `${KNMI_BASE}/datasets/${DATASET}/versions/${VERSION}/files`;

// =====================
// KNMI helpers
// =====================
function authHeaders() {
  const key = process.env.KNMI_API_KEY;
  if (!key) throw new Error("KNMI_API_KEY ontbreekt");
  return { Authorization: key };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`KNMI ${res.status}: ${txt}`);
  }
  return res.json();
}

async function fetchLatestFileForStation(station) {
  const params = new URLSearchParams({
    maxKeys: "1",
    orderBy: "created",
    sorting: "desc",
    prefix: `_C_${station}_`
  });
  const data = await fetchJson(`${FILES_URL}?${params}`);
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

async function downloadXml(filename) {
  const meta = await fetchJson(
    `${FILES_URL}/${encodeURIComponent(filename)}/url`
  );
  const url =
    meta.temporaryDownloadUrl ||
    meta.downloadUrl ||
    meta.url;

  const res = await fetch(url);
  if (!res.ok) throw new Error("Download XML mislukt");
  const text = await res.text();
  const i = text.indexOf("<?xml");
  return i >= 0 ? text.slice(i) : text;
}

function saveXml(station, xml) {
  fs.writeFileSync(path.join(METAR_DIR, `${station}.xml`), xml, "utf8");
}

function loadXml(station) {
  const p = path.join(METAR_DIR, `${station}.xml`);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

// =====================
// Throttling
// =====================
let lastUpdate = 0;
const UPDATE_INTERVAL = 4 * 60 * 1000;

function mayUpdate() {
  const now = Date.now();
  if (now - lastUpdate > UPDATE_INTERVAL) {
    lastUpdate = now;
    return true;
  }
  return false;
}

// =====================
// IWXXM parsing
// =====================
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  textNodeName: "text"
});

function deepFind(node, key) {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const v = deepFind(n, key);
      if (v != null) return v;
    }
  } else if (typeof node === "object") {
    if (node[key] != null) return node[key];
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
  if (typeof v === "string") return Number(v.replace(",", "."));
  if (typeof v === "object" && v.text != null) return asNumber(v.text);
  return null;
}

function asText(v) {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object" && v.text != null) return String(v.text);
  return null;
}

function parseIwxxm(xml) {
  const obj = xmlParser.parse(xml);
  const m = obj?.METAR;
  if (!m) return null;

  return {
    station:
      asText(deepFind(m, "locationIndicatorICAO")) ||
      asText(deepFind(m, "designator")),
    obsTime: asText(deepFind(m, "timePosition")),
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

app.get("/metar.geojson", async (req, res) => {
  try {
    const stations = Object.keys(STATIONS);
    let latest = {};

    if (mayUpdate()) {
      try {
        latest = await fetchLatestFilesPerStation(stations);
      } catch {
        // KNMI niet bereikbaar → cache gebruiken
      }
    }

    const features = [];

    for (const st of stations) {
      let xml = null;

      if (latest[st]) {
        try {
          xml = await downloadXml(latest[st]);
          saveXml(st, xml);
        } catch {
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
        properties: props
      });
    }

    res.json({ type: "FeatureCollection", features });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================
// Start
// =====================
app.listen(PORT, () => {
  console.log(`METAR backend actief op poort ${PORT}`);
});