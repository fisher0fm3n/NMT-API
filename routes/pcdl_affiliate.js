// routes/affiliate.routes.js
// DB: pcdl_affiliate.public.users & public.transactions
// users:
// - email TEXT PK
// - is_member BOOLEAN
// - platforms JSONB (object)
// - social_links JSONB (array of strings)
// - passport_photo TEXT (private path)
// - created_at/updated_at (updated_at set to now() on write)
//
// transactions:
// - code (affiliate code) matching users.code (case-insensitive)
// - amount/total_amount/... numeric-like (we sum safely)
// - timestamp BIGINT (milliseconds since epoch)  <-- used for all time filtering/sorting
//
// Auth model:
// - All /affiliate/* require x-api-key (GENERAL_API_KEY)
// - Admin-only list: x-admin-token must be present
// - For user-specific routes, allow x-admin-token OR a valid user token for that email
//
// Uploads:
// - passport_photo is stored privately under /uploads/affiliate/passport (no public serving route)

const { Router } = require("express");
const { Client } = require("pg");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const axios = require("axios");

// -------------------- PRIVATE upload storage --------------------
const UPLOAD_ROOT = path.join(process.cwd(), "uploads");
const PASSPORT_DIR = path.join(UPLOAD_ROOT, "affiliate", "passport");
const VIDEOS_DIR = path.join(UPLOAD_ROOT, "affiliate", "videos");
fs.mkdirSync(VIDEOS_DIR, { recursive: true });
fs.mkdirSync(PASSPORT_DIR, { recursive: true });
const MAX_PASSPORT_BYTES = 1024 * 1024;

function guessVideoMime(ext) {
  switch (ext.toLowerCase()) {
    case ".mp4":  return "video/mp4";
    case ".webm": return "video/webm";
    case ".ogg":
    case ".ogv":  return "video/ogg";
    case ".mov":  return "video/quicktime";
    case ".m4v":  return "video/x-m4v";
    default:      return "application/octet-stream";
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PASSPORT_BYTES },
  fileFilter: (_req, file, cb) => {
    const ok = new Set(["image/jpeg", "image/png", "image/webp"]).has(
      file.mimetype
    );
    if (!ok) return cb(new Error("Only JPG, PNG, or WEBP images are allowed"));
    cb(null, true);
  },
});

// Reusable wrapper to convert Multer's size error to a friendly message
function passportUpload(field = "passport_photo") {
  return (req, res, next) => {
    upload.single(field)(req, res, (err) => {
      if (!err) return next();
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          status: false,
          error: "upload_error",
          message: "passport photo must be ≤ 1MB",
        });
      }
      return res.status(400).json({
        status: false,
        error: "upload_error",
        message: err.message || "upload failed",
      });
    });
  };
}

// -------------------- DB --------------------
function newClient() {
  return new Client({
    user: "postgres",
    host: "102.219.189.166",
    database: "pcdl_affiliate",
    password: "B8Mgs81D58eTub9GhnO2FOp2",
    port: 5432,
  });
}
async function withClient(fn) {
  const db = newClient();
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

// -------------------- Auth & helpers --------------------
const GENERAL_API_KEY =
  process.env.PCDL_API_KEY || "ee115610-738b-4e7b-97e2-446468ba550c";
const ADMIN_TOKEN = "49736993-2038-44f6-9273-5527b4b8779e";

function hasGeneralApiKey(req) {
  return (req.header("x-api-key") || "").trim() === GENERAL_API_KEY;
}
function hasAdminToken(req) {
  return (req.header("x-admin-token") || "").trim() === ADMIN_TOKEN;
}

function requireGeneralApiKey(req, res, next) {
  if (!hasGeneralApiKey(req))
    return res
      .status(401)
      .json({ status: false, error: "unauthorized_api_key" });
  next();
}
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function trimString(v) {
  return typeof v === "string" ? v.trim() : v;
}
function trimAllStrings(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object" && !Buffer.isBuffer(v))
      out[k] = trimAllStrings(v);
    else out[k] = trimString(v);
  }
  return out;
}

function sanitizeEmail(e) {
  if (typeof e !== "string") return null;
  const s = e.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s.toLowerCase();
}
function getCallerToken(req) {
  const b = req.body || {},
    q = req.query || {};
  return (
    (typeof b.token === "string" && b.token.trim()) ||
    (typeof q.token === "string" && q.token.trim()) ||
    (req.header("x-user-token") || "").trim()
  );
}

// External token verification (auth-only; token never stored)
async function verifyUserToken(email, token) {
  if (!email || !token) return { ok: false, reason: "missing email/token" };
  try {
    const resp = await axios.post(
      "https://sjvv8a3ys1.execute-api.us-east-1.amazonaws.com/Dev/fetchUserToken",
      { email, token: "SFG89VKUG98DPGWJRW4" },
      { timeout: 8000, headers: { "Content-Type": "application/json" } }
    );
    const apiToken = resp?.data?.token;
    if (!apiToken) return { ok: false, reason: "no token from auth api" };
    return {
      ok: apiToken === token,
      reason: apiToken === token ? null : "token_mismatch",
    };
  } catch (err) {
    return {
      ok: false,
      reason: err?.response?.data || err.message || "auth_api_failed",
    };
  }
}

// Guards
async function requireAdminForList(req, res, next) {
  if (!hasAdminToken(req))
    return res
      .status(401)
      .json({ status: false, error: "admin_token_required" });
  next();
}
async function requireAdminOrVerifiedUser(req, res, next) {
  const email = req.params.email;
  if (!email)
    return res.status(400).json({ status: false, error: "bad_email" });
  if (hasAdminToken(req)) return next();
  const token = getCallerToken(req);
  if (!token)
    return res.status(401).json({ status: false, error: "token_required" });
  const auth = await verifyUserToken(email, token);
  if (!auth.ok)
    return res
      .status(401)
      .json({ status: false, error: "unauthorized", reason: auth.reason });
  next();
}
async function requireAdminOrBodyToken(req, res, next) {
  if (hasAdminToken(req)) return next();
  req.body = trimAllStrings(req.body || {});
  const email = req.body?.email;
  if (!email)
    return res.status(400).json({ status: false, error: "email_required" });
  const token = getCallerToken(req);
  if (!token)
    return res.status(401).json({ status: false, error: "token_required" });
  const auth = await verifyUserToken(email, token);
  if (!auth.ok)
    return res
      .status(401)
      .json({ status: false, error: "unauthorized", reason: auth.reason });
  next();
}

// --- helpers for engagement ---
function normCode(s) { return (s || "").toString().trim().toLowerCase(); }
function normId(s)   { return (s || "").toString().trim(); }

// Accepts: 4–12 chars, [a-z0-9_], must include at least one letter,
// no leading/trailing underscore-only (first/last must be [a-z0-9]).
const CODE_RE =
  /^(?=.{4,12}$)(?=[a-z0-9_]*[a-z])[a-z0-9](?:[a-z0-9_]*[a-z0-9])$/;

function normalizeAndValidateCode(codeRaw) {
  if (codeRaw == null || codeRaw === "") return { ok: true, code: null }; // not provided
  const code = String(codeRaw).trim().toLowerCase();

  if (!CODE_RE.test(code)) {
    // craft specific hints (optional)
    const len = code.length;
    const hasLetter = /[a-z]/.test(code);
    const validChars = /^[a-z0-9_]+$/.test(code);
    let message =
      "code must be 4–12 chars, letters/digits/underscore, and contain at least one letter";
    if (len < 4 || len > 12)
      message = "Code must be between 4 and 12 characters";
    else if (!validChars)
      message =
        "code can only contain lowercase letters, digits, and underscore";
    else if (!hasLetter) message = "code must include at least one letter";
    return { ok: false, reason: "invalid_format", message };
  }

  return { ok: true, code };
}

// Get code and created_at by email
async function getUserCodeAndCreatedAtByEmail(db, email) {
  const r = await db.query(
    `SELECT code, created_at FROM public.users WHERE lower(email) = lower($1) LIMIT 1`,
    [email]
  );
  if (!r.rows[0]) return { code: null, createdAtISO: null };
  const createdAtISO = r.rows[0].created_at
    ? new Date(r.rows[0].created_at).toISOString()
    : null;
  return { code: r.rows[0].code, createdAtISO };
}

// Helper: max of two ISO datetimes (returns the later one; handles nulls)
function maxISO(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return new Date(a) > new Date(b) ? a : b;
}

function normalizeLinksToArray(input) {
  const out = [];

  const pushLine = (s) => {
    const t = String(s || "").trim();
    if (!t) return;

    // If it's a JSON array as a string, parse it and recurse.
    if (t.startsWith("[") && t.endsWith("]")) {
      try {
        const arr = JSON.parse(t);
        arr.forEach(pushLine);
        return;
      } catch {
        /* fall through */
      }
    }

    // Otherwise split by comma/semicolon/newline (handles "a,b,c" cases)
    t.split(/[,;\n]+/).forEach((piece) => {
      const p = piece.trim().replace(/^"+|"+$/g, ""); // strip stray quotes
      if (p) out.push(p);
    });
  };

  const visit = (val) => {
    if (val == null || val === "") return;
    if (Array.isArray(val)) {
      val.forEach(visit);
      return;
    }
    if (typeof val === "object") {
      Object.values(val).forEach(visit);
      return;
    }
    pushLine(val);
  };

  visit(input);

  // Dedupe and keep only http/https
  const uniq = Array.from(new Set(out)).filter((u) => /^https?:\/\//i.test(u));

  return uniq.length ? uniq : null;
}

function boolOrNull(v) {
  if (v === true || v === false) return v;
  if (v == null || v === "") return null;
  const s = String(v).trim().toLowerCase();
  if (["true", "t", "1", "yes", "y"].includes(s)) return true;
  if (["false", "f", "0", "no", "n"].includes(s)) return false;
  return null;
}

// ---------- Payout mode ----------
const PAYOUT_MODES = { ADMIN: "admin", AUTO: "auto" };

async function getPayoutMode(db) {
  const r = await db.query(
    `SELECT value FROM public.app_settings WHERE key='payout_mode' LIMIT 1`
  );
  const mode = r.rows[0]?.value?.mode;
  return mode === PAYOUT_MODES.AUTO ? PAYOUT_MODES.AUTO : PAYOUT_MODES.ADMIN;
}

async function setPayoutMode(db, mode) {
  if (![PAYOUT_MODES.ADMIN, PAYOUT_MODES.AUTO].includes(mode)) {
    const err = new Error("bad_mode");
    err.status = 400;
    throw err;
  }
  await db.query(
    `INSERT INTO public.app_settings (key, value, updated_at)
     VALUES ('payout_mode', jsonb_build_object('mode',$1), now())
     ON CONFLICT (key) DO UPDATE SET value=jsonb_build_object('mode',$1), updated_at=now()`,
    [mode]
  );
}

function isCurrentMonthUTC(year, month) {
  const now = new Date();
  return (
    now.getUTCFullYear() === Number(year) &&
    now.getUTCMonth() + 1 === Number(month)
  );
}

/**
 * Compute the user’s payout for a given past month (UTC), clamped to user.created_at.
 * Returns: { ok, reason?, code, year, month, monthStartISO, monthEndISO, createdAtISO,
 *            total, tierName, percentage, earned, alreadyPaid, payoutRow }
 */
async function computeMonthPayoutPreview(db, email, year, month) {
  const { code, createdAtISO } = await getUserCodeAndCreatedAtByEmail(
    db,
    email
  );
  if (!code) return { ok: false, reason: "user_code_not_found" };

  const { startISO, endISO } = monthRangeUTC(year, month);
  const monthStartISO = maxISO(createdAtISO, startISO);
  const monthEndISO = endISO;

  if (monthStartISO && new Date(monthStartISO) >= new Date(monthEndISO)) {
    const tier = commissionTier(0);
    return {
      ok: true,
      code,
      year,
      month,
      monthStartISO,
      monthEndISO,
      createdAtISO,
      total: 0,
      tierName: tier.name,
      percentage: tier.rate,
      earned: 0,
      alreadyPaid: false,
      payoutRow: null,
    };
  }

  // Fetch all txns for that clamped month window
  const { rows } = await fetchPeriodTransactions(
    db,
    code,
    monthStartISO,
    monthEndISO,
    { limit: 100000, offset: 0 }
  );
  const total = +sumEspees(rows).toFixed(2);
  const { name: tierName, rate: percentage } = commissionTier(total);
  const earned = +(total * percentage).toFixed(2);

  const paidRes = await db.query(
    `SELECT * FROM public.payouts WHERE lower(email)=lower($1) AND year=$2 AND month=$3 LIMIT 1`,
    [email, year, month]
  );
  const payoutRow = paidRes.rows[0] || null;

  return {
    ok: true,
    code,
    year,
    month,
    monthStartISO,
    monthEndISO,
    createdAtISO,
    total,
    tierName,
    percentage,
    earned,
    alreadyPaid: !!payoutRow,
    payoutRow,
  };
}

// ---- Required-on-create (everything from your sample except `status`)
const REQUIRED_ON_CREATE = [
  "email",
  "code",
  "title",
  "last_name",
  "zonal_church",
  "followers",
  "contact_email",
  "country",
  "bio",
  "first_name",
  "group_church",
  "referral",
  "is_member",
  "kc_username",
  "payout",
  "phone",
  "platforms",
  "plan",
  "social_links",
  // passport_photo is enforced via the uploaded file, see POST route
];

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}
function isNonEmptyObject(v) {
  return (
    v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0
  );
}
function isNonEmptyArray(v) {
  return Array.isArray(v) && v.length > 0;
}

/**
 * Validate the request body AFTER normalization (trimming, parsing):
 * - strings must be non-empty
 * - followers must be a positive number (or >=0, tweak as needed)
 * - is_member must be a boolean
 * - platforms must be a non-empty object
 * - social_links must be a non-empty array (of strings)
 */
function validateRequiredOnCreate(b) {
  const errs = [];

  // strings
  const mustBeNonEmptyStrings = [
    "email",
    "code",
    "title",
    "last_name",
    "zonal_church",
    "contact_email",
    "country",
    "bio",
    "first_name",
    "group_church",
    "referral",
    "kc_username",
    "payout",
    "phone",
    "plan",
  ];
  for (const k of mustBeNonEmptyStrings) {
    if (!isNonEmptyString(b[k])) errs.push(`${k} is required`);
  }

  // followers -> number
  const followersNum = Number(b.followers);
  if (!Number.isFinite(followersNum)) errs.push("followers must be a number");
  // If you want strictly positive: if (!(followersNum > 0)) errs.push("followers must be > 0");

  // is_member -> boolean
  if (typeof b.is_member !== "boolean")
    errs.push("is_member must be true/false");

  // platforms -> object with at least 1 key
  if (!isNonEmptyObject(b.platforms))
    errs.push("platforms must be a non-empty JSON object");

  // social_links -> non-empty array of strings
  if (!isNonEmptyArray(b.social_links)) {
    errs.push("social_links must be a non-empty list of URLs");
  } else if (!b.social_links.every((s) => typeof s === "string" && s.trim())) {
    errs.push("social_links must contain only non-empty strings");
  }

  return errs;
}

