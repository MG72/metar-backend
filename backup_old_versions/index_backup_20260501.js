import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";
import fs from "fs";
import path from "path";

const METAR_DIR = path.join(process.cwd(), "metar");

// Zorg dat map bestaat
if (!fs.existsSync(METAR_DIR)) {
  fs.mkdirSync(METAR_DIR);
}


const app = express();
app.use(cors());
app.use(express.static("public"))

const PORT = 3000;

/**
 * Station-coördinaten (NL vliegvelden)
 */
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
/*const KNMI_FILES_URL = `${KNMI_BASE}/datasets/${DATASET}/versions/${VERSION}/files`;*/
const KNMI_FILES_URL = "https://api.dataplatform.knmi.nl/open-data/v1/datasets/metar/versions/1.0/files";
/*----------------- Functie opslaan XML per station en update -----------------*/

function saveMetarXml(station, xmlText) {
  const filePath = path.join(METAR_DIR, `${station}.xml`);
  fs.writeFileSync(filePath, xmlText, "utf8");
}

async function updateMetarForStation(station, filename) {
  try {
    const xml = await downloadXmlForFilename(filename);
    saveMetarXml(station, xml);
    return xml;
  } catch (err) {
    console.warn(`KNMI niet bereikbaar voor ${station}, gebruik cache`);
    return loadMetarXml(station);
  }
}

/* uit KNMI code */

async function fetchLatestFileForStation(station) {
  const params = new URLSearchParams({
    maxKeys: "1",
    orderBy: "created",
    sorting: "desc",
    prefix: `_C_${station}_`
  });

  const url = `${KNMI_FILES_URL}?${params.toString()}`;
  const res = await fetchWithAuthRetry(url);
  const data = await res.json();

  if (!data.files || data.files.length === 0) return null;
  return data.files[0].filename;
}

async function fetchLatestFilesPerStation(stations) {
  const result = {};
  for (const station of stations) {
    const filename = await fetchLatestFileForStation(station);
    if (filename) result[station] = filename;
  }
  return result;
}



/*----------------- Lezen van lokale METAR XML -----------------*/

function loadMetarXml(station) {
  const filePath = path.join(METAR_DIR, `${station}.xml`);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

/* ----------------- Auth / fetch helpers ----------------- */

function authHeaderVariants() {
  const key = process.env.KNMI_API_KEY;
  if (!key) throw new Error("KNMI_API_KEY ontbreekt in environment (setx KNMI_API_KEY ...)");
  return [
    { Authorization: key },
    { Authorization: `Bearer ${key}` }
  ];
}

async function fetchWithAuthRetry(url) {
  const variants = authHeaderVariants();
  let lastErr;

  for (const headers of variants) {
    const res = await fetch(url, { headers });
    if (res.ok) return res;

    const body = await res.text().catch(() => "");
    lastErr = new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  throw lastErr || new Error("Request mislukt (onbekend)");
}

function stripToXml(text) {
  const i = text.indexOf("<?xml");
  return i >= 0 ? text.slice(i) : text;
}

/**
 * Download-url ophalen (presigned S3) via /url, /download of metadata endpoint
 */
async function getMetarDownloadUrl(filename) {
  const encoded = encodeURIComponent(filename);

  const candidates = [
    `${KNMI_BASE}/datasets/${DATASET}/versions/${VERSION}/files/${encoded}/url`,
    `${KNMI_BASE}/datasets/${DATASET}/versions/${VERSION}/files/${encoded}/download`,
    `${KNMI_BASE}/datasets/${DATASET}/versions/${VERSION}/files/${encoded}`
  ];

  for (const endpoint of candidates) {
    const res = await fetchWithAuthRetry(endpoint);
    const contentType = res.headers.get("content-type") || "";

    if (!contentType.includes("application/json")) {
      return { directContent: true, url: endpoint };
    }

    const data = await res.json();
    const downloadUrl =
      data.downloadUrl ||
      data.temporaryDownloadUrl ||
      data.url ||
      data.href ||
      data.links?.download?.href ||
      data.links?.content?.href;

    if (downloadUrl) return { directContent: false, url: downloadUrl };
  }

  throw new Error("Kon geen download URL vinden via /url, /download of metadata endpoint");
}

/* ----------------- XML parsing helpers ----------------- */

/**
 * Parse IWXXM XML naar JS object; namespaces verwijderen helpt enorm.
 * We gebruiken textNodeName="text" zodat tekstwaarden makkelijker zijn.
 */
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  textNodeName: "text"
});

