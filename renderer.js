const isElectron = typeof require === "function" && typeof process !== "undefined" && Boolean(process?.versions?.electron);
const fs = isElectron ? require("fs") : null;
const path = isElectron ? require("path") : { basename: (p) => (p || "").split(/[\/\\]/).pop() };
const { ipcRenderer } = isElectron ? require("electron") : { ipcRenderer: null };
const analyzer = isElectron ? require("./analyzer") : null;
const exporter = isElectron ? require("./exporter") : null;

function filterEmailsByPeriod(emails, filters = {}) {
  const period = String(filters.period || "all");
  const now = new Date();
  return (emails || []).filter((email) => {
    if (period === "all") return true;
    if (!email.date) return false;
    const emailDate = new Date(email.date);
    if (period === "today") {
      return (
        emailDate.getFullYear() === now.getFullYear() &&
        emailDate.getMonth() === now.getMonth() &&
        emailDate.getDate() === now.getDate()
      );
    }
    const days = Number(period);
    if (!Number.isFinite(days) || days <= 0) return false;
    return (now.getTime() - emailDate.getTime()) / (1000 * 60 * 60 * 24) <= days;
  });
}

const LIVE_WARNING_MIN_CHARS = 50;
const LIVE_WARNING_DEBOUNCE_MS = 1500;
const LIVE_WARNING_COOLDOWN_MS = 8000;
const LIVE_WARNING_MIN_DELTA_CHARS = 20;
const LIVE_WARNING_AUTO_DISABLE_MS = 5 * 60 * 1000;
const UI_PREFERENCES_KEY = "toxicradar-ui-preferences";
const REPORT_METRICS = new Set(["count", "riskPercent"]);
const REPORT_CHART_TYPES = new Set(["bar", "line", "pie"]);
const APP_VIEWS = new Set(["overview", "compose", "reports"]);
const REPORT_PERIODS = new Set(["today", "7", "30", "90", "all"]);

const DIMENSION_SCORE_SERIES = [
  {
    key: "genuineEgoisticBehaviors",
    label: "Genuine Egoistic Behaviors",
    color: "#79acff",
  },
  { key: "takingCredit", label: "Taking Credit", color: "#3ecf8e" },
  { key: "exertingPressure", label: "Exerting Pressure", color: "#ff8c42" },
  {
    key: "underminingDevelopment",
    label: "Undermining Development",
    color: "#f0c04a",
  },
  { key: "manipulating", label: "Manipulating", color: "#ff4d4d" },
];

const state = {
  openaiApiKey: "",
  pstData: null,
  filteredEmails: [],
  results: [],
  activeView: "overview",
  composeLogPath: "",
  composeLogRowNumber: null,
  composeResult: null,
  dashboardSummary: {
    totalEmails: 0,
    positivePercent: 0,
    neutralPercent: 0,
    negativePercent: 0,
  },
  summarySort: {
    key: "date",
    direction: "desc",
  },
  summaryFilter: "all",
  reportChart: {
    metric: "count",
    type: "line",
    dayOffset: 0,
    monthOffset: 0,
    weekOffset: 0,
    yearOffset: 0,
    hiddenSeries: new Set(),
  },
  composeOriginalBody: "",
  composeRewriteApplied: false,
  liveWarningEnabled: false,
  liveWarningVisible: false,
  liveWarningMode: "live",
  liveWarningDismissedForText: "",
  liveWarningPhrases: [],
  liveWarningAnalysis: null,
  pendingRewriteAnalysis: null,
  pendingImproveText: "",
  lastLiveAnalysisText: "",
  lastLiveAnalysisAt: 0,
  isAnalyzing: false,
  isComposeAnalyzing: false,
  isLiveAnalyzing: false,
  isExporting: false,
  cancelRequested: false,
};

const elements = {};
let liveAnalysisDebounceId = null;
let liveWarningAutoDisableId = null;
let liveAnalysisRequestId = 0;
let excelWatcher = null;
let excelRefreshDebounceId = null;

function readUiPreferences() {
  try {
    return JSON.parse(localStorage.getItem(UI_PREFERENCES_KEY) || "{}");
  } catch (_error) {
    return {};
  }
}

function saveUiPreferences(updates = {}) {
  try {
    const currentPreferences = readUiPreferences();
    localStorage.setItem(
      UI_PREFERENCES_KEY,
      JSON.stringify({
        ...currentPreferences,
        ...updates,
      })
    );
  } catch (_error) {
  }
}

function applyUiPreferences() {
  const preferences = readUiPreferences();

  if (REPORT_METRICS.has(preferences.reportMetric)) {
    state.reportChart.metric = preferences.reportMetric;
    elements.reportMetricSelect.value = preferences.reportMetric;
  }

  if (REPORT_CHART_TYPES.has(preferences.reportChartType)) {
    state.reportChart.type = preferences.reportChartType;
    elements.reportChartTypeSelect.value = preferences.reportChartType;
  }
}

function getInitialViewPreference() {
  const preferences = readUiPreferences();
  const view = APP_VIEWS.has(preferences.activeView) ? preferences.activeView : "reports";
  const period = REPORT_PERIODS.has(preferences.reportPeriod) ? preferences.reportPeriod : "all";
  return { view, period };
}

function cacheDom() {
  elements.navButtons = Array.from(document.querySelectorAll(".nav-btn"));
  elements.overviewView = document.getElementById("overview-view");
  elements.composeView = document.getElementById("compose-view");
  elements.reportsView = document.getElementById("reports-view");
  elements.reportsTitle = document.getElementById("reports-title");
  elements.negativeSummary = document.getElementById("negative-summary");
  elements.neutralSummary = document.getElementById("neutral-summary");
  elements.positiveSummary = document.getElementById("positive-summary");
  elements.clearSummaryFilter = document.getElementById("clear-summary-filter");
  elements.emailSummaryTitle = document.getElementById("email-summary-title");
  elements.emailSummaryBody = document.getElementById("email-summary-body");
  elements.summarySortButtons = Array.from(document.querySelectorAll("[data-summary-sort]"));
  elements.openExcelBtn = document.getElementById("open-excel-btn");
  elements.chooseExcelBtn = document.getElementById("choose-excel-btn");
  elements.loadPstBtn = document.getElementById("load-pst-btn");
  elements.exportOutlookBtn = document.getElementById("export-outlook-btn");
  elements.periodSelect = document.getElementById("period-select");
  elements.analyzeBtn = document.getElementById("analyze-btn");
  elements.cancelBtn = document.getElementById("cancel-btn");
  elements.exportBtn = document.getElementById("export-btn");
  elements.settingsBtn = document.getElementById("settings-btn");
  elements.composeTo = document.getElementById("compose-to");
  elements.composeSubject = document.getElementById("compose-subject");
  elements.composeBody = document.getElementById("compose-body");
  elements.composeHighlightOverlay = document.getElementById("compose-highlight-overlay");
  elements.composeSendBtn = document.getElementById("compose-send-btn");
  elements.connectWatchBtn = document.getElementById("connect-watch-btn");
  elements.watchPairingCode = document.getElementById("watch-pairing-code");
  elements.biometricBadge = document.getElementById("biometric-badge");
  elements.bpmValue = document.getElementById("bpm-value");
  elements.stressLevelLabel = document.getElementById("stress-level-label");
  elements.composeUndoRewriteBtn = document.getElementById("compose-undo-rewrite-btn");
  elements.composeStatus = document.getElementById("compose-status");
  elements.liveWarningToggle = document.getElementById("live-warning-toggle");
  elements.liveWarningInfo = document.getElementById("live-warning-info");
  elements.liveWarningToggleLabel = document.getElementById("live-warning-toggle-label");
  elements.liveWarningBubble = document.getElementById("live-warning-bubble");
  elements.liveWarningText = document.getElementById("live-warning-text");
  elements.liveWarningQuestion = document.getElementById("live-warning-question");
  elements.liveWarningSuggestion = document.getElementById("live-warning-suggestion");
  elements.liveWarningYes = document.getElementById("live-warning-yes");
  elements.liveWarningNo = document.getElementById("live-warning-no");
  elements.composeResultCard = document.getElementById("compose-result-card");
  elements.composeResultEmpty = document.getElementById("compose-result-empty");
  elements.composeResultPanel = document.getElementById("compose-result-panel");
  elements.composeResultSubject = document.getElementById("compose-result-subject");
  elements.composeResultRecipient = document.getElementById("compose-result-recipient");
  elements.composeFlagBadge = document.getElementById("compose-flag-badge");
  elements.composeScoreBadge = document.getElementById("compose-score-badge");
  elements.composeResultNotes = document.getElementById("compose-result-notes");
  elements.composeDetailsBtn = document.getElementById("compose-details-btn");
  elements.composeLogPath = document.getElementById("compose-log-path");
  elements.pstPath = document.getElementById("pst-path");
  elements.emailCount = document.getElementById("email-count");
  elements.progressFill = document.getElementById("progress-fill");
  elements.progressText = document.getElementById("progress-text");
  elements.statusText = document.getElementById("status-text");
  elements.summaryText = document.getElementById("summary-text");
  elements.tableCaption = document.getElementById("table-caption");
  elements.resultsBody = document.getElementById("results-body");
  elements.reportsContent = document.getElementById("reports-content");
  elements.reportChartHeading = document.getElementById("report-chart-heading");
  elements.reportMetricSelect = document.getElementById("report-metric-select");
  elements.reportChartTypeSelect = document.getElementById("report-chart-type-select");
  elements.reportTotalCount = document.getElementById("report-total-count");
  elements.reportHighCount = document.getElementById("report-high-count");
  elements.reportNeutralCount = document.getElementById("report-neutral-count");
  elements.reportClearCount = document.getElementById("report-clear-count");
  elements.reportAxisTitle = document.getElementById("report-axis-title");
  elements.reportChartCaption = document.getElementById("report-chart-caption");
  elements.reportLegend = document.getElementById("report-legend");
  elements.reportChartWrap = document.getElementById("report-chart-wrap");
  elements.reportHistogram = document.getElementById("report-histogram");
  elements.reportChartEmpty = document.getElementById("report-chart-empty");
  elements.reportChartTooltip = document.getElementById("report-chart-tooltip");
  elements.dimensionScoreCard = document.getElementById("dimension-score-card");
  elements.dimensionScoreTitle = document.getElementById("dimension-score-title");
  elements.dimensionScoreCaption = document.getElementById("dimension-score-caption");
  elements.dimensionScoreLegend = document.getElementById("dimension-score-legend");
  elements.dimensionScoreWrap = document.getElementById("dimension-score-wrap");
  elements.dimensionScoreChart = document.getElementById("dimension-score-chart");
  elements.dimensionScoreEmpty = document.getElementById("dimension-score-empty");
  elements.dimensionScoreTooltip = document.getElementById("dimension-score-tooltip");
  elements.reportMonthNav = document.getElementById("report-month-nav");
  elements.reportPrevMonth = document.getElementById("report-prev-month");
  elements.reportNextMonth = document.getElementById("report-next-month");
  elements.reportMonthLabel = document.getElementById("report-month-label");
  elements.reportWeekNav = document.getElementById("report-week-nav");
  elements.reportPrevWeek = document.getElementById("report-prev-week");
  elements.reportNextWeek = document.getElementById("report-next-week");
  elements.reportWeekLabel = document.getElementById("report-week-label");
  elements.reportDayNav = document.getElementById("report-day-nav");
  elements.reportPrevDay = document.getElementById("report-prev-day");
  elements.reportNextDay = document.getElementById("report-next-day");
  elements.reportDayCalendarBtn = document.getElementById("report-day-calendar-btn");
  elements.reportDayLabel = document.getElementById("report-day-label");
  elements.reportDayPicker = document.getElementById("report-day-picker");
  elements.reportYearNav = document.getElementById("report-year-nav");
  elements.reportPrevYear = document.getElementById("report-prev-year");
  elements.reportNextYear = document.getElementById("report-next-year");
  elements.reportYearLabel = document.getElementById("report-year-label");
  elements.reportHistoryNav = document.getElementById("report-history-nav");
  elements.reportHistoryLabel = document.getElementById("report-history-label");
  elements.detailsModal = document.getElementById("details-modal");
  elements.modalTitle = document.getElementById("modal-title");
  elements.modalRecipients = document.getElementById("modal-recipients");
  elements.modalDate = document.getElementById("modal-date");
  elements.modalSender = document.getElementById("modal-sender");
  elements.modalTo = document.getElementById("modal-to");
  elements.modalDateFull = document.getElementById("modal-date-full");
  elements.modalSubjectFull = document.getElementById("modal-subject-full");
  elements.modalBodyFull = document.getElementById("modal-body-full");
  elements.modalDimensions = document.getElementById("modal-dimensions");
  elements.modalNotes = document.getElementById("modal-notes");
  elements.modalRewriteSection = document.getElementById("modal-rewrite-section");
  elements.modalRewrite = document.getElementById("modal-rewrite");
  elements.themeBtnDark = document.getElementById("theme-btn-dark");
  elements.themeBtnLight = document.getElementById("theme-btn-light");
  elements.settingsFeedback = document.getElementById("settings-feedback");
  elements.summaryMetricTooltip = document.createElement("div");
  elements.summaryMetricTooltip.className = "summary-metric-tooltip";
  document.body.appendChild(elements.summaryMetricTooltip);
}

function getSavedTheme() {
  return localStorage.getItem("toxicradar_theme") || "dark";
}

function applyTheme(theme) {
  const chosenTheme = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", chosenTheme);
  try {
    localStorage.setItem("toxicradar_theme", chosenTheme);
  } catch (_e) {}

  if (elements.themeBtnDark && elements.themeBtnLight) {
    if (chosenTheme === "dark") {
      elements.themeBtnDark.classList.add("active");
      elements.themeBtnLight.classList.remove("active");
    } else {
      elements.themeBtnLight.classList.add("active");
      elements.themeBtnDark.classList.remove("active");
    }
  }

  if (state.activeView === "reports" && typeof updateReportDashboard === "function") {
    updateReportDashboard();
  }
}

