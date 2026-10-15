/**
 * Firebase Persistent Storage Service for ToxicRadar
 * Provides Cloud Firestore and Realtime Database persistence over REST API
 * Zero extra dependencies: uses built-in fetch / node-fetch
 * Survives Render free-tier inactivity, container restarts, and ephemeral disk resets.
 */

const https = require("https");

// Environment variables
const FIREBASE_API_KEY = (process.env.FIREBASE_API_KEY || "").trim();
const FIREBASE_PROJECT_ID = (process.env.FIREBASE_PROJECT_ID || "").trim();
const FIREBASE_DATABASE_URL = (process.env.FIREBASE_DATABASE_URL || "").trim().replace(/\/$/, "");
const COLLECTION_PREFIX = (process.env.FIREBASE_COLLECTION_PREFIX || "toxicradar").trim();
const FIRESTORE_BATCH_SIZE = 400; // Firestore allows max 500 writes per commit
const FIRESTORE_PARALLEL_COMMITS = 3;

// Backend: Realtime Database if FIREBASE_DATABASE_URL is set, otherwise Firestore.
// Force one with FIREBASE_BACKEND=rtdb|firestore.
const FORCED_BACKEND = (process.env.FIREBASE_BACKEND || "").trim().toLowerCase();
function useFirestore() {
  if (FORCED_BACKEND === "firestore") return Boolean(FIREBASE_PROJECT_ID && FIREBASE_API_KEY);
  if (FORCED_BACKEND === "rtdb") return false;
  if (FIREBASE_DATABASE_URL) return false;
  return Boolean(FIREBASE_PROJECT_ID && FIREBASE_API_KEY);
}

function isConfigured() {
  return Boolean(
    (FIREBASE_PROJECT_ID && FIREBASE_API_KEY) ||
    (FIREBASE_DATABASE_URL && FIREBASE_API_KEY) ||
    FIREBASE_DATABASE_URL
  );
}

// ==================== FIRESTORE VALUE CONVERTERS ====================

function toFirestoreValue(val) {
  if (val === null || val === undefined) {
    return { nullValue: null };
  }
  if (typeof val === "boolean") {
    return { booleanValue: val };
  }
  if (typeof val === "number") {
    if (Number.isInteger(val)) {
      return { integerValue: String(val) };
    }
    return { doubleValue: val };
  }
  if (typeof val === "string") {
    return { stringValue: val };
  }
  if (Array.isArray(val)) {
    return {
      arrayValue: {
        values: val.map(toFirestoreValue),
      },
    };
  }
  if (typeof val === "object") {
    const fields = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) {
        fields[k] = toFirestoreValue(v);
      }
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function fromFirestoreValue(val) {
  if (!val || typeof val !== "object") return null;
  if ("stringValue" in val) return val.stringValue;
  if ("booleanValue" in val) return val.booleanValue;
  if ("integerValue" in val) return parseInt(val.integerValue, 10);
  if ("doubleValue" in val) return parseFloat(val.doubleValue);
  if ("nullValue" in val) return null;
  if ("arrayValue" in val) {
    return (val.arrayValue?.values || []).map(fromFirestoreValue);
  }
  if ("mapValue" in val) {
    const result = {};
    for (const [k, v] of Object.entries(val.mapValue?.fields || {})) {
      result[k] = fromFirestoreValue(v);
    }
    return result;
  }
  return null;
}

function fromFirestoreDoc(doc) {
  if (!doc || !doc.fields) return null;
  const data = {};
  for (const [k, v] of Object.entries(doc.fields)) {
    data[k] = fromFirestoreValue(v);
  }
  // Extract document ID from path if present
  if (doc.name) {
    const parts = doc.name.split("/");
    data._id = parts[parts.length - 1];
  }
  return data;
}

// ==================== REST API CLIENT ====================

async function httpRequest(url, options = {}) {
  const fetchFn = typeof fetch !== "undefined" ? fetch : require("node-fetch");
  const res = await fetchFn(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (res.status === 404) {
    return null;
  }

  if (!res.ok) {
    let errBody = "";
    try {
      errBody = await res.text();
    } catch (_e) {}
    throw new Error(`Firebase request failed (${res.status} ${res.statusText}): ${errBody}`);
  }

  return res.json();
}

// Firestore operations
async function firestoreGetDoc(collection, docId) {
  const safeCol = encodeURIComponent(`${COLLECTION_PREFIX}_${collection}`);
  const safeDoc = encodeURIComponent(String(docId));
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${safeCol}/${safeDoc}?key=${FIREBASE_API_KEY}`;
  const res = await httpRequest(url);
  return res ? fromFirestoreDoc(res) : null;
}

async function firestoreSetDoc(collection, docId, data) {
  const safeCol = encodeURIComponent(`${COLLECTION_PREFIX}_${collection}`);
  const safeDoc = encodeURIComponent(String(docId));
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${safeCol}/${safeDoc}?key=${FIREBASE_API_KEY}`;
  
  const fields = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) {
      fields[k] = toFirestoreValue(v);
    }
  }

  return httpRequest(url, {
    method: "PATCH",
    body: JSON.stringify({ fields }),
  });
}

