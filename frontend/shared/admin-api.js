import { listAdminRequests, listAdminUsers, setUserRole } from './api.js';
import { describeAuthError, initAuth, onAuthChange, signIn, signOutUser, signUp } from './firebase-auth.js';

const REFRESH_MS = 15000;

function authError(message) {
  const el = document.getElementById('admin-auth-error');
  if (!el) return;
  if (!message) { el.classList.add('hidden'); el.innerText = ''; return; }
  el.innerText = message;
  el.classList.remove('hidden');
}

// The admin monitoring tables used to read the database straight from the browser. They now
// poll admin-only backend routes, which are refused unless the verified role is 'admin'.
function normalizeRequest(record) {
  const ts = record.createdAt ? Date.parse(record.createdAt) : 0;
  return {
    ...record,
    userEmail: record.userEmail || record.userUid || 'anonymous',
    timestamp: ts ? new Date(ts).toLocaleTimeString() : '',
    __ts: ts || 0,
    requestBody: record.requestBody || { note: 'Request bodies are intentionally not retained.' },
    responseBody: record.responseBody || { requestId: record.requestId, status: record.status }
  };
}

async function refreshAdminData() {
  try {
    const [{ users }, { requests }] = await Promise.all([listAdminUsers(), listAdminRequests()]);
    adminState.users = users;
    adminState.apiRequests = requests.map(normalizeRequest).sort((a, b) => b.__ts - a.__ts);
    setRtdbStatus(true);
  } catch (error) {
    console.error('Admin data refresh failed:', error);
    setRtdbStatus(false);
  }
  renderUsersAndRoles();
  renderOverviewRequests();
  renderFullRequestsTable();
  renderLiveTraffic();
  updateOverviewStats();
  updateHealthCounts();
}

function startPolling() {
  if (adminState.refreshTimer) return;
  refreshAdminData();
  adminState.refreshTimer = setInterval(refreshAdminData, REFRESH_MS);
}

function stopPolling() {
  if (!adminState.refreshTimer) return;
  clearInterval(adminState.refreshTimer);
  adminState.refreshTimer = null;
}

function applySession(session, config) {
  if (config && !config.configured) {
    authError('Firebase is not configured on this server yet. Add the FIREBASE_* values to .env and restart.');
  }

  if (!session.authenticated) {
    stopPolling();
    adminState.currentUser = null;
    showAdminLoginForms();
    updateHealthCounts();
    return;
  }

  if (session.user.role !== 'admin') {
    stopPolling();
    adminState.currentUser = null;
    denyAdminAccess(session.user.email);
    return;
  }

  authError('');
  adminState.currentUser = { email: session.user.email, uid: session.user.uid, role: 'admin', name: session.user.name };
  grantAdminAccess();
  startPolling();
}

window.AyurAdmin = {
  start() {
    onAuthChange(applySession);
    initAuth();
  },

  async signIn() {
    authError('');
    const email = document.getElementById('admin-signin-email').value;
    const password = document.getElementById('admin-signin-password').value;
    try {
      await signIn(email, password);
      document.getElementById('admin-signin-password').value = '';
    } catch (error) {
      authError(describeAuthError(error));
    }
  },

  // Creates an ordinary account. The server assigns the role, so this grants admin access only
  // if the email is listed in ADMIN_BOOTSTRAP_EMAILS; otherwise an existing admin must promote it.
  async signUp() {
    authError('');
    const name = document.getElementById('admin-signup-name').value;
    const email = document.getElementById('admin-signup-email').value;
    const password = document.getElementById('admin-signup-password').value;
    try {
      const session = await signUp(name, email, password);
      document.getElementById('admin-signup-password').value = '';
      if (session.user.role !== 'admin') {
        authError('Account created, but admin access is server-granted. Ask an existing admin to promote this account, or add the email to ADMIN_BOOTSTRAP_EMAILS.');
      }
    } catch (error) {
      authError(describeAuthError(error));
    }
  },

  async signOut() {
    stopPolling();
    adminState.currentUser = null;
    document.getElementById('admin-user-display').innerText = '';
    document.getElementById('admin-user-role').innerText = '';
    try {
      await signOutUser();
    } catch (error) {
      console.error('Logout failed:', error);
    }
    showAdminLoginForms();
  },

  async setRole(uid, role) {
    if (!confirm(`Set this user's role to "${role}"?`)) return;
    try {
      await setUserRole(uid, role);
      await refreshAdminData();
    } catch (error) {
      alert(`Could not update role: ${error.message}`);
    }
  },

  refresh: refreshAdminData
};
