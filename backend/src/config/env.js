import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// One .env at the repo root configures every process in this monorepo, so the backend resolves
// the same file whether it is started from the root, from the workspace, or by server.js.
// Anchoring to __dirname (not cwd) is what makes that true. A pre-existing backend/.env is still
// read afterwards for backwards compatibility; dotenv never overwrites an already-set variable,
// so the root file always wins.
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(backendRoot, '..');
dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true });
dotenv.config({ path: path.join(backendRoot, '.env'), quiet: true });

// The service account is a server-only secret. It may be supplied either as an inline JSON
// string (convenient for hosted deployments) or as a path to a gitignored file (convenient locally).
function loadServiceAccount() {
  const inline = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  const filePath = (process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '').trim();
  // Inline JSON wins, so a hosted deploy needs no file at all. The path form is resolved against
  // the repo root first and then backend/, which keeps older ./secrets/... values working.
  let resolvedPath = '';
  if (!inline && filePath) {
    const candidates = [path.resolve(repoRoot, filePath), path.resolve(backendRoot, filePath)];
    resolvedPath = candidates.find((candidate) => fs.existsSync(candidate)) || '';
    if (!resolvedPath) {
      console.warn(`[firebase] FIREBASE_SERVICE_ACCOUNT_PATH points at a missing file: ${candidates[0]}`);
      return null;
    }
  }
  const raw = inline || (resolvedPath ? fs.readFileSync(resolvedPath, 'utf8') : '');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Firebase service account is not valid JSON: ${error.message}`);
  }
}

const serviceAccount = loadServiceAccount();

// Only the browser-safe Firebase Web config lives here. These values are public by design —
// Firebase Auth security comes from provider settings, authorized domains, and server-side
// token verification, not from hiding the Web API key.
const webConfig = {
  apiKey: process.env.FIREBASE_API_KEY || '',
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
  projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount?.project_id || '',
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
  appId: process.env.FIREBASE_APP_ID || ''
};

export const config = {
  port: Number(process.env.PORT || 3000),
  // The WHO ICD-API container. It serves the classification without OAuth, so the only settings
  // are where it lives and which release/linearization to read. An empty releaseId means
  // "ask the container which release it ships", which survives container upgrades.
  icd: {
    baseUrl: (process.env.ICD_API_BASE_URL || 'http://localhost').trim().replace(/\/+$/, ''),
    releaseId: (process.env.ICD_API_RELEASE_ID || '').trim(),
    linearization: (process.env.ICD_API_LINEARIZATION || 'mms').trim().toLowerCase(),
    language: (process.env.ICD_API_LANGUAGE || 'en').trim(),
    timeoutMs: Number(process.env.ICD_API_TIMEOUT_MS || 10000),
    cacheTtlMs: Number(process.env.ICD_API_CACHE_TTL_MS || 600000)
  },
  environment: process.env.NODE_ENV || 'development',
  serviceAccount,
  webConfig,
  webConfigured: Boolean(webConfig.apiKey && webConfig.authDomain && webConfig.projectId),
  adminConfigured: Boolean(serviceAccount),
  // Emails allowed to become admins on first sign-in. Roles are never accepted from the browser.
  adminBootstrapEmails: (process.env.ADMIN_BOOTSTRAP_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
};
