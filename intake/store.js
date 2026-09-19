/**
 * Session and worklist store.
 *
 * Backed by Firestore when a service account is configured (see ./db.js), otherwise
 * in memory. Every function is async and returns the record it touched, so the
 * routes read the same way against either backend.
 *
 * Deliberately short-lived: a kiosk session exists only until it has been handed to
 * the HIS. The DPDP requirement the problem statement names is that temporary session
 * data is cleared once the record has been submitted, and `endSession` does exactly
 * that — the interview transcript stops existing here the moment it has been
 * published. What remains on the worklist is the clinical summary the physician needs.
 */

const crypto = require('crypto');
const db = require('./db');

const SESSIONS_COLLECTION = 'kioskSessions';
const WORKLIST_COLLECTION = 'kioskWorklist';
// The physician list is bounded; a kiosk does not produce thousands of open items.
const WORKLIST_LIMIT = 200;

// In-memory fallback. Only consulted when Firestore is not configured — never as a
// cache in front of it, because a session mutated on one serverless instance would
// then be read stale from another.
const SESSIONS = new Map();
const WORKLIST = [];

// Ordering for the physician worklist: sickest first, then longest waiting.
const PRIORITY_RANK = { CRITICAL: 0, URGENT: 1, REVIEW: 2, ROUTINE: 3 };

// ---- persistence primitives -------------------------------------------------

async function saveSession(session) {
  const fs = await db.getDb();
  if (fs) await fs.collection(SESSIONS_COLLECTION).doc(session.id).set(db.pack(session, { startedAt: session.startedAt }));
  else SESSIONS.set(session.id, session);
  return session;
}

async function getSession(id) {
  const fs = await db.getDb();
  if (!fs) return SESSIONS.get(id) || null;
  const snapshot = await fs.collection(SESSIONS_COLLECTION).doc(id).get();
  return snapshot.exists ? db.unpack(snapshot.data()) : null;
}

async function saveWorklistItem(item) {
  const fs = await db.getDb();
  if (fs) {
    await fs.collection(WORKLIST_COLLECTION).doc(item.id).set(
      db.pack(item, { priority: item.priority, status: item.status, submittedAt: item.submittedAt })
    );
  } else {
    const index = WORKLIST.findIndex((w) => w.id === item.id);
    if (index === -1) WORKLIST.unshift(item);
    else WORKLIST[index] = item;
  }
  return item;
}

async function getWorklistItem(id) {
  const fs = await db.getDb();
  if (!fs) return WORKLIST.find((w) => w.id === id) || null;
  const snapshot = await fs.collection(WORKLIST_COLLECTION).doc(id).get();
  return snapshot.exists ? db.unpack(snapshot.data()) : null;
}

async function loadWorklist() {
  const fs = await db.getDb();
  if (!fs) return [...WORKLIST];
  const snapshot = await fs.collection(WORKLIST_COLLECTION).orderBy('submittedAt', 'desc').limit(WORKLIST_LIMIT).get();
  return snapshot.docs.map((doc) => db.unpack(doc.data())).filter(Boolean);
}

async function countSessions() {
  const fs = await db.getDb();
  if (!fs) return SESSIONS.size;
  const aggregate = await fs.collection(SESSIONS_COLLECTION).count().get();
  return aggregate.data().count;
}

// ---- sessions ------------------------------------------------------------------

async function createSession({ language = 'hi', ayushMode = false, patient = {} }) {
  const id = crypto.randomBytes(6).toString('hex');
  const session = {
    id,
    language,
    ayushMode,
    patient: {
      name: patient.name || 'Unregistered patient',
      abhaId: patient.abhaId || null,
      abha: null,
      age: patient.age || null,
      gender: patient.gender || null
    },
    consent: null,
    answers: {},
    documents: [],
    startedAt: new Date().toISOString()
  };
  return saveSession(session);
}

/** Applies a mutation to a session and persists it; null when the session is gone. */
async function updateSession(id, mutate) {
  const session = await getSession(id);
  if (!session) return null;
  mutate(session);
  return saveSession(session);
}

/**
 * Attaches a resolved ABHA to a session. When the directory knew the ABHA it also
 * carries a masked name, which is a better label for the worklist than "Walk-in".
 */
