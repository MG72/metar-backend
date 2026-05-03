import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import metarParser from "metar-parser";

const { parseMetar } = metarParser;

const app = express();
app.use(cors());
const PORT = 3000;

/**
 * Station-coördinaten (NL vliegvelden) – uitbreidbaar
 */
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

/* ----------------- KNMI helpers ----------------- */

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
  // KNMI plakt soms WMO-bulletin header vóór XML
  const i = text.indexOf("<?xml");
  return i >= 0 ? text.slice(i) : text;
}

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
      // zeldzaam: direct content
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
  const { directContent, url } = await getMetarDownloadUrl(filename);

  let text;

  if (directContent) {
    const res = await fetchWithAuthRetry(url);
    text = await res.text();
  } else {
    // presigned S3 URL werkt meestal zonder auth
    let res = await fetch(url);
    if (!res.ok) res = await fetchWithAuthRetry(url);
    text = await res.text();
  }

  return stripToXml(text);
}

/* ----------------- XML -> METAR strings ----------------- */

function extractMetarStringsFromXml(xmlText) {
  const metars = [];

  // 1) Probeer rawText (met/zonder namespace)
  const reRaw = /<[^>]*rawText\b[^>]*>([\s\S]*?)<\/[^>]*rawText>/gi;
  let m;
  while ((m = reRaw.exec(xmlText)) !== null) {
    const raw = m[1].replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").trim();
    if (raw) metars.push(raw);
  }

  // 2) Probeer metarText (fallback)
  if (metars.length === 0) {
    const reMetarText = /<[^>]*metarText\b[^>]*>([\s\S]*?)<\/[^>]*metarText>/gi;
    while ((m = reMetarText.exec(xmlText)) !== null) {
      const raw = m[1].replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").trim();
      if (raw) metars.push(raw);
    }
  }

  // 3) Laatste redmiddel: zoek een “METAR-achtige” regel in de tekst (ICAO + tijd Z)
  // Dit werkt alleen als de ruwe METAR ergens als platte tekst in de XML/bulletin staat.
  if (metars.length === 0) {
    const reLine = /\b[A-Z]{4}\s+\d{6}Z\b[^\r\n<]*/g; // tot newline of '<'
    const matches = xmlText.match(reLine) || [];
    for (const s of matches) {
      const cleaned = s.trim();
      if (cleaned) metars.push(cleaned);
    }
  }

  // Uniek maken
  return [...new Set(metars)];
}

/* XML INPSECTIE */
function findSnippet(haystack, needle, radius = 200) {
  const i = haystack.indexOf(needle);
  if (i === -1) return null;
  const start = Math.max(0, i - radius);
  const end = Math.min(haystack.length, i + needle.length + radius);
  return haystack.slice(start, end);
}

function listFirstTags(xmlText, limit = 60) {
  const tags = [];
  const re = /<\s*\/?\s*([A-Za-z0-9:_-]+)\b/g;
  let m;
  while ((m = re.exec(xmlText)) !== null && tags.length < limit) {
    tags.push(m[1]);
  }
  return tags;
}



/* ----------------- METAR -> GeoJSON ----------------- */

function metarToFeature(metarString) {
  const cleaned = metarString.trim();

  let parsed;
  try {
    parsed = parseMetar(cleaned);
  } catch {
    console.warn("Parse fout:", cleaned);
    return null;
  }

  const station = parsed.station;
  if (!station) return null;

  const coords = STATIONS[station];
  if (!coords) {
    // Alleen NL? Laat dan weg; voor debug kun je dit ook als "unknown" opnemen.
    console.warn("Station niet in STATIONS:", station);
    return null;
  }

  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [coords.lon, coords.lat] },
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

/* ----------------- Routes ----------------- */

app.get("/", (req, res) => {
  res.send("METAR backend draait ✅");
});

/** Debug: toont aantal METAR strings + eerste METAR */
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

/** GeoJSON endpoint voor MapLibre */
app.get("/metar.geojson", async (req, res) => {
  try {
    const xml = await fetchKnmiMetarXml();
    const metarStrings = extractMetarStringsFromXml(xml);

    const features = metarStrings.map(metarToFeature).filter(Boolean);

    res.json({ type: "FeatureCollection", features });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "METAR verwerking mislukt", message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server actief op http://localhost:${PORT}`);
});

app.get("/debug/xml-inspect", async (req, res) => {
  try {
    const xml = await fetchKnmiMetarXml();

    res.json({
      length: xml.length,
      startsWithXml: xml.startsWith("<?xml"),
      contains: {
        rawText: xml.includes("rawText"),
        metarText: xml.includes("metarText"),
        METAR: xml.includes("METAR"),
        iwxxm: xml.includes("iwxxm"),
      },
      snippet: {
        rawText: findSnippet(xml, "rawText"),
        metarText: findSnippet(xml, "metarText"),
        METAR: findSnippet(xml, "METAR"),
      },
      firstTags: listFirstTags(xml, 80)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});