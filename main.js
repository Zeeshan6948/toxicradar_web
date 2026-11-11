const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { app, BrowserWindow, Menu, Notification, dialog, ipcMain, nativeImage, shell } = require("electron");
const Store = require("electron-store");

const settingsStore = new Store({
  name: "toxicradar-settings",
  defaults: {
    openaiApiKey: "",
    excelPath: "",
    apiUsageByMonth: {},
    reminderIntervalDays: 0,
    lastReminderAt: "",
  },
});

const REMINDER_INTERVAL_OPTIONS = new Set([0, 7, 14, 30]);
const REMINDER_CHECK_MS = 60 * 60 * 1000;
const WINDOW_ICON_PATH = path.join(__dirname, "build", "icon.ico");
const NOTIFICATION_ICON_PATH = path.join(__dirname, "assets", "toxicradar-notification.png");
const DEFAULT_ZOOM_FACTOR = 0.8;
const MIN_ZOOM_FACTOR = 0.6;
const MAX_ZOOM_FACTOR = 1.8;
const ZOOM_STEP = 0.1;
const ANALYSIS_MODEL_PRICING = {
  "gpt-4o-mini": {
    inputPerMillion: 0.15,
    cachedInputPerMillion: 0.075,
    outputPerMillion: 0.60,
  },
};
let mainWindow = null;
let reminderCheckTimer = null;

function getAppIconPath() {
  return fs.existsSync(WINDOW_ICON_PATH) ? WINDOW_ICON_PATH : NOTIFICATION_ICON_PATH;
}

function getDefaultExcelPath() {
  const existingDashboardLog = path.resolve(__dirname, "..", "ToxicRadar_Auswertung_v2.xlsx");
  if (fs.existsSync(existingDashboardLog)) {
    return existingDashboardLog;
  }

  return path.join(app.getPath("documents"), "ToxicRadar-Compose-Log.xlsx");
}

function getConfiguredExcelPath() {
  const savedPath = String(settingsStore.get("excelPath", "") || "").trim();
  return savedPath || getDefaultExcelPath();
}

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
  const usageByMonth = settingsStore.get("apiUsageByMonth", {}) || {};
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
  const usageByMonth = settingsStore.get("apiUsageByMonth", {}) || {};
  const current = usageByMonth[monthKey] || {};
  const inputTokens = toUsageNumber(usage.input_tokens);
  const outputTokens = toUsageNumber(usage.output_tokens);
  const cachedInputTokens = Math.min(
    inputTokens,
    toUsageNumber(usage.input_tokens_details?.cached_tokens)
  );
  const totalTokens = toUsageNumber(usage.total_tokens) || inputTokens + outputTokens;
  const estimatedCostUsd = estimateUsageCost(model, usage);

  usageByMonth[monthKey] = {
    requests: toUsageNumber(current.requests) + 1,
    inputTokens: toUsageNumber(current.inputTokens) + inputTokens,
    outputTokens: toUsageNumber(current.outputTokens) + outputTokens,
    cachedInputTokens: toUsageNumber(current.cachedInputTokens) + cachedInputTokens,
    totalTokens: toUsageNumber(current.totalTokens) + totalTokens,
    estimatedCostUsd: (Number(current.estimatedCostUsd) || 0) + estimatedCostUsd,
  };

  settingsStore.set("apiUsageByMonth", usageByMonth);
  return getCurrentMonthUsage();
}

function runJsonCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        windowsHide: true,
        timeout: options.timeout || 10 * 60 * 1000,
        maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || stdout || error.message).trim()));
          return;
        }

        const output = String(stdout || "").replace(/^\uFEFF/, "").trim();
        if (!output) {
          resolve({});
          return;
        }

        try {
          resolve(JSON.parse(output));
        } catch (_parseError) {
          resolve({ output });
        }
      }
    );
  });
}

function createMainWindow() {
  const window = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1120,
    minHeight: 760,
    icon: getAppIconPath(),
    backgroundColor: "#0f1117",
    title: "Exploitative Leadership Detection and Mitigation Tool",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  registerZoomShortcuts(window);
  registerContextMenu(window);
  window.webContents.setZoomFactor(DEFAULT_ZOOM_FACTOR);
  window.maximize();
  window.loadFile(path.join(__dirname, "index.html"));
  mainWindow = window;
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
  return window;
}

function getReminderIntervalDays() {
  const intervalDays = Number(settingsStore.get("reminderIntervalDays", 0));
  return REMINDER_INTERVAL_OPTIONS.has(intervalDays) ? intervalDays : 0;
}

