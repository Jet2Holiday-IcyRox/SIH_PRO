# AyurFHIR Bridge — clinical intake kiosk (SIH26047)

A patient-facing clinical intake kiosk for AYUSH and general OPDs, whose output is not a
text summary but an ABDM-conformant FHIR R4 Bundle carrying NAMASTE codes dual-coded to
ICD-11 TM2.

A patient answers a structured history by speaking or tapping, in Hindi or English,
before the consultation. The kiosk screens for red flags as it goes, scans prior
reports, and pushes a coded, physician-editable summary to the doctor's screen.

## Terminology — what is real

| | |
| --- | --- |
| Source | `NATIONAL AYURVEDA MORBIDITY CODES.xls` (Ministry of Ayush) |
| Concepts loaded | 2,892 |
| Officially mapped to ICD-11 TM2 | 709 |
| Awaiting curation | 2,183 |
| ICD-11 release | 2026-01 MMS, Chapter 26 (Traditional Medicine Conditions) |

The release encodes its own crosswalk inside `NAMC_CODE`: a row coded `SP12 (AAE-16)`
carries the WHO TM2 code `SP12` and the NAMASTE code `AAE-16`. Every TM2 code in the
generated dataset was resolved against the licensed WHO ICD-11 container — no display
text or code is invented anywhere in the pipeline.

**No complete NAMASTE→TM2 crosswalk exists**, and this project does not pretend one does.
Roughly three quarters of the release has no published TM2 equivalent. Those concepts are
emitted NAMASTE-only, flagged `unmapped`, and routed to the curation queue rather than
being guessed at.

Regenerate the dataset (needs the WHO container running and LibreOffice for the .xls):

```bash
soffice --headless --convert-to csv "NATIONAL AYURVEDA MORBIDITY CODES.xls"
npm run build:terminology
```

## The intake pipeline

```
patient speaks / taps (hi, en)
  → ontology-driven dialogue manager   intake/ontology.js, intake/engine.js
  → red-flag triage rules              fires mid-interview, not at the end
  → structured history
  → NAMASTE ↔ ICD-11 TM2 coding        intake/coder.js, against the official release
  → FHIR R4 transaction Bundle         Encounter, QuestionnaireResponse, Condition,
                                       Observation, Flag, Consent
  → physician worklist                 /worklist — confirm, amend or reject
```

The dialogue is a state machine over a declared question graph, not a chatbot. Every
question the kiosk can ask is in `intake/ontology.js`, so the interview is reproducible
and reviewable.

The AI layer (`intake/llm.js`) is optional and additive: it polishes an already-generated
narrative and extracts values from OCR'd lab reports. Without an API key — or when a call
fails or times out — the kiosk behaves identically using its deterministic output. It can
never introduce a clinical question, assign a code, or state a diagnosis.

Provider is selected from whichever key is present in `backend/.env`, Gemini first:

| Key | Provider | Default model |
| --- | --- | --- |
| `GEMINI_API_KEY` | Google Gemini (REST, no SDK dependency) | `gemini-3.6-flash` |
| `ANTHROPIC_API_KEY` | Anthropic (`@anthropic-ai/sdk`) | `claude-opus-5` |
| neither | none — fully deterministic | — |

Every call is raced against `LLM_TIMEOUT_MS` (default 12s) and falls back to the
deterministic result on timeout, error, or a blocked response.

Three safety properties hold by construction:

- Conditions are emitted `provisional`. The physician confirms; nothing auto-files.
- A red flag stops the interview immediately and names the evidence that triggered it.
- The session transcript is deleted the moment it is handed to the HIS (DPDP 2023).

### ABHA identity

The practitioner portal already mints a mock ABHA at sign-up and writes the private
`abha/<abhaKey>` record plus a masked `abhaDirectory/<address>` discovery entry. The
kiosk reuses that identity rather than inventing its own.

The kiosk page has no signed-in Firebase user, so it cannot read `abhaDirectory`
directly. The portal therefore mirrors each masked entry to `POST /api/abha/register`
as it creates one, and the kiosk resolves against that bridge
(`GET /api/abha/resolve?q=…`). Only fields the portal already treats as
pre-consent-readable cross over — masked name, masked number, gender, year of birth.
The bridge is persisted to `data/abha_directory.json` so ABHAs created in an earlier
session still resolve after a restart.

