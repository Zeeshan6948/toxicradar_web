const crypto = require("crypto");

function sha(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

/** Constant-time string comparison (hashing first makes lengths equal). */
function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha(a), sha(b));
}

/** Never send a full API key to a browser. */
function maskKey(key) {
  const value = String(key || "").trim();
  if (!value) return "";
  return `sk-••••${value.slice(-4)}`;
}

function isMaskedKey(value) {
  return String(value || "").includes("•");
}

function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  next();
}

/** Fixed-window, in-memory limiter keyed by client IP. */
function createRateLimiter({ windowMs, max, message }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs);
  timer.unref();

  return function rateLimiter(req, res, next) {
    const key = req.ip || "unknown";
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: message || "Too many requests. Try again later." });
    }
    next();
  };
}

/** Blocks cross-site form/fetch posts: a browser-sent Origin must match this host. */
function sameOriginGuard(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin");
  if (!origin) return next(); // non-browser clients (the watch) send no Origin
  try {
    if (new URL(origin).host === req.get("host")) return next();
  } catch (_e) {
    // fall through
  }
  return res.status(403).json({ error: "Cross-origin request blocked." });
}

/**
 * HTTP Basic auth gate for the whole site. The browser shows its own login box,
 * so no frontend changes are needed. Any username is accepted; the password must match.
 *
 * openRoutes: ["GET /api/health", ...] are reachable without the password
 * (they must protect themselves, e.g. the watch's bearer token).
 */
function createAuthGate({ password, openRoutes = [], failLimiter, requirePassword }) {
  const open = new Set(openRoutes);

  return function authGate(req, res, next) {
    if (open.has(`${req.method} ${req.path}`)) return next();

    if (!password) {
      if (requirePassword) {
        return res
          .status(503)
          .type("text/plain")
          .send("Server is not configured: set the APP_PASSWORD environment variable.");
      }
      return next(); // local development only
    }

    const header = String(req.get("authorization") || "");
    if (header.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const supplied = decoded.slice(decoded.indexOf(":") + 1);
      if (safeEqual(supplied, password)) return next();
    }

    const respond = () => {
      res.setHeader("WWW-Authenticate", 'Basic realm="ToxicRadar", charset="UTF-8"');
      res.status(401).type("text/plain").send("Authentication required.");
    };
    // Count failed attempts so the password can't be brute-forced.
    return failLimiter ? failLimiter(req, res, respond) : respond();
  };
}

module.exports = {
  createAuthGate,
  createRateLimiter,
  isMaskedKey,
  maskKey,
  safeEqual,
  sameOriginGuard,
  securityHeaders,
};