function applyAbha(patient, abhaRecord) {
  patient.abha = abhaRecord;
  patient.abhaId = abhaRecord.display;
  const demographics = abhaRecord.demographics;
  if (demographics) {
    if (demographics.nameMasked) patient.name = demographics.nameMasked;
    if (demographics.gender) patient.gender = demographics.gender;
    if (demographics.yearOfBirth) patient.age = new Date().getFullYear() - demographics.yearOfBirth;
  }
}

const attachAbha = (id, abhaRecord) => updateSession(id, (session) => applyAbha(session.patient, abhaRecord));

const recordAnswer = (id, questionId, value) => updateSession(id, (session) => { session.answers[questionId] = value; });

const grantConsent = (id, scopes) => updateSession(id, (session) => {
  session.consent = { grantedAt: new Date().toISOString(), scopes };
});

const addDocument = (id, document) => updateSession(id, (session) => {
  session.documents.push({ ...document, addedAt: new Date().toISOString() });
});

/** DPDP: clear the transcript once it has been handed over. */
async function endSession(id) {
  const fs = await db.getDb();
  if (!fs) return SESSIONS.delete(id);
  await fs.collection(SESSIONS_COLLECTION).doc(id).delete();
  return true;
}

// ---- worklist ------------------------------------------------------------------

/** Publishes a finished intake to the physician worklist. */
function publish({ session, summary, proposals, bundle, narrative }) {
  return saveWorklistItem({
    id: session.id,
    patient: session.patient,
    ayushMode: session.ayushMode,
    language: session.language,
    priority: summary.priority,
    redFlags: summary.redFlags,
    chiefComplaint: summary.chiefComplaint,
    narrative,
    sections: summary.sections,
    prakriti: summary.prakriti,
    proposals,
    documents: session.documents,
    bundle,
    status: 'WAITING',
    submittedAt: new Date().toISOString(),
    physicianNote: null
  });
}

async function listWorklist() {
  const items = await loadWorklist();
  return items.sort((a, b) => {
    const byPriority = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
    if (byPriority !== 0) return byPriority;
    return new Date(a.submittedAt) - new Date(b.submittedAt);
  });
}

async function updateWorklistItem(id, mutate) {
  const item = await getWorklistItem(id);
  if (!item) return null;
  mutate(item);
  return saveWorklistItem(item);
}

/** Same as attachAbha, but for a patient already on the worklist — the walk-in case. */
const attachAbhaToWorklistItem = (id, abhaRecord) => updateWorklistItem(id, (item) => {
  applyAbha(item.patient, abhaRecord);
  // The bundle already went out with no identifier, so patch the resources that
  // reference the patient rather than leaving the record unlinkable.
  const reference = `Patient/${abhaRecord.display}`;
  (item.bundle.entry || []).forEach((entry) => {
    if (entry.resource && entry.resource.subject) entry.resource.subject.reference = reference;
    if (entry.resource && entry.resource.patient) entry.resource.patient.reference = reference;
  });
  item.abhaAttachedAt = new Date().toISOString();
});

/** Physician confirms, amends or rejects. The draft is never auto-accepted. */
const reviewWorklistItem = (id, { status, physicianNote, acceptedCodes }) => updateWorklistItem(id, (item) => {
  if (status) item.status = status;
  if (physicianNote !== undefined) item.physicianNote = physicianNote;
  if (Array.isArray(acceptedCodes)) {
    item.proposals = item.proposals.map((p) => ({ ...p, accepted: acceptedCodes.includes(p.namasteCode) }));
  }
  item.reviewedAt = new Date().toISOString();
});

async function stats() {
  const [items, activeSessions] = await Promise.all([loadWorklist(), countSessions()]);
  return {
    activeSessions,
    worklistTotal: items.length,
    waiting: items.filter((w) => w.status === 'WAITING').length,
    critical: items.filter((w) => w.priority === 'CRITICAL').length
  };
}

module.exports = {
  createSession, getSession, recordAnswer, grantConsent, addDocument, attachAbha, attachAbhaToWorklistItem,
  publish, listWorklist, getWorklistItem, reviewWorklistItem, endSession, stats
};
