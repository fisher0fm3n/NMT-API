// routes/loveworld_expo.js
// LoveWorld Expo (loveworldnation.online): the account and booking service behind the Expo website.
//
// Model (database `loveworld_expo`, Postgres, made with its tables on first use)
//   users               KingsChat identity, plus what the person tells the Expo about themselves;
//                       exhibitor_id when the admin has made the account part of an exhibitor's team;
//                       is_admin for the accounts that may run the website's admin area
//   refresh_tokens      one per signed-in browser (hashed; used once, then replaced)
//   exhibitors          who is on the show floor, and whether they take SmartMeet bookings
//   bookings            SmartMeet one-on-one meetings (a person, an exhibitor, a slot)
//   registrations       attend-the-Expo forms: the pass chosen (its day and price as quoted) and its status
//   sponsor_enquiries   the sponsor page's enquiry form
//   program_applications  Eagles Nest, Qubators and Content Creative applications
//   settings            this service's own values (the token signing key when none is set)
//   notifications       KingsChat messages sent about bookings (to the visitor and the exhibitor's team), and how each went
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
// KingsChat messages about SmartMeet bookings, sent as the project's own KingsChat profile
// (scope messages_on_behalf_of_project) with KC_API_KEY. EXPO_KC_MESSAGES=off stops them.
const KC_MESSAGES_URL = env("EXPO_KC_MESSAGES_URL") || "https://connect.kingsch.at/developer/api/messages";
const messagesOn = () => (env("EXPO_KC_MESSAGES") || "on").toLowerCase() !== "off" && !!KC_API_KEY;
// Every send is logged with KingsChat's answer; EXPO_KC_DEBUG=1 also logs the request body.
const kcDebug = () => ["1", "true", "on"].includes(String(env("EXPO_KC_DEBUG") || "").toLowerCase());

// Passes are paid in Espees, charged there and then to the buyer's Espees wallet (username and PIN)
// or an Espees card (card number and PIN) with the Expo's merchant token (EXPO_ESPEES_API_TOKEN),
// then confirmed with Espees. The PIN goes to Espees and nowhere else: it is never stored or logged.
// Once paid, each ticket is added on KingsPass (EXPO_KINGSPASS_URL, the KingsPass server, and the
// event's EXPO_KINGSPASS_EVENT_TOKEN). Without all of these, checkout says passes aren't on sale.
const ESPEES_API_TOKEN = env("EXPO_ESPEES_API_TOKEN") || "";
const ESPEES_URL = (env("EXPO_ESPEES_URL") || "https://web.espees.org/api/externalpayments").replace(/\/+$/, "");
// The KingsPass server, with or without its /api (https://kingspass.org or https://kingspass.org/api/).
const KINGSPASS_URL = (env("EXPO_KINGSPASS_URL") || "").replace(/\/+$/, "").replace(/\/api$/i, "");
const KINGSPASS_EVENT_TOKEN = env("EXPO_KINGSPASS_EVENT_TOKEN") || "";
const passesOnSale = () => !!(ESPEES_API_TOKEN && KINGSPASS_URL && KINGSPASS_EVENT_TOKEN);
// Every Espees and KingsPass answer is logged (its first 300 characters); EXPO_PAY_DEBUG=1 also
// logs what was sent, and the answers in full. Keys, tokens, PINs and card numbers are never logged.
const payDebug = () => ["1", "true", "on"].includes(String(env("EXPO_PAY_DEBUG") || "").toLowerCase());
const payLog = (raw) => (payDebug() ? raw : raw.slice(0, 300));

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
  // A meeting can be moved to another time until this many minutes before it starts.
  rescheduleCutoffMinutes: Number(env("EXPO_RESCHEDULE_CUTOFF_MINUTES") ?? 15),
  // One person may hold this many confirmed meetings a day (0: no limit).
  maxBookingsPerDay: Number(env("EXPO_MAX_BOOKINGS_PER_DAY") || 6),
};