// Pick the first existing numeric-like "amount" column from a safe whitelist
// Pick the first existing numeric-like "amount" column from a safe whitelist
async function resolveTxnAmountColumn(db) {
  const CANDIDATES = ["amount", "total_amount", "espees_amount", "value"]; // extend if needed

  const q = `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'transactions'
      AND column_name = ANY($1::text[])
    ORDER BY array_position($1::text[], column_name)
    LIMIT 1
  `;
  const r = await db.query(q, [CANDIDATES]);
  const col = r.rows[0]?.column_name || null;

  if (!col) {
    // none found — totals will be 0 until you add one of the candidate columns
    return { col: null, sqlExpr: "0::numeric" };
  }

  // Safely coerce text/numeric with commas/spaces to numeric
  const sqlExpr = `NULLIF(regexp_replace(t."${col}"::text, '[, ]', '', 'g'), '')::numeric`;
  return { col, sqlExpr };
}

// -------------------- Column allowlist --------------------
const KNOWN_COLS = new Set([
  "email",
  "code",
  "first_name",
  "last_name",
  "title",
  "zone",
  "followers",
  "is_member",
  "platforms",
  "payout",
  "phone",
  "country",
  "bio",
  "instagram",
  "facebook",
  "twitter",
  "tiktok",
  "youtube",
  "whatsapp",
  "website",
  "contact_email",
  "zonal_church",
  "group_church",
  "referral",
  "kc_username",
  "plan",
  "social_links",
  "passport_photo",
  "created_at",
  "updated_at",
  "type",
]);

const USER_TYPES = new Set(["affiliate", "solutionist"]);
function normalizeUserType(v) {
  if (v == null || v === "") return null; // let DB default apply
  const s = String(v).trim().toLowerCase();
  if (!USER_TYPES.has(s))
    return { ok: false, message: "type must be 'affiliate' or 'solutionist'" };
  return { ok: true, value: s };
}

/**
 * Build INSERT/UPDATE pieces with validated types.
 * Returns: { cols, vals, params, errors[] }
 *  - vals are $1..$n relative to params (no email included)
 *  - All jsonb params are stringified before binding to match ::jsonb casts
 */
function buildUpsertParts(bodyRaw) {
  const b = trimAllStrings(bodyRaw || {});
  const cols = [],
    vals = [],
    params = [],
    errors = [];

  // helper: null if empty string
  const nullIfEmpty = (v) => {
    if (v == null) return null;
    if (typeof v === "string" && v.trim() === "") return null;
    return v;
  };

  for (const [k0, vRaw] of Object.entries(b)) {
    const k = String(k0).toLowerCase();
    if (!KNOWN_COLS.has(k) || k === "email") continue;

    // normalize empty strings to null once
    const v0 = nullIfEmpty(vRaw);

    // ---- JSONB: platforms { ... } ----
    if (k === "platforms") {
      if (v0 == null) {
        cols.push("platforms");
        vals.push(`$${params.length + 1}::jsonb`);
        params.push(null);
      } else {
        // Accept JS object OR valid JSON string of an object
        let obj = null;
        if (typeof v0 === "object") obj = v0;
        else {
          try {
            obj = JSON.parse(String(v0));
          } catch {
            obj = null;
          }
        }
        if (!obj || Array.isArray(obj) || typeof obj !== "object") {
          errors.push(
            'platforms must be a JSON object (e.g. {"facebook":4900})'
          );
        } else {
          cols.push("platforms");
          vals.push(`$${params.length + 1}::jsonb`);
          params.push(JSON.stringify(obj)); // <— stringify for ::jsonb
        }
      }
      continue;
    }

    // ---- JSONB: social_links [ "url", ... ] ----
    if (k === "social_links") {
      const arr = normalizeLinksToArray(v0);
      cols.push("social_links");
      vals.push(`$${params.length + 1}::jsonb`);
      params.push(arr == null ? null : JSON.stringify(arr)); // <-- stringify for ::jsonb
      continue;
    }

    // ---- BOOLEAN: is_member ----
    if (k === "is_member") {
      const bv = boolOrNull(v0);
      if (v0 != null && bv === null)
        errors.push("is_member must be true/false");
      cols.push("is_member");
      vals.push(`$${params.length + 1}::boolean`);
      params.push(bv);
      continue;
    }

    // ---- BIGINT: followers ----
    if (k === "followers") {
      const n = v0 == null ? null : Number(v0);
      if (v0 != null && !Number.isFinite(n))
        errors.push("followers must be a number");
      cols.push("followers");
      vals.push(`$${params.length + 1}::bigint`);
      params.push(Number.isFinite(n) ? n : null);
      continue;
    }

    // ---- TIMESTAMPTZ passthrough ----
    if (k === "created_at" || k === "updated_at") {
      cols.push(k);
      vals.push(`$${params.length + 1}::timestamptz`);
      params.push(v0 || null);
      continue;
    }

    // ---- TEXT (enum-like): type ----
    if (k === "type") {
      const norm = normalizeUserType(v0);
      if (v0 != null && norm.ok === false) {
        errors.push(norm.message);
      }
      cols.push("type");
      vals.push(`$${params.length + 1}`);
      params.push(norm && norm.value ? norm.value : null); // null lets DB default apply on INSERT
      continue;
    }

    // ---- TEXT: code normalized lower-case ----
    if (k === "code") {
      cols.push("code");
      vals.push(`$${params.length + 1}`);
      params.push(v0 == null ? null : String(v0).toLowerCase());
      continue;
    }

    // ---- Default TEXT ----
    cols.push(k);
    vals.push(`$${params.length + 1}`);
    params.push(v0 == null ? null : String(v0));
  }

  return { cols, vals, params, errors };
}

async function assertCodeAvailable(db, code, currentEmail /* may be null */) {
  if (!code) return true; // nothing to check
  const params = [code];
  let sql = `SELECT email FROM public.users WHERE lower(code) = lower($1)`;
  if (currentEmail) {
    params.push(currentEmail);
    sql += ` AND lower(email) <> lower($2)`;
  }
  const r = await db.query(sql, params);
  return r.rowCount === 0;
}

// ---------- Commission (monthly reset by month window) ----------
function commissionTier(totalEspees) {
  const n = Number(totalEspees) || 0;
  if (n >= 5000) return { name: "Senior Affiliate", rate: 0.05 };
  if (n >= 1000) return { name: "Intermediate Affiliate", rate: 0.035 };
  if (n >= 500) return { name: "Emerging Affiliate", rate: 0.03 };
  if (n >= 10) return { name: "Active Affiliate", rate: 0.02 };
  if (n >= 5) return { name: "Starter Affiliate", rate: 0.01 };
  return { name: "No Tier", rate: 0.0 };
}

function firstOfMonthUTC(y, m /* 1-12 */) {
  return new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
}
function currentMonthRangeUTC() {
  const now = new Date();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0)
  );
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0)
  );
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}
function monthRangeUTC(year, month /* 1-12 */) {
  const s = firstOfMonthUTC(year, month);
  const e = firstOfMonthUTC(year, month + 1);
  return { startISO: s.toISOString(), endISO: e.toISOString() };
}

