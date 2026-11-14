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
//   ad_proposals        ad spaces asked for (the space, how many, what the ad is for): reviewed by the Expo
//                       team, then paid in Espees through the payment link an approval makes
//   ad_artwork          the artwork sent with an ad proposal, for the team: each file itself (up to
//                       200 MB, sent in pieces and kept on disk in EXPO_AD_FILES_DIR) and, for an
//                       image, a small review copy kept here
//   official_training   an Expo official's training: how far into the training video they are, when
//                       they watched it all and passed the quiz, and the name on their certificate
//   official_quiz_attempts  each go at the officials' quiz: the answers, the score and the questions missed
//   team_votes          the team vote: 1 Espee for one team, once and for good (one row that isn't
//                       cancelled for each account; counted once Espees confirms the payment)
//
// Auth: POST /expo/auth/kingschat exchanges a KingsChat accessToken (or authCode) for an
// access token (HS256 JWT, 1 h) and a refresh token. Signed-in calls send
// `Authorization: Bearer <accessToken>`, plus `x-api-key` when EXPO_API_KEY is set.
// Admin calls (/expo/admin/*) send `x-admin-key: EXPO_ADMIN_KEY`.
// An account on an exhibitor's team (users.exhibitor_id, set by the admin) runs that exhibitor
// at /expo/exhibitor: its overview, its details and its bookings.
//
// Same shape as routes/kingspresenter.js, so the two read alike.

const { Router, raw } = require("express");
const { Pool, Client } = require("pg");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const os = require("os");

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

