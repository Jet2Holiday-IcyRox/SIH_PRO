/**
 * Turns a completed intake into coded FHIR.
 *
 * This is the step that separates the kiosk from a note-taking app: the structured
 * history is matched against the official NAMASTE release and emitted as a FHIR R4
 * Bundle carrying both the NAMASTE code and, where the release publishes one, the
 * ICD-11 TM2 code.
 *
 * Two rules govern the coding, and both exist because getting them wrong would make
 * the record worse than no record:
 *
 *  1. A code is *proposed*, never asserted. Every Condition is emitted with
 *     verificationStatus 'provisional' and is the physician's to confirm or reject.
 *  2. Where the release publishes no TM2 mapping, nothing is invented. The concept
 *     goes out NAMASTE-only and into the curation queue. Roughly three quarters of
 *     the release is in that state, and pretending otherwise would be fabrication.
 */

const abha = require('./abha');

const NAMASTE_SYSTEM = 'https://ayush.gov.in/fhir/CodeSystem/namaste';
const TM2_SYSTEM = 'http://id.who.int/icd/release/11/mms/tm2';

/** Scores a concept against the patient's own words so the top proposal is explainable. */
function scoreConcept(concept, terms) {
  const haystack = [
    concept.termEnglish, concept.term, concept.termTransliteration,
    concept.icd11Tm2Title, ...(concept.synonyms || [])
  ].filter(Boolean).join(' ').toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (!term || term.length < 4) continue;
    if (haystack.includes(term)) score += term.length;
  }
  // An officially mapped concept is worth preferring when scores are otherwise close:
  // it is the one that can carry a TM2 code into the national record.
  if (concept.icd11Tm2Code) score += 3;
  return score;
}

/**
 * Proposes concepts for a completed summary.
 * `candidates` from the ontology are looked up first; free text is used to rank them
 * and, for the 'other' complaint, to search the whole release.
 */