// Amount reader (tolerates text with commas)
function readEspeesAmount(row) {
  const tryFields = ["amount", "espees_amount", "total_amount", "value"];
  for (const f of tryFields) {
    if (row[f] != null && row[f] !== "") {
      const n = Number(String(row[f]).replace(/[, ]/g, ""));
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

// Get code by email
async function getUserCodeByEmail(db, email) {
  const r = await db.query(
    `SELECT code FROM public.users WHERE lower(email) = lower($1) LIMIT 1`,
    [email]
  );
  return r.rows[0]?.code || null;
}

// Central time expression for transactions table (ms epoch -> timestamptz)
const TS_EXPR = `to_timestamp((t."timestamp")::bigint / 1000.0)`;

// Fetch list & count for a period
async function fetchPeriodTransactions(
  db,
  code,
  startISO,
  endISO,
  { limit = 50, offset = 0 } = {}
) {
  const params = [code];
  const conds = [`lower(t.code) = lower($1)`];
  if (startISO) {
    params.push(startISO);
    conds.push(`${TS_EXPR} >= $${params.length}::timestamptz`);
  }
  if (endISO) {
    params.push(endISO);
    conds.push(`${TS_EXPR} <  $${params.length}::timestamptz`);
  }
  const whereSql = `WHERE ${conds.join(" AND ")}`;

  const listSql = `
    SELECT t.*
    FROM public.transactions t
    ${whereSql}
    ORDER BY ${TS_EXPR} DESC NULLS LAST, t.id DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `;
  const countSql = `SELECT COUNT(*)::bigint AS c FROM public.transactions t ${whereSql}`;

  const listParams = [...params, limit, offset];
  const { rows } = await db.query(listSql, listParams);
  const countRows = await db.query(countSql, params);
  return { rows, total: Number(countRows.rows[0]?.c || 0) };
}

// JS-side sum
function sumEspees(rows) {
  return rows.reduce((acc, r) => acc + readEspeesAmount(r), 0);
}

// -------------------- Router --------------------
module.exports = function affiliateRoutes() {
  const router = Router();

  // all /affiliate/* require general api key
  // router.use("/affiliate", requireGeneralApiKey);

  router.get("/affiliate/test", (_req, res) =>
    res.json({ status: true, test: "ok" })
  );

  // -------- USERS --------

  // LIST (admin only)
  // Make sure you have body parsing enabled somewhere in your app setup:
  // app.use(express.json());

  router.post(
    "/affiliate/users/all",
    requireAdminForList,
    asyncHandler(async (req, res) => {
      // Read from body instead of query
      const { limit: rawLimit, offset: rawOffset, q: rawQ } = req.body || {};

      // Sanitize / normalize
      const limit = Math.max(
        1,
        Math.min(100, Number(String(rawLimit ?? "").trim() || 50))
      );
      const offset = Math.max(0, Number(String(rawOffset ?? "").trim() || 0));
      const q = (typeof rawQ === "string" ? rawQ : "").trim();

      const rows = await withClient(async (db) => {
        const values = [];
        let where = "";

        if (q) {
          values.push(`%${q}%`);
          where =
            `WHERE (email ILIKE $1 OR COALESCE(code,'') ILIKE $1 OR ` +
            `COALESCE(first_name,'') ILIKE $1 OR COALESCE(last_name,'') ILIKE $1)`;
        }

        // Figure out the parameter indexes for LIMIT/OFFSET based on whether q is present
        const limitIdx = q ? 2 : 1;
        const offsetIdx = q ? 3 : 2;

        const sql = `
        SELECT *
        FROM public.users
        ${where}
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `;

        values.push(limit, offset); // append after potential q

        const r = await db.query(sql, values);
        return r.rows;
      });

      res.json({ status: true, data: rows, limit, offset, q: q || null });
    })
  );

  // GET one (admin or user)
  router.get(
    "/affiliate/users/:email",
    requireAdminOrVerifiedUser,
    asyncHandler(async (req, res) => {
      const email = req.params.email;
      const row = await withClient(async (db) => {
        const r = await db.query(
          `SELECT * FROM public.users WHERE email = $1`,
          [email]
        );
        return r.rows[0] || null;
      });
      if (!row)
        return res.status(404).json({ status: false, error: "not_found" });
      res.json({ status: true, data: row });
    })
  );

// CREATE/UPSERT — supports passport_photo (multipart field: passport_photo)
router.post(
  "/affiliate/users",
  passportUpload("passport_photo"),
  asyncHandler(requireAdminOrBodyToken),
  asyncHandler(async (req, res) => {
    // trim + normalize incoming values
    req.body = trimAllStrings(req.body || {});
    const b = req.body || {};

    // email required (and for token verification already handled)
    const email = b.email;
    if (!email)
      return res.status(400).json({ status: false, error: "email_required" });

    // code format + normalize
    if (b.code !== undefined) {
      const v = normalizeAndValidateCode(b.code);
      if (!v.ok) {
        return res.status(400).json({
          status: false,
          error: "invalid_code_format",
          reason: v.reason,
          message: v.message,
        });
      }
      b.code = v.code; // normalized lowercase (or null)
    }

    // Uniqueness check for code (against other users)
    await withClient(async (db) => {
      const available = await assertCodeAvailable(
        db,
        b.code,
        /* currentEmail */ null
      );
      if (!available) {
        return Promise.reject({
          __app: true,
          code: 409,
          payload: { status: false, error: "code_taken" },
        });
      }
    });

    // ---- Passport photo is REQUIRED for affiliates on create ----
    const isAffiliateType = String(b.type || "").trim().toLowerCase() === "affiliate";
    if (isAffiliateType && !req.file) {
      return res.status(400).json({
        status: false,
        error: "passport_photo_required",
        message: "Please upload a passport photo (≤ 1MB; JPG/PNG/WEBP).",
      });
    }

    // Persist passport file privately (ONLY if a file was sent)
    if (req.file) {
      const safe = email.replace(/[^a-zA-Z0-9._-]/g, "_");
      // map mimetype → extension; default to .jpg if unknown
      const ext =
        req.file.mimetype === "image/png"
          ? ".png"
          : req.file.mimetype === "image/webp"
          ? ".webp"
          : ".jpg";
      const filename = `${safe}_${Date.now()}${ext}`;
      await fs.promises.writeFile(
        path.join(PASSPORT_DIR, filename),
        req.file.buffer
      );
      b.passport_photo = `/uploads/affiliate/passport/${filename}`;
    }

    // --- Convert/parse fields BEFORE "mandatory" validation ---
    // platforms (object)
    if (b.platforms != null && typeof b.platforms !== "object") {
      try {
        b.platforms = JSON.parse(String(b.platforms));
      } catch {
        /* leave as-is, validator will complain */
      }
    }
    // is_member (boolean)
    b.is_member = boolOrNull(b.is_member);
    // followers (number)
    if (b.followers != null) b.followers = Number(b.followers);
    // social_links (array of strings) – normalize from JSON string or comma-separated
    b.social_links = normalizeLinksToArray(b.social_links);

    // type (optional; enum-like)
    if (b.type !== undefined) {
      const t = normalizeUserType(b.type);
      if (t && t.ok === false) {
        return res
          .status(400)
          .json({ status: false, error: "bad_type", message: t.message });
      }
      if (t && t.value) b.type = t.value;
      else delete b.type;
    }

    function validateRequiredOnCreateByType(b) {
      // Fields common to both types
      const baseStrings = [
        "email",
        "code",
        "title",
        "last_name",
        "zonal_church",
        "contact_email",
        "country",
        "first_name",
        "group_church",
        "referral",
        "kc_username",
        "phone",
      ];
      const errs = [];

      const str = (k) =>
        typeof b[k] === "string" && b[k].trim() ? null : `${k} is required`;

      // Always check these
      baseStrings.forEach((k) => {
        const e = str(k);
        if (e) errs.push(e);
      });

      // is_member boolean
      if (typeof b.is_member !== "boolean")
        errs.push("is_member must be true/false");

      // country stored as code string already handled by above
      // followers/platforms/plan/social_links/payout/passport are conditional

      if (String(b.type || "").trim().toLowerCase() === "affiliate") {
        // Affiliate-only requirements
        if (!Number.isFinite(Number(b.followers)))
          errs.push("followers must be a number");
        if (
          !b.platforms ||
          typeof b.platforms !== "object" ||
          Array.isArray(b.platforms) ||
          !Object.keys(b.platforms).length
        )
          errs.push("platforms must be a non-empty JSON object");
        if (
          !Array.isArray(b.social_links) ||
          b.social_links.length === 0 ||
          !b.social_links.every((s) => typeof s === "string" && s.trim())
        )
          errs.push("social_links must be a non-empty list of URLs");
        if (!(typeof b.plan === "string" && b.plan.trim()))
          errs.push("plan is required");
        if (!(typeof b.payout === "string" && b.payout.trim()))
          errs.push("payout is required");
        // passport_photo enforced above when file is missing
      } else {
        // solutionist: soften fields
        // followers/platforms/plan/social_links/payout/passport_photo are NOT required
      }

      return errs;
    }

    // ---- Mandatory-field validation (everything except `status`) ----
    const reqErrors = validateRequiredOnCreateByType(b);
    if (reqErrors.length) {
      return res.status(400).json({
        status: false,
        error: "missing_or_invalid_fields",
        details: reqErrors,
      });
    }

    // ---- Build INSERT/UPSERT payload (with safe jsonb stringification) ----
    const { cols, vals, params, errors } = buildUpsertParts(b);
    if (errors.length) {
      return res
        .status(400)
        .json({ status: false, error: "bad_request", details: errors });
    }

    // Shift placeholders by +1 because $1 is email
    const valsOffset = vals.map((piece) =>
      piece.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + 1}`)
    );
    const setCols = ["email", ...cols, "updated_at"];
    const setVals = ["$1", ...valsOffset, "now()"];
    const qParams = [email, ...params];

    const sql = `
      INSERT INTO public.users (${setCols.join(", ")})
      VALUES (${setVals.join(", ")})
      ON CONFLICT (email)
      DO UPDATE SET ${cols
        .map((c) => `${c} = EXCLUDED.${c}`)
        .concat(["updated_at = now()"])
        .join(", ")}
      RETURNING *;
    `;

    const row = await withClient(async (db) => {
      const r = await db.query(sql, qParams);
      return r.rows[0];
    });

    res.status(201).json({ status: true, data: row });
  })
);

  // UPDATE — JSON or multipart; supports passport_photo
  // PATCH /affiliate/users
  // Body: { email, ...fields..., optional passport_photo }
  // Auth: x-api-key + (admin OR verified user for body.email)
  // Rules:
  //  - `code` cannot be updated (hard-block).
  //  - Any provided required field cannot be empty/null (reject).
  router.patch(
    "/affiliate/users",
    passportUpload("passport_photo"),
    asyncHandler(requireAdminOrBodyToken),
    asyncHandler(async (req, res) => {
      req.body = trimAllStrings(req.body || {});
      const email = req.body?.email;
      if (!email) {
        return res.status(400).json({ status: false, error: "email_required" });
      }

      if (Object.prototype.hasOwnProperty.call(req.body, "type")) {
        req.body.type = normalizeUserType(req.body.type);
      }

      // Block any attempt to change affiliate code
      if (Object.prototype.hasOwnProperty.call(req.body, "code")) {
        return res.status(400).json({
          status: false,
          error: "code_update_forbidden",
          message: "Affiliate code cannot be changed.",
        });
      }

      // Prepare mutable copy (never update email)
      const b = { ...req.body };

      // Save passport file if provided
      if (req.file) {
        const safe = email.replace(/[^a-zA-Z0-9._-]/g, "_");
        const ext =
          req.file.mimetype === "image/png"
            ? ".png"
            : req.file.mimetype === "image/webp"
            ? ".webp"
            : ".jpg";
        const filename = `${safe}_${Date.now()}${ext}`;
        await fs.promises.writeFile(
          path.join(PASSPORT_DIR, filename),
          req.file.buffer
        );
        b.passport_photo = `/uploads/affiliate/passport/${filename}`;
      }

      // ------- Normalization for validation -------
      // Convert booleans/numbers/JSON and links before validating emptiness.
      if (b.is_member !== undefined) b.is_member = boolOrNull(b.is_member);
      if (b.followers !== undefined)
        b.followers = b.followers === null ? null : Number(b.followers);

      if (b.platforms !== undefined && typeof b.platforms !== "object") {
        try {
          b.platforms = JSON.parse(String(b.platforms));
        } catch {
          /* leave as-is */
        }
      }
      if (b.social_links !== undefined) {
        b.social_links = normalizeLinksToArray(b.social_links);
      }

      // ------- “No-empty” validation on provided fields -------
      // Required (from your earlier spec; everything except `status`)
      const REQUIRED_ON_CREATE = new Set([
        "email",
        "code",
        "title",
        "last_name",
        "zonal_church",
        "followers",
        "contact_email",
        "country",
        "bio",
        "first_name",
        "group_church",
        "referral",
        "is_member",
        "kc_username",
        "payout",
        "phone",
        "platforms",
        "plan",
        "social_links",
        "type",
        // passport_photo handled by upload if you want to force it during create only
      ]);

const REQUIRED_ON_CREATE_AFFILIATE = new Set([
  "plan","social_links","payout","platforms","followers","passport_photo" // passport may be added via upload
]);
const REQUIRED_COMMON = new Set([
  "title","last_name","zonal_church","contact_email","country","first_name",
  "group_church","referral","is_member","kc_username","phone","code" // code not updatable, but presence is validated elsewhere
]);

const errors = [];
for (const key of Object.keys(b)) {
  if (key === "email" || key === "code") continue; // email identifies, code immutable

  const requireThis =
    REQUIRED_COMMON.has(key) ||
    (b.type !== "solutionist" && REQUIRED_ON_CREATE_AFFILIATE.has(key));

  if (!requireThis) continue;

  const val = b[key];
  if (val == null || (typeof val === "string" && val.trim() === "")) {
    errors.push(`${key} cannot be empty`);
    continue;
  }

  if (key === "followers" && !Number.isFinite(Number(val)))
    errors.push("followers must be a number");
  if (key === "is_member" && typeof val !== "boolean")
    errors.push("is_member must be true/false");
  if (key === "platforms") {
    if (!(val && typeof val === "object" && !Array.isArray(val) && Object.keys(val).length > 0))
      errors.push("platforms must be a non-empty JSON object");
  }
  if (key === "social_links") {
    if (!Array.isArray(val) || !val.length || !val.every(s => typeof s === "string" && s.trim()))
      errors.push("social_links must be a non-empty list of URLs");
  }
}


      if (errors.length) {
        return res.status(400).json({
          status: false,
          error: "invalid_update_payload",
          details: errors,
        });
      }

      // Build dynamic UPDATE set(s)
      const { cols, vals, params, errors: buildErrors } = buildUpsertParts(b);
      if (buildErrors.length) {
        return res
          .status(400)
          .json({ status: false, error: "bad_request", details: buildErrors });
      }

      if (!cols.length) {
        // Nothing to update -> return current row (if exists)
        const cur = await withClient(async (db) => {
          const r = await db.query(
            `SELECT * FROM public.users WHERE lower(email)=lower($1)`,
            [email]
          );
          return r.rows[0] || null;
        });
        if (!cur) {
          return res.status(404).json({ status: false, error: "not_found" });
        }
        return res.json({ status: true, data: cur });
      }

      const sets = cols.map((c, i) => `${c} = ${vals[i]}`).join(", ");
      const sql = `
      UPDATE public.users
         SET ${sets}, updated_at = now()
       WHERE lower(email) = lower($${params.length + 1})
       RETURNING *;
    `;

      const row = await withClient(async (db) => {
        const r = await db.query(sql, [...params, email]);
        return r.rows[0] || null;
      });

      if (!row) {
        return res.status(404).json({ status: false, error: "not_found" });
      }
      res.json({ status: true, data: row });
    })
  );

  // DELETE (admin or user)
  router.delete(
    "/affiliate/users/:email",
    requireAdminOrVerifiedUser,
    asyncHandler(async (req, res) => {
      const email = req.params.email;
      if (!email)
        return res.status(400).json({ status: false, error: "bad_email" });

      const count = await withClient(async (db) => {
        const r = await db.query(`DELETE FROM public.users WHERE email=$1`, [
          email,
        ]);
        return r.rowCount;
      });

      if (count === 0)
        return res.status(404).json({ status: false, error: "not_found" });
      res.json({ status: true, deleted: true });
    })
  );

  // -------- TRANSACTIONS LIST (POST) --------
  // Body: { email, token, from?, to?, status?, limit?, offset? }
  // - If no filters: returns all for user (latest -> oldest) with default pagination
  // - Case-insensitive code & status; time via "timestamp" (ms epoch)
  router.post(
    "/affiliate/users/transactions",
    asyncHandler(async (req, res, next) => {
      req.body = trimAllStrings(req.body || {});
      // Require general API key globally (already mounted), then admin or body token
      await requireAdminOrBodyToken(req, res, next);
    }),
    asyncHandler(async (req, res) => {
      const b = req.body || {};
      const email = b.email;

      const limit = Math.max(1, Math.min(200, Number(b.limit ?? 50)));
      const offset = Math.max(0, Number(b.offset ?? 0));

      // Optional filters
      const isValidDate = (s) =>
        typeof s === "string" && !Number.isNaN(Date.parse(s));
      const from = isValidDate(b.from) ? new Date(b.from).toISOString() : null;
      const to = isValidDate(b.to) ? new Date(b.to).toISOString() : null;
      const status = (b.status || "").trim(); // optional

      const rows = await withClient(async (db) => {
        const params = [email];
        const conds = [];
        if (from) {
          params.push(from);
          conds.push(`${TS_EXPR} >= $${params.length}::timestamptz`);
        }
        if (to) {
          params.push(to);
          conds.push(`${TS_EXPR} <  $${params.length}::timestamptz`);
        }
        if (status) {
          params.push(status);
          conds.push(`t.status ILIKE $${params.length}`);
        }

        params.push(limit);
        const limIdx = params.length;
        params.push(offset);
        const offIdx = params.length;

        const sql = `
          WITH usr AS (
            SELECT LOWER(u.code) AS lcode
            FROM public.users u
            WHERE u.email = $1
            LIMIT 1
          )
          SELECT t.*, COUNT(*) OVER() AS total_count
          FROM public.transactions t
          JOIN usr ON LOWER(t.code) = usr.lcode
          ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}
          ORDER BY ${TS_EXPR} DESC NULLS LAST, t.id DESC
          LIMIT $${limIdx} OFFSET $${offIdx}
        `;
        const r = await db.query(sql, params);
        return r.rows;
      });

      const total = rows[0]?.total_count ? Number(rows[0].total_count) : 0;
      const data = rows.map(({ total_count, ...r }) => r);

      res.json({
        status: true,
        email,
        limit,
        offset,
        total,
        filters: { from: from || null, to: to || null, status: status || null },
        data,
      });
    })
  );

  // -------- SUMMARY: CURRENT MONTH + OVERALL --------
  // Body: { email, token, include_list?: boolean, limit?: number, offset?: number }
  // POST /affiliate/users/transactions/summary
  // -------- SUMMARY: MONTH or CUSTOM RANGE — totals ignore pagination --------
  // helper: mask email-like strings
  function maskEmailString(s) {
    if (typeof s !== "string") return s;
    return s.replace(
      /([a-zA-Z0-9._%+-])([a-zA-Z0-9._%+-]*)(@)([a-zA-Z0-9.-])([a-zA-Z0-9.-]*)(\.[a-zA-Z]{2,})/g,
      (_m, a1, aRest, at, d1, dRest, tld) => {
        const left = a1 + (aRest ? "***" : "");
        const dom = d1 + (dRest ? "***" : "");
        return `${left}${at}${dom}${tld}`;
      }
    );
  }
  function maskEmailsDeep(v) {
    if (v == null) return v;
    if (typeof v === "string") return maskEmailString(v);
    if (Array.isArray(v)) return v.map(maskEmailsDeep);
    if (typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = maskEmailsDeep(val);
      return out;
    }
    return v;
  }

  // -------- SUMMARY: MONTH or CUSTOM RANGE — totals ignore pagination; add counts; mask emails --------
  router.post(
    "/affiliate/users/transactions/summary",
    asyncHandler(async (req, res, next) => {
      req.body = trimAllStrings(req.body || {});
      await requireAdminOrBodyToken(req, res, next);
    }),
    asyncHandler(async (req, res) => {
      const b = req.body || {};
      const email = b.email;

      const limit = Math.max(1, Math.min(200, Number(b.limit ?? 50)));
      const offset = Math.max(0, Number(b.offset ?? 0));
      const includeList = String(b.include_list || "").toLowerCase() === "true";

      // choose period: month or explicit range
      const hasMonth =
        Number.isFinite(Number(b.year)) && Number.isFinite(Number(b.month));
      const hasRange =
        typeof b.from === "string" &&
        !Number.isNaN(Date.parse(b.from)) &&
        typeof b.to === "string" &&
        !Number.isNaN(Date.parse(b.to));

      if (!hasMonth && !hasRange) {
        return res.status(400).json({
          status: false,
          error: "bad_period",
          message:
            "Provide either {year, month} (1–12) or both {from, to} (ISO).",
        });
      }
      if (hasMonth) {
        const y = Number(b.year),
          m = Number(b.month);
        if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
          return res
            .status(400)
            .json({ status: false, error: "bad_month_year" });
        }
      }

      const data = await withClient(async (db) => {
        const { code, createdAtISO } = await getUserCodeAndCreatedAtByEmail(
          db,
          email
        );
        if (!code) return { notFound: true };

        // amount expression (coerces text w/ commas → numeric)
        const { sqlExpr: amountExpr } = await resolveTxnAmountColumn(db);

        // ---- Overall (from user.created_at forward) -> compute SUM and COUNT in a single query ----
        const overallAggSql = `
        SELECT
          COALESCE(SUM(${amountExpr}), 0)::numeric(18,2) AS total,
          COUNT(*)::bigint AS cnt
        FROM public.transactions t
        WHERE lower(t.code) = lower($1)
          AND ${TS_EXPR} >= $2::timestamptz
      `;
        const overallAgg = await db.query(overallAggSql, [
          code,
          createdAtISO || "1970-01-01T00:00:00.000Z",
        ]);
        const overallTotal = Number(overallAgg.rows[0]?.total || 0);
        const overallCnt = Number(overallAgg.rows[0]?.cnt || 0);
        const overallTier = commissionTier(overallTotal);
        const overallEarn = +(overallTotal * overallTier.rate).toFixed(2);

        // ---- Period (month or range), clamped to created_at ----
        let startISO, endISO, label, year, month;
        if (hasMonth) {
          year = Number(b.year);
          month = Number(b.month);
          const r = monthRangeUTC(year, month);
          startISO = maxISO(createdAtISO, r.startISO);
          endISO = r.endISO; // exclusive
          label = "specific_month_utc";
        } else {
          startISO = maxISO(createdAtISO, new Date(b.from).toISOString());
          endISO = new Date(b.to).toISOString(); // exclusive
          label = "custom_range_utc";
        }

        // (A) Paginated LIST (for display only)
        const { rows: periodRows, total: periodCount } =
          await fetchPeriodTransactions(db, code, startISO, endISO, {
            limit,
            offset,
          });

        // (B) FULL unpaginated SUM + COUNT for the window
        const periodAggSql = `
        SELECT
          COALESCE(SUM(${amountExpr}), 0)::numeric(18,2) AS total,
          COUNT(*)::bigint AS cnt
        FROM public.transactions t
        WHERE lower(t.code) = lower($1)
          AND ${TS_EXPR} >= $2::timestamptz
          AND ${TS_EXPR} <  $3::timestamptz
      `;
        const periodAgg = await db.query(periodAggSql, [
          code,
          startISO,
          endISO,
        ]);
        const periodTotal = Number(periodAgg.rows[0]?.total || 0);
        const periodCnt = Number(periodAgg.rows[0]?.cnt || 0);

        const periodTier = commissionTier(periodTotal);
        const periodEarn = +(periodTotal * periodTier.rate).toFixed(2);

        // Mask emails in the list (if requested)
        const safeList = includeList
          ? periodRows.map(maskEmailsDeep)
          : undefined;

        return {
          code,
          overall: {
            // total_amount_espees: <omitted as requested>
            total_transactions: overallCnt,
            tier: overallTier.name,
            percentage: +(overallTier.rate * 100).toFixed(2),
            earned_amount_espees: overallEarn,
          },
          period: {
            label,
            ...(hasMonth ? { year, month } : {}),
            start: startISO,
            end: endISO,
            // total_amount_espees: <omitted as requested>
            total_transactions: periodCnt, // full count (not paginated)
            tier: periodTier.name,
            percentage: +(periodTier.rate * 100).toFixed(2),
            earned_amount_espees: periodEarn,
            ...(includeList
              ? { list: safeList, limit, offset, total: periodCount }
              : {}),
          },
        };
      });

      if (data.notFound) {
        return res
          .status(404)
          .json({ status: false, error: "user_code_not_found" });
      }
      return res.json({ status: true, data });
    })
  );

  // -------- SUMMARY: BY SPECIFIC MONTH/YEAR --------
  // Body: { email, token, year, month, include_list?: boolean, limit?: number, offset?: number }
  router.post(
    "/affiliate/users/transactions/summary/by-month",
    asyncHandler(async (req, res, next) => {
      req.body = trimAllStrings(req.body || {});
      await requireAdminOrBodyToken(req, res, next);
    }),
    asyncHandler(async (req, res) => {
      const email = req.body?.email;
      const year = Number(req.body?.year);
      const month = Number(req.body?.month); // 1-12
      if (
        !Number.isFinite(year) ||
        !Number.isFinite(month) ||
        month < 1 ||
        month > 12
      ) {
        return res.status(400).json({ status: false, error: "bad_month_year" });
      }
      const includeList =
        String(req.body?.include_list || "").toLowerCase() === "true";
      const limit = Math.max(1, Math.min(200, Number(req.body?.limit ?? 50)));
      const offset = Math.max(0, Number(req.body?.offset ?? 0));

      const data = await withClient(async (db) => {
        const { code, createdAtISO } = await getUserCodeAndCreatedAtByEmail(
          db,
          email
        );
        if (!code) return { notFound: true };

        // ---- Overall (from user.created_at forward) ----
        const overallSql = `
    SELECT * FROM public.transactions t
    WHERE lower(t.code) = lower($1)
      AND ${TS_EXPR} >= $2::timestamptz
  `;
        const overallRows = await db.query(overallSql, [
          code,
          createdAtISO || "1970-01-01T00:00:00.000Z",
        ]);
        const overallTotal = sumEspees(overallRows.rows);
        const overallTier = commissionTier(overallTotal);
        const overallEarn = +(overallTotal * overallTier.rate).toFixed(2);

        // ---- Specific month, clamped to created_at ----
        const { startISO, endISO } = monthRangeUTC(year, month);
        const monthStart = maxISO(createdAtISO, startISO);
        const { rows: monthRows, total: monthCount } =
          await fetchPeriodTransactions(db, code, monthStart, endISO, {
            limit,
            offset,
          });
        const monthTotal = sumEspees(monthRows);
        const monthTier = commissionTier(monthTotal);
        const monthEarn = +(monthTotal * monthTier.rate).toFixed(2);

        return {
          code,
          overall: {
            total_amount_espees: +overallTotal.toFixed(2),
          },
          period: {
            label: "specific_month_utc",
            year,
            month,
            start: monthStart, // clamped start
            end: endISO, // exclusive
            total_amount_espees: +monthTotal.toFixed(2),
            tier: monthTier.name,
            percentage: +(monthTier.rate * 100).toFixed(2),
            earned_amount_espees: monthEarn,
            ...(includeList
              ? { list: monthRows, limit, offset, total: monthCount }
              : {}),
          },
        };
      });

      if (data.notFound)
        return res
          .status(404)
          .json({ status: false, error: "user_code_not_found" });
      return res.json({ status: true, data });
    })
  );

  // POST /affiliate/payouts/request
  // Body: { email, token, year, month, note? }
  // Auth: admin OR verified user for email
  router.post(
    "/affiliate/payouts/request",
    asyncHandler(async (req, res, next) => {
      req.body = trimAllStrings(req.body || {});
      await requireAdminOrBodyToken(req, res, next);
    }),
    asyncHandler(async (req, res) => {
      const email = req.body?.email;
      const year = Number(req.body?.year);
      const month = Number(req.body?.month);
      const note = req.body?.note || "" || null;

      const isEth = (s) => /^0x[a-fA-F0-9]{40}$/.test(String(s || ""));

      if (!email)
        return res.status(400).json({ status: false, error: "email_required" });
      if (
        !Number.isFinite(year) ||
        !Number.isFinite(month) ||
        month < 1 ||
        month > 12
      ) {
        return res.status(400).json({ status: false, error: "bad_month_year" });
      }
      if (isCurrentMonthUTC(year, month)) {
        return res
          .status(400)
          .json({ status: false, error: "cannot_request_current_month" });
      }

      // ---- Espees API helpers (auto mode only) ----
      const ESPEES_API_KEY = "HyKbBPndHW5trPyTM8yLO4yPMcgK67jS8E2a1ZXY";
      const VENDING_WALLET = "0xb090398928e387f74078359728b89f8f66ac973d";
      const VENDING_PIN = "4321";
      const createVendingToken = async () => {
        const crypto = await import("node:crypto");
        const vending_hash = crypto.randomBytes(12).toString("base64url"); // unique each time
        const r = await fetch(
          "https://api.espees.org/agents/vending/createtoken",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": ESPEES_API_KEY,
            },
            body: JSON.stringify({
              vending_wallet_address: VENDING_WALLET,
              vending_wallet_pin: VENDING_PIN,
              vending_hash,
            }),
          }
        );
        const json = await r.json().catch(() => ({}));
        if (!r.ok || !json?.vending_token) {
          const message = json?.message || "espees_token_failed";
          const statusCode = json?.statusCode || r.status || 500;
          const err = new Error(message);
          err.statusCode = statusCode;
          err.payload = json;
          throw err;
        }
        return { token: json.vending_token, raw: json };
      };

      const vendEspees = async ({ userWallet, vendingToken, amount }) => {
        const r = await fetch("https://api.espees.org/v2/vending/vend", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": ESPEES_API_KEY,
          },
          body: JSON.stringify({
            user_wallet: userWallet,
            vending_token: vendingToken,
            amount_in_espees: amount,
          }),
        });
        const json = await r.json().catch(() => ({}));
        if (!r.ok) {
          const err = new Error(json?.message || "espees_vend_failed");
          err.statusCode = r.status || 502;
          err.payload = json;
          throw err;
        }
        return json;
      };

      const outcome = await withClient(async (db) => {
        // 0) Get payout mode and compute month preview
        const mode = await getPayoutMode(db); // "admin" | "auto"
        const preview = await computeMonthPayoutPreview(db, email, year, month);
        if (!preview.ok) return preview;

        if (preview.alreadyPaid) {
          return { alreadyPaid: true, payout: preview.payoutRow, mode };
        }
        if (preview.earned <= 0) {
          return { notEligible: true, preview, mode };
        }

        // 1) Get user's wallet address from profile (users.payout)
        //    Adjust table/column names if different in your schema.
        const walletRow = await db.query(
          `SELECT payout FROM public.users WHERE lower(email)=lower($1) LIMIT 1`,
          [email]
        );
        const walletAddress = String(walletRow.rows?.[0]?.payout || "")
          .trim()
          .toLowerCase();

        if (
          walletAddress === "0xee840a64bee77abae1e8de0a18a6f65367ac6cce" ||
          walletAddress === "monthly"
        )
          return res.status(400).json({
            status: false,
            error:
              "Please enter a valid wallet address, this can be updated on your profile",
          });

        // If wallet is missing/invalid and mode is AUTO, abort BEFORE hitting Espees API
        if (mode === "auto" && !isEth(walletAddress)) {
          return { mode: "auto", walletInvalid: true, wallet: walletAddress };
        }

        // ADMIN mode: create/refresh a request and stop here (no Espees transfer)
        if (mode === "admin") {
          const sql = `
          INSERT INTO public.payout_requests
            (email, code, year, month, total_amount_espees, percentage, earned_amount_espees, tier_name, status, note, requested_at)
          VALUES
            ($1,    $2,   $3,   $4,    $5,                  $6,         $7,                  $8,        'requested', $9,  now())
          ON CONFLICT (lower(email), year, month) DO UPDATE SET
            code                  = EXCLUDED.code,
            total_amount_espees   = EXCLUDED.total_amount_espees,
            percentage            = EXCLUDED.percentage,
            earned_amount_espees  = EXCLUDED.earned_amount_espees,
            tier_name             = EXCLUDED.tier_name,
            status                = 'requested',
            note                  = EXCLUDED.note,
            requested_at          = now()
          RETURNING *;
        `;
          const ir = await db.query(sql, [
            email,
            preview.code,
            year,
            month,
            preview.total,
            preview.percentage,
            preview.earned,
            preview.tierName,
            note,
          ]);
          return { mode, request: ir.rows[0], preview };
        }

        // AUTO mode: call Espees to vend the earned amount
        // Create vending token
        let vendToken, vendTokenRaw, vendResponse;
        try {
          const t = await createVendingToken();
          vendToken = t.token;
          vendTokenRaw = t.raw;
        } catch (e) {
          return {
            mode: "auto",
            espeesError: "token_error",
            espeesDetail: e.payload || { message: e.message },
          };
        }

        // Vend earned espees to the user's wallet from profile
        const amount = Number(Number(preview.earned).toFixed(2));
        try {
          vendResponse = await vendEspees({
            userWallet: walletAddress,
            vendingToken: vendToken,
            amount,
          });
        } catch (e) {
          return {
            mode: "auto",
            espeesError: "vend_error",
            espeesDetail: e.payload || { message: e.message },
          };
        }

        // Record payout as PAID
        let payout;
        try {
          const insertPayoutSql = `
          INSERT INTO public.payouts
            (email, code, year, month, total_amount_espees, percentage, earned_amount_espees, tier_name, note, paid_by)
          VALUES
            ($1,    $2,   $3,   $4,    $5,                  $6,         $7,                  $8,        $9,   $10)
          RETURNING *;
        `;
          const adminNote =
            (note ? `${note} | ` : "") +
            `espees_vended:${amount}@${walletAddress}; token_ok`;
          const ir = await db.query(insertPayoutSql, [
            email,
            preview.code,
            year,
            month,
            preview.total,
            preview.percentage,
            preview.earned,
            preview.tierName,
            adminNote,
            "auto",
          ]);
          payout = ir.rows[0];
        } catch (e) {
          if (String(e.code) === "23505") {
            const existed = await db.query(
              `SELECT * FROM public.payouts WHERE lower(email)=lower($1) AND year=$2 AND month=$3 LIMIT 1`,
              [email, year, month]
            );
            return { alreadyPaid: true, payout: existed.rows[0], mode: "auto" };
          }
          throw e;
        }

        // Upsert request as approved and link payout
        const rq = await db.query(
          `INSERT INTO public.payout_requests
           (email, code, year, month, total_amount_espees, percentage, earned_amount_espees, tier_name, status, note, requested_at, decided_at, decided_by, admin_note, payout_id)
         VALUES
           ($1,    $2,   $3,   $4,    $5,                  $6,         $7,                  $8,        'approved', $9,  now(), now(), 'auto', 'auto-approved', $10)
         ON CONFLICT (lower(email), year, month) DO UPDATE SET
           code                  = EXCLUDED.code,
           total_amount_espees   = EXCLUDED.total_amount_espees,
           percentage            = EXCLUDED.percentage,
           earned_amount_espees  = EXCLUDED.earned_amount_espees,
           tier_name             = EXCLUDED.tier_name,
           status                = 'approved',
           note                  = EXCLUDED.note,
           decided_at            = now(),
           decided_by            = 'auto',
           admin_note            = 'auto-approved',
           payout_id             = EXCLUDED.payout_id
         RETURNING *`,
          [
            email,
            preview.code,
            year,
            month,
            preview.total,
            preview.percentage,
            preview.earned,
            preview.tierName,
            note,
            payout.id,
          ]
        );

        return {
          mode: "auto",
          payout,
          request: rq.rows[0],
          preview,
          espees: { token: vendTokenRaw, vend: vendResponse },
        };
      });

      // ---- Final responses ----
      if (outcome.reason === "user_code_not_found") {
        return res
          .status(404)
          .json({ status: false, error: "user_code_not_found" });
      }
      if (outcome.alreadyPaid) {
        return res.status(409).json({
          status: false,
          error: "already_paid_for_month",
          mode: outcome.mode,
          data: outcome.payout,
        });
      }
      if (outcome.notEligible) {
        return res.status(400).json({
          status: false,
          error: "not_eligible",
          mode: outcome.mode,
          data: outcome.preview,
        });
      }
      if (outcome.mode === "auto" && outcome.walletInvalid) {
        // User profile wallet is missing/invalid → do NOT call Espees API
        return res.status(400).json({
          status: false,
          error: "bad_wallet_address",
          message:
            "User payout wallet is missing or not a valid address, e.g. 0xee840a64bee77abae1e8de0a18a6f65367ac6cce",
        });
      }
      if (outcome.mode === "auto" && outcome.espeesError) {
        // Espees failure during AUTO mode → do NOT record payout; surface error
        return res.status(502).json({
          status: false,
          error: outcome.espeesError,
          data: outcome.espeesDetail || null,
        });
      }

      // Success
      if (outcome.mode === "admin") {
        return res.status(201).json({
          status: true,
          mode: "admin",
          data: { request: outcome.request, preview: outcome.preview },
        });
      }
      // AUTO success (vend completed, payout recorded)
      return res.status(201).json({
        status: true,
        mode: "auto",
        data: {
          payout: outcome.payout,
          request: outcome.request,
          preview: outcome.preview,
          espees: outcome.espees, // includes token/vend API responses for auditing
        },
      });
    })
  );

  // POST /affiliate/payouts/approve
  // Admin-only
  // Body: { email, year, month, admin_note?, decided_by? }
  router.post(
    "/affiliate/payouts/approve",
    requireAdminForList,
    asyncHandler(async (req, res) => {
      const b = trimAllStrings(req.body || {});
      const email = b.email;
      const year = Number(b.year);
      const month = Number(b.month);
      const adminNote = b.admin_note || null;
      const decidedBy = b.decided_by || "admin";

      if (!email)
        return res.status(400).json({ status: false, error: "email_required" });
      if (
        !Number.isFinite(year) ||
        !Number.isFinite(month) ||
        month < 1 ||
        month > 12
      ) {
        return res.status(400).json({ status: false, error: "bad_month_year" });
      }
      if (isCurrentMonthUTC(year, month)) {
        return res
          .status(400)
          .json({ status: false, error: "cannot_pay_current_month" });
      }

      const out = await withClient(async (db) => {
        const preview = await computeMonthPayoutPreview(db, email, year, month);
        if (!preview.ok) return preview;
        if (preview.alreadyPaid)
          return { alreadyPaid: true, payout: preview.payoutRow };

        if (preview.earned <= 0) return { notEligible: true, preview };

        // Create payout row (unique per month)
        let payout;
        try {
          const ir = await db.query(
            `INSERT INTO public.payouts
             (email, code, year, month, total_amount_espees, percentage, earned_amount_espees, tier_name, note, paid_by)
           VALUES
             ($1,    $2,   $3,   $4,    $5,                  $6,         $7,                  $8,        $9,  $10)
           RETURNING *`,
            [
              email,
              preview.code,
              year,
              month,
              preview.total,
              preview.percentage,
              preview.earned,
              preview.tierName,
              adminNote,
              decidedBy,
            ]
          );
          payout = ir.rows[0];
        } catch (e) {
          if (String(e.code) === "23505") {
            const existed = await db.query(
              `SELECT * FROM public.payouts WHERE lower(email)=lower($1) AND year=$2 AND month=$3 LIMIT 1`,
              [email, year, month]
            );
            return { alreadyPaid: true, payout: existed.rows[0] };
          }
          throw e;
        }

        // Upsert request → approved & link payout
        const rq = await db.query(
          `INSERT INTO public.payout_requests
           (email, code, year, month, total_amount_espees, percentage, earned_amount_espees, tier_name, status, note, requested_at, decided_at, decided_by, admin_note, payout_id)
         VALUES
           ($1,    $2,   $3,   $4,    $5,                  $6,         $7,                  $8,        'approved', $9,  now(), now(), $10, $11, $12)
         ON CONFLICT (lower(email), year, month) DO UPDATE SET
           code                  = EXCLUDED.code,
           total_amount_espees   = EXCLUDED.total_amount_espees,
           percentage            = EXCLUDED.percentage,
           earned_amount_espees  = EXCLUDED.earned_amount_espees,
           tier_name             = EXCLUDED.tier_name,
           status                = 'approved',
           note                  = EXCLUDED.note,
           decided_at            = now(),
           decided_by            = EXCLUDED.decided_by,
           admin_note            = EXCLUDED.admin_note,
           payout_id             = EXCLUDED.payout_id
         RETURNING *`,
          [
            email,
            preview.code,
            year,
            month,
            preview.total,
            preview.percentage,
            preview.earned,
            preview.tierName,
            adminNote,
            decidedBy,
            adminNote,
            payout.id,
          ]
        );

        return { payout, request: rq.rows[0], preview };
      });

      if (out.reason === "user_code_not_found") {
        return res
          .status(404)
          .json({ status: false, error: "user_code_not_found" });
      }
      if (out.alreadyPaid) {
        return res.status(409).json({
          status: false,
          error: "already_paid_for_month",
          data: out.payout,
        });
      }
      if (out.notEligible) {
        return res
          .status(400)
          .json({ status: false, error: "not_eligible", data: out.preview });
      }
      return res.status(201).json({ status: true, data: out });
    })
  );

  // POST /affiliate/payouts/reject
  // Admin-only
  // Body: { email, year, month, admin_note?, decided_by? }
  router.post(
    "/affiliate/payouts/reject",
    requireAdminForList,
    asyncHandler(async (req, res) => {
      const b = trimAllStrings(req.body || {});
      const email = b.email;
      const year = Number(b.year);
      const month = Number(b.month);
      const adminNote = b.admin_note || null;
      const decidedBy = b.decided_by || "admin";

      if (!email)
        return res.status(400).json({ status: false, error: "email_required" });
      if (
        !Number.isFinite(year) ||
        !Number.isFinite(month) ||
        month < 1 ||
        month > 12
      ) {
        return res.status(400).json({ status: false, error: "bad_month_year" });
      }

      const out = await withClient(async (db) => {
        // If already paid, cannot reject
        const paid = await db.query(
          `SELECT id FROM public.payouts WHERE lower(email)=lower($1) AND year=$2 AND month=$3 LIMIT 1`,
          [email, year, month]
        );
        if (paid.rows[0]) return { alreadyPaid: true };

        const rq = await db.query(
          `UPDATE public.payout_requests
         SET status='rejected', decided_at=now(), decided_by=$4, admin_note=$5
         WHERE lower(email)=lower($1) AND year=$2 AND month=$3
         RETURNING *`,
          [email, year, month, decidedBy, adminNote]
        );
        return { request: rq.rows[0] || null };
      });

      if (out.alreadyPaid) {
        return res
          .status(409)
          .json({ status: false, error: "already_paid_for_month" });
      }
      if (!out.request) {
        return res
          .status(404)
          .json({ status: false, error: "request_not_found" });
      }
      return res.json({ status: true, data: out.request });
    })
  );

  // POST /affiliate/payouts/eligible-months
  // Body: { email, token, include_zero?: boolean=false, limit?: number=24, offset?: number=0 }
  // Auth: admin OR verified user token for email
  // Returns months from user.created_at up to the end of the last completed month (UTC).
  router.post(
    "/affiliate/payouts/eligible-months",
    asyncHandler(async (req, res, next) => {
      req.body = trimAllStrings(req.body || {});
      await requireAdminOrBodyToken(req, res, next);
    }),
    asyncHandler(async (req, res) => {
      const email = req.body?.email;
      if (!email)
        return res.status(400).json({ status: false, error: "email_required" });

      const includeZero =
        String(req.body?.include_zero ?? "false").toLowerCase() === "true";

      const out = await withClient(async (db) => {
        const { code, createdAtISO } = await getUserCodeAndCreatedAtByEmail(
          db,
          email
        );
        if (!code) return { notFound: true };

        // pick which column to sum
        const { col: amtCol, sqlExpr: amountExpr } =
          await resolveTxnAmountColumn(db);

        // Past months only: [user.created_at, first day of current month)
        const now = new Date();
        const endISO = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0)
        ).toISOString();
        const startISO = createdAtISO || "1970-01-01T00:00:00.000Z";
        if (new Date(startISO) >= new Date(endISO)) {
          return { rows: [], startISO, endISO };
        }

        const sql = `
        WITH bounds AS (
          SELECT $1::timestamptz AS start_iso, $2::timestamptz AS end_iso
        ),
        tx AS (
          SELECT
            (date_part('year',  to_timestamp(t."timestamp"::bigint / 1000.0)))::int AS year,
            (date_part('month', to_timestamp(t."timestamp"::bigint / 1000.0)))::int AS month,
            SUM(${amountExpr})::numeric(18,2) AS total_amount
          FROM public.transactions t
          CROSS JOIN bounds b
          WHERE lower(t.code) = lower($3)
            AND to_timestamp(t."timestamp"::bigint / 1000.0) >= b.start_iso
            AND to_timestamp(t."timestamp"::bigint / 1000.0) <  b.end_iso
          GROUP BY 1,2
        ),
        paid AS (
          SELECT year, month, id AS payout_id,
                 total_amount_espees  AS paid_total,
                 earned_amount_espees AS paid_earned
          FROM public.payouts
          WHERE lower(email) = lower($4)
        ),
        merged AS (
          SELECT
            tx.year, tx.month, tx.total_amount,
            paid.payout_id, paid.paid_total, paid.paid_earned
          FROM tx
          LEFT JOIN paid
            ON paid.year = tx.year AND paid.month = tx.month
        ),
        filtered AS (
          SELECT * FROM merged
          ${
            includeZero
              ? ""
              : "WHERE total_amount IS NOT NULL AND total_amount > 0"
          }
        )
        SELECT *
        FROM filtered
        ORDER BY year DESC, month DESC
      `;

        const params = [startISO, endISO, code, email];
        const r = await db.query(sql, params);

        // Build output and **skip months with "no tier"** (unpaid-only).
        const rows = [];
        for (const row of r.rows) {
          const y = Number(row.year);
          const m = Number(row.month);
          const total = Number(row.total_amount || 0);
          const paid = !!row.payout_id;

          if (paid) {
            rows.push({
              year: y,
              month: m,
              status: "paid",
              // total_amount_espees: Number(row.paid_total ?? total),
              earned_amount_espees: Number(row.paid_earned ?? 0),
              payout_id: row.payout_id,
            });
            continue;
          }

          // If unpaid: compute tier; drop the month if there's "no tier".
          const tier = commissionTier(total);
          // Treat as "no tier" if missing, unnamed, or non-positive rate.
          const noTier =
            !tier ||
            !tier.name ||
            typeof tier.rate !== "number" ||
            tier.rate <= 0;

          if (noTier) {
            // Do not include this month in the response
            continue;
          }

          const earned = +(total * tier.rate).toFixed(2);
          rows.push({
            year: y,
            month: m,
            status: total > 0 ? "unpaid" : "not_eligible",
            // total_amount_espees: +total.toFixed(2),
            tier: tier.name,
            percentage: +(tier.rate * 100).toFixed(2),
            earned_amount_espees: earned,
          });
        }

        return { rows, startISO, endISO, amtCol };
      });

      if (out.notFound) {
        return res
          .status(404)
          .json({ status: false, error: "user_code_not_found" });
      }

      return res.json({
        status: true,
        email,
        amount_column_used: out.amtCol || null, // helpful for debugging
        window: { from: out.startISO, to_exclusive: out.endISO },
        total: out.rows.length, // full count returned (no limit/offset)
        data: out.rows,
      });
    })
  );

  // POST /affiliate/payouts/list
  // Body: { limit?, offset?, email?, year?, month?, q? }
  // Auth: admin
  router.post(
    "/affiliate/payouts/list",
    requireAdminForList,
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};

      // helpers
      const toNumberOrNull = (v) =>
        v === undefined || v === null || String(v).trim() === ""
          ? null
          : Number(v);

      // pagination
      const limit = Math.max(
        1,
        Math.min(200, Number(String(b.limit ?? "").trim() || 50))
      );
      const offset = Math.max(0, Number(String(b.offset ?? "").trim() || 0));

      // filters
      const email = (b.email ? String(b.email) : "").trim();
      const year = toNumberOrNull(b.year); // null when missing/blank
      const month = toNumberOrNull(b.month); // null when missing/blank
      const q = (typeof b.q === "string" ? b.q : "").trim();

      // validate optional month
      if (
        month !== null &&
        (!Number.isFinite(month) || month < 1 || month > 12)
      ) {
        return res.status(400).json({ status: false, error: "bad_month" });
      }
      if (year !== null && !Number.isFinite(year)) {
        return res.status(400).json({ status: false, error: "bad_year" });
      }

      const rows = await withClient(async (db) => {
        const values = [];
        const whereParts = [];

        if (email) {
          values.push(email);
          whereParts.push(`lower(email) = lower($${values.length})`);
        }
        if (year !== null) {
          values.push(year);
          whereParts.push(`year = $${values.length}`);
        }
        if (month !== null) {
          values.push(month);
          whereParts.push(`month = $${values.length}`);
        }
        if (q) {
          values.push(`%${q}%`);
          const p = `$${values.length}`;
          whereParts.push(
            `(email ILIKE ${p} OR COALESCE(code,'') ILIKE ${p} OR COALESCE(tier_name,'') ILIKE ${p} OR COALESCE(note,'') ILIKE ${p})`
          );
        }

        const where = whereParts.length
          ? `WHERE ${whereParts.join(" AND ")}`
          : "";

        // LIMIT/OFFSET placeholders go last
        values.push(limit, offset);
        const limIdx = values.length - 1;
        const offIdx = values.length;

        const sql = `
        SELECT id, email, code, year, month,
               total_amount_espees, percentage, earned_amount_espees,
               tier_name, note, paid_by, created_at
        FROM public.payouts
        ${where}
        ORDER BY created_at DESC NULLS LAST, year DESC, month DESC, id DESC
        LIMIT $${limIdx} OFFSET $${offIdx};
      `;

        const r = await db.query(sql, values);
        return r.rows;
      });

      res.json({
        status: true,
        data: rows,
        limit,
        offset,
        filters: {
          email: email || null,
          year: year ?? null,
          month: month ?? null,
          q: q || null,
        },
      });
    })
  );

  // POST /affiliate/users/code/exists
  // Body: { code: string, exclude_email?: string }
  // Auth: protected by router.use("/affiliate", requireGeneralApiKey) in your file
  router.post(
    "/affiliate/users/code/exists",
    asyncHandler(async (req, res) => {
      const raw = (req.body?.code ?? "").toString().trim();
      if (!raw) {
        return res.status(400).json({ status: false, error: "code_required" });
      }

      // Validate & normalize with your existing rules (4–12, [a-z0-9_], at least one letter)
      const v = normalizeAndValidateCode(raw);
      if (!v.ok) {
        return res.status(400).json({
          status: false,
          error: "invalid_code_format",
          reason: v.reason,
          message: v.message,
        });
      }
      const code = v.code; // normalized lowercase

      const excludeEmail = req.body?.exclude_email;

      const exists = await withClient(async (db) => {
        const params = [code];
        let sql = `SELECT 1 FROM public.users WHERE lower(code) = lower($1)`;
        if (excludeEmail) {
          params.push(excludeEmail);
          sql += ` AND lower(email) <> lower($2)`;
        }
        const r = await db.query(sql, params);
        return r.rowCount > 0;
      });

      return res.json({
        status: true,
        code,
        exists,
        available: !exists,
      });
    })
  );

  // POST /affiliate/users/check
  // Body: { email }
  // Auth: protected by router.use("/affiliate", requireGeneralApiKey)
router.post(
  "/affiliate/users/check",
  asyncHandler(async (req, res) => {
    const email = req.body?.email;
    if (!email) {
      return res.status(400).json({ status: false, error: "email_required" });
    }

    const row = await withClient(async (db) => {
      const r = await db.query(
        `SELECT *
           FROM public.users
          WHERE lower(email) = lower($1)
          LIMIT 1`,
        [email]
      );
      return r.rows[0] || null;
    });

    if (!row) {
      return res.json({
        status: true,
        email,
        exists: false,
        complete: false,
        error: "not_found",
      });
    }

    // Determine user type (default to 'affiliate' when absent/invalid)
    const rawType = String(row.type || "affiliate").trim().toLowerCase();
    const type = rawType === "solutionist" ? "solutionist" : "affiliate";
    const isAffiliate = type === "affiliate";

    // --- completeness rules (all fields except "status") ---
    // Common required non-empty strings for BOTH affiliate & solutionist
    const REQUIRED_STRINGS_COMMON = [
      "code",
      "title",
      "last_name",
      "zonal_church",
      "contact_email",
      "country",
      "first_name",
      "group_church",
      "referral",
      "kc_username",
      "phone",
    ];

    // Affiliate-only required non-empty strings
    const REQUIRED_STRINGS_AFFILIATE = [
      "plan",
      "payout",
      "bio", // "what best describes you"
    ];

    const missing = [];

    // helper checks
    const isNonEmptyString = (v) =>
      typeof v === "string" && v.trim().length > 0;
    const isNonEmptyObject = (v) =>
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.keys(v).length > 0;
    const isNonEmptyArray = (v) => Array.isArray(v) && v.length > 0;

    // 1) required non-empty strings (common)
    for (const k of REQUIRED_STRINGS_COMMON) {
      if (!isNonEmptyString(row[k])) missing.push(k);
    }

    // 1b) affiliate-only required non-empty strings
    if (isAffiliate) {
      for (const k of REQUIRED_STRINGS_AFFILIATE) {
        if (!isNonEmptyString(row[k])) missing.push(k);
      }
    }

    // 2) code format (lowercase; 4–12 chars; [a-z0-9_] and must contain at least one letter)
    if (isNonEmptyString(row.code)) {
      const codeStr = String(row.code).trim().toLowerCase();
      if (!CODE_RE.test(codeStr)) missing.push("code_format_invalid");
    } // else already counted as missing "code"

    // 3) followers must be a finite number (>= 0) — affiliates only
    if (isAffiliate) {
      if (
        !(
          row.followers !== null &&
          row.followers !== undefined &&
          Number.isFinite(Number(row.followers))
        )
      ) {
        missing.push("followers");
      }
    }

    // 4) is_member must be boolean (not null) — applies to both
    if (!(row.is_member === true || row.is_member === false)) {
      missing.push("is_member");
    }

    // 5) platforms must be a non-empty object — affiliates only
    if (isAffiliate) {
      if (!isNonEmptyObject(row.platforms)) {
        missing.push("platforms");
      }
    }

    // 6) social_links must be a non-empty array of non-empty strings — affiliates only
    if (isAffiliate) {
      if (
        !isNonEmptyArray(row.social_links) ||
        !row.social_links.every((s) => isNonEmptyString(s))
      ) {
        missing.push("social_links");
      }
    }

    // 7) passport_photo must exist (path string) — affiliates only
    if (isAffiliate) {
      if (!isNonEmptyString(row.passport_photo)) {
        missing.push("passport_photo");
      }
    }

    const complete = missing.length === 0;

    return res.json({
      status: true,
      email,
      exists: true,
      type, // echo resolved type for client awareness
      complete,
      ...(complete ? {} : { error: "profile_not_complete", missing }),
    });
  })
);

  // POST /affiliate/users/get
  // Body: { email, token }
  // Auth: x-api-key + (admin OR verified user for body.email)
  router.post(
    "/affiliate/users/get",
    asyncHandler(async (req, res, next) => {
      req.body = trimAllStrings(req.body || {});
      await requireAdminOrBodyToken(req, res, next);
    }),
    asyncHandler(async (req, res) => {
      const email = req.body?.email;
      if (!email) {
        return res.status(400).json({ status: false, error: "email_required" });
      }

      const row = await withClient(async (db) => {
        const r = await db.query(
          `SELECT * FROM public.users WHERE lower(email) = lower($1) LIMIT 1`,
          [email]
        );
        return r.rows[0] || null;
      });

      if (!row) {
        return res.status(404).json({ status: false, error: "not_found" });
      }
      return res.json({ status: true, data: row });
    })
  );

  // POST /affiliate/users/passport
  // Body: { email, token, attachment?: boolean }
  // Auth: x-api-key + (admin OR verified user token for body.email)
  // Returns the binary image; 404 if missing, 403/401 if unauthorized.
  router.post(
    "/affiliate/users/passport",
    asyncHandler(async (req, res, next) => {
      // Normalize body first so the auth guard reads trimmed values
      req.body = trimAllStrings(req.body || {});
      await requireAdminOrBodyToken(req, res, next);
    }),
    asyncHandler(async (req, res) => {
      const email = req.body?.email;
      if (!email) {
        return res.status(400).json({ status: false, error: "email_required" });
      }

      // Optional: force download when attachment=true
      const asAttachment =
        String(req.body?.attachment ?? "false").toLowerCase() === "true";

      // Look up user's stored private path
      const row = await withClient(async (db) => {
        const r = await db.query(
          `SELECT passport_photo FROM public.users WHERE lower(email)=lower($1) LIMIT 1`,
          [email]
        );
        return r.rows[0] || null;
      });

      const rel = row?.passport_photo;
      if (!rel || typeof rel !== "string" || !rel.trim()) {
        return res
          .status(404)
          .json({ status: false, error: "passport_not_found" });
      }

      // Build absolute path and ensure it lives inside PASSPORT_DIR
      const safeRel = rel.replace(/^\/+/, ""); // strip leading slashes
      const abs = path.resolve(path.join(process.cwd(), safeRel));
      const allowedRoot = path.resolve(PASSPORT_DIR);
      if (!abs.startsWith(allowedRoot + path.sep)) {
        return res
          .status(404)
          .json({ status: false, error: "passport_not_found" });
      }

      // Content type by extension
      const ext = path.extname(abs).toLowerCase();
      const mime =
        ext === ".png"
          ? "image/png"
          : ext === ".webp"
          ? "image/webp"
          : "image/jpeg";
      res.setHeader("Content-Type", mime);
      if (asAttachment) {
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${path.basename(abs)}"`
        );
      }

      // Stream the file (clean ENOENT -> 404)
      const stream = fs.createReadStream(abs);
      stream.on("error", (err) => {
        if (err && err.code === "ENOENT") {
          return res
            .status(404)
            .json({ status: false, error: "passport_not_found" });
        }
        return res.status(500).json({ status: false, error: "read_error" });
      });
      stream.pipe(res);
    })
  );

  // --- ADMIN-ONLY: create a transaction (no email needed; proceed even if code not in users) ---
  // POST /affiliate/admin/transactions
  // Headers: x-api-key, x-admin-token
  router.post(
    "/affiliate/admin/transactions",
    asyncHandler(async (req, res) => {
      if (!hasAdminToken(req)) {
        return res
          .status(401)
          .json({ status: false, error: "admin_token_required" });
      }

      req.body = trimAllStrings(req.body || {});
      const b = req.body || {};

      // require affiliate code (but don't verify it exists)
      const code = (b.code || "").toString().trim().toLowerCase();
      // if (!code) {
      //   return res.status(400).json({ status: false, error: "code_required" });
      // }

      // helpers
      const toNull = (v) => {
        if (v == null) return null;
        if (typeof v === "string") {
          const s = v.trim();
          return !s || /^(na|n\/a|undefined)$/i.test(s) ? null : s;
        }
        return v;
      };

      // amount: accept amount|total_amount|espees_amount|value (strip commas/spaces)
      const amountNum = readEspeesAmount(b);
      if (!Number.isFinite(amountNum) || amountNum <= 0) {
        return res.status(400).json({
          status: false,
          error: "bad_amount",
          message:
            "amount must be a number > 0 (amount/total_amount/espees_amount/value)",
        });
      }

      // timestamp (ms since epoch) default: now
      let ts = Number(b.timestamp);
      if (!Number.isFinite(ts) || ts <= 0) ts = Date.now();
      ts = Math.trunc(ts);

      const payload = {
        id: toNull(b.id),
        code, // insert even if not in users
        amount: amountNum,
        city: toNull(b.city),
        continent: toNull(b.continent),
        country: toNull(b.country),
        currency: toNull(b.currency),
        user_email: toNull(b.user_email),
        gift_email: toNull(b.gift_email),
        narration: toNull(b.narration),
        promo: toNull(b.promo),
        date: toNull(b.date),
        reference: toNull(b.reference),
        timestamp: ts,
        type: toNull(b.type),
      };

      // build INSERT
      const cols = [],
        vals = [],
        params = [];
      let i = 1;
      for (const [k, v] of Object.entries(payload)) {
        cols.push(`"${k}"`);
        vals.push(`$${i++}`);
        params.push(v);
      }

      const sql = `
      INSERT INTO public.transactions (${cols.join(", ")})
      VALUES (${vals.join(", ")})
      RETURNING *;
    `;

      const row = await withClient(async (db) => {
        const r = await db.query(sql, params);
        return r.rows[0];
      });

      return res.status(201).json({ status: true, data: row });
    })
  );

  // -------- ADMIN: STATS BY CODE (ALL-TIME, PER CODE) + TABLE-WIDE TOTALS --------
  // POST /affiliate/admin/codes/summary
  // Headers: x-api-key, x-admin-token
  // Body (all optional):
  //   {
  //     limit?: 1-200 (default 50),
  //     offset?: 0+ (default 0),
  //     q?: string (search email/code/first_name/last_name),
  //     order_by?: 'total'|'transactions'|'updated_at'|'created_at'|'code' (default 'total'),
  //     order_dir?: 'asc'|'desc' (default 'desc'),
  //     has_transactions?: 'true'|'false'  // overall, from each user's created_at
  //   }
  router.post(
    "/affiliate/admin/codes/summary",
    requireAdminForList,
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};

      const limit = Math.max(
        1,
        Math.min(200, Number(String(b.limit ?? "").trim() || 50))
      );
      const offset = Math.max(0, Number(String(b.offset ?? "").trim() || 0));
      const q = (typeof b.q === "string" ? b.q : "").trim();

      const orderByRaw = String(b.order_by || "total").toLowerCase();
      const orderDir =
        String(b.order_dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
      const hasTxFilter = String(b.has_transactions ?? "").toLowerCase();

      const ORDER_COL = (() => {
        switch (orderByRaw) {
          case "total":
            return `"overall_total_made_espees"`;
          case "transactions":
            return `"overall_transactions_count"`;
          case "updated_at":
            return `updated_at`;
          case "created_at":
            return `created_at`;
          case "code":
            return `LOWER(code)`;
          default:
            return `"overall_total_made_espees"`;
        }
      })();

      const out = await withClient(async (db) => {
        const { sqlExpr: amountExpr } = await resolveTxnAmountColumn(db);

        // ---------- TABLE-WIDE TOTALS (VALID CODES; CLAMPED TO users.created_at) ----------
        const tableAggSql = `
        SELECT
          COUNT(*)::bigint                                AS all_transactions,
          COALESCE(SUM(${amountExpr}), 0)::numeric(18,2) AS all_total_made_espees
        FROM public.transactions t
        JOIN public.users u
          ON LOWER(t.code) = LOWER(u.code)
        WHERE ${TS_EXPR} >= u.created_at
      `;
        const tableAgg = await db.query(tableAggSql);
        const totalsAll = {
          all_transactions: Number(tableAgg.rows[0]?.all_transactions || 0),
          all_total_made_espees: Number(
            tableAgg.rows[0]?.all_total_made_espees || 0
          ),
        };

        // Count total affiliate users (valid codes)
        const usersAgg = await db.query(`
        SELECT COUNT(*)::bigint AS total_users
        FROM public.users
        WHERE code IS NOT NULL AND btrim(code) <> ''
      `);
        const totalUsers = Number(usersAgg.rows[0]?.total_users || 0);

        // ---------- PER-CODE (CLAMPED TO users.created_at) ----------
        const values = [];
        const where = [];
        if (q) {
          values.push(`%${q}%`);
          const p = `$${values.length}`;
          where.push(
            `(email ILIKE ${p} OR COALESCE(code,'') ILIKE ${p} OR COALESCE(first_name,'') ILIKE ${p} OR COALESCE(last_name,'') ILIKE ${p})`
          );
        }
        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

        values.push(limit, offset);
        const limIdx = values.length - 1;
        const offIdx = values.length;

        const sql = `
        WITH tx_overall AS (
          SELECT LOWER(u.code) AS lcode,
                 COUNT(*)::bigint                                AS overall_transactions_count,
                 COALESCE(SUM(${amountExpr}), 0)::numeric(18,2) AS overall_total_made_espees
          FROM public.transactions t
          JOIN public.users u ON LOWER(t.code) = LOWER(u.code)
          WHERE ${TS_EXPR} >= u.created_at
          GROUP BY LOWER(u.code)
        ),
        base AS (
          SELECT
            u.*,
            COALESCE(tx_overall.overall_transactions_count, 0)               AS overall_transactions_count,
            COALESCE(tx_overall.overall_total_made_espees, 0)::numeric(18,2) AS overall_total_made_espees
          FROM public.users u
          LEFT JOIN tx_overall ON LOWER(u.code) = tx_overall.lcode
        ),
        filt AS (
          SELECT * FROM base
          ${whereSql}
        )
        SELECT
          *,
          COUNT(*) OVER() AS __total_count
        FROM filt
        ${
          hasTxFilter === "true"
            ? "WHERE COALESCE(overall_transactions_count,0) > 0"
            : hasTxFilter === "false"
            ? "WHERE COALESCE(overall_transactions_count,0) = 0"
            : ""
        }
        ORDER BY ${ORDER_COL} ${orderDir}, updated_at DESC NULLS LAST, email ASC
        LIMIT $${limIdx} OFFSET $${offIdx};
      `;
        const r = await db.query(sql, values);

        return { rows: r.rows, totalsAll, totalUsers };
      });

      const rows = out.rows;
      const total = rows[0]?.__total_count ? Number(rows[0].__total_count) : 0;

      const data = rows.map((r) => {
        const {
          __total_count,
          overall_transactions_count,
          overall_total_made_espees,
          ...user
        } = r;

        return {
          code: user.code || null,
          overall_transactions_count: Number(overall_transactions_count || 0),
          overall_total_made_espees: Number(overall_total_made_espees || 0),
          user,
        };
      });

      return res.json({
        status: true,
        limit,
        offset,
        total,
        totals: {
          all_transactions: out.totalsAll.all_transactions,
          all_total_made_espees: out.totalsAll.all_total_made_espees,
          total_users: out.totalUsers,
        },
        filters: {
          q: q || null,
          order_by: orderByRaw,
          order_dir: orderDir.toLowerCase(),
          has_transactions: hasTxFilter || null,
        },
        data,
      });
    })
  );

  // -------- ADMIN: STATS BY CODE FOR A GIVEN MONTH + TABLE-WIDE TOTALS --------
  // POST /affiliate/admin/codes/summary/by-month
  // Headers: x-api-key, x-admin-token
  // Body:
  //   {
  //     year: number,  // required
  //     month: 1-12,   // required
  //     q?: string,
  //     limit?: 1-200 = 50,
  //     offset?: 0+ = 0,
  //     order_by?: 'total'|'transactions'|'updated_at'|'created_at'|'code' (default 'total'),
  //     order_dir?: 'asc'|'desc' (default 'desc'),
  //     has_transactions?: 'true'|'false' // in THIS month
  //   }
