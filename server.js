try {
  require("dotenv").config();
} catch (_e) {}
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const security = require("./security");
const multer = require("multer");
const analyzer = require("./analyzer");
const exporter = require("./exporter");
const biometrics = require("./biometrics");
const firebase = require("./firebase");
const store = require("./store");

const app = express();
const PORT = process.env.PORT || 3000;

// Only transient files (in-flight uploads / generated downloads) touch disk, in the OS temp
// folder, and each is deleted right after use. All persistent data lives in Firebase.
const UPLOADS_DIR = path.join(os.tmpdir(), "toxicradar-tmp");
const STORAGE_LABEL = "Firebase Cloud Storage";
fs.mkdirSync(UPLOADS_DIR, { recursive: true });


// Uploads: restrict file type and size
function uploaderFor(allowedExtensions, maxBytes) {
  return multer({
    dest: UPLOADS_DIR,
    limits: { fileSize: maxBytes, files: 1 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase();
      cb(null, allowedExtensions.includes(ext));
    },
  });
}
const uploadExcel = uploaderFor([".xlsx", ".xls"], 25 * 1024 * 1024);
const uploadPst = uploaderFor([".pst"], 100 * 1024 * 1024);

// ==================== SECURITY MIDDLEWARE ====================
// Render sits behind a proxy; this makes req.ip the real client address.
app.set("trust proxy", 1);
app.disable("x-powered-by");

const APP_PASSWORD = String(process.env.APP_PASSWORD || "");
const IS_HOSTED = process.env.RENDER === "true" || process.env.NODE_ENV === "production";
if (IS_HOSTED && !APP_PASSWORD) {
  console.error("!! APP_PASSWORD is not set. The site will refuse all requests until it is.");
}

const authFailLimiter = security.createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Too many failed logins. Try again in 15 minutes.",
});
const pairConfirmLimiter = security.createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: "Too many pairing attempts. Try again later.",
});
const analyzeLimiter = security.createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 600,
  message: "Analysis limit reached for this hour.",
});

app.use(security.securityHeaders);
app.use(
  security.createAuthGate({
    password: APP_PASSWORD,
    requirePassword: IS_HOSTED,
    failLimiter: authFailLimiter,
    // Reachable without the site password. The watch can't show a login box,
    // so these protect themselves (bearer token / single-use pairing code).
    openRoutes: [
      "GET /api/health",
      "GET /privacy",
      "POST /api/biometrics",
      "POST /api/biometrics/pair/confirm",
    ],
  })
);
app.use(security.sameOriginGuard);
app.use(express.json({ limit: "10mb" }));

// Serve ONLY the frontend files. Never expose the project root: it contains
// data/settings.json (API key), server source and uploaded files.
const PUBLIC_FILES = [
  "index.html",
  "style.css",
  "renderer.js",
  "api-client.js",
  "Microsoft_Excel-Logo.wine.svg",
];
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
PUBLIC_FILES.forEach((fileName) => {
  app.get(`/${fileName}`, (req, res) => res.sendFile(path.join(__dirname, fileName)));
});
app.use("/assets", express.static(path.join(__dirname, "assets")));

// ==================== REST API ENDPOINTS ====================

// Settings endpoints
function getActiveKey() {
  return String(process.env.OPENAI_API_KEY || "").trim();
}

app.get("/api/settings", (req, res) => {
  res.json({
    excelPath: STORAGE_LABEL,
    storage: firebase.isConfigured() ? "firebase" : "memory",
    firebaseConfigured: firebase.isConfigured(),
    hasApiKey: Boolean(getActiveKey()),
  });
});

// Nothing user-editable is stored server-side any more (theme lives in the browser).
app.post("/api/settings", (req, res) => {
  res.json({ success: true });
});

// Analysis endpoint
app.post("/api/analyze", analyzeLimiter, async (req, res) => {
  try {
    const { text, biometrics } = req.body || {};
    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "Text content is required for analysis." });
    }
    if (text.length > 30000) {
      return res.status(400).json({ error: "Text is too long (max 30,000 characters)." });
    }

    const keyToUse = getActiveKey();
    if (!keyToUse) {
      return res.status(400).json({
        error: "OpenAI API Key is missing on the server. Please set OPENAI_API_KEY in the environment.",
      });
    }

    const result = await analyzer.analyzeEmailText(text, keyToUse, biometrics);
    res.json({ success: true, analysis: result });
  } catch (error) {
    console.error("Analysis failed:", error);
    res.status(500).json({ error: error.message || "Failed to analyze message." });
  }
});

// Autocomplete endpoint (Non-exploitative inline completions using ChatGPT with fallback)
app.post("/api/autocomplete", async (req, res) => {
  try {
    const { text } = req.body || {};
    if (typeof text !== "string" || !text.trim()) {
      return res.json({ success: true, suggestion: "" });
    }
    const keyToUse = getActiveKey();
    const result = await analyzer.generateAutocomplete(text, keyToUse);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error("Autocomplete failed:", error);
    res.json({ success: true, suggestion: "", source: "error" });
  }
});