function getReportTitle(period) {
  switch (String(period || "")) {
    case "today":
      return "Daily Report";
    case "7":
      return "Weekly Report";
    case "30":
      return "Monthly Report";
    case "90":
      return "Yearly Report";
    case "all":
      return "Total History";
    default:
      return "Batch History";
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseJsonText(value) {
  return JSON.parse(String(value || "").replace(/^\uFEFF/, ""));
}

function isFileBusyError(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "");
  return (
    code === "EBUSY" ||
    code === "EPERM" ||
    /busy|locked|used by another process|resource busy/i.test(message)
  );
}

function formatExcelSaveError(error, fallback = "Excel could not be updated.") {
  if (isFileBusyError(error)) {
    return "The Excel file is currently open or locked. Please close it in Excel and try again.";
  }

  return fallback;
}

function sanitizeSuggestedRewrite(text) {
  if (!text) return "";

  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const cleanedLines = lines.filter((line) => {
    const trimmed = line.trim();

    if (/^subject\s*:/i.test(trimmed)) return false;
    if (/^\[(your name|name|sender name|your title|title)\]$/i.test(trimmed)) return false;
    if (/^<(your name|name|sender name|your title|title)>$/i.test(trimmed)) return false;

    return true;
  });

  return cleanedLines
    .join("\n")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSearchText(value) {
  return String(value || "")
    .replace(/['"\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F]/g, "")
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeToken(value) {
  return normalizeSearchText(value).replace(/[.,!?;:()[\]{}]/g, "");
}

function buildNormalizedIndexMap(text) {
  const source = String(text || "");
  let normalized = "";
  const map = [];
  let previousWasSpace = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    let normalizedCharacter = character;

    if (/['"\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F]/.test(character)) {
      continue;
    } else if (/[\u2013\u2014\u2212]/.test(character)) {
      normalizedCharacter = "-";
    } else if (character === "\u00A0") {
      normalizedCharacter = " ";
    }

    if (/\s/.test(normalizedCharacter)) {
      if (!normalized.length || previousWasSpace) {
        continue;
      }

      normalized += " ";
      map.push(index);
      previousWasSpace = true;
      continue;
    }

    normalized += normalizedCharacter.toLowerCase();
    map.push(index);
    previousWasSpace = false;
  }

  if (normalized.endsWith(" ")) {
    normalized = normalized.slice(0, -1);
    map.pop();
  }

  return { normalized, map };
}

function tokenizeSourceText(text) {
  const source = String(text || "");
  const tokens = [];
  const matcher = /\S+/g;
  let match;

  while ((match = matcher.exec(source)) !== null) {
    const raw = match[0];
    const normalized = normalizeToken(raw);
    if (!normalized) {
      continue;
    }

    tokens.push({
      raw,
      normalized,
      start: match.index,
      end: match.index + raw.length,
    });
  }

  return tokens;
}

function tokenizePhraseText(text) {
  return String(text || "")
    .split(/\s+/)
    .map((part) => normalizeToken(part))
    .filter(Boolean);
}

function levenshteinDistance(left, right) {
  const a = String(left || "");
  const b = String(right || "");

  if (a === b) {
    return 0;
  }

  if (!a.length) {
    return b.length;
  }

  if (!b.length) {
    return a.length;
  }

  const matrix = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));

  for (let i = 0; i <= a.length; i += 1) {
    matrix[i][0] = i;
  }

  for (let j = 0; j <= b.length; j += 1) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[a.length][b.length];
}

function tokenSimilarity(left, right) {
  const a = String(left || "");
  const b = String(right || "");

  if (!a || !b) {
    return 0;
  }

  if (a === b) {
    return 1;
  }

  if ((a.startsWith(b) || b.startsWith(a)) && Math.min(a.length, b.length) >= 4) {
    return 0.92;
  }

  const distance = levenshteinDistance(a, b);
  const maxLength = Math.max(a.length, b.length);
  return Math.max(0, 1 - distance / maxLength);
}

function findApproximatePhraseRange(sourceText, phraseText, allocatedRanges) {
  const sourceTokens = tokenizeSourceText(sourceText);
  const phraseTokens = tokenizePhraseText(phraseText);

  if (!sourceTokens.length || !phraseTokens.length) {
    return null;
  }

  let bestMatch = null;
  const minWindow = Math.max(1, phraseTokens.length - 2);
  const maxWindow = Math.min(sourceTokens.length, phraseTokens.length + 2);

  for (let windowSize = minWindow; windowSize <= maxWindow; windowSize += 1) {
    for (let start = 0; start <= sourceTokens.length - windowSize; start += 1) {
      const windowTokens = sourceTokens.slice(start, start + windowSize);
      const windowStart = windowTokens[0].start;
      const windowEnd = windowTokens[windowTokens.length - 1].end;

      const overlapsExisting = allocatedRanges.some(
        (range) => windowStart < range.end && windowEnd > range.start
      );
      if (overlapsExisting) {
        continue;
      }

      const maxLength = Math.max(phraseTokens.length, windowTokens.length);
      let scoreSum = 0;

      for (let index = 0; index < maxLength; index += 1) {
        const phraseToken = phraseTokens[index];
        const sourceToken = windowTokens[index]?.normalized;

        if (!phraseToken || !sourceToken) {
          scoreSum -= 0.35;
          continue;
        }

        scoreSum += tokenSimilarity(phraseToken, sourceToken);
      }

      const averageScore = scoreSum / maxLength;
      if (!bestMatch || averageScore > bestMatch.score) {
        bestMatch = {
          start: windowStart,
          end: windowEnd,
          score: averageScore,
        };
      }
    }
  }

  if (bestMatch && bestMatch.score >= 0.74) {
    return bestMatch;
  }

  return null;
}

function extractEvidencePhrasesFromDimensions(dimensions) {
  const phrases = [];
  let marker = 1;

  for (let index = 0; index < (dimensions || []).length; index += 1) {
    const dimension = dimensions[index];
    const evidence = String(dimension?.evidence || "").trim();
    const directEvidencePhrases = Array.isArray(dimension?.evidencePhrases)
      ? dimension.evidencePhrases
      : [];
    const quotedMatches = evidence ? [...evidence.matchAll(/"([^"]+)"/g)].map((match) => match[1]) : [];
    const bracketMatches = evidence ? [...evidence.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]) : [];
    const seen = new Set();
    const evidencePhrases = [...directEvidencePhrases, ...quotedMatches, ...bracketMatches]
      .map((rawPhrase) => String(rawPhrase || "").trim())
      .filter((phrase) => {
        const key = normalizeSearchText(phrase);
        if (phrase.length < 3 || !key || seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });

    for (const phrase of evidencePhrases) {
      phrases.push({
        marker,
        text: phrase,
        score: Math.max(1, Math.min(5, Number(dimension?.score) || 1)),
        category: String(dimension?.name || "Exploitative leadership"),
      });
      marker += 1;
    }
  }

  return phrases;
}

function extractCriticalPhrases(item) {
  return extractEvidencePhrasesFromDimensions(item?.analysis?.dimensions || []);
}

function extractLiveWarningPhrases(analysis) {
  return extractEvidencePhrasesFromDimensions(getLiveWarningDimensions(analysis));
}

function getHighlightTone(score) {
  if (score >= 5) {
    return "critical-red";
  }

  if (score >= 4) {
    return "critical-orange";
  }

  if (score >= 3) {
    return "critical-yellow";
  }

  return "critical-neutral";
}

function buildHighlightRanges(text, phrases) {
  const source = String(text || "");
  const indexedSource = buildNormalizedIndexMap(source);
  const ranges = [];
  const allocatedRanges = [];

  const sortedPhrases = [...phrases].sort((left, right) => {
    const lengthDifference = right.text.length - left.text.length;
    if (lengthDifference !== 0) {
      return lengthDifference;
    }
    return left.marker - right.marker;
  });

  for (const phrase of sortedPhrases) {
    const normalizedPhrase = normalizeSearchText(phrase.text);
    if (!normalizedPhrase) {
      continue;
    }

    let startIndex = 0;
    let chosenRange = null;
    while (startIndex < indexedSource.normalized.length) {
      const foundAt = indexedSource.normalized.indexOf(normalizedPhrase, startIndex);
      if (foundAt === -1) {
        break;
      }

      const originalStart = indexedSource.map[foundAt];
      const originalEnd =
        indexedSource.map[foundAt + normalizedPhrase.length - 1] + 1;

      if (originalStart == null || originalEnd == null) {
        startIndex = foundAt + normalizedPhrase.length;
        continue;
      }

      const overlapsExisting = allocatedRanges.some(
        (range) => originalStart < range.end && originalEnd > range.start
      );

      if (!overlapsExisting) {
        chosenRange = {
          start: originalStart,
          end: originalEnd,
          score: phrase.score,
          tone: getHighlightTone(phrase.score),
          marker: phrase.marker,
        };
        break;
      }

      startIndex = foundAt + normalizedPhrase.length;
    }

    if (!chosenRange) {
      const approximateRange = findApproximatePhraseRange(source, phrase.text, allocatedRanges);
      if (approximateRange) {
        chosenRange = {
          start: approximateRange.start,
          end: approximateRange.end,
          score: phrase.score,
          tone: getHighlightTone(phrase.score),
          marker: phrase.marker,
        };
      }
    }

    if (chosenRange) {
      allocatedRanges.push(chosenRange);
      ranges.push(chosenRange);
    }
  }

  ranges.sort((left, right) => {
    if (left.start !== right.start) {
      return left.start - right.start;
    }
    return left.marker - right.marker;
  });

  return ranges;
}

function renderLiveWarningHighlightedText(text, phrases) {
  const source = String(text || "");
  if (!source) {
    return "";
  }

  const ranges = buildHighlightRanges(source, phrases);
  if (!ranges.length) {
    return escapeHtml(source);
  }

  let cursor = 0;
  let html = "";

  for (const range of ranges) {
    const phrase = phrases.find((item) => item.marker === range.marker) || {};
    const category = phrase.category || "Exploitative leadership";

    if (cursor < range.start) {
      html += escapeHtml(source.slice(cursor, range.start));
    }

    html += `<mark class="compose-live-highlight ${range.tone}" data-live-category="${escapeHtml(
      category
    )}" data-live-score="${escapeHtml(range.score)}">${escapeHtml(
      source.slice(range.start, range.end)
    )}</mark>`;
    cursor = range.end;
  }

  if (cursor < source.length) {
    html += escapeHtml(source.slice(cursor));
  }

  return html;
}

function clearComposeHighlights() {
  state.liveWarningPhrases = [];

  if (!elements.composeHighlightOverlay || !elements.composeBody) {
    return;
  }

  elements.composeHighlightOverlay.innerHTML = "";
  elements.composeHighlightOverlay.classList.add("hidden");
  elements.composeBody.classList.remove("has-live-highlights");
}

function syncComposeHighlightScroll() {
  if (!elements.composeHighlightOverlay || !elements.composeBody) {
    return;
  }

  elements.composeHighlightOverlay.scrollTop = elements.composeBody.scrollTop;
  elements.composeHighlightOverlay.scrollLeft = elements.composeBody.scrollLeft;
}

function renderComposeHighlightPhrases(text, phrases) {
  if (!elements.composeHighlightOverlay || !elements.composeBody) {
    return;
  }

  if (!phrases.length) {
    clearComposeHighlights();
    return;
  }

  const ranges = buildHighlightRanges(text, phrases);
  if (!ranges.length) {
    clearComposeHighlights();
    return;
  }

  const activeMarkers = new Set(ranges.map((range) => range.marker));
  const activePhrases = phrases.filter((phrase) => activeMarkers.has(phrase.marker));
  state.liveWarningPhrases = activePhrases;
  elements.composeHighlightOverlay.innerHTML = renderLiveWarningHighlightedText(text, activePhrases);
  elements.composeHighlightOverlay.classList.remove("hidden");
  elements.composeBody.classList.add("has-live-highlights");
  syncComposeHighlightScroll();
}

function refreshComposeHighlightsFromCurrentText() {
  if (!state.liveWarningPhrases.length) {
    return;
  }

  renderComposeHighlightPhrases(elements.composeBody.value, state.liveWarningPhrases);
}

function renderComposeHighlights(analysis, text) {
  renderComposeHighlightPhrases(text, extractLiveWarningPhrases(analysis));
}

function getComposeHighlightAtPoint(clientX, clientY) {
  if (!elements.composeHighlightOverlay || elements.composeHighlightOverlay.classList.contains("hidden")) {
    return null;
  }

  const highlights = elements.composeHighlightOverlay.querySelectorAll(".compose-live-highlight");
  for (const highlight of highlights) {
    for (const rect of highlight.getClientRects()) {
      if (
        clientX >= rect.left - 2 &&
        clientX <= rect.right + 2 &&
        clientY >= rect.top - 2 &&
        clientY <= rect.bottom + 2
      ) {
        return highlight;
      }
    }
  }

  return null;
}

function showComposeHighlightTooltipAtPoint(event) {
  const highlight = getComposeHighlightAtPoint(event.clientX, event.clientY);
  if (!highlight) {
    hideTooltip();
    return;
  }

  const category = highlight.dataset.liveCategory || "Exploitative leadership";
  const score = highlight.dataset.liveScore || "?";
  showTooltip(`${category} - Score ${score}`, event);
}

function renderEvidenceWithMarker(dimension, marker) {
  const score = Math.max(1, Math.min(5, Number(dimension?.score) || 1));
  const tone = getHighlightTone(score);
  const evidence = String(dimension?.evidence || "No evidence provided.");
  const highlightedEvidence = escapeHtml(evidence).replace(
    /(&quot;.*?&quot;|\[[^\]]+\])/g,
    (match) => `<mark class="critical-highlight ${tone}">${match}</mark>`
  );

  return `
    <div class="evidence-with-marker">
      <span>${highlightedEvidence}</span>
    </div>
  `;
}

function renderHighlightedText(text, phrases) {
  const source = String(text || "");
  if (!source) {
    return "(No message body)";
  }

  if (!phrases.length) {
    return escapeHtml(source);
  }

  const ranges = buildHighlightRanges(source, phrases);
  if (!ranges.length) {
    return escapeHtml(source);
  }

  let cursor = 0;
  let html = "";

  for (const range of ranges) {
    const phrase = phrases.find((item) => item.marker === range.marker) || {};
    const category = phrase.category || "Exploitative leadership";

    if (cursor < range.start) {
      html += escapeHtml(source.slice(cursor, range.start));
    }

    html += `<mark class="critical-highlight ${range.tone}" title="${escapeHtml(
      `${category} - Score ${range.score}`
    )}">${escapeHtml(
      source.slice(range.start, range.end)
    )}</mark>`;
    cursor = range.end;
  }

  if (cursor < source.length) {
    html += escapeHtml(source.slice(cursor));
  }

  return html;
}

function formatDate(value) {
  if (!value) return "No date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No date";

  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function parseSummaryDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getReportPeriodConfig(period) {
  switch (String(period || "all")) {
    case "today":
      return {
        title: "Daily Report",
        bucketLabel: "hour",
        axisLabel: "Messages by hour",
        filterStart: null,
        buildBuckets: buildDailyBuckets,
      };
    case "7":
      return {
        title: "Weekly Report",
        bucketLabel: "day",
        axisLabel: "Messages by day",
        filterStart: null,
        buildBuckets: buildRollingDayBuckets,
      };
    case "30":
      return {
        title: "Monthly Report",
        bucketLabel: "day",
        axisLabel: "Messages by day",
        filterStart: null,
        buildBuckets: buildCalendarMonthBuckets,
      };
    case "90":
      return {
        title: "Yearly Report",
        bucketLabel: "month",
        axisLabel: "Messages by month",
        filterStart: null,
        buildBuckets: buildCalendarYearBuckets,
      };
    case "all":
    default:
      return {
        title: "Total History",
        bucketLabel: "month",
        axisLabel: "All messages by month",
        filterStart: null,
        buildBuckets: buildAllMessageBuckets,
      };
  }
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function startOfYear(date) {
  return new Date(date.getFullYear(), 0, 1);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addMonths(date, months) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function endOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

function endOfYear(date) {
  return new Date(date.getFullYear(), 11, 31, 23, 59, 59, 999);
}

function formatShortMonth(date) {
  return new Intl.DateTimeFormat("en-US", { month: "short" }).format(date);
}

function formatMonthYear(date) {
  return new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit" }).format(date);
}

function formatDateRangeLabel(startDate, endDate) {
  const sameYear = startDate.getFullYear() === endDate.getFullYear();
  const startFormat = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
  const endFormat = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${startFormat.format(startDate)} - ${endFormat.format(endDate)}`;
}

function formatLocalDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function parseDateInputValue(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatLocalMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function getReportScore(row) {
  const highestScore = toSummaryNumber(row.highestScore);
  const overallToxicity = toSummaryNumber(row.overallToxicity);
  return highestScore != null ? highestScore : overallToxicity != null ? overallToxicity : 0;
}

function getReportSeriesKey(score) {
  if (score > 3) return "high";
  if (score === 3) return "neutral";
  return "clear";
}

function getDimensionScore(row, series) {
  const directScore = toSummaryNumber(row?.[series.key]);
  if (directScore != null) {
    return Math.max(1, Math.min(5, directScore));
  }

  const dimensions = Array.isArray(row?.dimensions) ? row.dimensions : [];
  const dimension = dimensions.find((item) => String(item?.name || "") === series.label);
  const dimensionScore = toSummaryNumber(dimension?.score);
  return dimensionScore != null ? Math.max(1, Math.min(5, dimensionScore)) : 1;
}

function getVisibleReportRows(rows) {
  return [...rows].sort((left, right) => {
    const leftDate = parseSummaryDate(left.date);
    const rightDate = parseSummaryDate(right.date);
    const leftTime = leftDate ? leftDate.getTime() : 0;
    const rightTime = rightDate ? rightDate.getTime() : 0;
    return leftTime - rightTime;
  });
}

function getRowImprovementScore(row) {
  const dimensionScores = DIMENSION_SCORE_SERIES
    .map((series) => getDimensionScore(row, series))
    .filter((score) => Number.isFinite(score));
  const dimensionToxicityScore = dimensionScores.length
    ? dimensionScores.reduce((sum, score) => sum + score, 0) / dimensionScores.length
    : getReportScore(row) || 1;
  const communicationQualityScore =
    ((5 - Math.max(1, Math.min(5, dimensionToxicityScore))) / 4) * 100;
  return Math.max(0, Math.min(100, Math.round(communicationQualityScore)));
}

function buildImprovementBuckets(rows) {
  const datedRows = [...rows]
    .map((row) => ({ row, date: parseSummaryDate(row.date) }))
    .filter((item) => item.date)
    .sort((left, right) => left.date - right.date);

  if (!datedRows.length) {
    return [];
  }

  const firstDate = datedRows[0].date;
  const lastDate = datedRows[datedRows.length - 1].date;
  const daySpan = Math.max(1, Math.ceil((startOfDay(lastDate) - startOfDay(firstDate)) / (24 * 60 * 60 * 1000)));
  const useDailyBuckets = daySpan <= 45;
  const bucketMap = new Map();

  for (const item of datedRows) {
    const bucketDate = useDailyBuckets ? startOfDay(item.date) : startOfMonth(item.date);
    const key = useDailyBuckets ? formatLocalDateKey(bucketDate) : formatLocalMonthKey(bucketDate);
    if (!bucketMap.has(key)) {
      bucketMap.set(key, {
        key,
        label: useDailyBuckets
          ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(bucketDate)
          : formatMonthYear(bucketDate),
        sortValue: bucketDate.getTime(),
        totalImprovement: 0,
        count: 0,
        flagged: false,
      });
    }

    const bucket = bucketMap.get(key);
    bucket.totalImprovement += getRowImprovementScore(item.row);
    bucket.count += 1;
    bucket.flagged = bucket.flagged || Boolean(item.row.overallFlag);
  }

  return Array.from(bucketMap.values())
    .sort((left, right) => left.sortValue - right.sortValue)
    .map((bucket) => ({
      ...bucket,
      improvement: bucket.count ? Math.round(bucket.totalImprovement / bucket.count) : 0,
    }));
}

function getLatestReportDate(rows) {
  return rows.reduce((latestDate, row) => {
    const date = parseSummaryDate(row.date);
    if (!date) return latestDate;
    return !latestDate || date > latestDate ? date : latestDate;
  }, null);
}

function getEarliestReportDate(rows) {
  return rows.reduce((earliestDate, row) => {
    const date = parseSummaryDate(row.date);
    if (!date) return earliestDate;
    return !earliestDate || date < earliestDate ? date : earliestDate;
  }, null);
}

function getMonthDistance(startDate, endDate) {
  return (
    (endDate.getFullYear() - startDate.getFullYear()) * 12 +
    endDate.getMonth() -
    startDate.getMonth()
  );
}

function getDayDistance(startDate, endDate) {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.floor((startOfDay(endDate) - startOfDay(startDate)) / millisecondsPerDay));
}

function getYearDistance(startDate, endDate) {
  return Math.max(0, endDate.getFullYear() - startDate.getFullYear());
}

function createReportBucket(key, label, sortValue) {
  return {
    key,
    label,
    sortValue,
    clear: 0,
    neutral: 0,
    high: 0,
    totalScore: 0,
    scoredCount: 0,
  };
}

function addRowToBucket(bucket, row) {
  const score = getReportScore(row);
  bucket[getReportSeriesKey(score)] += 1;
  if (score > 0) {
    bucket.totalScore += score;
    bucket.scoredCount += 1;
  }
}

function getBucketTotal(bucket) {
  return bucket.clear + bucket.neutral + bucket.high;
}

function getBucketMetricValue(bucket, metric) {
  const total = getBucketTotal(bucket);
  if (metric === "riskPercent") {
    return total ? Math.round((bucket.high / total) * 100) : 0;
  }
  return total;
}

function buildDailyBuckets(rows) {
  const buckets = Array.from({ length: 25 }, (_, hour) =>
    createReportBucket(String(hour), String(hour), hour)
  );

  for (const row of rows) {
    const date = parseSummaryDate(row.date);
    if (!date) continue;
    addRowToBucket(buckets[date.getHours()], row);
  }

  return buckets;
}

function buildRollingDayBuckets(rows, config) {
  const start = config.filterStart || startOfDay(new Date());
  const dayCount = String(elements.periodSelect.value) === "7" ? 7 : 30;
  const buckets = [];
  const bucketMap = new Map();

  for (let index = 0; index < dayCount; index += 1) {
    const date = addDays(start, index);
    const key = formatLocalDateKey(date);
    const label = dayCount === 7
      ? `${date.getDate()}|${new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date)}`
      : String(date.getDate());
    const bucket = createReportBucket(key, label, date.getTime());
    buckets.push(bucket);
    bucketMap.set(key, bucket);
  }

  for (const row of rows) {
    const date = parseSummaryDate(row.date);
    if (!date) continue;
    const key = formatLocalDateKey(startOfDay(date));
    const bucket = bucketMap.get(key);
    if (bucket) addRowToBucket(bucket, row);
  }

  return buckets;
}

function buildCalendarMonthBuckets(rows, config) {
  const start = config.filterStart || startOfMonth(new Date());
  const lastDay = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  const buckets = [];
  const bucketMap = new Map();

  for (let day = 1; day <= lastDay; day += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), day);
    const key = formatLocalDateKey(date);
    const bucket = createReportBucket(key, String(day), date.getTime());
    buckets.push(bucket);
    bucketMap.set(key, bucket);
  }

  for (const row of rows) {
    const date = parseSummaryDate(row.date);
    if (!date) continue;
    const key = formatLocalDateKey(startOfDay(date));
    const bucket = bucketMap.get(key);
    if (bucket) addRowToBucket(bucket, row);
  }

  return buckets;
}

function buildRollingMonthBuckets(rows, config) {
  const start = config.filterStart || addMonths(startOfMonth(new Date()), -11);
  const buckets = [];
  const bucketMap = new Map();

  for (let index = 0; index < 12; index += 1) {
    const date = addMonths(start, index);
    const key = formatLocalMonthKey(date);
    const bucket = createReportBucket(key, formatShortMonth(date), date.getTime());
    buckets.push(bucket);
    bucketMap.set(key, bucket);
  }

  for (const row of rows) {
    const date = parseSummaryDate(row.date);
    if (!date) continue;
    const month = startOfMonth(date);
    const key = formatLocalMonthKey(month);
    const bucket = bucketMap.get(key);
    if (bucket) addRowToBucket(bucket, row);
  }

  return buckets;
}

function buildCalendarYearBuckets(rows, config) {
  const start = config.filterStart || startOfYear(new Date());
  const buckets = [];
  const bucketMap = new Map();

  for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
    const date = new Date(start.getFullYear(), monthIndex, 1);
    const key = formatLocalMonthKey(date);
    const bucket = createReportBucket(key, formatShortMonth(date), date.getTime());
    buckets.push(bucket);
    bucketMap.set(key, bucket);
  }

  for (const row of rows) {
    const date = parseSummaryDate(row.date);
    if (!date) continue;
    const month = startOfMonth(date);
    const key = formatLocalMonthKey(month);
    const bucket = bucketMap.get(key);
    if (bucket) addRowToBucket(bucket, row);
  }

  return buckets;
}

function buildAllMessageBuckets(rows) {
  const bucketMap = new Map();

  for (const row of rows) {
    const date = parseSummaryDate(row.date);
    if (!date) continue;
    const month = startOfMonth(date);
    const key = formatLocalMonthKey(month);

    if (!bucketMap.has(key)) {
      bucketMap.set(key, createReportBucket(key, formatMonthYear(month), month.getTime()));
    }

    addRowToBucket(bucketMap.get(key), row);
  }

  return Array.from(bucketMap.values()).sort((left, right) => left.sortValue - right.sortValue);
}

function getReportRowsForPeriod(period) {
  const rows = state.dashboardSummary.emails || [];
  const config = getReportPeriodConfig(period);
  const anchorDate = getLatestReportDate(rows) || new Date();
  const earliestDate = getEarliestReportDate(rows);
  config.anchorDate = anchorDate;
  config.earliestDate = earliestDate;

  if (String(period || "all") === "today") {
    const requestedOffset = Number(state.reportChart.dayOffset) || 0;
    const maxPastOffset = earliestDate ? getDayDistance(earliestDate, anchorDate) : 0;
    state.reportChart.dayOffset = Math.min(Math.max(0, requestedOffset), maxPastOffset);
    const selectedDay = addDays(startOfDay(anchorDate), -state.reportChart.dayOffset);
    config.filterStart = selectedDay;
    config.filterEnd = new Date(selectedDay.getFullYear(), selectedDay.getMonth(), selectedDay.getDate(), 23, 59, 59, 999);
    config.selectedDay = config.filterStart;
    config.maxPastDayOffset = maxPastOffset;
  } else if (String(period || "all") === "7") {
    const requestedOffset = Number(state.reportChart.weekOffset) || 0;
    const maxPastOffset = earliestDate
      ? Math.max(0, Math.ceil((startOfDay(anchorDate) - startOfDay(earliestDate)) / (7 * 24 * 60 * 60 * 1000)))
      : 0;
    state.reportChart.weekOffset = Math.min(Math.max(0, requestedOffset), maxPastOffset);
    const selectedEnd = addDays(startOfDay(anchorDate), -state.reportChart.weekOffset * 7);
    config.filterStart = addDays(selectedEnd, -6);
    config.filterEnd = new Date(selectedEnd.getFullYear(), selectedEnd.getMonth(), selectedEnd.getDate(), 23, 59, 59, 999);
    config.selectedWeekStart = config.filterStart;
    config.selectedWeekEnd = selectedEnd;
    config.maxPastWeekOffset = maxPastOffset;
  } else if (String(period || "all") === "30") {
    const requestedOffset = Number(state.reportChart.monthOffset) || 0;
    const maxPastOffset = earliestDate
      ? Math.max(0, getMonthDistance(startOfMonth(earliestDate), startOfMonth(anchorDate)))
      : 0;
    state.reportChart.monthOffset = Math.min(Math.max(0, requestedOffset), maxPastOffset);
    const selectedMonth = addMonths(startOfMonth(anchorDate), -state.reportChart.monthOffset);
    config.filterStart = selectedMonth;
    config.filterEnd = endOfMonth(selectedMonth);
    config.selectedMonth = selectedMonth;
    config.maxPastOffset = maxPastOffset;
  } else if (String(period || "all") === "90") {
    const requestedOffset = Number(state.reportChart.yearOffset) || 0;
    const maxPastOffset = earliestDate ? getYearDistance(earliestDate, anchorDate) : 0;
    state.reportChart.yearOffset = Math.min(Math.max(0, requestedOffset), maxPastOffset);
    const selectedYearDate = new Date(anchorDate.getFullYear() - state.reportChart.yearOffset, 0, 1);
    config.filterStart = startOfYear(selectedYearDate);
    config.filterEnd = endOfYear(selectedYearDate);
    config.selectedYear = selectedYearDate.getFullYear();
    config.maxPastYearOffset = maxPastOffset;
  } else if (String(period || "all") === "all") {
    config.historyStart = earliestDate ? startOfDay(earliestDate) : null;
    config.historyEnd = anchorDate ? startOfDay(anchorDate) : null;
  }

  const filteredRows = config.filterStart
    ? rows.filter((row) => {
        const date = parseSummaryDate(row.date);
        const filterEnd = config.filterEnd || anchorDate;
        return date && date >= config.filterStart && date <= filterEnd;
      })
    : rows.filter((row) => parseSummaryDate(row.date));

  return {
    config,
    rows: filteredRows,
    buckets: config.buildBuckets(filteredRows, config),
  };
}

function getVisibleReportBuckets(buckets) {
  return buckets;
}

function formatReportMetricValue(value, metric) {
  if (metric === "riskPercent") return `${Math.round(value)}%`;
  return String(Math.round(value));
}

function getReportXAxisTitle(period) {
  switch (String(period || "all")) {
    case "today":
      return "Hour";
    case "7":
    case "30":
      return "Day";
    case "90":
    case "all":
      return "Month";
    default:
      return "Time";
  }
}

function renderReportXAxisLabel(label, x, y) {
  const parts = String(label || "").split("|");
  if (parts.length === 1) {
    return `<text class="report-x-label" x="${x}" y="${y}" text-anchor="middle">${escapeHtml(parts[0])}</text>`;
  }

  return `
    <text class="report-x-label" x="${x}" y="${y - 12}" text-anchor="middle">${escapeHtml(parts[0])}</text>
    <text class="report-x-label" x="${x}" y="${y + 6}" text-anchor="middle">${escapeHtml(parts[1])}</text>
  `;
}

function getReportYAxisTicks(yMax, metric) {
  if (metric === "dimensionScores") {
    return [1, 2, 3, 4, 5];
  }

  if (metric === "count") {
    return Array.from({ length: yMax + 1 }, (_, index) => index);
  }

  return [0, 25, 50, 75, 100];
}

function getReportLegendSeries() {
  if (state.reportChart.metric === "dimensionScores") {
    return DIMENSION_SCORE_SERIES;
  }

  return [
    { key: "clear", label: "Positive", color: "#3ecf8e" },
    { key: "neutral", label: "Neutral", color: "#f0c04a" },
    { key: "high", label: "Negative", color: "#ff4d4d" },
  ];
}

function renderReportLegend() {
  const series = getReportLegendSeries();
  elements.reportLegend.innerHTML = series
    .map((item) => {
      const inactive = state.reportChart.hiddenSeries.has(item.key);
      return `
        <button class="report-legend-item ${inactive ? "inactive" : ""}" type="button" data-report-series="${item.key}" aria-pressed="${inactive ? "false" : "true"}">
          <span class="report-legend-swatch" style="background:${item.color}"></span>
          <span>${escapeHtml(item.label)}</span>
        </button>
      `;
    })
    .join("");
}

function getReportBarSegments(bucket, metric) {
  if (metric !== "count") {
    const value = getBucketMetricValue(bucket, metric);
    return [{
      key: metric,
      label: "High Risk %",
      value,
      color: "#ff4d4d",
    }];
  }

  return [
    { key: "clear", label: "Positive", color: "#3ecf8e" },
    { key: "neutral", label: "Neutral", color: "#f0c04a" },
    { key: "high", label: "Negative", color: "#ff4d4d" },
  ]
    .map((series) => ({
      ...series,
      value: bucket[series.key],
    }))
    .filter((segment) => !state.reportChart.hiddenSeries.has(segment.key));
}

function showReportChartTooltip(event, bucket, metric) {
  const total = getBucketTotal(bucket);
  elements.reportChartTooltip.innerHTML = `
    <strong>${escapeHtml(bucket.label)}</strong>
    <span>Total: ${total}</span>
    <span>Positive: ${bucket.clear}</span>
    <span>Neutral: ${bucket.neutral}</span>
    <span>Negative: ${bucket.high}</span>
    <span>High Risk %: ${total ? Math.round((bucket.high / total) * 100) : 0}%</span>
  `;
  const chartRect = elements.reportChartWrap.getBoundingClientRect();
  elements.reportChartTooltip.style.left = `${event.clientX - chartRect.left + 14}px`;
  elements.reportChartTooltip.style.top = `${event.clientY - chartRect.top + 14}px`;
  elements.reportChartTooltip.classList.add("visible");
}

function hideReportChartTooltip() {
  elements.reportChartTooltip.classList.remove("visible");
}

function showDimensionChartTooltip(event, bucket) {
  elements.dimensionScoreTooltip.innerHTML = `
    <strong>${escapeHtml(bucket.label)}</strong>
    <span>Communication Quality: ${bucket.improvement}%</span>
    <span>Messages: ${bucket.count}</span>
  `;
  const chartRect = elements.dimensionScoreWrap.getBoundingClientRect();
  elements.dimensionScoreTooltip.style.left = `${event.clientX - chartRect.left + 14}px`;
  elements.dimensionScoreTooltip.style.top = `${event.clientY - chartRect.top + 14}px`;
  elements.dimensionScoreTooltip.classList.add("visible");
}

function hideDimensionChartTooltip() {
  elements.dimensionScoreTooltip.classList.remove("visible");
}

function openReportDayPicker() {
  if (typeof elements.reportDayPicker.showPicker === "function") {
    elements.reportDayPicker.showPicker();
  } else {
    elements.reportDayPicker.focus();
    elements.reportDayPicker.click();
  }
}

function describeArcPath(centerX, centerY, radius, startAngle, endAngle) {
  const start = {
    x: centerX + radius * Math.cos(startAngle),
    y: centerY + radius * Math.sin(startAngle),
  };
  const end = {
    x: centerX + radius * Math.cos(endAngle),
    y: centerY + radius * Math.sin(endAngle),
  };
  const largeArcFlag = endAngle - startAngle > Math.PI ? 1 : 0;

  return [
    `M ${centerX} ${centerY}`,
    `L ${start.x} ${start.y}`,
    `A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`,
    "Z",
  ].join(" ");
}

function renderReportPieChart(rows) {
  const svgWidth = 960;
  const svgHeight = 390;
  const centerX = 350;
  const centerY = 195;
  const radius = 126;
  const high = rows.filter((row) => getReportScore(row) > 3).length;
  const neutral = rows.filter((row) => getReportScore(row) === 3).length;
  const clear = Math.max(0, rows.length - high - neutral);
  const total = clear + high;

  if (!total) {
    elements.reportHistogram.setAttribute("viewBox", `0 0 ${svgWidth} ${svgHeight}`);
    elements.reportHistogram.innerHTML = "";
    return;
  }

  const slices = [
    { key: "clear", label: "Positive", color: "#3ecf8e" },
    { key: "neutral", label: "Neutral", color: "#f0c04a" },
    { key: "high", label: "Negative", color: "#ff4d4d" },
  ]
    .map((series) => ({
      ...series,
      value: series.key === "clear" ? clear : series.key === "neutral" ? neutral : high,
    }))
    .filter((slice) => slice.value > 0 && !state.reportChart.hiddenSeries.has(slice.key));
  const visibleTotal = slices.reduce((sum, slice) => sum + slice.value, 0);
  let currentAngle = -Math.PI / 2;

  const sliceHtml = slices.map((slice, index) => {
    const angleSize = (slice.value / visibleTotal) * Math.PI * 2;
    const startAngle = currentAngle;
    const endAngle = currentAngle + angleSize;
    currentAngle = endAngle;
    const percentage = Math.round((slice.value / total) * 100);
    const midAngle = startAngle + angleSize / 2;
    const labelX = centerX + (radius + 46) * Math.cos(midAngle);
    const labelY = centerY + (radius + 46) * Math.sin(midAngle);
    const path = visibleTotal === slice.value
      ? `<circle class="report-pie-slice" cx="${centerX}" cy="${centerY}" r="${radius}" fill="${slice.color}" data-report-pie="${index}"></circle>`
      : `<path class="report-pie-slice" d="${describeArcPath(centerX, centerY, radius, startAngle, endAngle)}" fill="${slice.color}" data-report-pie="${index}"></path>`;

    return `
      ${path}
      <text class="report-pie-label" x="${labelX}" y="${labelY}" text-anchor="middle">${escapeHtml(slice.label)} ${percentage}%</text>
    `;
  }).join("");

  const legendHtml = `
    <text class="report-pie-total" x="610" y="165">Total ${total}</text>
    <text class="report-pie-meta" x="610" y="205">Positive ${clear}</text>
    <text class="report-pie-meta" x="610" y="235">Neutral ${neutral}</text>
    <text class="report-pie-meta" x="610" y="265">Negative ${high}</text>
  `;

  elements.reportHistogram.setAttribute("viewBox", `0 0 ${svgWidth} ${svgHeight}`);
  elements.reportHistogram.innerHTML = `${sliceHtml}${legendHtml}`;

  elements.reportHistogram.querySelectorAll("[data-report-pie]").forEach((target) => {
    target.addEventListener("mousemove", (event) => {
      const slice = slices[Number(target.getAttribute("data-report-pie"))];
      elements.reportChartTooltip.innerHTML = `
        <strong>${escapeHtml(slice.label)}</strong>
        <span>Messages: ${slice.value}</span>
        <span>Share: ${Math.round((slice.value / total) * 100)}%</span>
      `;
      const chartRect = elements.reportChartWrap.getBoundingClientRect();
      elements.reportChartTooltip.style.left = `${event.clientX - chartRect.left + 14}px`;
      elements.reportChartTooltip.style.top = `${event.clientY - chartRect.top + 14}px`;
      elements.reportChartTooltip.classList.add("visible");
    });
    target.addEventListener("mouseleave", hideReportChartTooltip);
  });
}

function renderDimensionScoreChart(rows) {
  if (!elements.dimensionScoreChart) return;

  const buckets = buildImprovementBuckets(rows);
  const total = rows.length;
  elements.dimensionScoreCaption.textContent = total
    ? `${total} messages grouped over time. Y-axis: communication quality 0-100.`
    : "No dated messages are available for the improvement graph.";
  elements.dimensionScoreEmpty.classList.toggle("hidden", buckets.length > 0);
  elements.dimensionScoreChart.classList.toggle("hidden", buckets.length === 0);
  elements.dimensionScoreLegend.innerHTML = `
      <span class="report-legend-item static">
      <span class="report-legend-swatch improvement-swatch"></span>
      <span>Communication Quality</span>
    </span>
  `;

  const svgWidth = 960;
  const svgHeight = 390;
  const margin = { top: 26, right: 28, bottom: 64, left: 58 };
  const plotWidth = svgWidth - margin.left - margin.right;
  const plotHeight = svgHeight - margin.top - margin.bottom;
  const bucketWidth = plotWidth / Math.max(1, buckets.length);
  const yMin = 0;
  const yMax = 100;
  const ticks = [0, 25, 50, 75, 100];
  const yForScore = (score) =>
    margin.top + plotHeight - ((Math.max(yMin, Math.min(yMax, score)) - yMin) / (yMax - yMin)) * plotHeight;

  let gridHtml = "";
  for (const tick of ticks) {
    const y = yForScore(tick);
    gridHtml += `
      <line class="report-grid-line" x1="${margin.left}" y1="${y}" x2="${svgWidth - margin.right}" y2="${y}"></line>
      <text class="report-axis-label" x="${margin.left - 12}" y="${y + 4}" text-anchor="end">${tick}</text>
    `;
  }

  let axisLabelsHtml = "";
  const labelInterval = Math.max(1, Math.ceil(buckets.length / 12));
  buckets.forEach((bucket, index) => {
    const bucketX = margin.left + index * bucketWidth;
    const bucketCenter = bucketX + bucketWidth / 2;
    const labelY = margin.top + plotHeight + 28;

    const shouldShowLabel =
      index === 0 || index === buckets.length - 1 || index % labelInterval === 0;
    axisLabelsHtml += `
      ${shouldShowLabel ? renderReportXAxisLabel(bucket.label, bucketCenter, labelY) : ""}
      <rect class="report-hover-target" x="${bucketX}" y="${margin.top}" width="${bucketWidth}" height="${plotHeight}" data-report-row="${index}"></rect>
    `;
  });

  const points = buckets.map((bucket, index) => {
    const bucketX = margin.left + index * bucketWidth;
    const x = bucketX + bucketWidth / 2;
    const y = yForScore(bucket.improvement);
    return { x, y, value: bucket.improvement };
  });
  const pointPath = points.map((point) => `${point.x},${point.y}`).join(" ");
  const lineHtml = `
    <polyline class="report-improvement-line" points="${pointPath}" fill="none"></polyline>
    ${points
      .map((point) => `<circle class="report-improvement-point" cx="${point.x}" cy="${point.y}" r="4"></circle>`)
      .join("")}
  `;

  elements.dimensionScoreChart.setAttribute("viewBox", `0 0 ${svgWidth} ${svgHeight}`);
  elements.dimensionScoreChart.innerHTML = `
    <line class="report-axis-line" x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${svgWidth - margin.right}" y2="${margin.top + plotHeight}"></line>
    <line class="report-axis-line" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotHeight}"></line>
    <text class="report-y-axis-title" x="${margin.left - 72}" y="${margin.top - 16}" text-anchor="start">Improvement</text>
    <text class="report-x-axis-title" x="${svgWidth - margin.right + 18}" y="${margin.top + plotHeight + 8}" text-anchor="start">Time</text>
    ${gridHtml}
    ${lineHtml}
    ${axisLabelsHtml}
  `;

  elements.dimensionScoreChart.querySelectorAll("[data-report-row]").forEach((target) => {
    target.addEventListener("mousemove", (event) => {
      const bucket = buckets[Number(target.getAttribute("data-report-row"))];
      showDimensionChartTooltip(event, bucket);
    });
    target.addEventListener("mouseleave", hideDimensionChartTooltip);
  });
}

function renderReportHistogram(buckets) {
  const metric = state.reportChart.metric;
  const chartType = state.reportChart.type;
  const period = elements.periodSelect.value || "all";
  const visibleBuckets = getVisibleReportBuckets(buckets);
  const svgWidth = 960;
  const svgHeight = 390;
  const margin = { top: 26, right: 28, bottom: 64, left: 58 };
  const plotWidth = svgWidth - margin.left - margin.right;
  const plotHeight = svgHeight - margin.top - margin.bottom;
  const bucketWidth = plotWidth / Math.max(1, visibleBuckets.length);
  const maxGroupWidth = metric === "count" ? 28 : 22;
  const maxValue = Math.max(
    1,
    ...visibleBuckets.map((bucket) => {
      if (metric === "count") {
        return Math.max(0, ...getReportBarSegments(bucket, metric).map((segment) => segment.value));
      }
      return getBucketMetricValue(bucket, metric);
    })
  );
  const yMax = metric === "riskPercent" ? 100 : Math.ceil(maxValue * 1.15);
  const ticks = getReportYAxisTicks(yMax, metric);
  const yAxisTitle = metric === "riskPercent" ? "High Risk %" : "Messages";
  const xAxisTitle = getReportXAxisTitle(period);

  let gridHtml = "";
  for (const tick of ticks) {
    const y = margin.top + plotHeight - (tick / yMax) * plotHeight;
    gridHtml += `
      <line class="report-grid-line" x1="${margin.left}" y1="${y}" x2="${svgWidth - margin.right}" y2="${y}"></line>
      <text class="report-axis-label" x="${margin.left - 12}" y="${y + 4}" text-anchor="end">${formatReportMetricValue(tick, metric)}</text>
    `;
  }

  let barsHtml = "";
  let axisLabelsHtml = "";
  visibleBuckets.forEach((bucket, index) => {
    const bucketX = margin.left + index * bucketWidth;
    const bucketCenter = bucketX + bucketWidth / 2;
    const segments = getReportBarSegments(bucket, metric);
    const groupWidth = Math.min(maxGroupWidth, Math.max(12, bucketWidth * 0.72));
    const innerGap = metric === "count" && segments.length > 1 ? 3 : 0;
    const segmentBarWidth = metric === "count"
      ? Math.max(3, (groupWidth - innerGap * Math.max(0, segments.length - 1)) / Math.max(1, segments.length))
      : groupWidth;
    const groupX = bucketCenter - ((segmentBarWidth * segments.length + innerGap * Math.max(0, segments.length - 1)) / 2);

    segments.forEach((segment, segmentIndex) => {
      const height = (segment.value / yMax) * plotHeight;
      const x = groupX + segmentIndex * (segmentBarWidth + innerGap);
      const y = margin.top + plotHeight - height;

      if (height > 0) {
        barsHtml += `
          <rect class="report-bar" x="${x}" y="${y}" width="${segmentBarWidth}" height="${height}" fill="${segment.color}"></rect>
        `;
      }
    });

    const labelY = margin.top + plotHeight + 28;
    axisLabelsHtml += `
      ${renderReportXAxisLabel(bucket.label, bucketCenter, labelY)}
      <rect class="report-hover-target" x="${bucketX}" y="${margin.top}" width="${bucketWidth}" height="${plotHeight}" data-report-bucket="${index}"></rect>
    `;
  });

  let lineHtml = "";
  if (chartType === "line") {
    const lineSeries = metric === "count"
      ? [
        { key: "clear", label: "Positive", color: "#3ecf8e" },
        { key: "neutral", label: "Neutral", color: "#f0c04a" },
        { key: "high", label: "Negative", color: "#ff4d4d" },
      ].filter((series) => !state.reportChart.hiddenSeries.has(series.key))
      : [{ key: "riskPercent", label: "High Risk %", color: "#ff4d4d" }];

    lineHtml = lineSeries.map((series) => {
      const points = visibleBuckets.map((bucket, index) => {
        const bucketX = margin.left + index * bucketWidth;
        const x = bucketX + bucketWidth / 2;
        const value = series.key === "riskPercent" ? getBucketMetricValue(bucket, metric) : bucket[series.key];
        const y = margin.top + plotHeight - (value / yMax) * plotHeight;
        return { x, y, value };
      });
      const pointPath = points.map((point) => `${point.x},${point.y}`).join(" ");
      const circles = points
        .filter((point) => point.value > 0)
        .map((point) => `<circle class="report-line-point" cx="${point.x}" cy="${point.y}" r="4" fill="${series.color}"></circle>`)
        .join("");

      return `
        <polyline class="report-line-path" points="${pointPath}" fill="none" stroke="${series.color}"></polyline>
        ${circles}
      `;
    }).join("");
  }

  elements.reportHistogram.setAttribute("viewBox", `0 0 ${svgWidth} ${svgHeight}`);
  elements.reportHistogram.innerHTML = `
    <line class="report-axis-line" x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${svgWidth - margin.right}" y2="${margin.top + plotHeight}"></line>
    <line class="report-axis-line" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotHeight}"></line>
    <text class="report-y-axis-title" x="${margin.left - 72}" y="${margin.top - 16}" text-anchor="start">${escapeHtml(yAxisTitle)}</text>
    <text class="report-x-axis-title" x="${svgWidth - margin.right + 18}" y="${margin.top + plotHeight + 8}" text-anchor="start">${escapeHtml(xAxisTitle)}</text>
    ${gridHtml}
    ${chartType === "line" ? lineHtml : barsHtml}
    ${axisLabelsHtml}
  `;

  elements.reportHistogram.querySelectorAll("[data-report-bucket]").forEach((target) => {
    target.addEventListener("mousemove", (event) => {
      const bucket = visibleBuckets[Number(target.getAttribute("data-report-bucket"))];
      showReportChartTooltip(event, bucket, metric);
    });
    target.addEventListener("mouseleave", hideReportChartTooltip);
  });
}

function updateReportDashboard() {
  if (!elements.reportHistogram) return;

  const period = elements.periodSelect.value || "all";
  if (state.reportChart.metric === "dimensionScores") {
    state.reportChart.metric = "count";
    elements.reportMetricSelect.value = "count";
  }

  const { config, rows, buckets } = getReportRowsForPeriod(period);
  const total = rows.length;
  const highRisk = rows.filter((row) => getReportScore(row) > 3).length;
  const neutral = rows.filter((row) => getReportScore(row) === 3).length;
  const clear = total - highRisk - neutral;
  const metric = state.reportChart.metric;
  const metricLabel = metric === "riskPercent"
    ? "high risk percentage"
    : "message count";

  elements.reportChartHeading.textContent = config.title;
  elements.reportAxisTitle.textContent = `${config.axisLabel}: ${metricLabel}`;
  elements.reportTotalCount.textContent = String(total);
  elements.reportHighCount.textContent = String(highRisk);
  elements.reportNeutralCount.textContent = String(neutral);
  elements.reportClearCount.textContent = String(clear);
  elements.reportChartCaption.textContent = total
    ? `${total} messages grouped by ${config.bucketLabel}. X-axis: time. Y-axis: ${metricLabel}.`
    : "No dated messages are available for this time range.";
  const isMonthly = period === "30";
  elements.reportMonthNav.classList.toggle("hidden", !isMonthly);
  if (isMonthly) {
    elements.reportMonthLabel.textContent = config.selectedMonth
      ? new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(config.selectedMonth)
      : "Month";
    elements.reportPrevMonth.disabled = state.reportChart.monthOffset >= (config.maxPastOffset || 0);
    elements.reportNextMonth.disabled = state.reportChart.monthOffset <= 0;
  }
  const isWeekly = period === "7";
  elements.reportWeekNav.classList.toggle("hidden", !isWeekly);
  if (isWeekly) {
    elements.reportWeekLabel.textContent = config.selectedWeekStart && config.selectedWeekEnd
      ? formatDateRangeLabel(config.selectedWeekStart, config.selectedWeekEnd)
      : "Week";
    elements.reportPrevWeek.disabled = state.reportChart.weekOffset >= (config.maxPastWeekOffset || 0);
    elements.reportNextWeek.disabled = state.reportChart.weekOffset <= 0;
  }
  const isDaily = period === "today";
  elements.reportDayNav.classList.toggle("hidden", !isDaily);
  if (isDaily) {
    elements.reportDayLabel.textContent = config.selectedDay
      ? new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" }).format(config.selectedDay)
      : "Date";
    if (config.selectedDay) {
      elements.reportDayPicker.value = formatLocalDateKey(config.selectedDay);
    }
    elements.reportDayPicker.min = config.earliestDate ? formatLocalDateKey(config.earliestDate) : "";
    elements.reportDayPicker.max = config.anchorDate ? formatLocalDateKey(config.anchorDate) : "";
    elements.reportPrevDay.disabled = state.reportChart.dayOffset >= (config.maxPastDayOffset || 0);
    elements.reportNextDay.disabled = state.reportChart.dayOffset <= 0;
  }
  const isYearly = period === "90";
  elements.reportYearNav.classList.toggle("hidden", !isYearly);
  if (isYearly) {
    elements.reportYearLabel.textContent = config.selectedYear ? String(config.selectedYear) : "Year";
    elements.reportPrevYear.disabled = state.reportChart.yearOffset >= (config.maxPastYearOffset || 0);
    elements.reportNextYear.disabled = state.reportChart.yearOffset <= 0;
  }
  const isHistory = period === "all";
  elements.reportHistoryNav.classList.toggle("hidden", !isHistory);
  elements.dimensionScoreCard?.classList.toggle("hidden", false);
  renderDimensionScoreChart(rows);
  if (isHistory) {
    elements.reportHistoryLabel.textContent = config.historyStart && config.historyEnd
      ? formatDateRangeLabel(config.historyStart, config.historyEnd)
      : "History";
  }
  elements.reportChartEmpty.classList.toggle("hidden", total > 0);
  elements.reportHistogram.classList.toggle("hidden", total === 0);
  elements.reportLegend.classList.toggle("metric-mode", metric !== "count");

  renderReportLegend();
  if (state.reportChart.type === "pie") {
    renderReportPieChart(rows);
  } else {
    renderReportHistogram(buckets);
  }
}

function getFilters() {
  return {
    period: elements.periodSelect.value,
  };
}

function setStatus(message) {
  elements.statusText.textContent = message;
}

function setComposeStatus(message) {
  elements.composeStatus.textContent = message;
}

function normalizeLiveText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function hasMeaningfulLiveTextChange(previousText, nextText) {
  const before = normalizeLiveText(previousText);
  const after = normalizeLiveText(nextText);

  if (!before) {
    return after.length >= LIVE_WARNING_MIN_CHARS;
  }

  const lengthDelta = Math.abs(after.length - before.length);
  if (lengthDelta >= LIVE_WARNING_MIN_DELTA_CHARS) {
    return true;
  }

  if (after === before) {
    return false;
  }

  const beforeTokens = new Set(before.toLowerCase().split(" ").filter(Boolean));
  const afterTokens = new Set(after.toLowerCase().split(" ").filter(Boolean));
  let changedTokens = 0;

  for (const token of afterTokens) {
    if (!beforeTokens.has(token)) {
      changedTokens += 1;
    }
  }

  return changedTokens >= 8;
}

function getLiveWarningDimensions(analysis) {
  return (analysis?.dimensions || []).filter((dimension) => {
    const score = Number(dimension?.score) || 0;
    return score >= 4;
  });
}

function hideLiveWarning(options = {}) {
  state.liveWarningVisible = false;
  state.liveWarningMode = "live";
  elements.liveWarningBubble.classList.add("hidden");
  elements.liveWarningBubble.classList.remove("post-analysis");
  elements.liveWarningSuggestion.classList.add("hidden");
  elements.liveWarningSuggestion.textContent = "";
  elements.liveWarningQuestion.textContent = "Do you want to improve your message?";
  elements.liveWarningYes.textContent = "Yes";
  elements.liveWarningNo.textContent = "No";
  if (!options.keepHighlights) {
    state.pendingRewriteAnalysis = null;
    clearComposeHighlights();
  }
}

function showLiveWarning(dimensions) {
  const labels = dimensions.map((dimension) => dimension.name).join(" and ");
  const readableLabels = labels || "Pressure and manipulation";
  state.pendingRewriteAnalysis = null;
  state.liveWarningMode = "live";
  elements.liveWarningBubble.classList.remove("post-analysis");
  elements.liveWarningText.textContent = `Your message has exploitative leadership ${readableLabels} detected.`;
  elements.liveWarningSuggestion.classList.add("hidden");
  elements.liveWarningSuggestion.textContent = "";
  elements.liveWarningQuestion.textContent = "Do you want to improve your message?";
  elements.liveWarningYes.textContent = "Yes";
  elements.liveWarningNo.textContent = "No";
  state.liveWarningVisible = true;
  elements.liveWarningBubble.classList.remove("hidden");
}

function showPostAnalysisBubble(analysis) {
  const criticalDimensions = (analysis?.dimensions || []).filter(
    (dimension) => Number(dimension?.score) > 3
  );
  const rewrite = sanitizeSuggestedRewrite(analysis?.suggestedRewrite || "");

  if (!criticalDimensions.length || !rewrite) {
    hideLiveWarning();
    return;
  }

  const labels = criticalDimensions
    .map((dimension) => `<strong>${escapeHtml(dimension.name)}</strong>`)
    .join(" and ");
  state.pendingRewriteAnalysis = analysis;
  state.liveWarningMode = "post-analysis";
  elements.liveWarningBubble.classList.add("post-analysis");
  elements.liveWarningText.innerHTML =
    `Your message has critical ${labels} detected.`;
  elements.liveWarningSuggestion.textContent = `Suggested rewrite:\n${rewrite}`;
  elements.liveWarningSuggestion.classList.remove("hidden");
  elements.liveWarningQuestion.textContent = "Do you want to apply the rewritten text?";
  elements.liveWarningYes.textContent = "Yes";
  elements.liveWarningNo.textContent = "No";
  state.liveWarningVisible = true;
  elements.liveWarningBubble.classList.remove("hidden");
}

function clearLiveWarningAutoDisableTimer() {
  if (liveWarningAutoDisableId) {
    clearTimeout(liveWarningAutoDisableId);
    liveWarningAutoDisableId = null;
  }
}

function startLiveWarningAutoDisableTimer() {
  clearLiveWarningAutoDisableTimer();
  liveWarningAutoDisableId = setTimeout(() => {
    liveWarningAutoDisableId = null;
    liveAnalysisRequestId += 1;
    setLiveWarningMode(false);
    setComposeStatus("Live Warning was automatically disabled after 5 minutes. Activate it manually to use it again.");
    setControls();
  }, LIVE_WARNING_AUTO_DISABLE_MS);
}

function setLiveWarningMode(enabled) {
  state.liveWarningEnabled = enabled;
  elements.liveWarningToggleLabel.textContent = enabled
    ? "Live Warning Active"
    : "Activate Live Warning";
  elements.liveWarningToggle.setAttribute("aria-pressed", enabled ? "true" : "false");
  elements.liveWarningToggle.classList.toggle("accent-btn", enabled);
  elements.liveWarningToggle.classList.toggle("ghost-btn", !enabled);

  if (enabled) {
    startLiveWarningAutoDisableTimer();
  } else {
    clearLiveWarningAutoDisableTimer();
    if (liveAnalysisDebounceId) {
      clearTimeout(liveAnalysisDebounceId);
      liveAnalysisDebounceId = null;
    }
    state.lastLiveAnalysisText = "";
    state.lastLiveAnalysisAt = 0;
    state.liveWarningAnalysis = null;
    state.pendingRewriteAnalysis = null;
    hideLiveWarning();
  }
}

function setProgress(current, total) {
  const safeTotal = total || 0;
  const percent = safeTotal > 0 ? Math.round((current / safeTotal) * 100) : 0;
  elements.progressFill.style.width = `${percent}%`;
  elements.progressText.textContent = `${current} of ${safeTotal} analyzed...`;
}

function renderSummary() {
  const successful = state.results.filter((item) => !item.error);
  const noIssues = successful.filter((item) => item.analysis.highestScore < 3).length;
  const moderate = successful.filter((item) => item.analysis.highestScore === 3).length;
  const highRisk = successful.filter((item) => item.analysis.highestScore >= 4).length;
  elements.summaryText.textContent = `✅ ${noIssues} No Issues  🟡 ${moderate} Moderate  🔴 ${highRisk} High Risk`;
  updateDashboardInsights();
}

function updateDashboardInsights() {
  const totalEmails = Number(state.dashboardSummary.totalEmails) || 0;
  elements.emailSummaryTitle.innerHTML = `Emails <span class="summary-title-count">(${escapeHtml(String(totalEmails))})</span>`;

  if (!state.dashboardSummary.totalEmails) {
    elements.negativeSummary.innerHTML = '<span class="metric-value">0%</span><span class="metric-label">negative</span>';
    elements.neutralSummary.innerHTML = '<span class="metric-value">0%</span><span class="metric-label">neutral</span>';
    elements.positiveSummary.innerHTML = '<span class="metric-value">0%</span><span class="metric-label">positive</span>';
    state.summaryFilter = "all";
    updateSummaryFilterControls();
    renderEmailSummaryTable([]);
    updateReportDashboard();
    return;
  }

  elements.negativeSummary.innerHTML = `<span class="metric-value">${escapeHtml(String(state.dashboardSummary.negativePercent))}%</span><span class="metric-label">negative</span>`;
  elements.neutralSummary.innerHTML = `<span class="metric-value">${escapeHtml(String(state.dashboardSummary.neutralPercent || 0))}%</span><span class="metric-label">neutral</span>`;
  elements.positiveSummary.innerHTML = `<span class="metric-value">${escapeHtml(String(state.dashboardSummary.positivePercent))}%</span><span class="metric-label">positive</span>`;
  updateSummaryFilterControls();
  renderEmailSummaryTable(getFilteredSummaryRows());
  updateReportDashboard();
}

function isNegativeSummaryRow(row) {
  const highestScore = toSummaryNumber(row.highestScore);
  const overallToxicity = toSummaryNumber(row.overallToxicity);
  const effectiveScore = highestScore != null ? highestScore : overallToxicity;

  if (effectiveScore != null) {
    return effectiveScore > 3;
  }

  return Boolean(row.overallFlag);
}

function isNeutralSummaryRow(row) {
  const highestScore = toSummaryNumber(row.highestScore);
  const overallToxicity = toSummaryNumber(row.overallToxicity);
  const effectiveScore = highestScore != null ? highestScore : overallToxicity;
  return effectiveScore === 3;
}

function getFilteredSummaryRows() {
  const rows = state.dashboardSummary.emails || [];
  if (state.summaryFilter === "negative") {
    return rows.filter(isNegativeSummaryRow);
  }

  if (state.summaryFilter === "neutral") {
    return rows.filter(isNeutralSummaryRow);
  }

  if (state.summaryFilter === "positive") {
    return rows.filter((row) => !isNegativeSummaryRow(row) && !isNeutralSummaryRow(row));
  }

  return rows;
}

function getSummaryMetricCount(type) {
  const rows = state.dashboardSummary.emails || [];
  const negativeCount = rows.filter(isNegativeSummaryRow).length;
  const neutralCount = rows.filter(isNeutralSummaryRow).length;
  if (type === "negative") return negativeCount;
  if (type === "neutral") return neutralCount;
  return rows.length - negativeCount - neutralCount;
}

function positionSummaryMetricTooltip(event) {
  elements.summaryMetricTooltip.style.left = `${event.clientX + 12}px`;
  elements.summaryMetricTooltip.style.top = `${event.clientY + 18}px`;
}

function showTooltip(message, event, variant = "") {
  elements.summaryMetricTooltip.textContent = message;
  elements.summaryMetricTooltip.classList.toggle("wide", variant === "wide");
  positionSummaryMetricTooltip(event);
  elements.summaryMetricTooltip.classList.add("visible");
}

function showSummaryMetricTooltip(type, event) {
  const count = getSummaryMetricCount(type);
  const rule =
    type === "negative"
      ? "Score 4-5"
      : type === "neutral"
        ? "Score 3"
        : "Score 1-2";
  showTooltip(`${count} ${count === 1 ? "Email" : "Emails"} · ${rule}`, event);
}

function hideTooltip() {
  elements.summaryMetricTooltip.classList.remove("visible");
  elements.summaryMetricTooltip.classList.remove("wide");
}

function updateSummaryFilterControls() {
  const filter = state.summaryFilter;
  elements.negativeSummary.classList.toggle("active", filter === "negative");
  elements.neutralSummary.classList.toggle("active", filter === "neutral");
  elements.positiveSummary.classList.toggle("active", filter === "positive");
  elements.clearSummaryFilter.classList.toggle("hidden", filter === "all");
}

function setSummaryFilter(filter) {
  state.summaryFilter = filter === "all" || state.summaryFilter === filter ? "all" : filter;
  updateSummaryFilterControls();
  renderEmailSummaryTable(getFilteredSummaryRows());
}

function getSummarySortDefaultDirection(key) {
  return key === "subject" ? "asc" : "desc";
}

function getLevelSeverity(value) {
  const normalizedLevel = String(value || "").trim().toLowerCase().replace(/\s+/g, "");
  switch (normalizedLevel) {
    case "veryhigh":
      return 5;
    case "high":
      return 4;
    case "moderate":
    case "medium":
      return 3;
    case "low":
      return 2;
    case "minimal":
    case "positive":
      return 1;
    case "verylow":
      return 1;
    default:
      return 0;
  }
}

function toSummaryNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toSummaryDate(value) {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function compareSummaryValues(leftValue, rightValue, direction) {
  const leftMissing = leftValue == null || leftValue === "";
  const rightMissing = rightValue == null || rightValue === "";

  if (leftMissing && rightMissing) return 0;
  if (leftMissing) return 1;
  if (rightMissing) return -1;

  if (typeof leftValue === "string" || typeof rightValue === "string") {
    return String(leftValue).localeCompare(String(rightValue), undefined, {
      numeric: true,
      sensitivity: "base",
    }) * (direction === "asc" ? 1 : -1);
  }

  if (leftValue === rightValue) return 0;
  return (leftValue > rightValue ? 1 : -1) * (direction === "asc" ? 1 : -1);
}

function getSummarySortValue(row, key) {
  if (key === "subject") return String(row.subject || "");
  if (key === "date") return toSummaryDate(row.date);
  if (key === "level") return getLevelSeverity(row.level);
  return toSummaryNumber(row[key]);
}

function getSortedSummaryRows(rows) {
  const key = state.summarySort.key;
  const direction = state.summarySort.direction;

  return (rows || [])
    .map((row, index) => {
      const dashboardIndex = (state.dashboardSummary.emails || []).indexOf(row);
      return {
        row,
        originalIndex: dashboardIndex >= 0 ? dashboardIndex : index,
      };
    })
    .sort((left, right) => {
      const compared = compareSummaryValues(
        getSummarySortValue(left.row, key),
        getSummarySortValue(right.row, key),
        direction
      );

      if (compared !== 0) {
        return compared;
      }

      return left.originalIndex - right.originalIndex;
    });
}

function updateSummarySortHeaders() {
  for (const button of elements.summarySortButtons || []) {
    const isActive = button.dataset.summarySort === state.summarySort.key;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-sort", isActive ? state.summarySort.direction : "none");
    button.dataset.sortDirection = isActive ? state.summarySort.direction : "";
  }
}

function sortSummaryBy(key) {
  if (state.summarySort.key === key) {
    state.summarySort.direction = state.summarySort.direction === "asc" ? "desc" : "asc";
  } else {
    state.summarySort.key = key;
    state.summarySort.direction = getSummarySortDefaultDirection(key);
  }

  renderEmailSummaryTable(getFilteredSummaryRows());
}

function renderEmailSummaryTable(rows) {
  updateSummarySortHeaders();

  if (!rows.length) {
    elements.emailSummaryBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="9">No Excel-based email summary available yet.</td>
      </tr>
    `;
    return;
  }

  const formatCell = (value) => {
    if (value === "" || value == null) {
      return "—";
    }

    return escapeHtml(String(value));
  };

  const formatLevelCell = (value) => {
    const level = String(value || "").trim();
    if (!level) {
      return "â€”";
    }

    const normalizedLevel = level.toLowerCase().replace(/\s+/g, "");
    const displayLevel =
      normalizedLevel === "minimal" || normalizedLevel === "positive"
        ? "Minimal"
        : normalizedLevel === "moderate" || normalizedLevel === "neutral"
          ? "Neutral"
          : level;
    const levelClass =
      normalizedLevel === "veryhigh"
        ? "level-very-high"
        : normalizedLevel === "high"
          ? "level-high"
          : normalizedLevel === "moderate" || normalizedLevel === "neutral"
            ? "level-neutral"
            : normalizedLevel === "minimal" || normalizedLevel === "positive"
              ? "level-positive"
              : "";

    return `<span class="level-badge ${levelClass}">${escapeHtml(displayLevel)}</span>`;
  };

  elements.emailSummaryBody.innerHTML = getSortedSummaryRows(rows)
    .map(
      ({ row, originalIndex }) => `
        <tr class="summary-row" data-summary-index="${originalIndex}" tabindex="0" role="button">
          <td class="subject-cell"><span class="truncate">${row.subject ? escapeHtml(row.subject) : ""}</span></td>
          <td class="mono">${formatCell(formatDate(row.date))}</td>
          <td>${formatCell(row.overallToxicity)}</td>
          <td>${formatLevelCell(row.level)}</td>
          <td>${formatCell(row.genuineEgoisticBehaviors)}</td>
          <td>${formatCell(row.takingCredit)}</td>
          <td>${formatCell(row.exertingPressure)}</td>
          <td>${formatCell(row.underminingDevelopment)}</td>
          <td>${formatCell(row.manipulating)}</td>
        </tr>
      `
    )
    .join("");
}

function buildDetailItemFromSummary(row) {
  if (!row) {
    return null;
  }

  const dimensions = Array.isArray(row.dimensions) ? row.dimensions : [];
  const highestScore =
    Number(row.highestScore) ||
    dimensions.reduce((currentHighest, dimension) => Math.max(currentHighest, Number(dimension?.score) || 0), 0);

  return {
    email: {
      subject: row.subject || "",
      recipients: row.recipients || "",
      sender: row.sender || "",
      date: row.date || "",
      body: row.originalText || "",
      textForAnalysis: row.originalText || "",
    },
    analysis: {
      overallFlag: Boolean(row.overallFlag),
      overallToxicityScore: row.overallToxicity || "",
      overallToxicityLabel: row.level || "",
      overallToxicityEmoji: "",
      highestScore,
      highestDimensionName: row.highestDimensionName || "",
      dimensions,
      notes: row.notes || "",
      suggestedRewrite: row.rewrittenText || "",
    },
    error: row.error || null,
  };
}

async function refreshDashboardInsightsFromExcel() {
  if (isElectron) {
    if (!state.composeLogPath) {
      state.dashboardSummary = {
        totalEmails: 0,
        positivePercent: 0,
        neutralPercent: 0,
        negativePercent: 0,
        emails: [],
      };
      updateDashboardInsights();
      return;
    }

    state.dashboardSummary = exporter.readDashboardSummary(state.composeLogPath);
    updateDashboardInsights();
  } else {
    try {
      if (!state.dashboardSummary) {
        setComposeStatus("Loading data from Firebase...");
      }
      const summary = await window.apiClient.getExcelSummary();
      state.dashboardSummary = summary;
      if (summary?.excelPath) {
        state.composeLogPath = summary.excelPath;
      }
      updateDashboardInsights();
    } catch (err) {
      console.error("Failed to load data from Firebase:", err);
      setComposeStatus(err.message || "Could not load data from Firebase.");
    }
  }
}

async function refreshExcelDashboard(options = {}) {
  const silent = Boolean(options.silent);

  try {
    await refreshDashboardInsightsFromExcel();
    renderComposeResult();
    if (!silent) {
      setComposeStatus(`Excel data refreshed.`);
    }
    return true;
  } catch (error) {
    if (!silent) {
      setComposeStatus(`Could not refresh Excel data: ${error.message}`);
    }
    return false;
  }
}

function scheduleExcelDashboardRefresh() {
  if (excelRefreshDebounceId) {
    clearTimeout(excelRefreshDebounceId);
  }

  excelRefreshDebounceId = setTimeout(async () => {
    excelRefreshDebounceId = null;
    const refreshed = await refreshExcelDashboard({ silent: true });
    if (refreshed) {
      setComposeStatus(`Excel file changed. Dashboard refreshed.`);
    }
  }, 900);
}

function stopExcelWatcher() {
  if (excelWatcher) {
    if (isElectron && typeof excelWatcher.close === "function") {
      excelWatcher.close();
    } else {
      clearInterval(excelWatcher);
    }
    excelWatcher = null;
  }

  if (excelRefreshDebounceId) {
    clearTimeout(excelRefreshDebounceId);
    excelRefreshDebounceId = null;
  }
}

function startExcelWatcher() {
  stopExcelWatcher();

  if (isElectron) {
    if (!state.composeLogPath || !fs?.existsSync(state.composeLogPath)) {
      return;
    }

    try {
      excelWatcher = fs.watch(state.composeLogPath, (eventType) => {
        if (eventType === "change" || eventType === "rename") {
          scheduleExcelDashboardRefresh();
        }
      });
    } catch (_error) {
      excelWatcher = null;
    }
  } else {
    excelWatcher = setInterval(() => {
      refreshDashboardInsightsFromExcel();
    }, 10000);
  }
}

function switchView(viewName, period = "") {
  if (viewName === "reports") {
    state.activeView = "reports";
  } else if (viewName === "compose") {
    state.activeView = "compose";
  } else {
    state.activeView = "overview";
  }

  const showOverview = state.activeView === "overview";
  const showCompose = state.activeView === "compose";
  const showReports = state.activeView === "reports";

  elements.overviewView.classList.toggle("hidden", !showOverview);
  elements.overviewView.classList.toggle("active", showOverview);
  elements.composeView.classList.toggle("hidden", !showCompose);
  elements.composeView.classList.toggle("active", showCompose);
  elements.reportsView.classList.toggle("hidden", !showReports);
  elements.reportsView.classList.toggle("active", showReports);

  for (const button of elements.navButtons) {
    const matchesView = button.dataset.view === state.activeView;
    const matchesPeriod = !period || button.dataset.period === period;
    button.classList.toggle(
      "active",
      matchesView && (state.activeView === "overview" || state.activeView === "compose" || matchesPeriod)
    );
  }

  if (showReports && period) {
    elements.periodSelect.value = period;
    elements.reportsTitle.textContent = getReportTitle(period);
    syncReportNavState(period);
    updateReportDashboard();
    handleFilterChange();
  } else if (showReports) {
    elements.periodSelect.value = elements.periodSelect.value || "all";
    elements.reportsTitle.textContent = getReportTitle(elements.periodSelect.value);
    syncReportNavState(elements.periodSelect.value);
    updateReportDashboard();
  } else {
    syncReportNavState("");
  }

  saveUiPreferences({
    activeView: state.activeView,
    reportPeriod: showReports ? elements.periodSelect.value || period || "all" : elements.periodSelect.value || "all",
  });
}

function syncReportNavState(period) {
  for (const button of elements.navButtons) {
    const view = button.dataset.view;
    const isOverview = view === "overview";
    const isCompose = view === "compose";
    const isActiveReport = view === "reports" && button.dataset.period === period;
    button.classList.toggle(
      "active",
      isOverview
        ? state.activeView === "overview"
        : isCompose
          ? state.activeView === "compose"
          : isActiveReport
    );
  }
}

function setControls() {
  const hasPst = Boolean(state.pstData);
  const hasFiltered = state.filteredEmails.length > 0;
  const hasComposeBody = Boolean(String(elements.composeBody?.value || "").trim());
  const isBusy = state.isAnalyzing || state.isExporting || state.isComposeAnalyzing;
  elements.analyzeBtn.disabled = !hasPst || !hasFiltered || isBusy;
  elements.cancelBtn.disabled = !state.isAnalyzing || state.isExporting;
  elements.exportBtn.disabled = state.results.length === 0 || isBusy;
  elements.loadPstBtn.disabled = isBusy;
  elements.exportOutlookBtn.disabled = isBusy;
  elements.periodSelect.disabled = isBusy;
  elements.settingsBtn.disabled = isBusy;
  elements.composeSendBtn.disabled = !hasComposeBody || isBusy;
  elements.composeUndoRewriteBtn.disabled = !state.composeRewriteApplied || isBusy;
  elements.composeUndoRewriteBtn.classList.toggle("hidden", !state.composeRewriteApplied);
  elements.composeDetailsBtn.disabled = !state.composeResult;
  elements.composeTo.disabled = state.isComposeAnalyzing;
  elements.composeSubject.disabled = state.isComposeAnalyzing;
  elements.composeBody.disabled = false;
  elements.liveWarningToggle.disabled = state.isComposeAnalyzing || state.isExporting || state.isAnalyzing;
  elements.liveWarningYes.disabled = state.isComposeAnalyzing;
  elements.liveWarningNo.disabled = state.isComposeAnalyzing;
}

function buildComposeEmailRecord() {
  const to = String(elements.composeTo.value || "").trim() || "(No Recipient)";
  const subject = String(elements.composeSubject.value || "").trim() || "(No Subject)";
  const body = String(elements.composeBody.value || "").trim();
  const date = new Date().toISOString();

  return {
    id: `compose-${date}`,
    subject,
    recipients: to,
    date,
    folderPath: "Compose Message",
    sender: "Local Draft",
    body,
    textForAnalysis: body,
  };
}

function renderComposeResult() {
  if (!state.composeResult) {
    elements.composeResultCard.classList.add("hidden");
    elements.composeResultEmpty.classList.remove("hidden");
    elements.composeResultPanel.classList.add("hidden");
    elements.composeLogPath.textContent = state.composeLogPath
      ? `Local log: ${state.composeLogPath}`
      : "";
    return;
  }

  const item = state.composeResult;
  elements.composeResultCard.classList.remove("hidden");
  elements.composeResultEmpty.classList.add("hidden");
  elements.composeResultPanel.classList.remove("hidden");
  elements.composeResultSubject.textContent = item.email.subject;
  elements.composeResultRecipient.textContent = item.email.recipients;
  elements.composeFlagBadge.innerHTML = getFlagBadge(item);
  elements.composeScoreBadge.innerHTML = getScoreBadge(item);
  elements.composeResultNotes.textContent = item.error
    ? item.error
    : item.analysis.notes || "No notes provided.";
  elements.composeLogPath.textContent = state.composeLogPath
    ? `Saved to: ${state.composeLogPath}`
    : "";
}

async function applyComposeRewrite() {
  const rewriteAnalysis = state.pendingRewriteAnalysis || state.composeResult?.analysis;
  const rewrite = sanitizeSuggestedRewrite(rewriteAnalysis?.suggestedRewrite || "");
  if (!rewrite) {
    setComposeStatus("No suggested rewrite is available for this message.");
    return;
  }

  if (!state.composeRewriteApplied) {
    state.composeOriginalBody = elements.composeBody.value;
  }

  const originalBody = String(state.composeOriginalBody || elements.composeBody.value || "");
  elements.composeBody.value = rewrite;
  state.composeRewriteApplied = true;
  clearComposeHighlights();

  const isLiveWarningRewrite =
    Boolean(state.pendingRewriteAnalysis) &&
    state.pendingRewriteAnalysis !== state.composeResult?.analysis;

  if ((!state.composeResult || isLiveWarningRewrite) && rewriteAnalysis) {
    const email = {
      ...buildComposeEmailRecord(),
      body: originalBody,
      textForAnalysis: originalBody,
    };
    state.composeResult = { email, analysis: rewriteAnalysis, error: null };
    state.composeLogRowNumber = null;
  }

  if (state.composeResult && state.composeLogPath && state.composeLogRowNumber) {
    try {
      if (isElectron) {
        exporter.updateComposeRewrite(state.composeLogPath, state.composeLogRowNumber, rewrite);
      } else {
        await window.apiClient.updateComposeRewrite(state.composeLogRowNumber, rewrite);
      }
      await refreshDashboardInsightsFromExcel();
      setComposeStatus("Rewrite applied and saved to the Excel log.");
    } catch (error) {
      setComposeStatus(`Rewrite applied, but it was not saved. ${formatExcelSaveError(error)}`);
    }
  } else if (state.composeResult && state.composeLogPath) {
    try {
      let savedComposeLog;
      if (isElectron) {
        savedComposeLog = exporter.appendComposeResult(state.composeResult, state.composeLogPath, {
          includeSuggestedRewrite: true,
        });
      } else {
        savedComposeLog = await window.apiClient.appendComposeResult(state.composeResult, {
          includeSuggestedRewrite: true,
        });
      }
      state.composeLogRowNumber = savedComposeLog?.rowNumber || null;
      await refreshDashboardInsightsFromExcel();
      renderComposeResult();
      setComposeStatus("Rewrite applied and saved to the Excel log.");
    } catch (error) {
      setComposeStatus(`Rewrite applied, but it was not saved. ${formatExcelSaveError(error)}`);
    }
  } else {
    setComposeStatus("Rewrite applied.");
  }
  setControls();
}

async function undoComposeRewrite() {
  if (!state.composeRewriteApplied) {
    return;
  }

  elements.composeBody.value = state.composeOriginalBody || "";
  state.composeRewriteApplied = false;
  clearComposeHighlights();

  if (state.composeResult && state.composeLogPath && state.composeLogRowNumber) {
    try {
      if (isElectron) {
        exporter.updateComposeRewrite(state.composeLogPath, state.composeLogRowNumber, "");
      } else {
        await window.apiClient.updateComposeRewrite(state.composeLogRowNumber, "");
      }
      await refreshDashboardInsightsFromExcel();
      setComposeStatus("Original restored and the saved rewrite was cleared from Excel.");
    } catch (error) {
      setComposeStatus(`Original restored, but Excel could not be updated. ${formatExcelSaveError(error)}`);
    }
  } else {
    setComposeStatus("Original restored.");
  }

  setControls();
}

function renderEmptyTable(message = "No results yet.") {
  elements.resultsBody.innerHTML = `
    <tr class="empty-row">
      <td colspan="6">${escapeHtml(message)}</td>
    </tr>
  `;
}

function getFlagBadge(item) {
  if (item.error) return '<span class="badge badge-error">Error</span>';
  if (item.analysis.overallFlag) return '<span class="badge badge-flagged">Flagged</span>';
  return '<span class="badge badge-clear">Clear</span>';
}

function getDisplayScoreEmoji(score) {
  const normalized = Math.max(1, Math.min(5, Math.round(Number(score) || 1)));
  if (normalized >= 5) return "🔴";
  if (normalized >= 4) return "🟠";
  if (normalized >= 3) return "🟡";
  if (normalized >= 2) return "🟢";
  return "🟢";
}

function getScoreBadge(item) {
  if (item.error) return '<span class="badge badge-error">Unavailable</span>';
  const score = item.analysis.highestScore;
  const emoji = getDisplayScoreEmoji(score);
  return `<span class="badge score-${score}">${emoji} Score ${score}</span>`;
}

function renderTable() {
  if (!state.results.length) {
    renderEmptyTable();
    return;
  }

  elements.resultsBody.innerHTML = state.results
    .map(
      (item, index) => `
        <tr>
          <td class="subject-cell"><span class="truncate">${escapeHtml(item.email.subject)}</span></td>
          <td class="recipients-cell"><span class="truncate">${escapeHtml(item.email.recipients)}</span></td>
          <td class="mono">${escapeHtml(formatDate(item.email.date))}</td>
          <td>${getFlagBadge(item)}</td>
          <td>${getScoreBadge(item)}</td>
          <td><button class="details-btn" data-details-index="${index}">Details</button></td>
        </tr>
      `
    )
    .join("");
}

function updateTableCaption() {
  if (!state.pstData) {
    elements.tableCaption.textContent = "No PST file loaded.";
    return;
  }

  elements.tableCaption.textContent = `${state.results.length} of ${state.filteredEmails.length} filtered emails analyzed.`;
}

function refreshFilters() {
  if (!state.pstData) {
    state.filteredEmails = [];
    elements.emailCount.textContent = "Load a PST to inspect Sent Items.";
    updateTableCaption();
    setControls();
    return;
  }

  state.filteredEmails = isElectron
    ? analyzer.applyFilters(state.pstData.emails, getFilters())
    : filterEmailsByPeriod(state.pstData.emails, getFilters());
  elements.emailCount.textContent = `${state.pstData.totalEmails} emails found in Sent Items. ${state.filteredEmails.length} currently match the filters.`;
  if (!state.results.length) {
    renderEmptyTable(state.filteredEmails.length ? "No results yet." : "No emails match the current filters.");
  }
  updateTableCaption();
  setControls();
}

function handleFilterChange() {
  if (state.isAnalyzing) {
    return;
  }

  saveUiPreferences({ reportPeriod: elements.periodSelect.value || "all" });
  elements.reportsTitle.textContent = getReportTitle(elements.periodSelect.value);
  syncReportNavState(elements.periodSelect.value);
  state.results = [];
  renderSummary();
  updateReportDashboard();
  refreshFilters();
  setProgress(0, state.filteredEmails.length);
}

async function loadSettings() {
  applyTheme(getSavedTheme());
  try {
    const settings = isElectron
      ? await ipcRenderer.invoke("settings:get")
      : await window.apiClient.getSettings();
    if (isElectron) {
      state.composeLogPath = String(settings?.excelPath || "");
    }
  } catch (err) {
    console.warn("Failed to load settings:", err);
  }
}

async function loadComposeLogPath() {
  if (isElectron) {
    state.composeLogPath = await ipcRenderer.invoke("compose:get-log-path");
  } else {
    const settings = await window.apiClient.getSettings();
    state.composeLogPath = settings?.excelPath || "ToxicRadar-Compose-Log.xlsx";
  }

  await refreshExcelDashboard({ silent: true });
  startExcelWatcher();
  renderComposeResult();
}

function openModal(id) {
  document.getElementById(id).classList.remove("hidden");
}

function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
}

