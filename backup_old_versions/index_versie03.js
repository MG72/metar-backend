import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import metarParser from "metar-parser";

const { parseMetar } = metarParser;

const app = express();
app.use(cors());

const PORT = 3000;


app.get("/", (req, res) => {
  res.send("Server draait ✅");
});

app.listen(PORT, () => {
  console.log(`Server actief op http://localhost:${PORT}`);
});



const STATIONS = {
  EHAM: { lon: 4.7639, lat: 52.3091 }, // Schiphol
  EHRD: { lon: 4.4372, lat: 51.9569 }, // Rotterdam
  EHGG: { lon: 6.5794, lat: 53.1197 }, // Groningen
  EHEH: { lon: 5.3745, lat: 51.4501 }, // Eindhoven
  EHBK: { lon: 5.7700, lat: 50.9117 }  // Maastricht
};

const KNMI_BASE = "https://api.dataplatform.knmi.nl/open-data/v1";
const DATASET = "metar";
const VERSION = "1.0";
const KNMI_FILES_URL = `${KNMI_BASE}/datasets/${DATASET}/versions/${VERSION}/files`;

/** ---------- Helpers ---------- */

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

/**
 * KNMI-bestanden bevatten vaak WMO header vóór de XML.
 * Knip alles weg vóór '<?xml'
 */
function stripToXml(text) {
  const i = text.indexOf("<?xml");
  return i >= 0 ? text.slice(i) : text;
}

/**
 * Extract METAR-string(s) uit IWXXM XML.
 * We zoeken naar <rawText> ... </rawText> (met of zonder namespaceprefix).
 */
function extractMetarStringsFromXml(xmlText) {
  const metars = [];
  const re = /<(?:(\w+):)?rawText\b[^>]*>([\s\S]*?)<\/(?:(\w+):)?rawText>/gi;
  let m;

  while ((m = re.exec(xmlText)) !== null) {
    const raw = m[2]
      .replace(/<!\[CDATA\[/g, "")
      .replace(/\]\]>/g, "")
      .trim();
    if (raw) metars.push(raw);
  }

  // Fallback: soms heet het element metarText
  if (metars.length === 0) {
    const re2 = /<(?:(\w+):)?metarText\b[^>]*>([\s\S]*?)<\/(?:(\w+):)?metarText>/gi;
    while ((m = re2.exec(xmlText)) !== null) {
      const raw = m[2]
        .replace(/<!\[CDATA\[/g, "")
        .replace(/\]\]>/g, "")
        .trim();
      if (raw) metars.push(raw);
    }
  }

  return metars;
}

/** ---------- KNMI flow ---------- */

async function fetchLatestMetarFilename() {
  const res = await fetchWithAuthRetry(KNMI_FILES_URL);
  const data = await res.json();

  const files = data.files || data.data?.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("Geen METAR files gevonden in KNMI response");
  }

  const latest = files.slice().sort((a, b) => new Date(b.created) - new Date(a.created))[0];
  if (!latest?.filename) throw new Error("Laatste file heeft geen filename");

  return latest.filename;
}

/**
 * Haal een download-URL op voor het bestand.
 * In jouw logs zagen we dat dit een presigned S3 URL kan zijn.
 */
async function getMetarDownloadUrl(filename) {
  const encoded = encodeURIComponent(filename);

  // KNMI API varianten: /url of /download (soms /{file} met links)
  const candidates = [
    `${KNMI_BASE}/datasets/${DATASET}/versions/${VERSION}/files/${encoded}/url`,
    `${KNMI_BASE}/datasets/${DATASET}/versions/${VERSION}/files/${encoded}/download`,
    `${KNMI_BASE}/datasets/${DATASET}/versions/${VERSION}/files/${encoded}`
  ];

  for (const endpoint of candidates) {
    const res = await fetchWithAuthRetry(endpoint);
    const contentType = res.headers.get("content-type") || "";

    // Soms zou een endpoint direct de content kunnen geven, maar meestal JSON.
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

async function fetchKnmiMetarXml() {
  const filename = await fetchLatestMetarFilename();
  console.log("Laatste METAR filename:", filename);

  const { directContent, url } = await getMetarDownloadUrl(filename);
  console.log("Gebruik download route:", url, "directContent=", directContent);

  let text;

  if (directContent) {
    const res = await fetchWithAuthRetry(url);
    text = await res.text();
  } else {
    // presigned S3 URL werkt meestal zonder auth
    let res = await fetch(url);
    if (!res.ok) {
      // fallback: toch auth proberen
      res = await fetchWithAuthRetry(url);
    }
    text = await res.text();
  }

  const xml = stripToXml(text);
  console.log("EERSTE 120 TEKENS XML:\n", xml.slice(0, 120));
  return xml;
}

/** ---------- METAR -> GeoJSON ---------- */

function metarToFeature(metarString) {
  const cleaned = metarString.trim();

  let parsed;
  try {
    parsed = parseMetar(cleaned);
  } catch (e) {
    console.warn("Parse fout:", cleaned);
    return null;
  }

  const station = parsed.station;
  if (!station) return null;

  // Alleen NL stations: filter op STATIONS
  const coords = STATIONS[station];
  if (!coords) {
    console.warn("Station niet in STATIONS:", station);
    return null;
  }

  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [coords.lon, coords.lat]
    },
    properties: {
      station,
      temperature: parsed.temperature?.value ?? null,
      wind_speed: parsed.wind?.speed ?? null,
      wind_dir: parsed.wind?.direction ?? null,
      visibility: parsed.visibility?.value ?? null,
      pressure: parsed.altimeter?.value ?? null,
      metar: cleaned
    }
  };
}

/** ---------- Routes ---------- */

app.get("/", (req, res) => {
  res.send("METAR backend draait ✅");
});

/**
 * Debug: laat zien of we XML kunnen downloaden + hoeveel METAR strings eruit komen
 */
app.get("/debug/metar", async (req, res) => {
  try {
    const xml = await fetchKnmiMetarXml();
    const metarStrings = extractMetarStringsFromXml(xml);
    res.json({
      metarStringsCount: metarStrings.length,
      firstMetar: metarStrings[0] || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GeoJSON endpoint voor MapLibre
 */
app.get("/metar.geojson", async (req, res) => {
  try {
    const xml = await fetchKnmiMetarXml();
    const metarStrings = extractMetarStringsFromXml(xml);

    console.log("Aantal METAR-strings:", metarStrings.length);
    console.log("METAR strings (eerste 3):", metarStrings.slice(0, 3));

    const features = metarStrings.map(metarToFeature).filter(Boolean);

    console.log("Aantal METAR features:", features.length);

    res.json({ type: "FeatureCollection", features });
  } catch (err) {
    console.error("METAR ERROR ↓↓↓");
    console.error(err);
    res.status(500).json({
      error: "METAR verwerking mislukt",
      message: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server actief op http://localhost:${PORT}`);
});