// -------- ADMIN: STATS BY CODE FOR A GIVEN MONTH + TABLE-WIDE TOTALS --------
// POST /affiliate/admin/codes/summary/by-month
router.post(
  "/affiliate/admin/codes/summary/by-month",
  requireAdminForList,
  asyncHandler(async (req, res) => {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const year = Number(b.year);
    const month = Number(b.month);

    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
      return res.status(400).json({ status: false, error: "bad_month_year" });
    }

    const limit  = Math.max(1, Math.min(200, Number(String(b.limit  ?? "").trim() || 50)));
    const offset = Math.max(0, Number(String(b.offset ?? "").trim() || 0));
    const q      = (typeof b.q === "string" ? b.q : "").trim();

    const orderByRaw = String(b.order_by || "total").toLowerCase();
    const orderDir   = String(b.order_dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
    const hasTxFilter = String(b.has_transactions ?? "").toLowerCase();

    const ORDER_COL = (() => {
      switch (orderByRaw) {
        case "total":        return `"total_made_espees"`;   // month total
        case "transactions": return `"transactions_count"`;  // month count
        case "updated_at":   return `updated_at`;
        case "created_at":   return `created_at`;
        case "code":         return `LOWER(code)`;
        default:             return `"total_made_espees"`;
      }
    })();

    const { startISO, endISO } = monthRangeUTC(year, month);

    const out = await withClient(async (db) => {
      const { sqlExpr: amountExpr } = await resolveTxnAmountColumn(db);

      // ---------- TABLE-WIDE TOTALS (VALID CODES; CLAMPED TO users.created_at) ----------
      const monthAggSql = `
        WITH bounds AS (
          SELECT $1::timestamptz AS start_iso, $2::timestamptz AS end_iso
        )
        SELECT
          COUNT(*)::bigint                                AS month_transactions,
          COALESCE(SUM(${amountExpr}), 0)::numeric(18,2) AS month_total_made_espees,
          COUNT(DISTINCT LOWER(u.code))::bigint          AS active_users
        FROM public.transactions t
        JOIN public.users u ON LOWER(t.code) = LOWER(u.code)
        CROSS JOIN bounds b
        WHERE ${TS_EXPR} >= GREATEST(u.created_at, b.start_iso)
          AND ${TS_EXPR} <  b.end_iso
      `;
      const monthAgg = await db.query(monthAggSql, [startISO, endISO]);
      const totalsMonth = {
        month_transactions: Number(monthAgg.rows[0]?.month_transactions || 0),
        month_total_made_espees: Number(monthAgg.rows[0]?.month_total_made_espees || 0),
        active_users: Number(monthAgg.rows[0]?.active_users || 0),
      };

      const allAggSql = `
        SELECT
          COUNT(*)::bigint                                AS all_transactions,
          COALESCE(SUM(${amountExpr}), 0)::numeric(18,2) AS all_total_made_espees
        FROM public.transactions t
        JOIN public.users u ON LOWER(t.code) = LOWER(u.code)
        WHERE ${TS_EXPR} >= u.created_at
      `;
      const allAgg = await db.query(allAggSql);
      const totalsAll = {
        all_transactions: Number(allAgg.rows[0]?.all_transactions || 0),
        all_total_made_espees: Number(allAgg.rows[0]?.all_total_made_espees || 0),
      };

      const usersAgg = await db.query(`
        SELECT COUNT(*)::bigint AS total_users
        FROM public.users
        WHERE code IS NOT NULL AND btrim(code) <> ''
      `);
      const totalUsers = Number(usersAgg.rows[0]?.total_users || 0);

      // ---------- PER-CODE (month + overall; both clamped to users.created_at) ----------
      const values = [startISO, endISO];
      const where = [];
      if (q) {
        values.push(`%${q}%`);
        const p = `$${values.length}`;
        where.push(
          `(email ILIKE ${p} OR COALESCE(code,'') ILIKE ${p} OR COALESCE(first_name,'') ILIKE ${p} OR COALESCE(last_name,'') ILIKE ${p})`
        );
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      values.push(limit, offset);
      const limIdx = values.length - 1;
      const offIdx = values.length;

      const sql = `
        WITH bounds AS (
          SELECT $1::timestamptz AS start_iso, $2::timestamptz AS end_iso
        ),
        tx_month AS (
          SELECT
            LOWER(u.code) AS lcode,
            COUNT(*)::bigint                                AS transactions_count,
            COALESCE(SUM(${amountExpr}), 0)::numeric(18,2) AS total_made_espees
          FROM public.transactions t
          JOIN public.users u ON LOWER(t.code) = LOWER(u.code)
          CROSS JOIN bounds b
          WHERE ${TS_EXPR} >= GREATEST(u.created_at, b.start_iso)
            AND ${TS_EXPR} <  b.end_iso
          GROUP BY LOWER(u.code)
        ),
        tx_overall AS (
          SELECT
            LOWER(u.code) AS lcode,
            COUNT(*)::bigint                                AS overall_transactions_count,
            COALESCE(SUM(${amountExpr}), 0)::numeric(18,2) AS overall_total_made_espees
          FROM public.transactions t
          JOIN public.users u ON LOWER(t.code) = LOWER(u.code)
          WHERE ${TS_EXPR} >= u.created_at
          GROUP BY LOWER(u.code)
        ),
        base AS (
          SELECT
            u.*,
            COALESCE(tx_month.transactions_count, 0)               AS transactions_count,        -- month
            COALESCE(tx_month.total_made_espees, 0)::numeric(18,2) AS total_made_espees,         -- month
            COALESCE(tx_overall.overall_transactions_count, 0)               AS overall_transactions_count,
            COALESCE(tx_overall.overall_total_made_espees, 0)::numeric(18,2) AS overall_total_made_espees
          FROM public.users u
          LEFT JOIN tx_month   ON LOWER(u.code) = tx_month.lcode
          LEFT JOIN tx_overall ON LOWER(u.code) = tx_overall.lcode
        ),
        filt AS (
          SELECT * FROM base
          ${whereSql}
        )
        SELECT
          *,
          COUNT(*) OVER() AS __total_count
        FROM filt
        ${
          hasTxFilter === "true"
            ? "WHERE COALESCE(transactions_count,0) > 0"
            : hasTxFilter === "false"
            ? "WHERE COALESCE(transactions_count,0) = 0"
            : ""
        }
        ORDER BY ${ORDER_COL} ${orderDir}, updated_at DESC NULLS LAST, email ASC
        LIMIT $${limIdx} OFFSET $${offIdx};
      `;
      const r = await db.query(sql, values);

      return { rows: r.rows, totalsMonth, totalsAll, totalUsers };
    });

    const rows = out.rows;
    const total = rows[0]?.__total_count ? Number(rows[0].__total_count) : 0;

    // ---- Map & add affiliate month tier info per code ----
    const data = rows.map((r) => {
      const {
        __total_count,
        transactions_count,
        total_made_espees,
        overall_transactions_count,
        overall_total_made_espees,
        ...user
      } = r;

      const monthTotal = Number(total_made_espees || 0);
      const tier = commissionTier(monthTotal); // { name, rate }
      const percentage = +(tier.rate * 100).toFixed(2);
      const earned = +(monthTotal * tier.rate).toFixed(2);

      return {
        code: user.code || null,

        // Month window stats (per code)
        transactions_count: Number(transactions_count || 0),
        total_made_espees: monthTotal,

        // Affiliate month tier & earnings (requested)
        tier_name: tier.name,
        percentage,                  // e.g. 3.5
        earned_amount_espees: earned, // monthTotal * rate

        // All-time stats (per code)
        overall_transactions_count: Number(overall_transactions_count || 0),
        overall_total_made_espees: Number(overall_total_made_espees || 0),

        period: { label: "specific_month_utc", year, month, start: startISO, end: endISO },
        // user // keep commented if you don't want to return full user rows
      };
    });

    return res.json({
      status: true,
      year,
      month,
      limit,
      offset,
      total,
      totals: {
        month_transactions: out.totalsMonth.month_transactions,
        month_total_made_espees: out.totalsMonth.month_total_made_espees,
        active_users: out.totalsMonth.active_users,
        all_transactions: out.totalsAll.all_transactions,
        all_total_made_espees: out.totalsAll.all_total_made_espees,
        total_users: out.totalUsers,
      },
      filters: {
        q: q || null,
        order_by: orderByRaw,
        order_dir: orderDir.toLowerCase(),
        has_transactions: hasTxFilter || null,
      },
      data,
    });
  })
);

  // POST /affiliate/solutions/engagement
// Body: { code, video_id, action: 'view' | 'share', inc?: number }
// Auth: x-api-key (same as the rest)
router.post(
  "/affiliate/solutions/engagement",
  asyncHandler(async (req, res) => {
    const b = trimAllStrings(req.body || {});
    const code = normCode(b.code);
    const videoId = normId(b.video_id);
    const action = (b.action || "").toString().trim().toLowerCase();
    const incRaw = Number(b.inc ?? 1);
    const inc = Number.isFinite(incRaw) && incRaw > 0 ? Math.trunc(incRaw) : 1;

    if (!code)    return res.status(400).json({ status:false, error:"code_required" });
    if (!videoId) return res.status(400).json({ status:false, error:"video_id_required" });
    if (!["view","share"].includes(action))
      return res.status(400).json({ status:false, error:"bad_action" });

    const row = await withClient(async (db) => {
      // Optional: ensure code exists in users (comment this block if you want to allow any code)
      const u = await db.query(`SELECT 1 FROM public.users WHERE lower(code)=lower($1) LIMIT 1`, [code]);
      if (u.rowCount === 0) {
        const e = new Error("user_code_not_found"); e.status = 404; throw e;
      }

      // Upsert & increment atomically
      const isView = action === "view";
      const sql = `
        INSERT INTO public.everyday_engagement_counters
          (code, video_id, views_count, shares_count, first_viewed_at, first_shared_at, last_viewed_at, last_shared_at)
        VALUES
          ($1,   $2,       ${isView ? "$3" : "0"}, ${isView ? "0" : "$3"},
           ${isView ? "now()" : "NULL"}, ${isView ? "NULL" : "now()"},
           ${isView ? "now()" : "NULL"}, ${isView ? "NULL" : "now()"})
        ON CONFLICT (LOWER(code), video_id)
        DO UPDATE SET
          views_count    = everyday_engagement_counters.views_count    + ${isView ? "$3" : "0"},
          shares_count   = everyday_engagement_counters.shares_count   + ${isView ? "0" : "$3"},
          last_viewed_at = ${isView ? "now()" : "everyday_engagement_counters.last_viewed_at"},
          last_shared_at = ${isView ? "everyday_engagement_counters.last_shared_at" : "now()"}
        RETURNING *;
      `;
      const params = [code, videoId, inc];
      const r = await db.query(sql, params);
      return r.rows[0];
    });

    return res.status(201).json({ status:true, data: row });
  })
);

// -------------------- EVERYDAY SOLUTIONS VIDEOS (CRUD) --------------------
// Table: public.affiliate_everydaysolutions
// Columns (from improved schema): id (PK), title, description, day, thumbnail, url,
// provider (generated), metadata jsonb, search_doc (generated),
// created_at, updated_at

// Basic validators (keep lightweight; DB enforces the rest)
const isHttpUrl = (s) => typeof s === "string" && /^https?:\/\//i.test(s || "");
const notBlank = (s) => typeof s === "string" && s.trim().length > 0;

function validateVideoPayload(body, { isCreate = true } = {}) {
  const b = body || {};
  const errors = [];

  if (isCreate) {
    if (!notBlank(b.id)) errors.push("id is required");
    if (!notBlank(b.title)) errors.push("title is required");
    if (!(Number.isFinite(Number(b.day)) && Number(b.day) >= 1 && Number(b.day) <= 366))
      errors.push("day must be an integer between 1 and 366");
    if (!isHttpUrl(b.url)) errors.push("url must start with http/https");
    if (!isHttpUrl(b.thumbnail)) errors.push("thumbnail must start with http/https");
  } else {
    // On update, validate only provided fields
    if ("title" in b && !notBlank(b.title)) errors.push("title cannot be empty");
    if ("day" in b && !(Number.isFinite(Number(b.day)) && Number(b.day) >= 1 && Number(b.day) <= 366))
      errors.push("day must be an integer between 1 and 366");
    if ("url" in b && !isHttpUrl(b.url)) errors.push("url must start with http/https");
    if ("thumbnail" in b && !isHttpUrl(b.thumbnail)) errors.push("thumbnail must start with http/https");
  }

  return errors;
}

// LIST with pagination + search (title/description), order by day|created_at
router.get(
  "/affiliate/videos",
  asyncHandler(async (req, res) => {
    const q = (req.query.q || "").toString().trim();
    const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 50)));
    const offset = Math.max(0, Number(req.query.offset ?? 0));
    const orderByRaw = String(req.query.order_by || "day").toLowerCase();
    const orderDir = String(req.query.order_dir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

    const ORDER_COL = orderByRaw === "created_at" ? "created_at" : "day";

    const data = await withClient(async (db) => {
      const params = [];
      let where = "";
      if (q) {
        // use full-text search when available; fallback to ILIKE
        params.push(q);
        params.push(`%${q}%`);
        params.push(`%${q}%`);
        where = `
          WHERE (search_doc @@ plainto_tsquery('english', $1)
                 OR title ILIKE $2
                 OR description ILIKE $3)
        `;
      }
      params.push(limit, offset);

      const sql = `
        SELECT id, title, description, day, thumbnail, url, provider, metadata,
               created_at, updated_at,
               COUNT(*) OVER() AS __total_count
        FROM public.affiliate_everydaysolutions
        ${where}
        ORDER BY ${ORDER_COL} ${orderDir}, created_at ASC
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `;
      const r = await db.query(sql, params);
      return r.rows;
    });

    const total = data.length ? Number(data[0].__total_count) : 0;
    const items = data.map(({ __total_count, ...row }) => row);
    res.json({ status: true, limit, offset, total, q: q || null, order_by: orderByRaw, order_dir: orderDir.toLowerCase(), data: items });
  })
);