async function saveSettings() {
  closeModal("settings-modal");
}

async function analyzeComposeMessage() {
  const email = buildComposeEmailRecord();
  if (!email.body) {
    setComposeStatus("Please write a message before starting the analysis.");
    setControls();
    return;
  }

  state.isComposeAnalyzing = true;
  state.composeOriginalBody = email.body;
  state.composeRewriteApplied = false;
  state.composeLogRowNumber = null;
  setControls();
  setComposeStatus("Analyzing the composed message...");

  try {
    let analysis;
    if (isElectron) {
      analysis = await analyzer.analyzeEmailText(email.textForAnalysis, state.openaiApiKey);
    } else {
      const biometricsData = watchConnected ? { bpm: currentBpm, stressLevel: currentStressLevel } : null;
      const res = await window.apiClient.analyze(email.textForAnalysis, biometricsData);
      analysis = res.analysis;
    }
    state.composeResult = { email, analysis, error: null };
  } catch (error) {
    state.composeResult = createErrorResult(email, error);
  }

  try {
    let savedComposeLog;
    if (isElectron) {
      savedComposeLog = exporter.appendComposeResult(state.composeResult, state.composeLogPath, {
        includeSuggestedRewrite: false,
      });
    } else {
      savedComposeLog = await window.apiClient.appendComposeResult(state.composeResult, {
        includeSuggestedRewrite: false,
      });
    }
    state.composeLogRowNumber = savedComposeLog?.rowNumber || null;
    await refreshDashboardInsightsFromExcel();
    setComposeStatus(
      state.composeResult.error
        ? `Compose analysis failed: ${state.composeResult.error} The draft was still logged locally.`
        : "Compose analysis completed and stored in the Excel log. Suggested rewrite will be saved only if accepted."
    );
  } catch (error) {
    setComposeStatus(
      state.composeResult.error
        ? `Compose analysis failed and the Excel log could not be updated. ${formatExcelSaveError(error)}`
        : `Analysis completed, but it was not saved to the Excel log. ${formatExcelSaveError(error)}`
    );
  } finally {
    state.isComposeAnalyzing = false;
    renderComposeResult();
    if (!state.composeResult.error) {
      showPostAnalysisBubble(state.composeResult.analysis);
    }
    setControls();
  }
}

