const crypto = require("crypto");
const firebase = require("./firebase");

const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY = 500;
const MAX_SESSIONS = 500;
const DEFAULT_RESTING_BPM = 65;
const DEFAULT_BASELINE_HRV = 50;

// sessionId -> { sessionId, token, pairCode, pairCodeExpiresAt, paired, createdAt, lastSeenAt, history[] }
const sessions = new Map();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function generatePairCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const inUse = [...sessions.values()].some(
      (session) => !session.paired && session.pairCode === code && session.pairCodeExpiresAt > Date.now()
    );
    if (!inUse) return code;
  }
  throw new Error("Could not generate a unique pairing code.");
}

function cleanupSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    const lastActivity = session.lastSeenAt || session.createdAt;
    const unpairedExpired = !session.paired && session.pairCodeExpiresAt < now;
    const idleExpired = now - lastActivity > SESSION_TTL_MS;
    if (unpairedExpired || idleExpired) {
      sessions.delete(id);
    }
  }
}

/** Browser calls this to start pairing. Returns a 6-digit code to type on the watch. */
function createPairingSession() {
  cleanupSessions();
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error("Too many active sessions. Try again later.");
  }

  const session = {
    sessionId: crypto.randomBytes(16).toString("hex"),
    token: crypto.randomBytes(24).toString("hex"),
    pairCode: generatePairCode(),
    pairCodeExpiresAt: Date.now() + PAIR_CODE_TTL_MS,
    paired: false,
    createdAt: Date.now(),
    lastSeenAt: 0,
    history: [],
  };
  sessions.set(session.sessionId, session);

  // Persist session to Firebase
  firebase.saveBiometricsSession(session).catch((err) => {
    console.warn("[Biometrics] Firebase save error:", err.message);
  });

  return {
    sessionId: session.sessionId,
    pairCode: session.pairCode,
    expiresInSeconds: Math.round(PAIR_CODE_TTL_MS / 1000),
  };
}

/** Watch calls this with the code. Returns a token used for all later uploads. */
function confirmPairing(code) {
  cleanupSessions();
  const normalized = String(code || "").trim();
  const session = [...sessions.values()].find(
    (item) => !item.paired && item.pairCode === normalized && item.pairCodeExpiresAt > Date.now()
  );
  if (!session) return null;

  session.paired = true;
  session.pairCode = "";
  session.lastSeenAt = Date.now();

  // Persist confirmed session to Firebase
  firebase.saveBiometricsSession(session).catch((err) => {
    console.warn("[Biometrics] Firebase save error:", err.message);
  });

  return { token: session.token, sessionId: session.sessionId };
}

function findSessionByToken(token) {
  const value = String(token || "");
  if (!value) return null;
  const tokenBuffer = Buffer.from(value);
  for (const session of sessions.values()) {
    if (!session.paired) continue;
    const expected = Buffer.from(session.token);
    if (expected.length === tokenBuffer.length && crypto.timingSafeEqual(expected, tokenBuffer)) {
      return session;
    }
  }
  return null;
}

function removeSession(sessionId) {
  const removed = sessions.delete(sessionId);
  if (removed) {
    firebase.deleteBiometricsSession(sessionId).catch((err) => {
      console.warn("[Biometrics] Firebase delete error:", err.message);
    });
  }
  return removed;
}

function rehydrateSessions(sessionList) {
  if (!Array.isArray(sessionList)) return 0;
  const now = Date.now();
  let count = 0;
  for (const s of sessionList) {
    if (!s || !s.sessionId || !s.token) continue;
    const lastActivity = s.lastSeenAt || s.createdAt || now;
    const isUnpairedExpired = !s.paired && s.pairCodeExpiresAt && s.pairCodeExpiresAt < now;
    const isIdleExpired = now - lastActivity > SESSION_TTL_MS;
    if (isUnpairedExpired || isIdleExpired) continue;

    sessions.set(s.sessionId, {
      sessionId: s.sessionId,
      token: s.token,
      pairCode: s.pairCode || "",
      pairCodeExpiresAt: s.pairCodeExpiresAt || 0,
      paired: Boolean(s.paired),
      createdAt: s.createdAt || now,
      lastSeenAt: s.lastSeenAt || 0,
      history: Array.isArray(s.history) ? s.history : [],
    });
    count += 1;
  }
  return count;
}

