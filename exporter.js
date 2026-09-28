const XLSX = require("xlsx");

function ensureWorkbook(targetPath) {
  try {
    return XLSX.readFile(targetPath);
  } catch (_error) {
    return XLSX.utils.book_new();
  }
}

function readSheetRows(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    return [];
  }

  return XLSX.utils.sheet_to_json(sheet, { defval: "" });
}

function upsertSheet(workbook, sheetName, rows) {
  const sheet = XLSX.utils.json_to_sheet(rows);

  if (workbook.SheetNames.includes(sheetName)) {
    workbook.Sheets[sheetName] = sheet;
    return;
  }

  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
}

function ensureWorksheetHeader(worksheet, headerRow) {
  if (!worksheet || !worksheet["!ref"]) {
    return XLSX.utils.aoa_to_sheet([headerRow]);
  }

  const range = XLSX.utils.decode_range(worksheet["!ref"]);
  const existingHeader = [];
  for (let columnIndex = 0; columnIndex < headerRow.length; columnIndex += 1) {
    const cell = worksheet[XLSX.utils.encode_cell({ r: 0, c: columnIndex })];
    existingHeader.push(cell ? String(cell.v || "") : "");
  }

  const headerMismatch = headerRow.some((label, index) => existingHeader[index] !== label);
  if (headerMismatch) {
    XLSX.utils.sheet_add_aoa(worksheet, [headerRow], { origin: "A1" });
    range.e.c = Math.max(range.e.c, headerRow.length - 1);
    worksheet["!ref"] = XLSX.utils.encode_range(range);
  }

  return worksheet;
}

function ensureWorksheetHeaderWithMappedRows(worksheet, headerRow) {
  if (!worksheet || !worksheet["!ref"]) {
    return XLSX.utils.aoa_to_sheet([headerRow]);
  }

  const rows = getSheetRows(worksheet);
  const existingHeader = Array.isArray(rows[0]) ? rows[0].map((cell) => String(cell || "")) : [];
  const headerMatches =
    existingHeader.length >= headerRow.length &&
    headerRow.every((label, index) => existingHeader[index] === label);

  if (headerMatches) {
    return worksheet;
  }

  const columnByLabel = new Map();
  existingHeader.forEach((label, index) => {
    if (label && !columnByLabel.has(label)) {
      columnByLabel.set(label, index);
    }
  });

  const mappedRows = rows.slice(1).map((row) =>
    headerRow.map((label) => {
      const sourceIndex = columnByLabel.get(label);
      return sourceIndex == null ? "" : row[sourceIndex] || "";
    })
  );

  return XLSX.utils.aoa_to_sheet([headerRow, ...mappedRows]);
}

function getSheetRows(worksheet) {
  if (!worksheet || !worksheet["!ref"]) return [];
  return XLSX.utils.sheet_to_json(worksheet, { header: 1, blankrows: false });
}

function isRowEmpty(row, expectedWidth) {
  if (!Array.isArray(row)) return true;

  for (let index = 0; index < expectedWidth; index += 1) {
    if (String(row[index] || "").trim() !== "") {
      return false;
    }
  }

  return true;
}

function findNextEmptyRowIndex(rows, headerRow) {
  const expectedWidth = Array.isArray(headerRow) ? headerRow.length : 0;
  if (!Array.isArray(rows) || rows.length === 0) {
    return 1;
  }

  for (let index = 1; index < rows.length; index += 1) {
    if (isRowEmpty(rows[index], expectedWidth)) {
      return index;
    }
  }

  return rows.length;
}

function toExcelDate(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("en-US");
}

function toSortableTimestamp(value) {
  if (!value) {
    return 0;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function safeParseJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(String(value).replace(/^\uFEFF/, ""));
  } catch (_error) {
    return null;
  }
}

function isTruthyFlag(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function toBooleanFlag(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value >= 1;
  }

  return isTruthyFlag(value);
}

const REQUIRED_DIMENSIONS = [
  "Genuine Egoistic Behaviors",
  "Taking Credit",
  "Exerting Pressure",
  "Undermining Development",
  "Manipulating",
];

function getScoreEmoji(score) {
  const normalized = Math.max(1, Math.min(5, Math.round(Number(score) || 1)));
  if (normalized >= 5) return "🔴";
  if (normalized >= 4) return "🟠";
  if (normalized >= 3) return "🟡";
  if (normalized >= 2) return "🟢";
  return "🟢";
}

