/**
 * In-memory session and worklist store.
 *
 * Deliberately not a database: a kiosk session is short-lived by design. The DPDP
 * requirement the problem statement names is that temporary session data is cleared
 * once the record has been submitted, and `endSession` does exactly that — the
 * interview transcript stops existing here the moment it has been handed to the HIS.
 * What remains on the worklist is the clinical summary the physician needs.
 */

const crypto = require('crypto');

const SESSIONS = new Map();
const WORKLIST = [];

// Ordering for the physician worklist: sickest first, then longest waiting.
const PRIORITY_RANK = { CRITICAL: 0, URGENT: 1, REVIEW: 2, ROUTINE: 3 };

function createSession({ language = 'hi', ayushMode = false, patient = {} }) {
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
  SESSIONS.set(id, session);
  return session;
}

const getSession = (id) => SESSIONS.get(id) || null;

/**
 * Attaches a resolved ABHA to a session. When the directory knew the ABHA it also
 * carries a masked name, which is a better label for the worklist than "Walk-in".
 */
function attachAbha(id, abhaRecord) {
  const session = SESSIONS.get(id);
  if (!session) return null;
  session.patient.abha = abhaRecord;
  session.patient.abhaId = abhaRecord.display;
  const demographics = abhaRecord.demographics;
  if (demographics) {
    if (demographics.nameMasked) session.patient.name = demographics.nameMasked;
    if (demographics.gender) session.patient.gender = demographics.gender;
    if (demographics.yearOfBirth) session.patient.age = new Date().getFullYear() - demographics.yearOfBirth;
  }
  return session;
}

/** Same, but for a patient already on the worklist — the walk-in case. */
function attachAbhaToWorklistItem(id, abhaRecord) {
  const item = WORKLIST.find((w) => w.id === id);
  if (!item) return null;
  item.patient = { ...item.patient, abha: abhaRecord, abhaId: abhaRecord.display };
  const demographics = abhaRecord.demographics;
  if (demographics && demographics.nameMasked) item.patient.name = demographics.nameMasked;
  // The bundle already went out with no identifier, so patch the resources that
  // reference the patient rather than leaving the record unlinkable.
  const reference = `Patient/${abhaRecord.display}`;
  (item.bundle.entry || []).forEach((entry) => {
    if (entry.resource && entry.resource.subject) entry.resource.subject.reference = reference;
    if (entry.resource && entry.resource.patient) entry.resource.patient.reference = reference;
  });
  item.abhaAttachedAt = new Date().toISOString();
  return item;
}

function recordAnswer(id, questionId, value) {
  const session = SESSIONS.get(id);
  if (!session) return null;
  session.answers[questionId] = value;
  return session;
}

function grantConsent(id, scopes) {
  const session = SESSIONS.get(id);
  if (!session) return null;
  session.consent = { grantedAt: new Date().toISOString(), scopes };
  return session;
}

function addDocument(id, document) {
  const session = SESSIONS.get(id);
  if (!session) return null;
  session.documents.push({ ...document, addedAt: new Date().toISOString() });
  return session;
}

/** Publishes a finished intake to the physician worklist. */
function publish({ session, summary, proposals, bundle, narrative }) {
  const item = {
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
  };
  WORKLIST.unshift(item);
  return item;
}

function listWorklist() {
  return [...WORKLIST].sort((a, b) => {
    const byPriority = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
    if (byPriority !== 0) return byPriority;
    return new Date(a.submittedAt) - new Date(b.submittedAt);
  });
}

const getWorklistItem = (id) => WORKLIST.find((w) => w.id === id) || null;

/** Physician confirms, amends or rejects. The draft is never auto-accepted. */
function reviewWorklistItem(id, { status, physicianNote, acceptedCodes }) {
  const item = getWorklistItem(id);
  if (!item) return null;
  if (status) item.status = status;
  if (physicianNote !== undefined) item.physicianNote = physicianNote;
  if (Array.isArray(acceptedCodes)) {
    item.proposals = item.proposals.map((p) => ({ ...p, accepted: acceptedCodes.includes(p.namasteCode) }));
  }
  item.reviewedAt = new Date().toISOString();
  return item;
}

/** DPDP: clear the transcript once it has been handed over. */
function endSession(id) {
  return SESSIONS.delete(id);
}

const stats = () => ({
  activeSessions: SESSIONS.size,
  worklistTotal: WORKLIST.length,
  waiting: WORKLIST.filter((w) => w.status === 'WAITING').length,
  critical: WORKLIST.filter((w) => w.priority === 'CRITICAL').length
});

module.exports = {
  createSession, getSession, recordAnswer, grantConsent, addDocument, attachAbha, attachAbhaToWorklistItem,
  publish, listWorklist, getWorklistItem, reviewWorklistItem, endSession, stats
};