async function firestoreListDocs(collection, pageSize = 300) {
  const safeCol = encodeURIComponent(`${COLLECTION_PREFIX}_${collection}`);
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${safeCol}?key=${FIREBASE_API_KEY}&pageSize=${pageSize}`;
  const res = await httpRequest(url);
  if (!res || !Array.isArray(res.documents)) {
    return [];
  }
  return res.documents.map(fromFirestoreDoc).filter(Boolean);
}

async function firestoreDeleteDoc(collection, docId) {
  const safeCol = encodeURIComponent(`${COLLECTION_PREFIX}_${collection}`);
  const safeDoc = encodeURIComponent(String(docId));
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${safeCol}/${safeDoc}?key=${FIREBASE_API_KEY}`;
  return httpRequest(url, { method: "DELETE" });
}

// Realtime Database operations (fallback if FIREBASE_DATABASE_URL is provided)
async function rtdbGet(path) {
  const auth = "";
  const url = `${FIREBASE_DATABASE_URL}/${COLLECTION_PREFIX}/${path}.json${auth}`;
  return httpRequest(url);
}

async function rtdbSet(path, data) {
  const auth = "";
  const url = `${FIREBASE_DATABASE_URL}/${COLLECTION_PREFIX}/${path}.json${auth}`;
  return httpRequest(url, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

async function rtdbDelete(path) {
  const auth = "";
  const url = `${FIREBASE_DATABASE_URL}/${COLLECTION_PREFIX}/${path}.json${auth}`;
  return httpRequest(url, { method: "DELETE" });
}

// ==================== HIGH LEVEL DOMAIN SERVICES ====================

const firebaseService = {
  isConfigured,

  /**
   * Save Application Settings
   */
  async saveSettings(settings) {
    if (!isConfigured()) return false;
    try {
      const sanitized = {
        excelPath: settings.excelPath || "",
        updatedAt: new Date().toISOString(),
      };

      if (useFirestore()) {
        await firestoreSetDoc("settings", "app_settings", sanitized);
      } else if (FIREBASE_DATABASE_URL) {
        await rtdbSet("settings", sanitized);
      }
      return true;
    } catch (err) {
      console.warn("[Firebase] Failed to save settings:", err.message);
      return false;
    }
  },

  /**
   * Load Application Settings
   */
  async loadSettings() {
    if (!isConfigured()) return null;
    try {
      if (useFirestore()) {
        return await firestoreGetDoc("settings", "app_settings");
      } else if (FIREBASE_DATABASE_URL) {
        return await rtdbGet("settings");
      }
      return null;
    } catch (err) {
      console.warn("[Firebase] Failed to load settings:", err.message);
      return null;
    }
  },

  /**
   * Save a single compose evaluation record
   */
  async saveComposeRecord(composeResult, rowNumber) {
    if (!isConfigured() || !composeResult) return false;
    try {
      const recordId = `record_${String(rowNumber || Date.now()).padStart(6, "0")}`;
      const payload = {
        rowNumber: Number(rowNumber) || null,
        email: composeResult.email || {},
        analysis: composeResult.analysis || {},
        error: composeResult.error ? String(composeResult.error) : null,
        createdAt: new Date().toISOString(),
      };

      if (useFirestore()) {
        await firestoreSetDoc("compose_records", recordId, payload);
      } else if (FIREBASE_DATABASE_URL) {
        await rtdbSet(`compose_records/${recordId}`, payload);
      }
      return true;
    } catch (err) {
      console.warn("[Firebase] Failed to save compose record:", err.message);
      return false;
    }
  },

  /**
   * Update the rewrite text of a compose evaluation record
   */
  async updateComposeRecordRewrite(rowNumber, rewrite) {
    if (!isConfigured() || !rowNumber) return false;
    try {
      const recordId = `record_${String(rowNumber).padStart(6, "0")}`;
      if (useFirestore()) {
        const existing = await firestoreGetDoc("compose_records", recordId);
        if (existing) {
          const updated = {
            ...existing,
            analysis: {
              ...(existing.analysis || {}),
              suggestedRewrite: rewrite,
            },
            updatedAt: new Date().toISOString(),
          };
          await firestoreSetDoc("compose_records", recordId, updated);
        }
      } else if (FIREBASE_DATABASE_URL) {
        const existing = await rtdbGet(`compose_records/${recordId}`);
        if (existing) {
          existing.analysis = existing.analysis || {};
          existing.analysis.suggestedRewrite = rewrite;
          existing.updatedAt = new Date().toISOString();
          await rtdbSet(`compose_records/${recordId}`, existing);
        }
      }
      return true;
    } catch (err) {
      console.warn("[Firebase] Failed to update rewrite:", err.message);
      return false;
    }
  },

  /**
   * Fetch all stored compose records for rehydration
   */
  async getComposeRecords() {
    if (!isConfigured()) return [];
    try {
      let records = [];
      if (useFirestore()) {
        records = await firestoreListDocs("compose_records", 1000);
      } else if (FIREBASE_DATABASE_URL) {
        const data = await rtdbGet("compose_records");
        if (data && typeof data === "object") {
          records = Object.values(data);
        }
      }

      // Sort in ascending order of rowNumber or createdAt
      return records.sort((a, b) => {
        const aNum = Number(a.rowNumber) || 0;
        const bNum = Number(b.rowNumber) || 0;
        if (aNum !== bNum) return aNum - bNum;
        return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
      });
    } catch (err) {
      console.warn("[Firebase] Failed to fetch compose records:", err.message);
      return [];
    }
  },

  /**
   * Save an Apple Watch biometrics session
   */
  async saveBiometricsSession(session) {
    if (!isConfigured() || !session || !session.sessionId) return false;
    try {
      const safeSession = {
        sessionId: session.sessionId,
        token: session.token,
        pairCode: session.pairCode || "",
        pairCodeExpiresAt: session.pairCodeExpiresAt || 0,
        paired: Boolean(session.paired),
        createdAt: session.createdAt || Date.now(),
        lastSeenAt: session.lastSeenAt || 0,
        history: Array.isArray(session.history) ? session.history.slice(-100) : [],
        updatedAt: new Date().toISOString(),
      };

      if (useFirestore()) {
        await firestoreSetDoc("biometrics_sessions", session.sessionId, safeSession);
      } else if (FIREBASE_DATABASE_URL) {
        await rtdbSet(`biometrics_sessions/${session.sessionId}`, safeSession);
      }
      return true;
    } catch (err) {
      console.warn("[Firebase] Failed to save biometrics session:", err.message);
      return false;
    }
  },

  /**
   * Fetch active biometrics sessions for rehydration
   */
  async getBiometricsSessions() {
    if (!isConfigured()) return [];
    try {
      let sessions = [];
      if (useFirestore()) {
        sessions = await firestoreListDocs("biometrics_sessions", 200);
      } else if (FIREBASE_DATABASE_URL) {
        const data = await rtdbGet("biometrics_sessions");
        if (data && typeof data === "object") {
          sessions = Object.values(data);
        }
      }
      return sessions;
    } catch (err) {
      console.warn("[Firebase] Failed to fetch biometrics sessions:", err.message);
      return [];
    }
  },

  /**
   * Delete a biometrics session
   */
  async deleteBiometricsSession(sessionId) {
    if (!isConfigured() || !sessionId) return false;
    try {
      if (useFirestore()) {
        await firestoreDeleteDoc("biometrics_sessions", sessionId);
      } else if (FIREBASE_DATABASE_URL) {
        await rtdbDelete(`biometrics_sessions/${sessionId}`);
      }
      return true;
    } catch (err) {
      console.warn("[Firebase] Failed to delete biometrics session:", err.message);
      return false;
    }
  },
  // ==================== GENERIC DOCUMENT API (throws on failure) ====================
  // Used by store.js. Unlike the lenient helpers above, errors propagate so the
  // API can tell the dashboard that Firebase is unreachable instead of showing "no data".

  /** Write many documents. Firestore: atomic commits of <= 400 writes, run 3 at a time. */
  async putDocs(collection, docs) {
    if (!isConfigured()) throw new Error("Firebase is not configured.");
    if (!Array.isArray(docs) || docs.length === 0) return 0;

    if (useFirestore()) {
      const dbPath = `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
      const url = `https://firestore.googleapis.com/v1/${dbPath}:commit?key=${FIREBASE_API_KEY}`;
      const chunks = [];
      for (let i = 0; i < docs.length; i += FIRESTORE_BATCH_SIZE) {
        chunks.push(docs.slice(i, i + FIRESTORE_BATCH_SIZE));
      }
      const commitChunk = (chunk) =>
        httpRequest(url, {
          method: "POST",
          body: JSON.stringify({
            writes: chunk.map(({ id, data }) => ({
              update: {
                name: `${dbPath}/${COLLECTION_PREFIX}_${collection}/${encodeURIComponent(String(id))}`,
                fields: toFirestoreValue(data).mapValue.fields,
              },
            })),
          }),
        });
      for (let i = 0; i < chunks.length; i += FIRESTORE_PARALLEL_COMMITS) {
        await Promise.all(chunks.slice(i, i + FIRESTORE_PARALLEL_COMMITS).map(commitChunk));
      }
    } else {
      // Realtime Database: one multi-path PATCH per chunk
      const auth = "";
      const url = `${FIREBASE_DATABASE_URL}/${COLLECTION_PREFIX}/${collection}.json${auth}`;
      for (let i = 0; i < docs.length; i += FIRESTORE_BATCH_SIZE) {
        const payload = {};
        for (const { id, data } of docs.slice(i, i + FIRESTORE_BATCH_SIZE)) {
          payload[String(id)] = data;
        }
        await httpRequest(url, { method: "PATCH", body: JSON.stringify(payload) });
      }
    }
    return docs.length;
  },

  /** Read every document in a collection (follows Firestore pagination). */
  async listDocs(collection) {
    if (!isConfigured()) throw new Error("Firebase is not configured.");

    if (useFirestore()) {
      const safeCol = encodeURIComponent(`${COLLECTION_PREFIX}_${collection}`);
      const base = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${safeCol}?key=${FIREBASE_API_KEY}&pageSize=300`;
      const all = [];
      let pageToken = "";
      do {
        const res = await httpRequest(pageToken ? `${base}&pageToken=${encodeURIComponent(pageToken)}` : base);
        if (res && Array.isArray(res.documents)) {
          all.push(...res.documents.map(fromFirestoreDoc).filter(Boolean));
        }
        pageToken = (res && res.nextPageToken) || "";
      } while (pageToken);
      return all;
    }

    const data = await rtdbGet(collection);
    if (!data || typeof data !== "object") return [];
    return Object.entries(data).map(([id, value]) => ({ ...value, _id: id }));
  },

  async getDoc(collection, id) {
    if (!isConfigured()) throw new Error("Firebase is not configured.");
    if (FIREBASE_PROJECT_ID && FIREBASE_API_KEY) return firestoreGetDoc(collection, id);
    const value = await rtdbGet(`${collection}/${id}`);
    return value ? { ...value, _id: String(id) } : null;
  },

  async setDoc(collection, id, data) {
    if (!isConfigured()) throw new Error("Firebase is not configured.");
    if (useFirestore()) {
      await firestoreSetDoc(collection, id, data);
    } else {
      await rtdbSet(`${collection}/${id}`, data);
    }
    return true;
  },
};

module.exports = firebaseService;


