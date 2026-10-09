// routes/kingspresenter.js
// KingsPresenter: church presentation software (desktop) and KingsPresenter Remote
// (phones that run the church screens through a relay). This is their account service.
//
// Model
//   users            KingsChat identity
//   devices          the computers and phones an account signs in on
//   refresh_tokens   one per signed-in device (hashed; used once, then replaced)
//   documents        the account's library (songs, services, slides…), synced between computers
//   media_objects    the library's media files, by content hash
//   relays           the relay servers phones and church computers meet at
//   remote_sessions  a church computer's Remote sessions, as its relay reports them
//   remote_joins     the phones that joined them
//   settings         this service's own values (the token signing key when none is set)
//
// Auth: POST /kp/auth/kingschat exchanges a KingsChat authCode for an access token
// (a short-lived HS256 JWT the relay can check) and a refresh token. Every other call
// sends `Authorization: Bearer <accessToken>`, plus `x-api-key` when KP_API_KEY is set.
//
// The database (default name `kingspresenter`) and its tables are created on first use.

const { Router } = require("express");
const express = require("express");
const { Pool, Client } = require("pg");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");

// The API's own .env (beside server.js), wherever pm2 was started from: dotenv's default is
// the working folder, which pm2 does not set. Values already set are kept.
const ENV_FILE = path.join(__dirname, "..", ".env");
// KP_SKIP_ENV_FILE: the environment only (tests, so they never reach the real database).
if (!process.env.KP_SKIP_ENV_FILE) {
  try { require("dotenv").config({ path: ENV_FILE, quiet: true }); } catch { /* no dotenv: the environment only */ }
}

/* ---------------------------------------------------------------------------
 * ENV
 * ------------------------------------------------------------------------- */

const env = (...names) => names.map((n) => process.env[n]).find((v) => v != null && v !== "");

// Unset: no app key is asked for (KingsPresenter's apps send it when they have one).
const KP_API_KEY = env("KP_API_KEY") || "";

// KingsChat: the same client as NMM reporting (KP_* to give KingsPresenter its own).
const KC_CLIENT_ID = env("KP_KC_CLIENT_ID", "NMM_KC_CLIENT_ID") || "";
const KC_API_KEY = env("KP_KC_API_KEY", "NMM_KC_API_KEY") || "";
const KC_TOKEN_URL = env("KP_KC_TOKEN_URL") || "https://connect.kingsch.at/developer/api/oauth2/token";
const KC_PROFILE_URL = env("KP_KC_PROFILE_URL") || "https://connect.kingsch.at/developer/api/user/profile";
const KC_LOGIN_URL = "https://accounts.kingschat.online/log-in";
const SITE_URL = (env("KP_SITE_URL", "NMM_SITE_URL") || "").replace(/\/+$/, "");

const ACCESS_TTL = Number(env("KP_ACCESS_TTL_SECONDS") || 3600);
const REFRESH_DAYS = Number(env("KP_REFRESH_DAYS") || 90);
// Outside the project folder: pm2 restarts the API when a file in it changes.
const MEDIA_DIR = path.resolve(env("KP_MEDIA_DIR") || path.join(os.homedir(), "kingspresenter-media"));
const MAX_MEDIA = `${Number(env("KP_MAX_MEDIA_MB") || 2048)}mb`;
// Relays report their sessions with this key (unset: they cannot report).
const RELAY_KEY = env("KP_RELAY_KEY") || "";
// A relay to offer when the relays table has none yet, e.g. wss://relay.example.org.
const DEFAULT_RELAY = env("KP_RELAY_URL") || "";

const KINDS = new Set(["services", "songs", "presentations", "media", "templates", "settings"]);

/* ---------------------------------------------------------------------------
 * DB
 * ------------------------------------------------------------------------- */

const DB_NAME = env("KP_DB_NAME") || "kingspresenter";

/**
 * Where the database is: KINGSPRESENTER_DATABASE_URL (KingsPresenter's own, as NMM reporting
 * has NMM_DATABASE_URL; KP_DATABASE_URL the same), else KingsPresenter's own fields
 * (KP_DB_*), else NMM reporting's Postgres server (NMM_DATABASE_URL, NMM_DB_*), else
 * PCO_FN's, those with the database `kingspresenter` on it.
 */
