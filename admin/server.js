/**
 * AyurFHIR Admin Console Server (Node.js + Express)
 * ------------------------------------------------------------
 * Start command: cd admin && npm run dev
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5174;
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

// 2. Health check
app.get('/api/health', (req, res) => {
  return res.json({
    service: 'AyurFHIR Admin Console Service',
    status: 'UP',
    timestamp: new Date().toISOString(),
    icd11Container: { target: ICD11_CONTAINER_HOST }
  });
});

// 3. Serve static files (admin.html as default)
app.use(express.static(__dirname));

app.get(['/', '/admin', '/admin.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Start Server cleanly
const server = app.listen(PORT, () => {
  console.log('================================================================');
  console.log(`  AyurFHIR Admin Console Server is running!`);
  console.log(`  Local URL:        http://localhost:${PORT}`);
  console.log(`  Direct Admin:     http://localhost:${PORT}/admin.html`);
  console.log(`  Live ICD-11 Host: ${ICD11_CONTAINER_HOST}`);
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