// GET one
router.get(
  "/affiliate/videos/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const row = await withClient(async (db) => {
      const r = await db.query(
        `SELECT id, title, description, day, thumbnail, url, provider, metadata, created_at, updated_at
         FROM public.affiliate_everydaysolutions WHERE id = $1`,
        [id]
      );
      return r.rows[0] || null;
    });
    if (!row) return res.status(404).json({ status: false, error: "not_found" });
    res.json({ status: true, data: row });
  })
);

// CREATE
router.post(
  "/affiliate/videos",
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const errors = validateVideoPayload(b, { isCreate: true });
    if (errors.length) return res.status(400).json({ status: false, error: "bad_request", details: errors });

    // metadata is optional JSON
    let metadata = null;
    if (b.metadata != null) {
      metadata = typeof b.metadata === "object" ? b.metadata : (() => { try { return JSON.parse(String(b.metadata)); } catch { return null; } })();
    }

    try {
      const row = await withClient(async (db) => {
        const sql = `
          INSERT INTO public.affiliate_everydaysolutions
            (id, title, description, day, thumbnail, url, metadata, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now(), now())
          RETURNING id, title, description, day, thumbnail, url, provider, metadata, created_at, updated_at
        `;
        const params = [b.id.trim(), b.title.trim(), b.description ?? null, Number(b.day), b.thumbnail.trim(), b.url.trim(), metadata ? JSON.stringify(metadata) : null];
        const r = await db.query(sql, params);
        return r.rows[0];
      });
      res.status(201).json({ status: true, data: row });
    } catch (e) {
      if (String(e.code) === "23505") {
        // unique violation (id/url/thumbnail)
        return res.status(409).json({ status: false, error: "conflict", message: "Duplicate id/url/thumbnail" });
      }
      throw e;
    }
  })
);