async function runLiveWarningAnalysis(_snapshotText) {
  const snapshotText = normalizeLiveText(_snapshotText);
  if (!state.liveWarningEnabled || snapshotText.length < LIVE_WARNING_MIN_CHARS) {
    state.isLiveAnalyzing = false;
    hideLiveWarning();
    return;
  }

  const requestId = ++liveAnalysisRequestId;
  state.isLiveAnalyzing = true;
  setControls();
  setComposeStatus("Live Warning is checking the draft...");

  try {
    let analysis;
    if (isElectron) {
      analysis = await analyzer.analyzeEmailText(snapshotText, state.openaiApiKey);
    } else {
      const biometricsData = watchConnected ? { bpm: currentBpm, stressLevel: currentStressLevel } : null;
      const res = await window.apiClient.analyze(snapshotText, biometricsData);
      analysis = res.analysis;
    }

    if (requestId !== liveAnalysisRequestId || !state.liveWarningEnabled) {
      return;
    }

    state.lastLiveAnalysisText = snapshotText;
    state.lastLiveAnalysisAt = Date.now();
    state.liveWarningAnalysis = analysis;

    const currentText = normalizeLiveText(elements.composeBody.value);
    if (currentText !== snapshotText) {
      scheduleLiveWarningAnalysis();
      return;
    }

    if (currentText === state.liveWarningDismissedForText) {
      hideLiveWarning();
      setComposeStatus("Live warning dismissed for this draft.");
      return;
    }

    const warningDimensions = getLiveWarningDimensions(analysis);
    if (warningDimensions.length) {
      showLiveWarning(warningDimensions);
      renderComposeHighlights(analysis, elements.composeBody.value);
      setComposeStatus("Live Warning found risky pressure or manipulation signals.");
      return;
    }

    hideLiveWarning();
    state.liveWarningAnalysis = null;
    setComposeStatus("Live Warning found no strong pressure or manipulation signals.");
  } catch (error) {
    if (requestId === liveAnalysisRequestId) {
      hideLiveWarning();
      setComposeStatus(`Live Warning could not check the draft. ${error.message}`);
    }
  } finally {
    if (requestId === liveAnalysisRequestId) {
      state.isLiveAnalyzing = false;
      setControls();
    }
  }
}