function getSession(sessionId) {
  return sessions.get(String(sessionId || "")) || null;
}

/**
 * Stress index 0-100.
 * - Only assessed when the user is stationary (otherwise high BPM is just movement).
 * - 70% weight: how far BPM is above resting BPM (35+ BPM above = max).
 * - 30% weight: how far HRV (SDNN) is below baseline (30+ ms below = max).
 */
function computeStress({ bpm, hrv, restingBpm, baselineHrv, isStationary }) {
  if (!isStationary) {
    return { stressPercent: null, stressLevel: "Not assessed (moving)", assessed: false };
  }

  const resting = restingBpm || DEFAULT_RESTING_BPM;
  const bpmScore = clamp((bpm - resting) / 35, 0, 1) * 70;

  let hrvScore = 0;
  if (hrv !== null) {
    const baseline = baselineHrv || DEFAULT_BASELINE_HRV;
    hrvScore = clamp((baseline - hrv) / 30, 0, 1) * 30;
  }

  const stressPercent = Math.round(bpmScore + hrvScore);
  let stressLevel = "Calm";
  if (stressPercent >= 60) stressLevel = "High Stress";
  else if (stressPercent >= 30) stressLevel = "Elevated";

  return { stressPercent, stressLevel, assessed: true };
}

/** Validates and stores one sample coming from the watch. Throws on invalid input. */
function addSample(session, payload = {}) {
  const bpm = toFiniteNumber(payload.bpm);
  if (bpm === null || bpm < 30 || bpm > 220) {
    throw new Error("bpm must be a number between 30 and 220.");
  }

  const hrvRaw = toFiniteNumber(payload.hrv);
  const hrv = hrvRaw !== null && hrvRaw >= 0 && hrvRaw <= 300 ? hrvRaw : null;
  const restingRaw = toFiniteNumber(payload.restingBpm);
  const restingBpm = restingRaw !== null && restingRaw >= 30 && restingRaw <= 120 ? restingRaw : null;
  const isStationary = payload.isStationary !== false;

  const timestampRaw = toFiniteNumber(payload.timestamp);
  // Accept seconds or milliseconds; fall back to server time for bad values.
  let timestampMs = Date.now();
  if (timestampRaw !== null && timestampRaw > 0) {
    timestampMs = timestampRaw < 1e12 ? timestampRaw * 1000 : timestampRaw;
  }

  const stress = computeStress({ bpm, hrv, restingBpm, isStationary });
  const sample = {
    bpm: Math.round(bpm),
    hrv: hrv === null ? null : Math.round(hrv * 10) / 10,
    restingBpm: restingBpm === null ? null : Math.round(restingBpm),
    isStationary,
    ...stress,
    timestamp: new Date(timestampMs).toISOString(),
    receivedAt: new Date().toISOString(),
  };

  session.history.push(sample);
  if (session.history.length > MAX_HISTORY) {
    session.history.splice(0, session.history.length - MAX_HISTORY);
  }
  session.lastSeenAt = Date.now();

  // Persist latest sample & session update to Firebase
  firebase.saveBiometricsSession(session).catch((err) => {
    console.warn("[Biometrics] Firebase sample save error:", err.message);
  });

  return sample;
}

function getCurrent(session) {
  const latest = session.history[session.history.length - 1] || null;
  return {
    paired: session.paired,
    connected: Boolean(latest) && Date.now() - session.lastSeenAt < 30 * 1000,
    latest,
  };
}

function getHistory(session, limit = 100) {
  const count = clamp(Math.floor(Number(limit) || 100), 1, MAX_HISTORY);
  return session.history.slice(-count);
}

module.exports = {
  addSample,
  computeStress,
  confirmPairing,
  createPairingSession,
  findSessionByToken,
  getCurrent,
  getHistory,
  getSession,
  rehydrateSessions,
  removeSession,
};
