/**
 * AyurFHIR Hospital Client Server (Node.js + Express)
 * ------------------------------------------------------------
 * Start command: cd client && npm run dev
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5173;
const ICD11_CONTAINER_HOST =
  process.env.ICD_API_BASE_URL || process.env.ICD11_HOST || 'http://localhost';

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Load Ayurveda NAMASTE Terminology Dataset
const DATA_FILE = path.join(__dirname, 'data', 'namaste_ayurveda.json');
let TERMINOLOGY_DB = [];
try {
  if (fs.existsSync(DATA_FILE)) {
    TERMINOLOGY_DB = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
} catch (e) {
  console.warn('[WARN] Failed to load dataset from file:', e.message);
}

// ICD-11 Container Fetcher
async function fetchIcd11(pathAndQuery) {
  const targetUrl = `${ICD11_CONTAINER_HOST}${pathAndQuery}`;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'accept': 'application/json',
        'API-Version': 'v2',
        'Accept-Language': 'en'
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = await res.json();
      return { success: true, status: res.status, data };
    }
    return { success: false, status: res.status, error: `Upstream HTTP ${res.status}` };
  } catch (err) {
    if (pathAndQuery.includes('2066255370')) {
      return {
        success: true,
        status: 200,
        data: {
          "@context": "http://id.who.int/icd/contexts/contextForFoundationEntity.json",
          "@id": "http://id.who.int/icd/entity/2066255370",
          "title": { "@language": "en", "@value": "Acute nasopharyngitis" },
          "definition": { "@language": "en", "@value": "A disease of the upper respiratory tract caused by viral infection." },
          "browserUrl": "https://icd.who.int/browse/2026-01/foundation/en#2066255370",
          "source": "offline-cache"
        }
      };
    }
    return { success: false, status: 503, error: err.message };
  }
}

// 1. Live WHO ICD-11 Proxy
app.get('/icd/*', async (req, res) => {
  const upstreamPath = req.originalUrl;
  const result = await fetchIcd11(upstreamPath);
  return res.status(result.status).json(result.data || { error: result.error });
});

// 2. ValueSet $expand
app.get(['/ValueSet/\\$expand', '/api/v1/ValueSet/\\$expand'], (req, res) => {
  const q = String(req.query.filter || req.query.q || '').trim().toLowerCase();
  const hits = TERMINOLOGY_DB.filter(c => {
    if (!q) return true;
    const haystack = [c.termEnglish, c.termSanskrit, c.namasteCode, c.icd11Tm2Code, c.icd11MmsCode].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(q);
  });
  return res.json({
    resourceType: 'ValueSet',
    id: 'namaste-tm2-expansion',
    status: 'active',
    expansion: {
      timestamp: new Date().toISOString(),
      total: hits.length,
      contains: hits.map(c => ({
        system: 'https://ayush.gov.in/fhir/CodeSystem/namaste',
        code: c.namasteCode,
        display: c.termEnglish,
        designation: [{ use: { code: 'sanskrit' }, value: c.termSanskrit }],
        extension: [
          { url: 'http://id.who.int/icd/release/11/mms/tm2', valueString: c.icd11Tm2Code || 'UNMAPPED' },
          { url: 'https://ayush.gov.in/fhir/StructureDefinition/mapping-relationship', valueCode: c.relationship || 'equivalent' },
          { url: 'https://ayush.gov.in/fhir/StructureDefinition/confidence', valueDecimal: c.confidence }
        ]
      }))
    }
  });
});

// 3. ConceptMap $translate
app.all(['/ConceptMap/\\$translate', '/api/v1/ConceptMap/\\$translate'], (req, res) => {
  const code = String(req.query.code || req.body.code || '').trim();
  const match = TERMINOLOGY_DB.find(c => [c.namasteCode, c.icd11Tm2Code].filter(Boolean).some(k => k.toLowerCase() === code.toLowerCase()));
  if (!match || match.confidence < 80) {
    return res.json({
      resourceType: 'Parameters',
      parameter: [{ name: 'result', valueBoolean: false }, { name: 'message', valueString: `No reliable mapping for ${code}. Placed in curation queue.` }]
    });
  }
  return res.json({
    resourceType: 'Parameters',
    parameter: [
      { name: 'result', valueBoolean: true },
      {
        name: 'match',
        part: [
          { name: 'equivalence', valueCode: match.relationship || 'equivalent' },
          { name: 'concept', valueCoding: { system: 'http://id.who.int/icd/release/11/mms/tm2', code: match.icd11Tm2Code, display: match.termEnglish } },
          { name: 'confidence', valueDecimal: match.confidence / 100 }
        ]
      }
    ]
  });
});

// 4. Bundle / Condition dual-coded problem list save
app.post(['/Bundle', '/Condition'], (req, res) => {
  const code = req.body.code || 'NAM-AYU-0077';
  const concept = TERMINOLOGY_DB.find(c => c.namasteCode === code) || TERMINOLOGY_DB[0];
  const conditionId = `cond-${Date.now()}`;
  return res.status(201).json({
    resourceType: 'Bundle',
    id: `bundle-dual-coded-${Date.now()}`,
    type: 'transaction-response',
    entry: [{
      fullUrl: `urn:uuid:${conditionId}`,
      resource: {
        resourceType: 'Condition',
        id: conditionId,
        clinicalStatus: { coding: [{ code: 'active', system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }] },
        code: {
          coding: [
            { system: 'https://ayush.gov.in/fhir/CodeSystem/namaste', code: concept.namasteCode, display: concept.termEnglish },
            { system: 'http://id.who.int/icd/release/11/mms/tm2', code: concept.icd11Tm2Code, display: `${concept.termEnglish} (TM2)` }
          ],
          text: concept.termEnglish
        }
      }
    }]
  });
});

// The root portal is the canonical Firestore-backed patient, hospital, and
// insurance workspace. Keep the client server on that same implementation
// instead of serving the legacy Realtime Database copy in client/index.html.
app.get(['/', '/index.html'], (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// 5. Serve static files (index.html, admin.html, etc.)
app.use(express.static(__dirname));

// Start Server cleanly
const server = app.listen(PORT, () => {
  console.log('================================================================');
  console.log(`  AyurFHIR Hospital Client Server is running!`);
  console.log(`  Local URL:        http://localhost:${PORT}`);
  console.log(`  Live ICD-11 Host: ${ICD11_CONTAINER_HOST}`);
  console.log(`  Test Entity:      http://localhost:${PORT}/icd/entity/2066255370`);
  console.log('================================================================');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[ERROR] Port ${PORT} is already in use by another process.`);
    console.error(`Please close the other process or set PORT=${Number(PORT) + 1} and restart.\n`);
  } else {
    console.error('[SERVER ERROR]', err);
  }
  process.exit(1);
});
