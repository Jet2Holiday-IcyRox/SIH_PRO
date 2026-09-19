// Single source of truth for browser authentication.
//
// The Firebase Web config is fetched from the backend (/api/v1/auth/config) instead of being
// hardcoded in each page, and the *role* always comes from the backend's verified session
// (/api/v1/auth/session) — never from a client-side database read, which the browser could lie about.

const CONFIG_URL = '/api/v1/auth/config';
const SESSION_URL = '/api/v1/auth/session';
const REGISTER_URL = '/api/v1/auth/register';

const GUEST = { authenticated: false, user: null };

const state = {
  config: null,
  session: GUEST,
  listeners: new Set(),
  readyPromise: null
};

const FRIENDLY_ERRORS = {
  'auth/invalid-email': 'That email address is not valid.',
  'auth/invalid-credential': 'Incorrect email or password.',
  'auth/wrong-password': 'Incorrect email or password.',
  'auth/user-not-found': 'No account exists for that email.',
  'auth/user-disabled': 'This account has been disabled.',
  'auth/email-already-in-use': 'An account already exists for that email. Try signing in instead.',
  'auth/weak-password': 'Password must be at least 6 characters.',
  'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
  'auth/network-request-failed': 'Network error reaching Firebase. Check your connection.',
  'auth/operation-not-allowed': 'Email/Password sign-in is not enabled for this Firebase project.',
  'auth/unauthorized-domain': 'This domain is not in the Firebase authorized-domains list.'
};

export function describeAuthError(error) {
  if (!error) return 'Unknown authentication error.';
  return FRIENDLY_ERRORS[error.code] || error.message || String(error);
}

function notify() {
  for (const listener of state.listeners) {
    try { listener(state.session, state.config); } catch (err) { console.error('Auth listener failed:', err); }
  }
}

async function fetchClientConfig() {
  try {
    const response = await fetch(CONFIG_URL);
    if (!response.ok) throw new Error(`config ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error('Could not load Firebase client config from the backend:', error);
    return { configured: false, tokenVerification: false, firebase: {}, error: String(error) };
  }
}

// Exchanges the Firebase ID token for the server-owned profile (uid, email, name, role).
async function refreshSession() {
  const token = await getIdToken();
  if (!token) {
    state.session = GUEST;
    notify();
    return state.session;
  }
  try {
    const response = await fetch(SESSION_URL, { headers: { Authorization: `Bearer ${token}` } });
    const payload = await response.json();
    state.session = response.ok && payload.authenticated ? payload : GUEST;
  } catch (error) {
    console.error('Session lookup failed:', error);
    state.session = GUEST;
  }
  notify();
  return state.session;
}

export function initAuth() {
  if (state.readyPromise) return state.readyPromise;

  state.readyPromise = (async () => {
    state.config = await fetchClientConfig();

    if (!state.config.configured) {
      console.warn('[auth] Firebase Web config is missing on the backend. Fill FIREBASE_* in .env.');
      notify();
      return state;
    }
    if (!window.firebase || !window.firebase.auth) {
      console.error('[auth] Firebase Web SDK did not load. Sign-in is unavailable.');
      state.config = { ...state.config, configured: false, error: 'sdk-missing' };
      notify();
      return state;
    }

    if (!firebase.apps.length) firebase.initializeApp(state.config.firebase);
    // LOCAL persistence keeps the session across reloads and across the patient/admin pages.
    await firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});
    firebase.auth().onAuthStateChanged(() => { refreshSession(); });
    return state;
  })();

  return state.readyPromise;
}

export function onAuthChange(listener) {
  state.listeners.add(listener);
  // Fire immediately so late subscribers see the current state.
  listener(state.session, state.config);
  return () => state.listeners.delete(listener);
}

export function getSession() { return state.session; }
export function getAuthConfig() { return state.config; }
export function isConfigured() { return Boolean(state.config && state.config.configured); }

export async function getIdToken(forceRefresh = false) {
  if (!isConfigured() || !window.firebase?.auth) return null;
  const user = firebase.auth().currentUser;
  if (!user) return null;
  try {
    return await user.getIdToken(forceRefresh);
  } catch (error) {
    console.error('Could not obtain an ID token:', error);
    return null;
  }
}

function assertReady() {
  if (!isConfigured()) {
    const reason = state.config?.error === 'sdk-missing'
      ? 'The Firebase SDK failed to load in this browser.'
      : 'Firebase is not configured on the server yet. Add the FIREBASE_* values to .env and restart.';
    throw new Error(reason);
  }
}

export async function signIn(email, password) {
  await initAuth();
  assertReady();
  await firebase.auth().signInWithEmailAndPassword(email, password);
  return refreshSession();
}

export async function signUp(displayName, email, password) {
  await initAuth();
  assertReady();
  await firebase.auth().createUserWithEmailAndPassword(email, password);
  const token = await getIdToken(true);
  // The backend creates the profile document; the role it assigns is not negotiable from here.
  const response = await fetch(REGISTER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ displayName })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    console.error('Profile creation failed:', payload.error || response.status);
  }
  return refreshSession();
}

export async function signOutUser() {
  if (!isConfigured() || !window.firebase?.auth) return GUEST;
  await firebase.auth().signOut();
  return refreshSession();
}
