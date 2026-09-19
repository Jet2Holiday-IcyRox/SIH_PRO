/**
 * AyurFHIR Terminology Microservice (Node.js)
 * ------------------------------------------------------------
 * Problem Statement: Develop API code for ICD-11 and NAMASTE
 * for integration into existing EMR systems.
 *
 * Microservice Capabilities:
 * 1. Live proxy and cache to WHO ICD-11 container at http://localhost
 * 2. FHIR R4 /ValueSet/$expand autocomplete (NAMASTE + ICD-11 TM2)
 * 3. FHIR R4 /ConceptMap/$translate dual-coding mapper with honest semantics
 * 4. FHIR R4 /Bundle & /Condition dual-coded problem list persistence
 * 5. Curation queue API for low-confidence terms
 * 6. Serves index.html and admin.html with 1-click user-friendly demo modes
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// The single root .env configures this process, the backend it mounts, and the intake kiosk.
// Anchored to __dirname so `npm start` works from anywhere; on Vercel the file is absent and
// the platform's own environment variables are already in process.env.
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const PORT = process.env.PORT || 3000;
// ICD11_HOST is the legacy name for this; ICD_API_BASE_URL is what the rest of the repo reads.
const ICD11_CONTAINER_HOST =
  process.env.ICD_API_BASE_URL || process.env.ICD11_HOST || 'http://localhost';

// Load Ayurveda NAMASTE Terminology Dataset
const DATA_FILE = path.join(__dirname, 'data', 'namaste_ayurveda.json');
// Generated from the official Ministry of Ayush release by scripts/build-terminology.js.
const RELEASE_DATA_FILE = path.join(__dirname, 'data', 'namaste_terminology.json');
// index.html and admin.html sit next to this file; client/ and admin/ hold copies
// served by their own standalone servers.
const STATIC_ROOT = __dirname;

// Only the practitioner portal is served from here. '/admin' is handled by the
// backend app below, which owns the real admin console in frontend/admin/.
const PAGE_ROUTES = {
  '/': 'index.html',
  // Patient-facing clinical intake kiosk and the physician worklist it feeds.
  '/kiosk': 'kiosk.html',
  '/kiosk/': 'kiosk.html',
  '/worklist': 'worklist.html',
  '/worklist/': 'worklist.html'
};

// STATIC_ROOT is the repository root, so only root-level assets are servable and
// the server's own sources stay private. Without this, /backend/.env and
// /.git/config are downloadable.
const PRIVATE_FILES = new Set(['server.js', 'test.js', 'package.json', 'package-lock.json']);

// The backend (ESM/Express) owns Firebase auth, the admin API and the frontend/
// pages. It only calls app.listen() when run directly, so importing it here adds
// no second listener - we just hand it the requests it owns.
const BACKEND_PREFIXES = ['/shared/', '/patient', '/admin', '/api/v1/auth/', '/api/v1/admin/'];

let backendAppPromise = null;
// Why the backend failed to load, surfaced by /api/health so a broken deploy is
// diagnosable without digging through platform logs.
let backendLoadError = null;
function getBackendApp() {
  if (!backendAppPromise) {
    // A literal specifier (not a computed file URL) so Vercel's bundler can trace the
    // backend and its dependencies (express, firebase-admin) into the function.
    backendAppPromise = import('./backend/src/app.js')
      .then((mod) => mod.default)
      .catch((err) => {
        backendLoadError = err.message;
        console.warn('[BACKEND] Could not load backend/src/app.js:', err.message);
        console.warn('[BACKEND] /admin and the auth API are unavailable; the portal still works.');
        return null;
      });
  }
  return backendAppPromise;
}

// Files the function must ship with that Vercel cannot discover by tracing server.js:
// the pages are picked by route table and the backend serves whole directories.
const DEPLOY_FILES = [
  'index.html', 'kiosk.html', 'worklist.html',
  'data/namaste_terminology.json',
  'frontend/admin/index.html', 'frontend/patient/index.html', 'frontend/shared/admin-api.js',
  'backend/src/app.js', 'node_modules/express/package.json', 'node_modules/firebase-admin/package.json'
];
function deploymentReport() {
  const files = {};
  for (const rel of DEPLOY_FILES) files[rel] = fs.existsSync(path.join(__dirname, rel));
  return {
    platform: process.env.VERCEL ? 'vercel' : 'node',
    root: __dirname,
    backend: backendLoadError ? { loaded: false, error: backendLoadError } : { loaded: backendAppPromise !== null },
    files
  };
}

function isBackendPath(pathname) {
  return BACKEND_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

function resolveStatic(pathname) {
  const route = PAGE_ROUTES[pathname];
  if (route) return path.join(STATIC_ROOT, route);

  const name = pathname.replace(/^\/+/, '');
  // Reject subdirectories, dotfiles and the server's own sources.
  if (!name || name.includes('/') || name.startsWith('.') || PRIVATE_FILES.has(name)) return null;
  return path.join(STATIC_ROOT, name);
}
let TERMINOLOGY_DB = [];
let TERMINOLOGY_META = {
  source: 'legacy demo dataset',
  totalConcepts: 0,
  officiallyMapped: 0,
  unmapped: 0
};

// The real release, built by scripts/build-terminology.js from the Ministry of Ayush
// "NATIONAL AYURVEDA MORBIDITY CODES" workbook, is preferred. The older hand-written
// demo file stays as a fallback so the portal still runs on a fresh clone that has not
// generated it yet.
try {
  if (fs.existsSync(RELEASE_DATA_FILE)) {
    const payload = JSON.parse(fs.readFileSync(RELEASE_DATA_FILE, 'utf8'));
    TERMINOLOGY_DB = payload.concepts || [];
    TERMINOLOGY_META = payload.meta || TERMINOLOGY_META;
    console.log(`[TERMINOLOGY] NAMASTE release loaded: ${TERMINOLOGY_META.totalConcepts} concepts, ` +
      `${TERMINOLOGY_META.officiallyMapped} officially mapped to ICD-11 TM2.`);
  } else if (fs.existsSync(DATA_FILE)) {
    TERMINOLOGY_DB = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    console.warn('[TERMINOLOGY] Using the legacy demo dataset. Run `npm run build:terminology` for the real release.');
  }
} catch (e) {
  console.warn('[WARN] Failed to load dataset from file, using fallback array:', e.message);
}

// In-memory curation queue & condition audit store
const CURATION_QUEUE = [
  {
    id: 'CUR-001',
    namasteCode: 'NAM-AYU-0999',
    termEnglish: 'Anukta Vyadhi (Unmapped Ayurvedic Condition)',
    termSanskrit: 'अनुक्तव्याधिः',
    confidence: 35,
    suggestedTm2: 'TM2-AYU-Z99.9',
    suggestedMms: 'MG26.Z',
    status: 'PENDING_REVIEW',
    submittedAt: new Date(Date.now() - 3600000).toISOString(),
    clinicalNotes: 'Syndrome observed in OPD with mixed Vata-Kapha presentation. Needs TM2 consensus.'
  }
];

const STORED_CONDITIONS = [];

// Clinical intake kiosk (SIH26047). Mounted below, after the FHIR operations.
const { createIntakeRoutes } = require('./intake/routes');
let intakeRoutes = null;

// Entity memory cache for instant offline & high-speed responses
const ENTITY_CACHE = new Map();

// Helper to fetch from the local ICD-11 container
async function fetchIcd11(pathAndQuery) {
  const targetUrl = `${ICD11_CONTAINER_HOST}${pathAndQuery}`;
  const cacheKey = pathAndQuery;
  
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
      ENTITY_CACHE.set(cacheKey, { data, timestamp: Date.now() });
      return { success: true, status: res.status, data, source: 'live-container' };
    }
    return { success: false, status: res.status, error: `Upstream HTTP ${res.status}` };
  } catch (err) {
    // Check if cached
    if (ENTITY_CACHE.has(cacheKey)) {
      return { success: true, status: 200, data: ENTITY_CACHE.get(cacheKey).data, source: 'cache-fallback' };
    }
    
    // Built-in high-fidelity fallback for entity 2066255370 if container drops
    if (pathAndQuery.includes('2066255370')) {
      const fallbackEntity = {
        "@context": "http://id.who.int/icd/contexts/contextForFoundationEntity.json",
        "@id": "http://id.who.int/icd/entity/2066255370",
        "parent": ["http://id.who.int/icd/entity/1971756453"],
        "browserUrl": "https://icd.who.int/browse/2026-01/foundation/en#2066255370",
        "title": { "@language": "en", "@value": "Acute nasopharyngitis" },
        "definition": {
          "@language": "en",
          "@value": "A disease of the upper respiratory tract, caused by an infection with rhinovirus. Characterised by pharyngitis, runny nose, stuffy nose, or cough."
        },
        "tm2Mapping": {
          "code": "TM2-AYU-R01.1",
          "namasteCode": "NAM-AYU-0077",
          "ayushTerm": "Pratishyaya (प्रतिश्यायः)"
        },
        "source": "offline-resilient-mode"
      };
      return { success: true, status: 200, data: fallbackEntity, source: 'offline-resilient-mode' };
    }
    
    return { success: false, status: 503, error: err.message };
  }
}

// MIME types dictionary for static files
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Request Parser Helper
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON format: ' + err.message));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, API-Version, Accept-Language'
  });
  res.end(JSON.stringify(data, null, 2));
}

// The request handler is defined standalone and exported so a serverless platform
// (Vercel) can invoke it per-request, while a normal `node server.js` still binds a port.
// On Vercel every request is rewritten to /api/index (vercel.json), and the function
// receives the rewritten URL - not the one the browser asked for - so /worklist,
// /kiosk and /api/* would all fall through to index.html. The rewrite copies the
// original path into the __vercel_path query parameter; put it back on req.url before
// routing so the rest of this file (and the mounted Express backend) never notices.
function restoreOriginalUrl(req) {
  const qIndex = req.url.indexOf('?');
  if (qIndex === -1) return;
  const params = new URLSearchParams(req.url.slice(qIndex + 1));
  const original = params.get('__vercel_path');
  if (original === null) return;
  params.delete('__vercel_path');
  const search = params.toString();
  req.url = (original.startsWith('/') ? original : '/' + original) + (search ? '?' + search : '');
}

async function handleRequest(req, res) {
  restoreOriginalUrl(req);
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  // CORS Preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, API-Version, Accept-Language'
    });
    return res.end();
  }

  try {
    // -------------------------------------------------------------
    // 1. Live WHO ICD-11 Container Proxy
    // Example: GET /icd/entity/2066255370 or /icd/entity/search?q=cold
    // -------------------------------------------------------------
    if (pathname.startsWith('/icd/')) {
      const upstreamPath = pathname + (parsedUrl.search || '');
      console.log(`[ICD-11 PROXY] Forwarding to ${ICD11_CONTAINER_HOST}${upstreamPath}`);
      const result = await fetchIcd11(upstreamPath);
      return sendJson(res, result.status, result.data || { error: result.error });
    }

    // -------------------------------------------------------------
    // 2. Health & Diagnostic Check
    // GET /api/health
    // -------------------------------------------------------------
    if (pathname === '/api/health' && method === 'GET') {
      // Attempt the backend so the report below can say whether it loads.
      await getBackendApp();
      let icdContainerUp = false;
      try {
        const testRes = await fetchIcd11('/icd/release/11/mms');
        icdContainerUp = testRes.success;
      } catch (e) {
        icdContainerUp = false;
      }

      return sendJson(res, 200, {
        service: 'AyurFHIR Terminology Microservice',
        status: 'UP',
        timestamp: new Date().toISOString(),
        deployment: deploymentReport(),
        versionStamps: {
          namasteRelease: TERMINOLOGY_META.namasteRelease || 'NAMASTE-2024.1',
          icd11Release: TERMINOLOGY_META.icd11Release || 'ICD-11-2026-01-MMS',
          tm2Chapter: TERMINOLOGY_META.tm2Chapter || 'Chapter 26 (Module II)',
          source: TERMINOLOGY_META.source || 'legacy demo dataset'
        },
        icd11Container: {
          target: ICD11_CONTAINER_HOST,
          accessible: icdContainerUp,
          testEntity: `${ICD11_CONTAINER_HOST}/icd/entity/2066255370`
        },
        database: {
          system: 'PostgreSQL-ready / Local Pre-sync',
          ayurvedaConceptCount: TERMINOLOGY_DB.length,
          officiallyMappedToTm2: TERMINOLOGY_META.officiallyMapped || 0,
          awaitingCuration: TERMINOLOGY_META.unmapped || 0,
          curationQueueLength: CURATION_QUEUE.length,
          storedConditionsCount: STORED_CONDITIONS.length
        }
      });
    }

    // -------------------------------------------------------------
    // 3. FHIR R4 /ValueSet/$expand (Autocomplete for EMR diagnosis)
    // -------------------------------------------------------------
    if ((pathname === '/ValueSet/$expand' || pathname === '/api/v1/ValueSet/$expand') && method === 'GET') {
      const q = String(parsedUrl.query.filter || parsedUrl.query.q || '').trim().toLowerCase();
      const stream = String(parsedUrl.query.stream || 'ayurveda').toLowerCase();
      const limit = Math.min(Number(parsedUrl.query.count || parsedUrl.query.limit) || 10, 50);

      const hits = TERMINOLOGY_DB.filter(c => {
        if (stream && c.system && c.system.toLowerCase() !== stream) return false;
        if (!q) return true;
        const haystack = [
          c.termEnglish,
          c.termSanskrit,
          c.namasteCode,
          c.icd11Tm2Code,
          c.icd11MmsCode,
          c.snomedCode,
          c.definition,
          ...(c.synonyms || [])
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(q);
      }).slice(0, limit);

      const response = {
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
            designation: [
              { use: { code: 'sanskrit' }, value: c.termSanskrit },
              { use: { code: 'definition' }, value: c.definition }
            ],
            extension: [
              { url: 'http://id.who.int/icd/release/11/mms/tm2', valueString: c.icd11Tm2Code || 'UNMAPPED' },
              { url: 'http://id.who.int/icd/release/11/mms', valueString: c.icd11MmsCode || 'UNMAPPED' },
              { url: 'http://id.who.int/icd/entity', valueString: c.icd11EntityId || '' },
              { url: 'https://ayush.gov.in/fhir/StructureDefinition/mapping-relationship', valueCode: c.relationship },
              { url: 'https://ayush.gov.in/fhir/StructureDefinition/confidence', valueDecimal: c.confidence }
            ]
          }))
        }
      };

      return sendJson(res, 200, response);
    }

    // -------------------------------------------------------------
    // 4. FHIR R4 /ConceptMap/$translate (Honest mapping semantics)
    // -------------------------------------------------------------
    if ((pathname === '/ConceptMap/$translate' || pathname === '/api/v1/ConceptMap/$translate') && (method === 'GET' || method === 'POST')) {
      let code = '';
      let sourceSystem = '';
      if (method === 'GET') {
        code = String(parsedUrl.query.code || '').trim();
        sourceSystem = String(parsedUrl.query.system || '');
      } else {
        const body = await readJsonBody(req);
        code = String(body.code || (body.parameter && body.parameter.find(p => p.name === 'code')?.valueCode) || '').trim();
        sourceSystem = String(body.system || (body.parameter && body.parameter.find(p => p.name === 'system')?.valueUri) || '');
      }

      if (!code) {
        return sendJson(res, 400, {
          resourceType: 'OperationOutcome',
          issue: [{ severity: 'error', code: 'required', diagnostics: 'Parameter "code" is required.' }]
        });
      }

      const match = TERMINOLOGY_DB.find(c =>
        [c.namasteCode, c.icd11Tm2Code, c.icd11MmsCode, c.snomedCode, c.icd11EntityId]
          .filter(Boolean)
          .some(k => k.toLowerCase() === code.toLowerCase())
      );

      // Low-confidence or unmapped term routing to curation queue
      if (!match || match.confidence < 80 || !match.icd11Tm2Code) {
        if (match && !CURATION_QUEUE.some(q => q.namasteCode === match.namasteCode)) {
          CURATION_QUEUE.push({
            id: `CUR-${Date.now()}`,
            namasteCode: match.namasteCode,
            termEnglish: match.termEnglish,
            termSanskrit: match.termSanskrit,
            confidence: match.confidence,
            suggestedTm2: 'PENDING',
            status: 'PENDING_REVIEW',
            submittedAt: new Date().toISOString()
          });
        }

        return sendJson(res, 200, {
          resourceType: 'Parameters',
          parameter: [
            { name: 'result', valueBoolean: false },
            { name: 'message', valueString: `No reliable mapping for "${code}". Placed in Ayush Clinical Curation Queue for expert review.` },
            { name: 'curationQueue', valueBoolean: true }
          ]
        });
      }

      // Validated mapping with FHIR ConceptMap equivalence.
      const matches = [{
        name: 'match',
        part: [
          { name: 'equivalence', valueCode: match.relationship || 'equivalent' },
          {
            name: 'concept',
            valueCoding: {
              system: 'http://id.who.int/icd/release/11/mms/tm2',
              code: match.icd11Tm2Code,
              display: match.icd11Tm2Title || `${match.termEnglish} (ICD-11 TM2)`
            }
          },
          { name: 'confidence', valueDecimal: match.confidence / 100 }
        ]
      }];

      // The NAMASTE release publishes a TM2 crosswalk but no biomedical MMS
      // equivalent, so a second match is emitted only where an MMS code actually
      // exists. Emitting a Coding with no code would assert a mapping nobody made.
      if (match.icd11MmsCode) {
        matches.push({
          name: 'match',
          part: [
            { name: 'equivalence', valueCode: 'related-to' },
            {
              name: 'concept',
              valueCoding: {
                system: 'http://id.who.int/icd/release/11/mms',
                code: match.icd11MmsCode,
                display: `${match.termEnglish} (biomedical MMS)`
              }
            },
            { name: 'confidence', valueDecimal: (match.confidence - 5) / 100 }
          ]
        });
      }

      return sendJson(res, 200, {
        resourceType: 'Parameters',
        parameter: [{ name: 'result', valueBoolean: true }, ...matches]
      });
    }

    // -------------------------------------------------------------
    // 5. FHIR R4 /Bundle & /Condition (Dual-Coded Problem List Save)
    // -------------------------------------------------------------
    if ((pathname === '/Bundle' || pathname === '/Condition' || pathname === '/api/v1/records/dual-coded') && method === 'POST') {
      const body = await readJsonBody(req);
      const codeOrTerm = body.code || body.namasteCode || (body.entry && body.entry[0]?.resource?.code?.text) || 'NAM-AYU-0077';
      const patientId = body.patientId || body.subject?.reference || 'Patient/ABHA-91-4821-3920-1102';
      const patientName = body.patientName || 'Anjali R. Deshmukh';

      // Find concept
      const concept = TERMINOLOGY_DB.find(c =>
        [c.namasteCode, c.termEnglish, c.termSanskrit, c.id].some(k => k && k.toLowerCase().includes(String(codeOrTerm).toLowerCase()))
      ) || TERMINOLOGY_DB[0];

      const conditionId = `cond-${Date.now()}`;
      const dualCodedCondition = {
        resourceType: 'Condition',
        id: conditionId,
        meta: {
          versionId: '1',
          lastUpdated: new Date().toISOString(),
          tag: [
            { system: 'https://ayush.gov.in/version', code: 'NAMASTE-2024.1', display: 'NAMASTE Ayurveda v2024.1' },
            { system: 'http://id.who.int/icd/release', code: 'ICD-11-2026-01-MMS', display: 'ICD-11 MMS 2026-01' }
          ]
        },
        clinicalStatus: {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active', display: 'Active' }]
        },
        verificationStatus: {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed', display: 'Confirmed' }]
        },
        category: [{
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item', display: 'Problem List Item' }]
        }],
        code: {
          coding: [
            {
              system: 'https://ayush.gov.in/fhir/CodeSystem/namaste',
              code: concept.namasteCode,
              display: concept.termEnglish,
              userSelected: true
            },
            {
              system: 'http://id.who.int/icd/release/11/mms/tm2',
              code: concept.icd11Tm2Code,
              display: `${concept.termEnglish} (TM2)`
            },
            {
              system: 'http://id.who.int/icd/release/11/mms',
              code: concept.icd11MmsCode,
              display: `${concept.termEnglish} (biomedical)`
            },
            {
              system: 'http://snomed.info/sct',
              code: concept.snomedCode,
              display: concept.termEnglish
            }
          ],
          text: `${concept.termEnglish} [${concept.termSanskrit}]`
        },
        subject: {
          reference: patientId.startsWith('Patient/') ? patientId : `Patient/${patientId}`,
          display: patientName
        },
        recordedDate: new Date().toISOString(),
        note: [{ text: concept.definition }]
      };

      const documentBundle = {
        resourceType: 'Bundle',
        id: `bundle-dual-coded-${Date.now()}`,
        type: 'transaction-response',
        timestamp: new Date().toISOString(),
        entry: [
          {
            fullUrl: `urn:uuid:${conditionId}`,
            resource: dualCodedCondition,
            response: { status: '201 Created', location: `Condition/${conditionId}` }
          }
        ]
      };

      STORED_CONDITIONS.unshift(dualCodedCondition);
      console.log(`[FHIR STORE] Dual-coded Condition saved: ${conditionId} (${concept.namasteCode} ↔ ${concept.icd11Tm2Code})`);
      return sendJson(res, 201, documentBundle);
    }

    // -------------------------------------------------------------
    // 5a. Full concept list for the practitioner portal.
    //
    // The portal keeps a client-side copy so its search, explorer and ConceptMap
    // viewer stay instant. It ships with a small offline seed; this endpoint
    // replaces that seed with the real release at boot, which is why the portal
    // shows 2,892 concepts rather than the handful baked into the page.
    // -------------------------------------------------------------
    if (pathname === '/api/terminology/concepts' && method === 'GET') {
      const stream = String(parsedUrl.query.stream || '').toLowerCase();
      const concepts = TERMINOLOGY_DB
        .filter((c) => !stream || (c.system || '').toLowerCase() === stream)
        .map((c) => ({
          id: c.id,
          namasteCode: c.namasteCode,
          termEnglish: c.termEnglish,
          termSanskrit: c.termSanskrit,
          icd11Tm2Code: c.icd11Tm2Code || null,
          icd11Tm2Title: c.icd11Tm2Title || null,
          icd11MmsCode: c.icd11MmsCode || null,
          snomedCode: c.snomedCode || null,
          ayushStream: c.ayushStream || 'Ayurveda',
          confidence: c.confidence,
          mappingStatus: c.mappingStatus || (c.icd11Tm2Code ? 'official-tm2' : 'unmapped'),
          // Definitions in the release run to several hundred words; the portal
          // only renders a one-line preview, so the payload is trimmed here rather
          // than shipping ~2 MB of prose the UI never shows.
          description: String(c.definition || '').slice(0, 180)
        }));

      return sendJson(res, 200, { meta: TERMINOLOGY_META, total: concepts.length, concepts });
    }

    // -------------------------------------------------------------
    // 5b. Clinical intake kiosk + physician worklist
    // -------------------------------------------------------------
    if (pathname.startsWith('/api/intake') || pathname.startsWith('/api/worklist') || pathname.startsWith('/api/abha')) {
      if (!intakeRoutes) {
        intakeRoutes = createIntakeRoutes({
          terminology: TERMINOLOGY_DB,
          terminologyMeta: TERMINOLOGY_META,
          curationQueue: CURATION_QUEUE,
          readJsonBody,
          sendJson
        });
      }
      if (await intakeRoutes(req, res, pathname, method, parsedUrl.query)) return;
    }

    // -------------------------------------------------------------
    // 6. Curation Queue Endpoints
    // -------------------------------------------------------------
    if (pathname === '/api/curation' && method === 'GET') {
      return sendJson(res, 200, {
        total: CURATION_QUEUE.length,
        items: CURATION_QUEUE
      });
    }

    if (pathname === '/api/curation/resolve' && method === 'POST') {
      const body = await readJsonBody(req);
      const item = CURATION_QUEUE.find(q => q.id === body.id);
      if (item) {
        item.status = body.action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
        item.reviewedAt = new Date().toISOString();
        item.reviewerComment = body.comment || 'Clinically verified by Ayush expert.';
      }
      return sendJson(res, 200, { success: true, item });
    }

    // -------------------------------------------------------------
    // 7. Admin console + auth, served by the backend app
    // -------------------------------------------------------------
    // index.html links to "admin.html"; send that to the real console so the
    // 289KB page does not have to be edited.
    if (pathname === '/admin.html') {
      res.writeHead(302, { Location: '/admin/' });
      return res.end();
    }

    if (isBackendPath(pathname)) {
      const backendApp = await getBackendApp();
      if (backendApp) return backendApp(req, res);
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Admin console unavailable: backend/src/app.js failed to load.');
    }

    // -------------------------------------------------------------
    // 8. Static File Server (serves index.html and root-level assets)
    // -------------------------------------------------------------
    let filePath = resolveStatic(pathname) || path.join(STATIC_ROOT, 'index.html');

    // Belt and braces: resolveStatic already rejects separators, but re-check the
    // resolved path in case STATIC_ROOT ever moves.
    if (!filePath.startsWith(STATIC_ROOT + path.sep)) {
      res.writeHead(403);
      return res.end('Access denied');
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        // If not found, fallback to index.html for client-side navigation
        filePath = path.join(STATIC_ROOT, 'index.html');
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      fs.readFile(filePath, (readErr, content) => {
        if (readErr) {
          res.writeHead(500);
          return res.end('Error loading file: ' + readErr.message);
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      });
    });

  } catch (globalErr) {
    console.error('[SERVER ERROR]', globalErr);
    sendJson(res, 500, {
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'fatal', code: 'exception', diagnostics: globalErr.message }]
    });
  }
}

// Vercel imports this module and calls the export once per request; there is no port to bind.
module.exports = handleRequest;
module.exports.handleRequest = handleRequest;

// Only listen when run directly (`node server.js`), never when imported.
if (require.main === module) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    console.log('================================================================');
    console.log(`  AyurFHIR Terminology Microservice is running!`);
    console.log(`  Port:             http://localhost:${PORT}`);
    console.log(`  Admin Console:    http://localhost:${PORT}/admin/`);
    console.log(`  Live ICD-11 Host: ${ICD11_CONTAINER_HOST}`);
    console.log(`  Test Entity URL:  http://localhost:${PORT}/icd/entity/2066255370`);
    console.log(`  FHIR Expansion:   http://localhost:${PORT}/ValueSet/$expand?q=Amlapitta`);
    console.log(`  Intake Kiosk:     http://localhost:${PORT}/kiosk`);
    console.log(`  Physician View:   http://localhost:${PORT}/worklist`);
    console.log('================================================================');
  });
}