function normalizeDashboardDimensions(dimensions, fallbackDimensions = {}) {
  const sourceMap = new Map(
    (Array.isArray(dimensions) ? dimensions : []).map((dimension) => [
      String(dimension?.name || "").trim(),
      dimension,
    ])
  );
  const fallbackByName = {
    "Genuine Egoistic Behaviors": fallbackDimensions.genuineEgoisticBehaviors,
    "Taking Credit": fallbackDimensions.takingCredit,
    "Exerting Pressure": fallbackDimensions.exertingPressure,
    "Undermining Development": fallbackDimensions.underminingDevelopment,
    Manipulating: fallbackDimensions.manipulating,
  };

  return REQUIRED_DIMENSIONS.map((name) => {
    const source = sourceMap.get(name) || {};
    const score = Math.max(1, Math.min(5, Math.round(Number(source.score ?? fallbackByName[name] ?? 1))));
    return {
      name,
      present: score >= 3,
      score,
      emoji: getScoreEmoji(score),
      evidence: String(source.evidence || ""),
      evidencePhrases: Array.isArray(source.evidencePhrases)
        ? source.evidencePhrases.map((phrase) => String(phrase || "").trim()).filter(Boolean).slice(0, 5)
        : [],
    };
  });
}

function getHighestDimensionName(dimensions) {
  const list = Array.isArray(dimensions) ? dimensions : [];
  let highest = null;

  for (const dimension of list) {
    const score = Number(dimension?.score) || 0;
    if (!highest || score > highest.score) {
      highest = {
        name: String(dimension?.name || ""),
        score,
      };
    }
  }

  return highest && highest.score > 1 ? highest.name : "None";
}

function exportResults(results, targetPath) {
  const workbook = XLSX.utils.book_new();
  const headerRow = [
    "Subject",
    "Original Text",
    "Rewritten Text",
    "Date",
    "Overall Toxicity",
    "Level",
    "Overall Flag",
    "Notes",
    "Genuine Egoistic Behaviors",
    "Taking Credit",
    "Exerting Pressure",
    "Undermining Development",
    "Manipulating",
    "Sender",
    "Recipients",
    "Record JSON",
  ];

  const rows = (results || []).map((item) => {
    const dimensions = normalizeDashboardDimensions(item.analysis?.dimensions || []);
    const scoreFor = (name) => dimensions.find((dimension) => dimension.name === name)?.score || 1;
    const savedAnalysis = item.analysis
      ? {
          ...item.analysis,
          dimensions,
        }
      : null;

    return [
      item.email.subject || "",
      item.email.textForAnalysis || item.email.body || "",
      item.analysis?.suggestedRewrite || "",
      toExcelDate(item.email.date || new Date()),
      item.error ? "" : item.analysis?.overallToxicityScore || "",
      item.error ? "" : item.analysis?.overallToxicityLabel || "",
      item.error ? "Error" : item.analysis?.overallFlag ? "True" : "False",
      item.error ? item.error : item.analysis?.notes || "",
      scoreFor("Genuine Egoistic Behaviors"),
      scoreFor("Taking Credit"),
      scoreFor("Exerting Pressure"),
      scoreFor("Undermining Development"),
      scoreFor("Manipulating"),
      item.email.sender || "",
      item.email.recipients || "",
      JSON.stringify({
        email: {
          subject: item.email.subject || "",
          recipients: item.email.recipients || "",
          sender: item.email.sender || "",
          date: item.email.date || "",
          body: item.email.body || "",
          textForAnalysis: item.email.textForAnalysis || item.email.body || "",
        },
        analysis: savedAnalysis,
        error: item.error || null,
      }),
    ];
  });

  const worksheet = XLSX.utils.aoa_to_sheet([headerRow, ...rows]);
  XLSX.utils.book_append_sheet(workbook, worksheet, "Auswertung");

  XLSX.writeFile(workbook, targetPath);
  return targetPath;
}