function scheduleLiveWarningAnalysis(options = {}) {
  if (liveAnalysisDebounceId) {
    clearTimeout(liveAnalysisDebounceId);
    liveAnalysisDebounceId = null;
  }

  if (!state.liveWarningEnabled) {
    state.isLiveAnalyzing = false;
    hideLiveWarning(options);
    return;
  }

  const snapshotText = normalizeLiveText(elements.composeBody.value);
  if (snapshotText.length < LIVE_WARNING_MIN_CHARS) {
    state.isLiveAnalyzing = false;
    hideLiveWarning(options);
    setComposeStatus(`Live Warning starts after ${LIVE_WARNING_MIN_CHARS} characters.`);
    setControls();
    return;
  }

  if (snapshotText === state.liveWarningDismissedForText) {
    hideLiveWarning(options);
    return;
  }

  if (
    state.lastLiveAnalysisText &&
    !hasMeaningfulLiveTextChange(state.lastLiveAnalysisText, snapshotText)
  ) {
    return;
  }

  const elapsedSinceLastCheck = Date.now() - state.lastLiveAnalysisAt;
  const cooldownWait = state.lastLiveAnalysisAt
    ? Math.max(0, LIVE_WARNING_COOLDOWN_MS - elapsedSinceLastCheck)
    : 0;
  const delayMs = Math.max(LIVE_WARNING_DEBOUNCE_MS, cooldownWait);

  liveAnalysisDebounceId = setTimeout(() => {
    liveAnalysisDebounceId = null;
    runLiveWarningAnalysis(snapshotText);
  }, delayMs);
}

