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
//   recording_summaries  a recording's summary, written by the AI from its transcript (kept by recording)
//   releases         KingsPresenter's installers, one per version and platform, for updates
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
// Recordings' summaries: written by the API's OpenAI client (server.js) with this model; a
// transcript longer than this (characters) is refused rather than sent.
const SUMMARY_MODEL = env("KP_SUMMARY_MODEL") || "gpt-4.1-mini";
const SUMMARY_MAX_CHARS = Number(env("KP_SUMMARY_MAX_CHARS") || 600000);
// Updates: the installers (outside the project: pm2 restarts on changes inside it), the key the
// build uploads them with (unset: no uploads), the largest installer, and this API's public
// address up to the mount point (e.g. https://nmt.loveworldapis.com/api) for the file links.
const RELEASES_DIR = path.resolve(env("KP_RELEASES_DIR") || path.join(os.homedir(), "kingspresenter-releases"));
const UPLOAD_KEY = env("KP_UPDATE_UPLOAD_KEY") || "";
const MAX_RELEASE = Number(env("KP_MAX_RELEASE_MB") || 1024) * 1024 * 1024;
const PUBLIC_URL = (env("KP_PUBLIC_URL") || "").replace(/\/+$/, "");
const PLATFORMS = new Set(["darwin", "win32"]);
const ARCHES = new Set(["arm64", "x64"]);

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

  CREATE TABLE IF NOT EXISTS recording_summaries (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recording_id TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'en',
    transcript_sha256 TEXT NOT NULL,
    summary JSONB NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, recording_id)
  );

  CREATE TABLE IF NOT EXISTS releases (
    id SERIAL PRIMARY KEY,
    version TEXT NOT NULL,
    platform TEXT NOT NULL,
    arch TEXT NOT NULL,
    filename TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    bytes BIGINT NOT NULL DEFAULT 0,
    sha256 TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    active BOOLEAN NOT NULL DEFAULT true,
    released_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (version, platform, arch)
  );

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
 * Recording summaries (the AI)
 * ------------------------------------------------------------------------- */

// What the AI is told (KingsPresenter's docs/recording-ai/prompt.md, kept in step with it).
const SUMMARY_PROMPT = `You summarise the transcript of a recording made in church: a sermon, a teaching, a meeting.

The transcript is the recording's audio as live speech recognition wrote it, line by line. Each line
has t, the seconds from the start of the recording. Expect recognition errors: misheard words
("Mac 16 verse 15" for Mark 16:15, "the book of Divisions" for Ephesians), missing punctuation,
repeated words. language is the language spoken (English when absent).

Return one JSON object that follows the schema, and nothing else.

What to produce
- title: what the recording was about, in a few words.
- summary.short: one sentence. summary.full: two or three short paragraphs.
- keyPoints: the main points made, in order (at most eight), each with the time it was made and the
  scriptures it rests on.
- scriptures: every passage mentioned, read or quoted, once each, in the order first mentioned:
  reference in English book names ("1 John 4:9", "Ephesians 3:17-19"); bookId as a USFM code
  (GEN ... REV, 1JN, 2CO); chapter, verse, verseEnd (null for a single verse; verse is null for a
  whole chapter); mentions (each time it came up: its time and the words as heard); a note when the
  reference had to be worked out (misheard, or quoted without a reference).
- decisions: what was agreed. actionItems: who is to do what, by when. openQuestions: what was
  left for later. Empty lists when there were none (a sermon).
- speakers: only names actually said; null for someone not named. themes: three to six.

Rules
1. Never invent. Every point, decision, task, name, date and scripture must come from the
   transcript. When something is unclear, leave it out or say so in a note.
2. A scripture counts when a reference is said, or when its words are read or quoted closely enough
   to be sure which verse it is. Check each one against the words read nearby: "Mac 16 verse 15"
   followed by "go ye into all the world and preach the gospel" is Mark 16:15.
3. Times: t in seconds exactly as in the transcript line where it happened; time as m:ss (h:mm:ss
   over an hour).
4. Write in the recording's language; scripture references always use English book names so the
   app can read them.
5. Keep it short: the whole summary should take two minutes to read.`;