function appendComposeResult(result, targetPath, options = {}) {
  const workbook = ensureWorkbook(targetPath);
  let worksheet = workbook.Sheets["Auswertung"];
  const includeSuggestedRewrite = Boolean(options.includeSuggestedRewrite);

  if (!worksheet) {
    worksheet = XLSX.utils.aoa_to_sheet([]);
    XLSX.utils.book_append_sheet(workbook, worksheet, "Auswertung");
  }

  const headerRow = [
    "Subject",
    "Original Text",
    "Rewritten Text",
    "Date",
    "Overall Toxicity",
    "Level",
    "Overall Flag",
    "Notes",
    "Genuine Egoistic Behaviors",
    "Taking Credit",
    "Exerting Pressure",
    "Undermining Development",
    "Manipulating",
    "Sender",
    "Recipients",
    "Record JSON",
  ];

  worksheet = ensureWorksheetHeaderWithMappedRows(worksheet, headerRow);

  const dimensionScores = {
    egoistic:
      result.analysis?.dimensions?.find((item) => item.name === "Genuine Egoistic Behaviors")?.score || 1,
    credit:
      result.analysis?.dimensions?.find((item) => item.name === "Taking Credit")?.score || 1,
    pressure:
      result.analysis?.dimensions?.find((item) => item.name === "Exerting Pressure")?.score || 1,
    development:
      result.analysis?.dimensions?.find((item) => item.name === "Undermining Development")?.score || 1,
    manipulation:
      result.analysis?.dimensions?.find((item) => item.name === "Manipulating")?.score || 1,
  };

  const savedAnalysis = result.analysis
    ? {
        ...result.analysis,
        suggestedRewrite: includeSuggestedRewrite ? result.analysis.suggestedRewrite || "" : "",
      }
    : null;

  const newRow = [
    result.email.subject || "",
    result.email.textForAnalysis,
    includeSuggestedRewrite ? result.analysis?.suggestedRewrite || "" : "",
    toExcelDate(result.email.date || new Date()),
    result.error ? "" : result.analysis?.overallToxicityScore || "",
    result.error ? "" : result.analysis?.overallToxicityLabel || "",
    result.error ? "Error" : result.analysis?.overallFlag ? "True" : "False",
    result.error ? result.error : result.analysis?.notes || "",
    dimensionScores.egoistic,
    dimensionScores.credit,
    dimensionScores.pressure,
    dimensionScores.development,
    dimensionScores.manipulation,
    result.email.sender || "",
    result.email.recipients || "",
    JSON.stringify({
      email: {
        subject: result.email.subject || "",
        recipients: result.email.recipients || "",
        sender: result.email.sender || "",
        date: result.email.date || "",
        body: result.email.body || "",
        textForAnalysis: result.email.textForAnalysis || "",
      },
      analysis: savedAnalysis,
      error: result.error || null,
    }),
  ];

  const rows = getSheetRows(worksheet);
  const targetRowIndex = findNextEmptyRowIndex(rows, headerRow);
  XLSX.utils.sheet_add_aoa(worksheet, [newRow], {
    origin: `A${targetRowIndex + 1}`,
  });

  workbook.Sheets["Auswertung"] = worksheet;
  XLSX.writeFile(workbook, targetPath);
  return {
    path: targetPath,
    rowNumber: targetRowIndex + 1,
  };
}

