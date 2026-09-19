/**
 * HTTP surface for the intake kiosk and the physician worklist.
 *
 * Exposed as a factory so server.js can hand in the loaded terminology and the
 * existing curation queue rather than this module reaching for globals.
 * Returns a handler that resolves true when it has served the request.
 */

const engine = require('./engine');
const coder = require('./coder');
const store = require('./store');
const llm = require('./llm');
const abha = require('./abha');
const { LANGUAGES, CHIEF_COMPLAINTS } = require('./ontology');

function createIntakeRoutes({ terminology, terminologyMeta, curationQueue, readJsonBody, sendJson }) {
  /**
   * Concepts the release leaves unmapped are queued for expert review the first time
   * they are actually proposed for a patient. The queue therefore reflects real
   * clinical demand — which terms Ayush most needs to map next — rather than the
   * whole 2,183-concept backlog.
   */
  function queueForCuration(proposals, summary) {
    for (const proposal of proposals) {
      if (proposal.icd11Tm2Code) continue;
      if (curationQueue.some((q) => q.namasteCode === proposal.namasteCode)) continue;
      curationQueue.push({
        id: `CUR-${Date.now()}-${proposal.namasteCode}`,
        namasteCode: proposal.namasteCode,
        termEnglish: proposal.termEnglish,
        termSanskrit: proposal.termSanskrit,
        confidence: null,
        suggestedTm2: 'PENDING',
        status: 'PENDING_REVIEW',
        submittedAt: new Date().toISOString(),
        clinicalNotes: `Proposed from kiosk intake: ${summary.chiefComplaint}. No TM2 mapping published in the NAMASTE release.`
      });
    }
  }

  return async function handle(req, res, pathname, method, parsedQuery = {}) {
    // ---- ABHA identity ---------------------------------------------------
    // The portal mirrors each masked directory entry here when it mints an ABHA,
    // so the kiosk can resolve one without a signed-in Firebase user.
    if (pathname === '/api/abha/register' && method === 'POST') {
      const body = await readJsonBody(req);
      const entry = abha.registerDirectoryEntry(body);
      if (!entry) {
        sendJson(res, 400, { error: 'An abhaAddress or abhaNumber is required.' });
        return true;
      }
      sendJson(res, 201, { registered: true, directorySize: abha.directorySize() });
      return true;
    }

    if (pathname === '/api/abha/resolve' && method === 'GET') {
      const resolved = await abha.resolve(parsedQuery.q || parsedQuery.abha || '');
      if (!resolved.ok) {
        sendJson(res, 200, { ok: false, error: resolved.error });
        return true;
      }
      sendJson(res, 200, { ok: true, abha: resolved.abha });
      return true;
    }

    // ---- bootstrap -------------------------------------------------------
    if (pathname === '/api/intake/config' && method === 'GET') {
      sendJson(res, 200, {
        languages: LANGUAGES,
        chiefComplaints: CHIEF_COMPLAINTS.map((c) => ({ id: c.id, icon: c.icon, label: c.label })),
        terminology: {
          release: terminologyMeta.namasteRelease,
          icd11Release: terminologyMeta.icd11Release,
          totalConcepts: terminologyMeta.totalConcepts,
          officiallyMapped: terminologyMeta.officiallyMapped,
          unmapped: terminologyMeta.unmapped
        },
        aiEnabled: llm.isEnabled()
      });
      return true;
    }

    // ---- session lifecycle ----------------------------------------------
    if (pathname === '/api/intake/session' && method === 'POST') {
      const body = await readJsonBody(req);
      let session = await store.createSession(body);
      if (body.abha) {
        const resolved = await abha.resolve(body.abha);
        if (resolved.ok) session = (await store.attachAbha(session.id, resolved.abha)) || session;
      }
      sendJson(res, 201, {
        sessionId: session.id,
        language: session.language,
        ayushMode: session.ayushMode,
        patient: session.patient
      });
      return true;
    }

    const sessionMatch = pathname.match(/^\/api\/intake\/([a-f0-9]{12})(\/[a-z]+)?$/);
    if (sessionMatch) {
      const session = await store.getSession(sessionMatch[1]);
      const action = sessionMatch[2] || '';
      if (!session) {
        sendJson(res, 404, { error: 'Session not found or already cleared.' });
        return true;
      }
      const options = { ayushMode: session.ayushMode };

      if (action === '/consent' && method === 'POST') {
        const body = await readJsonBody(req);
        const updated = await store.grantConsent(session.id, body.scopes || ['capture', 'share-with-his', 'link-abha']);
        sendJson(res, 200, { consent: updated ? updated.consent : null });
        return true;
      }

      if (action === '/next' && method === 'GET') {
        const { question, progress } = engine.nextQuestion(session.answers, options);
        sendJson(res, 200, { question, progress, language: session.language });
        return true;
      }

      if (action === '/answer' && method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.questionId) {
          sendJson(res, 400, { error: 'questionId is required.' });
          return true;
        }
        const updated = (await store.recordAnswer(session.id, body.questionId, body.value)) || session;

        // Red flags are evaluated after every answer, not only at the end: a patient
        // describing crushing chest pain should not have to finish the interview first.
        const redFlags = engine.evaluateRedFlags(updated.answers, options);
        const { question, progress } = engine.nextQuestion(updated.answers, options);
        sendJson(res, 200, {
          question,
          progress,
          redFlags,
          escalate: redFlags.some((f) => f.priority === 'CRITICAL')
        });
        return true;
      }

      if (action === '/document' && method === 'POST') {
        const body = await readJsonBody(req);
        // OCR runs in the browser; the server structures what it produced.
        const extracted = await llm.extractLabValues(body.text || '');
        const document = {
          name: body.name || 'Scanned document',
          kind: body.kind || 'report',
          ocrCharacters: String(body.text || '').length,
          reportDate: extracted.reportDate || null,
          labName: extracted.labName || null,
          results: extracted.results || [],
          extraction: extracted.source
        };
        const updated = (await store.addDocument(session.id, document)) || session;
        sendJson(res, 200, { document, documents: updated.documents.length });
        return true;
      }

      if (action === '/finalize' && method === 'POST') {
        const summary = engine.buildSummary(session.answers, options);
        const complaint = engine.complaintById(session.answers.chief_complaint);
        summary.candidateCodes = complaint ? complaint.candidates : [];

        const proposals = coder.proposeConcepts(summary, terminology);
        queueForCuration(proposals, summary);

        const polished = await llm.polishNarrative(summary);
        const bundle = coder.buildBundle({ session, summary, proposals, terminologyMeta });

        const item = await store.publish({
          session, summary, proposals, bundle, narrative: polished.text
        });
        // DPDP: the interview transcript is cleared as soon as it has been handed over.
        await store.endSession(session.id);

        sendJson(res, 201, {
          worklistId: item.id,
          priority: item.priority,
          redFlags: item.redFlags,
          narrative: polished.text,
          narrativeSource: polished.source,
          proposals,
          bundle,
          dualCoded: proposals.filter((p) => p.dualCoded).length,
          unmapped: proposals.filter((p) => !p.dualCoded).length
        });
        return true;
      }
    }

    // ---- physician worklist ---------------------------------------------
    if (pathname === '/api/worklist' && method === 'GET') {
      const [stats, items] = await Promise.all([store.stats(), store.listWorklist()]);
      sendJson(res, 200, {
        stats,
        items: items.map((item) => ({
          id: item.id,
          patient: item.patient,
          priority: item.priority,
          status: item.status,
          chiefComplaint: item.chiefComplaint,
          redFlags: item.redFlags,
          ayushMode: item.ayushMode,
          submittedAt: item.submittedAt,
          abha: item.patient.abha ? item.patient.abha.display : null,
          documents: item.documents.length,
          dualCoded: item.proposals.filter((p) => p.dualCoded).length
        }))
      });
      return true;
    }

    const worklistMatch = pathname.match(/^\/api\/worklist\/([a-f0-9]{12})(\/review|\/abha)?$/);
    if (worklistMatch) {
      const item = await store.getWorklistItem(worklistMatch[1]);
      if (!item) {
        sendJson(res, 404, { error: 'Not on the worklist.' });
        return true;
      }
      if (worklistMatch[2] === '/abha' && method === 'POST') {
        const body = await readJsonBody(req);
        const resolved = await abha.resolve(body.abha || '');
        if (!resolved.ok) {
          sendJson(res, 400, { error: resolved.error });
          return true;
        }
        sendJson(res, 200, { item: await store.attachAbhaToWorklistItem(item.id, resolved.abha) });
        return true;
      }

      if (worklistMatch[2] === '/review' && method === 'POST') {
        const body = await readJsonBody(req);
        sendJson(res, 200, { item: await store.reviewWorklistItem(item.id, body) });
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, { item });
        return true;
      }
    }

    return false;
  };
}

module.exports = { createIntakeRoutes };
