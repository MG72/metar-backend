import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import metarParser from "metar-parser";
import { XMLParser } from "fast-xml-parser";

const { parseMetar } = metarParser;


const app = express();
app.use(cors());

const PORT = 3000;

/**
 * Vaste station-coördinaten (NL vliegvelden)
 * Uit te breiden wanneer nodig
 */
const STATIONS = {
  EHAM: { lon: 4.7639, lat: 52.3091 }, // Schiphol
  EHRD: { lon: 4.4372, lat: 51.9569 }, // Rotterdam
  EHGG: { lon: 6.5794, lat: 53.1197 }, // Groningen
  EHEH: { lon: 5.3745, lat: 51.4501 }, // Eindhoven
  EHBK: { lon: 5.7700, lat: 50.9117 }  // Maastricht
};

/**
 * KNMI METAR bron (pas aan indien nodig)
 */
const KNMI_METAR_URL =
  "https://www.knmi.nl/actueel/metar.txt"; // voorbeeld

const KNMI_BASE = "https://api.dataplatform.knmi.nl/open-data/v1";
const DATASET = "metar";
const VERSION = "1.0";

const KNMI_FILES_URL =
  `${KNMI_BASE}/datasets/${DATASET}/versions/${VERSION}/files`;


  
// debug spul
function authHeaders() {
  const key = process.env.KNMI_API_KEY;
  if (!key) throw new Error("KNMI_API_KEY ontbreekt in environment");

  // We proberen beide varianten; de helper hieronder gebruikt ze.
  return [
    { Authorization: key },
    { Authorization: `Bearer ${key}` }
  ];
}

function extractMetarStringsFromXml(xmlText) {
  const parser = new XMLParser({
    ignoreAttributes: false
  });

  const parsed = parser.parse(xmlText);

  // KNMI METAR XML kan 1 of meerdere reports bevatten
  const reports =
    parsed?.meteorologicalAerodromeReport ||
    parsed?.meteorologicalAerodromeReports?.meteorologicalAerodromeReport;

  if (!reports) {
    console.warn("Geen METAR reports gevonden in XML");
    return [];
  }

  const reportArray = Array.isArray(reports) ? reports : [reports];

  return reportArray
    .map(r => r.metarText)
    .filter(Boolean);
}


async function fetchWithAuthRetry(url) {
  const variants = authHeaders();
  let lastErr;

  for (const headers of variants) {
    const res = await fetch(url, { headers });

    // Succes: meteen terug
    if (res.ok) return res;

    // Debug: lees body (vaak staat er een duidelijke fouttekst in)
    const body = await res.text().catch(() => "");
    console.error("KNMI DOWNLOAD FAIL");
    console.error("URL:", url);
    console.error("Auth header used:", headers.Authorization.startsWith("Bearer ") ? "Bearer ***" : "***");
    console.error("Status:", res.status, res.statusText);
    console.error("Response body (eerste 500):", body.slice(0, 500));

    lastErr = new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }

  throw lastErr || new Error("Download mislukt (onbekend)");
}  


async function getMetarDownloadUrl(filename) {
  const encoded = encodeURIComponent(filename);

  // Verschillende KNMI Open Data API varianten die in omloop zijn.
  // We proberen ze één voor één.
  const candidates = [
    `${KNMI_BASE}/datasets/${DATASET}/versions/${VERSION}/files/${encoded}/url`,
    `${KNMI_BASE}/datasets/${DATASET}/versions/${VERSION}/files/${encoded}/download`,
    `${KNMI_BASE}/datasets/${DATASET}/versions/${VERSION}/files/${encoded}`, // soms zit URL in metadata response
  ];

  for (const url of candidates) {
    const res = await fetchWithAuthRetry(url);

    // Sommige endpoints geven direct content (niet JSON). Detecteer dat:
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      // Dit endpoint gaf blijkbaar direct filecontent terug (bv. XML)
      // In dat geval gebruiken we dit "url" als downloadUrl-sentinel:
      return { directContent: true, url };
    }

    const data = await res.json();

    // Mogelijke velden waarin een presigned download URL kan zitten
    const downloadUrl =
      data.downloadUrl ||
      data.temporaryDownloadUrl ||
      data.url ||
      data.href ||
      data.links?.download?.href ||
      data.links?.content?.href ||
      data.files?.[0]?.downloadUrl;

    if (downloadUrl) {
      return { directContent: false, url: downloadUrl };
    }

    // Debug om te zien wat er terugkomt
    console.log("Geen downloadUrl gevonden in response van:", url);
    console.log("Response keys:", Object.keys(data));
  }

  throw new Error("Kon geen download-URL vinden via bekende endpoints (/url, /download, metadata).");
}

 