async function selectPstFile() {
  if (!isElectron) {
    const pstInput = document.getElementById("pst-file-input");
    if (pstInput) {
      pstInput.value = "";
      pstInput.click();
    }
    return;
  }

  const filePath = await ipcRenderer.invoke("dialog:select-pst");
  if (!filePath) return;

  state.isExporting = true;
  setControls();
  setStatus("Loading PST through Outlook and scanning Sent Items...");
  elements.pstPath.textContent = filePath;
  elements.emailCount.textContent = "Scanning emails...";
  setProgress(0, 0);

  try {
    const result = await ipcRenderer.invoke("pst:load-via-outlook", { pstPath: filePath });
    if (!result?.emailsJsonPath) {
      throw new Error("Outlook returned no email dataset.");
    }

    const raw = fs.readFileSync(result.emailsJsonPath, "utf8");
    const emails = parseJsonText(raw);
    loadPreparedEmailData(filePath, emails);
    try {
      fs.unlinkSync(result.emailsJsonPath);
    } catch (_error) {
    }

    const fileLabel = path.basename(filePath);
    setStatus(`Loaded ${fileLabel} via Outlook COM. ${state.pstData.totalEmails} Sent Items emails found.`);
  } catch (error) {
    state.pstData = null;
    state.filteredEmails = [];
    renderEmptyTable("Could not read the selected PST file.");
    setStatus(`Failed to load PST: ${error.message}`);
    elements.emailCount.textContent = "Could not read the selected PST file.";
  } finally {
    state.isExporting = false;
  }

  updateTableCaption();
  setControls();
}

