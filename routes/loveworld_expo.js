// routes/loveworld_expo.js
// LoveWorld Expo (loveworldexpo.com): the account and booking service behind the Expo website.
//
// Model (database `loveworld_expo`, Postgres, made with its tables on first use)
//   users               KingsChat identity, plus what the person tells the Expo about themselves;
//                       exhibitor_id when the admin has made the account part of an exhibitor's team
//   refresh_tokens      one per signed-in browser (hashed; used once, then replaced)
//   exhibitors          who is on the show floor, and whether they take SmartMeet bookings
//   bookings            SmartMeet one-on-one meetings (a person, an exhibitor, a slot)
//   registrations       "register interest" / attend-the-Expo forms
//   sponsor_enquiries   the sponsor page's enquiry form
//   program_applications  Eagles Nest, Qubators and Content Creative applications
//   settings            this service's own values (the token signing key when none is set)
//
// Auth: POST /expo/auth/kingschat exchanges a KingsChat accessToken (or authCode) for an
// access token (HS256 JWT, 1 h) and a refresh token. Signed-in calls send
// `Authorization: Bearer <accessToken>`, plus `x-api-key` when EXPO_API_KEY is set.
// Admin calls (/expo/admin/*) send `x-admin-key: EXPO_ADMIN_KEY`.
// An account on an exhibitor's team (users.exhibitor_id, set by the admin) runs that exhibitor
// at /expo/exhibitor: its overview, its details and its bookings.
//
// Same shape as routes/kingspresenter.js, so the two read alike.

const { Router } = require("express");
const { Pool, Client } = require("pg");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const ENV_FILE = path.join(__dirname, "..", ".env");
if (!process.env.EXPO_SKIP_ENV_FILE) {
  try { require("dotenv").config({ path: ENV_FILE, quiet: true }); } catch { /* the environment only */ }
}

/* ---------------------------------------------------------------------------
 * ENV
 * ------------------------------------------------------------------------- */

const env = (...names) => names.map((n) => process.env[n]).find((v) => v != null && v !== "");

// Unset: no app key is asked for.
const API_KEY = env("EXPO_API_KEY") || "";
// The Expo website's KingsChat client (its registration's redirect is the site's /auth/kingschat/callback).
const KC_CLIENT_ID = env("EXPO_KC_CLIENT_ID") || "630166b6-6431-4239-8036-c40b1b0f2652";
const KC_CLIENT_SECRET = env("EXPO_KC_CLIENT_SECRET") || "";
// The api-key of the KingsChat project the client belongs to, sent when reading a profile
// (KingsChat asks for it on some projects; without one the profile is read with the token alone).
// KINGSCHAT_API_KEY is the name the Expo website uses for the same value.
const KC_API_KEY = env("EXPO_KC_API_KEY", "KINGSCHAT_API_KEY") || "";
const KC_TOKEN_URL = env("EXPO_KC_TOKEN_URL") || "https://connect.kingsch.at/developer/api/oauth2/token";
const KC_PROFILE_URL = env("EXPO_KC_PROFILE_URL") || "https://connect.kingsch.at/developer/api/user/profile";
const KC_LOGIN_URL = "https://accounts.kingschat.online/log-in";
const SITE_URL = (env("EXPO_SITE_URL") || "").replace(/\/+$/, "");

const ACCESS_TTL = Number(env("EXPO_ACCESS_TTL_SECONDS") || 3600);
const REFRESH_DAYS = Number(env("EXPO_REFRESH_DAYS") || 90);
const adminKey = () => env("EXPO_ADMIN_KEY") || "";

// The event: its days (inclusive, YYYY-MM-DD), the zone its clock runs in, and SmartMeet's hours.
const EVENT = {
  start: env("EXPO_START_DATE") || "2026-11-09",
  end: env("EXPO_END_DATE") || "2026-11-15",
  offset: env("EXPO_UTC_OFFSET") || "+01:00",
  meetingMinutes: Number(env("EXPO_MEETING_MINUTES") || 20),
  dayStart: Number(env("EXPO_DAY_START_HOUR") || 10),
  dayEnd: Number(env("EXPO_DAY_END_HOUR") || 17),
  lunchHour: Number(env("EXPO_LUNCH_HOUR") ?? 13),
  // One person may hold this many confirmed meetings a day (0: no limit).
  maxBookingsPerDay: Number(env("EXPO_MAX_BOOKINGS_PER_DAY") || 6),
};

/* ---------------------------------------------------------------------------
 * DB
 * ------------------------------------------------------------------------- */

const DB_NAME = env("EXPO_DB_NAME") || "loveworld_expo";

/**
 * Where the database is: LOVEWORLD_EXPO_DATABASE_URL / EXPO_DATABASE_URL, else the Postgres
 * server KingsPresenter or NMM reporting use (their URL with the database `loveworld_expo`), else
 * the EXPO_DB_* / KP_DB_* / NMM_DB_* / PCO_FN_DB_* fields.
 */
function dbConfigFrom(e) {
  const pick = (...names) => names.map((n) => e[n]).find((v) => v != null && v !== "");
  const own = pick("LOVEWORLD_EXPO_DATABASE_URL", "EXPO_DATABASE_URL");
  if (own) return { connectionString: own };
  const shared = pick("KINGSPRESENTER_DATABASE_URL", "KP_DATABASE_URL", "NMM_DATABASE_URL");
  if (shared) {
    const u = new URL(shared);
    u.pathname = `/${pick("EXPO_DB_NAME") || DB_NAME}`;
    return { connectionString: u.toString() };
  }
  return {
    user: pick("EXPO_DB_USER", "KP_DB_USER", "NMM_DB_USER", "PCO_FN_DB_USER") || "postgres",
    host: pick("EXPO_DB_HOST", "KP_DB_HOST", "NMM_DB_HOST", "PCO_FN_DB_HOST"),
    database: pick("EXPO_DB_NAME") || DB_NAME,
    password: pick("EXPO_DB_PASSWORD", "KP_DB_PASSWORD", "NMM_DB_PASSWORD", "PCO_FN_DB_PASSWORD"),
    port: Number(pick("EXPO_DB_PORT", "KP_DB_PORT", "NMM_DB_PORT", "PCO_FN_DB_PORT") || 5432),
  };
}
const poolConfig = dbConfigFrom(process.env);
const DB_MISSING = !poolConfig.connectionString && typeof poolConfig.password !== "string"
  ? "The LoveWorld Expo database is not set up on this server: add LOVEWORLD_EXPO_DATABASE_URL to its .env (postgres://user:password@host:5432/loveworld_expo)."
  : "";
