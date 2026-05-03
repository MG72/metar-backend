import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import metarParser from "metar-parser";

const { parseMetar } = metarParser;

const app = express();
app.use(cors());

const PORT = 3000;

/* ========= tijdelijke test ========= */
app.get("/", (req, res) => {
  res.send("Server draait ✅");
});

app.listen(PORT, () => {
  console.log(`Server actief op http://localhost:${PORT}`);
});


/**
 * Station-coördinaten (NL vliegvelden) – uitbreidbaar
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

const KNMI_FILES_URL = `${KNMI_BASE}/datasets/${DATASET}/versions/${VERSION}/files`;

/** --------------- Helpers --------------- */

function authHeadersVariants() {
  const key = process.env.KNMI_API_KEY;
  if (!key) throw new Error("KNMI_API_KEY ontbreekt in environment");

  // KNMI accepteert soms Bearer, soms raw key. We proberen beide.
  return [
    { Authorization: key },
    { Authorization: `Bearer ${key}` }
  ];
}

async function fetchWithAuthRetry(url) {
  const variants = authHeadersVariants();
  let lastErr;

  for (const headers of variants) {
    const res = await fetch(url, { headers });
    if (res.ok) return res;

    const body = await res.text().catch(() => "");
    console.error("KNMI REQUEST FAIL");
    console.error("URL:", url);
    console.error("Status:", res.status, res.statusText);
    console.error("Body (eerste 500):", body.slice(0, 500));

    lastErr = new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }

  throw lastErr || new Error("Request mislukt (onbekend)");
}

/**
 * KNMI files bevatten vaak WMO-bulletin header vóór de XML.
 * Knip alles weg vóór '<?xml'
 */
function stripToXml(text) {
  const i = text.indexOf("<?xml");
  return i >= 0 ? text.slice(i) : text;
}

/**
 * Extract METAR rawText uit IWXXM XML.
 * Werkt met/zonder namespaceprefix (iwxxm:rawText of rawText) en met CDATA.
 */
function extractMetarStringsFromXml(xmlText) {
  const re = /<(?:(\w+):)?rawText\b[^>]*>([\s\S]*?)<\/(?:(\w+):)?rawText>/gi;
  const metars = [];
  let m;

  while ((m = re.exec(xmlText)) !== null) {
    const raw = m[2]
      .replace(/<!\[CDATA\[/g, "")
      .replace(/\]\]>/g, "")
      .trim();
    if (raw) metars.push(raw);
  }

  // Fallback: soms gebruikt men metarText
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

/** --------------- KNMI Flow --------------- */

async function fetchLatestMetarFilename() {
  const res = await fetchWithAuthRetry(KNMI_FILES_URL);
  const data = await res.json();

  const files = data.files || data.data?.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("Geen METAR files gevonden in KNMI response");
  }

  // Pak nieuwste op 'created'
  const latest = files.slice().sort((a, b) => new Date(b.created) - new Date(a.created))[0];
  if (!latest?.filename) throw new Error("METAR file heeft geen filename");

  return latest.filename;
}

async function getMetarDownloadUrl(filename) {
  const encoded = encodeURIComponent(filename);

  // De varianten die in de praktijk voorkomen bij KNMI Open Data:
  const candidates = [
    `${KNMI_BASE}/datasets/${DATASET}/versions/${VERSION}/files/${encoded}/url`,
    `${KNMI_BASE}/datasets/${DATASET}/versions/${VERSION}/files/${encoded}/download`,
    `${KNMI_BASE}/datasets/${DATASET}/versions/${VERSION}/files/${encoded}`
  ];

  for (const endpoint of candidates) {
    const res = await fetchWithAuthRetry(endpoint);

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      // Dit endpoint geeft direct content terug (zeldzaam)
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

  throw new Error("Kon geen download-URL vinden via bekende endpoints (/url, /download, metadata).");
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
    // Presigned S3 URL werkt meestal zonder auth
    let res = await fetch(url);
    if (!res.ok) {
      // Soms vereist het toch auth: fallback
      res = await fetchWithAuthRetry(url);
    }
    text = await res.text();
  }

  // Strip WMO header naar echte XML
  const xml = stripToXml(text);

  console.log("EERSTE 200 TEKENS XML:\n", xml.slice(0, 200));
  return xml;
}

/** --------------- METAR -> GeoJSON --------------- */

function metarToFeature(metarString) {
  let parsed;
  try {
    parsed = parseMetar(metarString);
  } catch {
    console.warn("Parse fout voor METAR:", metarString);
    return null;
  }

  const station = parsed.station;
  if (!station) return null;

  // Als je alleen NL stations wilt: filter op STATIONS
  if (!STATIONS[station]) {
    console.warn("Station niet in STATIONS:", station);
    return null;
  }

  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [STATIONS[station].lon, STATIONS[station].lat]
    },
    properties: {
      station,
      temperature: parsed.temperature?.value ?? null,
      wind_speed: parsed.wind?.speed ?? null,
      wind_dir: parsed.wind?.direction ?? null,
      visibility: parsed.visibility?.value ?? null,
      pressure: parsed.altimeter?.value ?? null,
      metar: metarString
    }
  };
}

/** --------------- Routes --------------- */

app.get("/", (req, res) => {
  res.send("METAR backend draait ✅");
});

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