function updateComposeRewrite(targetPath, rowNumber, rewrittenText) {
  if (!rowNumber) {
    return targetPath;
  }

  const workbook = ensureWorkbook(targetPath);
  const worksheet = workbook.Sheets["Auswertung"];
  if (!worksheet) {
    return targetPath;
  }

  const safeRewrite = String(rewrittenText || "");
  XLSX.utils.sheet_add_aoa(worksheet, [[safeRewrite]], { origin: `C${rowNumber}` });

  const recordCell = `P${rowNumber}`;
  const record = safeParseJson(worksheet[recordCell]?.v);
  if (record?.analysis) {
    record.analysis.suggestedRewrite = safeRewrite;
    XLSX.utils.sheet_add_aoa(worksheet, [[JSON.stringify(record)]], { origin: recordCell });
  }

  workbook.Sheets["Auswertung"] = worksheet;
  XLSX.writeFile(workbook, targetPath);
  return targetPath;
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function readDashboardSummary(targetPath) {
  const workbook = ensureWorkbook(targetPath);
  const rows = readSheetRows(workbook, "Auswertung");
  if (!rows.length) {
    return {
      totalEmails: 0,
      positivePercent: 0,
      neutralPercent: 0,
      negativePercent: 0,
      emails: [],
    };
  }

  let negativeCount = 0;
  let neutralCount = 0;

  for (const row of rows) {
    const highestScore = toNumber(row["Highest Score"]);
    const overallToxicity = toNumber(row["Overall Toxicity"]);
    const flagValue = row["Overall Flag"];

    const effectiveScore =
      highestScore != null ? highestScore : overallToxicity != null ? overallToxicity : null;

    if (effectiveScore === 3) {
      neutralCount += 1;
    } else if (effectiveScore != null ? effectiveScore > 3 : isTruthyFlag(flagValue)) {
      negativeCount += 1;
    }
  }

  const negativePercent = Math.round((negativeCount / rows.length) * 100);
  const neutralPercent = Math.round((neutralCount / rows.length) * 100);
  const positivePercent = 100 - negativePercent - neutralPercent;

  const emailRows = rows.map((row) => {
    const record = safeParseJson(row["Record JSON"]);
    const recordEmail = record?.email || {};
    const recordAnalysis = record?.analysis || {};
    const derivedOverallToxicity = toNumber(row["Overall Toxicity"]) ?? "";

    const summaryDimensions = Array.isArray(recordAnalysis.dimensions) ? recordAnalysis.dimensions : [];
    const fallbackDimensions = {
      genuineEgoisticBehaviors: toNumber(row["Genuine Egoistic Behaviors"]) ?? 1,
      takingCredit: toNumber(row["Taking Credit"]) ?? 1,
      exertingPressure: toNumber(row["Exerting Pressure"]) ?? 1,
      underminingDevelopment: toNumber(row["Undermining Development"]) ?? 1,
      manipulating: toNumber(row["Manipulating"]) ?? 1,
    };

    const derivedLevel =
      String(row.Level || "").trim() ||
      (derivedOverallToxicity >= 4
        ? "High"
        : derivedOverallToxicity === 3
          ? "Moderate"
          : derivedOverallToxicity
            ? "Low"
            : "");

    const subject = String(row.Subject || recordEmail.subject || "").trim();
    const originalText = String(row["Original Text"] || recordEmail.textForAnalysis || recordEmail.body || "").trim();
    const rewrittenText = String(row["Rewritten Text"] || recordAnalysis.suggestedRewrite || "").trim();
    const notes = String(row.Notes || recordAnalysis.notes || "").trim();
    const sender = String(row.Sender || recordEmail.sender || "").trim();
    const recipients = String(row.Recipients || recordEmail.recipients || "").trim();
    const date = String(row.Date || recordEmail.date || "").trim();
    const overallFlag = toBooleanFlag(row["Overall Flag"]) || Boolean(recordAnalysis.overallFlag);
    const rawDimensions = summaryDimensions.length
      ? summaryDimensions
      : [
          { name: "Genuine Egoistic Behaviors", score: fallbackDimensions.genuineEgoisticBehaviors },
          { name: "Taking Credit", score: fallbackDimensions.takingCredit },
          { name: "Exerting Pressure", score: fallbackDimensions.exertingPressure },
          { name: "Undermining Development", score: fallbackDimensions.underminingDevelopment },
          { name: "Manipulating", score: fallbackDimensions.manipulating },
        ].map((dimension) => ({
          name: dimension.name,
          present: Number(dimension.score) >= 3,
          score: Number(dimension.score) || 1,
          emoji: Number(dimension.score) >= 5
            ? "🔴"
            : Number(dimension.score) >= 4
              ? "🟠"
              : Number(dimension.score) >= 3
                ? "🟡"
                : Number(dimension.score) >= 2
                  ? "🟢"
                  : "⚪️",
          evidence: "",
          evidencePhrases: [],
        }));
    const dimensions = normalizeDashboardDimensions(rawDimensions, fallbackDimensions);

    const highestScoreFromDimensions = dimensions.reduce(
      (currentHighest, dimension) => Math.max(currentHighest, Number(dimension?.score) || 0),
      0
    );
    const highestDimensionName =
      String(recordAnalysis.highestDimensionName || "").trim() ||
      getHighestDimensionName(dimensions);

    return {
      subject,
      overallToxicity: derivedOverallToxicity,
      level: derivedLevel,
      genuineEgoisticBehaviors: fallbackDimensions.genuineEgoisticBehaviors,
      takingCredit: fallbackDimensions.takingCredit,
      exertingPressure: fallbackDimensions.exertingPressure,
      underminingDevelopment: fallbackDimensions.underminingDevelopment,
      manipulating: fallbackDimensions.manipulating,
      sender,
      recipients,
      date,
      notes,
      originalText,
      rewrittenText,
      overallFlag,
      highestScore: toNumber(row["Highest Score"]) ?? highestScoreFromDimensions,
      highestDimensionName,
      dimensions,
      detailItem: {
        email: {
          subject,
          recipients,
          sender,
          date,
          body: recordEmail.body || originalText,
          textForAnalysis: originalText,
        },
        analysis: {
          overallFlag,
          overallToxicityScore: derivedOverallToxicity,
          overallToxicityLabel: derivedLevel,
          overallToxicityEmoji: recordAnalysis.overallToxicityEmoji || "",
          highestScore: toNumber(row["Highest Score"]) ?? highestScoreFromDimensions,
          highestDimensionName,
          dimensions,
          notes,
          suggestedRewrite: rewrittenText,
        },
        error: row.Notes && String(row.Notes).toLowerCase().includes("error") ? String(row.Notes) : null,
      },
    };
  }).sort((left, right) => {
    const rightTimestamp = toSortableTimestamp(right.date);
    const leftTimestamp = toSortableTimestamp(left.date);

    if (rightTimestamp !== leftTimestamp) {
      return rightTimestamp - leftTimestamp;
    }

    return 0;
  });

  return {
    totalEmails: rows.length,
    positivePercent,
    neutralPercent,
    negativePercent,
    emails: emailRows,
  };
}

module.exports = {
  appendComposeResult,
  exportResults,
  readDashboardSummary,
  updateComposeRewrite,
};
