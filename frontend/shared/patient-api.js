import { getFhirSample, mapTerminology, searchTerminology } from './api.js';
import { describeAuthError, getAuthConfig, initAuth, onAuthChange, signIn, signOutUser, signUp } from './firebase-auth.js';

// The page's inline script owns presentation; this module owns Firebase Auth and the API calls.
window.AyurApi = { mapTerminology, searchTerminology, getFhirSample };

const GUEST_USER = { name: 'Guest Practitioner', email: 'guest@ayurfhir-demo.gov.in', role: 'user', isDemo: true };

function showAuthError(message) {
  const el = document.getElementById('auth-error');
  if (!el) return;
  if (!message) { el.classList.add('hidden'); el.innerText = ''; return; }
  el.innerText = message;
  el.classList.remove('hidden');
}

function showConfigWarning(config) {
  const el = document.getElementById('auth-config-warning');
  if (!el) return;
  if (config && config.configured) { el.classList.add('hidden'); return; }
  el.innerText = 'Firebase sign-in is not configured on this server yet. Add the FIREBASE_* values to .env and restart, or continue as a guest.';
  el.classList.remove('hidden');
}

function setFirebaseStatusPill(config, session) {
  const text = document.getElementById('fb-status-text');
  const pill = document.getElementById('fb-status-pill');
  if (!text || !pill) return;
  const configured = Boolean(config && config.configured);
  const label = !configured ? 'Firebase Not Configured' : session.authenticated ? 'Firebase Auth: Signed In' : 'Firebase Auth: Ready';
  const tone = !configured ? 'bg-amber-100 text-amber-800' : session.authenticated ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700';
  text.innerText = label;
  pill.className = `flex items-center gap-1.5 px-3 py-1 ${tone} rounded-full text-xs font-medium transition-colors`;
}

// Mirrors the verified backend session onto the page's own state object.
function applySession(session, config) {
  const user = session.authenticated && session.user
    ? { name: session.user.name, email: session.user.email, role: session.user.role, uid: session.user.uid, isDemo: false }
    : { ...GUEST_USER };
  state.currentUser = user;
  if (typeof updateUserUI === 'function') updateUserUI();
  setFirebaseStatusPill(config, session);
  showConfigWarning(config);
}

window.AyurAuth = {
  start() {
    onAuthChange(applySession);
    initAuth();
  },

  async signIn() {
    showAuthError('');
    const email = document.getElementById('signin-email').value;
    const password = document.getElementById('signin-password').value;
    try {
      const session = await signIn(email, password);
      closeModal('modal-auth');
      document.getElementById('signin-password').value = '';
      alert(`Signed in as ${session.user.email} (${session.user.role.toUpperCase()}).`);
    } catch (error) {
      showAuthError(describeAuthError(error));
    }
  },

  async signUp() {
    showAuthError('');
    const name = document.getElementById('signup-name').value;
    const email = document.getElementById('signup-email').value;
    const password = document.getElementById('signup-password').value;
    try {
      const session = await signUp(name, email, password);
      closeModal('modal-auth');
      document.getElementById('signup-password').value = '';
      alert(`Account created for ${session.user.email}. Role assigned by the server: ${session.user.role.toUpperCase()}.`);
    } catch (error) {
      showAuthError(describeAuthError(error));
    }
  },

  async signOut() {
    try {
      await signOutUser();
      alert('Signed out.');
    } catch (error) {
      alert(describeAuthError(error));
    }
  },

  // Guest mode is a local presentation fallback only; it grants no server-side privileges.
  async useGuest() {
    showAuthError('');
    await signOutUser().catch(() => {});
    state.currentUser = { ...GUEST_USER };
    if (typeof updateUserUI === 'function') updateUserUI();
    setFirebaseStatusPill(getAuthConfig(), { authenticated: false });
    closeModal('modal-auth');
  }
};

window.performTerminologySearch = async function performTerminologySearch() {
  const query = document.getElementById('term-search-input')?.value || '';
  const stream = document.getElementById('filter-stream')?.value || 'ALL';
  const container = document.getElementById('results-container');
  try {
    const { concepts } = await searchTerminology(query, stream);
    document.getElementById('search-count-badge').innerText = concepts.length;
    container.innerHTML = concepts.map((item) => `<div class="bg-white rounded-2xl border border-slate-200 p-5"><h3 class="font-bold text-slate-900 text-lg">${item.termEnglish}</h3><p class="text-xs text-slate-600 mt-2">${item.description}</p><p class="text-xs font-mono text-teal-700 mt-2">${item.namasteCode} → ${item.icd11Tm2Code}</p><span class="text-[10px] text-amber-700">Demo terminology data</span></div>`).join('') || '<p class="text-slate-500">No demo concepts match this search.</p>';
  } catch (error) { container.innerHTML = `<p class="text-red-600">${error.message}</p>`; }
};

window.executeApiSandbox = async function executeApiSandbox() {
  try {
    const response = await sendMappingRequest(JSON.parse(document.getElementById('api-sandbox-input').value));
    document.getElementById('api-sandbox-output').innerText = JSON.stringify(response, null, 2);
  } catch (error) { document.getElementById('api-sandbox-output').innerText = `// Error: ${error.message}`; }
};
