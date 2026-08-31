// routes/pcdl_gamification.js
// Quests (Duolingo-style daily/weekly goals with claimable XP rewards) and a
// public leaderboard. Complements the profile/levels/award endpoints that
// live in routes/pcdl.js.
//
// Endpoints:
//   GET  /pcdl/gamification/quests       ?email&token          (auth)
//   POST /pcdl/gamification/quests/claim {email, token, quest_code} (auth)
//   GET  /pcdl/gamification/leaderboard  ?period&limit[&email&token] (public)
//
// Privacy: the leaderboard never returns raw emails. Users with
// is_profile_public = false are excluded from the public list, but can still
// see their own rank by authenticating.

const { Router } = require("express");
const { Client } = require("pg");
const axios = require("axios");

const {
  ensureGamificationSchema,
  periodKeyFor,
  applyXp,
  displayNameFor,
} = require("../lib/gamification");

// Same fixed credentials pattern as the other pcdl route files.
function newClient() {
  return new Client({
    user: "postgres",
    host: "102.219.189.166",
    database: "pcdl",
    password: "B8Mgs81D58eTub9GhnO2FOp2",
    port: 5432,
  });
}

async function withClient(fn) {
  const client = newClient();
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

async function verifyUserToken(email, token) {
  if (!email || !token) return { ok: false, reason: "missing email/token" };
  try {
    const resp = await axios.post(
      "https://sjvv8a3ys1.execute-api.us-east-1.amazonaws.com/Dev/fetchUserToken",
      { email, token: "SFG89VKUG98DPGWJRW4" },
      { timeout: 8000, headers: { "Content-Type": "application/json" } },
    );
    const apiToken = resp?.data?.token;
    if (!apiToken) return { ok: false, reason: "no token from auth api" };
    return { ok: apiToken === token };
  } catch (err) {
    return { ok: false, reason: err?.message || "auth_api_failed" };
  }
}

const LEADERBOARD_PERIODS = new Set(["weekly", "monthly", "alltime"]);

function periodWindowSql(period) {
  // Returns a WHERE fragment over xp_events.created_at (UTC boundaries,
  // matching the daily/weekly keys used by streaks and quests).
  if (period === "weekly") {
    return `e.created_at >= date_trunc('week', now() AT TIME ZONE 'utc')`;
  }
  if (period === "monthly") {
    return `e.created_at >= date_trunc('month', now() AT TIME ZONE 'utc')`;
  }
  return null; // alltime uses users.xp directly
}

module.exports = function pcdlGamificationRoutes() {
  const router = Router();

  // ---------------- Quests: list with progress ----------------
  router.get(
    "/pcdl/gamification/quests",
    asyncHandler(async (req, res) => {
      const email = (req.query.email || "").trim();
      const token = (req.query.token || "").trim();
      if (!email || !token) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "email and token are required",
        });
      }
      const auth = await verifyUserToken(email, token);
      if (!auth.ok)
        return res.status(400).json({ status: false, error: "unauthorized" });

      await ensureGamificationSchema(withClient);

      const now = new Date();
      const keys = {
        daily: periodKeyFor("daily", now),
        weekly: periodKeyFor("weekly", now),
      };

      const rows = await withClient(async (db) => {
        const { rows } = await db.query(
          `
            SELECT d.code, d.title, d.description, d.icon, d.period, d.metric,
                   d.target, d.reward_xp, d.sort,
                   COALESCE(p.progress, 0) AS progress,
                   p.completed_at, p.claimed_at
              FROM public.quest_definitions d
              LEFT JOIN public.quest_progress p
                ON p.quest_code = d.code
               AND p.email = $1
               AND p.period_key = CASE d.period WHEN 'weekly' THEN $3 ELSE $2 END
             WHERE d.active
             ORDER BY d.period, d.sort, d.code
          `,
          [email, keys.daily, keys.weekly],
        );
        return rows;
      });

      const shape = (r) => ({
        code: r.code,
        title: r.title,
        description: r.description,
        icon: r.icon,
        metric: r.metric,
        target: Number(r.target),
        reward_xp: Number(r.reward_xp),
        progress: Math.min(Number(r.progress), Number(r.target)),
        completed: Boolean(r.completed_at),
        claimed: Boolean(r.claimed_at),
      });

      return res.json({
        status: true,
        data: {
          daily: {
            period_key: keys.daily,
            quests: rows.filter((r) => r.period === "daily").map(shape),
          },
          weekly: {
            period_key: keys.weekly,
            quests: rows.filter((r) => r.period === "weekly").map(shape),
          },
        },
      });
    }),
  );

  // ---------------- Quests: claim a completed quest's reward ----------------
  router.post(
    "/pcdl/gamification/quests/claim",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const email = (b.email || "").trim();
      const token = (b.token || "").trim();
      const questCode = (b.quest_code || "").trim();
      if (!email || !token || !questCode) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "email, token, quest_code are required",
        });
      }
      const auth = await verifyUserToken(email, token);
      if (!auth.ok)
        return res.status(400).json({ status: false, error: "unauthorized" });

      await ensureGamificationSchema(withClient);

      const result = await withClient(async (db) => {
        // The finally-ROLLBACK cleans up early returns and errors; after a
        // successful COMMIT it is a harmless no-op.
        await db.query("BEGIN");
        try {
          const q = await db.query(
            `SELECT code, title, period, reward_xp
               FROM public.quest_definitions
              WHERE code = $1 AND active`,
            [questCode],
          );
          if (q.rowCount === 0) return { error: "unknown_quest" };
          const quest = q.rows[0];
          const periodKey = periodKeyFor(quest.period);

          const p = await db.query(
            `SELECT id, completed_at, claimed_at
               FROM public.quest_progress
              WHERE email=$1 AND quest_code=$2 AND period_key=$3
              FOR UPDATE`,
            [email, questCode, periodKey],
          );
          if (p.rowCount === 0 || !p.rows[0].completed_at) {
            return { error: "not_completed" };
          }
          if (p.rows[0].claimed_at) return { error: "already_claimed" };

          await db.query(
            `UPDATE public.quest_progress SET claimed_at = now(), updated_at = now()
              WHERE id = $1`,
            [p.rows[0].id],
          );

          const idempotencyKey = [email, "quest_reward", questCode, periodKey].join("|");
          const points = Number(quest.reward_xp);
          await db.query(
            `INSERT INTO public.xp_events (email, action, points, meta, idempotency_key)
             VALUES ($1,'quest_reward',$2,$3,$4)`,
            [
              email,
              points,
              { quest_code: questCode, period_key: periodKey },
              idempotencyKey,
            ],
          );

          const xp = await applyXp(db, email, points);
          if (!xp) return { error: "not_found" };

          await db.query("COMMIT");
          return { ok: true, quest, ...xp };
        } finally {
          await db.query("ROLLBACK").catch(() => {});
        }
      });

      if (result.error === "unknown_quest") {
        return res
          .status(400)
          .json({ status: false, error: "unknown_quest", message: "Unknown quest" });
      }
      if (result.error === "not_completed") {
        return res.status(400).json({
          status: false,
          error: "not_completed",
          message: "Quest is not completed yet",
        });
      }
      if (result.error === "already_claimed") {
        return res.status(400).json({
          status: false,
          error: "already_claimed",
          message: "Reward already claimed",
        });
      }
      if (result.error === "not_found") {
        return res
          .status(400)
          .json({ status: false, error: "not_found", message: "user not found" });
      }

      const { quest, ok, error, ...xp } = result;
      return res.json({
        status: true,
        quest_code: quest.code,
        quest_title: quest.title,
        ...xp,
      });
    }),
  );

  // ---------------- Leaderboard (public) ----------------
  router.get(
    "/pcdl/gamification/leaderboard",
    asyncHandler(async (req, res) => {
      const period = LEADERBOARD_PERIODS.has(String(req.query.period))
        ? String(req.query.period)
        : "weekly";
      const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
      const email = (req.query.email || "").trim();
      const token = (req.query.token || "").trim();

      await ensureGamificationSchema(withClient);

      const windowSql = periodWindowSql(period);

      const data = await withClient(async (db) => {
        let rows;
        if (windowSql) {
          ({ rows } = await db.query(
            `
              SELECT u.email, u.username, u.first_name, u.last_name,
                     u.avatar_url, u.country, u.level,
                     SUM(e.points)::bigint AS points,
                     RANK() OVER (ORDER BY SUM(e.points) DESC) AS rank
                FROM public.xp_events e
                JOIN public.users u ON u.email = e.email
               WHERE ${windowSql}
                 AND COALESCE(u.is_profile_public, TRUE)
               GROUP BY u.email, u.username, u.first_name, u.last_name,
                        u.avatar_url, u.country, u.level
               ORDER BY points DESC, u.email ASC
               LIMIT $1
            `,
            [limit],
          ));
        } else {
          ({ rows } = await db.query(
            `
              SELECT u.email, u.username, u.first_name, u.last_name,
                     u.avatar_url, u.country, u.level,
                     u.xp::bigint AS points,
                     RANK() OVER (ORDER BY u.xp DESC) AS rank
                FROM public.users u
               WHERE COALESCE(u.is_profile_public, TRUE) AND u.xp > 0
               ORDER BY u.xp DESC, u.email ASC
               LIMIT $1
            `,
            [limit],
          ));
        }

        const entries = rows.map((r) => ({
          rank: Number(r.rank),
          display_name: displayNameFor(r),
          avatar_url: r.avatar_url || null,
          country: r.country || null,
          level: Number(r.level) || 1,
          points: Number(r.points) || 0,
          // Lets an authenticated client highlight its own row.
          is_me: Boolean(email && r.email === email),
        }));

        // Authenticated caller also gets their own rank, even when their
        // profile is private or outside the top N.
        let me = null;
        if (email && token) {
          const auth = await verifyUserToken(email, token);
          if (auth.ok) {
            let meRow;
            if (windowSql) {
              const r = await db.query(
                `
                  WITH scores AS (
                    SELECT e.email, SUM(e.points)::bigint AS points
                      FROM public.xp_events e
                     WHERE ${windowSql}
                     GROUP BY e.email
                  ),
                  ranked AS (
                    SELECT email, points, RANK() OVER (ORDER BY points DESC) AS rank
                      FROM scores
                  )
                  SELECT r.rank, r.points, u.username, u.first_name, u.last_name,
                         u.email, u.avatar_url, u.country, u.level
                    FROM ranked r
                    JOIN public.users u ON u.email = r.email
                   WHERE r.email = $1
                `,
                [email],
              );
              meRow = r.rows[0];
            } else {
              const r = await db.query(
                `
                  SELECT u.username, u.first_name, u.last_name, u.email,
                         u.avatar_url, u.country, u.level, u.xp::bigint AS points,
                         (SELECT COUNT(*) + 1 FROM public.users u2 WHERE u2.xp > u.xp) AS rank
                    FROM public.users u
                   WHERE u.email = $1
                `,
                [email],
              );
              meRow = r.rows[0];
            }
            if (meRow) {
              me = {
                rank: Number(meRow.rank),
                display_name: displayNameFor(meRow),
                avatar_url: meRow.avatar_url || null,
                country: meRow.country || null,
                level: Number(meRow.level) || 1,
                points: Number(meRow.points) || 0,
              };
            }
          }
        }

        return { entries, me };
      });

      return res.json({
        status: true,
        period,
        data: data.entries,
        me: data.me,
      });
    }),
  );

  return router;
};
