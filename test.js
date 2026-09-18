const assert = require('assert');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

async function runTests() {
  console.log(`\n=============================================================`);
  console.log(`  AyurFHIR Terminology Microservice Automated Test Suite`);
  console.log(`  Target: ${BASE_URL}`);
  console.log(`=============================================================\n`);

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ✓ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ [FAIL] ${name}:`, err.message);
      failed++;
    }
  }

  // Test 1: Service Health
  await test('GET /api/health returns UP with version stamps', async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, 'UP');
    assert.ok(data.versionStamps.namasteRelease);
    assert.ok(data.versionStamps.icd11Release);
  });

  // Test 2: Live WHO ICD-11 Container Entity 2066255370
  await test('GET /icd/entity/2066255370 returns Acute nasopharyngitis', async () => {
    const res = await fetch(`${BASE_URL}/icd/entity/2066255370`, {
      headers: {
        'accept': 'application/json',
        'API-Version': 'v2',
        'Accept-Language': 'en'
      }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.title);
    const titleVal = data.title['@value'] || data.title;
    assert.ok(titleVal.toLowerCase().includes('nasopharyngitis') || titleVal.toLowerCase().includes('cold'));
  });

  // Test 3: FHIR ValueSet $expand
  await test('GET /ValueSet/$expand?q=Amlapitta autocompletes with TM2 code', async () => {
    const res = await fetch(`${BASE_URL}/ValueSet/$expand?q=Amlapitta`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.resourceType, 'ValueSet');
    assert.ok(data.expansion.total > 0);
    const item = data.expansion.contains[0];
    // EB-4 / SM39 is the Amlapitta pair as published in the NAMASTE release and
    // verified against the WHO ICD-11 container.
    assert.strictEqual(item.code, 'EB-4');
    assert.ok(item.extension.some(e => e.url.endsWith('/tm2') && e.valueString === 'SM39'));
  });

  // Test 4: FHIR ConceptMap $translate (Valid mapping)
  await test('POST /ConceptMap/$translate returns equivalence and target TM2/MMS', async () => {
    const res = await fetch(`${BASE_URL}/ConceptMap/$translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'EB-4' })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.resourceType, 'Parameters');
    const resultParam = data.parameter.find(p => p.name === 'result');
    assert.strictEqual(resultParam.valueBoolean, true);
    const matchParam = data.parameter.find(p => p.name === 'match');
    assert.ok(matchParam);
    const coding = matchParam.part.find(p => p.name === 'concept').valueCoding;
    assert.strictEqual(coding.code, 'SM39');
    // Never emit a Coding without a code: that would assert a mapping nobody published.
    data.parameter.filter(p => p.name === 'match').forEach((m) => {
      assert.ok(m.part.find(x => x.name === 'concept').valueCoding.code);
    });
  });

  // Test 5: Honest Semantics & Curation Queue on Unmapped Concept
  await test('POST /ConceptMap/$translate for unmapped concept routes to Curation Queue', async () => {
    const res = await fetch(`${BASE_URL}/ConceptMap/$translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'AAD-1.12' })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const resultParam = data.parameter.find(p => p.name === 'result');
    assert.strictEqual(resultParam.valueBoolean, false);
    const queueParam = data.parameter.find(p => p.name === 'curationQueue');
    assert.strictEqual(queueParam.valueBoolean, true);
  });

  // Test 6: FHIR R4 Bundle POST Dual-Coded Condition Save
  await test('POST /Bundle saves dual-coded Condition into problem list', async () => {
    const res = await fetch(`${BASE_URL}/Bundle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'EB-4',
        patientId: 'Patient/ABHA-91-4821-3920-1102',
        patientName: 'Anjali R. Deshmukh'
      })
    });
    assert.strictEqual(res.status, 201);
    const bundle = await res.json();
    assert.strictEqual(bundle.resourceType, 'Bundle');
    const cond = bundle.entry[0].resource;
    assert.strictEqual(cond.resourceType, 'Condition');
    assert.strictEqual(cond.clinicalStatus.coding[0].code, 'active');
    // Must contain both NAMASTE and ICD-11 TM2 codings
    const codings = cond.code.coding;
    assert.ok(codings.some(c => c.system.includes('namaste')));
    assert.ok(codings.some(c => c.system.includes('tm2')));
  });

  // Test 7: Static Files Served
  await test('GET / and GET /admin.html serve successfully', async () => {
    const rIndex = await fetch(`${BASE_URL}/`);
    assert.strictEqual(rIndex.status, 200);
    const rAdmin = await fetch(`${BASE_URL}/admin.html`);
    assert.strictEqual(rAdmin.status, 200);
  });

  // ---------------------------------------------------------------------
  // Clinical intake kiosk (SIH26047)
  // ---------------------------------------------------------------------

  // Test 8: the kiosk bootstraps from the loaded release, not from hardcoded data.
  await test('GET /api/intake/config exposes complaints and release counts', async () => {
    const res = await fetch(`${BASE_URL}/api/intake/config`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.chiefComplaints.length >= 10);
    assert.ok(data.terminology.totalConcepts > 1000);
    assert.ok(data.terminology.officiallyMapped > 0);
    // Every complaint must be answerable by tapping, so each needs an icon and both labels.
    data.chiefComplaints.forEach((c) => {
      assert.ok(c.icon, `${c.id} has no icon`);
      assert.ok(c.label.hi && c.label.en, `${c.id} is not bilingual`);
    });
  });

  // Walks a full chest-pain intake and asserts the clinically important behaviours.
  let intakeResult = null;
  await test('Intake: chest pain with radiation escalates mid-interview and dual-codes', async () => {
    const post = async (path, body) => {
      const res = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      });
      return { status: res.status, body: await res.json() };
    };

    const created = await post('/api/intake/session', {
      language: 'hi', ayushMode: true,
      patient: { name: 'Test Patient', abhaId: '91-0000-0000-0000' }
    });
    assert.strictEqual(created.status, 201);
    const id = created.body.sessionId;
    await post(`/api/intake/${id}/consent`, { scopes: ['capture'] });

    const script = {
      chief_complaint: 'chest_pain', onset: 'sudden', character: 'pressing',
      radiation: 'arm_jaw', severity: 9, duration: 'today', aggravating: ['exertion'],
      associated: ['sweating'], past_history: ['hypertension'], medications: 'no',
      allergies: 'no', family_history: ['heart_disease'], personal_habits: ['smoking'],
      sleep: 'disturbed', prakriti_skin: 'dry', prakriti_temperament: 'quick',
      prakriti_sleep: 'light', agni: 'vishama', koshtha: 'krura', ahara: ['irregular'],
      vyayama_shakti: 'avara', sattva: 'madhyama', satmya: 'cold', sara_samhanana: 'thin'
    };

    let step = await (await fetch(`${BASE_URL}/api/intake/${id}/next`)).json();
    let escalatedAt = null;
    let asked = 0;
    while (step.question && asked < 60) {
      const q = step.question;
      const value = script[q.id] !== undefined ? script[q.id]
        : (q.options ? q.options[0].value : 'n/a');
      const answered = await post(`/api/intake/${id}/answer`, { questionId: q.id, value });
      if (answered.body.escalate && !escalatedAt) escalatedAt = asked;
      step = answered.body;
      asked++;
    }

    // The interview must stop for a critical finding rather than running to the end.
    assert.ok(escalatedAt !== null, 'chest pain with radiation did not escalate');
    assert.ok(escalatedAt < asked - 1, 'escalation only fired on the last question');

    const final = await post(`/api/intake/${id}/finalize`, {});
    assert.strictEqual(final.status, 201);
    intakeResult = final.body;
    assert.strictEqual(final.body.priority, 'CRITICAL');
    assert.ok(final.body.proposals.length > 0);
    assert.ok(final.body.dualCoded > 0, 'no proposal carried a TM2 code');

    // DPDP: the transcript must not survive handover.
    const afterFinalize = await fetch(`${BASE_URL}/api/intake/${id}/next`);
    assert.strictEqual(afterFinalize.status, 404);
  });

  // Test 10: the bundle is the deliverable, so its shape is asserted explicitly.
  await test('Intake bundle is a FHIR transaction with provisional dual-coded Conditions', async () => {
    assert.ok(intakeResult, 'previous test did not produce a bundle');
    const bundle = intakeResult.bundle;
    assert.strictEqual(bundle.resourceType, 'Bundle');
    assert.strictEqual(bundle.type, 'transaction');

    const types = bundle.entry.map((e) => e.resource.resourceType);
    ['Encounter', 'QuestionnaireResponse', 'Condition', 'Consent', 'Flag'].forEach((t) => {
      assert.ok(types.includes(t), `bundle is missing a ${t}`);
    });

    const condition = bundle.entry.find((e) => e.resource.resourceType === 'Condition').resource;
    // Never auto-confirm a diagnosis the patient typed into a kiosk.
    assert.strictEqual(condition.verificationStatus.coding[0].code, 'provisional');

    const systems = condition.code.coding.map((c) => c.system);
    assert.ok(systems.includes('https://ayush.gov.in/fhir/CodeSystem/namaste'));
    condition.code.coding.forEach((c) => assert.ok(c.code, 'Coding emitted without a code'));
  });

  // Test 11: worklist ordering is what triage depends on.
  await test('GET /api/worklist puts critical patients first', async () => {
    const res = await fetch(`${BASE_URL}/api/worklist`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.items.length > 0);
    const rank = { CRITICAL: 0, URGENT: 1, REVIEW: 2, ROUTINE: 3 };
    const ranks = data.items.map((i) => rank[i.priority]);
    assert.deepStrictEqual(ranks, [...ranks].sort((a, b) => a - b), 'worklist is not priority-ordered');
  });

  // Test 12: the portal's client-side copy is hydrated from this, so it must carry
  // the real release rather than the page's offline seed.
  await test('GET /api/terminology/concepts serves the full NAMASTE release', async () => {
    const res = await fetch(`${BASE_URL}/api/terminology/concepts`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.total > 2000, `expected the full release, got ${data.total}`);
    const amlapitta = data.concepts.find((c) => c.namasteCode === 'EB-4');
    assert.ok(amlapitta, 'EB-4 missing from the concept list');
    assert.strictEqual(amlapitta.icd11Tm2Code, 'SM39');
    // No concept may claim a mapping it does not have.
    data.concepts.forEach((c) => {
      if (c.mappingStatus === 'unmapped') assert.strictEqual(c.icd11Tm2Code, null);
    });
  });

  // Test 13: ABHA captured at the kiosk, and attached afterwards for a walk-in.
  await test('ABHA resolves from the portal directory and attaches to a walk-in', async () => {
    const post = async (path, body) => {
      const res = await fetch(`${BASE_URL}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      });
      return { status: res.status, body: await res.json() };
    };

    const registered = await post('/api/abha/register', {
      abhaAddress: 'testpatient@sbx', abhaKey: '91000011112222',
      nameMasked: 'T*** P*****', gender: 'M', yearOfBirth: 1990
    });
    assert.strictEqual(registered.status, 201);

    // Either form of the same ABHA must resolve to the same person.
    for (const query of ['testpatient@sbx', '91-0000-1111-2222']) {
      const res = await fetch(`${BASE_URL}/api/abha/resolve?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      assert.ok(data.ok, `${query} did not resolve`);
      assert.strictEqual(data.abha.knownToDirectory, true);
      // A directory hit proves the ABHA exists, not who is standing at the kiosk.
      assert.strictEqual(data.abha.verified, false);
    }

    // Garbage is rejected; an unknown but well-formed ABHA is accepted as self-declared.
    const garbage = await (await fetch(`${BASE_URL}/api/abha/resolve?q=notanabha`)).json();
    assert.strictEqual(garbage.ok, false);
    const unknown = await (await fetch(`${BASE_URL}/api/abha/resolve?q=ghost@sbx`)).json();
    assert.strictEqual(unknown.ok, true);
    assert.strictEqual(unknown.abha.knownToDirectory, false);
    assert.strictEqual(unknown.abha.verificationMethod, 'self-declared');

    // A session started with an ABHA carries it into the Patient resource.
    const session = await post('/api/intake/session', { language: 'en', ayushMode: false, abha: 'testpatient@sbx' });
    assert.strictEqual(session.body.patient.abhaId, 'testpatient@sbx');
    await post(`/api/intake/${session.body.sessionId}/consent`, { scopes: ['capture'] });

    let step = await (await fetch(`${BASE_URL}/api/intake/${session.body.sessionId}/next`)).json();
    let guard = 0;
    while (step.question && guard++ < 60) {
      const q = step.question;
      step = (await post(`/api/intake/${session.body.sessionId}/answer`, {
        questionId: q.id, value: q.options ? q.options[0].value : 'n/a'
      })).body;
    }
    const finalised = await post(`/api/intake/${session.body.sessionId}/finalize`, {});
    const patient = finalised.body.bundle.entry.find((e) => e.resource.resourceType === 'Patient').resource;
    assert.ok(patient, 'bundle has no Patient resource');
    assert.strictEqual(patient.identifier[0].value, 'testpatient@sbx');
    // Unverified identity must not be published as official.
    assert.strictEqual(patient.identifier[0].use, 'temp');
    assert.ok(['male', 'female', 'other', 'unknown', undefined].includes(patient.gender));

    // A walk-in finishes with no ABHA, then staff attach one from the worklist.
    const walkIn = await post('/api/intake/session', { language: 'en', ayushMode: false });
    await post(`/api/intake/${walkIn.body.sessionId}/consent`, { scopes: ['capture'] });
    let walkStep = await (await fetch(`${BASE_URL}/api/intake/${walkIn.body.sessionId}/next`)).json();
    guard = 0;
    while (walkStep.question && guard++ < 60) {
      const q = walkStep.question;
      walkStep = (await post(`/api/intake/${walkIn.body.sessionId}/answer`, {
        questionId: q.id, value: q.options ? q.options[0].value : 'n/a'
      })).body;
    }
    const walkFinal = await post(`/api/intake/${walkIn.body.sessionId}/finalize`, {});

    const rejected = await post(`/api/worklist/${walkFinal.body.worklistId}/abha`, { abha: 'nonsense' });
    assert.strictEqual(rejected.status, 400);

    const attached = await post(`/api/worklist/${walkFinal.body.worklistId}/abha`, { abha: 'testpatient@sbx' });
    assert.strictEqual(attached.status, 200);
    assert.strictEqual(attached.body.item.patient.abha.display, 'testpatient@sbx');
    // The bundle went out before the ABHA existed; its references must be repointed.
    const repointed = attached.body.item.bundle.entry
      .filter((e) => e.resource.subject && e.resource.subject.reference === 'Patient/testpatient@sbx');
    assert.ok(repointed.length > 0, 'bundle references were not repointed to the attached ABHA');
  });

  console.log(`\n=============================================================`);
  console.log(`  Tests Passed: ${passed} / ${passed + failed}`);
  console.log(`=============================================================\n`);

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