// The passes on sale: their price in Espees and the KingsPass tickets each one issues. Keep the
// prices in step with the website's src/data/passes.ts (checkout refuses a price the website
// shows differently). The day and 3-day passes issue the day ticket of each day picked.
const KINGSPASS_DAY_TICKETS = {
  "2026-11-09": 2581, "2026-11-10": 2580, "2026-11-11": 2579, "2026-11-12": 2578, "2026-11-13": 2577, "2026-11-14": 2576, "2026-11-15": 2575,
};
const PASSES = {
  day: { name: "Day pass", price: 10, days: 1 },
  "three-day": { name: "3-day pass", price: 15, days: 3 },
  week: { name: "Week pass", price: 25, ticket: 2574 },
  vip: { name: "VIP pass", price: 100, ticket: 2573 },
  // For trying a real purchase end to end, on KingsPass's test tickets ("Lw Expo Pass - Test" and
  // "Lw Expo Pass - Test 2"): admins only. EXPO_KINGSPASS_TEST2_TICKET can point Test pass 2 elsewhere.
  test: { name: "Test pass", price: 0.001, ticket: 2582, adminOnly: true },
  "test-2": { name: "Test pass 2", price: 0.001, ticket: Number(env("EXPO_KINGSPASS_TEST2_TICKET")) || 2593, adminOnly: true },
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
  -- Who may run the website's admin area: set by another admin, or straight in the database
  -- (UPDATE users SET is_admin = true WHERE lower(kc_username) = '<username>').
  ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
  -- A registration's pass as quoted when it was made (the website sets the price from its own
  -- list), and where it stands: pending (to pay), confirmed, cancelled.
  ALTER TABLE registrations ADD COLUMN IF NOT EXISTS pass_day TEXT NOT NULL DEFAULT '';
  ALTER TABLE registrations ADD COLUMN IF NOT EXISTS pass_price NUMERIC(12,2) NOT NULL DEFAULT 0;
  ALTER TABLE registrations ADD COLUMN IF NOT EXISTS pass_currency TEXT NOT NULL DEFAULT '';
  ALTER TABLE registrations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
  CREATE INDEX IF NOT EXISTS registrations_user ON registrations (user_id, created_at DESC);
  -- Passes bought online: the ticket holder's title and church (with the name, email, phone,
  -- country and zone above, from their profile), the days picked, the Espees payment, and the
  -- KingsPass tickets to issue ([{ ticketId, day, status: to_issue | issued | failed, ... }]).
  -- status: pending (to pay), paid (tickets still to issue), confirmed, cancelled.
  ALTER TABLE registrations ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';
  ALTER TABLE registrations ADD COLUMN IF NOT EXISTS church TEXT NOT NULL DEFAULT '';
  ALTER TABLE registrations ADD COLUMN IF NOT EXISTS pass_days JSONB NOT NULL DEFAULT '[]';
  ALTER TABLE registrations ADD COLUMN IF NOT EXISTS payment_ref TEXT;
  ALTER TABLE registrations ADD COLUMN IF NOT EXISTS payment_status TEXT;
  ALTER TABLE registrations ADD COLUMN IF NOT EXISTS payment_checked_at TIMESTAMPTZ;
  ALTER TABLE registrations ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
  ALTER TABLE registrations ADD COLUMN IF NOT EXISTS tickets JSONB NOT NULL DEFAULT '[]';
  ALTER TABLE registrations ADD COLUMN IF NOT EXISTS issued_at TIMESTAMPTZ;
  CREATE UNIQUE INDEX IF NOT EXISTS registrations_payment_ref ON registrations (payment_ref) WHERE payment_ref IS NOT NULL;
  -- How it was paid (wallet or card), who paid (@username, or the card's last four digits; never a
  -- PIN or the whole card number), and Espees' reason when it refused the payment.
  ALTER TABLE registrations ADD COLUMN IF NOT EXISTS payment_method TEXT;
  ALTER TABLE registrations ADD COLUMN IF NOT EXISTS payer TEXT;
  ALTER TABLE registrations ADD COLUMN IF NOT EXISTS payment_error TEXT;
  -- Prices to four decimal places of an Espee (the test pass is 0.001).
  DO $$ BEGIN
    IF (SELECT numeric_scale FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'registrations' AND column_name = 'pass_price') < 4 THEN
      ALTER TABLE registrations ALTER COLUMN pass_price TYPE NUMERIC(14,4);
    END IF;
  END $$;

  -- The KingsChat user id messages are addressed to: the profile's own id (profile.id), which
  -- kc_id (an account's key, kcID when KingsChat gives one) need not be. Filled in at sign-in.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS kc_user_id TEXT;
  -- The profile a person completes after signing in (with email, phone, country and zone): the
  -- website asks for it until every field is there. First and last name start from KingsChat's.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS title TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS church TEXT;
  -- Whether the person is a member of Christ Embassy, asked with the profile: zone and church are
  -- asked of members only. Null for accounts made before the question (see membership()).
  ALTER TABLE users ADD COLUMN IF NOT EXISTS christ_embassy BOOLEAN;
  -- Who cancelled a booking (visitor, exhibitor or admin) and the reason they gave.
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_by TEXT;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
  -- When a meeting was last moved to another time by the visitor, and how many times.
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rescheduled_at TIMESTAMPTZ;
  ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reschedule_count INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE IF NOT EXISTS notifications (
    id BIGSERIAL PRIMARY KEY,
    booking_id UUID REFERENCES bookings(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    recipient_kc_id TEXT,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    kc_message_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS notifications_booking ON notifications (booking_id, created_at);

  -- Page views, counted by the website: the page's address and the day (on the event's clock), and
  -- nothing about who viewed it.
  CREATE TABLE IF NOT EXISTS page_views (
    day DATE NOT NULL,
    path TEXT NOT NULL,
    views INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, path)
  );
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

const USER_SELECT = `SELECT id, kc_id, kc_username, kc_name, kc_avatar, email, phone, organisation, role, country, zone, title, first_name, last_name, church, christ_embassy, exhibitor_id, is_admin, created_at, last_login_at FROM users`;
const filled = (v) => String(v ?? "").trim() !== "";
/**
 * Whether the person is a member of Christ Embassy: their answer, or, for an account made before the
 * question was asked, yes if they gave a zone and church then (every profile had to), else unknown.
 */
const membership = (r) => (typeof r.christ_embassy === "boolean" ? r.christ_embassy : filled(r.zone) && filled(r.church) ? true : null);
/**
 * A complete profile, which the website asks a signed-in person for until it is: these fields, the
 * answer to whether they're a member of Christ Embassy, and, for members, their zone and church.
 */
const PROFILE_REQUIRED = ["title", "first_name", "last_name", "email", "phone", "country"];
const profileComplete = (r) => {
  const member = membership(r);
  return PROFILE_REQUIRED.every((k) => filled(r[k])) && isEmail(r.email) && member !== null && (!member || (filled(r.zone) && filled(r.church)));
};
function shapeUser(r) {
  if (!r) return null;
  return {
    id: r.id, kcId: r.kc_id, username: r.kc_username, name: r.kc_name, avatar: r.kc_avatar,
    email: r.email, phone: r.phone, organisation: r.organisation, role: r.role, country: r.country, zone: r.zone,
    title: r.title || null, firstName: r.first_name || null, lastName: r.last_name || null, church: r.church || null,
    christEmbassy: membership(r), profileComplete: profileComplete(r),
    exhibitorId: r.exhibitor_id || null, admin: !!r.is_admin, createdAt: r.created_at, lastLoginAt: r.last_login_at,
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

/** First and last name: KingsChat's own fields when it gives them, else its full name split at the first space. */
function splitName(first, last, full) {
  if (first || last) return { first: first ? String(first) : null, last: last ? String(last) : null };
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || null, last: parts.slice(1).join(" ") || null };
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
  // profile.id: the id KingsChat's messages API addresses a person by.
  const kcUserId = p.id != null && p.id !== "" ? String(p.id) : u.id != null && u.id !== "" ? String(u.id) : null;
  const names = splitName(pick("firstName", "first_name"), pick("lastName", "last_name"), pick("name"));
  return {
    kcId: kcIds[0] || null,
    kcIds,
    kcUserId,
    username: username ? String(username).replace(/^@/, "") : null,
    name: pick("name") || [pick("firstName"), pick("lastName")].filter(Boolean).join(" ") || null,
    email: pick("emailAddress", "email"),
    phone: phone ? String(phone) : null,
    avatar: pick("profilePicture", "avatar", "displayPicture", "avatarUrl", "avatar_url", "picture"),
    firstName: names.first,
    lastName: names.last,
  };
}

// KingsChat usernames (without the @, any case) made admins of the website's admin area as they sign
// in: EXPO_AUTO_ADMINS, comma-separated, or the Expo team's own below when it isn't set ("" turns it
// off). The username comes from KingsChat's sign-in, so nobody else can claim it here. They're made
// admins at every sign-in, so taking one off in the admin area lasts only until they next sign in:
// take them off this list as well.
const AUTO_ADMINS = new Set(
  // Read as it is (env() would treat "" as unset, and it means off here).
  (process.env.EXPO_AUTO_ADMINS ?? "pastorrita").split(",").map((u) => u.trim().replace(/^@/, "").toLowerCase()).filter(Boolean),
);

async function upsertKcUser(profile) {
  const username = profile.username || null;
  const made = await upsertKcAccount(profile, username);
  if (username && AUTO_ADMINS.has(username.toLowerCase())) {
    const promoted = await q1(`UPDATE users SET is_admin = true, updated_at = now() WHERE id = $1 AND NOT is_admin RETURNING id`, [made.id]);
    if (promoted) console.log(`[expo] @${username} signed in and was made an admin (EXPO_AUTO_ADMINS)`);
  }
  return made;
}

async function upsertKcAccount(profile, username) {
  const ids = profile.kcIds?.length ? profile.kcIds : profile.kcId ? [profile.kcId] : [];
  let row =
    (ids.length ? await q1(`SELECT id FROM users WHERE kc_id = ANY($1::text[]) ORDER BY (kc_id = $2) DESC, created_at ASC LIMIT 1`, [ids, profile.kcId]) : null) ||
    (username ? await q1(`SELECT id FROM users WHERE kc_id IS NULL AND lower(kc_username) = lower($1)`, [username]) : null);
  if (row) {
    await q(
      `UPDATE users SET kc_id = COALESCE($2, kc_id), kc_username = COALESCE($3, kc_username), kc_name = COALESCE($4, kc_name),
              kc_avatar = COALESCE($5, kc_avatar), email = COALESCE(email, $6), phone = COALESCE(phone, $7), kc_user_id = COALESCE($8, kc_user_id),
              first_name = COALESCE(NULLIF(first_name, ''), $9), last_name = COALESCE(NULLIF(last_name, ''), $10),
              updated_at = now(), last_login_at = now()
       WHERE id = $1`,
      [row.id, profile.kcId, username, profile.name, profile.avatar, profile.email, profile.phone, profile.kcUserId || null, profile.firstName || null, profile.lastName || null],
    );
  } else {
    row = await q1(
      `INSERT INTO users (id, kc_id, kc_username, kc_name, kc_avatar, email, phone, kc_user_id, first_name, last_name, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now()) RETURNING id`,
      [crypto.randomUUID(), profile.kcId, username, profile.name, profile.avatar, profile.email, profile.phone, profile.kcUserId || null, profile.firstName || null, profile.lastName || null],
    );
    return { id: row.id, created: true };
  }
  return { id: row.id, created: false };
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
  const account = await upsertKcUser(profile);
  return { userId: account.id, created: account.created };
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

const BOOKING_SELECT = `SELECT b.id, b.reference, b.user_id, b.exhibitor_id, e.name AS exhibitor_name, e.stand, b.starts_at, b.ends_at, b.name, b.email, b.organisation, b.topic, b.notes, b.location, b.status, b.created_at, b.cancelled_at, b.cancelled_by, b.cancel_reason, b.rescheduled_at, b.reschedule_count
  FROM bookings b JOIN exhibitors e ON e.id = b.exhibitor_id`;
const shapeBooking = (r) => r && ({
  id: r.id, reference: r.reference, exhibitorId: r.exhibitor_id, exhibitor: { id: r.exhibitor_id, name: r.exhibitor_name, stand: r.stand },
  start: localTime(r.starts_at), end: localTime(r.ends_at), startsAt: r.starts_at, endsAt: r.ends_at,
  name: r.name, email: r.email, organisation: r.organisation, topic: r.topic, notes: r.notes, location: r.location,
  status: r.status, createdAt: r.created_at, cancelledAt: r.cancelled_at, cancelledBy: r.cancelled_by || null, cancelReason: r.cancel_reason || "",
  rescheduledAt: r.rescheduled_at || null, rescheduleCount: r.reschedule_count || 0,
  // Until when the visitor may still move it (EXPO_RESCHEDULE_CUTOFF_MINUTES before the start).
  rescheduleUntil: new Date(new Date(r.starts_at).getTime() - EVENT.rescheduleCutoffMinutes * 60000).toISOString(),
  ...(r.user_id ? { userId: r.user_id } : {}),
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
 * KingsChat messages about bookings
 *
 * When a meeting is booked or cancelled, the visitor and everyone on the exhibitor's team get a
 * KingsChat message from the project's profile (POST /developer/api/messages, api-key, no
 * sender_id: scope messages_on_behalf_of_project). People who signed in here have authorized
 * the project, so they can be reached. Each send is kept in `notifications` with how it went;
 * a failed send never fails the booking or the cancellation.
 * ------------------------------------------------------------------------- */

const KC_TEXT_LIMIT = 1000; // bytes: KingsChat turns a text over 1024 bytes into a file
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Tue 10 Nov, 11:20–11:40 (GMT+1)" from the booking's times on the event's clock. */
function whenLabel(startsAt, endsAt) {
  const a = localTime(new Date(startsAt));
  const b = localTime(new Date(endsAt));
  const d = new Date(`${a.slice(0, 10)}T00:00:00Z`);
  const off = EVENT.offset.replace(/^([+-])0?(\d+):00$/, "$1$2").replace(/^([+-]\d+):(\d+)$/, "$1$2");
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${a.slice(11, 16)}–${b.slice(11, 16)} (GMT${off})`;
}

const site = (path) => (SITE_URL ? `${SITE_URL}${path}` : "");
const short = (v, n) => { const t = String(v || "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** A blank line between blocks of a message (an empty value, by contrast, is a line left out). */
const GAP = "\u2063";

/** Lines into one message, trimmed to KingsChat's inline limit (the longest optional line goes first). */
function compose(lines) {
  let list = lines.filter((l) => l != null && l !== false && l !== "").map((l) => (l === GAP ? "" : l));
  // No blank line at the start or end, nor two together (when the lines between were left out).
  list = list.filter((l, i) => l !== "" || (i > 0 && i < list.length - 1 && list[i - 1] !== ""));
  let text = list.join("\n");
  while (Buffer.byteLength(text, "utf8") > KC_TEXT_LIMIT) {
    const i = list.reduce((m, l, k) => (l.length > list[m].length ? k : m), 0);
    list[i] = short(list[i], Math.max(20, Math.floor(list[i].length * 0.7)));
    text = list.join("\n");
  }
  return text;
}

/** The booking with the visitor and the exhibitor, as the messages need them. */
async function bookingForMessages(bookingId) {
  return q1(
    `SELECT b.id, b.reference, b.exhibitor_id, b.starts_at, b.ends_at, b.name, b.email, b.organisation, b.topic, b.notes, b.location,
            b.status, b.cancelled_by, b.cancel_reason, e.name AS exhibitor_name, e.stand,
            u.id AS visitor_id, u.kc_user_id AS visitor_kc_user_id, u.kc_id AS visitor_kc_id, u.kc_username AS visitor_username, u.kc_name AS visitor_name
       FROM bookings b JOIN exhibitors e ON e.id = b.exhibitor_id LEFT JOIN users u ON u.id = b.user_id WHERE b.id = $1`, [bookingId]);
}

/** The texts for one event: what the visitor reads, and what the exhibitor's team reads. */
function bookingMessages(kind, b, { byName, from } = {}) {
  const who = b.name || b.visitor_name || (b.visitor_username ? `@${b.visitor_username}` : "A visitor");
  const handle = b.visitor_username ? ` (@${b.visitor_username})` : "";
  const when = whenLabel(b.starts_at, b.ends_at);
  const stand = b.stand ? ` · Stand ${b.stand}` : "";
  const reason = b.cancel_reason ? `Reason: ${short(b.cancel_reason, 300)}` : "";
  if (kind === "booked") {
    return {
      visitor: compose([
        "✅ SmartMeet confirmed · LoveWorld Expo 2026",
        GAP,
        `With: ${b.exhibitor_name}${stand}`,
        `When: ${when}`,
        `Where: ${b.location}`,
        `Topic: ${short(b.topic, 200)}`,
        `Reference: ${b.reference}`,
        GAP,
        site("/my-expo") && `See or cancel your meetings: ${site("/my-expo")}`,
      ]),
      exhibitor: compose([
        `📅 New SmartMeet booking · ${b.exhibitor_name}`,
        GAP,
        `Visitor: ${who}${handle}`,
        b.organisation && `Organisation: ${short(b.organisation, 120)}`,
        `When: ${when}`,
        `Where: ${b.location}`,
        `Topic: ${short(b.topic, 200)}`,
        b.notes && `Notes: ${short(b.notes, 400)}`,
        `Reference: ${b.reference}`,
        GAP,
        site("/exhibitor/bookings") && `All your meetings: ${site("/exhibitor/bookings")}`,
      ]),
    };
  }
  if (kind === "rescheduled") {
    const was = from ? whenLabel(from.startsAt, from.endsAt) : "";
    return {
      visitor: compose([
        "🔁 SmartMeet moved · LoveWorld Expo 2026",
        GAP,
        `With: ${b.exhibitor_name}${stand}`,
        `New time: ${when}`,
        was && `Was: ${was}`,
        `Where: ${b.location}`,
        `Topic: ${short(b.topic, 200)}`,
        `Reference: ${b.reference}`,
        GAP,
        site("/my-expo") && `See or change your meetings: ${site("/my-expo")}`,
      ]),
      exhibitor: compose([
        `🔁 SmartMeet moved · ${b.exhibitor_name}`,
        GAP,
        `${who}${handle} moved their meeting.`,
        `New time: ${when}`,
        was && `Was: ${was}`,
        `Where: ${b.location}`,
        `Topic: ${short(b.topic, 200)}`,
        `Reference: ${b.reference}`,
        GAP,
        was && "The earlier slot is open for booking again.",
      ]),
    };
  }
  // cancelled
  const byExhibitor = b.cancelled_by === "exhibitor";
  const by = byExhibitor ? `${b.exhibitor_name}${byName ? ` (${byName})` : ""}` : b.cancelled_by === "admin" ? "the Expo team" : who;
  return {
    visitor: compose([
      "❌ SmartMeet cancelled · LoveWorld Expo 2026",
      GAP,
      byExhibitor ? `${b.exhibitor_name} cancelled your meeting.` : b.cancelled_by === "admin" ? "The Expo team cancelled your meeting." : "You cancelled your meeting.",
      `With: ${b.exhibitor_name}${stand}`,
      `When: ${when}`,
      reason,
      `Reference: ${b.reference}`,
      GAP,
      site(`/smartmeet?exhibitor=${encodeURIComponent(b.exhibitor_id)}`) && `Book another time: ${site(`/smartmeet?exhibitor=${encodeURIComponent(b.exhibitor_id)}`)}`,
    ]),
    exhibitor: compose([
      `❌ SmartMeet cancelled · ${b.exhibitor_name}`,
      GAP,
      `Cancelled by: ${by}`,
      `Visitor: ${who}${handle}`,
      `When: ${when}`,
      `Topic: ${short(b.topic, 200)}`,
      reason,
      `Reference: ${b.reference}`,
      GAP,
      "The slot is open for booking again.",
    ]),
  };
}

/** One KingsChat message: { ok, messageId } or { ok: false, error }. `label` names it in the log. */
async function sendKcMessage(recipientId, text, label = "") {
  // Sent as the project's own KingsChat profile: no sender_id (scope messages_on_behalf_of_project).
  const payload = { recipient_id: recipientId, message: { body: { text: { body: text } } } };
  const tag = `[expo] KingsChat message${label ? ` ${label}` : ""}`;
  console.log(`${tag} → POST ${KC_MESSAGES_URL} (as the project) recipient_id=${recipientId} (${Buffer.byteLength(text, "utf8")} bytes, api-key …${KC_API_KEY.slice(-4)})`);
  if (kcDebug()) console.log(`${tag} request body: ${JSON.stringify(payload)}`);
  let resp;
  try {
    resp = await fetch(KC_MESSAGES_URL, {
      method: "POST",
      headers: { "api-key": KC_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.log(`${tag} ← no answer: ${err.message}`);
    return { ok: false, error: `unreachable: ${err.message}` };
  }
  const raw = await resp.text().catch(() => "");
  console.log(`${tag} ← ${resp.status} ${resp.statusText} ${raw.slice(0, 1000)}`);
  let json = null;
  try { json = JSON.parse(raw); } catch { /* not JSON: the gateway's HTML, say */ }
  if (!resp.ok || json?.status !== "ok") {
    return { ok: false, code: json?.error || "", error: `${resp.status} ${json?.error || ""} ${json?.message || (json ? "" : raw.slice(0, 200))}`.replace(/\s+/g, " ").trim() };
  }
  return { ok: true, messageId: json?.message?.id || null };
}

/**
 * One message to one person, sent and recorded in `notifications`: { userId, kind, status, error }.
 * `r` is { userId, kc, text, kind }; `bookingId` and `ref` (for the log) may be null.
 */
async function deliver(r, { bookingId = null, ref = "" } = {}) {
  let result;
  const label = `(${r.kind}${ref ? `, ${ref}` : ""})`;
  if (!messagesOn()) result = { ok: false, skipped: true, error: KC_API_KEY ? "messages turned off (EXPO_KC_MESSAGES=off)" : "no KingsChat api-key (EXPO_KC_API_KEY)" };
  else if (!r.kc) result = { ok: false, skipped: true, error: "no KingsChat id on the account" };
  else {
    result = await sendKcMessage(r.kc, r.text, label);
    // The recipient is the project's own KingsChat profile: not an outage, just no one to tell.
    if (result.code === "cannot_send_to_self") result = { ok: false, skipped: true, error: "the recipient is the project's own KingsChat profile itself (cannot_send_to_self)" };
  }
  const status = result.ok ? "sent" : result.skipped ? "skipped" : "failed";
  if (status === "skipped") console.log(`[expo] KingsChat message ${label} not sent: ${result.error}`);
  if (status === "failed") console.error(`[expo] KingsChat message ${label} failed: ${result.error}`);
  await q(
    `INSERT INTO notifications (booking_id, user_id, kind, recipient_kc_id, body, status, error, kc_message_id, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $6 = 'sent' THEN now() END)`,
    [bookingId, r.userId, r.kind, r.kc || null, r.text, status, result.error || null, result.messageId || null]);
  return { userId: r.userId, kind: r.kind, status, error: result.error || null };
}

/**
 * Tell the visitor and the exhibitor's team about a booking event ("booked", "rescheduled" or
 * "cancelled"). Returns the notifications rows' outcomes; never throws.
 */
async function notifyBooking(bookingId, kind, { byName, from } = {}) {
  try {
    const b = await bookingForMessages(bookingId);
    if (!b) return [];
    const texts = bookingMessages(kind, b, { byName, from });
    const team = await q(`SELECT id, kc_user_id, kc_id FROM users WHERE exhibitor_id = $1 AND disabled_at IS NULL`, [b.exhibitor_id]);
    if (!team.length) console.log(`[expo] KingsChat messages (${kind}, ${b.reference}): nobody is on ${b.exhibitor_name}'s team, so only the visitor is told`);
    const recipients = [
      ...(b.visitor_id ? [{ userId: b.visitor_id, kc: b.visitor_kc_user_id || b.visitor_kc_id, text: texts.visitor, kind: `${kind}:visitor` }] : []),
      ...team.map((m) => ({ userId: m.id, kc: m.kc_user_id || m.kc_id, text: texts.exhibitor, kind: `${kind}:exhibitor` })),
    ];
    // One message per KingsChat account, even when the visitor is also on the team.
    const seen = new Set();
    const out = [];
    for (const r of recipients) {
      const key = r.kc || r.userId;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(await deliver(r, { bookingId: b.id, ref: b.reference }));
    }
    return out;
  } catch (err) {
    console.error(`[expo] booking messages (${kind}, ${bookingId}) failed:`, err.message);
    return [];
  }
}

/** Send in the background: the answer to the person does not wait for KingsChat. */
const notifyLater = (bookingId, kind, opts) => { setImmediate(() => { notifyBooking(bookingId, kind, opts); }); };

/** The day of the week and month of a YYYY-MM-DD, e.g. "Mon 9 Nov". */
function dayLabel(date) {
  const d = new Date(`${date}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** The welcome a new account gets on KingsChat: what the Expo is and what is in store. */
function welcomeMessage(name) {
  const first = String(name || "").trim().split(/\s+/)[0];
  const start = new Date(`${EVENT.start}T00:00:00Z`);
  const end = new Date(`${EVENT.end}T00:00:00Z`);
  const dates = `${start.getUTCDate()}–${end.getUTCDate()} ${MONTHS[end.getUTCMonth()]} ${end.getUTCFullYear()}`;
  return compose([
    `👋 Welcome to LoveWorld Expo 2026${first ? `, ${first}` : ""}!`,
    GAP,
    `Where the world meets LoveWorld: seven days, ${dates}.`,
    GAP,
    "What's in store:",
    "• A sector in the spotlight each day: enterprise, health, agriculture, fashion & creativity, technology, manufacturing and investment",
    "• Product launches and live demos to see and try firsthand",
    "• Practical sessions with experts",
    "• SmartMeet: book one-on-one meetings with exhibitors before you arrive",
    GAP,
    site("/smartmeet") && `Book a meeting: ${site("/smartmeet")}`,
    site("/programme") && `The programme: ${site("/programme")}`,
  ]);
}

/** Welcome a new account on KingsChat, in the background; once per account (by its record). */
function welcomeLater(userId) {
  setImmediate(async () => {
    try {
      if (await q1(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'welcome'`, [userId])) return;
      const u = await q1(`SELECT id, kc_user_id, kc_id, kc_name, kc_username FROM users WHERE id = $1`, [userId]);
      if (!u) return;
      await deliver({ userId: u.id, kc: u.kc_user_id || u.kc_id, text: welcomeMessage(u.kc_name || u.kc_username), kind: "welcome" }, { ref: u.kc_username ? `@${u.kc_username}` : "" });
    } catch (err) {
      console.error(`[expo] welcome message (${userId}) failed:`, err.message);
    }
  });
}

