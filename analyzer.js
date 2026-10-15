const fs = require("fs");
const fetch = require("node-fetch");
const PSTExtractor = require("pst-extractor");

const ELTC_SYSTEM_PROMPT = `Role & Purpose
You are an Exploitative Leadership Training Coach (ELTC) - an expert communication analyst trained to detect and improve exploitative leadership tone in workplace emails.
Your role is to:
Identify harmful or exploitative leadership behaviors in written communication
Provide structured, evidence-based feedback
Transform messages into constructive, ethical, and development-focused communication

Core Task
Read the full email carefully
Evaluate across five behavioral dimensions:

1. Genuine Egoistic Behaviors
Self-serving language
Status-seeking or self-promotion
Centering personal recognition over team success

2. Taking Credit
Claiming ownership of others' work
Minimizing or omitting team contributions
Reframing group success as individual success

3. Exerting Pressure
Coercion, threats, or intimidation
Unrealistic deadlines framed aggressively
Language implying consequences for non-compliance

4. Undermining Development
Blocking growth opportunities
Dismissing learning, mentorship, or skill-building
Discouraging initiative or independent thinking

5. Manipulating
Guilt-tripping or emotional pressure
Gaslighting or reframing reality unfairly
Selective or deceptive phrasing to influence behavior

Output Format
1. Table (Default Output)
Use a Markdown table:
| Dimension | Present (Yes/No) | Score (1-5 + emoji) | Evidence (<=30 words) |

Machine-readable requirement:
The JSON response must always include all five dimensions, even when the score is 1.
Use the exact dimension names and order listed above.
For dimensions with score 1, set present to false and evidence to an empty string.

Scoring System
5 Very High: Explicit exploitative tone
4 High: Clear exploitative behavior
3 Moderate: Probable exploitative tone
2 Low: Minor or ambiguous signals
1 Minimal: Neutral or constructive

Rules
Present = Yes if score >= 3
In the human-readable table, show only dimensions with score >= 2.
In the machine-readable JSON, always include all five dimensions with scores 1-5.
Always include:
| Overall Flag | True/False | - | - |
Overall Flag = True if:
Any dimension >= 4 OR
Two or more dimensions >= 3
Also provide an overall toxicity score for the full email from 1 to 5 based on the complete message, not just the listed dimensions.

2. If No Issues Found
Return:
No exploitative leadership indicators detected. Communication appears respectful and professional.
No rewrite needed - message already uses a constructive tone.

Evidence Guidelines
Quote or paraphrase (<=30 words)
Start evidence with one quoted risky phrase or one bracketed risky phrase, then add a short explanation
Preferred formats:
"make sure I get full credit" - centers personal recognition over team contribution
[make sure I get full credit] - centers personal recognition over team contribution
Redact sensitive personal information when necessary
Evidence must be plain text only. Never include HTML, CSS, tags, attributes, class names, angle brackets, or strings such as highlight, span, style, or >.

Notes Section
After the table, include a short paragraph explaining:
Key exploitative behaviors detected
Likely impact on team morale, trust, or culture
General improvement guidance

Suggested Rewrite (Positive Tone)
Rewrite the entire email using constructive leadership principles.
Requirements:
Preserve the body structure (greeting, paragraphs, closing), but do NOT include a subject line
Maintain original intent and content
Replace harmful tone with: Clarity, Empathy, Collaboration, Accountability
Return plain email text only, with no markdown, no bold markers, no bullets, and no placeholder signatures such as [Your Name]

Example Transformation:
"Do this or don't bother showing up"
-> "Please aim to complete this on time, and let me know early if you need support."

Behavioral Principles
The rewrite should reflect:
Psychological safety
Recognition of team contributions
Transparent and fair communication
Encouragement of growth and autonomy
Respectful tone, even under pressure

Output Order
1. Table
2. Overall Flag
3. Notes
4. Suggested Rewrite

Use plain text only in evidence and suggestedRewrite. Never include HTML, CSS, tags, attributes, or fragments such as highlight, span, style, or >.`;

const OPENAI_ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "overallFlag",
    "overallToxicityScore",
    "overallToxicityLabel",
    "overallToxicityEmoji",
    "dimensions",
    "notes",
    "suggestedRewrite",
  ],
  properties: {
    overallFlag: { type: "boolean" },
    overallToxicityScore: { type: "integer", minimum: 1, maximum: 5 },
    overallToxicityLabel: {
      type: "string",
      enum: ["Minimal", "Low", "Moderate", "High", "Very High"],
    },
    overallToxicityEmoji: {
      type: "string",
      enum: ["⚪️", "🟢", "🟡", "🟠", "🔴"],
    },
    dimensions: {
      type: "array",
      minItems: 5,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "present", "score", "emoji", "evidence"],
        properties: {
          name: { type: "string" },
          present: { type: "boolean" },
          score: { type: "integer", minimum: 1, maximum: 5 },
          emoji: {
            type: "string",
            enum: ["⚪️", "🟢", "🟡", "🟠", "🔴"],
          },
          evidence: { type: "string" },
        },
      },
    },
    notes: { type: "string" },
    suggestedRewrite: { type: "string" },
  },
};