// Pronoun & egoistic bias evaluation endpoint
app.post("/api/bias/pronouns", (req, res) => {
  try {
    const { text } = req.body || {};
    const evaluation = analyzer.evaluatePronounBias(text || "");
    res.json({ success: true, ...evaluation, evaluation });
  } catch (error) {
    console.error("Pronoun evaluation failed:", error);
    res.status(500).json({ error: error.message });
  }
});

// Training & course recommendations endpoint
app.post("/api/training/recommendations", (req, res) => {
  try {
    const context = req.body || {};
    const recommendations = analyzer.getTrainingRecommendations(context);
    res.json({ success: true, ...recommendations });
  } catch (error) {
    console.error("Training recommendations failed:", error);
    res.status(500).json({ error: error.message });
  }
});

// Excel summary & dashboard endpoint - computed from Firebase records
app.get("/api/excel/summary", async (req, res) => {
  try {
    const summary = await store.getSummary({ from: req.query.from, to: req.query.to });
    res.json({
      ...summary,
      excelPath: STORAGE_LABEL,
      storage: "firebase",
      exists: summary.totalEmails > 0,
    });
  } catch (error) {
    console.error("Failed to load records from Firebase:", error);
    res.status(503).json({ error: `Could not load data from Firebase: ${error.message}` });
  }
});

// Save an analysed email to Firebase
app.post("/api/excel/append", async (req, res) => {
  try {
    const { composeResult } = req.body || {};
    if (!composeResult || !composeResult.email) {
      return res.status(400).json({ error: "composeResult is required" });
    }

    // The record id doubles as the "rowNumber" the client sends back when updating the rewrite.
    const id = await store.addComposeResult(composeResult);
    res.json({ success: true, rowNumber: id, excelPath: STORAGE_LABEL });
  } catch (error) {
    console.error("Failed to save compose result to Firebase:", error);
    res.status(500).json({ error: error.message || "Failed to save compose result to Firebase" });
  }
});

// Update the saved rewrite of a record in Firebase
app.post("/api/excel/rewrite", async (req, res) => {
  try {
    const { rowNumber, rewrite } = req.body || {};
    if (rowNumber) {
      const updated = await store.updateRewrite(String(rowNumber), rewrite || "");
      if (!updated) {
        return res.status(404).json({ error: "Record not found in Firebase." });
      }
    }
    res.json({ success: true });
  } catch (error) {
    console.error("Failed to update rewrite in Firebase:", error);
    res.status(500).json({ error: error.message || "Failed to update rewrite" });
  }
});

// Download all stored records as an Excel file (generated on the fly from Firebase)
app.get("/api/excel/download", async (req, res) => {
  let tempPath = null;
  try {
    const records = await store.listRecords({ force: true });
    tempPath = path.join(UPLOADS_DIR, `ToxicRadar-Log-${Date.now()}.xlsx`);
    exporter.exportResults(records, tempPath);
    res.download(tempPath, "ToxicRadar-Compose-Log.xlsx", () => {
      try {
        fs.unlinkSync(tempPath);
      } catch (_e) {}
    });
  } catch (error) {
    console.error("Failed to build Excel download:", error);
    if (tempPath && fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch (_e) {}
    }
    res.status(503).json({ error: `Could not export data from Firebase: ${error.message}` });
  }
});

// Upload an Excel file: parse it, commit every row to Firebase, discard the temp file
app.post("/api/excel/upload", uploadExcel.single("file"), async (req, res) => {
  const tempPath = req.file && req.file.path;
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Upload a .xlsx or .xls file." });
    }

    let records;
    try {
      records = exporter.parseExcelRecords(tempPath);
    } catch (parseError) {
      return res.status(400).json({ error: "That file could not be read as a ToxicRadar Excel log." });
    }
    if (!records.length) {
      return res.status(400).json({ error: "No email rows were found in that Excel file." });
    }

    const { count, batchId } = await store.addImportedRecords(records, { fileName: req.file.originalname });
    const summary = await store.getSummary();
    res.json({ success: true, imported: count, batchId, excelPath: STORAGE_LABEL, summary });
  } catch (error) {
    console.error("Failed to import Excel file into Firebase:", error);
    res.status(500).json({ error: `Failed to save Excel data to Firebase: ${error.message}` });
  } finally {
    if (tempPath) {
      try {
        fs.unlinkSync(tempPath);
      } catch (_e) {}
    }
  }
});

// Upload and parse PST file
app.post("/api/pst/upload", uploadPst.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Upload a .pst file." });
    }

    const tempFilePath = req.file.path;
    const parsedData = analyzer.parsePstFile(tempFilePath);

    // Clean up temporary file
    try {
      fs.unlinkSync(tempFilePath);
    } catch (_e) {}

    res.json({
      success: true,
      data: parsedData,
      count: parsedData?.emails?.length || 0,
    });
  } catch (error) {
    console.error("Failed to parse PST file:", error);
    if (req.file && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (_e) {}
    }
    res.status(500).json({ error: error.message || "Failed to parse PST file." });
  }
});