if (DB_MISSING) {
  const found = fs.existsSync(ENV_FILE) ? "it is there, without LOVEWORLD_EXPO_DATABASE_URL" : "there is no such file";
  console.error(`[expo] ${DB_MISSING} Looked in ${ENV_FILE}: ${found}.`);
}
const pool = new Pool({ ...poolConfig, max: Number(env("EXPO_DB_POOL_SIZE") || 10) });
pool.on("error", (err) => console.error("[expo] idle pg client error:", err.message));

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
    organisation TEXT,
    role TEXT,
    country TEXT,
    zone TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ,
    disabled_at TIMESTAMPTZ,
    disabled_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS users_kc_username ON users (lower(kc_username));

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT,
    user_agent TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS refresh_tokens_user ON refresh_tokens (user_id);

  CREATE TABLE IF NOT EXISTS exhibitors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    zone TEXT NOT NULL DEFAULT '',
    stand TEXT NOT NULL DEFAULT '',
    tagline TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    smartmeet BOOLEAN NOT NULL DEFAULT false,
    featured BOOLEAN NOT NULL DEFAULT false,
    meeting_topics JSONB NOT NULL DEFAULT '[]',
    availability JSONB NOT NULL DEFAULT '{}',
    logo TEXT,
    website TEXT,
    sort INTEGER NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id UUID PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exhibitor_id TEXT NOT NULL REFERENCES exhibitors(id) ON DELETE CASCADE,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    organisation TEXT NOT NULL DEFAULT '',
    topic TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'confirmed',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    cancelled_at TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX IF NOT EXISTS bookings_slot ON bookings (exhibitor_id, starts_at) WHERE status = 'confirmed';
  CREATE INDEX IF NOT EXISTS bookings_user ON bookings (user_id, starts_at);

  CREATE TABLE IF NOT EXISTS registrations (
    id UUID PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    organisation TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    zone TEXT NOT NULL DEFAULT '',
    interests JSONB NOT NULL DEFAULT '[]',
    pass TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS registrations_email ON registrations (lower(email));

  CREATE TABLE IF NOT EXISTS sponsor_enquiries (
    id UUID PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    organisation TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '',
    interest TEXT NOT NULL DEFAULT '',
    programs TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS program_applications (
    id UUID PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    program TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    organisation TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    data JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'submitted',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS program_applications_program ON program_applications (program, created_at DESC);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- Added after the first release: the exhibitor an account runs (its team), set by the admin.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS exhibitor_id TEXT REFERENCES exhibitors(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS users_exhibitor ON users (exhibitor_id);
`;

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
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("LoveWorld Expo database name must be lowercase letters, digits and _");
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
        if (err.code !== "3D000") throw err; // no such database
        await createDatabase();
      }
      await pool.query(SCHEMA);
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
const isEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v || ""));
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const reference = (prefix) => `${prefix}-${crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6)}`;
const slug = (v) => clean(v, 80).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const list = (v) => (Array.isArray(v) ? v.map((x) => clean(x, 120)).filter(Boolean).slice(0, 40) : []);

/* ---------------------------------------------------------------------------
 * The event's days and SmartMeet slots
 * ------------------------------------------------------------------------- */

/** Every day of the Expo, YYYY-MM-DD. */
function eventDays() {
  const days = [];
  const d = new Date(`${EVENT.start}T00:00:00Z`);
  const end = new Date(`${EVENT.end}T00:00:00Z`);
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
  return days;
}
const isEventDay = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && eventDays().includes(date);

/** A wall-clock time on the event's clock ("2026-11-10T11:00:00") as a Date. */
const atEvent = (local) => new Date(`${local}${EVENT.offset}`);
/** A Date as the event's wall-clock time ("2026-11-10T11:00:00"). */
function localTime(date) {
  const sign = EVENT.offset.startsWith("-") ? -1 : 1;
  const [h, m] = EVENT.offset.slice(1).split(":").map(Number);
  return new Date(date.getTime() + sign * (h * 60 + m) * 60000).toISOString().slice(0, 19);
}
const hhmm = (n) => String(n).padStart(2, "0");

/** The slots an exhibitor could take on a day (before bookings), from its availability or the defaults. */
function slotsFor(exhibitor, date) {
  const a = exhibitor?.availability && typeof exhibitor.availability === "object" ? exhibitor.availability : {};
  if (Array.isArray(a.closedDates) && a.closedDates.includes(date)) return [];
  const minutes = Number(a.slotMinutes) || EVENT.meetingMinutes;
  const dayStart = Number.isFinite(Number(a.dayStart)) ? Number(a.dayStart) : EVENT.dayStart;
  const dayEnd = Number.isFinite(Number(a.dayEnd)) ? Number(a.dayEnd) : EVENT.dayEnd;
  const blocked = new Set(Array.isArray(a.blocked) ? a.blocked : []);
  const out = [];
  for (let t = dayStart * 60; t + minutes <= dayEnd * 60; t += minutes) {
    const h = Math.floor(t / 60);
    if (h === EVENT.lunchHour) continue;
    const start = `${date}T${hhmm(h)}:${hhmm(t % 60)}:00`;
    const e = t + minutes;
    const end = `${date}T${hhmm(Math.floor(e / 60))}:${hhmm(e % 60)}:00`;
    out.push({ start, end, available: !blocked.has(start) });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Tokens
 * ------------------------------------------------------------------------- */

let secretPromise = null;
function tokenSecret() {
  if (env("EXPO_TOKEN_SECRET")) return Promise.resolve(env("EXPO_TOKEN_SECRET"));
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
 * Users and auth
 * ------------------------------------------------------------------------- */

function requireAppKey(req, res, next) {
  if (!API_KEY) return next();
  if ((req.header("x-api-key") || "").trim() !== API_KEY) return fail(res, 401, "unauthorized_api_key", "Invalid or missing x-api-key.");
  next();
}

function bearerToken(req) {
  const m = (req.header("authorization") || "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : (req.header("x-user-token") || "").trim() || null;
}

const USER_SELECT = `SELECT id, kc_id, kc_username, kc_name, kc_avatar, email, phone, organisation, role, country, zone, exhibitor_id, created_at, last_login_at FROM users`;
function shapeUser(r) {
  if (!r) return null;
  return {
    id: r.id, kcId: r.kc_id, username: r.kc_username, name: r.kc_name, avatar: r.kc_avatar,
    email: r.email, phone: r.phone, organisation: r.organisation, role: r.role, country: r.country, zone: r.zone,
    exhibitorId: r.exhibitor_id || null, createdAt: r.created_at, lastLoginAt: r.last_login_at,
  };
}
const getUserById = async (id) => shapeUser(await q1(`${USER_SELECT} WHERE id = $1`, [id]));
/** The exhibitor an account runs, as the site shows it next to the person: `{ id, name, stand, smartMeet }`, or null. */
async function exhibitorOf(userId) {
  const r = await q1(`SELECT e.id, e.name, e.stand, e.smartmeet FROM users u JOIN exhibitors e ON e.id = u.exhibitor_id WHERE u.id = $1`, [userId]);
  return r ? { id: r.id, name: r.name, stand: r.stand, smartMeet: r.smartmeet } : null;
}

/** The signed-in person on req.expoUserId, or 401. */
const requireUser = asyncHandler(async (req, res, next) => {
  const token = bearerToken(req);
  if (!token) return fail(res, 401, "no_token", "Sign in with KingsChat to continue.");
  const payload = await verifyAccess(token);
  if (!payload) return fail(res, 401, "invalid_token", "Your session has expired. Sign in again.");
  const account = await q1(`SELECT disabled_at, disabled_reason FROM users WHERE id = $1`, [payload.sub]);
  if (!account) return fail(res, 401, "account_deleted", "This account no longer exists. Sign in again.");
  if (account.disabled_at) return fail(res, 403, "account_disabled", account.disabled_reason || "This account has been disabled.");
  req.expoUserId = payload.sub;
  req.expoDeviceId = payload.dev || null;
  next();
});

/** The signed-in person when there is one (a bad token is simply nobody). */
const optionalUser = asyncHandler(async (req, _res, next) => {
  const token = bearerToken(req);
  const payload = token ? await verifyAccess(token) : null;
  req.expoUserId = payload?.sub && (await q1(`SELECT 1 FROM users WHERE id = $1 AND disabled_at IS NULL`, [payload.sub])) ? payload.sub : null;
  next();
});

/** After requireUser: the exhibitor the signed-in account runs on req.expoExhibitor (a database row), or 403. */
const requireExhibitor = asyncHandler(async (req, res, next) => {
  const row = await q1(`${EXHIBITOR_SELECT} WHERE id = (SELECT exhibitor_id FROM users WHERE id = $1)`, [req.expoUserId]);
  if (!row) return fail(res, 403, "not_exhibitor", "This account is not on an exhibitor's team. Ask the Expo team to add it to one.");
  req.expoExhibitor = row;
  next();
});

function requireAdmin(req, res, next) {
  const key = adminKey();
  if (!key) return fail(res, 503, "admin_off", "EXPO_ADMIN_KEY is not set on this server.");
  const given = (req.header("x-admin-key") || "").trim();
  if (!given || !safeEqual(given, key)) return fail(res, 401, "unauthorized_admin_key", "Invalid or missing x-admin-key.");
  next();
}

async function issue(userId, { deviceId, userAgent }) {
  const off = await q1(`SELECT disabled_reason FROM users WHERE id = $1 AND disabled_at IS NOT NULL`, [userId]);
  if (off) throw Object.assign(new Error(off.disabled_reason || "This account has been disabled."), { statusCode: 403, code: "account_disabled" });
  const user = await getUserById(userId);
  const device = clean(deviceId, 120) || crypto.randomUUID();
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
    body: JSON.stringify({ grant_type: "code", client_id: KC_CLIENT_ID, code, ...(KC_CLIENT_SECRET ? { client_secret: KC_CLIENT_SECRET } : {}) }),
  }).catch(() => null);
  if (!resp || !resp.ok) return null;
  const json = await resp.json().catch(() => null);
  const accessToken = json?.access_token ?? json?.accessToken ?? null;
  return accessToken ? { accessToken } : null;
}

/** The person's KingsChat profile, read as KingsPresenter reads it (every field name KingsChat has used). */
async function fetchKcProfile(accessToken) {
  const headers = { Accept: "application/json", Authorization: `Bearer ${accessToken}`, ...(KC_API_KEY ? { "api-key": KC_API_KEY } : {}) };
  const resp = await fetch(KC_PROFILE_URL, { headers }).catch((err) => { console.error(`[expo] KingsChat profile: no answer: ${err.message}`); return null; });
  if (!resp) return null;
  const json = await resp.json().catch(() => null);
  const p = json?.profile ?? json?.user ?? (json && typeof json === "object" && (json.username || json.kcID || json.id) ? json : null);
  if (!resp.ok || !p) {
    console.error(`[expo] KingsChat profile refused: ${resp.status} ${json?.error || ""} ${json?.message || ""}`.replace(/\s+/g, " ").trim());
    return null;
  }
  const u = p.user && typeof p.user === "object" ? p.user : p;
  const pick = (...keys) => { for (const k of keys) { const v = p[k] ?? u[k]; if (v != null && v !== "") return v; } return null; };
  const kcIds = [...new Set([p.kcID, u.kcID, p.id, u.id, p.userID, u.userID].filter((v) => v != null && v !== "").map(String))];
  const username = pick("username");
  const phone = pick("phoneNumber", "phone_number", "phone");
  return {
    kcId: kcIds[0] || null,
    kcIds,
    username: username ? String(username).replace(/^@/, "") : null,
    name: pick("name") || [pick("firstName"), pick("lastName")].filter(Boolean).join(" ") || null,
    email: pick("emailAddress", "email"),
    phone: phone ? String(phone) : null,
    avatar: pick("profilePicture", "avatar", "displayPicture", "avatarUrl", "avatar_url", "picture"),
  };
}

async function upsertKcUser(profile) {
  const username = profile.username || null;
  const ids = profile.kcIds?.length ? profile.kcIds : profile.kcId ? [profile.kcId] : [];
  let row =
    (ids.length ? await q1(`SELECT id FROM users WHERE kc_id = ANY($1::text[]) ORDER BY (kc_id = $2) DESC, created_at ASC LIMIT 1`, [ids, profile.kcId]) : null) ||
    (username ? await q1(`SELECT id FROM users WHERE kc_id IS NULL AND lower(kc_username) = lower($1)`, [username]) : null);
  if (row) {
    await q(
      `UPDATE users SET kc_id = COALESCE($2, kc_id), kc_username = COALESCE($3, kc_username), kc_name = COALESCE($4, kc_name),
              kc_avatar = COALESCE($5, kc_avatar), email = COALESCE(email, $6), phone = COALESCE(phone, $7), updated_at = now(), last_login_at = now()
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

async function kingsChatUser({ code, accessToken }) {
  if (!accessToken) {
    if (!KC_CLIENT_ID) return { error: [500, "kc_not_configured", "KingsChat sign-in is not set up on this server (EXPO_KC_CLIENT_ID)."] };
    const tokens = await exchangeKcCode(code);
    if (!tokens) return { error: [502, "kc_exchange_failed", "Could not exchange the KingsChat code."] };
    accessToken = tokens.accessToken;
  }
  const profile = await fetchKcProfile(accessToken);
  if (!profile) return { error: [502, "kc_profile_failed", "Could not read your KingsChat profile."] };
  if (!profile.kcId && !profile.username) return { error: [502, "kc_no_identity", "KingsChat did not return an identity."] };
  return { userId: await upsertKcUser(profile) };
}

/* ---------------------------------------------------------------------------
 * Shapes
 * ------------------------------------------------------------------------- */

const EXHIBITOR_SELECT = `SELECT id, name, category, zone, stand, tagline, description, smartmeet, featured, meeting_topics, availability, logo, website, sort, active FROM exhibitors`;
const shapeExhibitor = (r, { admin = false } = {}) => r && ({
  id: r.id, name: r.name, category: r.category, zone: r.zone, stand: r.stand, tagline: r.tagline, description: r.description,
  smartMeet: r.smartmeet, featured: r.featured, meetingTopics: r.meeting_topics || [], logo: r.logo, website: r.website,
  ...(admin ? { availability: r.availability || {}, sort: r.sort, active: r.active, ...(r.team !== undefined ? { team: r.team } : {}) } : {}),
});
/** The members of an exhibitor's team, as shown to each other and to the admin. */
const TEAM_SELECT = `SELECT id, kc_username, kc_name, kc_avatar, email FROM users WHERE exhibitor_id = $1 AND disabled_at IS NULL ORDER BY kc_name, kc_username`;
const shapeMember = (r) => ({ id: r.id, username: r.kc_username, name: r.kc_name, avatar: r.kc_avatar, email: r.email });

/** The fields an exhibitor's own team may change: how the stand reads, and SmartMeet. The rest (name, stand, zone, flags, order) is the admin's. */
const EXHIBITOR_OWN_FIELDS = ["tagline", "description", "meeting_topics", "availability", "logo", "website", "smartmeet"];

const BOOKING_SELECT = `SELECT b.id, b.reference, b.user_id, b.exhibitor_id, e.name AS exhibitor_name, e.stand, b.starts_at, b.ends_at, b.name, b.email, b.organisation, b.topic, b.notes, b.location, b.status, b.created_at, b.cancelled_at
  FROM bookings b JOIN exhibitors e ON e.id = b.exhibitor_id`;
const shapeBooking = (r) => r && ({
  id: r.id, reference: r.reference, exhibitorId: r.exhibitor_id, exhibitor: { id: r.exhibitor_id, name: r.exhibitor_name, stand: r.stand },
  start: localTime(r.starts_at), end: localTime(r.ends_at), startsAt: r.starts_at, endsAt: r.ends_at,
  name: r.name, email: r.email, organisation: r.organisation, topic: r.topic, notes: r.notes, location: r.location,
  status: r.status, createdAt: r.created_at, cancelledAt: r.cancelled_at, ...(r.user_id ? { userId: r.user_id } : {}),
});

/** Exhibitor fields from a request body (admin create/update, import). */
function exhibitorFields(body, { forInsert = false } = {}) {
  const f = {};
  const set = (k, v) => { if (v !== undefined) f[k] = v; };
  set("name", body.name !== undefined ? clean(body.name, 200) : undefined);
  set("category", body.category !== undefined ? clean(body.category, 60) : undefined);
  set("zone", body.zone !== undefined ? clean(body.zone, 60) : undefined);
  set("stand", body.stand !== undefined ? clean(body.stand, 20) : undefined);
  set("tagline", body.tagline !== undefined ? clean(body.tagline, 200) : undefined);
  set("description", body.description !== undefined ? clean(body.description, 4000) : undefined);
  set("smartmeet", body.smartMeet !== undefined ? !!body.smartMeet : body.smartmeet !== undefined ? !!body.smartmeet : undefined);
  set("featured", body.featured !== undefined ? !!body.featured : undefined);
  set("meeting_topics", body.meetingTopics !== undefined ? JSON.stringify(list(body.meetingTopics)) : undefined);
  set("availability", body.availability !== undefined ? JSON.stringify(body.availability && typeof body.availability === "object" ? body.availability : {}) : undefined);
  set("logo", body.logo !== undefined ? clean(body.logo, 500) || null : undefined);
  set("website", body.website !== undefined ? clean(body.website, 500) || null : undefined);
  set("sort", body.sort !== undefined ? Number(body.sort) || 0 : undefined);
  set("active", body.active !== undefined ? !!body.active : undefined);
  if (forInsert && !f.name) return null;
  return f;
}

const EXHIBITOR_RETURNING = `RETURNING id, name, category, zone, stand, tagline, description, smartmeet, featured, meeting_topics, availability, logo, website, sort, active`;
/** An exhibitor made (every field given) or, when its id exists, changed (only the fields given). */
async function upsertExhibitor(id, f) {
  const cols = Object.keys(f);
  const vals = cols.map((c) => f[c]);
  const exists = await q1(`SELECT 1 FROM exhibitors WHERE id = $1`, [id]);
  if (exists) {
    if (!cols.length) return q1(`${EXHIBITOR_SELECT} WHERE id = $1`, [id]);
    return q1(`UPDATE exhibitors SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1 ${EXHIBITOR_RETURNING}`, [id, ...vals]);
  }
  if (!f.name) throw Object.assign(new Error("An exhibitor needs a name."), { statusCode: 400 });
  return q1(`INSERT INTO exhibitors (id, ${cols.join(", ")}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")}) ${EXHIBITOR_RETURNING}`, [id, ...vals]);
}

/* ---------------------------------------------------------------------------
 * Routes
 * ------------------------------------------------------------------------- */

module.exports = function loveworldExpoRoutes() {
  const router = Router();

  router.use("/expo", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  router.use("/expo", asyncHandler(async (_req, _res, next) => { await ensureSchema(); next(); }));
  const app = [requireAppKey];
  const user = [requireAppKey, requireUser];
  const maybeUser = [requireAppKey, optionalUser];
  const exhibitorUser = [requireAppKey, requireUser, requireExhibitor];

  router.get("/expo/ping", asyncHandler(async (_req, res) => {
    const row = await q1(`SELECT (SELECT count(*)::int FROM users) AS users, (SELECT count(*)::int FROM exhibitors WHERE active) AS exhibitors`);
    ok(res, { message: "loveworld expo api alive", users: row?.users ?? 0, exhibitors: row?.exhibitors ?? 0 });
  }));

  router.get("/expo/config", ...app, (_req, res) => {
    ok(res, {
      kingschat: { clientId: KC_CLIENT_ID, loginUrl: KC_LOGIN_URL, redirectUri: SITE_URL ? `${SITE_URL}/auth/kingschat/callback` : null },
      event: { start: EVENT.start, end: EVENT.end, days: eventDays(), utcOffset: EVENT.offset, meetingMinutes: EVENT.meetingMinutes, dayStart: EVENT.dayStart, dayEnd: EVENT.dayEnd, lunchHour: EVENT.lunchHour, maxBookingsPerDay: EVENT.maxBookingsPerDay },
    });
  });

  /* ---- auth ------------------------------------------------------------ */

  const refused = (res, err) => { if (err?.code !== "account_disabled") throw err; return fail(res, 403, err.code, err.message); };

  router.post("/expo/auth/kingschat", ...app, asyncHandler(async (req, res) => {
    const code = clean(req.body?.code || req.body?.authCode, 4096);
    const accessToken = clean(req.body?.accessToken, 4096);
    if (!code && !accessToken) return fail(res, 400, "missing_code", "Provide `code` from KingsChat, or an `accessToken`.");
    const kc = await kingsChatUser({ code, accessToken });
    if (kc.error) return fail(res, ...kc.error);
    let out;
    try { out = await issue(kc.userId, { deviceId: req.body?.deviceId, userAgent: req.get("user-agent") }); } catch (err) { return refused(res, err); }
    ok(res, out);
  }));

  router.post("/expo/auth/refresh", ...app, asyncHandler(async (req, res) => {
    const hash = sha256(clean(req.body?.refreshToken, 512));
    const row = await q1(`DELETE FROM refresh_tokens WHERE token_hash = $1 AND expires_at > now() RETURNING user_id, device_id`, [hash]);
    if (!row) return fail(res, 401, "invalid_token", "Sign in again.");
    let out;
    try { out = await issue(row.user_id, { deviceId: row.device_id, userAgent: req.get("user-agent") }); } catch (err) { return refused(res, err); }
    ok(res, out);
  }));

  router.post("/expo/auth/logout", ...app, asyncHandler(async (req, res) => {
    await q(`DELETE FROM refresh_tokens WHERE token_hash = $1`, [sha256(clean(req.body?.refreshToken, 512))]);
    ok(res, { message: "signed out" });
  }));

  /* ---- account --------------------------------------------------------- */

  router.get("/expo/me", ...user, asyncHandler(async (req, res) => {
    const u = await getUserById(req.expoUserId);
    if (!u) return fail(res, 401, "invalid_token", "This account no longer exists.");
    const counts = await q1(
      `SELECT (SELECT count(*)::int FROM bookings WHERE user_id = $1 AND status = 'confirmed') AS bookings,
              (SELECT count(*)::int FROM registrations WHERE user_id = $1) AS registrations,
              (SELECT count(*)::int FROM program_applications WHERE user_id = $1) AS applications`, [u.id]);
    ok(res, { user: u, counts, exhibitor: await exhibitorOf(u.id) });
  }));

  router.patch("/expo/me", ...user, asyncHandler(async (req, res) => {
    const b = req.body || {};
    const email = b.email !== undefined ? clean(b.email, 200) : undefined;
    if (email !== undefined && email && !isEmail(email)) return fail(res, 400, "invalid_email", "That email address does not look right.");
    await q(
      `UPDATE users SET email = COALESCE($2, email), phone = COALESCE($3, phone), organisation = COALESCE($4, organisation),
              role = COALESCE($5, role), country = COALESCE($6, country), zone = COALESCE($7, zone), updated_at = now() WHERE id = $1`,
      [req.expoUserId, email, b.phone !== undefined ? clean(b.phone, 40) : undefined, b.organisation !== undefined ? clean(b.organisation, 200) : undefined,
        b.role !== undefined ? clean(b.role, 80) : undefined, b.country !== undefined ? clean(b.country, 80) : undefined, b.zone !== undefined ? clean(b.zone, 120) : undefined].map((v) => (v === undefined ? null : v)),
    );
    ok(res, { user: await getUserById(req.expoUserId) });
  }));

  router.delete("/expo/account", ...user, asyncHandler(async (req, res) => {
    await q(`DELETE FROM users WHERE id = $1`, [req.expoUserId]);
    ok(res, { deleted: true });
  }));

  /* ---- exhibitors ------------------------------------------------------ */

  router.get("/expo/exhibitors", ...app, asyncHandler(async (req, res) => {
    const needle = clean(req.query.q, 100).toLowerCase();
    const category = clean(req.query.category, 60);
    const zone = clean(req.query.zone, 60);
    const smartOnly = ["1", "true"].includes(String(req.query.smartmeet || "").toLowerCase());
    const rows = await q(
      `${EXHIBITOR_SELECT} WHERE active
         AND ($1 = '' OR lower(name || ' ' || tagline || ' ' || description || ' ' || category) LIKE '%' || $1 || '%')
         AND ($2 = '' OR category = $2) AND ($3 = '' OR zone = $3) AND (NOT $4 OR smartmeet)
       ORDER BY sort, name`, [needle, category, zone, smartOnly]);
    ok(res, { exhibitors: rows.map((r) => shapeExhibitor(r)) });
  }));

  router.get("/expo/exhibitors/:id", ...app, asyncHandler(async (req, res) => {
    const row = await q1(`${EXHIBITOR_SELECT} WHERE id = $1 AND active`, [clean(req.params.id, 80)]);
    if (!row) return fail(res, 404, "not_found", "No such exhibitor.");
    ok(res, { exhibitor: shapeExhibitor(row) });
  }));

  /* ---- SmartMeet ------------------------------------------------------- */

  router.get("/expo/smartmeet/days", ...app, (_req, res) => ok(res, { days: eventDays(), meetingMinutes: EVENT.meetingMinutes }));

  router.get("/expo/smartmeet/availability", ...app, asyncHandler(async (req, res) => {
    const exhibitorId = clean(req.query.exhibitor, 80);
    const date = clean(req.query.date, 10);
    const ex = await q1(`${EXHIBITOR_SELECT} WHERE id = $1 AND active`, [exhibitorId]);
    if (!ex || !ex.smartmeet) return fail(res, 404, "not_available", "That exhibitor is not taking SmartMeet bookings.");
    if (!isEventDay(date)) return fail(res, 400, "bad_date", `Pick a day of the Expo (${EVENT.start} to ${EVENT.end}).`);
    const taken = new Set((await q(`SELECT starts_at FROM bookings WHERE exhibitor_id = $1 AND status = 'confirmed' AND starts_at >= $2 AND starts_at < $3`,
      [exhibitorId, atEvent(`${date}T00:00:00`), atEvent(`${date}T23:59:59`)])).map((r) => localTime(r.starts_at)));
    const slots = slotsFor(ex, date).map((s) => ({ ...s, available: s.available && !taken.has(s.start) }));
    ok(res, { exhibitor: shapeExhibitor(ex), date, slots });
  }));

  router.get("/expo/smartmeet/bookings", ...user, asyncHandler(async (req, res) => {
    const rows = await q(`${BOOKING_SELECT} WHERE b.user_id = $1 ORDER BY b.starts_at`, [req.expoUserId]);
    ok(res, { bookings: rows.map(shapeBooking) });
  }));

  router.post("/expo/smartmeet/bookings", ...user, asyncHandler(async (req, res) => {
    const b = req.body || {};
    const exhibitorId = clean(b.exhibitorId, 80);
    const start = clean(b.start, 19);
    if (!exhibitorId || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(start)) return fail(res, 400, "missing_fields", "Provide `exhibitorId` and a `start` time (YYYY-MM-DDTHH:MM).");
    const startLocal = start.length === 16 ? `${start}:00` : start;
    const date = startLocal.slice(0, 10);
    const ex = await q1(`${EXHIBITOR_SELECT} WHERE id = $1 AND active`, [exhibitorId]);
    if (!ex || !ex.smartmeet) return fail(res, 404, "not_available", "That exhibitor is not taking SmartMeet bookings.");
    if (!isEventDay(date)) return fail(res, 400, "bad_date", `Pick a day of the Expo (${EVENT.start} to ${EVENT.end}).`);
    const slot = slotsFor(ex, date).find((s) => s.start === startLocal);
    if (!slot || !slot.available) return fail(res, 400, "bad_slot", "That time is not one of the exhibitor's meeting slots.");
    const me = await getUserById(req.expoUserId);
    const topic = clean(b.topic, 200);
    if (!topic) return fail(res, 400, "missing_topic", "Say what you would like to discuss.");
    const startsAt = atEvent(slot.start);
    const endsAt = atEvent(slot.end);
    if (await q1(`SELECT 1 FROM bookings WHERE user_id = $1 AND status = 'confirmed' AND starts_at = $2`, [me.id, startsAt])) {
      return fail(res, 409, "double_booked", "You already have a meeting at that time.");
    }
    if (EVENT.maxBookingsPerDay) {
      const n = (await q1(`SELECT count(*)::int AS n FROM bookings WHERE user_id = $1 AND status = 'confirmed' AND starts_at >= $2 AND starts_at < $3`, [me.id, atEvent(`${date}T00:00:00`), atEvent(`${date}T23:59:59`)]))?.n || 0;
      if (n >= EVENT.maxBookingsPerDay) return fail(res, 409, "day_full", `You can hold ${EVENT.maxBookingsPerDay} meetings a day at most.`);
    }
    const table = (Math.abs([...exhibitorId].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 24) + 1;
    const ref = reference("SM");
    let row;
    try {
      row = await q1(
        `INSERT INTO bookings (id, reference, user_id, exhibitor_id, starts_at, ends_at, name, email, organisation, topic, notes, location)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [crypto.randomUUID(), ref, me.id, exhibitorId, startsAt, endsAt, clean(b.name, 120) || me.name || me.username || "", clean(b.email, 200) || me.email || "",
          clean(b.organisation, 200) || me.organisation || "", topic, clean(b.notes, 2000), `SmartMeet Lounge · Table ${table}`],
      );
    } catch (err) {
      if (err.code === "23505") return fail(res, 409, "slot_taken", "That slot has just been taken. Pick another time.");
      throw err;
    }
    res.status(201);
    ok(res, { booking: shapeBooking(await q1(`${BOOKING_SELECT} WHERE b.id = $1`, [row.id])) });
  }));

  router.get("/expo/smartmeet/bookings/:id", ...user, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return fail(res, 404, "not_found", "No such booking.");
    const row = await q1(`${BOOKING_SELECT} WHERE b.id = $1 AND b.user_id = $2`, [req.params.id, req.expoUserId]);
    if (!row) return fail(res, 404, "not_found", "No such booking.");
    ok(res, { booking: shapeBooking(row) });
  }));

  router.delete("/expo/smartmeet/bookings/:id", ...user, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return fail(res, 404, "not_found", "No such booking.");
    const row = await q1(`UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1 AND user_id = $2 AND status = 'confirmed' RETURNING id`, [req.params.id, req.expoUserId]);
    if (!row) return fail(res, 404, "not_found", "No such booking, or it is already cancelled.");
    ok(res, { booking: shapeBooking(await q1(`${BOOKING_SELECT} WHERE b.id = $1`, [row.id])) });
  }));

  /* ---- the exhibitor's own area ---------------------------------------- */
  // For accounts the admin has put on an exhibitor's team (POST /expo/admin/users/:id/exhibitor).

  const dayBounds = (date) => [atEvent(`${date}T00:00:00`), atEvent(`${date}T23:59:59`)];

  // The overview: the exhibitor as the admin sees it, its meetings by day, and who else is on the team.
  router.get("/expo/exhibitor", ...exhibitorUser, asyncHandler(async (req, res) => {
    const ex = req.expoExhibitor;
    const counts = await q1(`SELECT count(*) FILTER (WHERE status = 'confirmed')::int AS bookings, count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled FROM bookings WHERE exhibitor_id = $1`, [ex.id]);
    const byDay = {};
    for (const r of await q(`SELECT starts_at FROM bookings WHERE exhibitor_id = $1 AND status = 'confirmed'`, [ex.id])) {
      const d = localTime(r.starts_at).slice(0, 10);
      byDay[d] = (byDay[d] || 0) + 1;
    }
    const days = eventDays().map((date) => ({ date, bookings: byDay[date] || 0, slots: slotsFor(ex, date).filter((s) => s.available).length }));
    const team = (await q(TEAM_SELECT, [ex.id])).map(shapeMember);
    ok(res, { exhibitor: shapeExhibitor(ex, { admin: true }), counts, days, team });
  }));

  // The team changes how the stand reads and its SmartMeet settings; the admin keeps the rest.
  router.patch("/expo/exhibitor", ...exhibitorUser, asyncHandler(async (req, res) => {
    const given = exhibitorFields(req.body || {});
    const f = Object.fromEntries(Object.entries(given).filter(([k]) => EXHIBITOR_OWN_FIELDS.includes(k)));
    const row = await upsertExhibitor(req.expoExhibitor.id, f);
    ok(res, { exhibitor: shapeExhibitor(row, { admin: true }) });
  }));

  // Every meeting booked with the exhibitor (one day of them with ?date=), with who booked it.
  router.get("/expo/exhibitor/bookings", ...exhibitorUser, asyncHandler(async (req, res) => {
    const date = clean(req.query.date, 10);
    if (date && !isEventDay(date)) return fail(res, 400, "bad_date", `Pick a day of the Expo (${EVENT.start} to ${EVENT.end}).`);
    const [from, to] = date ? dayBounds(date) : [null, null];
    const rows = await q(`${BOOKING_SELECT.replace("FROM bookings b", ", u.kc_username AS username, u.kc_avatar AS avatar FROM bookings b LEFT JOIN users u ON u.id = b.user_id")}
       WHERE b.exhibitor_id = $1 AND ($2::timestamptz IS NULL OR b.starts_at >= $2 AND b.starts_at < $3) ORDER BY b.starts_at`, [req.expoExhibitor.id, from, to]);
    ok(res, { bookings: rows.map((r) => ({ ...shapeBooking(r), username: r.username || null, avatar: r.avatar || null })) });
  }));

  /* ---- forms ----------------------------------------------------------- */

  router.post("/expo/registrations", ...maybeUser, asyncHandler(async (req, res) => {
    const b = req.body || {};
    const email = clean(b.email, 200);
    const first = clean(b.firstName, 80);
    const last = clean(b.lastName, 80);
    if (!email || !isEmail(email)) return fail(res, 400, "invalid_email", "Enter a valid email address.");
    if (!first || !last) return fail(res, 400, "missing_fields", "Enter your first and last name.");
    const ref = reference("REG");
    const row = await q1(
      `INSERT INTO registrations (id, reference, user_id, first_name, last_name, email, phone, organisation, role, country, zone, interests, pass)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id, created_at`,
      [crypto.randomUUID(), ref, req.expoUserId, first, last, email, clean(b.phone, 40), clean(b.organisation, 200), clean(b.role, 80), clean(b.country, 80), clean(b.zone, 120), JSON.stringify(list(b.interests)), clean(b.pass, 40)],
    );
    if (req.expoUserId) {
      await q(`UPDATE users SET email = COALESCE(email, $2), phone = CASE WHEN $3 <> '' THEN $3 ELSE phone END, organisation = CASE WHEN $4 <> '' THEN $4 ELSE organisation END,
                 role = CASE WHEN $5 <> '' THEN $5 ELSE role END, country = CASE WHEN $6 <> '' THEN $6 ELSE country END, zone = CASE WHEN $7 <> '' THEN $7 ELSE zone END, updated_at = now() WHERE id = $1`,
        [req.expoUserId, email, clean(b.phone, 40), clean(b.organisation, 200), clean(b.role, 80), clean(b.country, 80), clean(b.zone, 120)]);
    }
    res.status(201);
    ok(res, { reference: ref, id: row.id, createdAt: row.created_at });
  }));

  router.post("/expo/sponsor/enquiries", ...maybeUser, asyncHandler(async (req, res) => {
    const b = req.body || {};
    const name = clean(b.name, 120);
    const email = clean(b.email, 200);
    const organisation = clean(b.organisation, 200);
    if (!name || !organisation) return fail(res, 400, "missing_fields", "Enter your name and organisation.");
    if (!email || !isEmail(email)) return fail(res, 400, "invalid_email", "Enter a valid email address.");
    const ref = reference("SP");
    const row = await q1(
      `INSERT INTO sponsor_enquiries (id, reference, user_id, name, email, organisation, role, interest, programs, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, created_at`,
      [crypto.randomUUID(), ref, req.expoUserId, name, email, organisation, clean(b.role, 80), clean(b.interest, 80), clean(b.programs, 80), clean(b.message, 4000)],
    );
    res.status(201);
    ok(res, { reference: ref, id: row.id, createdAt: row.created_at });
  }));

  const PROGRAMS = new Set(["eagles-nest", "qubators", "content-creative"]);
  router.post("/expo/programs/applications", ...maybeUser, asyncHandler(async (req, res) => {
    const b = req.body || {};
    const program = slug(b.program);
    if (!PROGRAMS.has(program)) return fail(res, 400, "bad_program", "program must be eagles-nest, qubators or content-creative.");
    const name = clean(b.name, 120);
    const email = clean(b.email, 200);
    if (!name) return fail(res, 400, "missing_fields", "Enter your name.");
    if (!email || !isEmail(email)) return fail(res, 400, "invalid_email", "Enter a valid email address.");
    const data = b.data && typeof b.data === "object" && !Array.isArray(b.data) ? b.data : {};
    const ref = reference(program === "eagles-nest" ? "EN" : program === "qubators" ? "QB" : "CC");
    const row = await q1(
      `INSERT INTO program_applications (id, reference, user_id, program, name, email, organisation, summary, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, created_at`,
      [crypto.randomUUID(), ref, req.expoUserId, program, name, email, clean(b.organisation, 200), clean(b.summary, 4000), JSON.stringify(data).slice(0, 20000)],
    );
    res.status(201);
    ok(res, { reference: ref, id: row.id, createdAt: row.created_at });
  }));

  router.get("/expo/programs/applications", ...user, asyncHandler(async (req, res) => {
    const rows = await q(`SELECT id, reference, program, name, email, organisation, summary, status, created_at FROM program_applications WHERE user_id = $1 ORDER BY created_at DESC`, [req.expoUserId]);
    ok(res, { applications: rows.map((r) => ({ id: r.id, reference: r.reference, program: r.program, name: r.name, email: r.email, organisation: r.organisation, summary: r.summary, status: r.status, createdAt: r.created_at })) });
  }));

  /* ---- admin ----------------------------------------------------------- */

  const limit = (req, max = 500) => Math.min(max, Math.max(1, Number(req.query.limit) || 200));

  router.get("/expo/admin/stats", requireAdmin, asyncHandler(async (_req, res) => {
    const row = await q1(`SELECT (SELECT count(*)::int FROM users) AS users, (SELECT count(*)::int FROM exhibitors) AS exhibitors,
      (SELECT count(*)::int FROM bookings WHERE status = 'confirmed') AS bookings, (SELECT count(*)::int FROM registrations) AS registrations,
      (SELECT count(*)::int FROM sponsor_enquiries) AS enquiries, (SELECT count(*)::int FROM program_applications) AS applications`);
    ok(res, { stats: row });
  }));

  const shapeAdminUser = (r) => ({ ...shapeUser(r), disabled: !!r.disabled_at, disabledReason: r.disabled_reason || "", exhibitor: r.exhibitor_id ? { id: r.exhibitor_id, name: r.exhibitor_name } : null });
  const ADMIN_USER_SELECT = `SELECT u.*, e.name AS exhibitor_name FROM users u LEFT JOIN exhibitors e ON e.id = u.exhibitor_id`;

  // ?q= searches name, username and email; ?exhibitor= is one exhibitor's team.
  router.get("/expo/admin/users", requireAdmin, asyncHandler(async (req, res) => {
    const needle = clean(req.query.q, 100).toLowerCase();
    const exhibitor = clean(req.query.exhibitor, 80);
    const rows = await q(`${ADMIN_USER_SELECT} WHERE ($1 = '' OR lower(coalesce(u.kc_username,'') || ' ' || coalesce(u.kc_name,'') || ' ' || coalesce(u.email,'')) LIKE '%' || $1 || '%')
       AND ($2 = '' OR u.exhibitor_id = $2) ORDER BY u.created_at DESC LIMIT $3`, [needle, exhibitor, limit(req)]);
    ok(res, { users: rows.map(shapeAdminUser) });
  }));

  // Puts an account on an exhibitor's team (it then runs that exhibitor at /expo/exhibitor), or takes it off (exhibitorId null or "").
  router.post("/expo/admin/users/:id/exhibitor", requireAdmin, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return fail(res, 404, "not_found", "No such account.");
    const exhibitorId = slug(req.body?.exhibitorId || "");
    if (exhibitorId && !(await q1(`SELECT 1 FROM exhibitors WHERE id = $1`, [exhibitorId]))) return fail(res, 404, "not_found", "No such exhibitor.");
    const row = await q1(`UPDATE users SET exhibitor_id = $2, updated_at = now() WHERE id = $1 RETURNING id`, [req.params.id, exhibitorId || null]);
    if (!row) return fail(res, 404, "not_found", "No such account.");
    ok(res, { user: shapeAdminUser(await q1(`${ADMIN_USER_SELECT} WHERE u.id = $1`, [row.id])) });
  }));

  router.post("/expo/admin/users/:id", requireAdmin, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return fail(res, 404, "not_found", "No such account.");
    const disabled = !!req.body?.disabled;
    const row = await q1(`UPDATE users SET disabled_at = CASE WHEN $2 THEN coalesce(disabled_at, now()) ELSE NULL END, disabled_reason = CASE WHEN $2 THEN $3 ELSE NULL END, updated_at = now() WHERE id = $1 RETURNING id`, [req.params.id, disabled, clean(req.body?.reason, 300) || null]);
    if (!row) return fail(res, 404, "not_found", "No such account.");
    if (disabled) await q(`DELETE FROM refresh_tokens WHERE user_id = $1`, [row.id]);
    ok(res, { user: await getUserById(row.id), disabled });
  }));

  // With `team`: how many accounts run each exhibitor.
  router.get("/expo/admin/exhibitors", requireAdmin, asyncHandler(async (req, res) => {
    const rows = await q(`${EXHIBITOR_SELECT.replace(" FROM exhibitors", ", (SELECT count(*)::int FROM users u WHERE u.exhibitor_id = exhibitors.id AND u.disabled_at IS NULL) AS team FROM exhibitors")} ORDER BY sort, name LIMIT $1`, [limit(req, 2000)]);
    ok(res, { exhibitors: rows.map((r) => shapeExhibitor(r, { admin: true })) });
  }));

  router.post("/expo/admin/exhibitors", requireAdmin, asyncHandler(async (req, res) => {
    const f = exhibitorFields(req.body || {}, { forInsert: true });
    if (!f) return fail(res, 400, "missing_fields", "An exhibitor needs a name.");
    const id = slug(req.body?.id || f.name);
    if (!id) return fail(res, 400, "bad_id", "The id must contain letters or digits.");
    res.status(201);
    ok(res, { exhibitor: shapeExhibitor(await upsertExhibitor(id, f), { admin: true }) });
  }));

  // Several at once (the site's seed, a spreadsheet export): each is made or updated by id.
  router.post("/expo/admin/exhibitors/import", requireAdmin, asyncHandler(async (req, res) => {
    const items = Array.isArray(req.body?.exhibitors) ? req.body.exhibitors : [];
    if (!items.length) return fail(res, 400, "missing_fields", "Send { exhibitors: [...] }.");
    const out = [];
    for (const [i, item] of items.entries()) {
      const f = exhibitorFields(item, { forInsert: true });
      const id = slug(item?.id || f?.name);
      if (!f || !id) continue;
      if (f.sort === undefined) f.sort = i;
      out.push(shapeExhibitor(await upsertExhibitor(id, f), { admin: true }));
    }
    ok(res, { imported: out.length, exhibitors: out });
  }));

  router.put("/expo/admin/exhibitors/:id", requireAdmin, asyncHandler(async (req, res) => {
    const id = slug(req.params.id);
    if (!(await q1(`SELECT 1 FROM exhibitors WHERE id = $1`, [id]))) return fail(res, 404, "not_found", "No such exhibitor.");
    const f = exhibitorFields(req.body || {});
    ok(res, { exhibitor: shapeExhibitor(await upsertExhibitor(id, f), { admin: true }) });
  }));

  router.delete("/expo/admin/exhibitors/:id", requireAdmin, asyncHandler(async (req, res) => {
    const row = await q1(`DELETE FROM exhibitors WHERE id = $1 RETURNING id`, [slug(req.params.id)]);
    if (!row) return fail(res, 404, "not_found", "No such exhibitor.");
    ok(res, { deleted: row.id });
  }));

  router.get("/expo/admin/bookings", requireAdmin, asyncHandler(async (req, res) => {
    const exhibitor = clean(req.query.exhibitor, 80);
    const date = clean(req.query.date, 10);
    const rows = await q(`${BOOKING_SELECT} WHERE ($1 = '' OR b.exhibitor_id = $1) AND ($2 = '' OR b.starts_at >= $3 AND b.starts_at < $4) ORDER BY b.starts_at LIMIT $5`,
      [exhibitor, date, date ? atEvent(`${date}T00:00:00`) : null, date ? atEvent(`${date}T23:59:59`) : null, limit(req, 5000)]);
    ok(res, { bookings: rows.map(shapeBooking) });
  }));

  router.get("/expo/admin/registrations", requireAdmin, asyncHandler(async (req, res) => {
    const rows = await q(`SELECT * FROM registrations ORDER BY created_at DESC LIMIT $1`, [limit(req, 5000)]);
    ok(res, { registrations: rows.map((r) => ({ id: r.id, reference: r.reference, userId: r.user_id, firstName: r.first_name, lastName: r.last_name, email: r.email, phone: r.phone, organisation: r.organisation, role: r.role, country: r.country, zone: r.zone, interests: r.interests, pass: r.pass, createdAt: r.created_at })) });
  }));

  router.get("/expo/admin/enquiries", requireAdmin, asyncHandler(async (req, res) => {
    const rows = await q(`SELECT * FROM sponsor_enquiries ORDER BY created_at DESC LIMIT $1`, [limit(req, 5000)]);
    ok(res, { enquiries: rows.map((r) => ({ id: r.id, reference: r.reference, userId: r.user_id, name: r.name, email: r.email, organisation: r.organisation, role: r.role, interest: r.interest, programs: r.programs, message: r.message, status: r.status, createdAt: r.created_at })) });
  }));

  router.get("/expo/admin/applications", requireAdmin, asyncHandler(async (req, res) => {
    const program = slug(req.query.program || "");
    const rows = await q(`SELECT * FROM program_applications WHERE $1 = '' OR program = $1 ORDER BY created_at DESC LIMIT $2`, [program, limit(req, 5000)]);
    ok(res, { applications: rows.map((r) => ({ id: r.id, reference: r.reference, userId: r.user_id, program: r.program, name: r.name, email: r.email, organisation: r.organisation, summary: r.summary, data: r.data, status: r.status, createdAt: r.created_at })) });
  }));

  const STATUSES = { enquiries: ["new", "contacted", "closed"], applications: ["submitted", "shortlisted", "accepted", "declined"] };
  router.post("/expo/admin/:kind/:id", requireAdmin, asyncHandler(async (req, res, next) => {
    if (!STATUSES[req.params.kind]) return next();
    if (!isUuid(req.params.id)) return fail(res, 404, "not_found", "No such record.");
    const status = clean(req.body?.status, 20);
    if (!STATUSES[req.params.kind].includes(status)) return fail(res, 400, "bad_status", `status must be one of ${STATUSES[req.params.kind].join(", ")}.`);
    const table = req.params.kind === "enquiries" ? "sponsor_enquiries" : "program_applications";
    const row = await q1(`UPDATE ${table} SET status = $2 WHERE id = $1 RETURNING id, status`, [req.params.id, status]);
    if (!row) return fail(res, 404, "not_found", "No such record.");
    ok(res, row);
  }));

  return router;
};

module.exports.ensureSchema = ensureSchema;
module.exports.pool = pool;
module.exports.upsertExhibitor = upsertExhibitor;
module.exports.exhibitorFields = exhibitorFields;
module.exports.eventDays = eventDays;