// UPDATE (partial)
router.patch(
  "/affiliate/videos/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const b = req.body || {};
    if ("id" in b) return res.status(400).json({ status: false, error: "id_update_forbidden" });

    const errors = validateVideoPayload(b, { isCreate: false });
    if (errors.length) return res.status(400).json({ status: false, error: "bad_request", details: errors });

    // Build dynamic set
    const sets = [];
    const params = [];
    let i = 1;

    const add = (col, val, cast = "") => {
      sets.push(`${col} = $${i}${cast}`);
      params.push(val);
      i++;
    };

    if (b.title != null) add("title", String(b.title).trim());
    if (b.description != null) add("description", String(b.description));
    if (b.day != null) add("day", Number(b.day));
    if (b.thumbnail != null) add("thumbnail", String(b.thumbnail).trim());
    if (b.url != null) add("url", String(b.url).trim());

    if (b.metadata !== undefined) {
      let metadata = null;
      if (b.metadata != null) {
        metadata = typeof b.metadata === "object" ? b.metadata : (() => { try { return JSON.parse(String(b.metadata)); } catch { return null; } })();
      }
      add("metadata", metadata ? JSON.stringify(metadata) : null, "::jsonb");
    }

    if (!sets.length) {
      // nothing to update -> return current
      const current = await withClient(async (db) => {
        const r = await db.query(
          `SELECT id, title, description, day, thumbnail, url, provider, metadata, created_at, updated_at
             FROM public.affiliate_everydaysolutions WHERE id=$1`,
          [id]
        );
        return r.rows[0] || null;
      });
      if (!current) return res.status(404).json({ status: false, error: "not_found" });
      return res.json({ status: true, data: current });
    }

    const sql = `
      UPDATE public.affiliate_everydaysolutions
         SET ${sets.join(", ")}, updated_at = now()
       WHERE id = $${i}
       RETURNING id, title, description, day, thumbnail, url, provider, metadata, created_at, updated_at
    `;
    params.push(id);

    try {
      const row = await withClient(async (db) => {
        const r = await db.query(sql, params);
        return r.rows[0] || null;
      });
      if (!row) return res.status(404).json({ status: false, error: "not_found" });
      res.json({ status: true, data: row });
    } catch (e) {
      if (String(e.code) === "23505") {
        return res.status(409).json({ status: false, error: "conflict", message: "Duplicate url/thumbnail" });
      }
      throw e;
    }
  })
);

