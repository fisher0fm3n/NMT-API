// routes/nmm.js
// New Media Ministries (NMM) monthly reporting API.
//
// Mobile/app-facing mirror of the staff-reporting-web dashboard. It talks to the
// same `nmm_reporting` Postgres database, so anything done here shows up in the
// web app and vice versa.
//
// Auth model
//   1. The app signs in with KingsChat and receives an `authCode`.
//   2. POST /nmm/auth/kingschat exchanges that code for a bearer token.
//   3. Every other call sends `Authorization: Bearer <token>` (plus the app's
//      `x-api-key`). Tokens are stored hashed in the shared `sessions` table,
//      so web cookies and app tokens are the same sessions underneath.

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

// App-level key. Sent as `x-api-key` only — never read from the Authorization
// header, which carries the per-user bearer token.
const NMM_API_KEY =
  process.env.NMM_API_KEY ||
  process.env.PCDL_API_KEY ||
  process.env.GENERAL_API_KEY ||
  "ee115610-738b-4e7b-97e2-446468ba550c";

// KingsChat OAuth client id issued for NMM reporting.
const KC_CLIENT_ID =
  process.env.NMM_KC_CLIENT_ID || "630166b6-6431-4239-8036-c40b1b0f2652";
const KC_API_KEY = process.env.NMM_KC_API_KEY || "";
const KC_TOKEN_URL = "https://connect.kingsch.at/developer/api/oauth2/token";
const KC_PROFILE_URL = "https://connect.kingsch.at/developer/api/user/profile";

// Comma-separated KingsChat usernames auto-approved as super admins.
const BOOTSTRAP_ADMINS = String(process.env.NMM_SUPER_ADMIN_KC_USERNAMES || "")
  .split(",")
  .map((s) => s.trim().replace(/^@/, "").toLowerCase())
  .filter(Boolean);

const SESSION_DAYS = Number(process.env.NMM_SESSION_DAYS || 30);

// Must point at the SAME folder as the web app's UPLOAD_DIR for attachments to
// be readable from both, otherwise each app only sees the files it stored.
const UPLOAD_DIR = path.resolve(
  process.env.NMM_UPLOAD_DIR || path.join(process.cwd(), "uploads", "nmm"),
);
const MAX_UPLOAD_BYTES = Number(process.env.NMM_MAX_UPLOAD_MB || 25) * 1024 * 1024;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------------------------------------------------------------------------
 * DB
 * ------------------------------------------------------------------------- */

// Either NMM_DATABASE_URL on its own, or the discrete NMM_DB_* fields. Never
// both: pg lets a parsed connection string overwrite explicit fields with
// nulls, which produces confusing "role does not exist" style failures.
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

async function q(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows;
}

async function q1(text, params = []) {
  const rows = await q(text, params);
  return rows[0] || null;
}

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

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function ok(res, payload = {}) {
  return res.json({ status: true, ...payload });
}

function fail(res, http, error, message) {
  return res.status(http).json({ status: false, error, message });
}

function sha256(v) {
  return crypto.createHash("sha256").update(v).digest("hex");
}

function clean(v, max = 4000) {
  return String(v ?? "").trim().slice(0, max);
}

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const isPeriod = (p) => PERIOD_RE.test(String(p || ""));
const periodToDate = (p) => `${p}-01`;

/* ---------------------------------------------------------------------------
 * Auth middleware
 * ------------------------------------------------------------------------- */

// App key. Checked from `x-api-key` only.
function requireAppKey(req, res, next) {
  if (!NMM_API_KEY) return next();
  const incoming = (req.header("x-api-key") || "").trim();
  if (incoming !== NMM_API_KEY) {
    return fail(res, 401, "unauthorized_api_key", "Invalid or missing x-api-key.");
  }
  next();
}

const USER_SELECT = `
  SELECT u.id, u.kc_id, u.kc_username, u.kc_name, u.kc_avatar, u.email, u.phone,
         u.full_name, u.department_id, d.name AS department_name, u.role, u.status
  FROM users u
  LEFT JOIN departments d ON d.id = u.department_id`;

function shapeUser(r) {
  if (!r) return null;
  return {
    id: r.id,
    kcId: r.kc_id,
    kcUsername: r.kc_username,
    kcName: r.kc_name,
    kcAvatar: r.kc_avatar,
    email: r.email,
    phone: r.phone,
    fullName: r.full_name,
    departmentId: r.department_id,
    departmentName: r.department_name,
    role: r.role,
    status: r.status,
  };
}