async function loadParsedPstData(filePath, options = {}) {
  const retries = Number.isFinite(options.retries) ? options.retries : 0;
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 1000;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      state.pstData = analyzer.parsePstFile(filePath);
      state.results = [];
      elements.pstPath.textContent = filePath;
      renderSummary();
      refreshFilters();
      updateTableCaption();
      return;
    } catch (error) {
      lastError = error;
      const code = String(error?.code || "").toUpperCase();
      const isRetryable =
        code === "EBUSY" ||
        code === "EPERM" ||
        /busy|locked|used by another process/i.test(String(error?.message || ""));

      if (!isRetryable || attempt >= retries) {
        throw error;
      }

      setStatus(
        `PST export finished. Waiting for Outlook to release the file (${attempt + 1}/${retries + 1})...`
      );
      await analyzer.delay(retryDelayMs);
    }
  }

  throw lastError;
}

function normalizeEmailList(emails) {
  const list = Array.isArray(emails) ? emails : emails ? [emails] : [];
  return list
    .map((email, index) => ({
      id: String(email?.id || `email-${index + 1}`),
      subject: String(email?.subject || "(No Subject)").trim() || "(No Subject)",
      recipients: String(email?.recipients || "(No Recipients)").trim() || "(No Recipients)",
      date: String(email?.date || ""),
      folderPath: String(email?.folderPath || "Outlook / Sent Items"),
      sender: String(email?.sender || ""),
      body: String(email?.body || ""),
      textForAnalysis: String(email?.textForAnalysis || email?.body || ""),
    }))
    .sort((left, right) => {
      const leftTime = left.date ? new Date(left.date).getTime() : 0;
      const rightTime = right.date ? new Date(right.date).getTime() : 0;
      return rightTime - leftTime;
    });
}

function loadPreparedEmailData(filePath, emails) {
  const normalizedEmails = normalizeEmailList(emails);
  state.pstData = {
    filePath,
    sentFolderCount: 1,
    totalEmails: normalizedEmails.length,
    emails: normalizedEmails,
  };
  state.results = [];
  elements.pstPath.textContent = filePath;
  renderSummary();
  refreshFilters();
  updateTableCaption();
}

async function exportPstFromOutlook() {
  const exportOptions = await ipcRenderer.invoke("dialog:save-pst");
  if (!exportOptions?.outputPath) {
    return;
  }

  state.isExporting = true;
  setControls();
  setStatus("Importing Sent Items from classic Outlook...");

  try {
    const result = await ipcRenderer.invoke("outlook:export-sent-pst", exportOptions);
    const exportedPath = result?.path || exportOptions.outputPath;
    if (result?.emailsJsonPath) {
      const raw = fs.readFileSync(result.emailsJsonPath, "utf8");
      const emails = parseJsonText(raw);
      loadPreparedEmailData(exportedPath, emails);
      try {
        fs.unlinkSync(result.emailsJsonPath);
      } catch (_error) {
      }
    } else {
      await loadParsedPstData(exportedPath, {
        retries: 12,
        retryDelayMs: 1000,
      });
    }

    setStatus(`Sent Items imported and loaded from ${exportedPath}`);
  } catch (error) {
    setStatus(`Sent email import failed: ${error.message}`);
  } finally {
    state.isExporting = false;
    setControls();
  }
}

function createErrorResult(email, error) {
  return {
    email,
    error: error.message || "Unknown analysis error.",
    analysis: {
      overallFlag: false,
      dimensions: [],
      notes: error.message || "Unknown analysis error.",
      highestScore: 1,
      highestDimensionName: "Unavailable",
    },
  };
}

async function runBatchAnalysis() {
  if (!state.filteredEmails.length) {
    setStatus("No emails match the selected filters.");
    return;
  }

  state.isAnalyzing = true;
  state.cancelRequested = false;
  state.results = [];
  renderSummary();
  renderEmptyTable("Analysis in progress...");
  setProgress(0, state.filteredEmails.length);
  updateTableCaption();
  setControls();
  setStatus("Batch analysis started.");

  for (let index = 0; index < state.filteredEmails.length; index += 1) {
    if (state.cancelRequested) {
      break;
    }

    const email = state.filteredEmails[index];
    setStatus(`Analyzing "${email.subject}" (${index + 1} of ${state.filteredEmails.length})...`);

    try {
      let analysis;
      if (isElectron) {
        analysis = await analyzer.analyzeEmailText(email.textForAnalysis, state.openaiApiKey);
      } else {
        const res = await window.apiClient.analyze(email.textForAnalysis);
        analysis = res.analysis;
      }
      state.results.push({ email, analysis, error: null });
    } catch (error) {
      state.results.push(createErrorResult(email, error));
    }

    renderTable();
    renderSummary();
    setProgress(index + 1, state.filteredEmails.length);
    updateTableCaption();
  }

  state.isAnalyzing = false;
  const cancelled = state.cancelRequested;
  state.cancelRequested = false;
  setControls();
  setStatus(cancelled ? "Batch analysis cancelled." : "Batch analysis completed.");
}

function cancelAnalysis() {
  if (!state.isAnalyzing) return;
  state.cancelRequested = true;
  setStatus("Cancelling batch analysis after the current email...");
  setControls();
}

async function exportToExcel() {
  if (!state.results.length) return;

  if (isElectron) {
    const exportPath = await ipcRenderer.invoke(
      "dialog:save-export",
      "ToxicRadar-Batch-Analysis.xlsx"
    );

    if (!exportPath) return;

    try {
      exporter.exportResults(state.results, exportPath);
      setStatus(`Excel export saved to ${exportPath}`);
    } catch (error) {
      setStatus(`Excel export failed. ${formatExcelSaveError(error)}`);
    }
  } else {
    try {
      await window.apiClient.exportResults(state.results);
      setStatus("Excel export downloaded successfully.");
    } catch (error) {
      setStatus(`Excel export failed: ${error.message}`);
    }
  }
}

async function openExcelLog() {
  if (isElectron) {
    try {
      const result = await ipcRenderer.invoke("excel:open-log");
      setComposeStatus(`Excel opened: ${result.path}`);
    } catch (error) {
      setComposeStatus(`Could not open Excel: ${error.message}`);
    }
  } else {
    window.apiClient.downloadExcel();
    setComposeStatus("Excel log download started.");
  }
}

async function chooseExcelLogPath() {
  if (isElectron) {
    try {
      const result = await ipcRenderer.invoke("excel:choose-log-path");
      if (!result?.path) {
        return;
      }

      state.composeLogPath = result.path;
      await refreshExcelDashboard({ silent: true });
      startExcelWatcher();
      setComposeStatus(`Excel file selected and dashboard refreshed: ${result.path}`);
    } catch (error) {
      setComposeStatus(`Could not update Excel file: ${error.message}`);
    }
  } else {
    const fileInput = document.getElementById("excel-file-input");
    if (fileInput) {
      fileInput.value = "";
      fileInput.click();
    }
  }
}