function isReminderDue() {
  const intervalDays = getReminderIntervalDays();
  if (!intervalDays) {
    return false;
  }

  const lastReminderAt = String(settingsStore.get("lastReminderAt", "") || "");
  if (!lastReminderAt) {
    return true;
  }

  const lastReminderTime = new Date(lastReminderAt).getTime();
  if (!Number.isFinite(lastReminderTime)) {
    return true;
  }

  return Date.now() - lastReminderTime >= intervalDays * 24 * 60 * 60 * 1000;
}

function showUsageReminderIfDue() {
  if (!isReminderDue() || !Notification.isSupported()) {
    return;
  }

  settingsStore.set("lastReminderAt", new Date().toISOString());
  showUsageReminderNotification();
}

function showUsageReminderNotification() {
  if (!Notification.isSupported()) {
    return false;
  }

  const icon = fs.existsSync(NOTIFICATION_ICON_PATH)
    ? nativeImage.createFromPath(NOTIFICATION_ICON_PATH)
    : undefined;
  const notification = new Notification({
    title: "Exploitative Leadership Detection Reminder",
    body: "Time to review your communication trends in Exploitative Leadership Detection.",
    icon,
    silent: false,
  });

  notification.on("click", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    } else {
      createMainWindow();
    }
  });

  notification.show();
  return true;
}

function startReminderChecks() {
  if (reminderCheckTimer) {
    clearInterval(reminderCheckTimer);
  }
  showUsageReminderIfDue();
  reminderCheckTimer = setInterval(showUsageReminderIfDue, REMINDER_CHECK_MS);
}

function clampZoomFactor(value) {
  return Math.max(MIN_ZOOM_FACTOR, Math.min(MAX_ZOOM_FACTOR, value));
}

function changeZoomByDirection(window, direction) {
  const currentZoomFactor = window.webContents.getZoomFactor();
  const delta = direction === "in" ? ZOOM_STEP : -ZOOM_STEP;
  window.webContents.setZoomFactor(clampZoomFactor(currentZoomFactor + delta));
}

function registerZoomShortcuts(window) {
  window.webContents.on("zoom-changed", (event, zoomDirection) => {
    event.preventDefault();
    changeZoomByDirection(window, zoomDirection);
  });

  window.webContents.on("before-input-event", (event, input) => {
    const usesShortcutModifier = input.control || input.meta;
    if (!usesShortcutModifier) {
      return;
    }

    const key = String(input.key || "").toLowerCase();
    const code = String(input.code || "").toLowerCase();

    if (key === "0" || code === "digit0" || code === "numpad0") {
      window.webContents.setZoomFactor(DEFAULT_ZOOM_FACTOR);
      event.preventDefault();
      return;
    }

    if (key === "+" || key === "=" || code === "equal" || code === "numpadadd") {
      changeZoomByDirection(window, "in");
      event.preventDefault();
      return;
    }

    if (key === "-" || code === "minus" || code === "numpadsubtract") {
      changeZoomByDirection(window, "out");
      event.preventDefault();
    }
  });
}

function registerContextMenu(window) {
  window.webContents.on("context-menu", (_event, params) => {
    const menuTemplate = [];

    if (params.isEditable) {
      menuTemplate.push(
        { role: "undo", label: "Undo", enabled: params.editFlags.canUndo },
        { role: "redo", label: "Redo", enabled: params.editFlags.canRedo },
        { type: "separator" },
        { role: "cut", label: "Cut", enabled: params.editFlags.canCut },
        { role: "copy", label: "Copy", enabled: params.editFlags.canCopy },
        { role: "paste", label: "Paste", enabled: params.editFlags.canPaste },
        { role: "selectAll", label: "Select All", enabled: params.editFlags.canSelectAll }
      );
    } else if (params.selectionText) {
      menuTemplate.push(
        { role: "copy", label: "Copy" },
        { type: "separator" },
        { role: "selectAll", label: "Select All" }
      );
    } else {
      menuTemplate.push({ role: "selectAll", label: "Select All" });
    }

    Menu.buildFromTemplate(menuTemplate).popup({ window });
  });
}

ipcMain.handle("settings:get", async () => ({
  openaiApiKey: settingsStore.get("openaiApiKey", ""),
  excelPath: getConfiguredExcelPath(),
  apiUsage: getCurrentMonthUsage(),
  reminderIntervalDays: getReminderIntervalDays(),
}));