function proposeConcepts(summary, terminology, limit = 3) {
  const byCode = new Map(terminology.map((c) => [c.namasteCode, c]));
  const complaintCandidates = (summary.candidateCodes || [])
    .map((code) => byCode.get(code))
    .filter(Boolean);

  const terms = [
    summary.chiefComplaint,
    ...Object.values(summary.sections || {}).flat().map((e) => e.answer)
  ].join(' ').toLowerCase().split(/[^a-zऀ-ॿ]+/).filter(Boolean);

  const pool = complaintCandidates.length ? complaintCandidates : terminology;
  const ranked = pool
    .map((concept) => ({ concept, score: scoreConcept(concept, terms) }))
    .filter((r) => complaintCandidates.length || r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return ranked.map(({ concept, score }) => ({
    namasteCode: concept.namasteCode,
    term: concept.term,
    termSanskrit: concept.termSanskrit,
    termEnglish: concept.termEnglish,
    icd11Tm2Code: concept.icd11Tm2Code,
    icd11Tm2Title: concept.icd11Tm2Title,
    icd11EntityId: concept.icd11EntityId,
    mappingStatus: concept.mappingStatus,
    relationship: concept.relationship,
    // Dual-coded only when the release actually publishes the pair.
    dualCoded: Boolean(concept.icd11Tm2Code),
    matchScore: score
  }));
}

/** FHIR administrative-gender is a closed set; the portal stores 'M'/'F'/'O'. */
function normaliseGender(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return undefined;
  if (v === 'm' || v === 'male') return 'male';
  if (v === 'f' || v === 'female') return 'female';
  if (v === 'o' || v === 'other') return 'other';
  return 'unknown';
}

function codingFor(proposal) {
  const coding = [{
    system: NAMASTE_SYSTEM,
    code: proposal.namasteCode,
    display: proposal.termEnglish,
    userSelected: false
  }];
  if (proposal.icd11Tm2Code) {
    coding.push({
      system: TM2_SYSTEM,
      code: proposal.icd11Tm2Code,
      display: proposal.icd11Tm2Title || proposal.termEnglish
    });
  }
  return coding;
}

/**
 * Builds the transaction Bundle the kiosk hands to the HIS.
 *
 * Contents: the Encounter, a QuestionnaireResponse holding the full interview (so the
 * record shows what was actually asked, not only what was concluded), one provisional
 * Condition per proposed concept, Observations for the Dashavidha Pariksha findings,
 * a Flag for each red flag, and the Consent artefact.
 */
function buildBundle({ session, summary, proposals, terminologyMeta }) {
  const now = new Date().toISOString();
  const patientRef = `Patient/${session.patient.abhaId || session.id}`;
  const entries = [];

  // The Patient resource carries the ABHA as a FHIR Identifier whose `use` reports
  // whether the identity was actually verified. Without it the rest of the bundle
  // would reference a patient nothing can resolve.
  const patientId = `pat-${session.id}`;
  const identifiers = [];
  const abhaIdentifier = abha.toFhirIdentifier(session.patient.abha);
  if (abhaIdentifier) identifiers.push(abhaIdentifier);
  identifiers.push({
    use: 'secondary',
    system: 'https://ayurfhir.local/ns/kiosk-session',
    value: session.id,
    assigner: { display: 'Clinical intake kiosk' }
  });

  entries.push({
    fullUrl: `urn:uuid:${patientId}`,
    resource: {
      resourceType: 'Patient',
      id: patientId,
      identifier: identifiers,
      name: session.patient.name ? [{ text: session.patient.name }] : undefined,
      gender: normaliseGender(session.patient.gender),
      extension: session.patient.abha ? [{
        url: 'https://ayurfhir.local/abha-directory-match',
        valueBoolean: Boolean(session.patient.abha.knownToDirectory)
      }] : undefined
    },
    request: { method: 'POST', url: 'Patient' }
  });

  const encounterId = `enc-${session.id}`;
  entries.push({
    fullUrl: `urn:uuid:${encounterId}`,
    resource: {
      resourceType: 'Encounter',
      id: encounterId,
      status: 'arrived',
      class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
      subject: { reference: patientRef, display: session.patient.name },
      period: { start: session.startedAt },
      serviceType: {
        text: summary.ayushMode ? 'AYUSH outpatient department' : 'General outpatient department'
      },
      priority: {
        text: summary.priority,
        coding: [{
          system: 'http://terminology.hl7.org/CodeSystem/v3-ActPriority',
          code: summary.priority === 'CRITICAL' ? 'EM' : summary.priority === 'URGENT' ? 'UR' : 'R',
          display: summary.priority
        }]
      }
    },
    request: { method: 'POST', url: 'Encounter' }
  });

  // The interview itself, item by item. A summary alone would lose which questions
  // were put to the patient and in what words.
  const qrId = `qr-${session.id}`;
  entries.push({
    fullUrl: `urn:uuid:${qrId}`,
    resource: {
      resourceType: 'QuestionnaireResponse',
      id: qrId,
      status: 'completed',
      subject: { reference: patientRef },
      encounter: { reference: `Encounter/${encounterId}` },
      authored: now,
      source: { reference: patientRef },
      item: Object.entries(summary.sections).flatMap(([section, entriesInSection]) =>
        entriesInSection.map((e) => ({
          linkId: `${section}.${e.id}`,
          text: e.question,
          answer: [{ valueString: e.answer }]
        }))
      )
    },
    request: { method: 'POST', url: 'QuestionnaireResponse' }
  });

  proposals.forEach((proposal, index) => {
    const condId = `cond-${session.id}-${index}`;
    entries.push({
      fullUrl: `urn:uuid:${condId}`,
      resource: {
        resourceType: 'Condition',
        id: condId,
        meta: {
          lastUpdated: now,
          tag: [
            { system: 'https://ayush.gov.in/version', code: terminologyMeta.namasteRelease },
            { system: 'http://id.who.int/icd/release', code: terminologyMeta.icd11Release },
            // Machine-readable provenance: this came from a kiosk, not a clinician.
            { system: 'https://ayurfhir.local/provenance', code: 'patient-reported-intake', display: 'Captured by clinical intake kiosk' }
          ]
        },
        clinicalStatus: {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active', display: 'Active' }]
        },
        // Provisional until the physician confirms. This is the whole safety argument.
        verificationStatus: {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'provisional', display: 'Provisional' }]
        },
        category: [{
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item', display: 'Problem List Item' }]
        }],
        code: {
          coding: codingFor(proposal),
          text: `${proposal.term} — ${proposal.termEnglish}`
        },
        subject: { reference: patientRef, display: session.patient.name },
        encounter: { reference: `Encounter/${encounterId}` },
        recordedDate: now,
        note: [{ text: summary.narrative }],
        extension: [{
          url: 'https://ayush.gov.in/fhir/StructureDefinition/mapping-status',
          valueCode: proposal.mappingStatus
        }]
      },
      request: { method: 'POST', url: 'Condition' }
    });
  });

  // Dashavidha Pariksha findings as Observations, each labelled with the parameter
  // it assesses so an Ayurvedic reviewer can read them as a Pariksha, not as free text.
  const ayushEntries = (summary.sections.ayush || []);
  ayushEntries.forEach((entry, index) => {
    const obsId = `obs-${session.id}-${index}`;
    entries.push({
      fullUrl: `urn:uuid:${obsId}`,
      resource: {
        resourceType: 'Observation',
        id: obsId,
        status: 'preliminary',
        category: [{
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'survey', display: 'Survey' }]
        }],
        code: { text: entry.pariksha || entry.question },
        subject: { reference: patientRef },
        encounter: { reference: `Encounter/${encounterId}` },
        effectiveDateTime: now,
        valueString: entry.answer
      },
      request: { method: 'POST', url: 'Observation' }
    });
  });

  if (summary.prakriti) {
    const prakritiId = `obs-prakriti-${session.id}`;
    entries.push({
      fullUrl: `urn:uuid:${prakritiId}`,
      resource: {
        resourceType: 'Observation',
        id: prakritiId,
        status: 'preliminary',
        code: { text: 'Prakriti (constitutional assessment, provisional)' },
        subject: { reference: patientRef },
        encounter: { reference: `Encounter/${encounterId}` },
        effectiveDateTime: now,
        valueString: summary.prakriti.label,
        component: Object.entries(summary.prakriti.tally).map(([dosha, score]) => ({
          code: { text: dosha },
          valueInteger: score
        })),
        note: [{ text: `Screening instrument, ${summary.prakriti.basis}. Requires physician confirmation.` }]
      },
      request: { method: 'POST', url: 'Observation' }
    });
  }

  summary.redFlags.forEach((flag, index) => {
    const flagId = `flag-${session.id}-${index}`;
    entries.push({
      fullUrl: `urn:uuid:${flagId}`,
      resource: {
        resourceType: 'Flag',
        id: flagId,
        status: 'active',
        category: [{ text: 'Clinical triage' }],
        code: { text: flag.concern.en },
        subject: { reference: patientRef },
        encounter: { reference: `Encounter/${encounterId}` },
        period: { start: now },
        extension: [
          { url: 'https://ayurfhir.local/triage-priority', valueCode: flag.priority },
          { url: 'https://ayurfhir.local/triage-evidence', valueString: flag.matched.join(', ') }
        ]
      },
      request: { method: 'POST', url: 'Flag' }
    });
  });

  const consentId = `consent-${session.id}`;
  entries.push({
    fullUrl: `urn:uuid:${consentId}`,
    resource: {
      resourceType: 'Consent',
      id: consentId,
      status: 'active',
      scope: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentscope', code: 'patient-privacy' }] },
      category: [{ coding: [{ system: 'http://loinc.org', code: '59284-0', display: 'Patient Consent' }] }],
      patient: { reference: patientRef },
      dateTime: session.consent ? session.consent.grantedAt : now,
      policyRule: { text: 'Digital Personal Data Protection Act 2023; ABDM consent framework' },
      provision: {
        type: 'permit',
        purpose: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'TREAT', display: 'Treatment' }]
      }
    },
    request: { method: 'POST', url: 'Consent' }
  });

  return {
    resourceType: 'Bundle',
    id: `intake-${session.id}`,
    type: 'transaction',
    timestamp: now,
    entry: entries
  };
}

module.exports = { proposeConcepts, buildBundle, NAMASTE_SYSTEM, TM2_SYSTEM };