function deepFind(node, key) {
  // zoekt eerste occurrence van key in object tree
  if (node == null) return undefined;

  if (Array.isArray(node)) {
    for (const item of node) {
      const v = deepFind(item, key);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  if (typeof node === "object") {
    if (Object.prototype.hasOwnProperty.call(node, key)) return node[key];
    for (const k of Object.keys(node)) {
      const v = deepFind(node[k], key);
      if (v !== undefined) return v;
    }
  }

  return undefined;
}

function asNumber(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "object") {
    // fast-xml-parser kan { text: "12", "@_uom": "Cel" } geven
    if (v.text != null) return asNumber(v.text);
  }
  return null;
}

function asText(v) {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    if (v.text != null) return String(v.text);
  }
  return null;
}

/**
 * IWXXM -> properties object
 */
function parseIwxxmMetar(xmlText) {
  const obj = xmlParser.parse(xmlText);

  // Root is METAR na removeNSPrefix
  const metar = obj?.METAR;
  if (!metar) {
    return { error: "Geen METAR root gevonden", rawKeys: Object.keys(obj || {}) };
  }

  const station =
    asText(deepFind(metar, "locationIndicatorICAO")) ||
    asText(deepFind(metar, "designator")) ||
    null;

  // Temperatuur / dauwpunt / qnh kunnen direct waarde of Measure object zijn
  const airTemperature = deepFind(metar, "airTemperature");
  const dewpointTemperature = deepFind(metar, "dewpointTemperature");
  const qnh = deepFind(metar, "qnh");

  // Wind
  const meanWindDirection = deepFind(metar, "meanWindDirection");
  const meanWindSpeed = deepFind(metar, "meanWindSpeed");

  // Tijd (er zijn meerdere timePosition tags; we pakken observationTime zo goed mogelijk)
  const observationTime = deepFind(metar, "observationTime");
  const issueTime = deepFind(metar, "issueTime");

  // Probeer timePosition string te vinden binnen observationTime/issueTime
  const obsTime = asText(deepFind(observationTime, "timePosition")) || asText(deepFind(issueTime, "timePosition"));

  return {
    station,
    obsTime,
    temperature_c: asNumber(airTemperature),
    dewpoint_c: asNumber(dewpointTemperature),
    qnh_hpa: asNumber(qnh),
    wind_dir_deg: asNumber(meanWindDirection),
    wind_speed: asNumber(meanWindSpeed),
    // units als ze aanwezig zijn
    temperature_uom: airTemperature?.["@_uom"] || airTemperature?.["@_uom"] || null,
    dewpoint_uom: dewpointTemperature?.["@_uom"] || null,
    qnh_uom: qnh?.["@_uom"] || null,
    wind_speed_uom: meanWindSpeed?.["@_uom"] || null
  };
}

/* ----------------- File selection: latest per station ----------------- */

function matchesStation(filename, station) {
  // jouw filenames lijken op: A_LANL80EHAM..._C_EHAM_....xml
  // We matchen op "_C_EHAM_" als voorkeur, anders op station ergens in de naam.
  return filename.includes(`_C_${station}_`) || filename.includes(station);
}

async function fetchLatestFilenamesForStations(stations) {
  const res = await fetchWithAuthRetry(KNMI_FILES_URL);
  const data = await res.json();
  const files = data.files || data.data?.files;

  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("Geen METAR files gevonden in KNMI response");
  }

  const result = {};
  for (const station of stations) {
    const stationFiles = files
      .filter(f => f?.filename && matchesStation(f.filename, station))
      .slice()
      .sort((a, b) => new Date(b.created) - new Date(a.created));

    if (stationFiles.length > 0) result[station] = stationFiles[0].filename;
  }

  return result;
}

