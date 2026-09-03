// routes/nmm.js
// New Media Ministries (NMM) reporting API — the app-facing mirror of the
// staff-reporting-web dashboard. Same Postgres database, same rules.
//
// Model
//   units          directorates and flagship institutions
//   users          KingsChat identity + a directorate and/or an institution + a title
//   monthly_goals  goals per user, per unit, per month; set before the first report
//   reports        weeks 1–3 are weekly reports, week 4 is the month's report
//
// Auth: POST /nmm/auth/kingschat exchanges a KingsChat authCode for a bearer
// token; every other call sends `Authorization: Bearer <token>` plus `x-api-key`.

const { Router } = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const multer = require("multer");

/* ---------------------------------------------------------------------------
 * ENV
 * ------------------------------------------------------------------------- */

const NMM_API_KEY =
  process.env.NMM_API_KEY || process.env.PCDL_API_KEY || process.env.GENERAL_API_KEY ||
  "ee115610-738b-4e7b-97e2-446468ba550c";

const KC_CLIENT_ID = process.env.NMM_KC_CLIENT_ID || "630166b6-6431-4239-8036-c40b1b0f2652";
const KC_API_KEY = process.env.NMM_KC_API_KEY || "";
const KC_TOKEN_URL = "https://connect.kingsch.at/developer/api/oauth2/token";
const KC_PROFILE_URL = "https://connect.kingsch.at/developer/api/user/profile";

const BOOTSTRAP_ADMINS = String(process.env.NMM_SUPER_ADMIN_KC_USERNAMES || "")
  .split(",").map((s) => s.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);

const SESSION_DAYS = Number(process.env.NMM_SESSION_DAYS || 30);

// Deadlines are judged on the ministry's clock, not the server's.
const TIMEZONE = process.env.NMM_REPORTING_TIMEZONE || "Africa/Lagos";
const WEEKS_PER_MONTH = 4;
const MONTHLY_WEEK = 4;
const GRACE_HOURS = Number(process.env.NMM_MONTHLY_EDIT_GRACE_HOURS || 24);

// Must be the SAME folder as the web app's UPLOAD_DIR for attachments to be
// shared between the two.
const UPLOAD_DIR = path.resolve(process.env.NMM_UPLOAD_DIR || path.join(process.cwd(), "uploads", "nmm"));
const MAX_UPLOAD_BYTES = Number(process.env.NMM_MAX_UPLOAD_MB || 25) * 1024 * 1024;
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------------------------------------------------------------------------
 * DB
 * ------------------------------------------------------------------------- */

const poolConfig = process.env.NMM_DATABASE_URL
  ? { connectionString: process.env.NMM_DATABASE_URL }
  : {
      user: process.env.NMM_DB_USER || process.env.PCO_FN_DB_USER || "postgres",
      host: process.env.NMM_DB_HOST || process.env.PCO_FN_DB_HOST || "102.219.189.166",
      database: process.env.NMM_DB_NAME || "nmm_reporting",
      password: process.env.NMM_DB_PASSWORD || process.env.PCO_FN_DB_PASSWORD,
      port: Number(process.env.NMM_DB_PORT || process.env.PCO_FN_DB_PORT || 5432),
    };
const pool = new Pool({ ...poolConfig, max: Number(process.env.NMM_DB_POOL_SIZE || 10) });
pool.on("error", (err) => console.error("[nmm] idle pg client error:", err));

const q = async (text, params = []) => (await pool.query(text, params)).rows;
const q1 = async (text, params = []) => (await q(text, params))[0] || null;
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ok = (res, payload = {}) => res.json({ status: true, ...payload });
const fail = (res, http, error, message) => res.status(http).json({ status: false, error, message });
const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const clean = (v, max = 4000) => String(v ?? "").trim().slice(0, max);

const isPeriod = (p) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(p || ""));
const isWeek = (w) => Number.isInteger(w) && w >= 1 && w <= WEEKS_PER_MONTH;
const isKind = (k) => k === "directorate" || k === "institution";
const periodToDate = (p) => `${p}-01`;
const isMonthly = (week) => week === MONTHLY_WEEK;
const weekLabel = (week) => (isMonthly(week) ? "Month's Report" : `Week ${week} Report`);