async function fetchLatestMetarFile() {
  const response = await fetchWithAuthRetry(KNMI_FILES_URL);
  const data = await response.json();

  const files = data.files || data.data?.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("Geen METAR files gevonden in KNMI response");
  }

  const latestFile = files.sort(
    (a, b) => new Date(b.created) - new Date(a.created)
  )[0];

  if (!latestFile.filename) {
    throw new Error("METAR file heeft geen filename");
  }

  return latestFile.filename;
}

function extractMetarStringsFromXml(xmlText) {
  // Zoek rawText met of zonder namespaceprefix (iwxxm:rawText of rawText)
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

  // Fallback: sommige feeds gebruiken metarText
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

async function fetchKnmiMetars() {
  const filename = await fetchLatestMetarFile();
  console.log("Laatste METAR filename:", filename);

  const { directContent, url } = await getMetarDownloadUrl(filename);
  console.log("Gebruik download route:", url, "directContent=", directContent);

  let xmlText;

  if (directContent) {
    // Endpoint gaf direct content terug
    const res = await fetchWithAuthRetry(url);
    xmlText = await res.text();
  } else {
    // Presigned URL: soms werkt zonder auth, soms mét. We proberen beide.
    // 1) zonder headers:
    let res = await fetch(url);
    if (!res.ok) {
      // 2) met auth retry (voor het geval presigned alsnog auth vereist):
      res = await fetchWithAuthRetry(url);
    }
    xmlText = await res.text();
  }
  
  function stripToXml(xmlText) {
    const i = xmlText.indexOf("<?xml");
    return i >= 0 ? xmlText.slice(i) : xmlText;
}


  console.log("EERSTE 200 TEKENS XML:\n", xmlText.slice(0, 200));
  return xmlText;
}



/* async function fetchKnmiMetars() {
  const filename = await fetchLatestMetarFile();
  console.log("Laatste METAR filename:", filename);

  const downloadUrl =
    `https://api.dataplatform.knmi.nl/open-data/v1/datasets/metar/versions/1.0/files/${encodeURIComponent(filename)}/content`;

  const response = await fetchWithAuthRetry(downloadUrl);

  const xmlText = await response.text();
  console.log("EERSTE 300 TEKENS XML:\n", xmlText.slice(0, 300));

  return xmlText;
} */




function metarToFeature(metarString) {
  let parsed;
  try {
    parsed = parseMetar(metarString);
  } catch {
    return null;
  }

  const station = parsed.station;
  if (!STATIONS[station]) return null;

  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [
        STATIONS[station].lon,
        STATIONS[station].lat
      ]
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

/**
 * Health check
 */
app.get("/", (req, res) => {
  res.send("METAR backend draait ✅");
});

/**
 * GeoJSON endpoint
 */
app.get("/metar.geojson", async (req, res) => {
  try {
    const xmlTextRaw = await fetchKnmiMetars();
    const xmlText = stripToXml(xmlTextRaw);

    const metarStrings = extractMetarStringsFromXml(xmlText);

    console.log("Aantal METAR-strings:", metarStrings.length);
    console.log("METAR strings (eerste 3):", metarStrings.slice(0, 3));

    const features = metarStrings
      .map(metarToFeature)
      .filter(f => f !== null);

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
``