import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { config } from '../../config/env.js';

const USERS = 'users';
const REQUESTS = 'apiRequests';
const ROLES = new Set(['user', 'admin']);

// Privileged Firebase access is deliberately isolated here. Without a service account the
// adapter degrades to an in-memory store so the demo and the test suite still run, but it
// then verifies no tokens at all — every request is treated as unauthenticated.
export class FirebaseAdapter {
  constructor() {
    this.memoryUsers = new Map();
    this.memoryRequests = [];
    this.live = false;

    if (!config.adminConfigured) {
      console.warn('[firebase] No service account configured. Running with an in-memory store; ID tokens will NOT be verified.');
      return;
    }

    // A key that parses but cannot be used (wrong PEM, missing fields) must not throw at
    // import: on a serverless host that is a 500 on every route, not just the auth ones.
    try {
      const app = getApps().length
        ? getApps()[0]
        : initializeApp({ credential: cert(config.serviceAccount), projectId: config.serviceAccount.project_id });
      this.auth = getAuth(app);
      this.db = getFirestore(app);
      this.live = true;
    } catch (error) {
      console.warn(`[firebase] Service account rejected (${error.message}). Running with an in-memory store; ID tokens will NOT be verified.`);
    }
  }

  get isLive() {
    return this.live;
  }

  async verifyIdToken(idToken) {
    if (!this.live || !idToken) return null;
    try {
      // Not passing checkRevoked=true: it does an extra getUser() lookup that needs a service
      // account role most setups don't grant by default. Signature + expiry checks (the default)
      // are sufficient for this app; a revoked-but-unexpired token stays valid until it expires.
      return await this.auth.verifyIdToken(idToken);
    } catch (error) {
      // Expired/forged/revoked tokens are an expected client condition, not a server fault.
      if (config.environment !== 'production') console.warn('[firebase] Token verification rejected:', error.code || error.message);
      return null;
    }
  }

  // Role is decided server-side only: an existing profile wins, otherwise the bootstrap
  // allowlist decides, otherwise everyone starts as a practitioner.
  resolveBootstrapRole(email) {
    return config.adminBootstrapEmails.includes(String(email || '').toLowerCase()) ? 'admin' : 'user';
  }

  async getProfile(uid) {
    if (!this.live) return this.memoryUsers.get(uid) || null;
    const snapshot = await this.db.collection(USERS).doc(uid).get();
    return snapshot.exists ? { uid, ...snapshot.data() } : null;
  }

  // Called on every authenticated request so a profile always exists for a valid token.
  async ensureProfile({ uid, email, displayName }) {
    const existing = await this.getProfile(uid);
    if (existing) {
      const patch = {};
      if (displayName && displayName !== existing.displayName) patch.displayName = displayName;
      if (email && email !== existing.email) patch.email = email;
      if (!Object.keys(patch).length) return existing;
      if (this.live) await this.db.collection(USERS).doc(uid).set(patch, { merge: true });
      const merged = { ...existing, ...patch };
      if (!this.live) this.memoryUsers.set(uid, merged);
      return merged;
    }

    const profile = {
      uid,
      email: email || '',
      displayName: displayName || String(email || 'practitioner').split('@')[0],
      role: this.resolveBootstrapRole(email),
      createdAt: new Date().toISOString()
    };
    if (this.live) {
      await this.db.collection(USERS).doc(uid).set(profile);
      if (profile.role === 'admin') await this.auth.setCustomUserClaims(uid, { role: 'admin' });
    } else {
      this.memoryUsers.set(uid, profile);
    }
    return profile;
  }

  async listProfiles() {
    if (!this.live) return [...this.memoryUsers.values()];
    const snapshot = await this.db.collection(USERS).orderBy('createdAt', 'desc').limit(200).get();
    return snapshot.docs.map((doc) => ({ uid: doc.id, ...doc.data() }));
  }

  async setRole(uid, role) {
    if (!ROLES.has(role)) throw new Error(`Unsupported role: ${role}`);
    if (!this.live) {
      const profile = this.memoryUsers.get(uid);
      if (!profile) return null;
      const updated = { ...profile, role };
      this.memoryUsers.set(uid, updated);
      return updated;
    }
    await this.db.collection(USERS).doc(uid).set({ role }, { merge: true });
    // Custom claims let Firestore/Storage rules see the role without a document read.
    await this.auth.setCustomUserClaims(uid, role === 'admin' ? { role: 'admin' } : { role: 'user' });
    return this.getProfile(uid);
  }

  async logMappingRequest(entry) {
    const record = { ...entry, id: crypto.randomUUID() };
    if (!this.live) {
      this.memoryRequests.push(record);
      return;
    }
    await this.db.collection(REQUESTS).doc(record.id).set(record);
  }

  async listMappingRequests(limit = 200) {
    if (!this.live) return this.memoryRequests.slice(-limit).reverse();
    const snapshot = await this.db.collection(REQUESTS).orderBy('createdAt', 'desc').limit(limit).get();
    return snapshot.docs.map((doc) => doc.data());
  }
}