ipcMain.handle("settings:set", async (_event, payload = {}) => {
  const openaiApiKey = String(payload.openaiApiKey || "").trim();
  const reminderIntervalDays = Number(payload.reminderIntervalDays);
  const safeReminderIntervalDays = REMINDER_INTERVAL_OPTIONS.has(reminderIntervalDays)
    ? reminderIntervalDays
    : 0;
  const previousReminderIntervalDays = getReminderIntervalDays();
  settingsStore.set("openaiApiKey", openaiApiKey);
  settingsStore.set("reminderIntervalDays", safeReminderIntervalDays);
  if (!safeReminderIntervalDays) {
    settingsStore.set("lastReminderAt", "");
  } else if (
    safeReminderIntervalDays !== previousReminderIntervalDays ||
    !settingsStore.get("lastReminderAt", "")
  ) {
    settingsStore.set("lastReminderAt", new Date().toISOString());
  }
  return {
    success: true,
    hasApiKey: Boolean(openaiApiKey),
    reminderIntervalDays: safeReminderIntervalDays,
  };
});

ipcMain.handle("api-usage:get", async () => getCurrentMonthUsage());

ipcMain.handle("api-usage:record", async (_event, payload = {}) => {
  return recordApiUsage(String(payload.model || "gpt-4o-mini"), payload.usage || {});
});

ipcMain.handle("reminder:test", async () => ({
  success: showUsageReminderNotification(),
}));

ipcMain.handle("dialog:select-pst", async () => {
  const result = await dialog.showOpenDialog({
    title: "Select PST File",
    properties: ["openFile"],
    filters: [{ name: "Outlook PST Files", extensions: ["pst"] }],
  });

  if (result.canceled || !result.filePaths.length) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle("dialog:save-export", async (_event, defaultFileName) => {
  const result = await dialog.showSaveDialog({
    title: "Export Analysis Results",
    defaultPath: defaultFileName || "Exploitative-Leadership-Batch-Analysis.xlsx",
    filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
  });

  if (result.canceled || !result.filePath) {
    return null;
  }

  return result.filePath;
});

ipcMain.handle("compose:get-log-path", async () => {
  return getConfiguredExcelPath();
});

ipcMain.handle("excel:open-log", async () => {
  const targetPath = getConfiguredExcelPath();

  if (!fs.existsSync(targetPath)) {
    throw new Error("Excel file not found.");
  }

  const openError = await shell.openPath(targetPath);
  if (openError) {
    throw new Error(openError);
  }

  return { success: true, path: targetPath };
});

ipcMain.handle("excel:choose-log-path", async (event) => {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender) || undefined;
  const result = await dialog.showOpenDialog(ownerWindow, {
    title: "Choose Excel File",
    defaultPath: getConfiguredExcelPath(),
    properties: ["openFile"],
    filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
  });

  if (result.canceled || !result.filePaths.length) {
    return null;
  }

  const selectedPath = result.filePaths[0];
  settingsStore.set("excelPath", selectedPath);
  return { path: selectedPath };
});

ipcMain.handle("dialog:save-pst", async () => {
  const result = await dialog.showSaveDialog({
    title: "Export Sent Items to PST",
    defaultPath: "SentItems-Export.pst",
    filters: [{ name: "Outlook PST Files", extensions: ["pst"] }],
  });

  if (result.canceled || !result.filePath) {
    return null;
  }

  const fileExists = fs.existsSync(result.filePath);
  if (!fileExists) {
    return {
      outputPath: result.filePath,
      overwriteExisting: false,
    };
  }

  const overwritePrompt = await dialog.showMessageBox({
    type: "warning",
    title: "Replace Existing PST?",
    message: "The selected PST file already exists.",
    detail: "Do you want to replace it with a new Sent Items export?",
    buttons: ["Replace", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });

  if (overwritePrompt.response !== 0) {
    return null;
  }

  return {
    outputPath: result.filePath,
    overwriteExisting: true,
  };
});

ipcMain.handle("pst:load-via-outlook", async (_event, payload = {}) => {
  const pstPath = String(payload.pstPath || "").trim();
  if (!pstPath) {
    throw new Error("A PST path is required.");
  }

  const scriptPath = path.join(__dirname, "load-pst-win32com.py");
  return await runJsonCommand("py", ["-3", scriptPath, "--pst-path", pstPath]);
});

ipcMain.handle("outlook:export-sent-pst", async (_event, payload = {}) => {
  const outputPath = String(payload.outputPath || "").trim();
  const overwriteExisting = Boolean(payload.overwriteExisting);
  if (!outputPath) {
    throw new Error("A target .pst path is required.");
  }

  const scriptPath = path.join(__dirname, "export-sent-items.ps1");
  return await runJsonCommand(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-OutputPath",
      outputPath,
      "-OverwriteExisting",
      overwriteExisting ? "true" : "false",
    ],
    {
      maxBuffer: 1024 * 1024,
    }
  );
});

app.whenReady().then(() => {
  app.setName("Exploitative Leadership Detection");

  if (process.platform === "win32") {
    app.setAppUserModelId("ExploitativeLeadershipDetection.Desktop");
  }

  createMainWindow();
  startReminderChecks();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
