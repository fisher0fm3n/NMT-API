// lib/gamification.js
// Shared gamification engine: quest schema/seeds, period keys, quest-progress
// updates, and XP application. Used by the award endpoint in routes/pcdl.js
// and by routes/pcdl_gamification.js (quests + leaderboard).

// ---------------------------------------------------------------------
// Quest definitions (seeded idempotently; edit rows in DB to tune live)
// ---------------------------------------------------------------------
// metric values:
//   checkin_count  — daily check-ins
//   watch_count    — watch_completed events
//   listen_count   — listen_completed events
//   complete_count — watch_completed + listen_completed events
//   minutes        — minutes of playback (from duration_seconds)
//   xp_earned      — XP from any non-quest action
const QUEST_SEED = [
  // Daily
  ["daily_checkin", "Check in", "Open PCDL and check in today", "calendar", "daily", "checkin_count", 1, 5, 1],
  ["daily_watch_1", "Watch a message", "Finish watching any message today", "play-circle", "daily", "watch_count", 1, 15, 2],
  ["daily_listen_1", "Listen to a message", "Finish listening to any message today", "headset", "daily", "listen_count", 1, 10, 3],
  ["daily_minutes_20", "20 minutes in the Word", "Watch or listen for 20 minutes today", "time", "daily", "minutes", 20, 20, 4],
  // Weekly
  ["weekly_complete_5", "Complete 5 messages", "Finish 5 messages this week", "trophy", "weekly", "complete_count", 5, 75, 1],
  ["weekly_checkin_5", "Show up 5 days", "Check in on 5 different days this week", "flame", "weekly", "checkin_count", 5, 50, 2],
  ["weekly_minutes_120", "2 hours in the Word", "Watch or listen for 120 minutes this week", "hourglass", "weekly", "minutes", 120, 100, 3],
];