const REQUIRED_DIMENSIONS = [
  "Genuine Egoistic Behaviors",
  "Taking Credit",
  "Exerting Pressure",
  "Undermining Development",
  "Manipulating",
];

const OPENAI_ANALYSIS_MODEL = "gpt-4o-mini";

function getScoreEmoji(score) {
  const normalized = Math.max(1, Math.min(5, Math.round(Number(score) || 1)));
  if (normalized >= 5) return "🔴";
  if (normalized >= 4) return "🟠";
  if (normalized >= 3) return "🟡";
  if (normalized >= 2) return "🟢";
  return "🟢";
}

const SENT_FOLDER_NAMES = [
  "sent items",
  "sent mail",
  "sent messages",
  "gesendete elemente",
  "gesendete objekte",
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\u0000/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeFolderName(name) {
  return String(name || "").trim().toLowerCase();
}

function isSentFolder(folder) {
  return SENT_FOLDER_NAMES.includes(normalizeFolderName(folder?.displayName));
}

function getMessageDate(message) {
  const raw =
    message?.clientSubmitTime ||
    message?.messageDeliveryTime ||
    message?.creationTime ||
    null;

  if (!raw) return null;
  const date = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getMessageRecipients(message) {
  return [message?.displayTo, message?.displayCC, message?.displayBCC]
    .filter(Boolean)
    .join("; ")
    .replace(/\s*;\s*;\s*/g, "; ")
    .trim();
}

function getMessageBody(message) {
  const plainText = normalizeText(message?.body || "");
  if (plainText) return plainText;

  const htmlText = normalizeText(stripHtml(message?.bodyHTML || ""));
  if (htmlText) return htmlText;

  return "";
}

function createEmailRecord(message, folderPath, index) {
  const body = getMessageBody(message);
  const date = getMessageDate(message);

  return {
    id: `${folderPath}::${index}::${String(message?.subject || "").slice(0, 60)}`,
    subject: String(message?.subject || "(No Subject)").trim() || "(No Subject)",
    recipients: getMessageRecipients(message) || "(No Recipients)",
    date: date ? date.toISOString() : "",
    folderPath,
    sender: String(message?.senderName || message?.sentRepresentingName || "").trim(),
    body,
    textForAnalysis: body,
  };
}

function walkFolders(folder, lineage = [], sentFolders = []) {
  const currentLineage = [...lineage, String(folder?.displayName || "Root")];
  if (isSentFolder(folder)) {
    sentFolders.push({
      folder,
      folderPath: currentLineage.join(" / "),
    });
  }

  if (!folder?.hasSubfolders) {
    return sentFolders;
  }

  const subFolders = folder.getSubFolders() || [];
  for (const subFolder of subFolders) {
    walkFolders(subFolder, currentLineage, sentFolders);
  }

  return sentFolders;
}

function collectFolderEmails(folder, folderPath, emails) {
  if (!folder || Number(folder.contentCount || 0) <= 0) {
    return;
  }

  let index = 0;
  for (let item = folder.getNextChild(); item != null; item = folder.getNextChild()) {
    const body = getMessageBody(item);
    const subject = String(item?.subject || "").trim();
    const looksLikeMail = Boolean(
      body ||
      subject ||
      item?.displayTo ||
      item?.messageClass === "IPM.Note"
    );

    if (looksLikeMail) {
      emails.push(createEmailRecord(item, folderPath, index));
    }

    index += 1;
  }
}

function parsePstFile(filePath) {
  const pstBuffer = fs.readFileSync(filePath);
  const pst = new PSTExtractor.PSTFile(pstBuffer);
  const rootFolder = pst.getRootFolder();
  const sentFolders = walkFolders(rootFolder);
  const emails = [];

  for (const entry of sentFolders) {
    collectFolderEmails(entry.folder, entry.folderPath, emails);
  }

  emails.sort((left, right) => {
    const leftTime = left.date ? new Date(left.date).getTime() : 0;
    const rightTime = right.date ? new Date(right.date).getTime() : 0;
    return rightTime - leftTime;
  });

  return {
    filePath,
    sentFolderCount: sentFolders.length,
    totalEmails: emails.length,
    emails,
  };
}

function applyFilters(emails, filters = {}) {
  const period = String(filters.period || "all");
  const now = new Date();

  return (emails || []).filter((email) => {
    if (period === "all") {
      return true;
    }

    if (period === "today") {
      if (!email.date) return false;
      const emailDate = new Date(email.date);
      return (
        emailDate.getFullYear() === now.getFullYear() &&
        emailDate.getMonth() === now.getMonth() &&
        emailDate.getDate() === now.getDate()
      );
    }

    const days = Number(period);
    if (!Number.isFinite(days) || days <= 0 || !email.date) {
      return false;
    }

    const emailDate = new Date(email.date);
    const ageInDays = (now.getTime() - emailDate.getTime()) / (1000 * 60 * 60 * 24);
    return ageInDays <= days;
  });
}

function extractOpenAIText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const output = Array.isArray(data?.output) ? data.output : [];
  const texts = output.flatMap((item) => {
    const content = Array.isArray(item?.content) ? item.content : [];
    return content
      .filter((part) => typeof part?.text === "string")
      .map((part) => part.text);
  });

  return texts.join("\n").trim();
}

function getToxicityMeta(score) {
  const normalized = Math.max(1, Math.min(5, Math.round(Number(score) || 1)));
  const map = {
    1: { label: "Minimal", emoji: "⚪️" },
    2: { label: "Low", emoji: "🟢" },
    3: { label: "Moderate", emoji: "🟡" },
    4: { label: "High", emoji: "🟠" },
    5: { label: "Very High", emoji: "🔴" },
  };

  return { score: normalized, ...map[normalized] };
}

function calculateOverallToxicityScore(parsedDimensions, overallFlag, parsedScore) {
  if (Number.isFinite(parsedScore)) {
    return getToxicityMeta(parsedScore).score;
  }

  const scores = Array.isArray(parsedDimensions)
    ? parsedDimensions.map((dimension) => Number(dimension?.score) || 0).filter(Boolean)
    : [];

  if (scores.length === 0) {
    return overallFlag ? 3 : 1;
  }

  const maxScore = Math.max(...scores);
  const averageScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;

  if (overallFlag) {
    return Math.max(maxScore, Math.round(averageScore));
  }

  return Math.max(1, Math.round(averageScore));
}

function normalizeEvidence(evidence) {
  if (typeof evidence !== "string") return "";

  const cleaned = evidence
    .replace(/&lt;\s*\/?\s*span[^&]*&gt;/gi, "")
    .replace(/<\s*\/?\s*span[^>]*>/gi, "")
    .replace(/class\s*=\s*["']?highlight["']?\s*>?/gi, "")
    .replace(/["']?\s*highlight["']?\s*&gt;\s*/gi, "")
    .replace(/["']?\s*highlight["']?\s*>\s*/gi, "")
    .replace(/["']?\bhighlight\b["']?/gi, "")
    .replace(/&quot;?highlight&quot;?\s*&gt;\s*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!cleaned) return "";

  let normalized = cleaned;
  const firstBracket = cleaned.indexOf("[");
  const firstQuote = cleaned.indexOf("\"");
  const markerPositions = [firstBracket, firstQuote].filter((position) => position >= 0);
  if (markerPositions.length > 0) {
    normalized = cleaned.slice(Math.min(...markerPositions)).trim();
  }
  normalized = normalized.replace(/^[\s,;:.!-]+/, "").trim();

  if (!normalized) return "";

  const bracketMatch = normalized.match(/\[([^\]]{4,160})\]/);
  if (bracketMatch) {
    const bracketed = `[${bracketMatch[1].trim()}]`;
    const rest = normalized.replace(bracketMatch[0], "").replace(/^[\s,;:.!-]+/, "").trim();
    return rest ? `${bracketed} - ${rest}` : bracketed;
  }

  const quoteMatch = normalized.match(/"([^"]{4,160})"/);
  if (quoteMatch) {
    const quoted = `"${quoteMatch[1].trim()}"`;
    const rest = normalized.replace(quoteMatch[0], "").replace(/^[\s,;:.!-]+/, "").trim();
    return rest ? `${quoted} - ${rest}` : quoted;
  }

  return normalized;
}

function normalizeEvidencePhrases(value, score) {
  if (score < 2 || !Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const phrases = [];

  for (const item of value) {
    const phrase = String(item || "")
      .replace(/\s+/g, " ")
      .trim();
    const key = phrase.toLowerCase();
    if (!phrase || phrase.length < 3 || seen.has(key)) {
      continue;
    }

    seen.add(key);
    phrases.push(phrase);
    if (phrases.length >= 5) {
      break;
    }
  }

  return phrases;
}

function normalizeAnalysisPayload(parsed) {
  const parsedDimensions = Array.isArray(parsed?.dimensions) ? parsed.dimensions : [];
  const parsedDimensionMap = new Map(
    parsedDimensions.map((dimension) => [String(dimension?.name || "").trim(), dimension])
  );
  const normalizedDimensions = REQUIRED_DIMENSIONS.map((name) => {
    const dimension = parsedDimensionMap.get(name) || {};
    const score = Math.max(1, Math.min(5, Math.round(Number(dimension?.score) || 1)));
    return {
      name,
      present: score >= 3,
      score,
      emoji: getScoreEmoji(score),
      evidence: score >= 2 ? normalizeEvidence(dimension?.evidence) : "",
    };
  });

  const dimensionsAtOrAboveThree = normalizedDimensions.filter((dimension) => dimension.score >= 3).length;
  const computedOverallFlag =
    normalizedDimensions.some((dimension) => dimension.score >= 4) ||
    dimensionsAtOrAboveThree >= 2;
  const overallFlag = Boolean(parsed?.overallFlag) || computedOverallFlag;
  const toxicity = getToxicityMeta(
    calculateOverallToxicityScore(
      normalizedDimensions,
      overallFlag,
      Number(parsed?.overallToxicityScore)
    )
  );

  const highestDimension = normalizedDimensions.reduce((highest, current) => {
    if (!highest || current.score > highest.score) {
      return current;
    }
    return highest;
  }, null);

  return {
    overallFlag,
    overallToxicityScore: toxicity.score,
    overallToxicityLabel:
      typeof parsed?.overallToxicityLabel === "string" && parsed.overallToxicityLabel.trim()
        ? parsed.overallToxicityLabel
        : toxicity.label,
    overallToxicityEmoji:
      typeof parsed?.overallToxicityEmoji === "string" && parsed.overallToxicityEmoji.trim()
        ? parsed.overallToxicityEmoji
        : toxicity.emoji,
    dimensions: normalizedDimensions,
    notes: typeof parsed?.notes === "string" ? parsed.notes : "",
    suggestedRewrite:
      typeof parsed?.suggestedRewrite === "string" ? parsed.suggestedRewrite : "",
    highestScore: highestDimension ? highestDimension.score : toxicity.score,
    highestDimensionName: highestDimension && highestDimension.score > 1 ? highestDimension.name : "None",
  };
}

async function requestAnalysisOnce(emailText, openaiApiKey, biometrics = null) {
  let instructions = ELTC_SYSTEM_PROMPT;
  if (biometrics && biometrics.stressLevel) {
    instructions += `\n\n[BIOMETRICS CONTEXT]\nThe author's current stress level based on Apple Watch biometrics is: ${biometrics.stressLevel.toUpperCase()} (Heart Rate: ${biometrics.bpm} BPM).\nIf the stress level is elevated or high, consider that the author might be unintentionally projecting frustration, exerting pressure, or undermining development due to their emotional state. Highlight this in the notes if relevant.`;
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiApiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_ANALYSIS_MODEL,
      temperature: 0,
      instructions: instructions,
      input: `Please analyze this email:\n\n${emailText}`,
      text: {
        format: {
          type: "json_schema",
          name: "eltc_analysis",
          strict: true,
          schema: OPENAI_ANALYSIS_SCHEMA,
        },
      },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || "OpenAI API request failed.");
  }

  const raw = extractOpenAIText(data);
  const clean = raw.replace(/```json|```/g, "").trim();
  if (!clean) {
    throw new Error("OpenAI returned an empty response.");
  }

  const parsed = JSON.parse(clean);
  return {
    ...normalizeAnalysisPayload(parsed),
    biometrics: biometrics || null,
    usage: data?.usage || null,
    model: data?.model || OPENAI_ANALYSIS_MODEL,
  };
}

async function analyzeEmailText(emailText, openaiApiKey, biometrics = null) {
  const maxRetries = 3;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      await delay(200);
      return await requestAnalysisOnce(emailText, openaiApiKey, biometrics);
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        await delay(2000);
      }
    }
  }

  throw lastError || new Error("Analysis failed after multiple attempts.");
}

module.exports = {
  OPENAI_ANALYSIS_MODEL,
  ELTC_SYSTEM_PROMPT,
  delay,
  parsePstFile,
  applyFilters,
  analyzeEmailText,
};