function dbConfigFrom(e) {
  const pick = (...names) => names.map((n) => e[n]).find((v) => v != null && v !== "");
  const own = pick("KINGSPRESENTER_DATABASE_URL", "KP_DATABASE_URL");
  if (own) return { connectionString: own };
  if (pick("NMM_DATABASE_URL")) {
    const u = new URL(pick("NMM_DATABASE_URL"));
    u.pathname = `/${pick("KP_DB_NAME") || "kingspresenter"}`;
    return { connectionString: u.toString() };
  }
  return {
    user: pick("KP_DB_USER", "NMM_DB_USER", "PCO_FN_DB_USER") || "postgres",
    host: pick("KP_DB_HOST", "NMM_DB_HOST", "PCO_FN_DB_HOST"),
    database: pick("KP_DB_NAME") || "kingspresenter",
    password: pick("KP_DB_PASSWORD", "NMM_DB_PASSWORD", "PCO_FN_DB_PASSWORD"),
    port: Number(pick("KP_DB_PORT", "NMM_DB_PORT", "PCO_FN_DB_PORT") || 5432),
  };
}
const poolConfig = dbConfigFrom(process.env);
// No password anywhere: say so, rather than Postgres's "client password must be a string".
const DB_MISSING = !poolConfig.connectionString && typeof poolConfig.password !== "string"
  ? "The KingsPresenter database is not set up on this server: add KINGSPRESENTER_DATABASE_URL to its .env (postgres://user:password@host:5432/kingspresenter)."
  : "";
if (DB_MISSING) {
  const found = fs.existsSync(ENV_FILE) ? "it is there, without KINGSPRESENTER_DATABASE_URL" : "there is no such file";
  console.error(`[kp] ${DB_MISSING} Looked in ${ENV_FILE}: ${found}.`);
}
const pool = new Pool({ ...poolConfig, max: Number(env("KP_DB_POOL_SIZE") || 10) });
pool.on("error", (err) => console.error("[kp] idle pg client error:", err.message));

