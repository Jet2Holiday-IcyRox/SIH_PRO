/**
 * ABHA identity for the kiosk.
 *
 * The practitioner portal already mints a mock ABHA at sign-up and writes two
 * records: the private `abha/<abhaKey>` identity and a masked `abhaDirectory/<address>`
 * discovery entry. The directory is the record a HIP is allowed to read *before* any
 * consent exists, which is exactly the kiosk's situation — a patient walks up and
 * presents an address, and the kiosk needs to confirm it is a real ABHA and show them
 * enough to say "yes, that's me".
 *
 * Those records live in the portal's Firestore, which the kiosk page cannot read (it
 * has no signed-in user). The server can: with a service account it resolves straight
 * from the `abhaDirectory` collection the portal writes. Without one (a local clone
 * with no Firebase) it falls back to the bridge below, which the portal fills by
 * mirroring each masked entry at creation time. Either way only masked fields are
 * used — the same fields the portal already treats as pre-consent-readable.
 *
 * An ABHA that does not resolve is still accepted, recorded as self-declared and
 * unverified. Refusing the patient would be worse, and silently upgrading them to
 * "verified" would corrupt a national record.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('./db');

// The portal's collection and its document-id rule (index.html addressToKey): the
// address lower-cased with the characters Firebase keys forbid replaced by '_'.
const DIRECTORY_COLLECTION = 'abhaDirectory';
const directoryDocId = (address) => String(address || '').trim().toLowerCase().replace(/[.#$/[\]]/g, '_');

// The bridge is mirrored to disk. Without this, restarting the server would strand
// every ABHA the portal already minted — the portal only mirrors at creation time,
// so a patient who signed up yesterday would stop resolving at the kiosk today.
//
// On a serverless host the bundle is read-only and /tmp is the only writable path, so
// the mirror goes there. It survives warm invocations but not a cold start, which is
// the best a filesystem mirror can do without a real datastore behind it — see the
// deployment note in README.md.
const DEFAULT_STORE = process.env.VERCEL
  ? path.join(os.tmpdir(), 'abha_directory.json')
  : path.join(__dirname, '..', 'data', 'abha_directory.json');
const STORE_FILE = process.env.ABHA_DIRECTORY_FILE || DEFAULT_STORE;

// ABHA numbers are 14 digits, conventionally shown as 91-XXXX-XXXX-XXXX.
const ABHA_NUMBER = /^\d{14}$/;
// ABHA addresses are an ABDM local-part against a provider suffix (@sbx, @abdm).
const ABHA_ADDRESS = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]@[a-z]{2,20}$/i;

const digitsOnly = (value) => String(value || '').replace(/\D/g, '');

const formatNumber = (value) => {
  const d = digitsOnly(value);
  return d.length === 14 ? `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6, 10)}-${d.slice(10)}` : d;
};

const maskNumber = (value) => {
  const d = digitsOnly(value);
  return d.length === 14 ? `${d.slice(0, 2)}-XXXX-XXXX-${d.slice(10)}` : null;
};

function maskAddress(address) {
  const [local, domain] = String(address || '').split('@');
  if (!local || !domain) return null;
  return `${local.slice(0, 2)}${'x'.repeat(Math.max(local.length - 2, 1))}@${domain}`;
}

/** Parses whatever was typed or scanned into { ok, kind, number, address, display }. */
function parse(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, error: 'empty' };

  // An ABHA QR carries JSON; a scanner hands the string over verbatim.
  if (raw.startsWith('{')) {
    try {
      const payload = JSON.parse(raw);
      return parse(payload.hidn || payload.abhaNumber || payload.hid || payload.abhaAddress || '');
    } catch {
      return { ok: false, error: 'unreadable-qr' };
    }
  }

  if (raw.includes('@')) {
    const address = raw.toLowerCase();
    if (!ABHA_ADDRESS.test(address)) return { ok: false, error: 'bad-address' };
    return { ok: true, kind: 'address', address, number: null, display: address };
  }

  const digits = digitsOnly(raw);
  if (!ABHA_NUMBER.test(digits)) return { ok: false, error: 'bad-number' };
  return { ok: true, kind: 'number', number: digits, address: null, display: formatNumber(digits) };
}

/**
 * The bridge. Keyed by both address and number so either form resolves.
 * Mirrors only what the portal already publishes in `abhaDirectory`.
 */
const DIRECTORY = new Map();