// The ad spaces on the grounds: their price in Espees a space, how many there are (`spots`), how many
// of those are already gone outside the site (`reserved`, counted as taken), and the most any one
// product or service may hold (`perProduct`: one account's proposals with that title, being reviewed,
// approved or paid). The video advert has no limit on either (null), and comes as a link to the video
// (`kind: "video"`), one to a proposal. A space with `sizes` is booked in one of them, at that size's
// price (its own `size` and `price` are what it's listed with: the sizes, and the lowest price); its
// spots and limit are for all its sizes together. A printed space's `ppi` is the resolution its print
// file's images need at full size (said in the messages). Keep in step with the website's
// src/data/advertise.ts (a proposal at a price it shows differently is refused).
const AD_SPACES = {
  lampposts: { name: "Main Road Lamp Posts", size: "0.76 m wide × 2.01 m high", price: 300, spots: 31, perProduct: 2, ppi: 150 },
  "walkway-banners": {
    name: "Walkway Banners", size: "4 m, 2.5 m or 2 m wide × 2.5 m high", price: 1200, spots: 29, perProduct: 5, ppi: 100,
    sizes: {
      "4x2.5": { size: "4 m wide × 2.5 m high", price: 1500 },
      "2.5x2.5": { size: "2.5 m wide × 2.5 m high", price: 1200 },
      "2x2.5": { size: "2 m wide × 2.5 m high", price: 1200 },
    },
  },
  amphitheatre: { name: "Amphitheatre Exterior", size: "6.95 m wide × 11.28 m high", price: 3000, spots: 36, reserved: 11, perProduct: 4, ppi: 50 },
  "light-boxes": { name: "Light Boxes", size: "3 m wide × 1.5 m high", price: 1500, spots: 171, reserved: 101, perProduct: 4, ppi: 100 },
  video: { name: "Video Advert", size: "30 seconds, 1080 × 1920 HD MP4", price: 2000, spots: null, perProduct: null, kind: "video" },
  // For trying a real proposal, approval and payment end to end: admins only, like the test passes.
  test: { name: "Test ad space", size: "0.76 m wide × 2.01 m high", price: 0.001, spots: 100, perProduct: 10, ppi: 150, adminOnly: true },
};
// When print artwork is due, as the Expo team announced it (said in the approval and payment messages).
const AD_ARTWORK_DEADLINE = env("EXPO_AD_ARTWORK_DEADLINE") || "Wednesday 4 November, 3pm (GMT+1)";
// Where people are pointed with questions about their ad.
const EXPO_KC_HANDLE = "@loveworldexpo";

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

  -- Ad space proposals: the space (an AD_SPACES id), how many, the price as quoted, what the ad is
  -- for, and where it stands: pending (with the Expo team), approved (its payment link, pay_token,
  -- sent), paid, rejected (review_note: the team's reason) or cancelled (cancelled_by: owner or
  -- admin). Paid as a pass is, in Espees (payment_ref, payment_status, payment_method, payer,
  -- payment_error), never with the PIN or a whole card number kept.
  CREATE TABLE IF NOT EXISTS ad_proposals (
    id UUID PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    space TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price NUMERIC(14,4) NOT NULL,
    total NUMERIC(14,4) NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    review_note TEXT,
    pay_token TEXT UNIQUE,
    payment_ref TEXT UNIQUE,
    payment_status TEXT,
    payment_method TEXT,
    payer TEXT,
    payment_error TEXT,
    payment_checked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at TIMESTAMPTZ,
    paid_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    cancelled_by TEXT
  );
  CREATE INDEX IF NOT EXISTS ad_proposals_user ON ad_proposals (user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS ad_proposals_space ON ad_proposals (space, status);
  -- A video advert's video: the link the owner gave to it.
  ALTER TABLE ad_proposals ADD COLUMN IF NOT EXISTS video_url TEXT;
  -- For a space that comes in sizes: the one chosen (an id from its AD_SPACES sizes).
  ALTER TABLE ad_proposals ADD COLUMN IF NOT EXISTS size TEXT;
  CREATE TABLE IF NOT EXISTS ad_artwork (
    id UUID PRIMARY KEY,
    proposal_id UUID NOT NULL REFERENCES ad_proposals(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL,
    bytes BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS ad_artwork_proposal ON ad_artwork (proposal_id, created_at);
  -- The ad proposal a message was about.
  ALTER TABLE notifications ADD COLUMN IF NOT EXISTS ad_id UUID REFERENCES ad_proposals(id) ON DELETE CASCADE;
  -- The one-time key the website sends with a proposal and with each image, so the same one sent
  -- again (a retry after a dropped connection) gives back what was made rather than a second.
  ALTER TABLE ad_proposals ADD COLUMN IF NOT EXISTS client_key TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS ad_proposals_client_key ON ad_proposals (user_id, client_key) WHERE client_key IS NOT NULL;
  ALTER TABLE ad_artwork ADD COLUMN IF NOT EXISTS client_key TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS ad_artwork_client_key ON ad_artwork (proposal_id, client_key) WHERE client_key IS NOT NULL;
  -- Artwork sent as the file itself: its size as announced, its type (by its first bytes), how much
  -- has arrived (kept on disk, in AD_FILES_DIR, named by the row's id) and when the last of it did.
  -- \`bytes\` is then the review copy of an image, or nothing for a file a browser can't show (a PDF).
  ALTER TABLE ad_artwork ALTER COLUMN bytes DROP NOT NULL;
  ALTER TABLE ad_artwork ADD COLUMN IF NOT EXISTS file_size BIGINT;
  ALTER TABLE ad_artwork ADD COLUMN IF NOT EXISTS file_type TEXT;
  ALTER TABLE ad_artwork ADD COLUMN IF NOT EXISTS received BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE ad_artwork ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
  -- A printed space's artwork as a link (KingsCloud, Google Drive…), given with the proposal.
  ALTER TABLE ad_proposals ADD COLUMN IF NOT EXISTS artwork_url TEXT;

  -- Officials' training, one row a person from their first moment of the video or first go at the quiz: the furthest point
  -- watched (seconds, moved on no faster than the video plays) and when it was last moved, when the
  -- whole video was watched, when they first passed the quiz, and the name they put on their certificate.
  CREATE TABLE IF NOT EXISTS official_training (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    watched_seconds INTEGER NOT NULL DEFAULT 0,
    progress_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    watched_at TIMESTAMPTZ,
    passed_at TIMESTAMPTZ,
    certificate_name TEXT,
    certificate_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  -- Every go at the quiz: the answers given ({ "1": "b", … }), the score out of the total, and the
  -- questions missed. client_key: the page's one-time key, so a retry isn't counted twice.
  CREATE TABLE IF NOT EXISTS official_quiz_attempts (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    score INTEGER NOT NULL,
    total INTEGER NOT NULL,
    answers JSONB NOT NULL,
    missed INTEGER[] NOT NULL DEFAULT '{}',
    client_key TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS official_quiz_attempts_user ON official_quiz_attempts (user_id, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS official_quiz_attempts_client_key ON official_quiz_attempts (user_id, client_key) WHERE client_key IS NOT NULL;

  -- Team votes: a signed-in person pays 1 Espee to vote for one team (a VOTE_TEAMS id), once, for
  -- good. One row an attempt: pending (its payment is with Espees, taken but not yet confirmed, or
  -- without a clear answer), counted (paid: the vote) or cancelled (nothing was taken, so they may
  -- try again). Paid as a pass is (payment_ref: Espees' reference; payment_status, payment_method,
  -- payer, payment_error). The two unique indexes are what make a vote final: an account, and the
  -- KingsChat identity behind it (kc_id, kept so that deleting the account and signing in again gives
  -- no second vote), has at most one row that isn't cancelled, and nothing ever changes a row's team.
  -- A deleted account's vote stays, counted, with no account on it.
  CREATE TABLE IF NOT EXISTS team_votes (
    id UUID PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    kc_id TEXT,
    team TEXT NOT NULL,
    amount NUMERIC(14,4) NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    payment_ref TEXT,
    payment_status TEXT,
    payment_method TEXT,
    payer TEXT,
    payment_error TEXT,
    payment_checked_at TIMESTAMPTZ,
    paid_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS team_votes_one_per_user ON team_votes (user_id) WHERE status <> 'cancelled';
  CREATE UNIQUE INDEX IF NOT EXISTS team_votes_one_per_kc ON team_votes (kc_id) WHERE status <> 'cancelled' AND kc_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS team_votes_counted ON team_votes (team) WHERE status = 'counted';
  CREATE INDEX IF NOT EXISTS team_votes_created ON team_votes (created_at DESC);
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
 * `r` is { userId, kc, text, kind }; `bookingId`, `adId` and `ref` (for the log) may be null.
 */
async function deliver(r, { bookingId = null, adId = null, ref = "" } = {}) {
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
    `INSERT INTO notifications (booking_id, ad_id, user_id, kind, recipient_kc_id, body, status, error, kc_message_id, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $7 = 'sent' THEN now() END)`,
    [bookingId, adId, r.userId, r.kind, r.kc || null, r.text, status, result.error || null, result.messageId || null]);
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

/**
 * How a payment is made, from a request's `payment`: { method: "wallet", username, pin } or
 * { method: "card", cardNum, pin }, with `missing` (the message to show) when something isn't there.
 */
function paymentDetails(p) {
  const v = p && typeof p === "object" ? p : {};
  const method = v.method === "card" ? "card" : "wallet";
  const pin = String(v.pin ?? "").trim().slice(0, 20);
  const username = clean(v.username, 120).replace(/^@/, "");
  const cardNum = String(v.cardNum ?? "").replace(/[\s-]/g, "").slice(0, 40);
  const missing = !pin || (method === "wallet" ? !username : !/^\d{8,40}$/.test(cardNum))
    ? (method === "wallet" ? "Enter your Espees username and PIN." : "Enter your Espees card number and PIN.") : "";
  return { method, pin, username, cardNum, payer: method === "wallet" ? `@${username}` : `card ****${cardNum.slice(-4)}`, missing };
}

/* ---------------------------------------------------------------------------
 * Ad spaces: proposed, approved by the Expo team, then paid in Espees
 * ------------------------------------------------------------------------- */

// What counts toward a product's limit, and what takes spots from a space (an approval holds them).
const AD_HOLDING = ["pending", "approved", "paid"];
const AD_TAKEN = ["approved", "paid"];
// A payment still with Espees, taken but not yet confirmed, or without a clear answer: the proposal
// can't be paid again, rejected or cancelled until it's settled (or the team has checked it).
const AD_PAYING = ["PROCESSING", "CHARGED", "UNKNOWN", "MISMATCH"];
// Artwork for review: JPG, PNG or WebP images (told apart by their first bytes), each under the
// JSON body limit once in base64, and so many to a proposal.
const AD_ARTWORK_MAX_BYTES = Math.floor(1.4 * 1024 * 1024);
const AD_ARTWORK_MAX = 6;
// Artwork as the file itself: up to AD_FILE_MAX_BYTES, sent in pieces of up to AD_CHUNK_MAX_BYTES
// (each its own request, so no one request is large), kept on disk in AD_FILES_DIR, named by the
// artwork's id. Outside the app's folder, which the process manager watches and /uploads serves.
const AD_FILE_MAX_BYTES = 200 * 1024 * 1024;
const AD_CHUNK_MAX_BYTES = 8 * 1024 * 1024;
const AD_FILES_DIR = path.resolve(env("EXPO_AD_FILES_DIR") || path.join(os.homedir(), "loveworld-expo-files", "ad-artwork"));
const adFilePath = (id) => path.join(AD_FILES_DIR, id);

const adSpace = (id) => (Object.hasOwn(AD_SPACES, id) ? AD_SPACES[id] : null);
/** One of a space's sizes by its id ({ size, price }), or null (no such size, or a space without sizes). */
const adSizeOf = (s, id) => (s?.sizes && typeof id === "string" && Object.hasOwn(s.sizes, id) ? s.sizes[id] : null);
/** What a proposal's print is: its chosen size, or its space's size. */
const adSizeLabel = (r) => adSizeOf(adSpace(r.space), r.size)?.size || adSpace(r.space)?.size || "";
/** A proposal's product or service as its limit counts it: the same title, whatever its spacing or capitals. */
const productKey = (title) => clean(title, 120).replace(/\s+/g, " ").toLowerCase();
/** A video advert's link: an http(s) address, up to 500 characters, or null. */
function videoLink(v) {
  const text = clean(v, 500);
  try {
    const u = new URL(text);
    return /^https?:$/.test(u.protocol) && u.hostname.includes(".") ? u.href : null;
  } catch {
    return null;
  }
}
/** A one-time key from the website (8 to 80 letters, digits, - and _), or null. */
const clientKey = (v) => (typeof v === "string" && /^[\w-]{8,80}$/.test(v) ? v : null);
/** The payment link an approval makes (on the website), while there is something to pay or see. */
const adPayUrl = (r) => (r.pay_token && (r.status === "approved" || r.status === "paid") ? site(`/advertise/pay?link=${r.pay_token}`) || null : null);

/**
 * What an artwork file is, by its first bytes: an image (JPG, PNG, WebP, TIFF), a PDF (Illustrator
 * files saved PDF-compatible are PDFs), a Photoshop file or PostScript (EPS, older Illustrator), or null.
 */
function artworkFileType(buf) {
  const image = imageType(buf);
  if (image) return image;
  const head = buf.toString("latin1", 0, 5);
  if (buf.length > 4 && ((buf[0] === 0x49 && buf[1] === 0x49 && (buf[2] === 0x2a || buf[2] === 0x2b) && buf[3] === 0) || (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0 && (buf[3] === 0x2a || buf[3] === 0x2b)))) return "image/tiff";
  if (head === "%PDF-") return "application/pdf";
  if (head.startsWith("8BPS")) return "image/vnd.adobe.photoshop";
  if (head.startsWith("%!PS") || (buf.length > 4 && buf[0] === 0xc5 && buf[1] === 0xd0 && buf[2] === 0xd3 && buf[3] === 0xc6)) return "application/postscript";
  return null;
}

function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/**
 * Each ad space with what's left of it (`remaining`: approved and paid proposals take spots, as do its
 * `reserved` ones; null with no limit) and, for a signed-in person, how many each of their products
 * holds there (`held`: [{ title, quantity }], titles told apart as productKey does). `db` may be a
 * client in a transaction. The admin-only test space is there only with `test`.
 */
async function adSpaces(userId = null, db = pool, { test = false } = {}) {
  const rows = (await db.query(
    `SELECT space, COALESCE(sum(quantity) FILTER (WHERE status = ANY($1)), 0)::int AS taken FROM ad_proposals GROUP BY space`, [AD_TAKEN])).rows;
  const mine = userId
    ? (await db.query(`SELECT space, title, sum(quantity)::int AS quantity FROM ad_proposals WHERE user_id = $1 AND status = ANY($2) GROUP BY space, title ORDER BY min(created_at)`, [userId, AD_HOLDING])).rows
    : [];
  return Object.entries(AD_SPACES).filter(([, s]) => test || !s.adminOnly).map(([id, s]) => {
    const row = rows.find((r) => r.space === id);
    const taken = (s.reserved || 0) + (row?.taken ?? 0);
    const held = [];
    for (const m of mine.filter((m) => m.space === id)) {
      const same = held.find((h) => productKey(h.title) === productKey(m.title));
      if (same) same.quantity += m.quantity;
      else held.push({ title: m.title, quantity: m.quantity });
    }
    return {
      id, name: s.name, size: s.size, price: s.price, kind: s.kind || "print", spots: s.spots, taken,
      remaining: s.spots == null ? null : Math.max(0, s.spots - taken), perProduct: s.perProduct, held: userId ? held : null, adminOnly: !!s.adminOnly,
      sizes: s.sizes ? Object.entries(s.sizes).map(([sizeId, z]) => ({ id: sizeId, size: z.size, price: z.price })) : null,
    };
  });
}
/** Whether the account may see and use the admin-only test space. */
const isAdminUser = async (userId) => !!userId && !!(await q1(`SELECT 1 FROM users WHERE id = $1 AND is_admin`, [userId]));

/** An artwork row's columns, as shapeArtwork reads them; `t`: the table's alias, when there's a join. */
const adArtColumns = (t = "") => `${t}id AS id, ${t}name AS name, ${t}type AS type, ${t}bytes IS NOT NULL AS preview, octet_length(${t}bytes) AS preview_size, ${t}file_size AS file_size, ${t}file_type AS file_type, ${t}received AS received, ${t}completed_at AS completed_at`;
const AD_ART_COLUMNS = adArtColumns();
/**
 * One piece of artwork as the owner and the team see it (never its bytes): its name, type and size
 * (the file's, or for one sent before files, the image's), whether it has a review copy to show
 * (`preview`), and how much of the file has arrived (`complete` once all of it has).
 */
function shapeArtwork(a) {
  const file = a.file_size != null;
  const size = Number(file ? a.file_size : a.preview_size);
  return { id: a.id, name: a.name, type: (file ? a.file_type : a.type) || null, size, preview: !!a.preview, complete: !file || !!a.completed_at, received: file ? Number(a.received) : size };
}

/** The artwork of each proposal given, without the files themselves: { proposalId: [shapeArtwork] }. */
async function adArtworkOf(ids) {
  const out = {};
  if (!ids.length) return out;
  for (const a of await q(`SELECT proposal_id, ${AD_ART_COLUMNS} FROM ad_artwork WHERE proposal_id = ANY($1::uuid[]) ORDER BY created_at`, [ids])) {
    (out[a.proposal_id] ||= []).push(shapeArtwork(a));
  }
  return out;
}

/** A proposal as its owner sees it; with `admin`, the account it's from too (`r` joined with users). */
function shapeAd(r, { artwork = [], admin = false } = {}) {
  const s = adSpace(r.space);
  return {
    id: r.id, reference: r.reference, space: r.space, spaceName: s?.name || r.space, size: adSizeLabel(r), sizeId: r.size || null,
    quantity: r.quantity, unitPrice: Number(r.unit_price), total: Number(r.total), title: r.title, description: r.description, videoUrl: r.video_url || null, artworkUrl: r.artwork_url || null,
    status: r.status, reviewNote: r.review_note || null, payUrl: adPayUrl(r),
    paymentStatus: r.payment_status || null, paymentMethod: r.payment_method || null, payer: r.payer || null, paymentError: r.payment_error || null,
    createdAt: r.created_at, reviewedAt: r.reviewed_at || null, paidAt: r.paid_at || null, cancelledAt: r.cancelled_at || null, cancelledBy: r.cancelled_by || null,
    artwork,
    ...(admin ? { user: { id: r.user_id, username: r.kc_username || null, name: [r.first_name, r.last_name].filter(Boolean).join(" ") || r.kc_name || null, email: r.email || null, phone: r.phone || null, organisation: r.organisation || null } } : {}),
  };
}

/** What the payment link shows, to whoever has it: the ad and what's owed, nothing about the account. */
function shapeAdPayment(r) {
  const s = adSpace(r.space);
  return {
    reference: r.reference, space: r.space, spaceName: s?.name || r.space, size: adSizeLabel(r), sizeId: r.size || null, quantity: r.quantity, unitPrice: Number(r.unit_price), total: Number(r.total),
    title: r.title, status: r.status, paymentStatus: r.payment_status || null, paymentError: r.payment_status === "DECLINED" ? r.payment_error || null : null, paidAt: r.paid_at || null,
  };
}

/** The KingsChat message for each step of a proposal: submitted, approved, rejected, paid, cancelled. */
function adMessage(kind, r) {
  const s = adSpace(r.space);
  const heads = {
    submitted: "📝 Ad space proposal received",
    approved: "✅ Your ad space proposal is approved",
    rejected: "Your ad space proposal wasn't approved",
    paid: "🎉 Payment received: your ad space is booked",
    cancelled: "Your ad space proposal is cancelled",
    complimentary: "🎁 Your ad space is booked, complimentary",
  };
  const note = r.review_note ? `${kind === "rejected" ? "Reason" : "Note"}: ${short(r.review_note, 300)}` : "";
  const ask = `Questions? Message ${EXPO_KC_HANDLE} on KingsChat.`;
  const video = s?.kind === "video";
  // What the print file must be, for a printed space.
  const printFile = `Print file: a print-ready PDF at ${adSizeLabel(r) || "the size listed"}, full size, with images at ${s?.ppi || 100} dpi (ppi), by ${AD_ARTWORK_DEADLINE}.`;
  const next = {
    submitted: ["The Expo team will review your proposal. Once it's approved, we'll send you the link to pay here on KingsChat. Nothing is charged before then.", site("/my-expo#ads") && `Your proposals: ${site("/my-expo#ads")}`],
    approved: [note, adPayUrl(r) ? `Pay ${amountLabel(r.total)} here: ${adPayUrl(r)}` : "Pay from My Expo on the website.", video ? "" : "Your spaces are held for you until you pay.", video ? "" : printFile, ask],
    rejected: [note, ask, site("/advertise") && `Send a new proposal: ${site("/advertise")}`],
    paid: [video ? "Your video advert is booked for the Expo week." : `Your ad goes up on the grounds for the Expo week. ${printFile}`, ask],
    cancelled: [r.cancelled_by === "admin" ? "The Expo team cancelled it." : "You cancelled it, so nothing will be charged.", note, ask],
    complimentary: [note, "It comes with your sponsorship of the Expo, so there's nothing to pay.",
      video ? "Your video advert is booked for the Expo week." : `Your ad goes up on the grounds for the Expo week. ${printFile}`, ask],
  };
  return compose([
    `${heads[kind]} · LoveWorld Expo 2026`,
    GAP,
    `Reference: ${r.reference}`,
    `Space: ${r.quantity} × ${s?.name || r.space}${adSizeOf(s, r.size) ? `, ${adSizeOf(s, r.size).size}` : ""}`,
    `Ad: ${short(r.title, 120)}`,
    r.video_url ? `Video: ${r.video_url}` : "",
    r.artwork_url ? `Artwork: ${r.artwork_url}` : "",
    kind === "complimentary" ? "To pay: nothing (complimentary)" : `${kind === "paid" ? "Paid" : "Total"}: ${amountLabel(r.total)}`,
    GAP,
    ...next[kind],
  ]);
}

/** Tell the proposal's owner on KingsChat about a step, in the background. */
function adNotifyLater(id, kind) {
  setImmediate(async () => {
    try {
      const r = await q1(`SELECT a.*, u.kc_user_id, u.kc_id FROM ad_proposals a JOIN users u ON u.id = a.user_id WHERE a.id = $1`, [id]);
      if (r) await deliver({ userId: r.user_id, kc: r.kc_user_id || r.kc_id, text: adMessage(kind, r), kind: `ad:${kind}` }, { adId: r.id, ref: r.reference });
    } catch (err) {
      console.error(`[expo] ad message (${kind}, ${id}) failed:`, err.message);
    }
  });
}

/**
 * Brings an approved proposal's payment up to date: one Espees has taken is checked with it (done, for
 * this reference and the full total: "paid", and the owner hears on KingsChat, once). Safe to call
 * again and at the same time. Returns the row, with `checkError` when Espees couldn't be asked.
 */
async function settleAd(id) {
  const r = await q1(`SELECT * FROM ad_proposals WHERE id = $1`, [id]);
  if (!r || r.status !== "approved" || !r.payment_ref || !["CHARGED", "MISMATCH"].includes(r.payment_status)) return r;
  const t = await espeesTransaction(r.payment_ref);
  if (t.error) {
    console.error(`[expo] Espees transaction (${r.reference}) not checked: ${t.error}`);
    return { ...r, checkError: t.error };
  }
  const matches = (t.reference == null || String(t.reference) === r.payment_ref) && (t.amount == null || sameAmount(t.amount, r.total));
  if (t.done && !matches) console.error(`[expo] Espees transaction ${r.payment_ref} (${r.reference}) is for ${t.amount}, not ${Number(r.total)}: left unpaid`);
  const paid = t.done && matches;
  // Only the step from approved to paid tells the owner, so a second check at the same time doesn't.
  const moved = await q1(
    `UPDATE ad_proposals SET payment_status = $2, payment_checked_at = now(), status = CASE WHEN $3 THEN 'paid' ELSE status END,
       paid_at = CASE WHEN $3 THEN now() ELSE paid_at END WHERE id = $1 AND status = 'approved' RETURNING *`,
    [id, paid ? "PAID" : t.done ? "MISMATCH" : "CHARGED", paid]);
  if (paid && moved) adNotifyLater(id, "paid");
  return moved || (await q1(`SELECT * FROM ad_proposals WHERE id = $1`, [id]));
}

/* ---------------------------------------------------------------------------
 * Team votes: 1 Espee for one team, once and for good
 * ------------------------------------------------------------------------- */

// The teams (id: name). The website has the same ids, with its own pages for them (src/data/teams.ts
// there): a rename is this line and that file's.
const VOTE_TEAMS = { launchpad: "Launchpad", "wealth-liquefiers": "Wealth Liquefiers", dynamic: "Dynamic" };
const VOTE_PRICE = 1;
const voteCost = () => `${VOTE_PRICE} Espee${VOTE_PRICE === 1 ? "" : "s"}`;
// Votes are taken while Espees is set up and EXPO_VOTING isn't "off" (the switch that closes voting).
const votingOpen = () => !!ESPEES_API_TOKEN && (env("EXPO_VOTING") || "on").toLowerCase() !== "off";
// EXPO_VOTE_COUNTS=off keeps the running totals to the admin: the public answers carry no numbers.
const voteCountsPublic = () => (env("EXPO_VOTE_COUNTS") || "on").toLowerCase() !== "off";
// A payment still marked as being sent after this long never got its answer recorded (the server
// stopped mid-payment): nobody can tell whether it was taken, so it's for the team to check.
const VOTE_SENDING_MS = 2 * 60 * 1000;
const voteStuck = (r) => r.status === "pending" && r.payment_status === "PROCESSING" && Date.now() - new Date(r.created_at).getTime() > VOTE_SENDING_MS;
// Ten hex characters: a reference never has to be made twice, however many vote.
const voteReference = () => `VOTE-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;

/**
 * A vote as the person sees it: pending or counted (or, for the admin, cancelled), with where its
 * payment stands (a payment stuck being sent shows as UNKNOWN). The admin also sees who, Espees'
 * reference and what went wrong.
 */
function shapeVote(r, { admin = false } = {}) {
  if (!r) return null;
  return {
    id: r.id, reference: r.reference, team: r.team, teamName: VOTE_TEAMS[r.team] || r.team, amount: Number(r.amount) || 0, status: r.status,
    paymentStatus: voteStuck(r) ? "UNKNOWN" : r.payment_status || null, paymentMethod: r.payment_method || null, payer: r.payer || null,
    createdAt: r.created_at, paidAt: r.paid_at || null,
    ...(admin ? {
      user: r.user_id ? { id: r.user_id, username: r.kc_username || null, name: [r.first_name, r.last_name].filter(Boolean).join(" ") || r.kc_name || null, email: r.email || null } : null,
      paymentRef: r.payment_ref || null, paymentError: r.payment_error || null, paymentCheckedAt: r.payment_checked_at || null, cancelledAt: r.cancelled_at || null,
    } : {}),
  };
}

/** The account's vote: its one row that isn't cancelled (its own, or its KingsChat identity's from an account since deleted), or null. */
const voteOf = async (userId, db = pool) => (await db.query(
  `SELECT v.* FROM team_votes v WHERE v.status <> 'cancelled' AND (v.user_id = $1 OR v.kc_id = (SELECT kc_id FROM users WHERE id = $1)) ORDER BY v.created_at DESC LIMIT 1`, [userId])).rows[0] || null;

/** Why someone with a vote (or one being paid for) can't vote now: [http, code, message]. */
function voteRefusal(r) {
  const name = VOTE_TEAMS[r.team] || r.team;
  if (r.status === "counted") return [409, "already_voted", `You've already voted for ${name}. A vote can't be changed.`];
  if (r.payment_status === "PROCESSING" && !voteStuck(r)) return [409, "payment_in_progress", "Your payment is already going through. Give it a moment."];
  return [409, "vote_pending", `Your vote for ${name} is being confirmed with Espees. Please don't pay again: it will show here once it's confirmed.`];
}

/** Each team with its counted votes, and the total: for everyone (numbers left out when EXPO_VOTE_COUNTS is off) or, with `all`, for the admin. */
async function voteTally({ all = false } = {}) {
  const rows = await q(`SELECT team, count(*)::int AS votes FROM team_votes WHERE status = 'counted' GROUP BY team`);
  const by = Object.fromEntries(rows.map((r) => [r.team, r.votes]));
  const shown = all || voteCountsPublic();
  const teams = Object.entries(VOTE_TEAMS).map(([id, name]) => ({ id, name, votes: shown ? by[id] || 0 : null }));
  return { teams, total: shown ? teams.reduce((n, t) => n + t.votes, 0) : null };
}

/** The voter's KingsChat message once their vote is counted. */
function voteMessage(r) {
  return compose([
    `🗳️ Your vote for ${VOTE_TEAMS[r.team] || r.team} is in!`,
    GAP,
    `Reference: ${r.reference}`,
    `Paid: ${voteCost()}`,
    GAP,
    "One vote each, and it can't be changed. Thank you for voting.",
    site("/teams") && `The teams: ${site("/teams")}`,
  ]);
}

/** Tell the voter on KingsChat, in the background (once: only the step to counted calls it). */
function voteMessageLater(id) {
  setImmediate(async () => {
    try {
      const r = await q1(`SELECT v.*, u.kc_user_id, u.kc_id AS user_kc_id FROM team_votes v JOIN users u ON u.id = v.user_id WHERE v.id = $1`, [id]);
      if (r) await deliver({ userId: r.user_id, kc: r.kc_user_id || r.user_kc_id, text: voteMessage(r), kind: "vote:counted" }, { ref: r.reference });
    } catch (err) {
      console.error(`[expo] vote message (${id}) failed:`, err.message);
    }
  });
}

/**
 * Brings a vote's payment up to date: one Espees has taken is checked with it (done, for this
 * reference and the full price: the vote is counted, and the voter hears on KingsChat, once). Safe
 * to call again and at the same time. Returns the row, with `checkError` when Espees couldn't be asked.
 */
async function settleVote(id) {
  const r = await q1(`SELECT * FROM team_votes WHERE id = $1`, [id]);
  if (!r || r.status !== "pending" || !r.payment_ref || !["CHARGED", "MISMATCH"].includes(r.payment_status)) return r;
  const t = await espeesTransaction(r.payment_ref);
  if (t.error) {
    console.error(`[expo] Espees transaction (${r.reference}) not checked: ${t.error}`);
    return { ...r, checkError: t.error };
  }
  const matches = (t.reference == null || String(t.reference) === r.payment_ref) && (t.amount == null || sameAmount(t.amount, r.amount));
  if (t.done && !matches) console.error(`[expo] Espees transaction ${r.payment_ref} (${r.reference}) is for ${t.amount}, not ${Number(r.amount)}: not counted`);
  const paid = t.done && matches;
  // Only the step from pending to counted tells the voter, so a second check at the same time doesn't.
  const moved = await q1(
    `UPDATE team_votes SET payment_status = $2, payment_checked_at = now(), status = CASE WHEN $3 THEN 'counted' ELSE status END,
       paid_at = CASE WHEN $3 THEN now() ELSE paid_at END, updated_at = now() WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id, paid ? "PAID" : t.done ? "MISMATCH" : "CHARGED", paid]);
  if (paid && moved) voteMessageLater(id);
  return moved || (await q1(`SELECT * FROM team_votes WHERE id = $1`, [id]));
}

/* ---------------------------------------------------------------------------
 * Officials' training
 * ------------------------------------------------------------------------- */

// Every Expo official has the training video to watch and the quiz to pass, with OFFICIALS_PASS_PERCENT
// of its answers right (as many goes as it takes, open from the start: the video isn't required first),
// then puts their name on their certificate.
// The video plays from its link (CloudFront); its length is read from the file there, in ranges.
const OFFICIALS_VIDEO_DEFAULT = "https://d1zx0zj5kmre28.cloudfront.net/videos/InShot_20261108_133320385.mp4";
const officialsVideoUrl = () => env("EXPO_OFFICIALS_VIDEO_URL") || OFFICIALS_VIDEO_DEFAULT;
const OFFICIALS_PASS_PERCENT = Math.min(100, Math.max(1, Number(env("EXPO_OFFICIALS_PASS_PERCENT")) || 80));
// The furthest point watched moves on no faster than the video plays at up to 2×, since the last
// report, plus a little for a report that comes late; within OFFICIALS_END_SECONDS of the end (a last
// frame, the credits) the whole video is watched.
const OFFICIALS_PLAY_RATE = 2;
const OFFICIALS_SLACK_SECONDS = 30;
const OFFICIALS_END_SECONDS = 10;
const OFFICIALS_NAME_MAX = 80;

// The quiz: the Expo team's post-video quiz, module by module. Each question's four choices are a to d
// as written, and `answer` is the right one. The answers never leave this service.
const OFFICIALS_MODULES = [
  "Welcome and your role", "Courtesy and the Expo standard", "Hospitality", "Professional conduct and appearance",
  "Communicating well", "Handling complaints and difficult moments", "Role skills", "Safety, teamwork and escalation",
];
const OFFICIALS_QUIZ = [
  { module: 1, answer: "b", text: "Which statement best describes your role at the Expo?", options: ["I only need to know my own post.", "I am the face of the Expo and responsible for how visitors are treated.", "Visitor service is the job of the helpdesk only.", "I should describe the Expo in my own words."] },
  { module: 1, answer: "a", text: "When a visitor asks what the Expo is, you should:", options: ["Give the approved description.", "Say whatever you remember.", "Tell them to read the brochure.", "Ask a colleague to answer."] },
  { module: 1, answer: "a", text: "Which of these is part of your personal responsibility?", options: ["Arriving on time and knowing your post.", "Choosing which visitors deserve help.", "Ignoring problems that are not at your post.", "Giving different service to VIPs only."] },
  { module: 2, answer: "a", text: "How long do you have to make a first impression?", options: ["About ten seconds.", "One minute.", "Five minutes.", "It does not matter."] },
  { module: 2, answer: "b", text: "Which is the best welcome?", options: ["Nodding while you finish a phone call.", "Eye contact, a greeting and an offer of help.", "Waiting until the visitor speaks first.", "Pointing without speaking."] },
  { module: 2, answer: "c", text: "Which of the following is prohibited conduct?", options: ["Saying \"Please\" and \"Thank you.\"", "Treating every visitor with equal dignity.", "Accepting a gift in exchange for special treatment.", "Offering to show a visitor the way."] },
  { module: 3, answer: "a", text: "What are the five hospitality steps, in order?", options: ["Greet, Ask, Guide, Check, Thank.", "Ask, Greet, Point, Thank, Check.", "Greet, Guide, Ask, Thank, Check.", "Welcome, Direct, Leave, Thank, Check."] },
  { module: 3, answer: "c", text: "A visitor in a wheelchair needs help. What should you do first?", options: ["Push the wheelchair immediately.", "Ask the companion what the visitor needs.", "Greet the visitor and ask how they would like to be helped.", "Call security."] },
  { module: 3, answer: "c", text: "For an international guest who speaks little English, you should:", options: ["Speak louder.", "Use slang so it sounds friendly.", "Speak slowly with simple words, gestures and the map.", "Tell them to find someone who speaks their language."] },
  { module: 4, answer: "b", text: "If you need to leave your post, you should:", options: ["Leave quietly and return soon.", "Tell your supervisor and wait to be relieved.", "Ask a visitor to watch the post.", "Close the post."] },
  { module: 4, answer: "c", text: "Which action respects confidentiality?", options: ["Telling friends the VIP arrival time.", "Posting a photo of a security check online.", "Keeping VIP and security information within the team.", "Sharing exhibitor details with any visitor."] },
  { module: 4, answer: "b", text: "When may you use your phone on duty?", options: ["Whenever it is quiet.", "During breaks, or for official Expo duties.", "Only when a supervisor is not watching.", "To film interesting incidents."] },
  { module: 5, answer: "c", text: "A visitor asks a question you cannot answer. What do you say?", options: ["\"I don't know.\"", "A guess that sounds right.", "\"Let me find out for you,\" then ask your supervisor or the help desk.", "\"That is not my job.\""] },
  { module: 5, answer: "b", text: "Which is good radio practice?", options: ["Long, chatty messages.", "Using call signs and short, clear messages.", "Shouting so you are heard.", "Using the radio to chat during quiet moments."] },
  { module: 5, answer: "a", text: "Where may a visitor collect their badge?", options: ["The Access Point.", "Any entrance.", "The help desk only.", "Wherever the official says."] },
  { module: 6, answer: "a", text: "What are the four complaint-handling steps?", options: ["Listen, Apologise, Act, Follow up.", "Ignore, Defend, Explain, Leave.", "Argue, Apologise, Act, Forget.", "Listen, Defend, Refer, Close."] },
  { module: 6, answer: "b", text: "What should you avoid when a visitor is upset?", options: ["Listening without interrupting.", "Making promises you cannot keep.", "Lowering your voice.", "Offering what you can do."] },
  { module: 6, answer: "c", text: "A visitor becomes abusive after you have stayed calm and polite. What do you do?", options: ["Shout back.", "Walk away without telling anyone.", "Say you need respectful conversation, then call your supervisor or security if it continues.", "Ignore the abuse indefinitely."] },
  { module: 7, answer: "c", text: "At access control, a very important person arrives without a valid pass. You should:", options: ["Let them through to avoid embarrassment.", "Argue until they leave.", "Politely explain, and direct them to the help desk or call your supervisor.", "Check everyone's pass except theirs."] },
  { module: 7, answer: "b", text: "When searching bags, you should:", options: ["Say nothing.", "Explain that it is for everyone's safety, and be respectful.", "Skip anyone who looks friendly.", "Search only certain nationalities."] },
  { module: 7, answer: "b", text: "At the help desk, what should you do with a complaint you cannot resolve?", options: ["Tell the visitor to come back tomorrow.", "Record it and escalate it.", "Ignore it.", "Promise a solution."] },
  { module: 8, answer: "c", text: "You see an unattended bag. What do you do?", options: ["Open it to check.", "Move it away from the crowd.", "Do not touch it, keep people away and report immediately.", "Wait to see whether the owner returns."] },
  { module: 8, answer: "b", text: "A good escalation report includes:", options: ["Opinions about who is to blame.", "What, where, when and who, stated as facts.", "Only the location.", "A request to someone else to report it."] },
  { module: 8, answer: "b", text: "At the end of your shift you should:", options: ["Leave immediately.", "Brief your relief on open issues, visitors being assisted, and anything unusual.", "Tell the visitors to find another official.", "Hand over only if asked."] },
  { module: 8, answer: "b", text: "As a host or hostess in a pavilion, which of these should you know?", options: ["Only the location of your own booth.", "The location of every booth, the restrooms and the information desks.", "Only the exhibition times.", "Nothing. Visitors should ask the help desk."] },
];
const QUIZ_LETTERS = ["a", "b", "c", "d"];
/** The score that passes a quiz of `total` questions. */
const passScore = (total = OFFICIALS_QUIZ.length) => Math.ceil((total * OFFICIALS_PASS_PERCENT) / 100);
const shuffled = (list) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
/** The quiz as the person sees it: each question's choices in a new order every time, and no answers. */
const quizForPerson = () => OFFICIALS_QUIZ.map((item, i) => ({
  n: i + 1, module: item.module, moduleName: OFFICIALS_MODULES[item.module - 1], text: item.text,
  options: shuffled(item.options.map((text, j) => ({ id: QUIZ_LETTERS[j], text }))),
}));
/** The answers given ({ "1": "b", … }) marked: { answers, missed, score, total }, or null when any question is unanswered. */
function markQuiz(given) {
  const answers = {};
  const missed = [];
  for (const [i, item] of OFFICIALS_QUIZ.entries()) {
    const n = i + 1;
    const a = typeof given?.[n] === "string" ? given[n].trim().toLowerCase() : "";
    if (!QUIZ_LETTERS.slice(0, item.options.length).includes(a)) return null;
    answers[n] = a;
    if (a !== item.answer) missed.push(n);
  }
  return { answers, missed, total: OFFICIALS_QUIZ.length, score: OFFICIALS_QUIZ.length - missed.length };
}
const shapeAttempt = (a) => ({ score: a.score, total: a.total, passed: a.score >= passScore(a.total), missed: a.missed || [], at: a.created_at });

/**
 * An MP4's length in seconds, from its movie header (moov, then mvhd inside it), or null.
 * `read(position, length)` gives `{ bytes, size }`: the bytes there (fewer at the end) and the file's size.
 */
async function mp4Seconds(read) {
  const { size } = await read(0, 8);
  if (!size) return null;
  // The first box of `type` between `start` and `end`: where its contents start, and where it ends.
  const box = async (start, end, type) => {
    for (let at = start; at + 8 <= end;) {
      const { bytes } = await read(at, 16);
      if (bytes.length < 8) return null;
      let len = bytes.readUInt32BE(0);
      let head = 8;
      if (len === 1) {
        if (bytes.length < 16) return null;
        len = Number(bytes.readBigUInt64BE(8));
        head = 16;
      } else if (len === 0) len = end - at;
      if (len < head) return null;
      if (bytes.toString("latin1", 4, 8) === type) return { body: at + head, end: Math.min(end, at + len) };
      at += len;
    }
    return null;
  };
  const moov = await box(0, size, "moov");
  const mvhd = moov && (await box(moov.body, moov.end, "mvhd"));
  if (!mvhd) return null;
  const { bytes: b } = await read(mvhd.body, 32);
  if (b.length < 32) return null;
  const v1 = b[0] === 1;
  const scale = b.readUInt32BE(v1 ? 20 : 12);
  const units = v1 ? Number(b.readBigUInt64BE(24)) : b.readUInt32BE(16);
  return scale ? units / scale : null;
}
/** Reads a file at a web address a range at a time (never the whole of it), for mp4Seconds. */
const rangesOf = (url) => async (position, length) => {
  const res = await fetch(url, { headers: { range: `bytes=${position}-${position + length - 1}` }, signal: AbortSignal.timeout(10_000) });
  if (res.status !== 206) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`it answered ${res.status} to a range request`);
  }
  return { bytes: Buffer.from(await res.arrayBuffer()), size: Number((res.headers.get("content-range") || "").split("/")[1]) || null };
};
let officialsVideoSeen = null;
/**
 * The training video: its link and its length in whole seconds, read from the file and kept for six
 * hours (a minute when it couldn't be read: the last length read, else EXPO_OFFICIALS_VIDEO_SECONDS,
 * stands in meanwhile). Not available while its length is unknown.
 */
async function officialsVideo() {
  const url = officialsVideoUrl();
  if (officialsVideoSeen?.url !== url || Date.now() > officialsVideoSeen.until) {
    const read = await mp4Seconds(rangesOf(url)).catch((err) => {
      console.error(`[expo] Officials' training video: its length couldn't be read from ${url} (${err.message})`);
      return null;
    });
    const seconds = read ? Math.round(read) : (officialsVideoSeen?.url === url && officialsVideoSeen.seconds) || Number(env("EXPO_OFFICIALS_VIDEO_SECONDS")) || null;
    officialsVideoSeen = { url, seconds, until: Date.now() + (read ? 6 * 3600_000 : 60_000) };
  }
  const { seconds } = officialsVideoSeen;
  return { available: !!seconds, seconds, url: seconds ? url : null };
}
/**
 * A person's training as they see it: the video (its link and length), the quiz's size and pass mark,
 * how far they've watched, their goes (newest first) and their certificate.
 */
async function officialsTraining(userId) {
  const [t, attempts, video] = await Promise.all([
    q1(`SELECT * FROM official_training WHERE user_id = $1`, [userId]),
    q(`SELECT score, total, missed, created_at FROM official_quiz_attempts WHERE user_id = $1 ORDER BY created_at DESC`, [userId]),
    officialsVideo(),
  ]);
  return {
    video,
    quiz: { questions: OFFICIALS_QUIZ.length, passMark: passScore(), passPercent: OFFICIALS_PASS_PERCENT },
    started: !!t,
    watchedSeconds: t?.watched_seconds ?? 0,
    watchedAt: t?.watched_at ?? null,
    passedAt: t?.passed_at ?? null,
    certificate: t?.certificate_name ? { name: t.certificate_name, issuedAt: t.certificate_at } : null,
    attempts: attempts.map(shapeAttempt),
  };
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
    const pay = paymentDetails(b.payment);
    if (pay.missing) return fail(res, 400, "missing_payment", pay.missing);
    const { method, pin, username, cardNum } = pay;

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
          passId, days.length === 1 ? days[0] : "", JSON.stringify(days), pass.price, JSON.stringify(tickets), method, pay.payer]);
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

  /* ---- ad spaces: a proposal, the Expo team's approval, then payment -- */

  // Each space with what's left of it, and (signed in) how many the person holds.
  router.get("/expo/advertising/spaces", ...maybeUser, asyncHandler(async (req, res) => {
    ok(res, { spaces: await adSpaces(req.expoUserId, pool, { test: await isAdminUser(req.expoUserId) }) });
  }));

  // The signed-in person's proposals, newest first, with the spaces as they stand for them.
  router.get("/expo/advertising/proposals", ...user, asyncHandler(async (req, res) => {
    const rows = await q(`SELECT * FROM ad_proposals WHERE user_id = $1 ORDER BY created_at DESC`, [req.expoUserId]);
    const art = await adArtworkOf(rows.map((r) => r.id));
    ok(res, { proposals: rows.map((r) => shapeAd(r, { artwork: art[r.id] || [] })), spaces: await adSpaces(req.expoUserId, pool, { test: await isAdminUser(req.expoUserId) }) });
  }));

  // { space, size?, quantity, title, description, videoUrl?, artworkUrl?, expectedPrice?, key? }. Nothing is charged:
  // the proposal waits for the Expo team (pending), and the person hears on KingsChat that it's in. A
  // space that comes in sizes needs one of them (`size`, its id), at that size's price. Each
  // product or service (one account's proposals with that title) holds at most a space's perProduct
  // (what it has waiting, approved or paid counts), and no more than are left. A video advert is one
  // video, given as a link (videoUrl), with no limit. A printed space's artwork may come as a link too
  // (artworkUrl: KingsCloud, Google Drive…), besides or instead of files. `key` (8 to 80 letters, digits, - and _): the
  // same key sent again by the same person gives back the proposal it made (200, repeated: true), not
  // a second one, and no message.
  router.post("/expo/advertising/proposals", ...user, asyncHandler(async (req, res) => {
    const b = req.body || {};
    const key = clientKey(b.key);
    const spaceId = clean(b.space, 40);
    const s = adSpace(spaceId);
    if (!s || (s.adminOnly && !(await isAdminUser(req.expoUserId)))) return fail(res, 400, "bad_space", "Choose one of the ad spaces.");
    const video = s.kind === "video";
    const quantity = Number(b.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1) return fail(res, 400, "bad_quantity", "Choose at least 1 space.");
    if (video && quantity !== 1) return fail(res, 400, "bad_quantity", "A video advert is one video: send a proposal for each.");
    const title = clean(b.title, 120);
    const description = clean(b.description, 1000);
    if (!title) return fail(res, 400, "missing_fields", "Give your ad a title: the product or service it's for.");
    if (!description) return fail(res, 400, "missing_fields", "Say what your ad is about.");
    const videoUrl = video ? videoLink(b.videoUrl) : null;
    if (video && !videoUrl) return fail(res, 400, "bad_video_link", "Give the link to your video: a web address where the Expo team can download it.");
    const artworkUrl = video || !clean(b.artworkUrl) ? null : videoLink(b.artworkUrl);
    if (!video && clean(b.artworkUrl) && !artworkUrl) return fail(res, 400, "bad_artwork_link", "The artwork link should be a web address, starting https://");
    const size = adSizeOf(s, b.size);
    if (s.sizes && !size) return fail(res, 400, "bad_size", `Choose a size for ${s.name}: ${Object.values(s.sizes).map((z) => z.size).join(", ")}.`);
    const price = size ? size.price : s.price;
    if (b.expectedPrice != null && !sameAmount(b.expectedPrice, price)) return fail(res, 409, "price_changed", `${s.name}${size ? `, ${size.size},` : ""} are ${amountLabel(price)} a ${video ? "video" : "space"}.`);

    const id = crypto.randomUUID();
    const client = await pool.connect();
    let row;
    try {
      await client.query("BEGIN");
      // One proposal at a time for each person, so two at once can't go past the limit together.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`expo-ad-user:${req.expoUserId}`]);
      // Sent before (its answer lost on the way back): that proposal, which already counts toward the limit.
      const again = key && (await client.query(`SELECT * FROM ad_proposals WHERE user_id = $1 AND client_key = $2`, [req.expoUserId, key])).rows[0];
      if (again) {
        await client.query("ROLLBACK");
        return ok(res, { proposal: shapeAd(again, { artwork: (await adArtworkOf([again.id]))[again.id] || [] }), repeated: true });
      }
      const now = (await adSpaces(req.expoUserId, client, { test: true })).find((x) => x.id === spaceId);
      if (s.perProduct != null) {
        const have = now.held.filter((h) => productKey(h.title) === productKey(title)).reduce((n, h) => n + h.quantity, 0);
        const room = s.perProduct - have;
        if (quantity > room) {
          await client.query("ROLLBACK");
          return fail(res, 409, "over_limit", room > 0
            ? `Each product or service can hold up to ${s.perProduct} ${s.name} spaces. ${title} has ${have} already, so you can ask for ${room} more.`
            : `${title} already holds the most ${s.name} spaces one product or service can (${s.perProduct}).`);
        }
      }
      if (now.remaining != null && quantity > now.remaining) {
        await client.query("ROLLBACK");
        return fail(res, 409, "not_enough_spaces", now.remaining ? `Only ${now.remaining} ${s.name} space${now.remaining === 1 ? " is" : "s are"} left.` : `${s.name} are fully booked.`);
      }
      row = (await client.query(
        `INSERT INTO ad_proposals (id, reference, user_id, space, size, quantity, unit_price, total, title, description, video_url, client_key, artwork_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
        [id, reference("AD"), req.expoUserId, spaceId, size ? b.size : null, quantity, price, Math.round(price * quantity * 10000) / 10000, title, description, videoUrl, key, artworkUrl])).rows[0];
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    adNotifyLater(id, "submitted");
    res.status(201);
    ok(res, { proposal: shapeAd(row) });
  }));

  // { name, data: base64, key? }: one image of artwork for the person's own proposal, while it's being
  // reviewed. JPG, PNG or WebP (by its content), up to AD_ARTWORK_MAX_BYTES, AD_ARTWORK_MAX to a
  // proposal. The same `key` sent again gives back the image it stored (200), not a second copy.
  router.post("/expo/advertising/proposals/:id/artwork", ...user, asyncHandler(async (req, res) => {
    const mine = isUuid(req.params.id) && (await q1(`SELECT id, status FROM ad_proposals WHERE id = $1 AND user_id = $2`, [req.params.id, req.expoUserId]));
    if (!mine) return fail(res, 404, "not_found", "No such proposal.");
    const key = clientKey(req.body?.key);
    const stored = async () => key && q1(`SELECT ${AD_ART_COLUMNS} FROM ad_artwork WHERE proposal_id = $1 AND client_key = $2`, [mine.id, key]);
    const before = await stored();
    if (before) return ok(res, { artwork: shapeArtwork(before), repeated: true });
    if (mine.status !== "pending") return fail(res, 409, "not_pending", "Artwork can be added while the proposal is being reviewed.");
    const bytes = Buffer.from(String(req.body?.data || ""), "base64");
    if (bytes.length > AD_ARTWORK_MAX_BYTES) return fail(res, 413, "too_large", `Each image must be ${(AD_ARTWORK_MAX_BYTES / 1024 / 1024).toFixed(1)} MB or smaller.`);
    const type = imageType(bytes);
    if (!type) return fail(res, 400, "bad_type", "Artwork must be a JPG, PNG or WebP image.");
    const row = await q1(
      `INSERT INTO ad_artwork (id, proposal_id, name, type, bytes, client_key) SELECT $1, $2, $3, $4, $5, $7
        WHERE (SELECT count(*) FROM ad_artwork WHERE proposal_id = $2) < $6
        ON CONFLICT (proposal_id, client_key) WHERE client_key IS NOT NULL DO NOTHING RETURNING ${AD_ART_COLUMNS}`,
      [crypto.randomUUID(), mine.id, clean(req.body?.name, 120), type, bytes, AD_ARTWORK_MAX, key]);
    if (!row) {
      // Stored by the same key a moment ago (two sends at once), or the proposal is full.
      const meanwhile = await stored();
      if (meanwhile) return ok(res, { artwork: shapeArtwork(meanwhile), repeated: true });
      return fail(res, 409, "too_many", `A proposal can have up to ${AD_ARTWORK_MAX} images.`);
    }
    res.status(201);
    ok(res, { artwork: shapeArtwork(row) });
  }));

  // { name, size, key?, preview? }: starts one artwork file (up to AD_FILE_MAX_BYTES) for the person's own
  // proposal while it's being reviewed; its pieces follow (PUT …/files/:fileId). `preview`: for an image,
  // a small review copy (base64 JPG, PNG or WebP, up to AD_ARTWORK_MAX_BYTES) for the team to look at.
  // AD_ARTWORK_MAX files and images to a proposal. The same `key` again gives back the file it started
  // (200, repeated), with how much of it has arrived, so a send can carry on where it stopped.
  // Answers { artwork, received, chunkMax }.
  router.post("/expo/advertising/proposals/:id/files", ...user, asyncHandler(async (req, res) => {
    const mine = isUuid(req.params.id) && (await q1(`SELECT id, status FROM ad_proposals WHERE id = $1 AND user_id = $2`, [req.params.id, req.expoUserId]));
    if (!mine) return fail(res, 404, "not_found", "No such proposal.");
    const key = clientKey(req.body?.key);
    const stored = async () => key && q1(`SELECT ${AD_ART_COLUMNS} FROM ad_artwork WHERE proposal_id = $1 AND client_key = $2 AND file_size IS NOT NULL`, [mine.id, key]);
    const answer = (a) => ({ artwork: shapeArtwork(a), received: Number(a.received), chunkMax: AD_CHUNK_MAX_BYTES });
    const before = await stored();
    if (before) return ok(res, { ...answer(before), repeated: true });
    if (mine.status !== "pending") return fail(res, 409, "not_pending", "Artwork can be added while the proposal is being reviewed.");
    const size = Number(req.body?.size);
    if (!Number.isSafeInteger(size) || size < 1) return fail(res, 400, "bad_size", "Say how big the file is.");
    if (size > AD_FILE_MAX_BYTES) return fail(res, 413, "too_large", `Each file must be ${AD_FILE_MAX_BYTES / 1024 / 1024} MB or smaller. For a bigger one, give a link to it (KingsCloud, Google Drive…).`);
    let preview = null, previewType = "";
    if (req.body?.preview) {
      preview = Buffer.from(String(req.body.preview), "base64");
      previewType = imageType(preview);
      if (preview.length > AD_ARTWORK_MAX_BYTES || !previewType) return fail(res, 400, "bad_preview", "The review copy must be a JPG, PNG or WebP image.");
    }
    const row = await q1(
      `INSERT INTO ad_artwork (id, proposal_id, name, type, bytes, client_key, file_size) SELECT $1, $2, $3, $4, $5, $7, $8
        WHERE (SELECT count(*) FROM ad_artwork WHERE proposal_id = $2) < $6
        ON CONFLICT (proposal_id, client_key) WHERE client_key IS NOT NULL DO NOTHING RETURNING ${AD_ART_COLUMNS}`,
      [crypto.randomUUID(), mine.id, clean(req.body?.name, 120), previewType, preview, AD_ARTWORK_MAX, key, size]);
    if (!row) {
      const meanwhile = await stored();
      if (meanwhile) return ok(res, { ...answer(meanwhile), repeated: true });
      return fail(res, 409, "too_many", `A proposal can have up to ${AD_ARTWORK_MAX} files.`);
    }
    res.status(201);
    ok(res, answer(row));
  }));

  // The next piece of an artwork file, as the request's raw body (up to AD_CHUNK_MAX_BYTES), at
  // ?offset= (the bytes already there). A piece already stored (its answer lost on the way back) is
  // taken again without being written twice; one that would leave a gap is refused (409 bad_offset)
  // with `received`, where to carry on from. The first piece must show the file is artwork (a JPG,
  // PNG, WebP or TIFF image, a PDF, a Photoshop or PostScript file). Answers { artwork, received, complete }.
  router.put("/expo/advertising/proposals/:id/files/:fileId", ...user,
    raw({ type: () => true, limit: AD_CHUNK_MAX_BYTES }),
    asyncHandler(async (req, res) => {
      if (!isUuid(req.params.id) || !isUuid(req.params.fileId)) return fail(res, 404, "not_found", "No such file.");
      const piece = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const offset = Number(req.query.offset);
      if (!Number.isSafeInteger(offset) || offset < 0) return fail(res, 400, "bad_offset", "Say where this piece goes (offset).");
      const client = await pool.connect();
      let out;
      try {
        await client.query("BEGIN");
        // One piece at a time for each file: two sent at once take turns.
        const a = (await client.query(
          `SELECT ${adArtColumns("w.")}
             FROM ad_artwork w JOIN ad_proposals p ON p.id = w.proposal_id
            WHERE w.id = $1 AND w.proposal_id = $2 AND p.user_id = $3 AND w.file_size IS NOT NULL FOR UPDATE OF w`,
          [req.params.fileId, req.params.id, req.expoUserId])).rows[0];
        const have = a ? Number(a.received) : 0;
        if (!a) out = [404, "not_found", "No such file."];
        else if (a.completed_at || offset + piece.length <= have) out = { a };
        else if (offset !== have) out = { gap: have };
        else if (!piece.length) out = [400, "empty", "This piece has nothing in it."];
        else if (offset + piece.length > Number(a.file_size)) out = [400, "too_long", "This file is longer than its size said."];
        else {
          const fileType = offset === 0 ? artworkFileType(piece) : a.file_type;
          if (!fileType) out = [400, "bad_type", "Artwork must be a JPG, PNG, WebP or TIFF image, a PDF, or a Photoshop (PSD), Illustrator or EPS file."];
          else {
            await fs.promises.mkdir(AD_FILES_DIR, { recursive: true });
            const fh = await fs.promises.open(adFilePath(a.id), offset === 0 ? "w" : "r+");
            try {
              // Anything past what's recorded is from a piece whose answer never got here: written over.
              await fh.truncate(offset);
              await fh.write(piece, 0, piece.length, offset);
              if (offset + piece.length === Number(a.file_size)) await fh.sync();
            } finally {
              await fh.close();
            }
            const moved = (await client.query(
              `UPDATE ad_artwork SET received = $2, file_type = $3, completed_at = CASE WHEN $2 = file_size THEN now() END WHERE id = $1 RETURNING ${AD_ART_COLUMNS}`,
              [a.id, offset + piece.length, fileType])).rows[0];
            out = { a: moved };
          }
        }
        await client.query(Array.isArray(out) ? "ROLLBACK" : "COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      if (Array.isArray(out)) return fail(res, ...out);
      if (out.gap != null) return res.status(409).json({ status: false, error: "bad_offset", message: `This file has ${out.gap} bytes so far: carry on from there.`, received: out.gap });
      const art = shapeArtwork(out.a);
      ok(res, { artwork: art, received: art.received, complete: art.complete });
    }));

  // The person withdraws their own proposal, before it's paid (and not while a payment is with Espees).
  router.post("/expo/advertising/proposals/:id/cancel", ...user, asyncHandler(async (req, res) => {
    const mine = isUuid(req.params.id) && (await q1(`SELECT * FROM ad_proposals WHERE id = $1 AND user_id = $2`, [req.params.id, req.expoUserId]));
    if (!mine) return fail(res, 404, "not_found", "No such proposal.");
    const row = await q1(
      `UPDATE ad_proposals SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'owner'
        WHERE id = $1 AND status IN ('pending', 'approved') AND (payment_status IS NULL OR NOT payment_status = ANY($2)) RETURNING *`, [mine.id, AD_PAYING]);
    if (!row) {
      return fail(res, 409, "not_cancellable", mine.status === "paid" ? "This ad space is paid for. Message us on KingsChat about it."
        : AD_PAYING.includes(mine.payment_status) ? "A payment for this is with Espees, so it can't be cancelled now. Message us on KingsChat." : `This proposal is already ${mine.status}.`);
    }
    adNotifyLater(row.id, "cancelled");
    ok(res, { proposal: shapeAd(row, { artwork: (await adArtworkOf([row.id]))[row.id] || [] }) });
  }));

  // The payment link: whoever has it sees the ad and what's owed (nothing about the account) and can pay.
  router.get("/expo/advertising/pay/:token", ...app, asyncHandler(async (req, res) => {
    const r = await q1(`SELECT * FROM ad_proposals WHERE pay_token = $1`, [clean(req.params.token, 80)]);
    if (!r) return fail(res, 404, "not_found", "This payment link isn't valid.");
    ok(res, { proposal: shapeAdPayment(r) });
  }));

  // { expectedTotal?, payment: { method: "wallet", username, pin } | { method: "card", cardNum, pin } }:
  // pays an approved proposal in Espees there and then, as a pass is paid (the PIN goes to Espees and
  // is never kept). Answers as soon as Espees has taken it (201, CHARGED); confirming it with Espees
  // follows in the background, as /confirm also does, and makes it paid.
  router.post("/expo/advertising/pay/:token", ...app, asyncHandler(async (req, res) => {
    if (!ESPEES_API_TOKEN) return fail(res, 503, "not_on_sale", "Payments in Espees aren't set up yet.");
    const b = req.body || {};
    const pay = paymentDetails(b.payment);
    if (pay.missing) return fail(res, 400, "missing_payment", pay.missing);
    // The proposal is held while it's marked as with Espees, so a second Pay can't charge it again.
    const client = await pool.connect();
    let r;
    try {
      await client.query("BEGIN");
      r = (await client.query(`SELECT * FROM ad_proposals WHERE pay_token = $1 FOR UPDATE`, [clean(req.params.token, 80)])).rows[0];
      const refuse = !r ? [404, "not_found", "This payment link isn't valid."]
        : r.status === "paid" ? [409, "already_paid", "This ad space is already paid for."]
        : r.status !== "approved" ? [409, "not_payable", `This proposal is ${r.status}, so it can't be paid.`]
        : b.expectedTotal != null && !sameAmount(b.expectedTotal, r.total) ? [409, "price_changed", `The total is ${amountLabel(r.total)}.`]
        : AD_PAYING.includes(r.payment_status) ? [409, "payment_in_progress", "A payment for this is already with Espees. Please don't pay again: check back in a few minutes, or message us on KingsChat."]
        : null;
      if (refuse) {
        await client.query("ROLLBACK");
        return fail(res, ...refuse);
      }
      await client.query(`UPDATE ad_proposals SET payment_status = 'PROCESSING', payment_method = $2, payer = $3, payment_error = NULL, payment_ref = NULL WHERE id = $1`, [r.id, pay.method, pay.payer]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const charge = await chargeEspees({ reference: r.reference, pass_price: r.total }, pay);
    if (charge.declined || charge.unavailable) {
      await q(`UPDATE ad_proposals SET payment_status = 'DECLINED', payment_error = $2 WHERE id = $1`, [r.id, charge.declined || `unreachable: ${charge.unavailable}`]);
      return charge.declined
        ? fail(res, 402, "payment_declined", charge.declined)
        : fail(res, 502, "payment_unavailable", "Espees couldn't be reached, so nothing was taken. Please try again in a moment.");
    }
    if (charge.unknown) {
      console.error(`[expo] ad payment ${r.reference}: can't tell whether Espees took the payment (${charge.unknown})`);
      await q(`UPDATE ad_proposals SET payment_status = 'UNKNOWN', payment_error = $2 WHERE id = $1`, [r.id, charge.unknown]);
      return fail(res, 502, "payment_unknown", "We couldn't tell whether Espees took the payment. Please don't pay again: the Expo team will check it and message you on KingsChat.");
    }
    const row = await q1(`UPDATE ad_proposals SET payment_ref = $2, payment_status = 'CHARGED' WHERE id = $1 RETURNING *`, [r.id, charge.reference]);
    res.status(201);
    ok(res, { proposal: shapeAdPayment(row) });
    setImmediate(() => settleAd(r.id).catch((err) => console.error(`[expo] settling ${r.reference}: ${err.message}`)));
  }));

  // The payment link's proposal brought up to date: a payment Espees has taken is checked with it.
  router.post("/expo/advertising/pay/:token/confirm", ...app, asyncHandler(async (req, res) => {
    const found = await q1(`SELECT id FROM ad_proposals WHERE pay_token = $1`, [clean(req.params.token, 80)]);
    if (!found) return fail(res, 404, "not_found", "This payment link isn't valid.");
    const r = await settleAd(found.id);
    ok(res, { proposal: shapeAdPayment(r), ...(r.checkError ? { checkError: "Espees couldn't be reached to check the payment. Try again in a moment." } : {}) });
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

  /* ---- officials' training --------------------------------------------- */

  // The signed-in person's training: the video, the quiz's size and pass mark, how far they've
  // watched, their goes at the quiz and their certificate (see officialsTraining).
  router.get("/expo/officials", ...user, asyncHandler(async (req, res) => {
    ok(res, { training: await officialsTraining(req.expoUserId) });
  }));

  // { seconds }: how far into the video the person has watched, to pick up from there and for the team to
  // see. Their furthest point moves on no faster than the video plays since their last report; near the
  // end, the video is watched.
  router.post("/expo/officials/progress", ...user, asyncHandler(async (req, res) => {
    const video = await officialsVideo();
    if (!video.available) return fail(res, 503, "no_video", "The training video isn't available yet.");
    const given = Math.max(0, Math.min(video.seconds, Math.floor(Number(req.body?.seconds) || 0)));
    await q(
      `INSERT INTO official_training (user_id, watched_seconds) VALUES ($1, LEAST($2::int, $3::int))
       ON CONFLICT (user_id) DO UPDATE SET
         watched_seconds = GREATEST(official_training.watched_seconds,
           LEAST($2::int, official_training.watched_seconds + $3::int + floor(EXTRACT(EPOCH FROM now() - official_training.progress_at) * $4::numeric)::int)),
         progress_at = now(), updated_at = now()`,
      [req.expoUserId, given, OFFICIALS_SLACK_SECONDS, OFFICIALS_PLAY_RATE]);
    await q(`UPDATE official_training SET watched_at = now() WHERE user_id = $1 AND watched_at IS NULL AND watched_seconds >= $2`,
      [req.expoUserId, video.seconds - OFFICIALS_END_SECONDS]);
    ok(res, { training: await officialsTraining(req.expoUserId) });
  }));

  // The quiz, open to everyone signed in (watching the video first isn't required): every question, its
  // choices in a new order each time, without the answers.
  router.get("/expo/officials/quiz", ...user, asyncHandler(async (req, res) => {
    ok(res, { questions: quizForPerson(), passMark: passScore(), passPercent: OFFICIALS_PASS_PERCENT });
  }));

  // { answers: { "1": "b", … }, key? }: a go at the quiz, with every question answered. It's kept with its
  // score and the questions missed (which are told, but not their right answers); the pass mark passes.
  // As many goes as it takes, until one passes. The same `key` sent again gives back the go it made.
  router.post("/expo/officials/quiz", ...user, asyncHandler(async (req, res) => {
    const key = clientKey(req.body?.key);
    const byKey = async () => key && q1(`SELECT * FROM official_quiz_attempts WHERE user_id = $1 AND client_key = $2`, [req.expoUserId, key]);
    const before = await byKey();
    if (before) return ok(res, { attempt: shapeAttempt(before), training: await officialsTraining(req.expoUserId), repeated: true });
    // Their training starts here if they haven't watched any of the video.
    const t = await q1(
      `INSERT INTO official_training (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET updated_at = now() RETURNING passed_at`, [req.expoUserId]);
    if (t.passed_at) return fail(res, 409, "already_passed", "You've passed the quiz already.");
    const marked = markQuiz(req.body?.answers);
    if (!marked) return fail(res, 400, "unanswered", "Answer every question.");
    const row = await q1(
      `INSERT INTO official_quiz_attempts (id, user_id, score, total, answers, missed, client_key) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, client_key) WHERE client_key IS NOT NULL DO NOTHING RETURNING *`,
      [crypto.randomUUID(), req.expoUserId, marked.score, marked.total, JSON.stringify(marked.answers), marked.missed, key]);
    // Made by the same key a moment ago (two sends at once).
    if (!row) return ok(res, { attempt: shapeAttempt(await byKey()), training: await officialsTraining(req.expoUserId), repeated: true });
    if (marked.score >= passScore(marked.total)) {
      await q(`UPDATE official_training SET passed_at = now(), updated_at = now() WHERE user_id = $1 AND passed_at IS NULL`, [req.expoUserId]);
    }
    res.status(201);
    ok(res, { attempt: shapeAttempt(row), training: await officialsTraining(req.expoUserId) });
  }));

  // { name }: the name on the person's certificate, once they've passed. Set once: it can't be changed
  // after (the same name sent again, a retry, is fine).
  router.post("/expo/officials/certificate", ...user, asyncHandler(async (req, res) => {
    const name = clean(String(req.body?.name ?? "").replace(/\s+/g, " "), OFFICIALS_NAME_MAX);
    if (name.length < 2) return fail(res, 400, "bad_name", "Enter your name as it should appear on your certificate.");
    const row = await q1(
      `UPDATE official_training SET certificate_name = $2, certificate_at = now(), updated_at = now()
        WHERE user_id = $1 AND passed_at IS NOT NULL AND certificate_name IS NULL RETURNING user_id`, [req.expoUserId, name]);
    if (!row) {
      const t = await q1(`SELECT passed_at, certificate_name FROM official_training WHERE user_id = $1`, [req.expoUserId]);
      if (!t?.passed_at) return fail(res, 409, "not_passed", "Pass the quiz first.");
      if (t.certificate_name !== name) return fail(res, 409, "name_set", "The name on your certificate is set already, and can't be changed.");
    }
    ok(res, { training: await officialsTraining(req.expoUserId) });
  }));

  /* ---- team votes: 1 Espee for one team, once and for good ------------- */

  // The teams with their counted votes (`votes` and `total` null when EXPO_VOTE_COUNTS is off),
  // whether votes are being taken, what one costs and, signed in, the person's own vote. A payment
  // of theirs that Espees has taken but not yet confirmed is checked again as they look (at most
  // every 15 seconds), so a vote paid for on a page that then closed still gets counted.
  router.get("/expo/votes", ...maybeUser, asyncHandler(async (req, res) => {
    let mine = req.expoUserId ? await voteOf(req.expoUserId) : null;
    const due = mine && mine.status === "pending" && mine.payment_status === "CHARGED" && (!mine.payment_checked_at || Date.now() - new Date(mine.payment_checked_at).getTime() > 15000);
    if (due) mine = await settleVote(mine.id);
    ok(res, { open: votingOpen(), price: VOTE_PRICE, currency: "ESPEES", ...(await voteTally()), vote: shapeVote(mine) });
  }));

  // The signed-in person's vote: { vote } (pending or counted), or null when they haven't voted.
  router.get("/expo/votes/me", ...user, asyncHandler(async (req, res) => {
    ok(res, { vote: shapeVote(await voteOf(req.expoUserId)) });
  }));

  // { team, expectedPrice?, payment: { method: "wallet", username, pin } | { method: "card", cardNum, pin } }:
  // the signed-in person's one vote. Espees is charged there and then, as for a pass (the PIN goes
  // to Espees and is never kept), then asked to confirm the charge: 201 { vote }, counted once it
  // has (pending, CHARGED, until then: /expo/votes/confirm asks again). Someone who has voted, or
  // whose payment may have been taken, is refused (409) before anything is charged.
  router.post("/expo/votes", ...user, asyncHandler(async (req, res) => {
    if (!votingOpen()) return fail(res, 503, "voting_closed", ESPEES_API_TOKEN ? "Voting is closed." : "Voting isn't open yet.");
    const b = req.body || {};
    const team = clean(b.team, 40);
    if (!Object.hasOwn(VOTE_TEAMS, team)) return fail(res, 400, "bad_team", "Pick one of the teams.");
    if (b.expectedPrice != null && !sameAmount(b.expectedPrice, VOTE_PRICE)) return fail(res, 409, "price_changed", `A vote costs ${voteCost()}.`);
    const u = await q1(`SELECT id, kc_id FROM users WHERE id = $1`, [req.expoUserId]);
    const had = await voteOf(u.id);
    if (had) return fail(res, ...voteRefusal(had));
    const pay = paymentDetails(b.payment);
    if (pay.missing) return fail(res, 400, "missing_payment", pay.missing);

    // The vote is made, marked as with Espees, before anything is charged, under the person's
    // payment lock: a second Vote, at the same moment or ever after, finds it and is refused. The
    // unique indexes refuse it too, whatever this code does.
    const id = crypto.randomUUID();
    const ref = voteReference();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`expo-pay:${u.id}`]);
      const live = await voteOf(u.id, client);
      if (live) {
        await client.query("ROLLBACK");
        return fail(res, ...voteRefusal(live));
      }
      await client.query(
        `INSERT INTO team_votes (id, reference, user_id, kc_id, team, amount, status, payment_status, payment_method, payer)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'PROCESSING', $7, $8)`,
        [id, ref, u.id, u.kc_id || null, team, VOTE_PRICE, pay.method, pay.payer]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (err.code !== "23505" || !/^team_votes_one_per_/.test(err.constraint || "")) throw err;
      const live = await voteOf(u.id);
      return fail(res, ...(live ? voteRefusal(live) : [409, "already_voted", "You've already voted. A vote can't be changed."]));
    } finally {
      client.release();
    }

    const charge = await chargeEspees({ reference: ref, pass_price: VOTE_PRICE }, pay);
    if (charge.declined || charge.unavailable) {
      // Nothing was taken: the attempt is kept, cancelled, and they can vote again (for any team).
      await q(`UPDATE team_votes SET status = 'cancelled', cancelled_at = now(), payment_status = 'DECLINED', payment_error = $2, updated_at = now() WHERE id = $1 AND status = 'pending'`,
        [id, charge.declined || `unreachable: ${charge.unavailable}`]);
      return charge.declined
        ? fail(res, 402, "payment_declined", charge.declined)
        : fail(res, 502, "payment_unavailable", "Espees couldn't be reached, so nothing was taken. Please try again in a moment.");
    }
    if (charge.unknown) {
      console.error(`[expo] vote ${ref}: can't tell whether Espees took the payment (${charge.unknown})`);
      await q(`UPDATE team_votes SET payment_status = 'UNKNOWN', payment_error = $2, updated_at = now() WHERE id = $1`, [id, charge.unknown]);
      return fail(res, 502, "payment_unknown", "We couldn't tell whether Espees took the payment. Please don't pay again: the Expo team will check it, and your vote will show here once it's confirmed.");
    }
    await q(`UPDATE team_votes SET payment_ref = $2, payment_status = 'CHARGED', updated_at = now() WHERE id = $1`, [id, charge.reference]);
    const v = await settleVote(id);
    res.status(201);
    ok(res, { vote: shapeVote(v) });
  }));

  // The person's own vote brought up to date: a payment Espees has taken is checked with it, and
  // counted once confirmed. checkError: Espees couldn't be asked this time.
  router.post("/expo/votes/confirm", ...user, asyncHandler(async (req, res) => {
    const mine = await voteOf(req.expoUserId);
    if (!mine) return fail(res, 404, "no_vote", "You haven't voted yet.");
    const r = await settleVote(mine.id);
    ok(res, { vote: shapeVote(r), ...(r.checkError ? { checkError: "Espees couldn't be reached to check the payment. Try again in a moment." } : {}) });
  }));

  /* ---- admin ----------------------------------------------------------- */

  const limit =(req, max = 500) => Math.min(max, Math.max(1, Number(req.query.limit) || 200));

  const shapeAdminUser = (r) => ({ ...shapeUser(r), disabled: !!r.disabled_at, disabledReason: r.disabled_reason || "", exhibitor: r.exhibitor_id ? { id: r.exhibitor_id, name: r.exhibitor_name } : null });
  const ADMIN_USER_SELECT = `SELECT u.*, e.name AS exhibitor_name FROM users u LEFT JOIN exhibitors e ON e.id = u.exhibitor_id`;

  router.get("/expo/admin/stats", requireAdmin, asyncHandler(async (_req, res) => {
    const row = await q1(`SELECT (SELECT count(*)::int FROM users) AS users, (SELECT count(*)::int FROM exhibitors) AS exhibitors,
      (SELECT count(*)::int FROM bookings WHERE status = 'confirmed') AS bookings, (SELECT count(*)::int FROM registrations) AS registrations,
      (SELECT count(*)::int FROM sponsor_enquiries) AS enquiries, (SELECT count(*)::int FROM program_applications) AS applications,
      (SELECT count(*)::int FROM team_votes WHERE status = 'counted') AS votes`);
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
  // Newest first. ?q= (name, username, email) and ?exhibitor= (a team) narrow it; ?limit= and ?offset=
  // page through it, and `total` is how many match in all.
  router.get("/expo/admin/users", requireAdmin, asyncHandler(async (req, res) => {
    const needle = clean(req.query.q, 100).toLowerCase();
    const exhibitor = clean(req.query.exhibitor, 80);
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
    const where = `WHERE ($1 = '' OR lower(coalesce(u.kc_username,'') || ' ' || coalesce(u.kc_name,'') || ' ' || coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'') || ' ' || coalesce(u.email,'')) LIKE '%' || $1 || '%')
       AND ($2 = '' OR u.exhibitor_id = $2)`;
    const [rows, count] = await Promise.all([
      q(`${ADMIN_USER_SELECT} ${where} ORDER BY u.created_at DESC, u.id LIMIT $3 OFFSET $4`, [needle, exhibitor, limit(req), offset]),
      q1(`SELECT count(*)::int AS n FROM users u ${where}`, [needle, exhibitor]),
    ]);
    ok(res, { users: rows.map(shapeAdminUser), total: count?.n ?? rows.length, offset });
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
    // Its artwork files, kept on disk, go once the account has.
    const files = (await q(`SELECT w.id FROM ad_artwork w JOIN ad_proposals p ON p.id = w.proposal_id WHERE p.user_id = $1 AND w.file_size IS NOT NULL`, [id])).map((r) => r.id);
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
        // After the messages, which an ad's removal would otherwise take with it uncounted.
        ads: await count(`DELETE FROM ad_proposals WHERE user_id = $1`),
        quizAttempts: await count(`DELETE FROM official_quiz_attempts WHERE user_id = $1`),
      };
      await client.query(`DELETE FROM users WHERE id = $1`, [id]);
      await client.query("COMMIT");
      for (const f of files) await fs.promises.rm(adFilePath(f), { force: true }).catch((err) => console.error(`[expo] artwork file ${f} not removed:`, err.message));
      ok(res, { deleted: id, removed: { ...removed, artworkFiles: files.length } });
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

  /* ---- admin: ad space proposals --------------------------------------- */

  // ?status= narrows the list. Each with the account it's from and its artwork (not the images:
  // /expo/admin/advertising/artwork/:id gives one), and the spaces with what's left of them.
  router.get("/expo/admin/advertising", requireAdmin, asyncHandler(async (req, res) => {
    const status = clean(req.query.status, 20);
    const rows = await q(
      `SELECT a.*, u.kc_username, u.kc_name, u.first_name, u.last_name, u.email, u.phone, u.organisation
         FROM ad_proposals a JOIN users u ON u.id = a.user_id WHERE ($1 = '' OR a.status = $1) ORDER BY a.created_at DESC LIMIT $2`, [status, limit(req, 2000)]);
    const art = await adArtworkOf(rows.map((r) => r.id));
    ok(res, { proposals: rows.map((r) => shapeAd(r, { artwork: art[r.id] || [], admin: true })), spaces: await adSpaces(null, pool, { test: true }) });
  }));

  // A piece of artwork's image to look at: its review copy (or the image, for one sent before files).
  router.get("/expo/admin/advertising/artwork/:id", requireAdmin, asyncHandler(async (req, res) => {
    const a = isUuid(req.params.id) && (await q1(`SELECT name, type, bytes FROM ad_artwork WHERE id = $1 AND bytes IS NOT NULL`, [req.params.id]));
    if (!a) return fail(res, 404, "not_found", "No such image.");
    res.setHeader("Content-Type", a.type);
    res.setHeader("Content-Disposition", `inline; filename="${(a.name || "artwork").replace(/[^\w.-]+/g, "_").slice(0, 80)}"`);
    res.end(a.bytes);
  }));

  // The artwork file itself, to download, once all of it has arrived (409 not_complete before). For
  // artwork sent before files, its image.
  router.get("/expo/admin/advertising/artwork/:id/file", requireAdmin, asyncHandler(async (req, res) => {
    const a = isUuid(req.params.id) && (await q1(`SELECT id, name, type, bytes, file_size, file_type, received, completed_at FROM ad_artwork WHERE id = $1`, [req.params.id]));
    if (!a) return fail(res, 404, "not_found", "No such file.");
    const filename = (a.name || "artwork").replace(/[^\w.-]+/g, "_").slice(0, 120);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    if (a.file_size == null) {
      res.setHeader("Content-Type", a.type);
      return res.end(a.bytes);
    }
    if (!a.completed_at) return fail(res, 409, "not_complete", `This file didn't finish uploading: ${Number(a.received)} of ${Number(a.file_size)} bytes arrived.`);
    const where = adFilePath(a.id);
    const stat = await fs.promises.stat(where).catch(() => null);
    if (!stat) return fail(res, 404, "file_missing", "This file isn't on the server.");
    res.setHeader("Content-Type", a.file_type || "application/octet-stream");
    res.setHeader("Content-Length", String(stat.size));
    const stream = fs.createReadStream(where);
    stream.on("error", (err) => { console.error(`[expo] artwork file ${a.id}:`, err.message); res.destroy(err); });
    stream.pipe(res);
  }));

  /** An admin's step on a proposal, under a lock on its row: `change(row, client)` answers with the new row, or [http, code, message]. */
  async function adminStep(req, res, change) {
    if (!isUuid(req.params.id)) return fail(res, 404, "not_found", "No such proposal.");
    const client = await pool.connect();
    let out;
    try {
      await client.query("BEGIN");
      const row = (await client.query(`SELECT * FROM ad_proposals WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
      out = row ? await change(row, client) : [404, "not_found", "No such proposal."];
      await client.query(Array.isArray(out) ? "ROLLBACK" : "COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (Array.isArray(out)) return fail(res, ...out);
    return out;
  }
  const adminAd = async (row) => {
    const full = await q1(`SELECT a.*, u.kc_username, u.kc_name, u.first_name, u.last_name, u.email, u.phone, u.organisation FROM ad_proposals a JOIN users u ON u.id = a.user_id WHERE a.id = $1`, [row.id]);
    return shapeAd(full, { artwork: (await adArtworkOf([row.id]))[row.id] || [], admin: true });
  };
  const unsettled = (r) => AD_PAYING.includes(r.payment_status);
  // Whether a pending proposal's space still has room for it, as it starts to take spots: null if so,
  // else the refusal. Holds the space's lock to the end of the transaction.
  const noRoom = async (r, client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`expo-ad-space:${r.space}`]);
    // A space with no limit (the video advert) has no `remaining`; one no longer offered has none left.
    const sp = (await adSpaces(null, client, { test: true })).find((s) => s.id === r.space);
    const left = sp ? sp.remaining : 0;
    return left != null && r.quantity > left ? [409, "not_enough_spaces", `Only ${left} of these space${left === 1 ? " is" : "s are"} left, and this proposal is for ${r.quantity}.`] : null;
  };

  // { note? }: approves a pending proposal if its space still has room (approvals take spots), makes
  // its payment link, and sends it to the owner on KingsChat.
  router.post("/expo/admin/advertising/:id/approve", requireAdmin, asyncHandler(async (req, res) => {
    const row = await adminStep(req, res, async (r, client) => {
      if (r.status !== "pending") return [409, "not_pending", `This proposal is ${r.status}.`];
      const full = await noRoom(r, client);
      if (full) return full;
      return (await client.query(`UPDATE ad_proposals SET status = 'approved', pay_token = $2, review_note = $3, reviewed_at = now() WHERE id = $1 RETURNING *`,
        [r.id, b64url(crypto.randomBytes(24)), clean(req.body?.note, 1000) || null])).rows[0];
    });
    if (!row || res.headersSent) return;
    adNotifyLater(row.id, "approved");
    ok(res, { proposal: await adminAd(row) });
  }));

  // { reason }: turns a proposal down (before it's paid); the owner is told why on KingsChat.
  router.post("/expo/admin/advertising/:id/reject", requireAdmin, asyncHandler(async (req, res) => {
    const reason = clean(req.body?.reason, 1000);
    if (!reason) return fail(res, 400, "missing_reason", "Give the reason: it's sent to them.");
    const row = await adminStep(req, res, async (r, client) => {
      if (!["pending", "approved"].includes(r.status) || unsettled(r)) return [409, "not_rejectable", unsettled(r) ? "A payment for this is with Espees: check it first." : `This proposal is ${r.status}.`];
      return (await client.query(`UPDATE ad_proposals SET status = 'rejected', review_note = $2, reviewed_at = now() WHERE id = $1 RETURNING *`, [r.id, reason])).rows[0];
    });
    if (!row || res.headersSent) return;
    adNotifyLater(row.id, "rejected");
    ok(res, { proposal: await adminAd(row) });
  }));

  // { reason? }: cancels a proposal that isn't paid (an approved one gives its spots back).
  router.post("/expo/admin/advertising/:id/cancel", requireAdmin, asyncHandler(async (req, res) => {
    const row = await adminStep(req, res, async (r, client) => {
      if (!["pending", "approved"].includes(r.status) || unsettled(r)) return [409, "not_cancellable", unsettled(r) ? "A payment for this is with Espees: check it first." : `This proposal is ${r.status}.`];
      return (await client.query(`UPDATE ad_proposals SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'admin', review_note = COALESCE($2, review_note) WHERE id = $1 RETURNING *`,
        [r.id, clean(req.body?.reason, 1000) || null])).rows[0];
    });
    if (!row || res.headersSent) return;
    adNotifyLater(row.id, "cancelled");
    ok(res, { proposal: await adminAd(row) });
  }));

  // { note? }: books a proposal free, for a sponsor whose category comes with ad space: one being
  // reviewed (if its space still has room) or approved (not while a payment for it is with Espees). It
  // is then paid, with nothing to pay (payment_status COMPLIMENTARY) and no payment link; it takes its
  // spots as any booking does, and the owner is told on KingsChat.
  router.post("/expo/admin/advertising/:id/complimentary", requireAdmin, asyncHandler(async (req, res) => {
    const row = await adminStep(req, res, async (r, client) => {
      if (!["pending", "approved"].includes(r.status) || unsettled(r)) return [409, "not_complimentary", unsettled(r) ? "A payment for this is with Espees: check it first." : `This proposal is ${r.status}.`];
      if (r.status === "pending") {
        const full = await noRoom(r, client);
        if (full) return full;
      }
      return (await client.query(
        `UPDATE ad_proposals SET status = 'paid', payment_status = 'COMPLIMENTARY', paid_at = now(), reviewed_at = COALESCE(reviewed_at, now()), pay_token = NULL,
           review_note = COALESCE($2, review_note) WHERE id = $1 RETURNING *`,
        [r.id, clean(req.body?.note, 1000) || null])).rows[0];
    });
    if (!row || res.headersSent) return;
    adNotifyLater(row.id, "complimentary");
    ok(res, { proposal: await adminAd(row) });
  }));

  // A payment Espees has taken, checked with it again (as the payment link's /confirm).
  router.post("/expo/admin/advertising/:id/settle", requireAdmin, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return fail(res, 404, "not_found", "No such proposal.");
    const r = await settleAd(req.params.id);
    if (!r) return fail(res, 404, "not_found", "No such proposal.");
    ok(res, { proposal: await adminAd(r), ...(r.checkError ? { checkError: r.checkError } : {}) });
  }));

  // { note? }: marks an approved proposal paid by hand, once the team has seen the payment in Espees
  // (one without a clear answer, say); the owner hears on KingsChat as for any payment.
  router.post("/expo/admin/advertising/:id/paid", requireAdmin, asyncHandler(async (req, res) => {
    const row = await adminStep(req, res, async (r, client) => {
      if (r.status !== "approved") return [409, "not_approved", `This proposal is ${r.status}.`];
      return (await client.query(`UPDATE ad_proposals SET status = 'paid', paid_at = now(), payment_status = 'MARKED_PAID', payment_error = COALESCE($2, payment_error) WHERE id = $1 RETURNING *`,
        [r.id, clean(req.body?.note, 300) || null])).rows[0];
    });
    if (!row || res.headersSent) return;
    adNotifyLater(row.id, "paid");
    ok(res, { proposal: await adminAd(row) });
  }));

  // Lets an approved proposal be paid again once the team has seen in Espees that a payment without a
  // clear answer (or one stuck being sent) was never taken.
  router.post("/expo/admin/advertising/:id/reopen", requireAdmin, asyncHandler(async (req, res) => {
    const row = await adminStep(req, res, async (r, client) => {
      if (r.status !== "approved" || !["UNKNOWN", "PROCESSING"].includes(r.payment_status)) return [409, "not_reopenable", "Only an approved proposal whose payment had no clear answer can be opened for payment again."];
      return (await client.query(`UPDATE ad_proposals SET payment_status = NULL, payment_error = NULL, payment_ref = NULL WHERE id = $1 RETURNING *`, [r.id])).rows[0];
    });
    if (!row || res.headersSent) return;
    ok(res, { proposal: await adminAd(row) });
  }));

  /* ---- admin: officials' training -------------------------------------- */

  // Everyone who has started the training, newest first: how far into the video, every go at the quiz
  // (its score), when they passed and the name on their certificate. And each question with its right
  // answer and how many goes got it right; the quiz's size and pass mark; the video.
  router.get("/expo/admin/officials", requireAdmin, asyncHandler(async (req, res) => {
    const rows = await q(
      `SELECT t.*, u.kc_username, u.kc_name, u.first_name, u.last_name, u.email, u.phone,
              COALESCE((SELECT json_agg(json_build_object('score', a.score, 'total', a.total, 'at', a.created_at) ORDER BY a.created_at)
                          FROM official_quiz_attempts a WHERE a.user_id = t.user_id), '[]') AS goes
         FROM official_training t JOIN users u ON u.id = t.user_id ORDER BY t.created_at DESC LIMIT $1`, [limit(req, 5000)]);
    const all = (await q1(`SELECT count(*)::int AS n FROM official_quiz_attempts`)).n;
    const missedBy = Object.fromEntries((await q(`SELECT n, count(*)::int AS times FROM official_quiz_attempts, unnest(missed) AS n GROUP BY n`)).map((m) => [m.n, m.times]));
    ok(res, {
      officials: rows.map((r) => ({
        user: { id: r.user_id, username: r.kc_username, name: [r.first_name, r.last_name].filter(Boolean).join(" ") || r.kc_name || null, email: r.email, phone: r.phone },
        startedAt: r.created_at, lastSeenAt: r.updated_at,
        watchedSeconds: r.watched_seconds, watchedAt: r.watched_at, passedAt: r.passed_at,
        certificate: r.certificate_name ? { name: r.certificate_name, issuedAt: r.certificate_at } : null,
        attempts: r.goes.map((a) => ({ score: a.score, total: a.total, passed: a.score >= passScore(a.total), at: a.at })),
      })),
      questions: OFFICIALS_QUIZ.map((item, i) => ({
        n: i + 1, module: item.module, moduleName: OFFICIALS_MODULES[item.module - 1], text: item.text,
        answer: item.options[QUIZ_LETTERS.indexOf(item.answer)], attempts: all, right: all - (missedBy[i + 1] || 0),
      })),
      quiz: { questions: OFFICIALS_QUIZ.length, passMark: passScore(), passPercent: OFFICIALS_PASS_PERCENT },
      video: await officialsVideo(),
    });
  }));

  /* ---- admin: team votes ------------------------------------------------ */

  const VOTE_ADMIN_SELECT = `SELECT v.*, u.kc_username, u.kc_name, u.first_name, u.last_name, u.email FROM team_votes v LEFT JOIN users u ON u.id = v.user_id`;
  const adminVote = async (id) => shapeVote(await q1(`${VOTE_ADMIN_SELECT} WHERE v.id = $1`, [id]), { admin: true });

  // The totals (each team's counted votes; how many votes are counted, being checked and were never
  // paid; the Espees taken) and the votes, newest first: who, the team, when, Espees' reference and
  // where the payment stands. ?status= (counted, pending, cancelled), ?team= and ?q= (name, username,
  // email or a reference) narrow the list; ?limit= and ?offset= page through it, and `total` is how
  // many match in all.
  router.get("/expo/admin/votes", requireAdmin, asyncHandler(async (req, res) => {
    const status = clean(req.query.status, 20);
    const team = clean(req.query.team, 40);
    const needle = clean(req.query.q, 100).toLowerCase();
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
    const where = `WHERE ($1 = '' OR v.status = $1) AND ($2 = '' OR v.team = $2)
       AND ($3 = '' OR lower(coalesce(u.kc_username,'') || ' ' || coalesce(u.kc_name,'') || ' ' || coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'') || ' ' || coalesce(u.email,'') || ' ' || v.reference || ' ' || coalesce(v.payment_ref,'')) LIKE '%' || $3 || '%')`;
    const [rows, count, by, tally] = await Promise.all([
      q(`${VOTE_ADMIN_SELECT} ${where} ORDER BY v.created_at DESC, v.id LIMIT $4 OFFSET $5`, [status, team, needle, limit(req, 1000), offset]),
      q1(`SELECT count(*)::int AS n FROM team_votes v LEFT JOIN users u ON u.id = v.user_id ${where}`, [status, team, needle]),
      q(`SELECT status, count(*)::int AS n, coalesce(sum(amount), 0)::float AS amount FROM team_votes GROUP BY status`),
      voteTally({ all: true }),
    ]);
    const of = (s) => by.find((r) => r.status === s) || { n: 0, amount: 0 };
    ok(res, {
      open: votingOpen(), countsPublic: voteCountsPublic(), price: VOTE_PRICE, teams: tally.teams,
      totals: { counted: of("counted").n, pending: of("pending").n, cancelled: of("cancelled").n, espees: of("counted").amount },
      votes: rows.map((r) => shapeVote(r, { admin: true })), total: count?.n ?? rows.length, offset,
    });
  }));

  // A payment Espees has taken, checked with it again (as the person's own /expo/votes/confirm).
  router.post("/expo/admin/votes/:id/settle", requireAdmin, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return fail(res, 404, "not_found", "No such vote.");
    const r = await settleVote(req.params.id);
    if (!r) return fail(res, 404, "not_found", "No such vote.");
    ok(res, { vote: await adminVote(r.id), ...(r.checkError ? { checkError: r.checkError } : {}) });
  }));

  /** An admin's step on a vote still being paid for, under a lock on its row: `sql` (its $1 the id, $2 the note) makes the change. */
  async function voteStep(req, res, allowed, sql) {
    if (!isUuid(req.params.id)) return fail(res, 404, "not_found", "No such vote.");
    const client = await pool.connect();
    let out;
    try {
      await client.query("BEGIN");
      const row = (await client.query(`SELECT * FROM team_votes WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
      out = !row ? [404, "not_found", "No such vote."]
        : row.status !== "pending" ? [409, "not_pending", row.status === "counted" ? "This vote is already counted." : "This attempt was never paid: there is nothing to change."]
        : !allowed(row) ? [409, "payment_in_progress", "This payment is still going through. Give it a couple of minutes."]
        : (await client.query(sql, [row.id, clean(req.body?.note, 300) || null])).rows[0];
      await client.query(Array.isArray(out) ? "ROLLBACK" : "COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (Array.isArray(out)) return fail(res, ...out);
    return out;
  }
  // Not while the charge is still on its way to Espees (its answer isn't in yet).
  const voteSettled = (r) => r.payment_status !== "PROCESSING" || voteStuck(r);

  // { note? }: counts a vote by hand (paymentStatus MARKED_PAID), once the team has seen its payment
  // in Espees: one without a clear answer, say. The voter hears on KingsChat as for any vote.
  router.post("/expo/admin/votes/:id/paid", requireAdmin, asyncHandler(async (req, res) => {
    const row = await voteStep(req, res, voteSettled,
      `UPDATE team_votes SET status = 'counted', paid_at = now(), payment_status = 'MARKED_PAID', payment_error = COALESCE($2, payment_error), updated_at = now() WHERE id = $1 RETURNING *`);
    if (!row || res.headersSent) return;
    voteMessageLater(row.id);
    ok(res, { vote: await adminVote(row.id) });
  }));

  // { note? }: lets the person vote again, once the team has seen in Espees that a payment without a
  // clear answer was never taken: the attempt is kept, cancelled (paymentStatus REOPENED).
  router.post("/expo/admin/votes/:id/reopen", requireAdmin, asyncHandler(async (req, res) => {
    const row = await voteStep(req, res, voteSettled,
      `UPDATE team_votes SET status = 'cancelled', cancelled_at = now(), payment_status = 'REOPENED', payment_error = COALESCE($2, payment_error), updated_at = now() WHERE id = $1 RETURNING *`);
    if (!row || res.headersSent) return;
    ok(res, { vote: await adminVote(row.id) });
  }));

  const STATUSES = { enquiries:["new", "contacted", "closed"], applications: ["submitted", "shortlisted", "accepted", "declined"], registrations: ["pending", "confirmed", "cancelled"] };
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
/** The officials' quiz with its answers, for the tests. */
module.exports.officialsQuiz = OFFICIALS_QUIZ;
/** Which pass settings are there (names only, never values), for the dev server's start-up line. */
module.exports.passesSetup = () => ({ onSale: passesOnSale(), missing: [["EXPO_ESPEES_API_TOKEN", ESPEES_API_TOKEN], ["EXPO_KINGSPASS_URL", KINGSPASS_URL], ["EXPO_KINGSPASS_EVENT_TOKEN", KINGSPASS_EVENT_TOKEN]].filter(([, v]) => !v).map(([k]) => k), kingspass: KINGSPASS_URL, debug: payDebug() });
module.exports.notifyBooking = notifyBooking;
module.exports.pool = pool;
module.exports.upsertExhibitor = upsertExhibitor;
module.exports.exhibitorFields = exhibitorFields;
module.exports.eventDays = eventDays;
