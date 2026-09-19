/**
 * Firestore for the kiosk and worklist.
 *
 * The kiosk runs as a serverless function in production, where nothing in memory
 * survives from one request to the next and two requests rarely land on the same
 * instance. A session started on one instance was invisible to the next, and the
 * worklist emptied on every cold start. Firestore is the datastore the portal already
 * writes to, so the intake side reads and writes the same database.
 *
 * Credentials are the backend's: one service account, resolved by its config module,
 * so there is exactly one place that knows how to parse it. Without a service account
 * `getDb()` resolves to null and the callers keep their in-memory behaviour, which is
 * what a fresh local clone and the test suite rely on.
 */

let dbPromise = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      // Literal specifier: the bundler has to be able to see this import.
      const { config } = await import('../backend/src/config/env.js');
      if (!config.adminConfigured) {
        console.warn('[kiosk-db] No Firebase service account; sessions and the worklist live in memory only.');
        return null;
      }
      const { cert, getApps, initializeApp } = require('firebase-admin/app');
      const { getFirestore } = require('firebase-admin/firestore');
      const app = getApps().length
        ? getApps()[0]
        : initializeApp({ credential: cert(config.serviceAccount), projectId: config.serviceAccount.project_id });
      return getFirestore(app);
    })().catch((err) => {
      console.warn(`[kiosk-db] Firestore unavailable (${err.message}); falling back to memory.`);
      return null;
    });
  }
  return dbPromise;
}

/** For /api/health: which store the kiosk is actually using right now. */
async function describe() {
  const db = await getDb();
  return db ? 'firestore' : 'memory';
}

/**
 * Documents are stored as one JSON string plus the few fields that are queried.
 * A worklist item carries a FHIR Bundle, and Firestore's value rules (no undefined,
 * no arrays directly inside arrays) are not worth policing across every resource
 * the coder can emit. JSON round-tripping is exactly what the HTTP layer does anyway.
 */
const pack = (record, indexed = {}) => ({ ...indexed, id: record.id, payload: JSON.stringify(record) });
const unpack = (data) => (data && data.payload ? JSON.parse(data.payload) : null);

module.exports = { getDb, describe, pack, unpack };