// Export analysis results to downloadable Excel file
app.post("/api/export", (req, res) => {
  try {
    const { results } = req.body || {};
    if (!Array.isArray(results)) {
      return res.status(400).json({ error: "Results array is required." });
    }

    const exportPath = path.join(UPLOADS_DIR, `ToxicRadar-Export-${Date.now()}.xlsx`);
    exporter.exportResults(results, exportPath);

    res.download(exportPath, "ToxicRadar-Export.xlsx", () => {
      try {
        fs.unlinkSync(exportPath);
      } catch (_e) {}
    });
  } catch (error) {
    console.error("Failed to export results:", error);
    res.status(500).json({ error: error.message || "Failed to export results." });
  }
});

// ==================== APPLE WATCH BIOMETRICS ====================

// Browser: start pairing, receive a 6-digit code to type on the watch
app.post("/api/biometrics/pair", (req, res) => {
  try {
    res.json(biometrics.createPairingSession());
  } catch (error) {
    res.status(429).json({ error: error.message });
  }
});

// Watch: exchange the 6-digit code for an upload token
app.post("/api/biometrics/pair/confirm", pairConfirmLimiter, (req, res) => {
  const result = biometrics.confirmPairing(req.body?.code);
  if (!result) {
    return res.status(400).json({ error: "Invalid or expired pairing code." });
  }
  res.json({ success: true, ...result });
});

// Watch: upload one biometric sample (Authorization: Bearer <token>)
app.post("/api/biometrics", (req, res) => {
  const header = String(req.get("authorization") || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const session = biometrics.findSessionByToken(token);
  if (!session) {
    return res.status(401).json({ error: "Invalid or missing token. Pair the watch again." });
  }

  try {
    const sample = biometrics.addSample(session, req.body);
    res.json({ success: true, sample });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Browser: latest reading for a session
app.get("/api/biometrics/current", (req, res) => {
  const session = biometrics.getSession(req.query.sessionId);
  if (!session) {
    return res.status(404).json({ error: "Unknown session. Start pairing again." });
  }
  res.json(biometrics.getCurrent(session));
});

// Browser: recent readings for a session
app.get("/api/biometrics/history", (req, res) => {
  const session = biometrics.getSession(req.query.sessionId);
  if (!session) {
    return res.status(404).json({ error: "Unknown session. Start pairing again." });
  }
  res.json({ samples: biometrics.getHistory(session, req.query.limit) });
});

// Browser: disconnect the watch and delete its stored data
app.delete("/api/biometrics/session", (req, res) => {
  const removed = biometrics.removeSession(req.query.sessionId);
  res.json({ success: removed });
});

// Privacy policy (required for App Store HealthKit review)
app.get("/privacy", (req, res) => {
  res.sendFile(path.join(__dirname, "appstore", "privacy-policy.html"));
});


// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", app: "ToxicRadar Web", version: "1.0.1" });
});

// Startup warm-up for Render spin-ups. Email records are read straight from
// Firebase on demand (store.js), so only biometrics sessions need rehydrating.
async function rehydrateFromFirebase() {
  if (!firebase.isConfigured()) return;
  console.log("[Firebase] Starting data rehydration...");

  try {
    const records = await store.listRecords({ force: true });
    console.log(`[Firebase] ${records.length} email records available.`);
  } catch (err) {
    console.warn("[Firebase] Could not read email records:", err.message);
  }

  try {
    const remoteSessions = await firebase.getBiometricsSessions();
    if (remoteSessions && remoteSessions.length > 0) {
      const count = biometrics.rehydrateSessions(remoteSessions);
      console.log(`[Firebase] Rehydrated ${count} active biometrics sessions.`);
    }
  } catch (err) {
    console.warn("[Firebase] Biometrics sessions rehydration failed:", err.message);
  }
}

// Start Server
const server = app.listen(PORT, async () => {
  console.log(`=============================================`);
  console.log(`🚀 ToxicRadar Web running at: http://localhost:${PORT}`);
  console.log(`🗄️  Storage: ${firebase.isConfigured() ? "Firebase (no local data files)" : "in-memory (Firebase not configured)"}`);
  if (firebase.isConfigured()) {
    console.log(`🔥 Firebase storage: Connected (${process.env.FIREBASE_PROJECT_ID || "Realtime DB"})`);
    await rehydrateFromFirebase();
  } else {
    console.log(`ℹ️ Firebase not configured. Using local ephemeral storage.`);
  }
  console.log(`=============================================`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n❌ [ToxicRadar Server] Port ${PORT} is already in use!`);
    console.error(`   Another instance of ToxicRadar or another process is running on this port.`);
    console.error(`\n👉 To free up port ${PORT}, run this command in your terminal:`);
    console.error(`   kill -9 $(lsof -t -i:${PORT})`);
    console.error(`\n👉 Alternatively, start the server on a different port:`);
    console.error(`   PORT=3001 npm start\n`);
    process.exit(1);
  } else {
    console.error("❌ [ToxicRadar Server] Unexpected server error:", err);
    process.exit(1);
  }
});