async function downloadXmlForFilename(filename) {
  const { directContent, url } = await getMetarDownloadUrl(filename);

  let text;
  if (directContent) {
    const res = await fetchWithAuthRetry(url);
    text = await res.text();
  } else {
    let res = await fetch(url); // presigned S3 meestal zonder auth
    if (!res.ok) res = await fetchWithAuthRetry(url);
    text = await res.text();
  }

  return stripToXml(text);
}



/* ----------------- Routes ----------------- */

app.get("/", (req, res) => {
  res.send("METAR backend draait ✅");
});

/**
 * Debug: laat zien welke latest filenames we per station pakken
 */
app.get("/debug/latest-files", async (req, res) => {
  try {
    const latest = await fetchLatestFilenamesForStations(Object.keys(STATIONS));
    res.json(latest);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Debug: parse 1 station (EHAM) en laat properties zien
 */
app.get("/debug/parsed", async (req, res) => {
  try {
    const latest = await fetchLatestFilenamesForStations(["EHAM"]);
    const filename = latest.EHAM;
    if (!filename) return res.json({ error: "Geen latest file gevonden voor EHAM" });

    const xml = await downloadXmlForFilename(filename);
    const props = parseIwxxmMetar(xml);
    res.json({ filename, props });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GeoJSON endpoint (alle NL stations in STATIONS)
 */

app.get("/metar.geojson", async (req, res) => {
  try {
    const stations = Object.keys(STATIONS);
    let latestFiles = {};

    // ✅ HIER: bepaal of we KNMI mogen raken
    if (mayUpdate()) {
      try {
        latestFiles = await fetchLatestFilesPerStation(stations);
      } catch (e) {
        console.warn("KNMI niet bereikbaar, gebruik cache");
      }
    }

    const features = [];

    for (const station of stations) {
      let xml = null;

      // ✅ Probeer te updaten als we een nieuw bestand kennen
      if (latestFiles[station]) {
        xml = await updateMetarForStation(station, latestFiles[station]);
      }

      // ✅ Altijd fallback naar lokale cache
      if (!xml) {
        xml = loadMetarXml(station);
      }

      if (!xml) continue;

      const props = parseIwxxmMetar(xml);
      const coords = STATIONS[station];

      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [coords.lon, coords.lat]
        },
        properties: {
          ...props,
          station,
          cached: !latestFiles[station]
        }
      });
    }

    res.json({
      type: "FeatureCollection",
      features
    });

  } catch (err) {
    res.status(500).json({
      error: "METAR verwerking mislukt",
      message: err.message
    });
  }
});



/* app.get("/metar.geojson", async (req, res) => {
  try {
    const stations = Object.keys(STATIONS);
    let latestFiles = {};

    // Probeer KNMI (best effort)
    try {
      latestFiles = await fetchLatestFilesPerStation(stations);
    } catch {
      console.warn("KNMI niet bereikbaar, gebruik alleen cache");
    }

    const features = [];

    for (const station of stations) {
      let xml = null;

      if (latestFiles[station]) {
        xml = await updateMetarForStation(station, latestFiles[station]);
      }

      if (!xml) {
        xml = loadMetarXml(station);
      }

      if (!xml) continue;

      const props = parseIwxxmMetar(xml);
      const coords = STATIONS[station];

      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [coords.lon, coords.lat]
        },
        properties: {
          ...props,
          station,
          cached: !latestFiles[station]
        }
      });
    }

    res.json({
      type: "FeatureCollection",
      features
    });

  } catch (err) {
    res.status(500).json({
      error: "METAR verwerking mislukt",
      message: err.message
    });
  }
}); */


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


app.listen(PORT, () => {
  console.log(`Server actief op http://localhost:${PORT}`);
});