function openDetails(index) {
  let item = null;

  if (typeof index === "number") {
    item = state.results[index];
  } else if (index === "compose") {
    item = state.composeResult;
  } else if (index && typeof index === "object") {
    item = index.email && index.analysis ? index : index.detailItem || null;
  }

  if (!item) return;
  const criticalPhrases = extractCriticalPhrases(item);

  const subject = String(item.email.subject || "").trim();
  elements.modalTitle.textContent = subject;
  elements.modalRecipients.textContent = item.email.recipients || "";
  elements.modalDate.textContent = formatDate(item.email.date);
  elements.modalSender.textContent = item.email.sender || "";
  elements.modalTo.textContent = item.email.recipients || "";
  elements.modalDateFull.textContent = formatDate(item.email.date);
  elements.modalSubjectFull.innerHTML = subject ? renderHighlightedText(subject, criticalPhrases) : "";
  elements.modalBodyFull.innerHTML = renderHighlightedText(
    item.email.body || item.email.textForAnalysis || "(No message body)",
    criticalPhrases
  );
  elements.modalNotes.textContent = item.error ? item.error : item.analysis.notes || "No notes provided.";
  const rewrittenText = sanitizeSuggestedRewrite(item.analysis?.suggestedRewrite || "");
  elements.modalRewrite.textContent = rewrittenText;
  elements.modalRewriteSection.classList.toggle("hidden", !rewrittenText);
  elements.modalRewriteSection.parentElement?.classList.toggle("single-column", !rewrittenText);

  const dimensions = item.analysis.dimensions || [];
  elements.modalDimensions.innerHTML = dimensions.length
    ? dimensions
        .map(
          (dimension, dimensionIndex) => `
            <tr>
              <td>${escapeHtml(dimension.name)}</td>
              <td>${dimension.present ? "Yes" : "No"}</td>
              <td>${escapeHtml(`${getDisplayScoreEmoji(dimension.score)} ${dimension.score}`)}</td>
              <td>${renderEvidenceWithMarker(dimension, dimensionIndex + 1)}</td>
            </tr>
          `
        )
        .join("")
    : `
        <tr class="empty-row">
          <td colspan="4">${item.error ? "No dimensions available." : "No dimensions above the reporting threshold."}</td>
        </tr>
      `;

  openModal("details-modal");
}

function openSummaryDetails(index) {
  const row = state.dashboardSummary.emails[index];
  if (!row) {
    return;
  }

  openDetails(row.detailItem || buildDetailItemFromSummary(row));
}

// Biometrics State & Polling
let watchSessionId = null;
let watchPollInterval = null;
let currentStressLevel = "calm";
let currentBpm = null;
let watchConnected = false;

async function startWatchPairing() {
  try {
    elements.connectWatchBtn.disabled = true;
    elements.connectWatchBtn.textContent = "Pairing...";
    
    const res = await window.apiClient.pairWatch();
    watchSessionId = res.sessionId;
    elements.watchPairingCode.textContent = res.pairCode;
    elements.watchPairingCode.classList.remove("hidden");
    elements.connectWatchBtn.classList.add("hidden");

    // Start polling for connection
    if (watchPollInterval) clearInterval(watchPollInterval);
    watchPollInterval = setInterval(pollBiometrics, 2000);
  } catch (err) {
    console.error("Pairing error:", err);
    elements.connectWatchBtn.disabled = false;
    elements.connectWatchBtn.textContent = "Connect Watch";
  }
}

async function pollBiometrics() {
  if (!watchSessionId) return;
  
  try {
    const data = await window.apiClient.getBiometrics(watchSessionId);
    
    if (data.status === "paired" && !watchConnected) {
      watchConnected = true;
      elements.watchPairingCode.classList.add("hidden");
      elements.biometricBadge.classList.remove("hidden");
    }
    
    if (watchConnected && data.status === "paired") {
      updateBiometricUI(data);
    }
  } catch (err) {
    console.error("Polling error:", err);
  }
}

function updateBiometricUI(data) {
  if (data.bpm) {
    currentBpm = Math.round(data.bpm);
    elements.bpmValue.textContent = `${currentBpm} BPM`;
  }
  
  if (typeof data.stressScore === "number") {
    let level = "Calm";
    let color = "var(--success)"; // green
    currentStressLevel = "calm";
    
    if (data.stressScore > 75) {
      level = "High Stress";
      color = "var(--error)"; // red
      currentStressLevel = "high";
    } else if (data.stressScore > 50) {
      level = "Elevated";
      color = "var(--warning)"; // yellow
      currentStressLevel = "elevated";
    }
    
    elements.stressLevelLabel.textContent = level;
    elements.stressLevelLabel.style.color = color;
    elements.bpmValue.style.color = color;
  }
}


function bindEvents() {
  for (const button of elements.navButtons) {
    button.addEventListener("click", () => {
      if (button.dataset.view === "overview") {
        refreshDashboardInsightsFromExcel();
      }
      switchView(button.dataset.view, button.dataset.period || "");
    });
  }

  elements.openExcelBtn?.addEventListener("click", openExcelLog);
  elements.chooseExcelBtn?.addEventListener("click", chooseExcelLogPath);
  
  if (elements.connectWatchBtn) {
    elements.connectWatchBtn.addEventListener("click", startWatchPairing);
  }
  elements.negativeSummary.addEventListener("click", () => setSummaryFilter("negative"));
  elements.neutralSummary.addEventListener("click", () => setSummaryFilter("neutral"));
  elements.positiveSummary.addEventListener("click", () => setSummaryFilter("positive"));
  elements.negativeSummary.addEventListener("mouseenter", (event) => showSummaryMetricTooltip("negative", event));
  elements.negativeSummary.addEventListener("mousemove", positionSummaryMetricTooltip);
  elements.negativeSummary.addEventListener("mouseleave", hideTooltip);
  elements.neutralSummary.addEventListener("mouseenter", (event) => showSummaryMetricTooltip("neutral", event));
  elements.neutralSummary.addEventListener("mousemove", positionSummaryMetricTooltip);
  elements.neutralSummary.addEventListener("mouseleave", hideTooltip);
  elements.positiveSummary.addEventListener("mouseenter", (event) => showSummaryMetricTooltip("positive", event));
  elements.positiveSummary.addEventListener("mousemove", positionSummaryMetricTooltip);
  elements.positiveSummary.addEventListener("mouseleave", hideTooltip);
  elements.liveWarningInfo.addEventListener("mouseenter", (event) => {
    showTooltip(
      "Live Warning analyzes while you type and can use many API tokens. It turns off automatically after 5 minutes.",
      event,
      "wide"
    );
  });
  elements.liveWarningInfo.addEventListener("mousemove", positionSummaryMetricTooltip);
  elements.liveWarningInfo.addEventListener("mouseleave", hideTooltip);
  elements.clearSummaryFilter.addEventListener("click", () => setSummaryFilter("all"));
  elements.loadPstBtn.addEventListener("click", selectPstFile);
  elements.exportOutlookBtn.addEventListener("click", exportPstFromOutlook);
  elements.settingsBtn.addEventListener("click", () => {
    elements.settingsFeedback.textContent = "";
    applyTheme(getSavedTheme());
    openModal("settings-modal");
  });
  if (elements.themeBtnDark) {
    elements.themeBtnDark.addEventListener("click", () => applyTheme("dark"));
  }
  if (elements.themeBtnLight) {
    elements.themeBtnLight.addEventListener("click", () => applyTheme("light"));
  }
  elements.periodSelect.addEventListener("change", handleFilterChange);
  elements.reportMetricSelect.addEventListener("change", () => {
    state.reportChart.metric = elements.reportMetricSelect.value;
    saveUiPreferences({ reportMetric: state.reportChart.metric });
    updateReportDashboard();
  });
  elements.reportChartTypeSelect.addEventListener("change", () => {
    state.reportChart.type = elements.reportChartTypeSelect.value;
    saveUiPreferences({ reportChartType: state.reportChart.type });
    updateReportDashboard();
  });
  elements.reportPrevDay.addEventListener("click", () => {
    state.reportChart.dayOffset += 1;
    updateReportDashboard();
  });
  elements.reportNextDay.addEventListener("click", () => {
    state.reportChart.dayOffset = Math.max(0, state.reportChart.dayOffset - 1);
    updateReportDashboard();
  });
  elements.reportDayCalendarBtn.addEventListener("click", openReportDayPicker);
  elements.reportDayLabel.addEventListener("dblclick", openReportDayPicker);
  elements.reportDayPicker.addEventListener("change", () => {
    const selectedDate = parseDateInputValue(elements.reportDayPicker.value);
    const rows = state.dashboardSummary.emails || [];
    const anchorDate = getLatestReportDate(rows) || new Date();

    if (!selectedDate) {
      return;
    }

    state.reportChart.dayOffset = getDayDistance(selectedDate, anchorDate);
    updateReportDashboard();
  });
  elements.reportPrevMonth.addEventListener("click", () => {
    state.reportChart.monthOffset += 1;
    updateReportDashboard();
  });
  elements.reportNextMonth.addEventListener("click", () => {
    state.reportChart.monthOffset = Math.max(0, state.reportChart.monthOffset - 1);
    updateReportDashboard();
  });
  elements.reportPrevWeek.addEventListener("click", () => {
    state.reportChart.weekOffset += 1;
    updateReportDashboard();
  });
  elements.reportNextWeek.addEventListener("click", () => {
    state.reportChart.weekOffset = Math.max(0, state.reportChart.weekOffset - 1);
    updateReportDashboard();
  });
  elements.reportPrevYear.addEventListener("click", () => {
    state.reportChart.yearOffset += 1;
    updateReportDashboard();
  });
  elements.reportNextYear.addEventListener("click", () => {
    state.reportChart.yearOffset = Math.max(0, state.reportChart.yearOffset - 1);
    updateReportDashboard();
  });
  elements.reportLegend.addEventListener("click", (event) => {
    const button = event.target.closest("[data-report-series]");
    if (!button) return;

    const series = button.getAttribute("data-report-series");
    if (state.reportChart.hiddenSeries.has(series)) {
      state.reportChart.hiddenSeries.delete(series);
    } else {
      const allSeries = getReportLegendSeries().map((item) => item.key);
      const visibleSeries = allSeries.filter((key) => !state.reportChart.hiddenSeries.has(key));
      if (visibleSeries.length <= 1) {
        return;
      }
      state.reportChart.hiddenSeries.add(series);
    }

    updateReportDashboard();
  });
  elements.dimensionScoreTitle.addEventListener("mouseenter", (event) => {
    showTooltip(
      "Unit: points on a 0-100 Communication Quality Score scale. Formula: ((5 - average dimension score) / 4) * 100. Higher means more respectful communication.",
      event,
      "wide"
    );
  });
  elements.dimensionScoreTitle.addEventListener("mousemove", positionSummaryMetricTooltip);
  elements.dimensionScoreTitle.addEventListener("mouseleave", hideTooltip);
  elements.analyzeBtn.addEventListener("click", runBatchAnalysis);
  elements.cancelBtn.addEventListener("click", cancelAnalysis);
  elements.exportBtn.addEventListener("click", exportToExcel);
  elements.composeSendBtn.addEventListener("click", analyzeComposeMessage);
  elements.composeUndoRewriteBtn.addEventListener("click", undoComposeRewrite);
  elements.composeDetailsBtn.addEventListener("click", () => openDetails("compose"));
  elements.liveWarningToggle.addEventListener("click", (event) => {
    event.preventDefault();
    const enabled = !state.liveWarningEnabled;
    setLiveWarningMode(enabled);
    state.liveWarningDismissedForText = "";
    liveAnalysisRequestId += 1;
    setComposeStatus(
      enabled
        ? "Live Warning activated. It will check after the draft is long enough and changes meaningfully."
        : "Live Warning disabled. Use Send for Analysis to check the message."
    );
    if (enabled) {
      scheduleLiveWarningAnalysis();
    }
    elements.composeBody.focus();
  });
  elements.liveWarningNo.addEventListener("click", () => {
    const warningMode = state.liveWarningMode;
    if (warningMode === "live") {
      state.liveWarningDismissedForText = normalizeLiveText(elements.composeBody.value);
    }
    hideLiveWarning({ keepHighlights: warningMode === "live" });
    setComposeStatus(
      warningMode === "post-analysis"
        ? "Rewrite suggestion dismissed. You can keep the original message."
        : "Live warning dismissed. You can keep editing or send the message."
    );
  });
  elements.liveWarningYes.addEventListener("click", () => {
    if (state.liveWarningMode === "post-analysis") {
      applyComposeRewrite();
      hideLiveWarning();
      return;
    }

    const liveAnalysis = state.liveWarningAnalysis;
    if (liveAnalysis) {
      showPostAnalysisBubble(liveAnalysis);
      setComposeStatus("Suggested rewrite is ready. Choose Yes to apply it or No to keep editing.");
      return;
    }

    setComposeStatus("No suggested rewrite is available yet. Please wait for Live Warning to finish.");
  });
  elements.composeBody.addEventListener("input", () => {
    if (state.composeRewriteApplied && elements.composeBody.value !== state.composeOriginalBody) {
      state.composeRewriteApplied = false;
    }
    const currentText = normalizeLiveText(elements.composeBody.value);
    if (currentText !== state.liveWarningDismissedForText) {
      state.liveWarningDismissedForText = "";
    }
    hideLiveWarning({ keepHighlights: true });
    refreshComposeHighlightsFromCurrentText();
    scheduleLiveWarningAnalysis({ keepHighlights: true });
    if (!state.isComposeAnalyzing) {
      setComposeStatus(
        state.liveWarningEnabled
          ? "Ready for local analysis. Live checks now wait longer and only re-run after meaningful draft changes."
          : "Ready for local analysis."
      );
      setControls();
    }
  });
  elements.composeBody.addEventListener("scroll", syncComposeHighlightScroll);
  elements.composeBody.addEventListener("mousemove", showComposeHighlightTooltipAtPoint);
  elements.composeBody.addEventListener("mouseleave", hideTooltip);

  const excelFileInput = document.getElementById("excel-file-input");
  if (excelFileInput) {
    excelFileInput.addEventListener("change", async (event) => {
      const file = event.target?.files?.[0];
      if (!file) return;
      setComposeStatus(`Uploading ${file.name}...`);
      try {
        const res = await window.apiClient.uploadExcel(file);
        if (res.summary) {
          state.dashboardSummary = res.summary;
          if (res.excelPath) {
            state.composeLogPath = res.excelPath;
          }
          updateDashboardInsights();
          setComposeStatus(`${file.name}: ${res.imported ?? ""} emails saved to Firebase and loaded.`);
        }
      } catch (err) {
        setComposeStatus(`Failed to upload Excel: ${err.message}`);
      }
    });
  }

  const pstFileInput = document.getElementById("pst-file-input");
  if (pstFileInput) {
    pstFileInput.addEventListener("change", async (event) => {
      const file = event.target?.files?.[0];
      if (!file) return;
      state.isExporting = true;
      setControls();
      setStatus(`Uploading and scanning PST file (${file.name})...`);
      elements.pstPath.textContent = file.name;
      elements.emailCount.textContent = "Scanning emails...";
      setProgress(0, 0);

      try {
        const res = await window.apiClient.uploadPst(file);
        if (!res?.data?.emails?.length) {
          throw new Error("No sent emails found in this PST archive.");
        }
        loadPreparedEmailData(file.name, res.data.emails);
        setStatus(`Loaded ${file.name}. ${res.data.emails.length} Sent Items emails found.`);
      } catch (err) {
        state.pstData = null;
        state.filteredEmails = [];
        renderEmptyTable("Could not read the uploaded PST file.");
        setStatus(`Failed to load PST: ${err.message}`);
        elements.emailCount.textContent = "Could not read the selected PST file.";
      } finally {
        state.isExporting = false;
        updateTableCaption();
        setControls();
      }
    });
  }

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const summarySortButton = target.closest("[data-summary-sort]");
    if (summarySortButton) {
      sortSummaryBy(summarySortButton.getAttribute("data-summary-sort"));
      return;
    }

    const summaryRow = target.closest("[data-summary-index]");
    if (summaryRow) {
      openSummaryDetails(Number(summaryRow.getAttribute("data-summary-index")));
      return;
    }

    const detailsButton = target.closest("[data-details-index]");
    if (detailsButton) {
      openDetails(Number(detailsButton.getAttribute("data-details-index")));
      return;
    }

    const modalId = target.getAttribute("data-close-modal");
    if (modalId) {
      closeModal(modalId);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const summaryRow = target.closest("[data-summary-index]");
    if (!summaryRow) {
      return;
    }

    event.preventDefault();
    openSummaryDetails(Number(summaryRow.getAttribute("data-summary-index")));
  });
}

async function init() {
  cacheDom();
  applyUiPreferences();
  bindEvents();
  renderSummary();
  renderComposeResult();
  renderEmptyTable();
  updateTableCaption();
  setLiveWarningMode(false);
  setControls();
  const initialView = getInitialViewPreference();
  switchView(initialView.view, initialView.view === "reports" ? initialView.period : "");
  await loadComposeLogPath();
  await loadSettings();
}

document.addEventListener("DOMContentLoaded", init);
window.addEventListener("beforeunload", stopExcelWatcher);
