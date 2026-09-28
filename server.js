try {
  require("dotenv").config();
} catch (_e) {}
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const analyzer = require("./analyzer");
const exporter = require("./exporter");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const DEFAULT_EXCEL_PATH = path.join(DATA_DIR, "ToxicRadar-Compose-Log.xlsx");

// Ensure data and uploads directories exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Check for existing sample or default Excel log
function resolveDefaultExcelPath() {
  const localDefault = path.join(DATA_DIR, "ToxicRadar-Compose-Log.xlsx");
  if (fs.existsSync(localDefault)) return localDefault;

  const parentFile = path.resolve(__dirname, "..", "ToxicRadar_Auswertung_v2.xlsx");
  if (fs.existsSync(parentFile)) return parentFile;

  return localDefault;
}

// In-file settings manager replacing electron-store
function loadSettings() {
  const envKey = process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY.trim() : "";
  const defaults = {
    openaiApiKey: envKey,
    excelPath: resolveDefaultExcelPath(),
    apiUsageByMonth: {},
    reminderIntervalDays: 0,
    lastReminderAt: "",
  };

  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
      const merged = { ...defaults, ...parsed };
      if (!merged.openaiApiKey && envKey) {
        merged.openaiApiKey = envKey;
      }
      return merged;
    }
  } catch (err) {
    console.error("Failed to read settings file, using defaults:", err.message);
  }

  return defaults;
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("Failed to save settings:", err.message);
    return false;
  }
}

let currentSettings = loadSettings();

// Usage & Pricing Logic
const ANALYSIS_MODEL_PRICING = {
  "gpt-4o-mini": {
    inputPerMillion: 0.15,
    cachedInputPerMillion: 0.075,
    outputPerMillion: 0.6,
  },
};

function getCurrentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function toUsageNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function estimateUsageCost(model, usage = {}) {
  const pricing = ANALYSIS_MODEL_PRICING[model] || ANALYSIS_MODEL_PRICING["gpt-4o-mini"];
  const inputTokens = toUsageNumber(usage.input_tokens);
  const outputTokens = toUsageNumber(usage.output_tokens);
  const cachedInputTokens = Math.min(
    inputTokens,
    toUsageNumber(usage.input_tokens_details?.cached_tokens)
  );
  const regularInputTokens = Math.max(0, inputTokens - cachedInputTokens);

  return (
    (regularInputTokens / 1_000_000) * pricing.inputPerMillion +
    (cachedInputTokens / 1_000_000) * pricing.cachedInputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}

function getCurrentMonthUsage() {
  const monthKey = getCurrentMonthKey();
  const usageByMonth = currentSettings.apiUsageByMonth || {};
  const monthUsage = usageByMonth[monthKey] || {};

  return {
    monthKey,
    requests: toUsageNumber(monthUsage.requests),
    inputTokens: toUsageNumber(monthUsage.inputTokens),
    outputTokens: toUsageNumber(monthUsage.outputTokens),
    cachedInputTokens: toUsageNumber(monthUsage.cachedInputTokens),
    totalTokens: toUsageNumber(monthUsage.totalTokens),
    estimatedCostUsd: Number(monthUsage.estimatedCostUsd) || 0,
  };
}

function recordApiUsage(model, usage = {}) {
  const monthKey = getCurrentMonthKey();
  const usageByMonth = currentSettings.apiUsageByMonth || {};
  const current = usageByMonth[monthKey] || {};

  const inputTokens = toUsageNumber(usage.input_tokens);
  const outputTokens = toUsageNumber(usage.output_tokens);
  const cachedInputTokens = Math.min(
    inputTokens,
    toUsageNumber(usage.input_tokens_details?.cached_tokens)
  );
  const totalTokens = toUsageNumber(usage.total_tokens) || inputTokens + outputTokens;
  const cost = estimateUsageCost(model, usage);

  usageByMonth[monthKey] = {
    requests: toUsageNumber(current.requests) + 1,
    inputTokens: toUsageNumber(current.inputTokens) + inputTokens,
    outputTokens: toUsageNumber(current.outputTokens) + outputTokens,
    cachedInputTokens: toUsageNumber(current.cachedInputTokens) + cachedInputTokens,
    totalTokens: toUsageNumber(current.totalTokens) + totalTokens,
    estimatedCostUsd: Number(((Number(current.estimatedCostUsd) || 0) + cost).toFixed(6)),
    updatedAt: new Date().toISOString(),
  };

  currentSettings.apiUsageByMonth = usageByMonth;
  saveSettings(currentSettings);
  return getCurrentMonthUsage();
}

// Multer Storage Configuration
const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

// Middleware
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Serve static frontend files
app.use(express.static(path.join(__dirname)));

// ==================== REST API ENDPOINTS ====================

// Settings endpoints
app.get("/api/settings", (req, res) => {
  const activeKey = (currentSettings.openaiApiKey || process.env.OPENAI_API_KEY || "").trim();
  res.json({
    openaiApiKey: activeKey,
    excelPath: currentSettings.excelPath || DEFAULT_EXCEL_PATH,
    reminderIntervalDays: Number(currentSettings.reminderIntervalDays) || 0,
    hasApiKey: Boolean(activeKey),
  });
});

app.post("/api/settings", (req, res) => {
  const { openaiApiKey, reminderIntervalDays, excelPath } = req.body || {};

  if (typeof openaiApiKey === "string") {
    currentSettings.openaiApiKey = openaiApiKey.trim();
  }
  if (typeof reminderIntervalDays === "number") {
    currentSettings.reminderIntervalDays = reminderIntervalDays;
  }
  if (typeof excelPath === "string" && excelPath.trim()) {
    currentSettings.excelPath = excelPath.trim();
  }

  saveSettings(currentSettings);
  res.json({ success: true, settings: currentSettings });
});

// Usage endpoints
app.get("/api/usage", (req, res) => {
  res.json(getCurrentMonthUsage());
});

app.post("/api/usage", (req, res) => {
  const { model, usage } = req.body || {};
  const updated = recordApiUsage(model, usage);
  res.json(updated);
});

// Analysis endpoint
app.post("/api/analyze", async (req, res) => {
  try {
    const { text, apiKey } = req.body || {};
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Text content is required for analysis." });
    }

    const keyToUse = (apiKey && apiKey.trim()) || currentSettings.openaiApiKey;
    if (!keyToUse) {
      return res.status(400).json({
        error: "OpenAI API Key is missing. Please configure it in settings or provide it.",
      });
    }

    const result = await analyzer.analyzeEmailText(text, keyToUse);
    if (result && result.usage) {
      recordApiUsage(result.model || "gpt-4o-mini", result.usage);
    }

    res.json({ success: true, analysis: result });
  } catch (error) {
    console.error("Analysis failed:", error);
    res.status(500).json({ error: error.message || "Failed to analyze message." });
  }
});