Either form resolves: an ABHA address (`rukmini@sbx`) or the 14-digit number. A QR
payload is parsed too. Three outcomes:

| Input | Result |
| --- | --- |
| Known ABHA | Patient confirms a masked name; `verificationMethod: directory-match-pending-otp` |
| Well-formed but unknown | Accepted as `self-declared`; intake continues |
| Malformed | Rejected, patient re-enters or continues as a walk-in |

**`verified` is never set true by this code.** A directory hit proves the ABHA exists,
not that the person at the kiosk owns it — that needs an OTP to the linked mobile,
which is the next thing to wire in. Until then the FHIR Identifier goes out with
`use: "temp"` and a `self-declared-unverified` / `pending-otp` marker. Publishing an
unverified identity as `official` would corrupt a real patient's national record.

Walk-ins can finish intake with no ABHA; staff attach one later from the worklist,
which repoints the bundle's subject references to the newly linked patient.

### AYUSH mode

Selecting the AYUSH OPD adds Dashavidha Pariksha — Agni, Koshtha, Ahara, Vyayama Shakti,
Sattva, Satmya, Sara/Samhanana — plus a scored Prakriti screen. Findings are emitted as
FHIR Observations labelled with the parameter each assesses. The Prakriti result is
explicitly provisional: it is a screening instrument for the physician to confirm.

---

## Original terminology service