// DELETE
router.delete(
  "/affiliate/videos/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const count = await withClient(async (db) => {
      const r = await db.query(`DELETE FROM public.affiliate_everydaysolutions WHERE id=$1`, [id]);
      return r.rowCount;
    });
    if (!count) return res.status(404).json({ status: false, error: "not_found" });
    res.json({ status: true, deleted: true, id });
  })
);

// ---------- helper (near your other helpers) ----------
const normStr = (s) => (typeof s === "string" ? s.trim() : "");
const toDayKey = (d) => {
  // robust: accept number | string | null
  const s = d == null ? "" : String(d).trim();
  const label = s || "Unassigned";
  // grab the first number for sorting (works for "3", "Day 3", etc.)
  const m = label.match(/\d+/);
  const num = m ? Number(m[0]) : null;
  return { label, num };
};


// ============ LIST ALL VIDEOS BY DAY WITH USER COUNTS ============
// POST /affiliate/solutions/videos/by-day
// Body: { email: string, token: string }
// Returns: { code, days: [{ day, videos: [...] }], total_videos }
router.post(
  "/affiliate/solutions/videos/by-day",
  asyncHandler(async (req, res) => {
    req.body = trimAllStrings(req.body || {});
    const email = sanitizeEmail(req.body?.email);
    const token = getCallerToken(req); // reads body.token OR x-user-token (still body-only is fine)

    if (!email)  return res.status(400).json({ status:false, error:"email_required" });
    if (!token)  return res.status(401).json({ status:false, error:"token_required" });

    // verify user token
    const auth = await verifyUserToken(email, token);
    if (!auth.ok)
      return res.status(401).json({ status:false, error:"unauthorized", reason: auth.reason });

    const out = await withClient(async (db) => {
      // find user's affiliate code
      const code = await getUserCodeByEmail(db, email);
      if (!code) return { notFound: true };

      // fetch all videos + this user's counters
      const sql = `
        SELECT
          v.id,
          v.title,
          v.description,
          v.thumbnail,
          v.url,
          v.day,
          COALESCE(c.views_count,  0)::bigint AS views_count,
          COALESCE(c.shares_count, 0)::bigint AS shares_count,
          c.last_viewed_at,
          c.last_shared_at
        FROM public.affiliate_everydaysolutions v
        LEFT JOIN public.everyday_engagement_counters c
          ON c.video_id = v.id AND LOWER(c.code) = LOWER($1)
        ORDER BY
          -- try to order by numeric part of "day" first, then fallback text, then id
          NULLIF(regexp_replace(v.day::text, '\\D','','g'), '')::int NULLS LAST,
          v.day,
          v.id
      `;
      const r = await db.query(sql, [code]);

      // group by day, keeping a numeric sort key
      const buckets = new Map(); // key: label -> { day, num, videos: [] }
      for (const row of r.rows) {
        const { label, num } = toDayKey(row.day);
        if (!buckets.has(label)) buckets.set(label, { day: label, num, videos: [] });

        buckets.get(label).videos.push({
          id: row.id,
          title: row.title,
          description: row.description,
          thumbnail: row.thumbnail,
          url: row.url,
          user_engagement: {
            views: Number(row.views_count || 0),
            shares: Number(row.shares_count || 0),
            last_viewed_at: row.last_viewed_at || null,
            last_shared_at: row.last_shared_at || null,
          },
        });
      }

      const days = Array.from(buckets.values()).sort((a, b) => {
        // sort by numeric day if both present, else by label
        if (Number.isFinite(a.num) && Number.isFinite(b.num)) return a.num - b.num;
        if (Number.isFinite(a.num)) return -1;
        if (Number.isFinite(b.num)) return 1;
        return String(a.day).localeCompare(String(b.day));
      }).map(({ day, videos }) => ({ day, videos }));

      return { code, days, total: r.rowCount };
    });

    if (out.notFound)
      return res.status(404).json({ status:false, error:"user_code_not_found" });

    return res.json({
      status: true,
      email,
      code: out.code,
      total_videos: out.total,
      days: out.days,
    });
  })
);