const q = async (text, params = []) => (await pool.query(text, params)).rows;
const q1 = async (text, params = []) => (await q(text, params))[0] || null;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY,
    kc_id TEXT UNIQUE,
    kc_username TEXT,
    kc_name TEXT,
    kc_avatar TEXT,
    email TEXT,
    phone TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS users_kc_username ON users (lower(kc_username));

  CREATE TABLE IF NOT EXISTS devices (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'desktop',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS devices_user ON devices (user_id);

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
    user_agent TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS refresh_tokens_user ON refresh_tokens (user_id);

  CREATE TABLE IF NOT EXISTS documents (
    seq BIGSERIAL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    rev INTEGER NOT NULL,
    json JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    deleted_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, kind, id)
  );
  CREATE INDEX IF NOT EXISTS documents_user_seq ON documents (user_id, seq);

  CREATE TABLE IF NOT EXISTS media_objects (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sha256 TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    bytes BIGINT NOT NULL DEFAULT 0,
    mime TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, sha256)
  );

  CREATE TABLE IF NOT EXISTS relays (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    region TEXT NOT NULL DEFAULT '',
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS remote_sessions (
    id TEXT PRIMARY KEY,
    relay_id INTEGER REFERENCES relays(id) ON DELETE SET NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL DEFAULT '',
    opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at TIMESTAMPTZ,
    close_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS remote_sessions_user ON remote_sessions (user_id, opened_at DESC);

  CREATE TABLE IF NOT EXISTS remote_joins (
    id BIGSERIAL PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES remote_sessions(id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT '',
    via TEXT NOT NULL DEFAULT '',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    left_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS remote_joins_session ON remote_joins (session_id, remote_id);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

// The database itself, then its tables: once, on the first call (again after a failure).
let schemaReady = null;
async function createDatabase() {
  const admin = new Client(
    poolConfig.connectionString
      ? { connectionString: poolConfig.connectionString.replace(/\/[^/?]+(\?|$)/, "/postgres$1") }
      : { ...poolConfig, database: "postgres" },
  );
  await admin.connect();
  try {
    const name = poolConfig.connectionString ? new URL(poolConfig.connectionString).pathname.slice(1) : DB_NAME;
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("KingsPresenter database name must be lowercase letters, digits and _");
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (!exists.rowCount) await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end().catch(() => {});
  }
}
function ensureSchema() {
  if (DB_MISSING) return Promise.reject(Object.assign(new Error(DB_MISSING), { statusCode: 503 }));
  if (!schemaReady) {
    schemaReady = (async () => {
      try {
        await pool.query("SELECT 1");
      } catch (err) {
        if (err.code !== "3D000") throw err; // 3D000: no such database
        await createDatabase();
      }
      await pool.query(SCHEMA);
      if (DEFAULT_RELAY) {
        await q(`INSERT INTO relays (name, url) SELECT 'KingsPresenter', $1 WHERE NOT EXISTS (SELECT 1 FROM relays)`, [DEFAULT_RELAY]);
      }
    })().catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ok = (res, payload = {}) => res.json({ status: true, ...payload });
const fail = (res, http, error, message) => res.status(http).json({ status: false, error, message });
const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const clean = (v, max = 4000) => String(v ?? "").trim().slice(0, max);
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ""));
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/* ---------------------------------------------------------------------------
 * Tokens
 * ------------------------------------------------------------------------- */

// The signing key: KP_TOKEN_SECRET, or one made once and kept in `settings`.
let secretPromise = null;
function tokenSecret() {
  if (env("KP_TOKEN_SECRET")) return Promise.resolve(env("KP_TOKEN_SECRET"));
  if (!secretPromise) {
    secretPromise = (async () => {
      await ensureSchema();
      await q(`INSERT INTO settings (key, value) VALUES ('token_secret', $1) ON CONFLICT (key) DO NOTHING`, [crypto.randomBytes(48).toString("base64url")]);
      return (await q1(`SELECT value FROM settings WHERE key = 'token_secret'`)).value;
    })().catch((err) => { secretPromise = null; throw err; });
  }
  return secretPromise;
}

async function signAccess(payload) {
  const secret = await tokenSecret();
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ACCESS_TTL }));
  const sig = b64url(crypto.createHmac("sha256", secret).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}

async function verifyAccess(token) {
  const [head, body, sig] = String(token || "").split(".");
  if (!head || !body || !sig) return null;
  const expected = b64url(crypto.createHmac("sha256", await tokenSecret()).update(`${head}.${body}`).digest());
  if (!safeEqual(expected, sig)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.sub || (payload.exp && payload.exp < Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------------
 * Auth
 * ------------------------------------------------------------------------- */

function requireAppKey(req, res, next) {
  if (!KP_API_KEY) return next();
  if ((req.header("x-api-key") || "").trim() !== KP_API_KEY) {
    return fail(res, 401, "unauthorized_api_key", "Invalid or missing x-api-key.");
  }
  next();
}

function bearerToken(req) {
  const m = (req.header("authorization") || "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : (req.header("x-user-token") || "").trim() || null;
}

const USER_SELECT = `SELECT id, kc_id, kc_username, kc_name, kc_avatar, email, phone, created_at FROM users`;
function shapeUser(r) {
  if (!r) return null;
  return {
    id: r.id, kcId: r.kc_id, username: r.kc_username, name: r.kc_name, avatar: r.kc_avatar,
    email: r.email, phone: r.phone, createdAt: r.created_at,
  };
}
const getUserById = async (id) => shapeUser(await q1(`${USER_SELECT} WHERE id = $1`, [id]));

const requireUser = asyncHandler(async (req, res, next) => {
  const token = bearerToken(req);
  if (!token) return fail(res, 401, "no_token", "Sign in to continue.");
  const payload = await verifyAccess(token);
  if (!payload) return fail(res, 401, "invalid_token", "Your session has expired. Sign in again.");
  req.kpUserId = payload.sub;
  req.kpDeviceId = payload.dev || null;
  next();
});

const DEVICE_KINDS = new Set(["desktop", "phone", "web"]);

/** A device's tokens: the access token and a new refresh token (its hash stored). */
async function issue(userId, { deviceId, deviceName, deviceKind, userAgent }) {
  const user = await getUserById(userId);
  // The device's own id when it has one (and it is not another account's), else a new one.
  let device = isUuid(deviceId) ? deviceId : null;
  if (device && (await q1(`SELECT 1 FROM devices WHERE id = $1 AND user_id <> $2`, [device, userId]))) device = null;
  device = device || crypto.randomUUID();
  const kind = DEVICE_KINDS.has(deviceKind) ? deviceKind : "desktop";
  await q(
    `INSERT INTO devices (id, user_id, name, kind) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET last_seen = now(),
       name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE devices.name END`,
    [device, userId, clean(deviceName, 120), kind],
  );
  const refreshToken = crypto.randomBytes(32).toString("base64url");
  await q(
    `INSERT INTO refresh_tokens (token_hash, user_id, device_id, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5::int))`,
    [sha256(refreshToken), userId, device, clean(userAgent, 300) || null, REFRESH_DAYS],
  );
  const accessToken = await signAccess({ sub: userId, dev: device, name: user.name || user.username || "" });
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL, deviceId: device, user };
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
              email = COALESCE($6, email), phone = COALESCE($7, phone), updated_at = now(), last_login_at = now()
       WHERE id = $1`,
      [row.id, profile.kcId, username, profile.name, profile.avatar, profile.email, profile.phone],
    );
  } else {
    row = await q1(
      `INSERT INTO users (id, kc_id, kc_username, kc_name, kc_avatar, email, phone, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING id`,
      [crypto.randomUUID(), profile.kcId, username, profile.name, profile.avatar, profile.email, profile.phone],
    );
  }
  return row.id;
}

/** A KingsChat code (or access token) → a KingsPresenter user, or an error to send. */
async function kingsChatUser({ code, accessToken }) {
  if (!accessToken) {
    if (!KC_CLIENT_ID) return { error: [500, "kc_not_configured", "KingsChat sign-in is not set up on this server (KP_KC_CLIENT_ID)."] };
    const tokens = await exchangeKcCode(code);
    if (!tokens) return { error: [502, "kc_exchange_failed", "Could not exchange the KingsChat code."] };
    accessToken = tokens.accessToken;
  }
  const profile = await fetchKcProfile(accessToken);
  if (!profile) return { error: [502, "kc_profile_failed", "Could not read your KingsChat profile."] };
  if (!profile.kcId && !profile.username) return { error: [502, "kc_no_identity", "KingsChat did not return an identity."] };
  return { userId: await upsertKcUser(profile) };
}

// The page KingsChat sends a phone back to when the app uses this API as its redirect:
// it hands the app its tokens (inside the app's sign-in view) and says where to go.
function callbackPage(payload) {
  const data = JSON.stringify({ type: "kp-auth", ...payload }).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KingsPresenter</title><style>body{font-family:system-ui,sans-serif;background:#1c1d21;color:#f2f3f5;display:grid;place-items:center;min-height:100vh;margin:0}p{max-width:22rem;text-align:center;line-height:1.5}</style></head>
<body><p id="m">${payload.status ? "Signed in. Returning to KingsPresenter…" : "Sign-in did not work. Close this and try again."}</p>
<script>var d=${data};try{if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(d));else if(window.opener)window.opener.postMessage(d,"*");}catch(e){}</script></body></html>`;
}

/* ---------------------------------------------------------------------------
 * Routes
 * ------------------------------------------------------------------------- */

module.exports = function kingsPresenterRoutes() {
  const router = Router();
  fs.mkdirSync(MEDIA_DIR, { recursive: true });

  // Never cache an API response; the database is ready before any route runs.
  router.use("/kp", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  router.use("/kp", asyncHandler(async (_req, _res, next) => { await ensureSchema(); next(); }));
  const app = [requireAppKey];
  const user = [requireAppKey, requireUser];

  router.get("/kp/ping", asyncHandler(async (_req, res) => {
    const row = await q1(`SELECT count(*)::int AS users FROM users`);
    ok(res, { message: "kingspresenter api alive", users: row?.users ?? 0 });
  }));

  // What the apps need before anyone signs in: where to sign in, which relays to use.
  router.get("/kp/config", ...app, asyncHandler(async (_req, res) => {
    const relays = await q(`SELECT name, url, region FROM relays WHERE active ORDER BY id`);
    ok(res, {
      kingschat: { clientId: KC_CLIENT_ID, loginUrl: KC_LOGIN_URL, redirectUri: SITE_URL ? `${SITE_URL}/auth/kingschat/callback` : null },
      relays,
    });
  }));

  /* ---- auth ------------------------------------------------------------ */

  router.post("/kp/auth/kingschat", ...app, asyncHandler(async (req, res) => {
    const code = clean(req.body?.code || req.body?.authCode, 4096);
    const accessToken = clean(req.body?.accessToken, 4096);
    if (!code && !accessToken) return fail(res, 400, "missing_code", "Provide `code` from KingsChat, or an `accessToken`.");
    const kc = await kingsChatUser({ code, accessToken });
    if (kc.error) return fail(res, ...kc.error);
    const out = await issue(kc.userId, {
      deviceId: req.body?.deviceId, deviceName: req.body?.deviceName, deviceKind: req.body?.deviceKind, userAgent: req.get("user-agent"),
    });
    ok(res, out);
  }));

  // KingsChat's redirect, for an app that sends people back here (KingsChat posts the code,
  // or puts it in the address). No app key: KingsChat itself calls it.
  router.all("/kp/auth/kingschat/callback", asyncHandler(async (req, res) => {
    res.type("html");
    const code = clean(req.body?.code || req.body?.authCode || req.query.code || req.query.authCode, 4096);
    if (!code) return res.status(400).send(callbackPage({ status: false, error: "missing_code" }));
    const kc = await kingsChatUser({ code });
    if (kc.error) return res.status(kc.error[0]).send(callbackPage({ status: false, error: kc.error[1] }));
    const out = await issue(kc.userId, { deviceKind: clean(req.query.kind, 20) || "phone", deviceName: clean(req.query.device, 120), userAgent: req.get("user-agent") });
    res.send(callbackPage({ status: true, ...out }));
  }));

  // A new access token for a refresh token, which is used up and replaced.
  router.post("/kp/auth/refresh", ...app, asyncHandler(async (req, res) => {
    const hash = sha256(clean(req.body?.refreshToken, 512));
    const row = await q1(
      `DELETE FROM refresh_tokens WHERE token_hash = $1 AND expires_at > now() RETURNING user_id, device_id`, [hash]);
    if (!row) return fail(res, 401, "invalid_token", "Sign in again.");
    const out = await issue(row.user_id, { deviceId: row.device_id, deviceName: req.body?.deviceName, userAgent: req.get("user-agent") });
    ok(res, out);
  }));

  router.post("/kp/auth/logout", ...app, asyncHandler(async (req, res) => {
    await q(`DELETE FROM refresh_tokens WHERE token_hash = $1`, [sha256(clean(req.body?.refreshToken, 512))]);
    ok(res, { message: "signed out" });
  }));

  /* ---- account --------------------------------------------------------- */

  router.get("/kp/me", ...user, asyncHandler(async (req, res) => {
    const u = await getUserById(req.kpUserId);
    if (!u) return fail(res, 401, "invalid_token", "This account no longer exists.");
    if (req.kpDeviceId) await q(`UPDATE devices SET last_seen = now() WHERE id = $1 AND user_id = $2`, [req.kpDeviceId, u.id]);
    ok(res, { user: u });
  }));

  // The computers and phones signed in to this account; signing one out.
  router.get("/kp/devices", ...user, asyncHandler(async (req, res) => {
    const rows = await q(
      `SELECT d.id, d.name, d.kind, d.created_at, d.last_seen,
              EXISTS (SELECT 1 FROM refresh_tokens t WHERE t.device_id = d.id AND t.expires_at > now()) AS signed_in
       FROM devices d WHERE d.user_id = $1 ORDER BY d.last_seen DESC`, [req.kpUserId]);
    ok(res, { devices: rows.map((d) => ({ id: d.id, name: d.name, kind: d.kind, createdAt: d.created_at, lastSeen: d.last_seen, signedIn: d.signed_in, current: d.id === req.kpDeviceId })) });
  }));

  router.delete("/kp/devices/:id", ...user, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return fail(res, 400, "invalid_device", "No such device.");
    const gone = await q(`DELETE FROM devices WHERE id = $1 AND user_id = $2 RETURNING id`, [req.params.id, req.kpUserId]);
    if (!gone.length) return fail(res, 404, "not_found", "No such device.");
    ok(res, { deleted: true });
  }));

  // Deletes the account and everything in it (library, media records, devices).
  router.delete("/kp/account", ...user, asyncHandler(async (req, res) => {
    const media = await q(`SELECT storage_key FROM media_objects WHERE user_id = $1`, [req.kpUserId]);
    await q(`DELETE FROM users WHERE id = $1`, [req.kpUserId]);
    for (const m of media) {
      const still = await q1(`SELECT 1 FROM media_objects WHERE storage_key = $1`, [m.storage_key]);
      if (!still) await fsp.rm(path.join(MEDIA_DIR, m.storage_key), { force: true }).catch(() => {});
    }
    ok(res, { deleted: true });
  }));

  /* ---- library sync ---------------------------------------------------- */

  router.get("/kp/sync/pull", ...user, asyncHandler(async (req, res) => {
    const since = Number(req.query.since) || 0;
    const rows = await q(`SELECT * FROM documents WHERE user_id = $1 AND seq > $2 ORDER BY seq LIMIT 500`, [req.kpUserId, since]);
    ok(res, {
      changes: rows.map((r) => ({ kind: r.kind, id: r.id, rev: r.rev, updatedAt: r.updated_at.toISOString(), deletedAt: r.deleted_at ? r.deleted_at.toISOString() : null, doc: r.json })),
      cursor: rows.length ? Number(rows[rows.length - 1].seq) : since,
      more: rows.length === 500,
    });
  }));

  // Last writer wins, by the document's updatedAt.
  router.post("/kp/sync/push", ...user, asyncHandler(async (req, res) => {
    const docs = Array.isArray(req.body?.docs) ? req.body.docs.slice(0, 500) : [];
    const accepted = [];
    const rejected = [];
    let cursor = 0;
    for (const d of docs) {
      if (!KINDS.has(d?.kind) || !d.id || !d.doc || typeof d.doc !== "object") continue;
      const id = clean(d.id, 200);
      const current = await q1(`SELECT rev, json, updated_at FROM documents WHERE user_id = $1 AND kind = $2 AND id = $3`, [req.kpUserId, d.kind, id]);
      const incomingAt = new Date(d.doc.updatedAt || d.updatedAt || Date.now());
      if (Number.isNaN(incomingAt.getTime())) continue;
      if (current && current.updated_at > incomingAt) { rejected.push({ kind: d.kind, id, current: current.json }); continue; }
      const rev = Math.max(Number(d.doc.rev) || 1, (current?.rev || 0) + 1);
      const row = await q1(
        `INSERT INTO documents (user_id, kind, id, rev, json, updated_at, deleted_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, kind, id) DO UPDATE SET rev = excluded.rev, json = excluded.json, updated_at = excluded.updated_at,
           deleted_at = excluded.deleted_at, seq = nextval('documents_seq_seq')
         RETURNING seq`,
        [req.kpUserId, d.kind, id, rev, { ...d.doc, rev }, incomingAt, d.doc.deletedAt ? new Date(d.doc.deletedAt) : null],
      );
      cursor = Number(row.seq);
      accepted.push({ kind: d.kind, id, rev });
    }
    ok(res, { accepted, rejected, cursor });
  }));

  /* ---- media ----------------------------------------------------------- */

  const shaOf = (req) => String(req.params.sha || "").toLowerCase();
  router.head("/kp/media/:sha", ...user, asyncHandler(async (req, res) => {
    const m = await q1(`SELECT 1 FROM media_objects WHERE user_id = $1 AND sha256 = $2`, [req.kpUserId, shaOf(req)]);
    res.status(m ? 200 : 404).end();
  }));

  router.put("/kp/media/:sha", ...user, express.raw({ type: () => true, limit: MAX_MEDIA }), asyncHandler(async (req, res) => {
    const sha = shaOf(req);
    if (!/^[a-f0-9]{64}$/.test(sha)) return fail(res, 400, "bad_hash", "The address must be the file's sha256.");
    if (!Buffer.isBuffer(req.body) || !req.body.length) return fail(res, 400, "empty_upload", "The upload was empty.");
    if (crypto.createHash("sha256").update(req.body).digest("hex") !== sha) return fail(res, 400, "hash_mismatch", "The file does not match its hash.");
    const storageKey = `${sha.slice(0, 2)}/${sha}`;
    await fsp.mkdir(path.join(MEDIA_DIR, sha.slice(0, 2)), { recursive: true });
    await fsp.writeFile(path.join(MEDIA_DIR, storageKey), req.body);
    await q(`INSERT INTO media_objects (user_id, sha256, storage_key, bytes, mime) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [req.kpUserId, sha, storageKey, req.body.length, clean(req.get("content-type"), 120)]);
    res.status(201);
    ok(res, { sha256: sha, bytes: req.body.length });
  }));

  router.get("/kp/media/:sha", ...user, asyncHandler(async (req, res) => {
    const m = await q1(`SELECT storage_key, mime FROM media_objects WHERE user_id = $1 AND sha256 = $2`, [req.kpUserId, shaOf(req)]);
    if (!m) return fail(res, 404, "not_found", "No such file.");
    res.type(m.mime || "application/octet-stream");
    fs.createReadStream(path.join(MEDIA_DIR, m.storage_key)).on("error", () => res.status(404).end()).pipe(res);
  }));

  /* ---- Remote: relays and sessions ------------------------------------ */

  router.get("/kp/relays", ...app, asyncHandler(async (_req, res) => {
    ok(res, { relays: await q(`SELECT name, url, region FROM relays WHERE active ORDER BY id`) });
  }));

  // A relay reports what happens on it: a church computer's session opening or closing,
  // phones joining and leaving. Only relays with KP_RELAY_KEY may.
  router.post("/kp/relay/events", asyncHandler(async (req, res) => {
    if (!RELAY_KEY || !safeEqual(sha256(clean(req.header("x-relay-key"), 512)), sha256(RELAY_KEY))) {
      return fail(res, 401, "unauthorized_relay", "Invalid or missing x-relay-key.");
    }
    const url = clean(req.body?.relay, 300);
    let relayId = null;
    if (/^wss?:\/\//.test(url)) {
      const r = await q1(
        `INSERT INTO relays (name, url) VALUES ($1, $2)
         ON CONFLICT (url) DO UPDATE SET last_seen_at = now(), updated_at = now() RETURNING id`,
        [clean(req.body?.name, 80) || "KingsPresenter", url]);
      relayId = r.id;
    }
    const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 200) : [];
    for (const e of events) {
      const sid = clean(e?.sessionId, 64);
      if (!sid) continue;
      const owner = isUuid(e.userId) ? e.userId : null;
      switch (e.t) {
        case "opened":
          await q(
            `INSERT INTO remote_sessions (id, relay_id, user_id, name) VALUES ($1, $2, (SELECT id FROM users WHERE id = $3), $4)
             ON CONFLICT (id) DO UPDATE SET last_seen_at = now(), closed_at = NULL, close_reason = NULL, name = excluded.name`,
            [sid, relayId, owner, clean(e.name, 80)]);
          break;
        case "closed":
          await q(`UPDATE remote_sessions SET closed_at = now(), close_reason = $2, last_seen_at = now() WHERE id = $1`, [sid, clean(e.reason, 120) || null]);
          await q(`UPDATE remote_joins SET left_at = now() WHERE session_id = $1 AND left_at IS NULL`, [sid]);
          break;
        case "join":
          await q(
            `INSERT INTO remote_joins (session_id, remote_id, user_id, name, mode, via)
             SELECT $1, $2, (SELECT id FROM users WHERE id = $3), $4, $5, $6 WHERE EXISTS (SELECT 1 FROM remote_sessions WHERE id = $1)`,
            [sid, clean(e.remoteId, 64), owner, clean(e.phone, 60), clean(e.mode, 20), clean(e.via, 20)]);
          break;
        case "leave":
          await q(`UPDATE remote_joins SET left_at = now() WHERE session_id = $1 AND remote_id = $2 AND left_at IS NULL`, [sid, clean(e.remoteId, 64)]);
          break;
        default: break;
      }
    }
    ok(res, { received: events.length });
  }));

  // This account's church computers' Remote sessions, newest first, with the phones that joined.
  router.get("/kp/remote/sessions", ...user, asyncHandler(async (req, res) => {
    const rows = await q(
      `SELECT s.id, s.name, s.opened_at, s.closed_at, s.close_reason, r.url AS relay_url,
              (SELECT count(*)::int FROM remote_joins j WHERE j.session_id = s.id) AS joins
       FROM remote_sessions s LEFT JOIN relays r ON r.id = s.relay_id
       WHERE s.user_id = $1 ORDER BY s.opened_at DESC LIMIT 100`, [req.kpUserId]);
    ok(res, { sessions: rows.map((s) => ({ id: s.id, name: s.name, openedAt: s.opened_at, closedAt: s.closed_at, closeReason: s.close_reason, relay: s.relay_url, joins: s.joins })) });
  }));

  return router;
};

// For scripts/kp-migrate.js and tests: making the database, and the pool (to close it).
module.exports.ensureSchema = ensureSchema;
module.exports.dbConfigFrom = dbConfigFrom;
module.exports.pool = pool;