// "Now" as a wall clock in the reporting zone.
function zonedNow(from = new Date()) {
  return new Date(from.toLocaleString("en-US", { timeZone: TIMEZONE }));
}
const pad = (n) => String(n).padStart(2, "0");
const currentPeriod = (d = zonedNow()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const weekOfMonth = (d = zonedNow()) => Math.min(WEEKS_PER_MONTH, Math.ceil(d.getDate() / 7));
const todayISO = (d = zonedNow()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function periodEnd(p) {
  const [y, m] = p.split("-").map(Number);
  return new Date(y, m, 1);
}
const isCurrentPeriod = (p, d = zonedNow()) => currentPeriod(d) === p;
const periodHasEnded = (p, d = zonedNow()) => d >= periodEnd(p);

const ROLES = ["director", "assistant_director", "assistant", "staff", "super_admin"];
const SELF_ROLES = ["director", "assistant_director", "assistant"];
const STATUSES = ["pending", "approved", "rejected", "removed"];

/* ---------------------------------------------------------------------------
 * Edit windows — the same rules as the web app
 *   • anything is editable while its month is running
 *   • a submitted month's report stays editable for 24h from first submission
 *   • an admin unlock overrides both until a chosen time
 * ------------------------------------------------------------------------- */

function editWindow(r, realNow = new Date()) {
  const zoned = zonedNow(realNow);
  if (r.unlocked_until && new Date(r.unlocked_until) > realNow) {
    return { canEdit: true, reason: "unlocked", until: new Date(r.unlocked_until).toISOString() };
  }
  if (isMonthly(r.week) && r.status === "submitted" && r.first_submitted_at) {
    const until = new Date(new Date(r.first_submitted_at).getTime() + GRACE_HOURS * 3_600_000);
    return until > realNow
      ? { canEdit: true, reason: "grace", until: until.toISOString() }
      : { canEdit: false, reason: "closed", until: until.toISOString() };
  }
  if (isCurrentPeriod(r.period, zoned)) {
    return { canEdit: true, reason: "month", until: periodEnd(r.period).toISOString() };
  }
  return { canEdit: false, reason: "closed", until: periodEnd(r.period).toISOString() };
}
const canOpenReport = (period, week) => isCurrentPeriod(period) && week <= weekOfMonth();
const goalsEditable = (period) => isCurrentPeriod(period);

/* ---------------------------------------------------------------------------
 * Auth
 * ------------------------------------------------------------------------- */

function requireAppKey(req, res, next) {
  if (!NMM_API_KEY) return next();
  if ((req.header("x-api-key") || "").trim() !== NMM_API_KEY) {
    return fail(res, 401, "unauthorized_api_key", "Invalid or missing x-api-key.");
  }
  next();
}

const USER_SELECT = `
  SELECT u.id, u.kc_id, u.kc_username, u.kc_name, u.kc_avatar, u.email, u.phone, u.full_name,
         u.directorate_id, d.name AS directorate_name, u.institution_id, i.name AS institution_name,
         u.staff_unit_id, su.name AS staff_unit_name, su.kind AS staff_unit_kind,
         to_char(u.birthday, 'YYYY-MM-DD') AS birthday, u.rank, u.staff_role, u.city, u.country,
         u.role, u.status, u.disabled_at::text AS disabled_at
  FROM users u
  LEFT JOIN units d ON d.id = u.directorate_id
  LEFT JOIN units i ON i.id = u.institution_id
  LEFT JOIN units su ON su.id = u.staff_unit_id`;

function shapeUser(r) {
  if (!r) return null;
  return {
    id: r.id, kcId: r.kc_id, kcUsername: r.kc_username, kcName: r.kc_name, kcAvatar: r.kc_avatar,
    email: r.email, phone: r.phone, fullName: r.full_name,
    directorateId: r.directorate_id, directorateName: r.directorate_name,
    institutionId: r.institution_id, institutionName: r.institution_name,
    staffUnitId: r.staff_unit_id, staffUnitName: r.staff_unit_name, staffUnitKind: r.staff_unit_kind,
    birthday: r.birthday, rank: r.rank, staffRole: r.staff_role, city: r.city, country: r.country,
    role: r.role, status: r.status, disabledAt: r.disabled_at,
  };
}
const isStaff = (u) => u.role === "staff";
const isDisabled = (u) => u.disabledAt !== null;
const hasUnit = (u) => (isStaff(u) ? u.staffUnitId !== null : u.directorateId !== null || u.institutionId !== null);
function unitsOf(u) {
  const out = [];
  if (u.directorateId) out.push({ id: u.directorateId, kind: "directorate", name: u.directorateName });
  if (u.institutionId) out.push({ id: u.institutionId, kind: "institution", name: u.institutionName });
  return out;
}
const unitOfKind = (u, kind) => unitsOf(u).find((x) => x.kind === kind) || null;

function bearerToken(req) {
  const m = (req.header("authorization") || "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : (req.header("x-user-token") || "").trim() || null;
}

const requireUser = asyncHandler(async (req, res, next) => {
  const token = bearerToken(req);
  if (!token) return fail(res, 401, "no_token", "Sign in to continue.");
  const row = await q1(
    `${USER_SELECT} JOIN sessions s ON s.user_id = u.id WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  if (!row) return fail(res, 401, "invalid_token", "Your session has expired. Sign in again.");
  req.nmmUser = shapeUser(row);
  next();
});

function requireApproved(req, res, next) {
  const u = req.nmmUser;
  if (isDisabled(u)) return fail(res, 403, "account_disabled", "This account is switched off. Switch it back on to continue.");
  if (u.status === "new" || (u.status === "approved" && !hasUnit(u))) {
    return fail(res, 403, "onboarding_required",
      isStaff(u) ? "Complete your staff profile first." : "Choose your directorate and/or flagship institution first.");
  }
  if (u.status !== "approved") {
    return fail(res, 403, "approval_required", "Your account is awaiting administrator approval.");
  }
  next();
}
// Heads only — staff members do not file reports or set goals.
function requireHead(req, res, next) {
  if (isStaff(req.nmmUser)) return fail(res, 403, "forbidden", "Staff accounts do not file reports.");
  next();
}
function requireSuperAdmin(req, res, next) {
  if (req.nmmUser.role !== "super_admin") return fail(res, 403, "forbidden", "Super admin access required.");
  next();
}

const isClosedStatus = (s) => s === "rejected" || s === "removed";

function nextStepFor(user) {
  if (!user) return "signin";
  if (isDisabled(user)) return "disabled";
  const onboarding = isStaff(user) ? "onboarding_staff" : "onboarding";
  if (user.status === "new") return onboarding;
  if (isClosedStatus(user.status)) return user.status; // "rejected" or "removed"
  if (user.status !== "approved") return "pending";
  return hasUnit(user) ? "home" : onboarding;
}

const getUserById = async (id) => shapeUser(await q1(`${USER_SELECT} WHERE u.id = $1`, [id]));

async function createSession(userId, userAgent) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000);
  await q(`INSERT INTO sessions (token_hash, user_id, user_agent, expires_at) VALUES ($1, $2, $3, $4)`,
    [sha256(token), userId, userAgent || null, expiresAt]);
  await q(`UPDATE users SET last_login_at = now() WHERE id = $1`, [userId]);
  return { token, expiresAt };
}

/* ---------------------------------------------------------------------------
 * KingsChat
 * ------------------------------------------------------------------------- */

async function exchangeKcCode(code) {
  const resp = await fetch(KC_TOKEN_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "code", client_id: KC_CLIENT_ID, code }),
  }).catch(() => null);
  if (!resp || !resp.ok) return null;
  const json = await resp.json().catch(() => null);
  const accessToken = json?.access_token ?? json?.accessToken ?? null;
  return accessToken ? { accessToken } : null;
}

async function fetchKcProfile(accessToken) {
  const headers = { Accept: "application/json", Authorization: `Bearer ${accessToken}` };
  if (KC_API_KEY) headers["api-key"] = KC_API_KEY;
  const resp = await fetch(KC_PROFILE_URL, { headers }).catch(() => null);
  if (!resp) return null;
  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json) return null;
  const p = json.profile ?? json.user ?? json ?? {};
  const user = p.user ?? p;
  const phone = p.phoneNumber ?? p.phone_number ?? p.phone ?? user.phoneNumber ?? user.phone_number ?? null;
  const name = p.name || [p.firstName ?? user.firstName, p.lastName ?? user.lastName].filter(Boolean).join(" ") || null;
  const kcId = p.kcID ?? user.kcID ?? p.id ?? user.id ?? p.userID ?? user.userID ?? null;
  return {
    kcId: kcId != null ? String(kcId) : null,
    username: (user.username ?? p.username ?? null)?.replace(/^@/, "") ?? null,
    name,
    email: p.emailAddress ?? p.email ?? user.emailAddress ?? user.email ?? null,
    phone: phone ? String(phone) : null,
    avatar: p.profilePicture ?? p.avatar ?? p.displayPicture ?? user.profilePicture ?? null,
  };
}

async function upsertKcUser(profile) {
  const username = profile.username || null;
  let row =
    (profile.kcId ? await q1(`SELECT id FROM users WHERE kc_id = $1`, [profile.kcId]) : null) ||
    (username ? await q1(`SELECT id FROM users WHERE kc_id IS NULL AND lower(kc_username) = lower($1)`, [username]) : null);
  if (row) {
    await q(
      `UPDATE users SET kc_id = COALESCE($2, kc_id), kc_username = COALESCE($3, kc_username),
              kc_name = COALESCE($4, kc_name), kc_avatar = COALESCE($5, kc_avatar),
              email = COALESCE($6, email), phone = COALESCE($7, phone), updated_at = now()
       WHERE id = $1`,
      [row.id, profile.kcId, username, profile.name, profile.avatar, profile.email, profile.phone],
    );
  } else {
    row = await q1(
      `INSERT INTO users (kc_id, kc_username, kc_name, kc_avatar, email, phone)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [profile.kcId, username, profile.name, profile.avatar, profile.email, profile.phone],
    );
  }
  if (username && BOOTSTRAP_ADMINS.includes(username.toLowerCase())) {
    await q(
      `UPDATE users SET role = 'super_admin', status = 'approved', full_name = COALESCE(full_name, kc_name),
              reviewed_at = COALESCE(reviewed_at, now()), updated_at = now() WHERE id = $1`,
      [row.id],
    );
  }
  return row.id;
}

/* ---------------------------------------------------------------------------
 * Reports
 * ------------------------------------------------------------------------- */

const REPORT_SELECT = `
  SELECT r.id, r.user_id, r.unit_id, un.kind AS unit_kind, un.name AS unit_name,
         COALESCE(u.full_name, u.kc_name) AS author_name, u.kc_username AS author_username,
         to_char(r.period, 'YYYY-MM') AS period, r.week, r.status, r.head_of_unit,
         to_char(r.submission_date, 'YYYY-MM-DD') AS submission_date,
         r.submitted_at::text AS submitted_at, r.first_submitted_at::text AS first_submitted_at,
         r.unlocked_until::text AS unlocked_until, r.updated_at::text AS updated_at
  FROM reports r JOIN units un ON un.id = r.unit_id LEFT JOIN users u ON u.id = r.user_id`;

const SUMMARY_SELECT = `
  SELECT r.id, to_char(r.period, 'YYYY-MM') AS period, r.week, r.status,
         r.submitted_at::text AS submitted_at, r.updated_at::text AS updated_at,
         r.unit_id, un.kind AS unit_kind, un.name AS unit_name,
         COALESCE(u.full_name, u.kc_name) AS author_name, u.kc_username AS author_username
  FROM reports r JOIN units un ON un.id = r.unit_id LEFT JOIN users u ON u.id = r.user_id`;

const summarize = (r) => ({ ...r, is_monthly: isMonthly(r.week) });

async function loadReport(row) {
  if (!row) return null;
  const [highlights, platforms, relations, attachments] = await Promise.all([
    q(`SELECT id, activity, purpose, status_impact FROM report_highlights WHERE report_id = $1 ORDER BY position, id`, [row.id]),
    q(`SELECT id, platform, purpose, hosted_on, status FROM report_platforms WHERE report_id = $1 ORDER BY position, id`, [row.id]),
    q(`SELECT id, activity, overlap, collaboration, suggestions FROM report_relations WHERE report_id = $1 ORDER BY position, id`, [row.id]),
    q(`SELECT id, original_name, mime_type, size_bytes::int AS size_bytes, created_at::text AS created_at
       FROM report_attachments WHERE report_id = $1 ORDER BY created_at`, [row.id]),
  ]);
  return { ...row, is_monthly: isMonthly(row.week), highlights, platforms, relations, attachments, window: editWindow(row) };
}
const getReport = async (id) => loadReport(await q1(`${REPORT_SELECT} WHERE r.id = $1`, [id]));
const getReportFor = async (userId, unitId, period, week) =>
  loadReport(await q1(`${REPORT_SELECT} WHERE r.user_id = $1 AND r.unit_id = $2 AND r.period = $3 AND r.week = $4`,
    [userId, unitId, periodToDate(period), week]));

async function getOrCreateReport(user, unit, period, week) {
  const existing = await getReportFor(user.id, unit.id, period, week);
  if (existing) return existing;
  if (!canOpenReport(period, week)) return null;
  await q(
    `INSERT INTO reports (user_id, unit_id, period, week, head_of_unit) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, unit_id, period, week) DO NOTHING`,
    [user.id, unit.id, periodToDate(period), week, user.fullName || user.kcName || ""],
  );
  return getReportFor(user.id, unit.id, period, week);
}

const nonEmpty = (rows, keys) => (Array.isArray(rows) ? rows : []).filter((r) => keys.some((k) => clean(r?.[k])));
async function replaceRows(client, table, reportId, columns, rows) {
  await client.query(`DELETE FROM ${table} WHERE report_id = $1`, [reportId]);
  for (let i = 0; i < rows.length; i += 1) {
    const values = columns.map((c) => clean(rows[i][c]));
    await client.query(
      `INSERT INTO ${table} (report_id, position, ${columns.join(", ")}) VALUES ($1, $2, ${values.map((_, j) => `$${j + 3}`).join(", ")})`,
      [reportId, i, ...values],
    );
  }
}

async function saveReport(report, body) {
  await withTx(async (client) => {
    await client.query(
      `UPDATE reports SET head_of_unit = COALESCE(
         (SELECT NULLIF(TRIM(COALESCE(u.full_name, u.kc_name, '')), '') FROM users u WHERE u.id = reports.user_id), head_of_unit),
         updated_at = now() WHERE id = $1`,
      [report.id],
    );
    await replaceRows(client, "report_highlights", report.id, ["activity", "purpose", "status_impact"],
      nonEmpty(body.highlights, ["activity", "purpose", "status_impact"]));
    if (report.is_monthly) {
      await replaceRows(client, "report_platforms", report.id, ["platform", "purpose", "hosted_on", "status"],
        nonEmpty(body.platforms, ["platform", "purpose", "hosted_on", "status"]));
      await replaceRows(client, "report_relations", report.id, ["activity", "overlap", "collaboration", "suggestions"],
        nonEmpty(body.relations, ["activity", "overlap", "collaboration", "suggestions"]));
    }
  });
}

async function countGoals(userId, unitId, period) {
  return (await q1(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE completed)::int AS done
     FROM monthly_goals WHERE user_id = $1 AND unit_id = $2 AND period = $3`,
    [userId, unitId, periodToDate(period)],
  )) || { total: 0, done: 0 };
}
const listGoals = (userId, unitId, period) => q(
  `SELECT id, goal, intended_outcome, target_date, completed, completed_at::text AS completed_at
   FROM monthly_goals WHERE user_id = $1 AND unit_id = $2 AND period = $3 ORDER BY position, id`,
  [userId, unitId, periodToDate(period)],
);

// Everything the app needs about one unit in one month.
async function unitMonth(userId, unit, period) {
  const [goals, rows] = await Promise.all([
    countGoals(userId, unit.id, period),
    q(`SELECT id, week, status, submitted_at::text AS submitted_at FROM reports WHERE user_id = $1 AND unit_id = $2 AND period = $3`,
      [userId, unit.id, periodToDate(period)]),
  ]);
  const monthOpen = isCurrentPeriod(period);
  const currentWeek = monthOpen ? weekOfMonth() : periodHasEnded(period) ? WEEKS_PER_MONTH + 1 : 0;
  const weeks = [];
  for (let w = 1; w <= WEEKS_PER_MONTH; w += 1) {
    const r = rows.find((x) => x.week === w);
    let status;
    if (r?.status === "submitted") status = "submitted";
    else if (w > currentWeek) status = "upcoming";
    else if (w < currentWeek) status = "missed";
    else status = r ? "draft" : "due";
    weeks.push({ week: w, label: weekLabel(w), status, reportId: r?.id ?? null, submitted_at: r?.submitted_at ?? null });
  }
  return { unit, period, goals, weeks, missed: weeks.filter((w) => w.status === "missed").length,
    currentWeek: Math.min(currentWeek, WEEKS_PER_MONTH), monthOpen };
}

/* ---------------------------------------------------------------------------
 * Uploads
 * ------------------------------------------------------------------------- */

const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif", "application/pdf",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain", "text/csv", "application/zip",
]);
const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 10 },
  fileFilter: (_req, file, cb) => {
    const mime = file.mimetype || "";
    if (ALLOWED_MIME.has(mime) || mime.startsWith("image/")) return cb(null, true);
    cb(new Error(`File type ${mime} is not allowed`));
  },
});
const uploadsFor = (field = "files") => (req, res, next) =>
  attachmentUpload.array(field, 10)(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === "LIMIT_FILE_SIZE";
    return fail(res, tooBig ? 413 : 400, "upload_error",
      tooBig ? `Each file must be ${MAX_UPLOAD_BYTES / 1024 / 1024} MB or smaller.` : err.message || "Upload failed.");
  });
function safeExt(name) {
  const ext = path.extname(String(name || "")).toLowerCase().replace(/[^a-z0-9.]/g, "");
  return ext.length <= 10 ? ext : "";
}
function attachmentPath(storedName) {
  const abs = path.resolve(UPLOAD_DIR, storedName);
  return abs !== UPLOAD_DIR && !abs.startsWith(UPLOAD_DIR + path.sep) ? null : abs;
}

/* ---------------------------------------------------------------------------
 * Routes
 * ------------------------------------------------------------------------- */

module.exports = function nmmRoutes() {
  const router = Router();
  // Never cache an API response, and always require the app key.
  router.use("/nmm", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  router.use("/nmm", requireAppKey);
  const approved = [requireUser, requireApproved];
  const head = [requireUser, requireApproved, requireHead];
  const admin = [requireUser, requireApproved, requireSuperAdmin];

  router.get("/nmm/ping", asyncHandler(async (_req, res) => {
    const row = await q1(`SELECT count(*)::int AS units FROM units WHERE is_active`);
    ok(res, { message: "nmm reporting api alive", units: row?.units ?? 0, period: currentPeriod(), week: weekOfMonth() });
  }));

  /* ---- auth ------------------------------------------------------------ */

  router.post("/nmm/auth/kingschat", asyncHandler(async (req, res) => {
    const code = clean(req.body?.code || req.body?.authCode, 4096);
    let accessToken = clean(req.body?.accessToken, 4096);
    if (!code && !accessToken) return fail(res, 400, "missing_code", "Provide `code` from KingsChat, or an `accessToken`.");
    if (!accessToken) {
      const tokens = await exchangeKcCode(code);
      if (!tokens) return fail(res, 502, "kc_exchange_failed", "Could not exchange the KingsChat code.");
      accessToken = tokens.accessToken;
    }
    const profile = await fetchKcProfile(accessToken);
    if (!profile) return fail(res, 502, "kc_profile_failed", "Could not read your KingsChat profile.");
    if (!profile.kcId && !profile.username) return fail(res, 502, "kc_no_identity", "KingsChat did not return an identity.");
    const userId = await upsertKcUser(profile);
    const user = await getUserById(userId);
    const { token, expiresAt } = await createSession(userId, req.get("user-agent"));
    ok(res, { token, expiresAt: expiresAt.toISOString(), next: nextStepFor(user), user });
  }));

  // Account controls, always for the signed-in user and nobody else:
  // switch off (reversible), switch back on, or delete for good.
  const lastActiveSuperAdmin = async (id) => {
    const row = await q1(
      `SELECT count(*)::int AS n FROM users
       WHERE role = 'super_admin' AND status = 'approved' AND disabled_at IS NULL AND id <> $1`, [id]);
    return (row?.n ?? 0) === 0;
  };

  router.post("/nmm/account", requireUser, asyncHandler(async (req, res) => {
    const u = req.nmmUser;
    const action = clean(req.body?.action, 20);
    if (action === "reactivate") {
      if (!isDisabled(u)) return fail(res, 409, "already_active", "This account is already active.");
      await q(`UPDATE users SET disabled_at = NULL, updated_at = now() WHERE id = $1`, [u.id]);
      const user = await getUserById(u.id);
      return ok(res, { user, next: nextStepFor(user) });
    }
    if (action === "disable") {
      if (isDisabled(u)) return fail(res, 409, "already_disabled", "This account is already switched off.");
      if (u.role === "super_admin" && (await lastActiveSuperAdmin(u.id))) {
        return fail(res, 409, "last_super_admin", "You are the only active super admin. Make someone else a super admin first.");
      }
      await q(`UPDATE users SET disabled_at = now(), updated_at = now() WHERE id = $1`, [u.id]);
      await q(`DELETE FROM sessions WHERE user_id = $1`, [u.id]); // signs out everywhere
      return ok(res, { disabled: true });
    }
    return fail(res, 400, "invalid_action", "action must be disable or reactivate.");
  }));

  router.delete("/nmm/account", requireUser, asyncHandler(async (req, res) => {
    const u = req.nmmUser;
    if (u.role === "super_admin" && (await lastActiveSuperAdmin(u.id))) {
      return fail(res, 409, "last_super_admin", "You are the only active super admin. Make someone else a super admin first.");
    }
    const reports = await q(`SELECT id FROM reports WHERE user_id = $1`, [u.id]);
    await q(`UPDATE users SET reviewed_by = NULL WHERE reviewed_by = $1`, [u.id]);
    const gone = await q(`DELETE FROM users WHERE id = $1 RETURNING id`, [u.id]);
    if (!gone.length) return fail(res, 500, "delete_failed", "Could not delete the account.");
    for (const r of reports) await fsp.rm(path.join(UPLOAD_DIR, String(r.id)), { recursive: true, force: true }).catch(() => {});
    ok(res, { deleted: true });
  }));

  router.post("/nmm/auth/logout", requireUser, asyncHandler(async (req, res) => {
    await q(`DELETE FROM sessions WHERE token_hash = $1`, [sha256(bearerToken(req))]);
    ok(res, { message: "signed out" });
  }));

  /* ---- account --------------------------------------------------------- */

  router.get("/nmm/me", requireUser, asyncHandler(async (req, res) => {
    ok(res, { user: req.nmmUser, next: nextStepFor(req.nmmUser), units: unitsOf(req.nmmUser) });
  }));

  router.patch("/nmm/me", requireUser, asyncHandler(async (req, res) => {
    const fullName = clean(req.body?.fullName, 200);
    const phone = clean(req.body?.phone, 40) || null;
    if (fullName.length < 3) return fail(res, 400, "invalid_name", "Please provide your full name.");
    await q(`UPDATE users SET full_name = $2, phone = $3, updated_at = now() WHERE id = $1`, [req.nmmUser.id, fullName, phone]);
    ok(res, { user: await getUserById(req.nmmUser.id) });
  }));

  // Active directorates and flagship institutions for the onboarding pickers.
  router.get("/nmm/units", requireUser, asyncHandler(async (req, res) => {
    const kind = isKind(req.query.kind) ? req.query.kind : null;
    const units = await q(
      `SELECT id, kind, name FROM units WHERE is_active ${kind ? "AND kind = $1" : ""} ORDER BY kind, position, name`,
      kind ? [kind] : [],
    );
    ok(res, {
      units,
      directorates: units.filter((u) => u.kind === "directorate"),
      institutions: units.filter((u) => u.kind === "institution"),
      roles: SELF_ROLES,
    });
  }));

  // Full name, title, and at least one of directorateId / institutionId.
  router.post("/nmm/onboarding", requireUser, asyncHandler(async (req, res) => {
    const fullName = clean(req.body?.fullName, 200);
    if (fullName.length < 3) return fail(res, 400, "invalid_name", "Please provide your full name.");
    const role = req.body?.role || "director";
    if (!SELF_ROLES.includes(role)) return fail(res, 400, "invalid_role", "role must be director, assistant_director or assistant.");
    const directorateId = req.body?.directorateId ? Number(req.body.directorateId) : null;
    const institutionId = req.body?.institutionId ? Number(req.body.institutionId) : null;
    if (!directorateId && !institutionId) {
      return fail(res, 400, "unit_required", "Select a directorate, a flagship institution, or both.");
    }
    if (directorateId) {
      const d = await q1(`SELECT id FROM units WHERE id = $1 AND kind = 'directorate' AND is_active`, [directorateId]);
      if (!d) return fail(res, 400, "invalid_directorate", "Select a valid directorate.");
    }
    if (institutionId) {
      const i = await q1(`SELECT id FROM units WHERE id = $1 AND kind = 'institution' AND is_active`, [institutionId]);
      if (!i) return fail(res, 400, "invalid_institution", "Select a valid flagship institution.");
    }
    await q(
      `UPDATE users SET full_name = $2, directorate_id = $3, institution_id = $4,
              role = CASE WHEN role = 'super_admin' THEN role ELSE $5::user_role END,
              status = CASE WHEN status = 'approved' THEN status ELSE 'pending'::user_status END,
              profile_submitted_at = COALESCE(profile_submitted_at, now()), updated_at = now()
       WHERE id = $1`,
      [req.nmmUser.id, fullName, directorateId, institutionId, role],
    );
    const user = await getUserById(req.nmmUser.id);
    ok(res, { user, next: nextStepFor(user) });
  }));

  /* ---- dashboard ------------------------------------------------------- */

  // The caller's standing for a month across their units: goals, week statuses,
  // and anything missed. Defaults to the current month.
  router.get("/nmm/home", ...head, asyncHandler(async (req, res) => {
    const period = clean(req.query.period, 7) || currentPeriod();
    if (!isPeriod(period)) return fail(res, 400, "invalid_period", "Use a period like 2026-09.");
    const months = await Promise.all(unitsOf(req.nmmUser).map((u) => unitMonth(req.nmmUser.id, u, period)));
    ok(res, { period, currentWeek: weekOfMonth(), units: months });
  }));

  /* ---- goals ----------------------------------------------------------- */

  router.get("/nmm/goals", ...head, asyncHandler(async (req, res) => {
    const kind = req.query.kind;
    const period = clean(req.query.period, 7) || currentPeriod();
    if (!isKind(kind) || !isPeriod(period)) return fail(res, 400, "bad_request", "Provide kind and a period like 2026-09.");
    const unit = unitOfKind(req.nmmUser, kind);
    if (!unit) return fail(res, 403, "forbidden", "You do not report for that kind of unit.");
    ok(res, { goals: await listGoals(req.nmmUser.id, unit.id, period), editable: goalsEditable(period) });
  }));

  // Replace the list. Existing ids keep their completion state.
  router.put("/nmm/goals", ...head, asyncHandler(async (req, res) => {
    const { kind, period } = req.body || {};
    if (!isKind(kind) || !isPeriod(period)) return fail(res, 400, "bad_request", "Provide kind and a period like 2026-09.");
    const unit = unitOfKind(req.nmmUser, kind);
    if (!unit) return fail(res, 403, "forbidden", "You do not report for that kind of unit.");
    if (!goalsEditable(period)) return fail(res, 409, "period_closed", "Goals for that month can no longer be changed.");
    const rows = nonEmpty(req.body.goals, ["goal", "intended_outcome", "target_date"]);
    await withTx(async (client) => {
      const keep = [];
      for (let i = 0; i < rows.length; i += 1) {
        const g = rows[i];
        if (g.id) {
          const r = await client.query(
            `UPDATE monthly_goals SET position = $5, goal = $6, intended_outcome = $7, target_date = $8, updated_at = now()
             WHERE id = $1 AND user_id = $2 AND unit_id = $3 AND period = $4 RETURNING id`,
            [g.id, req.nmmUser.id, unit.id, periodToDate(period), i, clean(g.goal), clean(g.intended_outcome), clean(g.target_date, 300)]);
          if (r.rows[0]) { keep.push(r.rows[0].id); continue; }
        }
        const ins = await client.query(
          `INSERT INTO monthly_goals (user_id, unit_id, period, position, goal, intended_outcome, target_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [req.nmmUser.id, unit.id, periodToDate(period), i, clean(g.goal), clean(g.intended_outcome), clean(g.target_date, 300)]);
        keep.push(ins.rows[0].id);
      }
      await client.query(`DELETE FROM monthly_goals WHERE user_id = $1 AND unit_id = $2 AND period = $3 AND NOT (id = ANY($4::int[]))`,
        [req.nmmUser.id, unit.id, periodToDate(period), keep]);
    });
    ok(res, { goals: await listGoals(req.nmmUser.id, unit.id, period) });
  }));

  router.patch("/nmm/goals/:id", ...head, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const g = await q1(`SELECT user_id, to_char(period, 'YYYY-MM') AS period FROM monthly_goals WHERE id = $1`, [id]);
    if (!g) return fail(res, 404, "not_found", "Goal not found.");
    if (g.user_id !== req.nmmUser.id && req.nmmUser.role !== "super_admin") return fail(res, 403, "forbidden", "Not your goal.");
    if (!goalsEditable(g.period)) return fail(res, 409, "period_closed", "Goals for that month can no longer be changed.");
    const completed = Boolean(req.body?.completed);
    await q(`UPDATE monthly_goals SET completed = $2, completed_at = CASE WHEN $2 THEN now() ELSE NULL END, updated_at = now() WHERE id = $1`,
      [id, completed]);
    ok(res, { id, completed });
  }));

  /* ---- reports --------------------------------------------------------- */

  // History for one of the caller's units.
  router.get("/nmm/reports", ...head, asyncHandler(async (req, res) => {
    const kind = req.query.kind;
    if (!isKind(kind)) return fail(res, 400, "bad_request", "Provide kind=directorate or kind=institution.");
    const unit = unitOfKind(req.nmmUser, kind);
    if (!unit) return fail(res, 403, "forbidden", "You do not report for that kind of unit.");
    const rows = await q(`${SUMMARY_SELECT} WHERE r.user_id = $1 AND r.unit_id = $2 ORDER BY r.period DESC, r.week DESC`,
      [req.nmmUser.id, unit.id]);
    ok(res, { unit, reports: rows.map(summarize) });
  }));

  // Open (create if needed) a report for a kind, month and week.
  router.post("/nmm/reports", ...head, asyncHandler(async (req, res) => {
    const { kind, period } = req.body || {};
    const week = Number(req.body?.week);
    if (!isKind(kind) || !isPeriod(period) || !isWeek(week)) {
      return fail(res, 400, "bad_request", "Provide kind, a period like 2026-09 and a week from 1 to 4.");
    }
    const unit = unitOfKind(req.nmmUser, kind);
    if (!unit) return fail(res, 403, "forbidden", "You do not report for that kind of unit.");
    const report = await getOrCreateReport(req.nmmUser, unit, period, week);
    if (!report) return fail(res, 409, "not_open", `The ${weekLabel(week)} for ${period} is not open.`);
    ok(res, { report, goals: await listGoals(req.nmmUser.id, unit.id, period) });
  }));

  router.get("/nmm/reports/:id", ...head, asyncHandler(async (req, res) => {
    const report = await getReport(Number(req.params.id));
    if (!report) return fail(res, 404, "not_found", "Report not found.");
    if (report.user_id !== req.nmmUser.id && req.nmmUser.role !== "super_admin") return fail(res, 403, "forbidden", "Not your report.");
    ok(res, { report, goals: await listGoals(report.user_id, report.unit_id, report.period) });
  }));

  // Save sections while the edit window is open (submitted or not).
  router.put("/nmm/reports/:id", ...head, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const report = await getReport(id);
    if (!report) return fail(res, 404, "not_found", "Report not found.");
    if (report.user_id !== req.nmmUser.id) return fail(res, 403, "forbidden", "Only the owner can edit it.");
    if (!report.window.canEdit) return fail(res, 409, "report_locked", "This report can no longer be changed.");
    await saveReport(report, req.body || {});
    ok(res, { report: await getReport(id) });
  }));

  // Submit. Needs goals for the month and at least one highlight.
  router.post("/nmm/reports/:id/submit", ...head, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const report = await getReport(id);
    if (!report) return fail(res, 404, "not_found", "Report not found.");
    if (report.user_id !== req.nmmUser.id) return fail(res, 403, "forbidden", "Only the owner can submit it.");
    if (!report.window.canEdit) return fail(res, 409, "report_locked", "This report can no longer be changed.");
    const errors = [];
    if (!clean(report.head_of_unit)) errors.push("Your account has no full name. Set it on your profile first.");
    if ((await countGoals(report.user_id, report.unit_id, report.period)).total === 0) {
      errors.push("Set your goals for the month before submitting your first report.");
    }
    if (!report.highlights.some((h) => clean(h.activity) || clean(h.status_impact))) {
      errors.push(report.is_monthly ? "Add at least one highlight for the month." : "Add at least one activity for the week.");
    }
    if (errors.length) return fail(res, 422, "validation_failed", errors.join(" "));
    await q(
      `UPDATE reports SET status = 'submitted', submitted_at = now(),
              first_submitted_at = COALESCE(first_submitted_at, now()),
              submission_date = COALESCE(submission_date, $2::date), updated_at = now()
       WHERE id = $1`,
      [id, todayISO()],
    );
    ok(res, { report: await getReport(id) });
  }));

  // Drafts only, while the window is open.
  router.delete("/nmm/reports/:id", ...head, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const report = await getReport(id);
    if (!report) return fail(res, 404, "not_found", "Report not found.");
    if (report.user_id !== req.nmmUser.id && req.nmmUser.role !== "super_admin") return fail(res, 403, "forbidden", "Only the owner can delete it.");
    if (report.status === "submitted") return fail(res, 409, "report_locked", "Submitted reports cannot be deleted.");
    if (!report.window.canEdit) return fail(res, 409, "report_locked", "This report can no longer be changed.");
    const gone = await q(`DELETE FROM reports WHERE id = $1 AND status = 'draft' RETURNING id`, [id]);
    if (!gone.length) return fail(res, 409, "report_locked", "Submitted reports cannot be deleted.");
    await fsp.rm(path.join(UPLOAD_DIR, String(id)), { recursive: true, force: true }).catch(() => {});
    ok(res, { id });
  }));

  /* ---- attachments ----------------------------------------------------- */

  router.post("/nmm/reports/:id/attachments", ...head, uploadsFor("files"), asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const report = await getReport(id);
    if (!report) return fail(res, 404, "not_found", "Report not found.");
    if (report.user_id !== req.nmmUser.id) return fail(res, 403, "forbidden", "Only the owner can add attachments.");
    if (!report.window.canEdit) return fail(res, 409, "report_locked", "This report can no longer be changed.");
    const files = req.files || [];
    if (!files.length) return fail(res, 400, "no_files", "No files received.");
    await fsp.mkdir(path.join(UPLOAD_DIR, String(id)), { recursive: true });
    const saved = [];
    for (const file of files) {
      const storedName = `${id}/${Date.now()}-${crypto.randomBytes(6).toString("hex")}${safeExt(file.originalname)}`;
      await fsp.writeFile(path.join(UPLOAD_DIR, storedName), file.buffer);
      saved.push(await q1(
        `INSERT INTO report_attachments (report_id, uploaded_by, original_name, stored_name, mime_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, original_name, mime_type, size_bytes::int AS size_bytes, created_at::text AS created_at`,
        [id, req.nmmUser.id, clean(file.originalname, 255), storedName, file.mimetype || "application/octet-stream", file.size]));
    }
    ok(res, { attachments: saved });
  }));

  router.get("/nmm/attachments/:id", ...head, asyncHandler(async (req, res) => {
    const att = await q1(`SELECT a.*, r.user_id AS owner_id FROM report_attachments a JOIN reports r ON r.id = a.report_id WHERE a.id = $1`,
      [Number(req.params.id)]);
    if (!att) return fail(res, 404, "not_found", "Attachment not found.");
    if (att.owner_id !== req.nmmUser.id && req.nmmUser.role !== "super_admin") return fail(res, 403, "forbidden", "Not your attachment.");
    const abs = attachmentPath(att.stored_name);
    if (!abs || !fs.existsSync(abs)) return fail(res, 404, "file_missing", "The stored file is not on this server.");
    const inline = att.mime_type.startsWith("image/") || att.mime_type === "application/pdf";
    res.setHeader("Content-Type", att.mime_type);
    res.setHeader("Content-Length", att.size_bytes);
    res.setHeader("Content-Disposition",
      `${req.query.download ? "attachment" : inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(att.original_name)}`);
    fs.createReadStream(abs).pipe(res);
  }));

  router.delete("/nmm/attachments/:id", ...head, asyncHandler(async (req, res) => {
    const att = await q1(
      `SELECT a.id, a.stored_name, r.user_id AS owner_id, to_char(r.period, 'YYYY-MM') AS period, r.week, r.status,
              r.first_submitted_at::text AS first_submitted_at, r.unlocked_until::text AS unlocked_until
       FROM report_attachments a JOIN reports r ON r.id = a.report_id WHERE a.id = $1`,
      [Number(req.params.id)]);
    if (!att) return fail(res, 404, "not_found", "Attachment not found.");
    if (att.owner_id !== req.nmmUser.id && req.nmmUser.role !== "super_admin") return fail(res, 403, "forbidden", "Not your attachment.");
    if (!editWindow(att).canEdit) return fail(res, 409, "report_locked", "This report can no longer be changed.");
    await q(`DELETE FROM report_attachments WHERE id = $1`, [att.id]);
    const abs = attachmentPath(att.stored_name);
    if (abs) await fsp.unlink(abs).catch(() => {});
    ok(res, { id: att.id });
  }));

  /* ---- staff (joined through an invite link) --------------------------- */

  // Accept an invite token the app captured from a /join/<token> link. Only a
  // brand-new account is attached; existing heads are left alone.
  router.post("/nmm/invites/accept", requireUser, asyncHandler(async (req, res) => {
    const token = clean(req.body?.token, 80);
    if (!/^[A-Za-z0-9_-]{10,64}$/.test(token)) return fail(res, 400, "invalid_invite", "This invite link is not valid.");
    const inv = await q1(`SELECT i.*, un.name AS unit_name FROM staff_invites i JOIN units un ON un.id = i.unit_id WHERE i.token = $1`, [token]);
    if (!inv || !inv.is_active) return fail(res, 400, "invalid_invite", "This invite link is not valid any more.");
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) return fail(res, 400, "invalid_invite", "This invite link has expired.");
    if (inv.max_uses !== null && inv.uses >= inv.max_uses) return fail(res, 400, "invalid_invite", "This invite link has been used up.");
    const rows = await q(
      `UPDATE users SET role = 'staff', staff_unit_id = $2, invite_id = $3, updated_at = now()
       WHERE id = $1 AND status = 'new' AND directorate_id IS NULL AND institution_id IS NULL RETURNING id`,
      [req.nmmUser.id, inv.unit_id, inv.id]);
    if (rows.length) await q(`UPDATE staff_invites SET uses = uses + 1 WHERE id = $1`, [inv.id]);
    const user = await getUserById(req.nmmUser.id);
    ok(res, { applied: rows.length > 0, unit: { id: inv.unit_id, name: inv.unit_name }, user, next: nextStepFor(user) });
  }));

  // Staff onboarding: name, birthday, rank, role, KPIs and location.
  router.post("/nmm/onboarding/staff", requireUser, asyncHandler(async (req, res) => {
    const u = req.nmmUser;
    if (!isStaff(u) || !u.staffUnitId) return fail(res, 403, "forbidden", "This form is for staff who joined through an invite link.");
    const b = req.body || {};
    const fullName = clean(b.fullName, 200);
    if (fullName.length < 3) return fail(res, 400, "invalid_name", "Please provide your full name.");
    const birthday = clean(b.birthday, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return fail(res, 400, "invalid_birthday", "Provide birthday as YYYY-MM-DD.");
    if (!clean(b.rank)) return fail(res, 400, "invalid_rank", "Please provide your rank.");
    if (!clean(b.staffRole)) return fail(res, 400, "invalid_role", "Please provide your role.");
    if (!clean(b.city) || !clean(b.country)) return fail(res, 400, "invalid_location", "Please provide city and country.");
    const kpis = (Array.isArray(b.kpis) ? b.kpis : []).filter((k) => clean(k?.kpi));
    if (!kpis.length) return fail(res, 400, "kpis_required", "Add at least one KPI.");
    await withTx(async (client) => {
      await client.query(
        `UPDATE users SET full_name = $2, birthday = $3, rank = $4, staff_role = $5, city = $6, country = $7,
                phone = COALESCE($8, phone),
                status = CASE WHEN status = 'approved' THEN status ELSE 'pending'::user_status END,
                profile_submitted_at = COALESCE(profile_submitted_at, now()), updated_at = now()
         WHERE id = $1`,
        [u.id, fullName, birthday, clean(b.rank, 120), clean(b.staffRole, 160), clean(b.city, 120), clean(b.country, 120),
         b.phone ? clean(b.phone, 40) : null]);
      await client.query(`DELETE FROM staff_kpis WHERE user_id = $1`, [u.id]);
      for (let i = 0; i < kpis.length; i += 1) {
        await client.query(`INSERT INTO staff_kpis (user_id, position, kpi, target) VALUES ($1, $2, $3, $4)`,
          [u.id, i, clean(kpis[i].kpi, 400), clean(kpis[i].target, 400)]);
      }
    });
    const user = await getUserById(u.id);
    ok(res, { user, next: nextStepFor(user) });
  }));

  const listKpis = (userId) => q(`SELECT id, kpi, target FROM staff_kpis WHERE user_id = $1 ORDER BY position, id`, [userId]);

  router.get("/nmm/kpis", requireUser, asyncHandler(async (req, res) => {
    if (!isStaff(req.nmmUser)) return fail(res, 403, "forbidden", "Only staff accounts have KPIs.");
    ok(res, { kpis: await listKpis(req.nmmUser.id) });
  }));

  router.put("/nmm/kpis", requireUser, asyncHandler(async (req, res) => {
    if (!isStaff(req.nmmUser)) return fail(res, 403, "forbidden", "Only staff accounts have KPIs.");
    const kpis = (Array.isArray(req.body?.kpis) ? req.body.kpis : []).filter((k) => clean(k?.kpi));
    if (!kpis.length) return fail(res, 400, "kpis_required", "Keep at least one KPI.");
    await withTx(async (client) => {
      await client.query(`DELETE FROM staff_kpis WHERE user_id = $1`, [req.nmmUser.id]);
      for (let i = 0; i < kpis.length; i += 1) {
        await client.query(`INSERT INTO staff_kpis (user_id, position, kpi, target) VALUES ($1, $2, $3, $4)`,
          [req.nmmUser.id, i, clean(kpis[i].kpi, 400), clean(kpis[i].target, 400)]);
      }
    });
    ok(res, { kpis: await listKpis(req.nmmUser.id) });
  }));

  // Heads: the ready-made invite link per unit, and their staff list.
  router.get("/nmm/staff/invites", ...head, asyncHandler(async (req, res) => {
    const base = process.env.NMM_SITE_URL || "";
    const links = [];
    for (const u of unitsOf(req.nmmUser)) {
      let inv = await q1(`SELECT token, uses FROM staff_invites WHERE unit_id = $1 AND is_active ORDER BY created_at DESC LIMIT 1`, [u.id]);
      if (!inv) {
        inv = await q1(`INSERT INTO staff_invites (token, unit_id, created_by) VALUES ($1, $2, $3) RETURNING token, uses`,
          [crypto.randomBytes(18).toString("base64url"), u.id, req.nmmUser.id]);
      }
      links.push({ unit: u, url: `${base}/join/${inv.token}`, token: inv.token, uses: inv.uses });
    }
    ok(res, { links });
  }));

  router.get("/nmm/staff", ...head, asyncHandler(async (req, res) => {
    const ids = unitsOf(req.nmmUser).map((u) => u.id);
    const staff = await q(
      `SELECT u.id, u.kc_username, u.kc_name, u.kc_avatar, u.full_name, u.rank, u.staff_role, u.city, u.country,
              to_char(u.birthday, 'YYYY-MM-DD') AS birthday, u.status, u.staff_unit_id, un.name AS unit_name, un.kind AS unit_kind,
              (SELECT count(*)::int FROM staff_kpis k WHERE k.user_id = u.id) AS kpi_count
       FROM users u JOIN units un ON un.id = u.staff_unit_id
       WHERE u.role = 'staff' AND u.staff_unit_id = ANY($1::int[])
       ORDER BY CASE u.status WHEN 'pending' THEN 0 WHEN 'new' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END, u.full_name NULLS LAST`,
      [ids]);
    ok(res, { staff });
  }));

  // One staff member in full, for their head's profile view.
  router.get("/nmm/staff/:id", ...head, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const row = await q1(
      `SELECT u.id, u.kc_username, u.kc_name, u.kc_avatar, u.email, u.phone, u.full_name,
              to_char(u.birthday, 'YYYY-MM-DD') AS birthday, u.rank, u.staff_role, u.city, u.country,
              u.status, u.staff_unit_id AS unit_id, un.name AS unit_name, un.kind AS unit_kind,
              u.profile_submitted_at::text AS profile_submitted_at, u.reviewed_at::text AS reviewed_at,
              u.last_login_at::text AS last_login_at, u.created_at::text AS created_at
       FROM users u JOIN units un ON un.id = u.staff_unit_id
       WHERE u.id = $1 AND u.role = 'staff'`,
      [id]);
    if (!row) return fail(res, 404, "not_found", "Staff member not found.");
    const mine = unitsOf(req.nmmUser).some((u) => u.id === row.unit_id);
    if (!mine && req.nmmUser.role !== "super_admin") return fail(res, 403, "forbidden", "You can only view staff of units you head.");
    ok(res, { staff: { ...row, kpis: await listKpis(id) } });
  }));

  router.patch("/nmm/staff/:id", ...head, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const target = await q1(`SELECT staff_unit_id FROM users WHERE id = $1 AND role = 'staff'`, [id]);
    if (!target) return fail(res, 404, "not_found", "Staff member not found.");
    const mine = unitsOf(req.nmmUser).some((u) => u.id === target.staff_unit_id);
    if (!mine && req.nmmUser.role !== "super_admin") return fail(res, 403, "forbidden", "You can only manage staff of units you head.");
    const status = req.body?.status;
    if (!["approved", "rejected", "removed"].includes(status)) {
      return fail(res, 400, "invalid_status", "status must be approved, rejected or removed.");
    }
    await q(`UPDATE users SET status = $2, reviewed_at = now(), reviewed_by = $3, updated_at = now() WHERE id = $1`, [id, status, req.nmmUser.id]);
    ok(res, { user: await getUserById(id) });
  }));

  /* ---- admin ----------------------------------------------------------- */

  router.get("/nmm/admin/users", ...admin, asyncHandler(async (req, res) => {
    const status = String(req.query.status || "");
    const valid = ["new", "pending", "approved", "rejected"].includes(status);
    const users = await q(
      `SELECT u.id, u.kc_username, u.kc_name, u.kc_avatar, u.email, u.phone, u.full_name,
              u.directorate_id, d.name AS directorate_name, u.institution_id, i.name AS institution_name,
              u.role, u.status, u.profile_submitted_at::text AS profile_submitted_at, u.reviewed_at::text AS reviewed_at,
              u.last_login_at::text AS last_login_at, u.created_at::text AS created_at
       FROM users u LEFT JOIN units d ON d.id = u.directorate_id LEFT JOIN units i ON i.id = u.institution_id
       ${valid ? "WHERE u.status = $1" : ""}
       ORDER BY CASE u.status WHEN 'pending' THEN 0 WHEN 'new' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END,
                u.profile_submitted_at DESC NULLS LAST, u.created_at DESC`,
      valid ? [status] : []);
    ok(res, { users });
  }));

  router.patch("/nmm/admin/users/:id", ...admin, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const me = req.nmmUser;
    const body = req.body || {};
    let status = null, role = null;
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) return fail(res, 400, "invalid_status", "status must be pending, approved or rejected.");
      if (id === me.id && body.status !== "approved") return fail(res, 400, "self_suspend", "You cannot suspend your own account.");
      status = body.status;
    }
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role)) return fail(res, 400, "invalid_role", `role must be one of ${ROLES.join(", ")}.`);
      if (id === me.id && body.role !== "super_admin") return fail(res, 400, "self_demote", "You cannot remove your own super admin role.");
      role = body.role;
    }
    const setDir = body.directorateId !== undefined;
    const dirId = setDir && body.directorateId ? Number(body.directorateId) : null;
    if (dirId && !(await q1(`SELECT 1 FROM units WHERE id = $1 AND kind = 'directorate'`, [dirId]))) {
      return fail(res, 400, "invalid_directorate", "Invalid directorate.");
    }
    const setInst = body.institutionId !== undefined;
    const instId = setInst && body.institutionId ? Number(body.institutionId) : null;
    if (instId && !(await q1(`SELECT 1 FROM units WHERE id = $1 AND kind = 'institution'`, [instId]))) {
      return fail(res, 400, "invalid_institution", "Invalid flagship institution.");
    }
    await q(
      `UPDATE users SET
         status = COALESCE($3, status), role = COALESCE($4, role),
         directorate_id = CASE WHEN $6 THEN $5 ELSE directorate_id END,
         institution_id = CASE WHEN $8 THEN $7 ELSE institution_id END,
         reviewed_at = CASE WHEN $3 IS NULL THEN reviewed_at ELSE now() END,
         reviewed_by = CASE WHEN $3 IS NULL THEN reviewed_by ELSE $2 END,
         updated_at = now()
       WHERE id = $1`,
      [id, me.id, status, role, dirId, setDir, instId, setInst]);
    const user = await getUserById(id);
    if (!user) return fail(res, 404, "not_found", "User not found.");
    ok(res, { user });
  }));

  router.get("/nmm/admin/units", ...admin, asyncHandler(async (_req, res) => {
    ok(res, { units: await q(`SELECT id, kind, name, position, is_active FROM units ORDER BY kind, position, name`) });
  }));

  router.post("/nmm/admin/units", ...admin, asyncHandler(async (req, res) => {
    const { kind } = req.body || {};
    const name = clean(req.body?.name, 160);
    if (!isKind(kind)) return fail(res, 400, "invalid_kind", "kind must be directorate or institution.");
    if (name.length < 2) return fail(res, 400, "invalid_name", "Enter a name.");
    const unit = await q1(
      `INSERT INTO units (kind, name, position)
       VALUES ($1, $2, (SELECT COALESCE(max(position), 0) + 1 FROM units WHERE kind = $1))
       ON CONFLICT (kind, name) DO UPDATE SET is_active = TRUE
       RETURNING id, kind, name, position, is_active`,
      [kind, name]);
    ok(res, { unit });
  }));

  router.patch("/nmm/admin/units/:id", ...admin, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const name = req.body?.name !== undefined ? clean(req.body.name, 160) : null;
    if (name !== null && name.length < 2) return fail(res, 400, "invalid_name", "Enter a name.");
    const isActive = req.body?.isActive !== undefined ? Boolean(req.body.isActive) : null;
    await q(`UPDATE units SET name = COALESCE($2, name), is_active = COALESCE($3, is_active) WHERE id = $1`, [id, name, isActive]);
    const unit = await q1(`SELECT id, kind, name, position, is_active FROM units WHERE id = $1`, [id]);
    if (!unit) return fail(res, 404, "not_found", "Not found.");
    ok(res, { unit });
  }));

  // Every report, filterable: ?period=YYYY-MM&kind=&unit=<id>&week=1-4&status=
  router.get("/nmm/admin/reports", ...admin, asyncHandler(async (req, res) => {
    const where = [], params = [];
    const add = (sql, v) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
    const { period, kind, unit, week, status } = req.query;
    if (period) { if (!isPeriod(period)) return fail(res, 400, "invalid_period", "Use a period like 2026-09."); add("r.period = ?", periodToDate(period)); }
    if (kind) { if (!isKind(kind)) return fail(res, 400, "invalid_kind", "kind must be directorate or institution."); add("un.kind = ?", kind); }
    if (unit) add("r.unit_id = ?", Number(unit));
    if (week) { if (!isWeek(Number(week))) return fail(res, 400, "invalid_week", "week must be 1 to 4."); add("r.week = ?", Number(week)); }
    if (status) { if (!["draft", "submitted"].includes(status)) return fail(res, 400, "invalid_status", "status must be draft or submitted."); add("r.status = ?", status); }
    const rows = await q(`${SUMMARY_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                          ORDER BY r.period DESC, r.week DESC, un.kind, un.name, author_name`, params);
    ok(res, { reports: rows.map(summarize) });
  }));

  // Per-unit totals for a month.
  router.get("/nmm/admin/overview", ...admin, asyncHandler(async (req, res) => {
    const period = clean(req.query.period, 7) || currentPeriod();
    if (!isPeriod(period)) return fail(res, 400, "invalid_period", "Use a period like 2026-09.");
    const weeksElapsed = isCurrentPeriod(period) ? Math.min(3, weekOfMonth()) : periodHasEnded(period) ? 3 : 0;
    const units = await q(
      `SELECT un.id, un.kind, un.name,
         (SELECT count(*)::int FROM users u WHERE (u.directorate_id = un.id OR u.institution_id = un.id) AND u.status = 'approved' AND u.disabled_at IS NULL) AS members,
         (SELECT count(*)::int FROM reports r WHERE r.unit_id = un.id AND r.period = $1 AND r.week < 4 AND r.status = 'submitted') AS weekly_submitted,
         (SELECT count(*)::int FROM users u WHERE (u.directorate_id = un.id OR u.institution_id = un.id) AND u.status = 'approved' AND u.disabled_at IS NULL) * $2::int AS weekly_expected,
         (SELECT count(*)::int FROM reports r WHERE r.unit_id = un.id AND r.period = $1 AND r.week = 4 AND r.status = 'submitted') AS monthly_submitted,
         (SELECT count(*)::int FROM monthly_goals g WHERE g.unit_id = un.id AND g.period = $1) AS goals_total,
         (SELECT count(*)::int FROM monthly_goals g WHERE g.unit_id = un.id AND g.period = $1 AND g.completed) AS goals_done
       FROM units un WHERE un.is_active ORDER BY un.kind, un.position, un.name`,
      [periodToDate(period), weeksElapsed]);
    const totals = units.reduce((t, u) => ({
      members: t.members + u.members, weekly_submitted: t.weekly_submitted + u.weekly_submitted,
      weekly_expected: t.weekly_expected + u.weekly_expected, monthly_submitted: t.monthly_submitted + u.monthly_submitted,
      goals_total: t.goals_total + u.goals_total, goals_done: t.goals_done + u.goals_done,
    }), { members: 0, weekly_submitted: 0, weekly_expected: 0, monthly_submitted: 0, goals_total: 0, goals_done: 0 });
    const pending = await q1(`SELECT count(*)::int AS n FROM users WHERE status = 'pending'`);
    ok(res, { period, currentWeek: weekOfMonth(), units, totals, pendingApprovals: pending?.n ?? 0 });
  }));

  // Reopen a report for editing for `hours` (default 48), overriding every window.
  router.post("/nmm/admin/reports/:id/unlock", ...admin, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!(await getReport(id))) return fail(res, 404, "not_found", "Report not found.");
    const h = Math.min(24 * 14, Math.max(1, Number(req.body?.hours) || 48));
    await q(`UPDATE reports SET unlocked_until = $2, updated_at = now() WHERE id = $1`, [id, new Date(Date.now() + h * 3_600_000)]);
    ok(res, { report: await getReport(id) });
  }));

  router.get("/nmm/periods", ...head, asyncHandler(async (_req, res) => {
    const rows = await q(`SELECT DISTINCT to_char(period, 'YYYY-MM') AS period FROM reports ORDER BY period DESC`);
    ok(res, { periods: rows.map((r) => r.period), current: currentPeriod(), currentWeek: weekOfMonth() });
  }));

  return router;
};
