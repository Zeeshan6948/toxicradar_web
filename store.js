/**
 * ToxicRadar record store.
 *
 * Firebase is the single source of truth for analysed emails. Nothing is
 * written to local disk. If Firebase is NOT configured (local dev only), an
 * in-memory Map is used and a warning is logged - data is lost on restart.
 *
 * Firestore collections (prefixed with FIREBASE_COLLECTION_PREFIX, default "toxicradar"):
 *   toxicradar_compose_records/{id}   one document per analysed email
 *   toxicradar_import_batches/{id}    one document per Excel upload
 *
 * Record document:
 *   email:    { subject, sender, recipients, date, body, textForAnalysis }
 *   analysis: { overallFlag, overallToxicityScore, overallToxicityLabel, dimensions[5], notes, suggestedRewrite, ... } | null
 *   error:    string | null
 *   source:   "compose" | "excel-upload"
 *   batchId:  import batch id (uploads only)
 *   emailDate (ISO) / overallToxicity / level / flag: flat fields for querying in the Firebase console
 *   createdAt, updatedAt: ISO timestamps
 * Legacy documents (email / analysis / error / rowNumber / createdAt only) are read as-is.
 */

const crypto = require("crypto");
const firebase = require("./firebase");
const exporter = require("./exporter");
const analyzer = require("./analyzer");

const RECORDS = "compose_records";
const BATCHES = "import_batches";
const CACHE_TTL_MS = 5000;

const memory = new Map();
let warnedMemory = false;
let cache = null; // { at, records }

function useFirebase() {
  if (firebase.isConfigured()) return true;
  if (!warnedMemory) {
    warnedMemory = true;
    console.warn("[Store] Firebase is not configured - using in-memory storage (data is lost on restart).");
  }
  return false;
}

function invalidate() {
  cache = null;
}

function toIso(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

/** Deterministic id: re-uploading the same sheet updates records instead of duplicating them. */
function contentId(email) {
  const key = [email.subject, email.sender, email.recipients, email.date, email.textForAnalysis || email.body]
    .map((part) => String(part || "").trim())
    .join("\u241f");
  return `rec_${crypto.createHash("sha1").update(key).digest("hex").slice(0, 24)}`;
}

function toDocument(record, extra = {}) {
  const email = record.email || {};
  const analysis = record.analysis || null;
  const error = record.error ? String(record.error) : null;
  const now = new Date().toISOString();
  const balance = analyzer.calculateBalanceFactors(email.textForAnalysis || email.body || "", analysis || {});

  return {
    email,
    analysis,
    error,
    emailDate: toIso(email.date) || now,
    overallToxicity: Number(analysis?.overallToxicityScore) || 0,
    level: analysis?.overallToxicityLabel || "",
    flag: Boolean(analysis?.overallFlag),
    positiveFactor: record.positiveFactor ?? balance.positiveFactor,
    negativeFactor: record.negativeFactor ?? balance.negativeFactor,
    pronounStats: record.pronounStats ?? balance.pronounStats,
    createdAt: now,
    ...extra,
  };
}

async function writeDocs(rawDocs) {
  const docs = Array.from(new Map(rawDocs.map((doc) => [doc.id, doc])).values());
  if (useFirebase()) {
    await firebase.putDocs(RECORDS, docs);
  } else {
    docs.forEach(({ id, data }) => memory.set(id, { ...data, _id: id }));
  }
  invalidate();
}

/** Save one analysed email (compose flow). Returns the record id. */
async function addComposeResult(composeResult) {
  const result = { ...composeResult, email: { ...(composeResult.email || {}) } };
  if (!result.email.date) result.email.date = new Date().toISOString();
  const id = contentId(result.email);
  await writeDocs([{ id, data: toDocument(result, { source: "compose" }) }]);
  return id;
}

/** Import many records (Excel upload) in chunked batch commits. */
async function addImportedRecords(records, meta = {}) {
  const batchId = `batch_${Date.now()}`;
  const docs = records.map((record) => ({
    id: contentId(record.email || {}),
    data: toDocument(record, { source: "excel-upload", batchId }),
  }));
  await writeDocs(docs);

  const batchDoc = {
    id: batchId,
    data: {
      fileName: String(meta.fileName || ""),
      rowCount: docs.length,
      importedAt: new Date().toISOString(),
    },
  };
  try {
    if (useFirebase()) await firebase.putDocs(BATCHES, [batchDoc]);
  } catch (err) {
    console.warn("[Store] Could not save import batch metadata:", err.message);
  }
  return { batchId, count: docs.length };
}

async function getRecord(id) {
  return useFirebase() ? firebase.getDoc(RECORDS, id) : memory.get(id) || null;
}

async function updateRewrite(id, rewrite) {
  const existing = await getRecord(id);
  if (!existing) return false;
  const { _id, ...data } = existing;
  data.analysis = { ...(data.analysis || {}), suggestedRewrite: String(rewrite || "") };
  data.updatedAt = new Date().toISOString();
  if (useFirebase()) {
    await firebase.setDoc(RECORDS, id, data);
  } else {
    memory.set(id, { ...data, _id: id });
  }
  invalidate();
  return true;
}

/** All records, oldest first. Throws if Firebase can't be reached. */
async function listRecords({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.records;

  const raw = useFirebase() ? await firebase.listDocs(RECORDS) : Array.from(memory.values());
  const records = raw
    .filter((doc) => doc && (doc.email || doc.analysis))
    .map((doc) => ({
      ...doc,
      email: doc.email || {},
      analysis: doc.analysis || null,
      error: doc.error || null,
    }))
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  cache = { at: Date.now(), records };
  return records;
}

/** Dashboard summary computed from the stored records. Optional ISO date range filter. */
async function getSummary({ from, to } = {}) {
  let records = await listRecords();
  if (from || to) {
    const min = from ? new Date(from).getTime() : -Infinity;
    const max = to ? new Date(to).getTime() : Infinity;
    records = records.filter((record) => {
      const time = new Date(record.emailDate || record.email?.date || record.createdAt || 0).getTime();
      return time >= min && time <= max;
    });
  }
  return exporter.summarizeRecords(records);
}

module.exports = {
  addComposeResult,
  addImportedRecords,
  updateRewrite,
  listRecords,
  getSummary,
};