function bearerToken(req) {
  const h = req.header("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : (req.header("x-user-token") || "").trim() || null;
}

// Resolves the bearer token to a user. 401 when absent or expired.
const requireUser = asyncHandler(async (req, res, next) => {
  const token = bearerToken(req);
  if (!token) return fail(res, 401, "no_token", "Sign in to continue.");
  const row = await q1(
    `${USER_SELECT}
     JOIN sessions s ON s.user_id = u.id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  if (!row) return fail(res, 401, "invalid_token", "Your session has expired. Sign in again.");
  req.nmmUser = shapeUser(row);
  next();
});

// Approved accounts only (i.e. past onboarding and admin approval).
function requireApproved(req, res, next) {
  const u = req.nmmUser;
  if (u.status !== "approved") {
    return fail(
      res,
      403,
      u.status === "new" ? "onboarding_required" : "approval_required",
      u.status === "new"
        ? "Submit your full name and department first."
        : "Your account is awaiting administrator approval.",
    );
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (req.nmmUser.role !== "super_admin") {
    return fail(res, 403, "forbidden", "Super admin access required.");
  }
  next();
}

// Where the app should send the user next, given their account state.
function nextStepFor(user) {
  if (!user) return "signin";
  if (user.status === "approved") return "home";
  if (user.status === "new") return "onboarding";
  if (user.status === "rejected") return "rejected";
  return "pending";
}

async function getUserById(id) {
  return shapeUser(await q1(`${USER_SELECT} WHERE u.id = $1`, [id]));
}

async function createSession(userId, userAgent) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000);
  await q(
    `INSERT INTO sessions (token_hash, user_id, user_agent, expires_at) VALUES ($1, $2, $3, $4)`,
    [sha256(token), userId, userAgent || null, expiresAt],
  );
  await q(`UPDATE users SET last_login_at = now() WHERE id = $1`, [userId]);
  return { token, expiresAt };
}

/* ---------------------------------------------------------------------------
 * KingsChat
 * ------------------------------------------------------------------------- */

async function exchangeKcCode(code) {
  const resp = await fetch(KC_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  const phone =
    p.phoneNumber ?? p.phone_number ?? p.phone ?? user.phoneNumber ?? user.phone_number ?? null;
  const name =
    p.name || [p.firstName ?? user.firstName, p.lastName ?? user.lastName].filter(Boolean).join(" ") || null;
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

// Find-or-create the local user for a KingsChat profile.
async function upsertKcUser(profile) {
  const username = profile.username || null;
  let row =
    (profile.kcId ? await q1(`SELECT id FROM users WHERE kc_id = $1`, [profile.kcId]) : null) ||
    (username
      ? await q1(`SELECT id FROM users WHERE kc_id IS NULL AND lower(kc_username) = lower($1)`, [username])
      : null);

  if (row) {
    await q(
      `UPDATE users SET
         kc_id = COALESCE($2, kc_id), kc_username = COALESCE($3, kc_username),
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
      `UPDATE users SET role = 'super_admin', status = 'approved',
              full_name = COALESCE(full_name, kc_name),
              reviewed_at = COALESCE(reviewed_at, now()), updated_at = now()
       WHERE id = $1`,
      [row.id],
    );
  }
  return row.id;
}

/* ---------------------------------------------------------------------------
 * Reports
 * ------------------------------------------------------------------------- */

const REPORT_SELECT = `
  SELECT r.id, r.user_id, r.department_id, d.name AS department_name,
         COALESCE(u.full_name, u.kc_name) AS author_name, u.kc_username AS author_username,
         to_char(r.period, 'YYYY-MM') AS period, r.status, r.directorate, r.head_of_department,
         to_char(r.submission_date, 'YYYY-MM-DD') AS submission_date,
         r.submitted_at::text AS submitted_at, r.updated_at::text AS updated_at
  FROM reports r
  LEFT JOIN departments d ON d.id = r.department_id
  LEFT JOIN users u ON u.id = r.user_id`;

const SUMMARY_SELECT = `
  SELECT r.id, to_char(r.period, 'YYYY-MM') AS period, r.status,
         r.submitted_at::text AS submitted_at, r.updated_at::text AS updated_at,
         r.department_id, d.name AS department_name,
         COALESCE(u.full_name, u.kc_name) AS author_name, u.kc_username AS author_username,
         (SELECT count(*)::int FROM report_goals g WHERE g.report_id = r.id) AS goals_total,
         (SELECT count(*)::int FROM report_goals g WHERE g.report_id = r.id AND g.completed) AS goals_done
  FROM reports r
  LEFT JOIN departments d ON d.id = r.department_id
  LEFT JOIN users u ON u.id = r.user_id`;

async function loadReport(row) {
  if (!row) return null;
  const [goals, platforms, highlights, relations, attachments] = await Promise.all([
    q(
      `SELECT id, goal, intended_outcome, target_date, completed, completed_at::text AS completed_at
       FROM report_goals WHERE report_id = $1 ORDER BY position, id`,
      [row.id],
    ),
    q(
      `SELECT id, platform, purpose, hosted_on, status FROM report_platforms
       WHERE report_id = $1 ORDER BY position, id`,
      [row.id],
    ),
    q(
      `SELECT id, goal, purpose, status_impact FROM report_highlights
       WHERE report_id = $1 ORDER BY position, id`,
      [row.id],
    ),
    q(
      `SELECT id, activity, overlap, collaboration, suggestions FROM report_relations
       WHERE report_id = $1 ORDER BY position, id`,
      [row.id],
    ),
    q(
      `SELECT id, original_name, mime_type, size_bytes::int AS size_bytes, created_at::text AS created_at
       FROM report_attachments WHERE report_id = $1 ORDER BY created_at`,
      [row.id],
    ),
  ]);
  return { ...row, goals, platforms, highlights, relations, attachments };
}

async function getReport(id) {
  return loadReport(await q1(`${REPORT_SELECT} WHERE r.id = $1`, [id]));
}

async function getReportForPeriod(userId, period) {
  return loadReport(
    await q1(`${REPORT_SELECT} WHERE r.user_id = $1 AND r.period = $2`, [userId, periodToDate(period)]),
  );
}

// Creates the month's report if it does not exist. Directorate and head of
// department are taken from the account; the submission date is stamped later.
async function getOrCreateReport(user, period) {
  const existing = await getReportForPeriod(user.id, period);
  if (existing) return existing;
  await q(
    `INSERT INTO reports (user_id, department_id, period, directorate, head_of_department)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, period) DO NOTHING`,
    [
      user.id,
      user.departmentId,
      periodToDate(period),
      user.departmentName || "",
      user.fullName || user.kcName || "",
    ],
  );
  return getReportForPeriod(user.id, period);
}

function nonEmpty(rows, keys) {
  return (Array.isArray(rows) ? rows : []).filter((r) => keys.some((k) => clean(r?.[k]).length > 0));
}

async function replaceRows(client, table, reportId, columns, rows) {
  await client.query(`DELETE FROM ${table} WHERE report_id = $1`, [reportId]);
  for (let i = 0; i < rows.length; i += 1) {
    const values = columns.map((c) => clean(rows[i][c]));
    const placeholders = values.map((_, j) => `$${j + 3}`).join(", ");
    await client.query(
      `INSERT INTO ${table} (report_id, position, ${columns.join(", ")}) VALUES ($1, $2, ${placeholders})`,
      [reportId, i, ...values],
    );
  }
}

// Saves the four sections. Goals are matched by id so their completion state
// survives an edit. Identification fields are re-derived, never taken from the
// request body.
async function saveReport(reportId, body) {
  await withTx(async (client) => {
    await client.query(
      `UPDATE reports SET
         directorate = COALESCE((SELECT name FROM departments WHERE id = reports.department_id), directorate),
         head_of_department = COALESCE(
           (SELECT NULLIF(TRIM(COALESCE(u.full_name, u.kc_name, '')), '') FROM users u WHERE u.id = reports.user_id),
           head_of_department),
         updated_at = now()
       WHERE id = $1`,
      [reportId],
    );

    const goals = nonEmpty(body.goals, ["goal", "intended_outcome", "target_date"]);
    const keep = [];
    for (let i = 0; i < goals.length; i += 1) {
      const g = goals[i];
      if (g.id) {
        const r = await client.query(
          `UPDATE report_goals SET position = $3, goal = $4, intended_outcome = $5, target_date = $6
           WHERE id = $1 AND report_id = $2 RETURNING id`,
          [g.id, reportId, i, clean(g.goal), clean(g.intended_outcome), clean(g.target_date, 300)],
        );
        if (r.rows[0]) {
          keep.push(r.rows[0].id);
          continue;
        }
      }
      const ins = await client.query(
        `INSERT INTO report_goals (report_id, position, goal, intended_outcome, target_date)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [reportId, i, clean(g.goal), clean(g.intended_outcome), clean(g.target_date, 300)],
      );
      keep.push(ins.rows[0].id);
    }
    await client.query(`DELETE FROM report_goals WHERE report_id = $1 AND NOT (id = ANY($2::int[]))`, [
      reportId,
      keep,
    ]);

    await replaceRows(client, "report_platforms", reportId, ["platform", "purpose", "hosted_on", "status"],
      nonEmpty(body.platforms, ["platform", "purpose", "hosted_on", "status"]));
    await replaceRows(client, "report_highlights", reportId, ["goal", "purpose", "status_impact"],
      nonEmpty(body.highlights, ["goal", "purpose", "status_impact"]));
    await replaceRows(client, "report_relations", reportId, ["activity", "overlap", "collaboration", "suggestions"],
      nonEmpty(body.relations, ["activity", "overlap", "collaboration", "suggestions"]));
  });
}

/* ---------------------------------------------------------------------------
 * Uploads
 * ------------------------------------------------------------------------- */

const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
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

function uploadsFor(field = "files") {
  return (req, res, next) => {
    attachmentUpload.array(field, 10)(req, res, (err) => {
      if (!err) return next();
      const tooBig = err.code === "LIMIT_FILE_SIZE";
      return fail(
        res,
        tooBig ? 413 : 400,
        "upload_error",
        tooBig ? `Each file must be ${MAX_UPLOAD_BYTES / 1024 / 1024} MB or smaller.` : err.message || "Upload failed.",
      );
    });
  };
}

function safeExt(name) {
  const ext = path.extname(String(name || "")).toLowerCase().replace(/[^a-z0-9.]/g, "");
  return ext.length <= 10 ? ext : "";
}

// Resolve a stored_name to an absolute path, refusing anything outside the root.
function attachmentPath(storedName) {
  const abs = path.resolve(UPLOAD_DIR, storedName);
  if (abs !== UPLOAD_DIR && !abs.startsWith(UPLOAD_DIR + path.sep)) return null;
  return abs;
}

/* ---------------------------------------------------------------------------
 * Routes
 * ------------------------------------------------------------------------- */

module.exports = function nmmRoutes() {
  const router = Router();

  // Everything under /nmm needs the app key.
  router.use("/nmm", requireAppKey);

  /* ---- health ---------------------------------------------------------- */

  router.get(
    "/nmm/ping",
    asyncHandler(async (_req, res) => {
      const row = await q1(`SELECT count(*)::int AS departments FROM departments WHERE is_active`);
      ok(res, { message: "nmm reporting api alive", departments: row?.departments ?? 0 });
    }),
  );

  /* ---- auth ------------------------------------------------------------ */

  // Exchange a KingsChat authCode (or an access token the app already holds)
  // for a bearer token for this API.
  router.post(
    "/nmm/auth/kingschat",
    asyncHandler(async (req, res) => {
      const code = clean(req.body?.code || req.body?.authCode, 4096);
      const supplied = clean(req.body?.accessToken, 4096);
      if (!code && !supplied) {
        return fail(res, 400, "missing_code", "Provide `code` from KingsChat, or an `accessToken`.");
      }

      let accessToken = supplied;
      if (!accessToken) {
        const tokens = await exchangeKcCode(code);
        if (!tokens) {
          return fail(res, 502, "kc_exchange_failed", "Could not exchange the KingsChat code.");
        }
        accessToken = tokens.accessToken;
      }

      const profile = await fetchKcProfile(accessToken);
      if (!profile) return fail(res, 502, "kc_profile_failed", "Could not read your KingsChat profile.");
      if (!profile.kcId && !profile.username) {
        return fail(res, 502, "kc_no_identity", "KingsChat did not return an identity.");
      }

      const userId = await upsertKcUser(profile);
      const user = await getUserById(userId);
      const { token, expiresAt } = await createSession(userId, req.get("user-agent"));
      ok(res, { token, expiresAt: expiresAt.toISOString(), next: nextStepFor(user), user });
    }),
  );

  router.post(
    "/nmm/auth/logout",
    requireUser,
    asyncHandler(async (req, res) => {
      await q(`DELETE FROM sessions WHERE token_hash = $1`, [sha256(bearerToken(req))]);
      ok(res, { message: "signed out" });
    }),
  );

  /* ---- profile --------------------------------------------------------- */

  router.get(
    "/nmm/me",
    requireUser,
    asyncHandler(async (req, res) => {
      ok(res, { user: req.nmmUser, next: nextStepFor(req.nmmUser) });
    }),
  );

  // Users may change their own name and phone. Department and role are
  // administrator-only.
  router.patch(
    "/nmm/me",
    requireUser,
    asyncHandler(async (req, res) => {
      const fullName = clean(req.body?.fullName, 200);
      const phone = clean(req.body?.phone, 40) || null;
      if (fullName.length < 3) return fail(res, 400, "invalid_name", "Please provide your full name.");
      await q(`UPDATE users SET full_name = $2, phone = $3, updated_at = now() WHERE id = $1`, [
        req.nmmUser.id,
        fullName,
        phone,
      ]);
      ok(res, { user: await getUserById(req.nmmUser.id) });
    }),
  );

  router.get(
    "/nmm/departments",
    asyncHandler(async (_req, res) => {
      ok(res, { departments: await q(`SELECT id, name FROM departments WHERE is_active ORDER BY name`) });
    }),
  );

  // Onboarding: full name + department, then the account waits for approval.
  router.post(
    "/nmm/onboarding",
    requireUser,
    asyncHandler(async (req, res) => {
      const fullName = clean(req.body?.fullName, 200);
      const departmentId = Number(req.body?.departmentId);
      if (fullName.length < 3) return fail(res, 400, "invalid_name", "Please provide your full name.");
      const dept = await q1(`SELECT id FROM departments WHERE id = $1 AND is_active`, [departmentId]);
      if (!dept) return fail(res, 400, "invalid_department", "Select a valid department.");

      await q(
        `UPDATE users SET full_name = $2, department_id = $3,
                status = CASE WHEN status = 'approved' THEN status ELSE 'pending'::user_status END,
                profile_submitted_at = now(), updated_at = now()
         WHERE id = $1`,
        [req.nmmUser.id, fullName, departmentId],
      );
      const user = await getUserById(req.nmmUser.id);
      ok(res, { user, next: nextStepFor(user) });
    }),
  );

  /* ---- my reports ------------------------------------------------------ */

  router.get(
    "/nmm/reports",
    requireUser,
    requireApproved,
    asyncHandler(async (req, res) => {
      ok(res, {
        reports: await q(`${SUMMARY_SELECT} WHERE r.user_id = $1 ORDER BY r.period DESC`, [req.nmmUser.id]),
      });
    }),
  );

  // Create (or return) this user's report for a month. Body: { period }
  router.post(
    "/nmm/reports",
    requireUser,
    requireApproved,
    asyncHandler(async (req, res) => {
      const period = clean(req.body?.period, 7);
      if (!isPeriod(period)) return fail(res, 400, "invalid_period", "Use a period like 2026-09.");
      ok(res, { report: await getOrCreateReport(req.nmmUser, period) });
    }),
  );

  // The caller's report for a month. `?create=1` opens a draft if none exists.
  router.get(
    "/nmm/reports/period/:period",
    requireUser,
    requireApproved,
    asyncHandler(async (req, res) => {
      const { period } = req.params;
      if (!isPeriod(period)) return fail(res, 400, "invalid_period", "Use a period like 2026-09.");
      const create = ["1", "true", "yes"].includes(String(req.query.create || "").toLowerCase());
      const report = create
        ? await getOrCreateReport(req.nmmUser, period)
        : await getReportForPeriod(req.nmmUser.id, period);
      if (!report) return fail(res, 404, "not_found", "No report for that month yet.");
      ok(res, { report });
    }),
  );

  router.get(
    "/nmm/reports/:id",
    requireUser,
    requireApproved,
    asyncHandler(async (req, res) => {
      const report = await getReport(Number(req.params.id));
      if (!report) return fail(res, 404, "not_found", "Report not found.");
      if (report.user_id !== req.nmmUser.id && req.nmmUser.role !== "super_admin") {
        return fail(res, 403, "forbidden", "Not your report.");
      }
      ok(res, { report });
    }),
  );

  // Save the four sections of a draft. Identification fields are ignored.
  router.put(
    "/nmm/reports/:id",
    requireUser,
    requireApproved,
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const report = await getReport(id);
      if (!report) return fail(res, 404, "not_found", "Report not found.");
      if (report.user_id !== req.nmmUser.id) return fail(res, 403, "forbidden", "Only the owner can edit it.");
      if (report.status === "submitted") {
        return fail(res, 409, "report_locked", "This report has been submitted and is locked.");
      }
      await saveReport(id, req.body || {});
      ok(res, { report: await getReport(id) });
    }),
  );

  // Submit. Stamps the submission date with today's date and locks the report.
  router.post(
    "/nmm/reports/:id/submit",
    requireUser,
    requireApproved,
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const report = await getReport(id);
      if (!report) return fail(res, 404, "not_found", "Report not found.");
      if (report.user_id !== req.nmmUser.id) return fail(res, 403, "forbidden", "Only the owner can submit it.");
      if (report.status === "submitted") return ok(res, { report });

      const errors = [];
      if (!clean(report.directorate)) {
        errors.push("Your account has no department assigned. Ask an administrator to set it.");
      }
      if (!clean(report.head_of_department)) {
        errors.push("Your account has no full name. Set it on your profile before submitting.");
      }
      if (!report.goals.some((g) => clean(g.goal))) errors.push("Add at least one goal for the month.");
      if (errors.length) return fail(res, 422, "validation_failed", errors.join(" "));

      await q(
        `UPDATE reports SET status = 'submitted', submitted_at = now(), submission_date = CURRENT_DATE,
                updated_at = now()
         WHERE id = $1`,
        [id],
      );
      ok(res, { report: await getReport(id) });
    }),
  );

  // Delete. Only while the report is still a draft.
  router.delete(
    "/nmm/reports/:id",
    requireUser,
    requireApproved,
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const report = await getReport(id);
      if (!report) return fail(res, 404, "not_found", "Report not found.");
      if (report.user_id !== req.nmmUser.id && req.nmmUser.role !== "super_admin") {
        return fail(res, 403, "forbidden", "Only the owner can delete it.");
      }
      if (report.status === "submitted") {
        return fail(res, 409, "report_locked", "Submitted reports can no longer be deleted.");
      }
      const gone = await q(`DELETE FROM reports WHERE id = $1 AND status = 'draft' RETURNING id`, [id]);
      if (!gone.length) return fail(res, 409, "report_locked", "Submitted reports can no longer be deleted.");
      await fsp.rm(path.join(UPLOAD_DIR, String(id)), { recursive: true, force: true }).catch(() => {});
      ok(res, { id });
    }),
  );

  /* ---- goals ----------------------------------------------------------- */

  // Tick a goal off (or back on). Works after submission — that is the point of
  // the goal tracker.
  router.patch(
    "/nmm/goals/:id",
    requireUser,
    requireApproved,
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const owner = await q1(
        `SELECT r.user_id, r.id AS report_id FROM report_goals g
         JOIN reports r ON r.id = g.report_id WHERE g.id = $1`,
        [id],
      );
      if (!owner) return fail(res, 404, "not_found", "Goal not found.");
      if (owner.user_id !== req.nmmUser.id && req.nmmUser.role !== "super_admin") {
        return fail(res, 403, "forbidden", "Not your goal.");
      }
      const completed = Boolean(req.body?.completed);
      await q(
        `UPDATE report_goals SET completed = $2, completed_at = CASE WHEN $2 THEN now() ELSE NULL END
         WHERE id = $1`,
        [id, completed],
      );
      ok(res, { id, completed });
    }),
  );

  /* ---- attachments ----------------------------------------------------- */

  // Multipart upload, field name `files` (repeat it for several files).
  router.post(
    "/nmm/reports/:id/attachments",
    requireUser,
    requireApproved,
    uploadsFor("files"),
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const report = await getReport(id);
      if (!report) return fail(res, 404, "not_found", "Report not found.");
      if (report.user_id !== req.nmmUser.id) {
        return fail(res, 403, "forbidden", "Only the owner can add attachments.");
      }
      if (report.status === "submitted") {
        return fail(res, 409, "report_locked", "This report has been submitted and is locked.");
      }
      const files = req.files || [];
      if (!files.length) return fail(res, 400, "no_files", "No files received.");

      const dir = path.join(UPLOAD_DIR, String(id));
      await fsp.mkdir(dir, { recursive: true });

      const saved = [];
      for (const file of files) {
        const storedName = `${id}/${Date.now()}-${crypto.randomBytes(6).toString("hex")}${safeExt(file.originalname)}`;
        await fsp.writeFile(path.join(UPLOAD_DIR, storedName), file.buffer);
        const row = await q1(
          `INSERT INTO report_attachments (report_id, uploaded_by, original_name, stored_name, mime_type, size_bytes)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, original_name, mime_type, size_bytes::int AS size_bytes, created_at::text AS created_at`,
          [
            id,
            req.nmmUser.id,
            clean(file.originalname, 255),
            storedName,
            file.mimetype || "application/octet-stream",
            file.size,
          ],
        );
        saved.push(row);
      }
      ok(res, { attachments: saved });
    }),
  );

  // Download / stream one attachment. `?download=1` forces a save dialog.
  router.get(
    "/nmm/attachments/:id",
    requireUser,
    requireApproved,
    asyncHandler(async (req, res) => {
      const att = await q1(
        `SELECT a.*, r.user_id AS owner_id FROM report_attachments a
         JOIN reports r ON r.id = a.report_id WHERE a.id = $1`,
        [Number(req.params.id)],
      );
      if (!att) return fail(res, 404, "not_found", "Attachment not found.");
      if (att.owner_id !== req.nmmUser.id && req.nmmUser.role !== "super_admin") {
        return fail(res, 403, "forbidden", "Not your attachment.");
      }
      const abs = attachmentPath(att.stored_name);
      if (!abs || !fs.existsSync(abs)) {
        return fail(res, 404, "file_missing", "The stored file is not on this server.");
      }
      const inline = att.mime_type.startsWith("image/") || att.mime_type === "application/pdf";
      const disposition = req.query.download ? "attachment" : inline ? "inline" : "attachment";
      res.setHeader("Content-Type", att.mime_type);
      res.setHeader("Content-Length", att.size_bytes);
      res.setHeader(
        "Content-Disposition",
        `${disposition}; filename*=UTF-8''${encodeURIComponent(att.original_name)}`,
      );
      fs.createReadStream(abs).pipe(res);
    }),
  );

  router.delete(
    "/nmm/attachments/:id",
    requireUser,
    requireApproved,
    asyncHandler(async (req, res) => {
      const att = await q1(
        `SELECT a.id, a.stored_name, r.user_id AS owner_id, r.status FROM report_attachments a
         JOIN reports r ON r.id = a.report_id WHERE a.id = $1`,
        [Number(req.params.id)],
      );
      if (!att) return fail(res, 404, "not_found", "Attachment not found.");
      if (att.owner_id !== req.nmmUser.id && req.nmmUser.role !== "super_admin") {
        return fail(res, 403, "forbidden", "Not your attachment.");
      }
      if (att.status === "submitted") {
        return fail(res, 409, "report_locked", "This report has been submitted and is locked.");
      }
      await q(`DELETE FROM report_attachments WHERE id = $1`, [att.id]);
      const abs = attachmentPath(att.stored_name);
      if (abs) await fsp.unlink(abs).catch(() => {});
      ok(res, { id: att.id });
    }),
  );

  /* ---- admin ----------------------------------------------------------- */

  router.get(
    "/nmm/admin/users",
    requireUser,
    requireApproved,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
      const status = String(req.query.status || "").trim();
      const valid = ["new", "pending", "approved", "rejected"].includes(status);
      const users = await q(
        `SELECT u.id, u.kc_username, u.kc_name, u.kc_avatar, u.email, u.phone, u.full_name,
                u.department_id, d.name AS department_name, u.role, u.status,
                u.profile_submitted_at::text AS profile_submitted_at,
                u.reviewed_at::text AS reviewed_at, u.last_login_at::text AS last_login_at,
                u.created_at::text AS created_at
         FROM users u LEFT JOIN departments d ON d.id = u.department_id
         ${valid ? "WHERE u.status = $1" : ""}
         ORDER BY CASE u.status WHEN 'pending' THEN 0 WHEN 'new' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END,
                  u.profile_submitted_at DESC NULLS LAST, u.created_at DESC`,
        valid ? [status] : [],
      );
      ok(res, { users });
    }),
  );

  // Approve / reject an account, change its role or department.
  router.patch(
    "/nmm/admin/users/:id",
    requireUser,
    requireApproved,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const admin = req.nmmUser;
      const body = req.body || {};

      let status = null;
      if (body.status !== undefined) {
        if (!["pending", "approved", "rejected"].includes(body.status)) {
          return fail(res, 400, "invalid_status", "status must be pending, approved or rejected.");
        }
        if (id === admin.id && body.status !== "approved") {
          return fail(res, 400, "self_suspend", "You cannot suspend your own account.");
        }
        status = body.status;
      }

      let role = null;
      if (body.role !== undefined) {
        if (!["director", "super_admin"].includes(body.role)) {
          return fail(res, 400, "invalid_role", "role must be director or super_admin.");
        }
        if (id === admin.id && body.role !== "super_admin") {
          return fail(res, 400, "self_demote", "You cannot remove your own super admin role.");
        }
        role = body.role;
      }

      const setDept = body.departmentId !== undefined;
      const departmentId = setDept && body.departmentId ? Number(body.departmentId) : null;

      await q(
        `UPDATE users SET
           status = COALESCE($3, status),
           role = COALESCE($4, role),
           department_id = CASE WHEN $6 THEN $5 ELSE department_id END,
           reviewed_at = CASE WHEN $3 IS NULL THEN reviewed_at ELSE now() END,
           reviewed_by = CASE WHEN $3 IS NULL THEN reviewed_by ELSE $2 END,
           updated_at = now()
         WHERE id = $1`,
        [id, admin.id, status, role, departmentId, setDept],
      );
      const user = await getUserById(id);
      if (!user) return fail(res, 404, "not_found", "User not found.");
      ok(res, { user });
    }),
  );

  router.get(
    "/nmm/admin/departments",
    requireUser,
    requireApproved,
    requireSuperAdmin,
    asyncHandler(async (_req, res) => {
      ok(res, { departments: await q(`SELECT id, name, is_active FROM departments ORDER BY name`) });
    }),
  );

  router.post(
    "/nmm/admin/departments",
    requireUser,
    requireApproved,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
      const name = clean(req.body?.name, 120);
      if (name.length < 2) return fail(res, 400, "invalid_name", "Enter a department name.");
      const department = await q1(
        `INSERT INTO departments (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET is_active = TRUE
         RETURNING id, name, is_active`,
        [name],
      );
      ok(res, { department });
    }),
  );

  router.patch(
    "/nmm/admin/departments/:id",
    requireUser,
    requireApproved,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const name = req.body?.name !== undefined ? clean(req.body.name, 120) : null;
      if (name !== null && name.length < 2) return fail(res, 400, "invalid_name", "Enter a department name.");
      const isActive = req.body?.isActive !== undefined ? Boolean(req.body.isActive) : null;
      await q(
        `UPDATE departments SET name = COALESCE($2, name), is_active = COALESCE($3, is_active) WHERE id = $1`,
        [id, name, isActive],
      );
      const department = await q1(`SELECT id, name, is_active FROM departments WHERE id = $1`, [id]);
      if (!department) return fail(res, 404, "not_found", "Department not found.");
      ok(res, { department });
    }),
  );

  // Every submission, filterable by ?period=YYYY-MM&department=<id>&status=
  router.get(
    "/nmm/admin/reports",
    requireUser,
    requireApproved,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
      const where = [];
      const params = [];
      const { period, department, status } = req.query;
      if (period) {
        if (!isPeriod(period)) return fail(res, 400, "invalid_period", "Use a period like 2026-09.");
        params.push(periodToDate(period));
        where.push(`r.period = $${params.length}`);
      }
      if (department) {
        params.push(Number(department));
        where.push(`r.department_id = $${params.length}`);
      }
      if (status) {
        if (!["draft", "submitted"].includes(status)) {
          return fail(res, 400, "invalid_status", "status must be draft or submitted.");
        }
        params.push(status);
        where.push(`r.status = $${params.length}`);
      }
      const reports = await q(
        `${SUMMARY_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY r.period DESC, d.name, author_name`,
        params,
      );
      ok(res, { reports });
    }),
  );

  // Per-department totals for a month: people, submissions, goal progress.
  router.get(
    "/nmm/admin/overview",
    requireUser,
    requireApproved,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
      const period = clean(req.query.period, 7) || new Date().toISOString().slice(0, 7);
      if (!isPeriod(period)) return fail(res, 400, "invalid_period", "Use a period like 2026-09.");
      const departments = await q(
        `SELECT d.id, d.name,
           (SELECT count(*)::int FROM users u WHERE u.department_id = d.id AND u.status = 'approved') AS directors,
           (SELECT count(*)::int FROM reports r WHERE r.department_id = d.id AND r.period = $1 AND r.status = 'submitted') AS submitted,
           (SELECT count(*)::int FROM reports r WHERE r.department_id = d.id AND r.period = $1 AND r.status = 'draft') AS drafts,
           (SELECT count(*)::int FROM report_goals g JOIN reports r ON r.id = g.report_id
              WHERE r.department_id = d.id AND r.period = $1 AND r.status = 'submitted') AS goals_total,
           (SELECT count(*)::int FROM report_goals g JOIN reports r ON r.id = g.report_id
              WHERE r.department_id = d.id AND r.period = $1 AND r.status = 'submitted' AND g.completed) AS goals_done
         FROM departments d WHERE d.is_active ORDER BY d.name`,
        [periodToDate(period)],
      );
      const totals = departments.reduce(
        (t, d) => ({
          directors: t.directors + d.directors,
          submitted: t.submitted + d.submitted,
          drafts: t.drafts + d.drafts,
          goals_total: t.goals_total + d.goals_total,
          goals_done: t.goals_done + d.goals_done,
        }),
        { directors: 0, submitted: 0, drafts: 0, goals_total: 0, goals_done: 0 },
      );
      const pending = await q1(`SELECT count(*)::int AS n FROM users WHERE status = 'pending'`);
      ok(res, { period, departments, totals, pendingApprovals: pending?.n ?? 0 });
    }),
  );

  // Unlock a submitted report so its owner can edit and resubmit it.
  router.post(
    "/nmm/admin/reports/:id/reopen",
    requireUser,
    requireApproved,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      if (!(await getReport(id))) return fail(res, 404, "not_found", "Report not found.");
      await q(`UPDATE reports SET status = 'draft', updated_at = now() WHERE id = $1`, [id]);
      ok(res, { report: await getReport(id) });
    }),
  );

  // Months that already have reports, for period pickers.
  router.get(
    "/nmm/periods",
    requireUser,
    requireApproved,
    asyncHandler(async (_req, res) => {
      const rows = await q(
        `SELECT DISTINCT to_char(period, 'YYYY-MM') AS period FROM reports ORDER BY period DESC`,
      );
      ok(res, { periods: rows.map((r) => r.period), current: new Date().toISOString().slice(0, 7) });
    }),
  );

  return router;
};