function loadDirectory() {
  try {
    if (!fs.existsSync(STORE_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    for (const [key, value] of Object.entries(saved)) DIRECTORY.set(key, value);
    console.log(`[ABHA] directory bridge restored: ${directorySize()} ABHA(s).`);
  } catch (err) {
    console.warn('[ABHA] could not restore the directory bridge:', err.message);
  }
}

function saveDirectory() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(Object.fromEntries(DIRECTORY), null, 2));
  } catch (err) {
    // A failed mirror must never break ABHA capture; it only costs persistence.
    console.warn('[ABHA] could not persist the directory bridge:', err.message);
  }
}

const addressKey = (address) => String(address || '').toLowerCase().replace(/[.@]/g, '_');

function registerDirectoryEntry(entry) {
  const address = String(entry.abhaAddress || '').toLowerCase();
  const number = digitsOnly(entry.abhaKey || entry.abhaNumber);
  if (!address && !number) return null;

  const record = {
    abhaAddress: address || null,
    abhaNumberMasked: entry.abhaNumberMasked || maskNumber(number),
    nameMasked: entry.nameMasked || null,
    gender: entry.gender || null,
    yearOfBirth: entry.yearOfBirth || null,
    mobileMasked: entry.mobileMasked || '****',
    registeredAt: new Date().toISOString()
  };
  if (address) DIRECTORY.set(addressKey(address), record);
  // The full number never leaves the portal, so index by it without storing it.
  if (number) DIRECTORY.set(`num_${number}`, record);
  saveDirectory();
  return record;
}

const lookupBridge = (parsed) => (parsed.kind === 'address'
  ? DIRECTORY.get(addressKey(parsed.address))
  : DIRECTORY.get(`num_${parsed.number}`)) || null;

/** The portal's own directory. Documents are keyed by address; the number is a field. */
async function lookupFirestore(parsed) {
  const store = await db.getDb();
  if (!store) return null;
  try {
    const collection = store.collection(DIRECTORY_COLLECTION);
    let data = null;
    if (parsed.kind === 'address') {
      const snapshot = await collection.doc(directoryDocId(parsed.address)).get();
      data = snapshot.exists ? snapshot.data() : null;
    } else {
      const snapshot = await collection.where('abhaKey', '==', parsed.number).limit(1).get();
      data = snapshot.empty ? null : snapshot.docs[0].data();
    }
    if (!data) return null;
    return {
      abhaAddress: data.abhaAddress || null,
      abhaNumberMasked: data.abhaNumberMasked || maskNumber(data.abhaKey) || null,
      nameMasked: data.nameMasked || null,
      gender: data.gender || null,
      yearOfBirth: data.yearOfBirth || null,
      mobileMasked: data.mobileMasked || '****'
    };
  } catch (err) {
    console.warn('[ABHA] directory lookup failed:', err.message);
    return null;
  }
}

/**
 * Resolves an ABHA into the identity record stored on a session.
 * Never upgrades `verified` on its own: a directory hit proves the ABHA exists,
 * not that the person standing at the kiosk is its owner. Proving that needs an
 * OTP to the linked mobile, which is the next thing to wire in.
 */
async function resolve(input) {
  const parsed = parse(input);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const found = (await lookupFirestore(parsed)) || lookupBridge(parsed);
  return {
    ok: true,
    abha: {
      kind: parsed.kind,
      number: parsed.number,
      address: parsed.address || (found && found.abhaAddress) || null,
      display: parsed.display,
      masked: parsed.kind === 'number' ? maskNumber(parsed.number) : maskAddress(parsed.address),
      knownToDirectory: Boolean(found),
      verified: false,
      verificationMethod: found ? 'directory-match-pending-otp' : 'self-declared',
      capturedAt: new Date().toISOString(),
      demographics: found
        ? { nameMasked: found.nameMasked, gender: found.gender, yearOfBirth: found.yearOfBirth, mobileMasked: found.mobileMasked }
        : null
    }
  };
}

/** FHIR Identifier. `use` reports verification state so downstream can tell them apart. */
function toFhirIdentifier(abha) {
  if (!abha) return null;
  const isNumber = abha.kind === 'number';
  return {
    use: abha.verified ? 'official' : 'temp',
    system: isNumber
      ? 'https://healthid.abdm.gov.in/ns/abha-number'
      : 'https://healthid.abdm.gov.in/ns/abha-address',
    value: isNumber ? abha.number : abha.address,
    assigner: { display: 'Ayushman Bharat Digital Mission' },
    extension: [{
      url: 'https://ayurfhir.local/abha-verification',
      valueCode: abha.verificationMethod
    }]
  };
}

const directorySize = () => [...DIRECTORY.keys()].filter((k) => !k.startsWith('num_')).length;

loadDirectory();

module.exports = {
  parse, resolve, registerDirectoryEntry, toFhirIdentifier,
  formatNumber, maskNumber, maskAddress, directorySize
};