/* ---------------------------------------------------------------------------
 * Passes: paid in Espees, issued on KingsPass
 * ------------------------------------------------------------------------- */

/** The KingsPass tickets a pass issues for the days picked: [{ ticketId, day }]. */
function passTickets(passId, days) {
  const pass = PASSES[passId];
  if (!pass) return [];
  return pass.days ? days.map((day) => ({ ticketId: KINGSPASS_DAY_TICKETS[day], day })) : [{ ticketId: pass.ticket, day: "" }];
}

const sameAmount = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
const amountLabel = (n) => `${Number(n).toLocaleString("en-GB", { maximumFractionDigits: 4 })} Espees`;
const parseJson = (raw) => { try { return JSON.parse(raw); } catch { return null; } };

/** A call to Espees' payments API: { http, json, raw }, or { error, timedOut } when there was no answer. */
async function espeesCall(path, body, label, timeoutMs = 30000) {
  if (payDebug()) {
    // What was sent, with the PIN and all but the card's last four digits hidden.
    const shown = { ...body, ...(body.pin != null ? { pin: "****" } : {}), ...(body.cardNum != null ? { cardNum: `****${String(body.cardNum).slice(-4)}` } : {}) };
    console.log(`[expo] Espees ${label} → POST ${ESPEES_URL}/${path} (API-TOKEN …${ESPEES_API_TOKEN.slice(-4)}) ${JSON.stringify(shown)}`);
  }
  let resp;
  try {
    resp = await fetch(`${ESPEES_URL}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "API-TOKEN": ESPEES_API_TOKEN },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // A timeout may come after Espees has taken the payment; a refused connection never does.
    return { error: err.message, timedOut: err.name === "TimeoutError" };
  }
  const raw = await resp.text().catch(() => "");
  console.log(`[expo] Espees ${label} ← ${resp.status} ${payLog(raw)}`);
  return { http: resp.status, json: parseJson(raw), raw };
}

/**
 * Charges a purchase on Espees, from a wallet ({ method: "wallet", username, pin }) or a card
 * ({ method: "card", cardNum, pin }): { reference } once Espees has taken it; { declined } with
 * Espees' reason, or { unavailable }, when nothing was taken; { unknown } when it can't be told.
 */
async function chargeEspees(r, payment) {
  const amount = Number(r.pass_price);
  // A charge can take Espees a while (20 seconds and more): it gets a minute before it's "unknown".
  const out = payment.method === "card"
    ? await espeesCall("cardpayment", { cardNum: payment.cardNum, pin: payment.pin, amount: String(amount) }, `card payment ${r.reference}`, 60000)
    : await espeesCall("makepayment", { username: payment.username, pin: payment.pin, espeesAmount: amount }, `wallet payment ${r.reference}`, 60000);
  if (out.error) return out.timedOut ? { unknown: `no answer: ${out.error}` } : { unavailable: out.error };
  const ref = out.json?.data?.reference ?? out.json?.reference;
  if (out.json?.status === true && ref) return { reference: String(ref) };
  if (out.json?.status === false) return { declined: clean(out.json.message || out.json.error || "Espees refused the payment.", 300) };
  // Anything else (a server error, say) may or may not have taken the payment.
  return { unknown: `${out.http} ${out.raw.slice(0, 200)}`.trim() };
}

/** What Espees says of a charge: { done (its status is "1"), amount, reference } or { error }. */
async function espeesTransaction(reference) {
  const out = await espeesCall("transactionstatus", { reference }, `transaction ${reference}`);
  if (out.error) return { error: `no answer: ${out.error}` };
  const d = out.json?.data;
  if (out.json?.status !== true || !d) return { error: `${out.http} ${out.json?.message || out.raw.slice(0, 200)}`.trim() };
  return { done: String(d.status ?? "") === "1", status: String(d.status ?? ""), amount: d.espeesAmount ?? null, reference: d.reference ?? null };
}

/** KingsPass's reason for refusing an attendee: its message, its field errors ("phone_number: …"), or the answer itself. */
function kingsPassReason(json, raw) {
  for (const v of [json?.message, json?.msg, json?.error]) if (typeof v === "string" && v.trim()) return v.trim();
  // KingsPass gives its reasons under msg ({ "msg": { "attend": "attendee already registered for this event" } }).
  const fields = [json?.msg, json?.errors, json?.messages, json?.message].find((v) => v && typeof v === "object");
  if (fields) return Object.entries(fields).map(([k, v]) => `${k}: ${[].concat(v).join(" ")}`).join("; ");
  return raw.slice(0, 200);
}

// KingsPass needs a zone and a church for every attendee; someone who isn't a member of Christ Embassy
// gives neither, so these go in their place (on KingsPass only: the person's profile stays as it is).
const KINGSPASS_NO_ZONE = "lwexpo";
const KINGSPASS_NO_CHURCH = "lwexpo delegate";

/** One ticket on KingsPass for the purchase's holder: { status: "issued", attendeeId } or { status: "failed", error } (with KingsPass's answer). */
async function addKingsPassAttendee(r, ticketId) {
  if (!KINGSPASS_URL || !KINGSPASS_EVENT_TOKEN) return { status: "failed", error: "KingsPass isn't set up (EXPO_KINGSPASS_URL, EXPO_KINGSPASS_EVENT_TOKEN)" };
  const form = new FormData();
  const fields = {
    title: r.title, firstname: r.first_name, lastname: r.last_name, email: r.email, phone_number: r.phone, country: r.country,
    zone: filled(r.zone) ? r.zone : KINGSPASS_NO_ZONE, church: filled(r.church) ? r.church : KINGSPASS_NO_CHURCH, ticket_id: String(ticketId),
  };
  for (const [k, v] of Object.entries(fields)) form.append(k, v ?? "");
  if (payDebug()) console.log(`[expo] KingsPass attendee (${r.reference}, ticket ${ticketId}) → POST ${KINGSPASS_URL}/api/public/attendees ${JSON.stringify(fields)}`);
  let resp;
  try {
    resp = await fetch(`${KINGSPASS_URL}/api/public/attendees`, { method: "POST", headers: { "X-EVENT-TOKEN": KINGSPASS_EVENT_TOKEN, Accept: "application/json" }, body: form, signal: AbortSignal.timeout(20000) });
  } catch (err) {
    return { status: "failed", error: `unreachable: ${err.message}` };
  }
  const raw = await resp.text().catch(() => "");
  const json = parseJson(raw);
  console.log(`[expo] KingsPass attendee (${r.reference}, ticket ${ticketId}) ← ${resp.status} ${payLog(raw)}`);
  if (!resp.ok || json?.success === false || json?.status === false || json?.error === true) {
    return { status: "failed", error: `${resp.status} ${kingsPassReason(json, raw)}`.trim(), response: raw.slice(0, 500) };
  }
  const a = json?.attendee ?? json?.data ?? json;
  return { status: "issued", attendeeId: a?.id != null ? String(a.id) : null, response: raw.slice(0, 500) };
}

/** Issues a paid purchase's tickets that aren't out yet, holding its row so no ticket goes out twice. */
async function issueTickets(id) {
  const client = await pool.connect();
  let row;
  let confirmedNow = false;
  try {
    await client.query("BEGIN");
    row = (await client.query(`SELECT * FROM registrations WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (row?.status === "paid") {
      const tickets = [];
      for (const t of row.tickets || []) {
        if (t.status === "issued") tickets.push(t);
        else tickets.push({ ticketId: t.ticketId, day: t.day || "", ...(await addKingsPassAttendee(row, t.ticketId)), at: new Date().toISOString() });
      }
      confirmedNow = tickets.length > 0 && tickets.every((t) => t.status === "issued");
      row = (await client.query(
        `UPDATE registrations SET tickets = $2, status = CASE WHEN $3 THEN 'confirmed' ELSE status END, issued_at = CASE WHEN $3 THEN now() ELSE issued_at END
          WHERE id = $1 RETURNING *`, [id, JSON.stringify(tickets), confirmedNow])).rows[0];
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (confirmedNow) passMessageLater(row.id);
  return row;
}

/**
 * Brings a purchase up to date: asks Espees about one it has charged but that isn't confirmed yet
 * (done, for this purchase's reference and full price: "paid"), then issues a paid one's KingsPass
 * tickets (all out: "confirmed", and the buyer hears on KingsChat). Safe to call again, and at the
 * same time. Returns the row, with `checkError` when Espees couldn't be asked.
 */
async function settleRegistration(id) {
  let r = await q1(`SELECT * FROM registrations WHERE id = $1`, [id]);
  // Only a charge made through Espees' payments API (purchases from before it have no payment_method).
  if (!r || !r.payment_ref || !r.payment_method) return r;
  if (r.status === "pending") {
    const t = await espeesTransaction(r.payment_ref);
    if (t.error) {
      console.error(`[expo] Espees transaction (${r.reference}) not checked: ${t.error}`);
      return { ...r, checkError: t.error };
    }
    const matches = (t.reference == null || String(t.reference) === r.payment_ref) && (t.amount == null || sameAmount(t.amount, r.pass_price));
    if (t.done && !matches) console.error(`[expo] Espees transaction ${r.payment_ref} (${r.reference}) is for ${t.amount}, not ${Number(r.pass_price)}: left pending`);
    const paid = t.done && matches;
    r = (await q1(
      `UPDATE registrations SET payment_status = $2, payment_checked_at = now(), status = CASE WHEN $3 AND status = 'pending' THEN 'paid' ELSE status END,
         paid_at = CASE WHEN $3 AND paid_at IS NULL THEN now() ELSE paid_at END WHERE id = $1 RETURNING *`,
      [id, paid ? "PAID" : t.done ? "MISMATCH" : "CHARGED", paid])) || r;
  }
  if (r.status === "paid") r = await issueTickets(id);
  return r;
}

/** The buyer's KingsChat message once their pass is confirmed. */
function passMessage(r) {
  const days = (r.pass_days || []).map(dayLabel);
  const n = (r.tickets || []).length;
  return compose([
    `🎟️ Your LoveWorld Expo 2026 ${PASSES[r.pass]?.name || r.pass} is confirmed!`,
    GAP,
    `Reference: ${r.reference}`,
    days.length ? `${days.length === 1 ? "Day" : "Days"}: ${days.join(", ")}` : null,
    `Ticket holder: ${[r.title, r.first_name, r.last_name].filter(Boolean).join(" ")}`,
    `Paid: ${amountLabel(r.pass_price)}`,
    GAP,
    `Your ${n === 1 ? "ticket is" : `${n} tickets are`} on KingsPass, issued to ${r.email}.`,
    site("/my-expo") && `Your passes: ${site("/my-expo")}`,
    site("/smartmeet") && `Book meetings with exhibitors: ${site("/smartmeet")}`,
  ]);
}

/** Tell the buyer on KingsChat, in the background (once: only the step to confirmed calls it). */
function passMessageLater(id) {
  setImmediate(async () => {
    try {
      const r = await q1(`SELECT r.*, u.kc_user_id, u.kc_id FROM registrations r JOIN users u ON u.id = r.user_id WHERE r.id = $1`, [id]);
      if (r) await deliver({ userId: r.user_id, kc: r.kc_user_id || r.kc_id, text: passMessage(r), kind: "pass:confirmed" }, { ref: r.reference });
    } catch (err) {
      console.error(`[expo] pass message (${id}) failed:`, err.message);
    }
  });
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
      event: { start: EVENT.start, end: EVENT.end, days: eventDays(), utcOffset: EVENT.offset, meetingMinutes: EVENT.meetingMinutes, dayStart: EVENT.dayStart, dayEnd: EVENT.dayEnd, lunchHour: EVENT.lunchHour, maxBookingsPerDay: EVENT.maxBookingsPerDay, rescheduleCutoffMinutes: EVENT.rescheduleCutoffMinutes },
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
    // A first sign-in made the account: welcome them on KingsChat.
    if (kc.created) welcomeLater(kc.userId);
    ok(res, { ...out, created: !!kc.created });
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

  // The profile: any of these fields (a field left out is kept), each trimmed to its length, and
  // christEmbassy (true or false): whether they're a member, so asked for their zone and church.
  const PROFILE_FIELDS = {
    title: ["title", 40], firstName: ["first_name", 80], lastName: ["last_name", 80], email: ["email", 200], phone: ["phone", 40],
    country: ["country", 80], zone: ["zone", 120], church: ["church", 200], organisation: ["organisation", 200], role: ["role", 80],
  };
  router.patch("/expo/me", ...user, asyncHandler(async (req, res) => {
    const b = req.body || {};
    const vals = [req.expoUserId];
    const sets = [];
    for (const [key, [col, max]] of Object.entries(PROFILE_FIELDS)) {
      if (b[key] === undefined) continue;
      vals.push(clean(b[key], max));
      sets.push(`${col} = $${vals.length}`);
    }
    if (b.christEmbassy !== undefined) {
      if (typeof b.christEmbassy !== "boolean") return fail(res, 400, "bad_membership", "Say whether you're a member of Christ Embassy.");
      vals.push(b.christEmbassy);
      sets.push(`christ_embassy = $${vals.length}`);
    }
    const email = b.email !== undefined ? clean(b.email, 200) : "";
    if (email && !isEmail(email)) return fail(res, 400, "invalid_email", "That email address does not look right.");
    if (sets.length) await q(`UPDATE users SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, vals);
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
    notifyLater(row.id, "booked");
    res.status(201);
    ok(res, { booking: shapeBooking(await q1(`${BOOKING_SELECT} WHERE b.id = $1`, [row.id])) });
  }));

  router.get("/expo/smartmeet/bookings/:id", ...user, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return fail(res, 404, "not_found", "No such booking.");
    const row = await q1(`${BOOKING_SELECT} WHERE b.id = $1 AND b.user_id = $2`, [req.params.id, req.expoUserId]);
    if (!row) return fail(res, 404, "not_found", "No such booking.");
    ok(res, { booking: shapeBooking(row) });
  }));

  // The visitor moves their meeting to another of the exhibitor's slots ({ start: "YYYY-MM-DDTHH:MM" }),
  // until EXPO_RESCHEDULE_CUTOFF_MINUTES (15) before it starts. Same exhibitor, same table; the old
  // slot is freed. Both sides get a KingsChat message with the old and new times.
  router.patch("/expo/smartmeet/bookings/:id", ...user, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return fail(res, 404, "not_found", "No such booking.");
    const current = await q1(`SELECT id, exhibitor_id, starts_at, ends_at, status FROM bookings WHERE id = $1 AND user_id = $2`, [req.params.id, req.expoUserId]);
    if (!current || current.status !== "confirmed") return fail(res, 404, "not_found", "No such booking, or it is cancelled.");
    const cutoff = EVENT.rescheduleCutoffMinutes;
    if (new Date(current.starts_at).getTime() - Date.now() < cutoff * 60000) {
      return fail(res, 409, "too_late", `Meetings can be moved until ${cutoff} minutes before they start.`);
    }
    const start = clean(req.body?.start, 19);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(start)) return fail(res, 400, "missing_fields", "Provide the new `start` time (YYYY-MM-DDTHH:MM).");
    const startLocal = start.length === 16 ? `${start}:00` : start;
    const date = startLocal.slice(0, 10);
    if (!isEventDay(date)) return fail(res, 400, "bad_date", `Pick a day of the Expo (${EVENT.start} to ${EVENT.end}).`);
    const ex = await q1(`${EXHIBITOR_SELECT} WHERE id = $1 AND active`, [current.exhibitor_id]);
    if (!ex || !ex.smartmeet) return fail(res, 404, "not_available", "That exhibitor is not taking SmartMeet bookings any more.");
    const slot = slotsFor(ex, date).find((x) => x.start === startLocal);
    if (!slot || !slot.available) return fail(res, 400, "bad_slot", "That time is not one of the exhibitor's meeting slots.");
    const startsAt = atEvent(slot.start);
    const endsAt = atEvent(slot.end);
    if (startsAt.getTime() === new Date(current.starts_at).getTime()) return fail(res, 400, "same_time", "That is the meeting's time already.");
    if (startsAt.getTime() - Date.now() < cutoff * 60000) return fail(res, 400, "bad_slot", `Pick a time at least ${cutoff} minutes from now.`);
    if (await q1(`SELECT 1 FROM bookings WHERE user_id = $1 AND status = 'confirmed' AND starts_at = $2 AND id <> $3`, [req.expoUserId, startsAt, current.id])) {
      return fail(res, 409, "double_booked", "You already have a meeting at that time.");
    }
    if (EVENT.maxBookingsPerDay) {
      const [from, to] = [atEvent(`${date}T00:00:00`), atEvent(`${date}T23:59:59`)];
      const n = (await q1(`SELECT count(*)::int AS n FROM bookings WHERE user_id = $1 AND status = 'confirmed' AND starts_at >= $2 AND starts_at < $3 AND id <> $4`, [req.expoUserId, from, to, current.id]))?.n || 0;
      if (n >= EVENT.maxBookingsPerDay) return fail(res, 409, "day_full", `You can hold ${EVENT.maxBookingsPerDay} meetings a day at most.`);
    }
    try {
      await q(`UPDATE bookings SET starts_at = $2, ends_at = $3, rescheduled_at = now(), reschedule_count = reschedule_count + 1 WHERE id = $1`, [current.id, startsAt, endsAt]);
    } catch (err) {
      if (err.code === "23505") return fail(res, 409, "slot_taken", "That slot has just been taken. Pick another time.");
      throw err;
    }
    notifyLater(current.id, "rescheduled", { from: { startsAt: current.starts_at, endsAt: current.ends_at } });
    ok(res, { booking: shapeBooking(await q1(`${BOOKING_SELECT} WHERE b.id = $1`, [current.id])) });
  }));

  // The visitor cancels their own meeting ({ reason }, optional). Both sides get a KingsChat message.
  router.delete("/expo/smartmeet/bookings/:id", ...user, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return fail(res, 404, "not_found", "No such booking.");
    const row = await q1(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'visitor', cancel_reason = NULLIF($3, '')
        WHERE id = $1 AND user_id = $2 AND status = 'confirmed' RETURNING id`, [req.params.id, req.expoUserId, clean(req.body?.reason, 500)]);
    if (!row) return fail(res, 404, "not_found", "No such booking, or it is already cancelled.");
    notifyLater(row.id, "cancelled");
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

  // Someone on the exhibitor's team cancels a meeting with it ({ reason }, optional): the slot is
  // free again, and the visitor and the team get a KingsChat message.
  router.delete("/expo/exhibitor/bookings/:id", ...exhibitorUser, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return fail(res, 404, "not_found", "No such booking.");
    const row = await q1(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'exhibitor', cancel_reason = NULLIF($3, '')
        WHERE id = $1 AND exhibitor_id = $2 AND status = 'confirmed' RETURNING id`, [req.params.id, req.expoExhibitor.id, clean(req.body?.reason, 500)]);
    if (!row) return fail(res, 404, "not_found", "No such booking with this exhibitor, or it is already cancelled.");
    const me = await getUserById(req.expoUserId);
    notifyLater(row.id, "cancelled", { byName: me?.name || (me?.username ? `@${me.username}` : "") });
    const out = await q1(`${BOOKING_SELECT.replace("FROM bookings b", ", u.kc_username AS username, u.kc_avatar AS avatar FROM bookings b LEFT JOIN users u ON u.id = b.user_id")} WHERE b.id = $1`, [row.id]);
    ok(res, { booking: { ...shapeBooking(out), username: out.username || null, avatar: out.avatar || null } });
  }));

  /* ---- forms ----------------------------------------------------------- */

  /** A registration as the person and the admin see it. */
  // A purchase (pending while Espees confirms it, paid, confirmed) also has its days, payment and
  // tickets. The admin also sees each ticket's KingsPass outcome.
  const shapeRegistration = (r, { admin = false } = {}) => ({
    id: r.id, reference: r.reference, userId: r.user_id, title: r.title || "", firstName: r.first_name, lastName: r.last_name, email: r.email, phone: r.phone,
    organisation: r.organisation, role: r.role, country: r.country, zone: r.zone, church: r.church || "", interests: r.interests, pass: r.pass, passDay: r.pass_day || "",
    passDays: Array.isArray(r.pass_days) && r.pass_days.length ? r.pass_days : r.pass_day ? [r.pass_day] : [],
    passPrice: Number(r.pass_price) || 0, passCurrency: r.pass_currency || "", status: r.status, createdAt: r.created_at,
    paymentStatus: r.payment_status || null, paymentMethod: r.payment_method || null, payer: r.payer || null, paymentError: r.payment_error || null, paidAt: r.paid_at || null, issuedAt: r.issued_at || null,
    tickets: (r.tickets || []).map((t) => ({ ticketId: t.ticketId, day: t.day || "", status: t.status, ...(admin ? { attendeeId: t.attendeeId || null, error: t.error || null, response: t.response || null, at: t.at || null } : {}) })),
  });

  // passDay: the day of a one-day pass; passPrice / passCurrency: the price the website quoted.
  // A free pass is confirmed at once; one with a price waits as pending until the Expo team confirms it.
  router.post("/expo/registrations", ...maybeUser, asyncHandler(async (req, res) => {
    const b = req.body || {};
    const email = clean(b.email, 200);
    const first = clean(b.firstName, 80);
    const last = clean(b.lastName, 80);
    if (!email || !isEmail(email)) return fail(res, 400, "invalid_email", "Enter a valid email address.");
    if (!first || !last) return fail(res, 400, "missing_fields", "Enter your first and last name.");
    const passDay = clean(b.passDay, 10);
    if (passDay && !isEventDay(passDay)) return fail(res, 400, "bad_date", `Pick a day of the Expo (${EVENT.start} to ${EVENT.end}).`);
    const price = Math.max(0, Math.round((Number(b.passPrice) || 0) * 100) / 100);
    const ref = reference("REG");
    const row = await q1(
      `INSERT INTO registrations (id, reference, user_id, first_name, last_name, email, phone, organisation, role, country, zone, interests, pass, pass_day, pass_price, pass_currency, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
      [crypto.randomUUID(), ref, req.expoUserId, first, last, email, clean(b.phone, 40), clean(b.organisation, 200), clean(b.role, 80), clean(b.country, 80), clean(b.zone, 120),
        JSON.stringify(list(b.interests)), clean(b.pass, 40), passDay, price, clean(b.passCurrency, 8).toUpperCase(), price > 0 ? "pending" : "confirmed"],
    );
    if (req.expoUserId) {
      await q(`UPDATE users SET email = COALESCE(email, $2), phone = CASE WHEN $3 <> '' THEN $3 ELSE phone END, organisation = CASE WHEN $4 <> '' THEN $4 ELSE organisation END,
                 role = CASE WHEN $5 <> '' THEN $5 ELSE role END, country = CASE WHEN $6 <> '' THEN $6 ELSE country END, zone = CASE WHEN $7 <> '' THEN $7 ELSE zone END, updated_at = now() WHERE id = $1`,
        [req.expoUserId, email, clean(b.phone, 40), clean(b.organisation, 200), clean(b.role, 80), clean(b.country, 80), clean(b.zone, 120)]);
    }
    res.status(201);
    ok(res, { reference: ref, id: row.id, createdAt: row.created_at, registration: shapeRegistration(row) });
  }));

  // The signed-in person's registrations, newest first.
  router.get("/expo/registrations", ...user, asyncHandler(async (req, res) => {
    const rows = await q(`SELECT * FROM registrations WHERE user_id = $1 ORDER BY created_at DESC`, [req.expoUserId]);
    ok(res, { registrations: rows.map(shapeRegistration) });
  }));

  /* ---- passes: bought with Espees, issued on KingsPass ----------------- */

  // { pass, days: ["2026-11-10", …] (the day and 3-day passes), expectedPrice, payment: { method:
  // "wallet", username, pin } or { method: "card", cardNum, pin } }. The ticket holder is the
  // signed-in person, from their profile. Espees is charged there and then (the PIN goes to Espees
  // and is never kept), and the answer comes as soon as it has taken the payment: 201 { registration }
  // (pending, CHARGED). The charge is then confirmed and the tickets issued in the background, as
  // /expo/passes/:id/confirm also does (the website's payment page calls it).
  router.post("/expo/passes/checkout", ...user, asyncHandler(async (req, res) => {
    if (!passesOnSale()) return fail(res, 503, "not_on_sale", "Passes can't be bought online yet.");
    const b = req.body || {};
    const u = await q1(`SELECT * FROM users WHERE id = $1`, [req.expoUserId]);
    if (!profileComplete(u)) return fail(res, 400, "profile_incomplete", "Complete your profile first: your ticket is issued in your name.");
    const passId = clean(b.pass, 40);
    const pass = Object.hasOwn(PASSES, passId) ? PASSES[passId] : null;
    if (!pass || (pass.adminOnly && !u.is_admin)) return fail(res, 400, "bad_pass", "Pick one of the passes on sale.");
    if (!pass.days && !pass.ticket) return fail(res, 503, "not_on_sale", `The ${pass.name} has no KingsPass ticket yet.`);
    const days = pass.days ? [...new Set(Array.isArray(b.days) ? b.days.map((d) => clean(d, 10)) : [])].sort() : [];
    if (pass.days && (days.length !== pass.days || !days.every(isEventDay) || !days.every((d) => KINGSPASS_DAY_TICKETS[d]))) {
      return fail(res, 400, "bad_days", `Pick ${pass.days === 1 ? "a day" : `${pass.days} different days`} of the Expo (${EVENT.start} to ${EVENT.end}).`);
    }
    if (b.expectedPrice != null && !sameAmount(b.expectedPrice, pass.price)) return fail(res, 409, "price_changed", `The ${pass.name} costs ${amountLabel(pass.price)}.`);
    const p = b.payment && typeof b.payment === "object" ? b.payment : {};
    const method = p.method === "card" ? "card" : "wallet";
    const pin = String(p.pin ?? "").trim().slice(0, 20);
    const username = clean(p.username, 120).replace(/^@/, "");
    const cardNum = String(p.cardNum ?? "").replace(/[\s-]/g, "").slice(0, 40);
    if (!pin || (method === "wallet" ? !username : !/^\d{8,40}$/.test(cardNum))) {
      return fail(res, 400, "missing_payment", method === "wallet" ? "Enter your Espees username and PIN." : "Enter your Espees card number and PIN.");
    }

    // One payment at a time for each person: the purchase is made, marked as with Espees, under a
    // lock, so a second Pay while the first is still with Espees is refused rather than charged.
    const id = crypto.randomUUID();
    const ref = reference("LWX");
    const tickets = passTickets(passId, days).map((t) => ({ ...t, status: "to_issue" }));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`expo-pay:${u.id}`]);
      const busy = (await client.query(`SELECT 1 FROM registrations WHERE user_id = $1 AND status = 'pending' AND payment_status = 'PROCESSING' AND created_at > now() - interval '2 minutes'`, [u.id])).rowCount;
      if (busy) {
        await client.query("ROLLBACK");
        return fail(res, 409, "payment_in_progress", "A payment of yours is already going through. Check My Expo in a moment.");
      }
      // The same pass, for the same days, paid (or possibly paid) in the last ten minutes: most likely
      // the same purchase again after the page lost its answer, so it isn't charged a second time.
      const recent = (await client.query(
        `SELECT 1 FROM registrations WHERE user_id = $1 AND pass = $2 AND pass_days = $3::jsonb AND created_at > now() - interval '10 minutes'
           AND (status IN ('paid', 'confirmed') OR payment_status IN ('CHARGED', 'UNKNOWN', 'MISMATCH'))`, [u.id, passId, JSON.stringify(days)])).rowCount;
      if (recent) {
        await client.query("ROLLBACK");
        return fail(res, 409, "already_paid", `You paid for this ${pass.name} a few minutes ago, so you haven't been charged again. See it in My Expo.`);
      }
      await client.query(
        `INSERT INTO registrations (id, reference, user_id, title, first_name, last_name, email, phone, organisation, role, country, zone, church, pass, pass_day, pass_days, pass_price, pass_currency, tickets, status,
           payment_status, payment_method, payer)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'ESPEES', $18, 'pending', 'PROCESSING', $19, $20)`,
        [id, ref, u.id, u.title, u.first_name, u.last_name, u.email, u.phone, u.organisation || "", u.role || "", u.country, u.zone || "", u.church || "",
          passId, days.length === 1 ? days[0] : "", JSON.stringify(days), pass.price, JSON.stringify(tickets), method, method === "wallet" ? `@${username}` : `card ****${cardNum.slice(-4)}`]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const charge = await chargeEspees({ reference: ref, pass_price: pass.price }, { method, username, cardNum, pin });
    if (charge.declined || charge.unavailable) {
      await q(`UPDATE registrations SET status = 'cancelled', payment_status = 'DECLINED', payment_error = $2 WHERE id = $1`, [id, charge.declined || `unreachable: ${charge.unavailable}`]);
      return charge.declined
        ? fail(res, 402, "payment_declined", charge.declined)
        : fail(res, 502, "payment_unavailable", "Espees couldn't be reached, so nothing was taken. Please try again in a moment.");
    }
    if (charge.unknown) {
      console.error(`[expo] checkout ${ref}: can't tell whether Espees took the payment (${charge.unknown})`);
      await q(`UPDATE registrations SET payment_status = 'UNKNOWN', payment_error = $2 WHERE id = $1`, [id, charge.unknown]);
      return fail(res, 502, "payment_unknown", "We couldn't tell whether Espees took the payment. Please don't pay again: check My Expo in a few minutes, or message us on KingsChat.");
    }
    const r = await q1(`UPDATE registrations SET payment_ref = $2, payment_status = 'CHARGED' WHERE id = $1 RETURNING *`, [id, charge.reference]);
    res.status(201);
    ok(res, { registration: shapeRegistration(r) });
    setImmediate(() => settleRegistration(id).catch((err) => console.error(`[expo] settling ${ref}: ${err.message}`)));
  }));

  // The person's own purchase, brought up to date: the payment checked with Espees, the tickets
  // issued once it's paid. checkError: Espees couldn't be asked this time.
  router.post("/expo/passes/:id/confirm", ...user, asyncHandler(async (req, res) => {
    const mine = isUuid(req.params.id) && (await q1(`SELECT id FROM registrations WHERE id = $1 AND user_id = $2`, [req.params.id, req.expoUserId]));
    if (!mine) return fail(res, 404, "not_found", "No such purchase.");
    const r = await settleRegistration(mine.id);
    ok(res, { registration: shapeRegistration(r), ...(r.checkError ? { checkError: "Espees couldn't be reached to check the payment. Try again in a moment." } : {}) });
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

  // A page view from the website: only a tidy page address is counted ("/programme/eagles-nest",
  // never a query or anything typed in), and at most PAGE_VIEW_PATHS different pages a day, so the
  // table can't be flooded. The site sends it with the app key; nothing about the visitor is kept.
  const PAGE_VIEW_PATHS = 300;
  router.post("/expo/views", requireAppKey, asyncHandler(async (req, res) => {
    const raw = clean(req.body?.path, 200).split(/[?#]/)[0];
    const path = raw.replace(/\/+$/, "") || (raw ? "/" : "");
    if (path !== "/" && !/^\/[a-z0-9-]+(\/[a-z0-9-]+){0,3}$/.test(path)) return fail(res, 400, "bad_path", "That isn't a page on the site.");
    // The admin area, the site's own endpoints and the steps of signing in aren't pages people visit.
    if (/^\/(admin|api|auth)(\/|$)/.test(path)) return fail(res, 400, "bad_path", "Those pages aren't counted.");
    const day = localTime(new Date()).slice(0, 10);
    const row = await q1(
      `INSERT INTO page_views (day, path, views)
       SELECT $1::date, $2::text, 1 WHERE EXISTS (SELECT 1 FROM page_views WHERE day = $1::date AND path = $2::text) OR (SELECT count(*) FROM page_views WHERE day = $1::date) < $3::int
       ON CONFLICT (day, path) DO UPDATE SET views = page_views.views + 1 RETURNING views`,
      [day, path, PAGE_VIEW_PATHS],
    );
    ok(res, { counted: !!row });
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

  const shapeAdminUser = (r) => ({ ...shapeUser(r), disabled: !!r.disabled_at, disabledReason: r.disabled_reason || "", exhibitor: r.exhibitor_id ? { id: r.exhibitor_id, name: r.exhibitor_name } : null });
  const ADMIN_USER_SELECT = `SELECT u.*, e.name AS exhibitor_name FROM users u LEFT JOIN exhibitors e ON e.id = u.exhibitor_id`;

  router.get("/expo/admin/stats", requireAdmin, asyncHandler(async (_req, res) => {
    const row = await q1(`SELECT (SELECT count(*)::int FROM users) AS users, (SELECT count(*)::int FROM exhibitors) AS exhibitors,
      (SELECT count(*)::int FROM bookings WHERE status = 'confirmed') AS bookings, (SELECT count(*)::int FROM registrations) AS registrations,
      (SELECT count(*)::int FROM sponsor_enquiries) AS enquiries, (SELECT count(*)::int FROM program_applications) AS applications`);
    ok(res, { stats: row });
  }));

  // Page views over the last ?days= days (30 by default, up to a year), to today on the event's clock:
  // each day's total (days with none included), each page's total, and the total since counting began.
  router.get("/expo/admin/page-views", requireAdmin, asyncHandler(async (req, res) => {
    const span = Math.min(366, Math.max(1, Math.floor(Number(req.query.days)) || 30));
    const to = localTime(new Date()).slice(0, 10);
    const from = new Date(Date.parse(`${to}T00:00:00Z`) - (span - 1) * 86_400_000).toISOString().slice(0, 10);
    const rows = await q(`SELECT day::text AS day, path, views FROM page_views WHERE day BETWEEN $1::date AND $2::date`, [from, to]);
    const all = await q1(`SELECT coalesce(sum(views), 0)::int AS views, min(day)::text AS since FROM page_views`);
    const byDay = new Map();
    const byPath = new Map();
    for (const r of rows) {
      byDay.set(r.day, (byDay.get(r.day) || 0) + r.views);
      byPath.set(r.path, (byPath.get(r.path) || 0) + r.views);
    }
    const days = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
      const day = new Date(t).toISOString().slice(0, 10);
      days.push({ day, views: byDay.get(day) || 0 });
    }
    const pages = [...byPath].map(([path, views]) => ({ path, views })).sort((a, b) => b.views - a.views || a.path.localeCompare(b.path));
    ok(res, { from, to, total: days.reduce((n, d) => n + d.views, 0), days, pages, allTime: { views: all.views, since: all.since } });
  }));

  // ?q= searches name (KingsChat's and the profile's), username and email; ?exhibitor= is one exhibitor's team.
  router.get("/expo/admin/users", requireAdmin, asyncHandler(async (req, res) => {
    const needle = clean(req.query.q, 100).toLowerCase();
    const exhibitor = clean(req.query.exhibitor, 80);
    const rows = await q(`${ADMIN_USER_SELECT} WHERE ($1 = '' OR lower(coalesce(u.kc_username,'') || ' ' || coalesce(u.kc_name,'') || ' ' || coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'') || ' ' || coalesce(u.email,'')) LIKE '%' || $1 || '%')
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

  // `disabled` (with `reason`) disables or restores the account; `admin` grants or takes away the
  // admin area. Each is applied only when given. The last admin cannot be taken away.
  router.post("/expo/admin/users/:id", requireAdmin, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return fail(res, 404, "not_found", "No such account.");
    const b = req.body || {};
    if (!(await q1(`SELECT 1 FROM users WHERE id = $1`, [req.params.id]))) return fail(res, 404, "not_found", "No such account.");
    if (b.disabled !== undefined) {
      const disabled = !!b.disabled;
      await q(`UPDATE users SET disabled_at = CASE WHEN $2 THEN coalesce(disabled_at, now()) ELSE NULL END, disabled_reason = CASE WHEN $2 THEN $3 ELSE NULL END, updated_at = now() WHERE id = $1`, [req.params.id, disabled, clean(b.reason, 300) || null]);
      if (disabled) await q(`DELETE FROM refresh_tokens WHERE user_id = $1`, [req.params.id]);
    }
    if (b.admin !== undefined) {
      const admin = !!b.admin;
      if (!admin) {
        const others = await q1(`SELECT 1 FROM users WHERE is_admin AND disabled_at IS NULL AND id <> $1 LIMIT 1`, [req.params.id]);
        const isAdmin = await q1(`SELECT 1 FROM users WHERE id = $1 AND is_admin`, [req.params.id]);
        if (isAdmin && !others) return fail(res, 409, "last_admin", "This is the only admin account. Make another account an admin first.");
      }
      await q(`UPDATE users SET is_admin = $2, updated_at = now() WHERE id = $1`, [req.params.id, admin]);
    }
    const user = await q1(`${ADMIN_USER_SELECT} WHERE u.id = $1`, [req.params.id]);
    ok(res, { user: shapeAdminUser(user), disabled: !!user.disabled_at, admin: !!user.is_admin });
  }));

  // Deletes an account and everything it made, all or nothing: its SmartMeet meetings (the slots
  // free up; exhibitors are not messaged), passes, programme applications, sponsor enquiries, its
  // entries in the message log and its sign-ins. The last admin cannot be deleted. Says how many
  // of each went.
  router.delete("/expo/admin/users/:id", requireAdmin, asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) return fail(res, 404, "not_found", "No such account.");
    const user = await q1(`SELECT is_admin FROM users WHERE id = $1`, [id]);
    if (!user) return fail(res, 404, "not_found", "No such account.");
    if (user.is_admin && !(await q1(`SELECT 1 FROM users WHERE is_admin AND disabled_at IS NULL AND id <> $1 LIMIT 1`, [id]))) {
      return fail(res, 409, "last_admin", "This is the only admin account. Make another account an admin first.");
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const count = async (sql) => (await client.query(sql, [id])).rowCount;
      const removed = {
        bookings: await count(`DELETE FROM bookings WHERE user_id = $1`),
        registrations: await count(`DELETE FROM registrations WHERE user_id = $1`),
        applications: await count(`DELETE FROM program_applications WHERE user_id = $1`),
        enquiries: await count(`DELETE FROM sponsor_enquiries WHERE user_id = $1`),
        messages: await count(`DELETE FROM notifications WHERE user_id = $1`),
      };
      await client.query(`DELETE FROM users WHERE id = $1`, [id]);
      await client.query("COMMIT");
      ok(res, { deleted: id, removed });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
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

  // ?pass= and ?status= narrow the list.
  // The KingsChat messages sent about bookings, newest first (?booking=<id> for one booking's).
  router.get("/expo/admin/notifications", requireAdmin, asyncHandler(async (req, res) => {
    const booking = isUuid(req.query.booking) ? req.query.booking : null;
    const rows = await q(
      `SELECT n.*, b.reference, u.kc_username, u.kc_name FROM notifications n LEFT JOIN bookings b ON b.id = n.booking_id LEFT JOIN users u ON u.id = n.user_id
        WHERE $1::uuid IS NULL OR n.booking_id = $1 ORDER BY n.created_at DESC, n.id DESC LIMIT $2`, [booking, limit(req, 2000)]);
    ok(res, { notifications: rows.map((r) => ({ id: Number(r.id), bookingId: r.booking_id, reference: r.reference, kind: r.kind, user: r.user_id ? { id: r.user_id, username: r.kc_username, name: r.kc_name } : null,
      recipientKcId: r.recipient_kc_id, status: r.status, error: r.error, kcMessageId: r.kc_message_id, body: r.body, createdAt: r.created_at, sentAt: r.sent_at })) });
  }));

  router.get("/expo/admin/registrations", requireAdmin, asyncHandler(async (req, res) => {
    const pass = clean(req.query.pass, 40);
    const status = clean(req.query.status, 20);
    const rows = await q(`SELECT * FROM registrations WHERE ($1 = '' OR pass = $1) AND ($2 = '' OR status = $2) ORDER BY created_at DESC LIMIT $3`, [pass, status, limit(req, 5000)]);
    ok(res, { registrations: rows.map((r) => shapeRegistration(r, { admin: true })) });
  }));

  // Any purchase brought up to date (as /expo/passes/:id/confirm): to retry tickets KingsPass refused.
  router.post("/expo/admin/registrations/:id/settle", requireAdmin, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return fail(res, 404, "not_found", "No such registration.");
    const r = await settleRegistration(req.params.id);
    if (!r) return fail(res, 404, "not_found", "No such registration.");
    ok(res, { registration: shapeRegistration(r, { admin: true }), ...(r.checkError ? { checkError: r.checkError } : {}) });
  }));

  router.get("/expo/admin/enquiries", requireAdmin, asyncHandler(async (req, res) => {
    const rows = await q(`SELECT * FROM sponsor_enquiries ORDER BY created_at DESC LIMIT $1`, [limit(req, 5000)]);
    ok(res, { enquiries: rows.map((r) => ({ id: r.id, reference: r.reference, userId: r.user_id, name: r.name, email: r.email, organisation: r.organisation, role: r.role, interest: r.interest, programs: r.programs, message: r.message, status: r.status, createdAt: r.created_at })) });
  }));

  // ?program= and ?status= narrow the list.
  router.get("/expo/admin/applications", requireAdmin, asyncHandler(async (req, res) => {
    const program = slug(req.query.program || "");
    const status = clean(req.query.status, 20);
    const rows = await q(`SELECT * FROM program_applications WHERE ($1 = '' OR program = $1) AND ($2 = '' OR status = $2) ORDER BY created_at DESC LIMIT $3`, [program, status, limit(req, 5000)]);
    ok(res, { applications: rows.map((r) => ({ id: r.id, reference: r.reference, userId: r.user_id, program: r.program, name: r.name, email: r.email, organisation: r.organisation, summary: r.summary, data: r.data, status: r.status, createdAt: r.created_at })) });
  }));

  const STATUSES = { enquiries: ["new", "contacted", "closed"], applications: ["submitted", "shortlisted", "accepted", "declined"], registrations: ["pending", "confirmed", "cancelled"] };
  const STATUS_TABLES = { enquiries: "sponsor_enquiries", applications: "program_applications", registrations: "registrations" };
  router.post("/expo/admin/:kind/:id", requireAdmin, asyncHandler(async (req, res, next) => {
    if (!STATUSES[req.params.kind]) return next();
    if (!isUuid(req.params.id)) return fail(res, 404, "not_found", "No such record.");
    const status = clean(req.body?.status, 20);
    if (!STATUSES[req.params.kind].includes(status)) return fail(res, 400, "bad_status", `status must be one of ${STATUSES[req.params.kind].join(", ")}.`);
    const table = STATUS_TABLES[req.params.kind];
    const row = await q1(`UPDATE ${table} SET status = $2 WHERE id = $1 RETURNING id, status`, [req.params.id, status]);
    if (!row) return fail(res, 404, "not_found", "No such record.");
    ok(res, row);
  }));

  return router;
};

module.exports.ensureSchema = ensureSchema;
/** Which pass settings are there (names only, never values), for the dev server's start-up line. */
module.exports.passesSetup = () => ({ onSale: passesOnSale(), missing: [["EXPO_ESPEES_API_TOKEN", ESPEES_API_TOKEN], ["EXPO_KINGSPASS_URL", KINGSPASS_URL], ["EXPO_KINGSPASS_EVENT_TOKEN", KINGSPASS_EVENT_TOKEN]].filter(([, v]) => !v).map(([k]) => k), kingspass: KINGSPASS_URL, debug: payDebug() });
module.exports.notifyBooking = notifyBooking;
module.exports.pool = pool;
module.exports.upsertExhibitor = upsertExhibitor;
module.exports.exhibitorFields = exhibitorFields;
module.exports.eventDays = eventDays;