This branch also retains the Express backend and admin console from the earlier build.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000/`. One command, one process. `server.js` handles the terminology
API and the portal, and delegates the admin console and auth to the backend app it imports
from `backend/src/app.js`:

| Path | Served by | What it is |
| --- | --- | --- |
| `/` | `server.js` | practitioner portal (`index.html`) — patient, hospital and insurer portals |
| `/kiosk` | `server.js` | **patient intake kiosk** — voice + touch clinical history |
| `/worklist` | `server.js` | **physician worklist** — summaries, coding, FHIR bundle |
| `/admin/` | backend | admin console — Users & Roles, Audit Logs, Live API Request Monitor |
| `/patient/` | backend | the older standalone patient page |
| `/shared/*` | backend | frontend ES modules |
| `/api/v1/auth/*`, `/api/v1/admin/*` | backend | Firebase auth and admin API |
| `/api/health`, `/api/curation` | `server.js` | health and curation queue |
| `/api/intake/*` | `server.js` | kiosk session, dialogue, documents, finalize |
| `/api/worklist/*` | `server.js` | physician worklist and review |
| `/ValueSet/$expand`, `/ConceptMap/$translate`, `/Bundle` | `server.js` | FHIR R4 terminology operations |
| `/icd/*` | `server.js` | WHO ICD-11 container proxy (`ICD11_HOST`, default `http://localhost`) |

`/admin` and `/admin.html` both redirect to `/admin/`, so the portal's "Open Admin Console"
button lands on the real console.

The backend is imported, not spawned — it only calls `listen()` when run directly, so this is a
single process on a single port. If it fails to load, the portal and terminology API keep working
and `/admin/` returns 503.

`npm test` runs `test.js` against a running server on port 3000.

### Other entry points

Not needed for normal development; they exist for working on a sub-app in isolation:

| Command | Port | Serves |
| --- | --- | --- |
| `npm run dev:client` | 5173 | `client/server.js` — hospital EMR client, own copy of the pages |
| `npm run dev:admin` | 5174 | `admin/server.js` — own copy of the pages |
| `npm run dev:backend` | 3000 | `backend/src/app.js` alone, without the terminology API |

## Firestore security rules

`firestore.rules` governs what the **browser** may do. The backend uses the Admin SDK, which
bypasses rules entirely, so nothing here can lock the server out.

```bash
npx firebase deploy --only firestore:rules
```

Firestore denies everything by default, so the portal will fail closed until these are deployed.

Ownership is always proven from a stored document, never from a client-supplied value: a patient
owns `abha/<abhaKey>` and a facility owns `hips/<hipId>`, each via its `ownerUid`. The rules read
the `_parent`/`_key` fields the Firestore adapter writes, rather than parsing document ids.

The rule that matters most is on `users/{uid}`. The portal's signup form writes `role` straight
from a `<select>`, and the backend's `requireRole('admin')` reads that same field — so an
unconstrained write there would let any browser grant itself the admin API. The client is limited
to `patient`, `hospital` and `user`, and can neither introduce nor retain `admin`; only the Admin
SDK can set that. Admin reads are gated on the `role` **custom claim**, which the backend sets via
`setCustomUserClaims` and a browser cannot forge.

Other invariants worth knowing:

- `abhaDirectory` is readable by any signed-in user on purpose — a facility resolves a patient by
  ABHA address before any consent exists, and those records are masked by construction.
- A facility can offer a record (`linkRequests`) but only the patient can approve it, and the
  attached bundle cannot be altered during approval.
- `careContexts` is written by the patient alone; records arrive there only through an approved
  link request.
- Neither party can rewrite who a consent is between, what it covers, or when it expires.
- `dataAccessLogs` and `auditLogs` are append-only for everyone, including the patient.
- **The decision on a consent is the patient's alone.** A requester — hospital or insurer — may
  only revoke; it cannot flip its own request to `GRANTED`. That never disclosed anything (the
  payload under `disclosures/<cid>` is still writable by the patient only), but without the rule a
  requester could display a grant that was never signed and write `CONSENT_GRANTED` into the
  patient's ledger.

### Insurance collections

`policyDirectory` is the one lookup that is deliberately **not** open the way `abhaDirectory` is. An
ABHA address is chosen by its owner; a policy number is issued by a company and printed on paper
that changes hands, so a directory readable by any signed-in user would be a fishing licence. A
`get` therefore resolves only for the policyholder or the insurer named in the document, `list` is
admin-only, and only the patient may write it — an insurer cannot attach a policy to an ABHA that
has not claimed it. A number that does not exist and a number belonging to a rival insurer both
come back denied, which is the same answer on purpose.

| Collection | Written by | Read by |
| --- | --- | --- |
| `insurers/<insurerId>` | the owning account | the owner (holds the API key hash) |
| `insurerDirectory/<insurerId>` | the owning account | any signed-in user, so a patient can pick an insurer |
| `policyDirectory/<policyKey>` | the patient only | the policyholder, and the issuing insurer |
| `patientPolicies/<abhaKey>/<policyKey>` | the patient | the patient |
| `insurerConsents/<insurerId>/<cid>` | the requesting insurer | that insurer |

The rules for all of the above are covered by an emulator test suite. It is not wired into
`npm test`, because it needs the emulator and two extra packages:

```bash
npm i --no-save @firebase/rules-unit-testing firebase
npx firebase-tools emulators:exec --only firestore "node test/firestore-rules.test.mjs"
```

## Firebase setup

Login uses **Firebase Authentication (Email/Password)** in the browser and **Firebase Admin + Cloud Firestore** on the server. Fill `backend/.env` from `backend/.env.example`:

1. **Enable the provider** — Firebase Console → Authentication → Sign-in method → enable *Email/Password*.
2. **Enable Firestore** — Console → Build → Firestore Database → Create database. Profiles are written to `users/{uid}` and request logs to `apiRequests/{id}` by the server only.
3. **Web config** — Console → Project settings → General → Your apps → Web app. Copy into `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_STORAGE_BUCKET`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_APP_ID`. These are public by design and are served to the browser by `GET /api/v1/auth/config`; the pages no longer hardcode them.
4. **Service account** — Console → Project settings → Service accounts → Generate new private key. Save it outside version control (`backend/secrets/` is gitignored) and point `FIREBASE_SERVICE_ACCOUNT_PATH` at it, or paste the JSON into `FIREBASE_SERVICE_ACCOUNT_JSON`. **This is a server-only secret — never ship it to the browser.**
5. **First admin** — put your email in `ADMIN_BOOTSTRAP_EMAILS`. That account gets `role: admin` on first sign-in; it can then promote others from the admin console.
6. **Deployed domains** — Console → Authentication → Settings → Authorized domains must list the host you serve from.

### How a login flows

1. The browser signs in with Firebase Auth and receives an ID token.
2. `frontend/shared/api.js` sends that token as `Authorization: Bearer …` on every API call.
3. `backend/src/middleware/auth.js` verifies it with the Admin SDK, then loads the profile from Firestore.
4. The **role comes back from the server**, never from a browser-side database read, so the client cannot self-promote.

## API

- `GET /api/health`
- `GET /api/v1/auth/config` — browser-safe Firebase Web config
- `GET /api/v1/auth/session` — the verified caller's uid, email, name, and role
- `POST /api/v1/auth/register` — creates the server-owned profile after client-side signup (role in the body is ignored)
- `GET /api/v1/admin/users`, `POST /api/v1/admin/users/:uid/role`, `GET /api/v1/admin/requests` — admin role required
- `GET /api/v1/terminology/search?q=Amlapitta&stream=Ayurveda`
- `GET /api/v1/icd11/status` — release, linearization, and whether the ICD-API container answers
- `GET /api/v1/icd11/search?q=asthma&chapter=12&flexible=true` — full-text disease search
- `GET /api/v1/icd11/entity/:id` — one entity with definition, inclusions, exclusions, index terms, parents, children
- `GET /api/v1/icd11/code/:code` — reverse lookup from an ICD-11 code (e.g. `5A11`)
- `GET /api/v1/icd11/chapters` — the 28 top-level chapters
- `GET /api/v1/icd11/autocode?q=chronic+cough` — best-match code for free clinical text
- `POST /api/v1/terminology/map`
- `GET /api/v1/fhir/sample?type=condition`
- `POST /api/v1/consent`
- `GET /api/v1/patients/:id/records` (requires an active mock consent and `x-hospital-id`)

Mapping input requires `emrPatientId`, `ayushSystem`, `legacyTerm`, `namasteCode`, and an optional supported `outputFormat`.

## WHO ICD-11 integration

The `/api/v1/icd11/*` routes proxy a **WHO ICD-API container**, which is normally run locally:

```bash
docker run -p 80:80 -e acceptLicense=true -e saveAnalytics=false whoicd/icd-api
```

Point the backend at it with `ICD_API_BASE_URL` (default `http://localhost`). The container serves
the classification without OAuth, so no client id/secret is needed — unlike the hosted
`id.who.int` API. Leaving `ICD_API_RELEASE_ID` empty makes the backend ask the container which
release it ships, so a container upgrade needs no config change.

Both portals get an **ICD-11 Disease Search** button in the sidebar. It opens a browser over the
live classification: chapter drill-down, full-text and flexible search, direct code lookup,
best-match autocoding for free text, and a detail panel with definitions, inclusions, exclusions,
synonyms, index terms, postcoordination axes, and clickable parents/children. Both pages render it
from the single `frontend/shared/icd-explorer.js` module.

Search titles arrive from the API wrapped in its own `<em class='found'>` match markers. The
backend escapes every title and then reintroduces only those markers as `<mark>`, so classification
content can never inject markup into either portal.

If the container is not running, the endpoints answer `503` with the reason and the portals show an
offline notice instead of failing silently.

## The insurance portal

A third portal sits beside the patient and hospital ones, for insurers and TPAs. Its entry point is
the **policy number and nothing else** — no ABHA address, no phone number, no name.

1. **The patient links the policy.** In the patient portal, *My insurance policies* attaches a
   policy number to their ABHA, choosing the insurer from the public `insurerDirectory`. This is the
   only way a policy number ever becomes resolvable, and it grants the insurer nothing.
2. **The insurer resolves a claimant.** Typing the policy number returns masked demographics and the
   cover period — enough to confirm the right person, and no diagnosis, facility or treatment date.
3. **The insurer raises a claim request.** Purpose is pinned to `HPAYMT` (Healthcare Payment); a
   payer cannot dress a claim check up as care management. The request carries the claim reference
   and the policy number, and the date range defaults to the cover period rather than all of time.
4. **The patient signs it, record by record**, in the same OTP-signed review a hospital request goes
   through — with the requester shown as an insurer, and the policy number they were found by
   spelled out.
5. **The insurer reads the disclosure**, and gets a claims-oriented view: the ICD-11 MMS codes to
   adjudicate on, pulled out of the FHIR bundles, beside the NAMASTE terms the AYUSH practitioner
   actually recorded.

Consent is not skipped because the identifier is a policy number. A claim consent reuses the same
consent document, signature, disclosure payload and append-only ledger a hospital request uses —
`requesterType` distinguishes them and `insurerId` is what the security rules authorise against — so
a revoke kills an insurer's access mid-session exactly as it kills a hospital's.

## FHIR responses have a GUI

Every FHIR surface used to end at a `<pre>` of JSON. Each now has a **Visual / JSON** pair of tabs
filled from the same object, so the wire format and the reading of it cannot drift apart:

- the **FHIR Resource Explorer**, where Validate still parses the JSON pane
- both **record viewers** — the patient's own records, and what a hospital or insurer fetched
- the **API console** response, including non-FHIR bodies and error envelopes

The renderer handles Bundle, Composition, Patient, Organization, Condition, MedicationRequest,
DiagnosticReport, Observation, Consent, Provenance, ConceptMap, ValueSet, CapabilityStatement,
Parameters and OperationOutcome, and falls back to a readable field grid for anything else. Codings
are chips labelled by system, so a dual-coded `CodeableConcept` reads as *one concept, four systems*
at a glance; `$translate` shows equivalence and a confidence bar; `$expand` shows each concept with
its cross-codes.

Bundles arrive from other parties through disclosures, so a resource is untrusted input. Narrative
`text.div` is XHTML by spec and is stripped to plain text rather than injected, and every value is
escaped before it is concatenated.

## Architecture

`backend/src` owns API routes, input validation, terminology mapping, FHIR construction, consent, and integration boundaries. Demo NAMASTE/ICD-11 mappings and ABDM records are explicitly mock data. They are isolated so official providers can replace them later.

`frontend/shared/firebase-auth.js` is the only place the browser touches Firebase Auth; `frontend/shared/api.js` is the API client and attaches the ID token. `patient-api.js` and `admin-api.js` wire those into the two pages, whose inline scripts now only handle presentation. The Realtime Database SDK is gone from both pages.

`backend/src/integrations/icd/icdAdapter.js` is the ICD-API boundary (HTTP, timeouts, release discovery, TTL cache) and `backend/src/services/icdService.js` normalises the API's JSON-LD into the flat, HTML-safe shape the portals consume.

`backend/src/integrations/firebase/firebaseAdapter.js` is the server-side Firebase boundary: token verification, Firestore profiles, roles, and custom claims. Without a service account it falls back to an in-memory store and verifies nothing, which keeps the demo and tests runnable.

## Security and prototype limits

- Roles are assigned server-side only. The patient signup form no longer offers an "admin" option, and the admin signup form creates an ordinary account unless the email is in `ADMIN_BOOTSTRAP_EMAILS`.
- Development identity headers (`x-demo-*`) work only when no service account is configured, never in production, and are hard-capped at the `user` role so they cannot reach admin routes.
- Without a service account the backend does not verify ID tokens at all — treat that mode as a demo, not as authentication.
- The admin console's "Offline Demo" bypass is presentation-only; it holds no server session, so the live Users and Requests tabs stay empty.
- Consent and ABDM use in-memory mock adapters. No ABHA/Aadhaar lookup is implemented.
- Insurers are self-registered: the IRDAI registration number is stored as typed and is not verified
  against any registry, and nothing checks that a policy number a patient links was ever issued to
  them. Both are the same class of prototype gap as the mock ABHA issuance, and both are contained
  by the same rule — a policy link discloses nothing on its own, and every read still needs a
  signed consent.
- FHIR resources are compatible-shaped prototypes and explicitly not asserted to be formally validated.
- API logs are deliberately minimized and do not retain the full patient mapping request/response.
- ICD-11 browsing is read-only reference data and, like the demo terminology search, is open to unauthenticated callers. Using the WHO ICD-API requires accepting its licence terms.