// ---------------------------------------------------------------------
// Period keys (UTC, matching the streak logic in the award endpoint)
// ---------------------------------------------------------------------
function dailyKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function weeklyKey(d = new Date()) {
  // ISO-8601 week number, UTC.
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function periodKeyFor(period, d = new Date()) {
  return period === "weekly" ? weeklyKey(d) : dailyKey(d);
}

// ---------------------------------------------------------------------
// Schema bootstrap (lazy + idempotent)
// ---------------------------------------------------------------------
let schemaPromise = null;

function ensureGamificationSchema(withClient) {
  if (!schemaPromise) {
    schemaPromise = withClient(async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.quest_definitions (
          code        TEXT PRIMARY KEY,
          title       TEXT NOT NULL,
          description TEXT,
          icon        TEXT,
          period      TEXT NOT NULL CHECK (period IN ('daily','weekly')),
          metric      TEXT NOT NULL,
          target      NUMERIC NOT NULL CHECK (target > 0),
          reward_xp   INTEGER NOT NULL CHECK (reward_xp >= 0),
          active      BOOLEAN NOT NULL DEFAULT TRUE,
          sort        INTEGER NOT NULL DEFAULT 0
        )
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.quest_progress (
          id           BIGSERIAL PRIMARY KEY,
          email        TEXT NOT NULL,
          quest_code   TEXT NOT NULL REFERENCES public.quest_definitions(code) ON DELETE CASCADE,
          period_key   TEXT NOT NULL,
          progress     NUMERIC NOT NULL DEFAULT 0,
          completed_at TIMESTAMPTZ,
          claimed_at   TIMESTAMPTZ,
          updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (email, quest_code, period_key)
        )
      `);
      await db.query(
        `CREATE INDEX IF NOT EXISTS quest_progress_email_period_idx
           ON public.quest_progress (email, period_key)`,
      );
      // Leaderboard scans xp_events by time window.
      await db.query(
        `CREATE INDEX IF NOT EXISTS xp_events_created_at_idx
           ON public.xp_events (created_at)`,
      );
      await db.query(
        `CREATE INDEX IF NOT EXISTS xp_events_email_created_at_idx
           ON public.xp_events (email, created_at)`,
      );

      for (const [code, title, description, icon, period, metric, target, reward, sort] of QUEST_SEED) {
        await db.query(
          `INSERT INTO public.quest_definitions
             (code, title, description, icon, period, metric, target, reward_xp, sort)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (code) DO NOTHING`,
          [code, title, description, icon, period, metric, target, reward, sort],
        );
      }
    }).catch((err) => {
      schemaPromise = null; // retry on next call
      throw err;
    });
  }
  return schemaPromise;
}

// ---------------------------------------------------------------------
// Quest progress
// ---------------------------------------------------------------------
/** Metric deltas produced by one awarded action. */
function metricDeltas(action, { durationSec = 0, points = 0 } = {}) {
  const deltas = { xp_earned: Math.max(0, points) };
  switch (action) {
    case "daily_checkin":
      deltas.checkin_count = 1;
      break;
    case "watch_completed":
      deltas.watch_count = 1;
      deltas.complete_count = 1;
      break;
    case "listen_completed":
      deltas.listen_count = 1;
      deltas.complete_count = 1;
      break;
    default:
      break;
  }
  if (
    (action === "watch_completed" || action === "listen_completed") &&
    durationSec > 0
  ) {
    deltas.minutes = Math.min(durationSec / 60, 240); // cap one event at 4h
  }
  return deltas;
}

/**
 * Applies one action's metric deltas to the caller's active quests inside the
 * caller's transaction. Returns quests newly completed by this action:
 * [{ code, title, reward_xp, period, period_key }].
 */
async function updateQuestProgress(db, email, action, opts = {}) {
  const deltas = metricDeltas(action, opts);
  const metrics = Object.keys(deltas).filter((m) => deltas[m] > 0);
  if (!metrics.length) return [];

  const { rows: quests } = await db.query(
    `SELECT code, title, period, metric, target, reward_xp
       FROM public.quest_definitions
      WHERE active AND metric = ANY($1)`,
    [metrics],
  );
  if (!quests.length) return [];

  const now = new Date();
  const completed = [];
  for (const q of quests) {
    const periodKey = periodKeyFor(q.period, now);
    const { rows } = await db.query(
      `INSERT INTO public.quest_progress (email, quest_code, period_key, progress, updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (email, quest_code, period_key)
       DO UPDATE SET progress = public.quest_progress.progress + EXCLUDED.progress,
                     updated_at = now()
       RETURNING progress, completed_at`,
      [email, q.code, periodKey, deltas[q.metric]],
    );
    const row = rows[0];
    if (!row.completed_at && Number(row.progress) >= Number(q.target)) {
      await db.query(
        `UPDATE public.quest_progress
            SET completed_at = now()
          WHERE email=$1 AND quest_code=$2 AND period_key=$3 AND completed_at IS NULL`,
        [email, q.code, periodKey],
      );
      completed.push({
        code: q.code,
        title: q.title,
        reward_xp: q.reward_xp,
        period: q.period,
        period_key: periodKey,
      });
    }
  }
  return completed;
}

// ---------------------------------------------------------------------
// XP application (used by the quest claim endpoint)
// ---------------------------------------------------------------------
/**
 * Adds XP to a user inside the caller's transaction and returns the same
 * level/progress payload the award endpoint responds with. Does not touch
 * streaks.
 */
async function applyXp(db, email, points) {
  const ures = await db.query(
    `SELECT xp, level FROM public.users WHERE email=$1 FOR UPDATE`,
    [email],
  );
  if (ures.rowCount === 0) return null;
  const user = ures.rows[0];

  const newXp = Number(user.xp) + points;
  await db.query(
    `UPDATE public.users SET xp = $1, last_activity_at = now() WHERE email = $2`,
    [newXp, email],
  );

  const lvl = await db.query(`SELECT public.level_for_xp($1) AS level`, [newXp]);
  const newLevel = Number(lvl.rows[0].level);
  const leveledUp = newLevel !== Number(user.level);
  if (leveledUp) {
    await db.query(`UPDATE public.users SET level = $1 WHERE email = $2`, [
      newLevel,
      email,
    ]);
  }

  const next = await db.query(
    `SELECT level, xp_required FROM public.gamification_levels WHERE level = $1 + 1`,
    [newLevel],
  );
  const thisReq = await db.query(
    `SELECT xp_required FROM public.gamification_levels WHERE level = $1`,
    [newLevel],
  );
  const thisLevelXp = Number(thisReq.rows[0]?.xp_required ?? 0);
  const nextLevelXp = Number(next.rows[0]?.xp_required ?? thisLevelXp);

  return {
    points_awarded: points,
    level: newLevel,
    leveled_up: leveledUp,
    xp_total: newXp,
    xp_this_level: Math.max(0, newXp - thisLevelXp),
    xp_to_next: Math.max(0, nextLevelXp - newXp),
    next_level: next.rows.length ? Number(next.rows[0].level) : newLevel,
  };
}

/** Public-safe display name: never expose raw emails on the leaderboard. */
function displayNameFor(row) {
  if (row.username && String(row.username).trim()) return String(row.username);
  if (row.first_name && String(row.first_name).trim()) {
    return [row.first_name, row.last_name ? `${String(row.last_name)[0]}.` : ""]
      .filter(Boolean)
      .join(" ");
  }
  const email = String(row.email || "");
  const at = email.indexOf("@");
  if (at > 1) return `${email[0]}***${email.slice(at)}`;
  return "PCDL Member";
}

module.exports = {
  QUEST_SEED,
  dailyKey,
  weeklyKey,
  periodKeyFor,
  ensureGamificationSchema,
  metricDeltas,
  updateQuestProgress,
  applyXp,
  displayNameFor,
};