// The shape of the answer (docs/recording-ai/response.schema.json), given to the model as its output format.
const moment = { t: { type: "number" }, time: { type: "string" } };
const SUMMARY_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["version", "language", "title", "summary", "keyPoints", "scriptures", "decisions", "actionItems", "openQuestions", "speakers", "themes"],
  properties: {
    version: { type: "integer" },
    language: { type: "string" },
    title: { type: "string" },
    summary: { type: "object", additionalProperties: false, required: ["short", "full"], properties: { short: { type: "string" }, full: { type: "string" } } },
    keyPoints: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false, required: ["point", "t", "time", "scriptures"], properties: { point: { type: "string" }, ...moment, scriptures: { type: "array", items: { type: "string" } } } } },
    scriptures: { type: "array", items: { type: "object", additionalProperties: false, required: ["reference", "bookId", "chapter", "verse", "verseEnd", "mentions"],
      properties: { reference: { type: "string" }, bookId: { type: "string" }, chapter: { type: "integer" }, verse: { type: ["integer", "null"] }, verseEnd: { type: ["integer", "null"] },
        mentions: { type: "array", items: { type: "object", additionalProperties: false, required: ["t", "time", "said"], properties: { ...moment, said: { type: "string" } } } }, note: { type: "string" } } } },
    decisions: { type: "array", items: { type: "object", additionalProperties: false, required: ["decision", "t", "time"], properties: { decision: { type: "string" }, ...moment } } },
    actionItems: { type: "array", items: { type: "object", additionalProperties: false, required: ["task", "owner", "due", "t", "time"], properties: { task: { type: "string" }, owner: { type: ["string", "null"] }, due: { type: ["string", "null"] }, ...moment } } },
    openQuestions: { type: "array", items: { type: "object", additionalProperties: false, required: ["question", "t", "time"], properties: { question: { type: "string" }, ...moment } } },
    speakers: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "role"], properties: { name: { type: ["string", "null"] }, role: { type: "string" } } } },
    themes: { type: "array", maxItems: 6, items: { type: "string" } },
  },
};

/** The transcript as posted, checked: [{ t, text }] or a reason it is not one. */
function readTranscript(body) {
  const lines = Array.isArray(body?.transcript) ? body.transcript : null;
  if (!lines || !lines.length) return { error: "The body needs a transcript: a list of { t, text } lines." };
  const transcript = [];
  let chars = 0;
  for (const l of lines) {
    const t = Number(l?.t);
    const text = clean(l?.text, 20000);
    if (!Number.isFinite(t) || t < 0) return { error: "Every transcript line needs t, its seconds from the start." };
    if (!text) continue;
    chars += String(l.text).length;
    transcript.push({ t: Math.round(t * 10) / 10, text });
  }
  if (!transcript.length) return { error: "The transcript has no words in it." };
  if (chars > SUMMARY_MAX_CHARS) return { tooLong: true, error: `The transcript is too long for one summary (${chars} characters; up to ${SUMMARY_MAX_CHARS}).` };
  return { transcript, language: /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(String(body.language || "")) ? String(body.language).slice(0, 2).toLowerCase() : "en" };
}