router.get(
  "/affiliate/everydaysolutions/videos/:filename",
  asyncHandler(async (req, res) => {
    const raw = (req.params.filename || "").trim();
    if (!raw) {
      return res.status(400).json({ status: false, error: "filename_required" });
    }
    // reject paths
    if (raw.includes("/") || raw.includes("\\") || raw.includes("..")) {
      return res.status(400).json({ status: false, error: "bad_filename" });
    }

    const abs = path.resolve(path.join(VIDEOS_DIR, raw));
    const allowedRoot = path.resolve(VIDEOS_DIR) + path.sep;
    if (!abs.startsWith(allowedRoot)) {
      return res.status(404).json({ status: false, error: "not_found" });
    }

    let stat;
    try {
      stat = await fs.promises.stat(abs);
      if (!stat.isFile()) throw new Error("not_file");
    } catch {
      return res.status(404).json({ status: false, error: "not_found" });
    }

    const total = stat.size;
    const ext = path.extname(abs);
    const mime = guessVideoMime(ext);
    const asAttachment = String(req.query.attachment ?? "false").toLowerCase() === "true";

    // Strong caching (tweak if you’ll replace files in place)
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Last-Modified", stat.mtime.toUTCString());
    res.setHeader("Cache-Control", "private, max-age=604800"); // 7 days

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m) {
        res.setHeader("Content-Range", `bytes */${total}`);
        return res.status(416).end();
      }

      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : total - 1;

      if (Number.isNaN(start) || start < 0) start = 0;
      if (Number.isNaN(end) || end >= total) end = total - 1;
      if (start > end) {
        res.setHeader("Content-Range", `bytes */${total}`);
        return res.status(416).end();
      }

      const chunk = end - start + 1;
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
      res.setHeader("Content-Length", String(chunk));
      res.setHeader("Content-Type", mime);
      if (asAttachment) {
        res.setHeader("Content-Disposition", `attachment; filename="${path.basename(abs)}"`);
      }

      const stream = fs.createReadStream(abs, { start, end });
      stream.on("error", () => res.status(500).end());
      return stream.pipe(res);
    }

    // Full file
    res.status(200);
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Length", String(total));
    if (asAttachment) {
      res.setHeader("Content-Disposition", `attachment; filename="${path.basename(abs)}"`);
    }
    const stream = fs.createReadStream(abs);
    stream.on("error", () => res.status(500).end());
    stream.pipe(res);
  })
);

// -------------------- LINK CLICK TRACKING --------------------
// In-memory store for rate limiting (resets on server restart)
// For multi-instance deployments, replace with Redis
const clickRateLimitStore = new Map(); // key: IP|code -> { count, windowStart }

const CLICK_RATE_LIMIT = {
  maxPerWindow: 5,        // max 5 unique clicks per IP per code...
  windowMs: 60 * 60 * 1000, // ...per hour
  dedupeWindowMs: 30 * 1000, // ignore repeat clicks within 30 seconds (same IP+code)
};

function getClickRateLimitKey(ip, code) {
  return `${ip}|${normCode(code)}`;
}

/**
 * Check and update rate limit for a given key.
 * Returns { allowed: boolean, remaining: number, retryAfterMs: number }
 */
function checkClickRateLimit(ip, code) {
  const key = getClickRateLimitKey(ip, code);
  const now = Date.now();
  const entry = clickRateLimitStore.get(key);

  if (!entry || now - entry.windowStart >= CLICK_RATE_LIMIT.windowMs) {
    // New window
    clickRateLimitStore.set(key, { count: 1, windowStart: now, lastSeen: now });
    return { allowed: true, remaining: CLICK_RATE_LIMIT.maxPerWindow - 1, retryAfterMs: 0 };
  }

  // Dedupe: same IP+code clicked within dedupeWindowMs → silently accept but don't count
  if (now - entry.lastSeen < CLICK_RATE_LIMIT.dedupeWindowMs) {
    return { allowed: true, remaining: CLICK_RATE_LIMIT.maxPerWindow - entry.count, retryAfterMs: 0, deduped: true };
  }

  if (entry.count >= CLICK_RATE_LIMIT.maxPerWindow) {
    const retryAfterMs = CLICK_RATE_LIMIT.windowMs - (now - entry.windowStart);
    return { allowed: false, remaining: 0, retryAfterMs };
  }

  entry.count += 1;
  entry.lastSeen = now;
  clickRateLimitStore.set(key, entry);
  return { allowed: true, remaining: CLICK_RATE_LIMIT.maxPerWindow - entry.count, retryAfterMs: 0 };
}

// Periodically purge expired entries to prevent memory leak (every 30 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of clickRateLimitStore.entries()) {
    if (now - entry.windowStart >= CLICK_RATE_LIMIT.windowMs) {
      clickRateLimitStore.delete(key);
    }
  }
}, 30 * 60 * 1000);


// POST /affiliate/links/click
// Body: { code: string, ref?: string, meta?: object }
// - ref: optional referrer/source string (e.g. "instagram", "twitter")
// - meta: optional freeform JSON (device info, page URL, etc.)
// Rate limit: 5 unique clicks per IP per code per hour
// Dedupe: clicks within 30s from same IP+code are silently ignored (not double-counted)
router.post(
  "/affiliate/links/click",
  asyncHandler(async (req, res) => {
    const b = trimAllStrings(req.body || {});
    const code = normCode(b.code);
    if (!code) {
      return res.status(400).json({ status: false, error: "code_required" });
    }

    // Normalize optional fields
    const ref = typeof b.ref === "string" && b.ref.trim() ? b.ref.trim().slice(0, 100) : null;
    let meta = null;
    if (b.meta != null) {
      meta = typeof b.meta === "object" ? b.meta : (() => {
        try { return JSON.parse(String(b.meta)); } catch { return null; }
      })();
    }

    // Extract caller IP (trust X-Forwarded-For if behind a proxy/nginx)
    const ip =
      (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.socket?.remoteAddress ||
      "unknown";

    // Rate limit check
    const rl = checkClickRateLimit(ip, code);
    res.setHeader("X-RateLimit-Limit", String(CLICK_RATE_LIMIT.maxPerWindow));
    res.setHeader("X-RateLimit-Remaining", String(rl.remaining));

    if (!rl.allowed) {
      res.setHeader("Retry-After", String(Math.ceil(rl.retryAfterMs / 1000)));
      return res.status(429).json({
        status: false,
        error: "rate_limited",
        message: "Too many clicks from this IP for this code. Try again later.",
        retry_after_seconds: Math.ceil(rl.retryAfterMs / 1000),
      });
    }

    // If deduped (within 30s window), acknowledge but skip DB write
    if (rl.deduped) {
      return res.json({ status: true, counted: false, reason: "deduplicated" });
    }

    // Verify code exists in users table
    const codeExists = await withClient(async (db) => {
      const r = await db.query(
        `SELECT 1 FROM public.users WHERE lower(code) = lower($1) LIMIT 1`,
        [code]
      );
      return r.rowCount > 0;
    });

    if (!codeExists) {
      return res.status(404).json({ status: false, error: "code_not_found" });
    }

    // Upsert into link_clicks_counters (total) + insert a raw event row
    const row = await withClient(async (db) => {

      // 1) Increment aggregate counter
      await db.query(
        `INSERT INTO public.affiliate_link_clicks (code, clicks_count, first_clicked_at, last_clicked_at)
         VALUES ($1, 1, now(), now())
         ON CONFLICT (lower(code))
         DO UPDATE SET
           clicks_count    = affiliate_link_clicks.clicks_count + 1,
           last_clicked_at = now()`,
        [code]
      );

      // 2) Insert a raw event for audit trail / analytics
      const r = await db.query(
        `INSERT INTO public.affiliate_link_click_events
           (code, ip_hash, ref, meta, clicked_at)
         VALUES ($1, $2, $3, $4::jsonb, now())
         RETURNING id, code, ref, clicked_at`,
        [
          code,
          // Hash the IP so raw IPs are never stored (privacy-friendly)
          require("crypto").createHash("sha256").update(ip).digest("hex"),
          ref,
          meta ? JSON.stringify(meta) : null,
        ]
      );
      return r.rows[0];
    });

    return res.status(201).json({ status: true, counted: true, data: row });
  })
);


// GET /affiliate/links/click/:code
// Returns aggregate click count + recent events for a code
// Auth: admin OR verified user token (via query ?token=... or x-user-token header)
router.get(
  "/affiliate/links/click/:code",
  asyncHandler(async (req, res, next) => {
    // Reuse your existing guard: map :code param into a fake body for requireAdminOrBodyToken
    // Simpler: just duplicate logic inline — admin token OR user token for the email that owns this code
    const isAdmin = hasAdminToken(req);
    if (!isAdmin) {
      const token = (req.query.token || req.header("x-user-token") || "").trim();
      if (!token) {
        return res.status(401).json({ status: false, error: "token_required" });
      }
      // Resolve the email that owns this code
      const ownerEmail = await withClient(async (db) => {
        const r = await db.query(
          `SELECT email FROM public.users WHERE lower(code) = lower($1) LIMIT 1`,
          [req.params.code]
        );
        return r.rows[0]?.email || null;
      });
      if (!ownerEmail) {
        return res.status(404).json({ status: false, error: "code_not_found" });
      }
      const auth = await verifyUserToken(ownerEmail, token);
      if (!auth.ok) {
        return res.status(401).json({ status: false, error: "unauthorized", reason: auth.reason });
      }
    }
    next();
  }),
  asyncHandler(async (req, res) => {
    const code = normCode(req.params.code);
    if (!code) return res.status(400).json({ status: false, error: "code_required" });

    const limit  = Math.max(1, Math.min(200, Number(req.query.limit  ?? 50)));
    const offset = Math.max(0, Number(req.query.offset ?? 0));

    const data = await withClient(async (db) => {
      // Aggregate
      const agg = await db.query(
        `SELECT clicks_count, first_clicked_at, last_clicked_at
         FROM public.affiliate_link_clicks
         WHERE lower(code) = lower($1)`,
        [code]
      );

      // Recent events (no raw IPs returned)
      const events = await db.query(
        `SELECT id, code, ref, meta, clicked_at
         FROM public.affiliate_link_click_events
         WHERE lower(code) = lower($1)
         ORDER BY clicked_at DESC
         LIMIT $2 OFFSET $3`,
        [code, limit, offset]
      );

      const countRes = await db.query(
        `SELECT COUNT(*)::bigint AS c FROM public.affiliate_link_click_events WHERE lower(code) = lower($1)`,
        [code]
      );

      return {
        summary: agg.rows[0] || { clicks_count: 0, first_clicked_at: null, last_clicked_at: null },
        events: events.rows,
        total_events: Number(countRes.rows[0]?.c || 0),
      };
    });

    return res.json({ status: true, code, limit, offset, ...data });
  })
);



  // error handler
  router.use((err, _req, res, _next) => {
    if (err && err.__app && err.code && err.payload) {
      return res.status(err.code).json(err.payload);
    }
    console.error("[affiliate api] error:", err.stack || err);
    if (err && err.code && err.message) {
      return res.status(500).json({
        status: false,
        error: "db_error",
        code: err.code,
        message: err.message,
      });
    }
    res.status(500).json({
      status: false,
      error: "internal_error",
      message: err?.message || "Internal Server Error",
    });
  });

  return router;
};