// Excel summary & dashboard endpoint
app.get("/api/excel/summary", (req, res) => {
  try {
    const targetExcelPath = currentSettings.excelPath || DEFAULT_EXCEL_PATH;

    if (!fs.existsSync(targetExcelPath)) {
      return res.json({
        totalEmails: 0,
        positivePercent: 0,
        neutralPercent: 0,
        negativePercent: 0,
        emails: [],
        excelPath: targetExcelPath,
        exists: false,
      });
    }

    const summary = exporter.readDashboardSummary(targetExcelPath);
    res.json({
      ...summary,
      excelPath: targetExcelPath,
      exists: true,
    });
  } catch (error) {
    console.error("Failed to read Excel summary:", error);
    res.status(500).json({ error: error.message || "Failed to read Excel summary" });
  }
});

// Append compose result to Excel
app.post("/api/excel/append", (req, res) => {
  try {
    const { composeResult, options } = req.body || {};
    if (!composeResult) {
      return res.status(400).json({ error: "composeResult is required" });
    }

    const targetExcelPath = currentSettings.excelPath || DEFAULT_EXCEL_PATH;
    const savedLog = exporter.appendComposeResult(composeResult, targetExcelPath, options || {});

    res.json({
      success: true,
      rowNumber: savedLog.rowNumber,
      excelPath: targetExcelPath,
    });
  } catch (error) {
    console.error("Failed to append compose result:", error);
    res.status(500).json({ error: error.message || "Failed to log compose result to Excel" });
  }
});

// Update rewrite in Excel
app.post("/api/excel/rewrite", (req, res) => {
  try {
    const { rowNumber, rewrite } = req.body || {};
    const targetExcelPath = currentSettings.excelPath || DEFAULT_EXCEL_PATH;

    exporter.updateComposeRewrite(targetExcelPath, rowNumber, rewrite || "");
    res.json({ success: true });
  } catch (error) {
    console.error("Failed to update rewrite:", error);
    res.status(500).json({ error: error.message || "Failed to update rewrite in Excel" });
  }
});

// Download active Excel file
app.get("/api/excel/download", (req, res) => {
  const targetExcelPath = currentSettings.excelPath || DEFAULT_EXCEL_PATH;

  if (!fs.existsSync(targetExcelPath)) {
    // Generate an empty template workbook if it doesn't exist yet
    exporter.appendComposeResult(
      {
        email: { to: "demo@company.com", subject: "Initial Log", body: "Welcome to ToxicRadar." },
        analysis: {
          overallFlag: false,
          overallToxicityScore: 1,
          overallToxicityLabel: "Minimal",
          overallToxicityEmoji: "🟢",
          dimensions: [],
          notes: "Initial log entry.",
          suggestedRewrite: "",
        },
      },
      targetExcelPath,
      { promptType: "compose" }
    );
  }

  res.download(targetExcelPath, path.basename(targetExcelPath) || "ToxicRadar-Log.xlsx");
});

// Upload an Excel file
app.post("/api/excel/upload", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No Excel file uploaded." });
    }

    const originalName = req.file.originalname || "Uploaded-Log.xlsx";
    const newPath = path.join(DATA_DIR, originalName);

    // Move uploaded file to DATA_DIR
    fs.renameSync(req.file.path, newPath);

    currentSettings.excelPath = newPath;
    saveSettings(currentSettings);

    const summary = exporter.readDashboardSummary(newPath);
    res.json({
      success: true,
      excelPath: newPath,
      summary,
    });
  } catch (error) {
    console.error("Failed to upload Excel file:", error);
    if (req.file && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (_e) {}
    }
    res.status(500).json({ error: error.message || "Failed to process Excel upload" });
  }
});

// Upload and parse PST file
app.post("/api/pst/upload", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No PST file uploaded." });
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

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", app: "ToxicRadar Web", version: "1.0.1" });
});

// Start Server
app.listen(PORT, () => {
  console.log(`=============================================`);
  console.log(`🚀 ToxicRadar Web running at: http://localhost:${PORT}`);
  console.log(`📁 Data directory: ${DATA_DIR}`);
  console.log(`=============================================`);
});

