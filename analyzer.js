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
  const normalized = normalizeAnalysisPayload(parsed);
  const factors = calculateBalanceFactors(emailText, normalized);
  return {
    ...normalized,
    pronounStats: factors.pronounStats,
    positiveFactor: factors.positiveFactor,
    negativeFactor: factors.negativeFactor,
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

// ==================== PRONOUN & EGOISTIC BIAS DETECTION ====================

const SINGULAR_PRONOUNS_REGEX = /\b(I|me|my|mine|myself)\b/gi;
const COLLECTIVE_IDENTIFIERS_REGEX = /\b(we|us|our|ours|ourselves|together|jointly|collaboratively)\b/gi;
const COLLECTIVE_PHRASES_REGEX = /\b(as a team|our team|the team|team members|all of us|with the team|together with)\b/gi;

function evaluatePronounBias(text) {
  const content = String(text || "").trim();
  if (!content) {
    return {
      singularCount: 0,
      collectiveCount: 0,
      totalCount: 0,
      singularRatio: 0,
      collectiveRatio: 0,
      isEgoisticSkew: false,
      severity: "none",
      coachingMessage: "",
      suggestedPhrasing: "",
      transformedText: "",
    };
  }

  const singularMatches = content.match(SINGULAR_PRONOUNS_REGEX) || [];
  const singularCount = singularMatches.length;

  const collectiveMatches = content.match(COLLECTIVE_IDENTIFIERS_REGEX) || [];
  const collectivePhrases = content.match(COLLECTIVE_PHRASES_REGEX) || [];
  const collectiveCount = collectiveMatches.length + collectivePhrases.length;

  const totalCount = singularCount + collectiveCount;
  const singularRatio = totalCount > 0 ? Math.round((singularCount / totalCount) * 100) / 100 : 0;
  const collectiveRatio = totalCount > 0 ? Math.round((collectiveCount / totalCount) * 100) / 100 : 0;

  // Skew threshold: At least 2 singular pronouns and either zero collective or singular ratio >= 65%
  const isEgoisticSkew = singularCount >= 2 && (collectiveCount === 0 || singularRatio >= 0.65);
  let severity = "none";
  if (singularCount >= 4 && (collectiveCount === 0 || singularRatio >= 0.75)) {
    severity = "high";
  } else if (isEgoisticSkew) {
    severity = "moderate";
  }

  let coachingMessage = "";
  if (isEgoisticSkew) {
    const sPct = Math.round(singularRatio * 100);
    const cPct = Math.round(collectiveRatio * 100);
    coachingMessage = `Egoistic Bias Alert: ${singularCount} singular references ("I", "me", "my") vs. ${collectiveCount} collective references ("we", "team") [${sPct}% vs. ${cPct}%]. Centering individual credit can diminish team psychological safety and trust.`;
  }

  // Generate team-centric phrasing conversion
  let transformedText = content;
  transformedText = transformedText
    .replace(/\bI completed\b/gi, "Our team completed")
    .replace(/\bI managed to\b/gi, "We managed to")
    .replace(/\bI achieved\b/gi, "Our team achieved")
    .replace(/\bI built\b/gi, "We built")
    .replace(/\bI delivered\b/gi, "Our team delivered")
    .replace(/\bI finished\b/gi, "We finished")
    .replace(/\bI decided\b/gi, "We agreed as a team")
    .replace(/\bI need you to\b/gi, "Let's work together to")
    .replace(/\bI want you to\b/gi, "Could we collaborate to")
    .replace(/\bI expect\b/gi, "Our goal is to have")
    .replace(/\bmy project\b/gi, "our project")
    .replace(/\bmy plan\b/gi, "our shared plan")
    .replace(/\bmy team\b/gi, "our team")
    .replace(/\bmy strategy\b/gi, "our collaborative strategy")
    .replace(/\bmy accomplishment\b/gi, "our team milestone")
    .replace(/\bmy goal\b/gi, "our shared goal")
    .replace(/\bto me\b/gi, "with our team")
    .replace(/\bsend me\b/gi, "share with our team")
    .replace(/\bcontact me\b/gi, "connect with us");

  let suggestedPhrasing = "";
  if (transformedText !== content) {
    suggestedPhrasing = transformedText;
  } else if (isEgoisticSkew) {
    suggestedPhrasing = content
      .replace(/\bI\b/g, "We")
      .replace(/\bmy\b/gi, "our")
      .replace(/\bme\b/gi, "us");
  }

  return {
    singularCount,
    collectiveCount,
    totalCount,
    singularRatio,
    collectiveRatio,
    isEgoisticSkew,
    severity,
    coachingMessage,
    suggestedPhrasing,
    transformedText,
  };
}

function calculateBalanceFactors(text, analysis = {}) {
  const bias = evaluatePronounBias(text);
  const toxicity = Number(analysis.overallToxicityScore || analysis.highestScore || analysis.overallToxicity) || 1;
  const dimensions = Array.isArray(analysis.dimensions) ? analysis.dimensions : [];

  // Positive factor: collective identifiers + constructive leadership bonus
  const constructiveBonus = toxicity <= 2 ? 3 : (toxicity === 3 ? 1 : 0);
  const positiveFactor = bias.collectiveCount * 2 + constructiveBonus;

  // Negative factor: singular egoistic count + high toxicity / dimension penalties
  let dimensionPenalty = 0;
  for (const dim of dimensions) {
    const score = Number(dim.score) || 1;
    if (score >= 4) dimensionPenalty += 3;
    else if (score === 3) dimensionPenalty += 1;
  }
  const toxicityPenalty = toxicity >= 4 ? 4 : (toxicity === 3 ? 2 : 0);
  const negativeFactor = bias.singularCount * 1.5 + toxicityPenalty + dimensionPenalty;

  return {
    positiveFactor: Math.round(positiveFactor * 10) / 10,
    negativeFactor: Math.round(negativeFactor * 10) / 10,
    pronounStats: bias,
  };
}

// ==================== NON-EXPLOITATIVE INLINE AUTO-COMPLETE ====================

const AUTOCOMPLETE_SYSTEM_PROMPT = `You are an inline workplace writing coach for Exploitative Leadership Detection.
The author is drafting an email. Complete their current sentence or thought with a concise, natural continuation (4 to 12 words).
STRICT PSYCHOLOGICAL SAFETY GUARDRAILS:
- The continuation MUST be collaborative, psychologically safe, constructive, and respectful.
- Strictly AVOID high-pressure, intimidating, passive-aggressive, or egoistic language.
- DO NOT repeat what the user typed. Start immediately with the continuation words.
- Return ONLY the raw continuation string. Do not use quotes, explanations, or conversational filler.`;

function getOfflineCollaborativeCompletion(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";

  const rules = [
    { pattern: /\b(let me know if)\s*$/i, completion: "we can review this together during our next sync." },
    { pattern: /\b(please make sure)\s*$/i, completion: "the team has all the resources needed to succeed." },
    { pattern: /\b(we need to)\s*$/i, completion: "align as a group to deliver our shared goals." },
    { pattern: /\b(i wanted to)\s*$/i, completion: "share this update and see how our team can collaborate on it." },
    { pattern: /\b(can you please|could you please)\s*$/i, completion: "take a look when you have a moment, and let me know if you need support." },
    { pattern: /\b(thanks for|thank you for)\s*$/i, completion: "everyone's hard work and commitment to our team's success." },
    { pattern: /\b(i think we should)\s*$/i, completion: "discuss this together to ensure every perspective is heard." },
    { pattern: /\b(as a team,? we)\s*$/i, completion: "can tackle this together while maintaining open communication." },
    { pattern: /\b(could you|can you)\s*$/i, completion: "let us know what support our team can provide on this?" },
    { pattern: /\b(looking forward to)\s*$/i, completion: "collaborating on this and achieving great results together." },
    { pattern: /\b(moving forward,?)\s*$/i, completion: "let's maintain clear visibility and psychological safety across the team." },
    { pattern: /\b(our goal is to)\s*$/i, completion: "support one another while delivering high-quality work." },
    { pattern: /\b(don't hesitate to|feel free to)\s*$/i, completion: "reach out if you need assistance or want to talk things through." },
    { pattern: /\b(i would appreciate)\s*$/i, completion: "your feedback so we can refine our team's approach." },
    { pattern: /\b(to ensure we)\s*$/i, completion: "stay on track, let's keep communication open across the team." },
    { pattern: /\b(i will make sure)\s*$/i, completion: "our team has the support and clarity needed for this." },
    { pattern: /\b(if you have any)\s*$/i, completion: "questions or concerns, my door is always open." },
    { pattern: /\b(great job on)\s*$/i, completion: "this milestone, the team's effort made all the difference." },
  ];

  for (const rule of rules) {
    if (rule.pattern.test(trimmed)) {
      return rule.completion;
    }
  }

  if (/,\s*$/.test(trimmed)) {
    return "and please let me know how our team can help.";
  }
  if (/\b(and|or|so|but)\s*$/i.test(trimmed)) {
    return "we can connect to align on next steps together.";
  }
  return "and let's connect if anyone needs additional support or clarity.";
}

async function generateAutocomplete(contextText, apiKey) {
  const trimmed = String(contextText || "").trim();
  if (trimmed.length < 8) {
    return { suggestion: "", source: "none" };
  }

  const effectiveKey = String(apiKey || process.env.OPENAI_API_KEY || "").trim();

  // If no API key or offline, use the rule-based psychological safety engine
  if (!effectiveKey) {
    return {
      suggestion: getOfflineCollaborativeCompletion(trimmed),
      source: "offline-rules",
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${effectiveKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_ANALYSIS_MODEL,
        temperature: 0.2,
        max_tokens: 35,
        messages: [
          { role: "system", content: AUTOCOMPLETE_SYSTEM_PROMPT },
          { role: "user", content: `Email drafting context:\n"${trimmed}"\n\nContinue with a collaborative next phrase:` },
        ],
      }),
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`ChatGPT autocomplete failed (${response.status})`);
    }

    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content || "";
    let suggestion = raw.replace(/^["'\s]+|["'\s]+$/g, "").trim();

    // Guardrail check: ensure suggestion is not empty and reasonably short
    if (!suggestion || suggestion.length > 120) {
      suggestion = getOfflineCollaborativeCompletion(trimmed);
    }

    return { suggestion, source: "chatgpt" };
  } catch (_err) {
    // Graceful offline fallback
    return {
      suggestion: getOfflineCollaborativeCompletion(trimmed),
      source: "offline-fallback",
    };
  }
}

// ==================== DYNAMIC LEADERSHIP TRAINING MODULES ====================

const STRUCTURED_TRAINING_MODULES = [
  {
    id: "servant-leadership",
    category: "Servant Leadership",
    title: "Servant Leadership & Shared Credit",
    targetDimension: "Genuine Egoistic Behaviors",
    duration: "8 min read",
    objective: "Transition from individual self-promotion ('I/Me') to collective recognition ('We/Team') that builds psychological ownership and team cohesion.",
    badExample: "I delivered this project on time and I expect senior leadership to acknowledge my hard work.",
    goodExample: "Our team delivered this project on time together; I am deeply grateful for everyone's dedication to this milestone.",
    habits: [
      "Use 'We' instead of 'I' when communicating team accomplishments to leadership.",
      "Explicitly name and praise contributing colleagues in project updates.",
      "Frame leadership as removing obstacles for your team rather than directing credit upward.",
    ],
  },
  {
    id: "psychological-safety",
    category: "Psychological Safety",
    title: "Psychological Safety & De-escalating Pressure",
    targetDimension: "Exerting Pressure",
    duration: "7 min read",
    objective: "Communicate high-priority deadlines and expectations without intimidation, ultimatum language, or inducing anxiety.",
    badExample: "Have this finished by 5 PM today or don't bother coming to the client presentation.",
    goodExample: "Our team target is to wrap this up by 5 PM. Please let me know early if you run into blockers so we can support you.",
    habits: [
      "Pair urgent requests with open offers of support and resource removal.",
      "Avoid implied threats or punitive framing around unexpected delays.",
      "Encourage team members to surface roadblocks early without fear of blame.",
    ],
  },
  {
    id: "collaborative-influence",
    category: "Collaborative Communication",
    title: "Collaborative Communication & Transparent Influence",
    targetDimension: "Manipulating Followers",
    duration: "9 min read",
    objective: "Eliminate guilt-tripping and emotional manipulation in favor of transparent, respectful, and direct workplace dialogue.",
    badExample: "After everything leadership has done for you, the least you could do is take on this weekend workload.",
    goodExample: "We have an unexpected weekend coverage need. Let's discuss as a team who has capacity or how we can balance the schedule.",
    habits: [
      "State business objectives directly without attaching personal guilt or moral obligation.",
      "Invite genuine two-way feedback before finalizing operational decisions.",
      "Separate objective project needs from emotional leverage.",
    ],
  },
  {
    id: "autonomy-support",
    category: "Autonomy Support",
    title: "Autonomy Support & Follower Development",
    targetDimension: "Undermining Development",
    duration: "8 min read",
    objective: "Foster junior and team initiative by mentoring through questions rather than micromanaging or dismissing independent thought.",
    badExample: "Just stick to the instructions given; you don't have enough seniority to suggest changes.",
    goodExample: "I value your initiative in looking at this process. Let's review your proposal together during our next 1-on-1.",
    habits: [
      "Ask 'What approach do you recommend?' before prescribing a solution.",
      "Delegate problem ownership, not merely mechanical task execution.",
      "Celebrate constructive experimentation and frame missteps as collective learning.",
    ],
  },
];

function getTrainingRecommendations(context = {}) {
  const negativeScore = Number(context.negativeScore || context.overallToxicityScore || 1);
  const egoisticSkew = Boolean(context.isEgoisticSkew);
  const dimensionNames = Array.isArray(context.dimensions)
    ? context.dimensions.map((d) => (d.name || d).toLowerCase())
    : [];

  // Sort modules dynamically so the most relevant topic is presented first
  const sorted = [...STRUCTURED_TRAINING_MODULES].sort((a, b) => {
    let scoreA = 0;
    let scoreB = 0;
    if (egoisticSkew && a.id === "servant-leadership") scoreA += 10;
    if (egoisticSkew && b.id === "servant-leadership") scoreB += 10;

    if (dimensionNames.some((d) => d.includes("pressure")) && a.id === "psychological-safety") scoreA += 8;
    if (dimensionNames.some((d) => d.includes("pressure")) && b.id === "psychological-safety") scoreB += 8;

    if (dimensionNames.some((d) => d.includes("manipulat")) && a.id === "collaborative-influence") scoreA += 8;
    if (dimensionNames.some((d) => d.includes("manipulat")) && b.id === "collaborative-influence") scoreB += 8;

    if (dimensionNames.some((d) => d.includes("development")) && a.id === "autonomy-support") scoreA += 8;
    if (dimensionNames.some((d) => d.includes("development")) && b.id === "autonomy-support") scoreB += 8;

    return scoreB - scoreA;
  });

  return {
    modules: sorted,
    negativeIndex: negativeScore,
    recommendedCount: sorted.length,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  OPENAI_ANALYSIS_MODEL,
  ELTC_SYSTEM_PROMPT,
  delay,
  parsePstFile,
  applyFilters,
  analyzeEmailText,
  evaluatePronounBias,
  calculateBalanceFactors,
  generateAutocomplete,
  getOfflineCollaborativeCompletion,
  getTrainingRecommendations,
  STRUCTURED_TRAINING_MODULES,
};