/** The model's answer, checked and tidied into the summary's shape (missing lists become empty). */
function shapeSummary(raw, language) {
  const a = raw && typeof raw === "object" ? raw : {};
  const str = (v, max = 4000) => clean(v, max);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const intOrNull = (v) => (v == null || v === "" ? null : Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const list = (v) => (Array.isArray(v) ? v : []);
  const summary = a.summary && typeof a.summary === "object" ? a.summary : {};
  const out = {
    version: 1,
    language: str(a.language, 8) || language,
    title: str(a.title, 200),
    summary: { short: str(summary.short, 1000), full: str(summary.full, 8000) },
    keyPoints: list(a.keyPoints).slice(0, 8).map((p) => ({ point: str(p?.point, 600), t: num(p?.t), time: str(p?.time, 12), scriptures: list(p?.scriptures).map((x) => str(x, 60)).filter(Boolean) })).filter((p) => p.point),
    scriptures: list(a.scriptures).map((x) => ({
      reference: str(x?.reference, 80), bookId: str(x?.bookId, 3).toUpperCase(), chapter: Math.max(1, Math.round(num(x?.chapter)) || 1), verse: intOrNull(x?.verse), verseEnd: intOrNull(x?.verseEnd),
      mentions: list(x?.mentions).map((m) => ({ t: num(m?.t), time: str(m?.time, 12), said: str(m?.said, 600) })),
      ...(x?.note ? { note: str(x.note, 400) } : {}),
    })).filter((x) => x.reference && /^[1-3A-Z][A-Z0-9]{2}$/.test(x.bookId)),
    decisions: list(a.decisions).map((d) => ({ decision: str(d?.decision, 600), t: num(d?.t), time: str(d?.time, 12) })).filter((d) => d.decision),
    actionItems: list(a.actionItems).map((x) => ({ task: str(x?.task, 600), owner: x?.owner == null ? null : str(x.owner, 200) || null, due: x?.due == null ? null : str(x.due, 200) || null, t: num(x?.t), time: str(x?.time, 12) })).filter((x) => x.task),
    openQuestions: list(a.openQuestions).map((x) => ({ question: str(x?.question, 600), t: num(x?.t), time: str(x?.time, 12) })).filter((x) => x.question),
    speakers: list(a.speakers).map((x) => ({ name: x?.name == null ? null : str(x.name, 120) || null, role: str(x?.role, 200) })).filter((x) => x.role || x.name),
    themes: list(a.themes).slice(0, 6).map((x) => str(x, 80)).filter(Boolean),
  };
  if (!out.title || !out.summary.full && !out.summary.short) return null;
  return out;
}

/** Asks the model for the summary; throws { statusCode, code } when it cannot. */
async function writeSummary(openai, { recordingId, language, transcript }) {
  let resp;
  try {
    resp = await openai.chat.completions.create({
      model: SUMMARY_MODEL,
      temperature: 0.2,
      response_format: { type: "json_schema", json_schema: { name: "recording_summary", schema: SUMMARY_SCHEMA } },
      messages: [
        { role: "system", content: SUMMARY_PROMPT },
        { role: "user", content: JSON.stringify({ recordingId, language, transcript }) },
      ],
    });
  } catch (err) {
    const busy = err?.status === 429 || err?.status >= 500;
    throw Object.assign(new Error(busy ? "The AI service is busy; try again in a moment." : `The AI could not summarise this recording: ${err?.message || err}`), { statusCode: busy ? 503 : 502, code: busy ? "ai_busy" : "ai_failed" });
  }
  const text = resp?.choices?.[0]?.message?.content;
  let parsed = null;
  try { parsed = JSON.parse(String(text || "").replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { /* not JSON */ }
  const summary = shapeSummary(parsed, language);
  if (!summary) throw Object.assign(new Error("The AI sent back no summary."), { statusCode: 502, code: "ai_failed" });
  return summary;
}

/* ---------------------------------------------------------------------------
 * Updates
 * ------------------------------------------------------------------------- */

/** Version a is newer than b: "0.2.0" > "0.1.9" (a "v" in front and a "-beta" tail ignored). */
function newer(a, b) {
  const parts = (v) => String(v || "").replace(/^v/i, "").split("-")[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

/** The address an app downloads a release from: KP_PUBLIC_URL, else this request's own host. */
function releaseUrl(req, r) {
  const base = PUBLIC_URL || `${req.protocol}://${req.get("host")}${req.baseUrl || ""}`;
  return `${base}/kp/updates/files/${encodeURIComponent(r.version)}/${r.platform}/${r.arch}`;
}
const shapeRelease = (req, r) => ({ version: r.version, platform: r.platform, arch: r.arch, filename: r.filename, size: Number(r.bytes), sha256: r.sha256, notes: r.notes, releasedAt: r.released_at, url: releaseUrl(req, r) });

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

module.exports = function kingsPresenterRoutes({ openai = null } = {}) {
  const router = Router();
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  fs.mkdirSync(RELEASES_DIR, { recursive: true });

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
  /* ---- Recordings: summaries by the AI ------------------------------- */

  // A recording's transcript (KingsPresenter posts it when a recording stops): its summary,
  // written by the AI and kept by recording id; the same transcript again costs nothing.
  router.post("/kp/recordings/summary", ...user, asyncHandler(async (req, res) => {
    if (!openai) return fail(res, 503, "summaries_off", "This server has no AI service for summaries (OPENAI_API_KEY is not set).");
    const read = readTranscript(req.body || {});
    if (read.error) return fail(res, read.tooLong ? 413 : 400, read.tooLong ? "too_long" : "bad_request", read.error);
    const { transcript, language } = read;
    const hash = sha256(JSON.stringify(transcript));
    const recordingId = clean(req.body.recordingId, 80) || `t-${hash.slice(0, 32)}`;
    const kept = await q1(`SELECT summary FROM recording_summaries WHERE user_id = $1 AND recording_id = $2 AND transcript_sha256 = $3`, [req.kpUserId, recordingId, hash]);
    if (kept) return ok(res, { ...kept.summary, cached: true });
    let summary;
    try { summary = await writeSummary(openai, { recordingId, language, transcript }); } catch (err) { if (!err.code) throw err; return fail(res, err.statusCode || 502, err.code, err.message); }
    await q(`INSERT INTO recording_summaries (user_id, recording_id, language, transcript_sha256, summary, model) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (user_id, recording_id) DO UPDATE SET language = EXCLUDED.language, transcript_sha256 = EXCLUDED.transcript_sha256, summary = EXCLUDED.summary, model = EXCLUDED.model, created_at = now()`,
      [req.kpUserId, recordingId, language, hash, JSON.stringify(summary), SUMMARY_MODEL]);
    ok(res, summary);
  }));

  router.get("/kp/recordings/summary/:recordingId", ...user, asyncHandler(async (req, res) => {
    const kept = await q1(`SELECT summary, created_at FROM recording_summaries WHERE user_id = $1 AND recording_id = $2`, [req.kpUserId, clean(req.params.recordingId, 80)]);
    if (!kept) return fail(res, 404, "not_found", "No summary for that recording.");
    ok(res, { ...kept.summary, createdAt: kept.created_at });
  }));

  /* ---- Updates: the installers ---------------------------------------- */

  // The build sends each installer here (scripts/update-upload.js in KingsPresenter): the
  // file as the body, its version, platform, hash and notes in headers. Streamed to disk,
  // not held in memory; a file whose hash does not match is thrown away.
  router.put("/kp/updates/upload", asyncHandler(async (req, res) => {
    if (!UPLOAD_KEY) return fail(res, 503, "uploads_off", "KP_UPDATE_UPLOAD_KEY is not set on this server.");
    const key = clean(req.header("x-upload-key"), 200);
    if (!key || !safeEqual(key, UPLOAD_KEY)) { req.resume(); return fail(res, 401, "unauthorized_upload_key", "Invalid or missing x-upload-key."); }
    const version = clean(req.header("x-version"), 40);
    const platform = clean(req.header("x-platform"), 20);
    const arch = clean(req.header("x-arch"), 20);
    const sha = clean(req.header("x-sha256"), 64).toLowerCase();
    const filename = clean(req.header("x-filename"), 200).replace(/[^\w .()+-]+/g, "") || `KingsPresenter-${version}-${arch}.${platform === "darwin" ? "dmg" : "exe"}`;
    let notes = "";
    try { notes = clean(Buffer.from(clean(req.header("x-notes"), 60000), "base64").toString("utf8"), 20000); } catch { notes = ""; }
    const bad = !/^\d+\.\d+\.\d+/.test(version) ? "x-version must be a version, e.g. 0.1.2."
      : !PLATFORMS.has(platform) ? "x-platform must be darwin or win32."
      : !ARCHES.has(arch) ? "x-arch must be arm64 or x64."
      : !/^[a-f0-9]{64}$/.test(sha) ? "x-sha256 must be the file's SHA-256." : "";
    if (bad) { req.resume(); return fail(res, 400, "bad_request", bad); }
    if (Number(req.header("content-length")) > MAX_RELEASE) { req.resume(); return fail(res, 413, "too_large", `An installer may be up to ${MAX_RELEASE / 1024 / 1024} MB.`); }
    const dir = path.join(RELEASES_DIR, version);
    await fsp.mkdir(dir, { recursive: true });
    const storageKey = `${version}/${platform}-${arch}-${filename}`;
    const file = path.join(RELEASES_DIR, storageKey);
    const part = `${file}.part`;
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    try {
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(part);
        req.on("data", (c) => { hash.update(c); bytes += c.length; if (bytes > MAX_RELEASE) req.destroy(Object.assign(new Error("too large"), { code: "too_large" })); });
        req.on("error", reject);
        req.on("aborted", () => reject(new Error("The upload stopped early.")));
        out.on("error", reject);
        out.on("finish", resolve);
        req.pipe(out);
      });
      if (!bytes) throw Object.assign(new Error("The upload was empty."), { code: "empty_upload" });
      if (hash.digest("hex") !== sha) throw Object.assign(new Error("The file does not match its hash."), { code: "hash_mismatch" });
    } catch (err) {
      await fsp.rm(part, { force: true });
      const code = err.code === "too_large" ? "too_large" : err.code === "hash_mismatch" ? "hash_mismatch" : err.code === "empty_upload" ? "empty_upload" : "upload_failed";
      return fail(res, code === "too_large" ? 413 : 400, code, err.message);
    }
    await fsp.rename(part, file);
    const row = await q1(
      `INSERT INTO releases (version, platform, arch, filename, storage_key, bytes, sha256, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (version, platform, arch) DO UPDATE SET filename = EXCLUDED.filename, storage_key = EXCLUDED.storage_key, bytes = EXCLUDED.bytes,
         sha256 = EXCLUDED.sha256, notes = EXCLUDED.notes, active = true, released_at = now()
       RETURNING *`,
      [version, platform, arch, filename, storageKey, bytes, sha, notes]);
    // An older file this one replaced (a different name for the same version and platform) goes.
    for (const f of await fsp.readdir(dir).catch(() => [])) if (f.startsWith(`${platform}-${arch}-`) && f !== `${platform}-${arch}-${filename}`) await fsp.rm(path.join(dir, f), { force: true });
    res.status(201);
    ok(res, { release: shapeRelease(req, row) });
  }));

  const latestFor = async (platform, arch) => {
    let best = null;
    for (const r of await q(`SELECT * FROM releases WHERE platform = $1 AND arch = $2 AND active`, [platform, arch])) if (!best || newer(r.version, best.version)) best = r;
    return best;
  };

  // What KingsPresenter asks, a little after it starts and every few hours: the latest version
  // for its platform, when it is newer than the one asking; 204 when there is nothing newer.
  router.get("/kp/updates/latest", ...user, asyncHandler(async (req, res) => {
    const platform = clean(req.query.platform, 20) || "darwin";
    const arch = clean(req.query.arch, 20) || (platform === "darwin" ? "arm64" : "x64");
    const version = clean(req.query.version, 40);
    if (!PLATFORMS.has(platform) || !ARCHES.has(arch)) return fail(res, 400, "bad_request", "platform must be darwin or win32; arch arm64 or x64.");
    const best = await latestFor(platform, arch);
    if (!best || (version && !newer(best.version, version))) return res.status(204).end();
    const r = shapeRelease(req, best);
    ok(res, { version: r.version, notes: r.notes, url: r.url, size: r.size, sha256: r.sha256, releasedAt: r.releasedAt, filename: r.filename });
  }));

  router.get("/kp/updates/releases", ...user, asyncHandler(async (req, res) => {
    const rows = await q(`SELECT * FROM releases WHERE active ORDER BY released_at DESC LIMIT 100`);
    ok(res, { releases: rows.map((r) => shapeRelease(req, r)) });
  }));

  router.get("/kp/updates/files/:version/:platform/:arch", ...user, asyncHandler(async (req, res) => {
    const r = await q1(`SELECT * FROM releases WHERE version = $1 AND platform = $2 AND arch = $3 AND active`, [clean(req.params.version, 40), clean(req.params.platform, 20), clean(req.params.arch, 20)]);
    if (!r) return fail(res, 404, "not_found", "No such release.");
    const file = path.join(RELEASES_DIR, r.storage_key);
    let size;
    try { size = (await fsp.stat(file)).size; } catch { return fail(res, 404, "not_found", "The installer is not on this server any more."); }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(size));
    res.setHeader("Content-Disposition", `attachment; filename="${r.filename.replace(/"/g, "")}"`);
    res.setHeader("X-Sha256", r.sha256);
    fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
  }));

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
module.exports.newer = newer;
module.exports.shapeSummary = shapeSummary;
