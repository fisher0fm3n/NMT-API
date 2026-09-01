// routes/pcdl_quizzes.js
// Quizzes: bite-size Bible/PCDL knowledge checks with XP rewards, plus the
// usage-activity feed that powers the app's growth screen.
//
//   GET  /pcdl/quizzes                 [?email&token]  list (+ user's best scores)
//   GET  /pcdl/quizzes/:id                             quiz with questions
//   POST /pcdl/quizzes/:id/submit      {email, token, score, total}
//   GET  /pcdl/gamification/activity   ?email&token[&days=14]

const { Router } = require("express");
const { Client } = require("pg");
const axios = require("axios");

const { applyXp } = require("../lib/gamification");

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
  if (!email || !token) return { ok: false };
  try {
    const resp = await axios.post(
      "https://sjvv8a3ys1.execute-api.us-east-1.amazonaws.com/Dev/fetchUserToken",
      { email, token: "SFG89VKUG98DPGWJRW4" },
      { timeout: 8000, headers: { "Content-Type": "application/json" } },
    );
    const apiToken = resp?.data?.token;
    return { ok: Boolean(apiToken) && apiToken === token };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------
// Schema + seed (lazy, idempotent)
// ---------------------------------------------------------------------
const SEED = [
  {
    slug: "foundations-of-faith",
    title: "Foundations of Faith",
    description: "How well do you know the bedrock truths of the Christian life?",
    audience: "adults",
    color: "#E71D72",
    icon: "flame",
    reward_xp: 30,
    questions: [
      ["What does Romans 10:17 say faith comes by?", ["Prayer and fasting", "Hearing the Word of God", "Going to church", "Good works"], 1, "Faith comes by hearing, and hearing by the Word of God."],
      ["According to Hebrews 11:1, faith is the substance of…", ["Things seen", "Things hoped for", "Miracles", "Feelings"], 1, "Faith is the substance of things hoped for, the evidence of things not seen."],
      ["Without faith it is impossible to…", ["Prosper", "Sing", "Please God", "Preach"], 2, "Hebrews 11:6 — without faith it is impossible to please Him."],
      ["The just shall live by…", ["Sight", "Faith", "Hope", "Law"], 1, "Romans 1:17 — the just shall live by faith."],
      ["Faith without works is…", ["Growing", "Perfect", "Dead", "Hidden"], 2, "James 2:26 — faith without works is dead."],
    ],
  },
  {
    slug: "know-your-bible",
    title: "Know Your Bible",
    description: "Quick-fire questions every young believer should ace.",
    audience: "teens",
    color: "#1CB0F6",
    icon: "book",
    reward_xp: 25,
    questions: [
      ["How many books are in the New Testament?", ["27", "39", "66", "12"], 0, "The New Testament has 27 books."],
      ["Who was thrown into the lions' den?", ["David", "Daniel", "Joseph", "Elijah"], 1, "Daniel was thrown into the lions' den and God shut the lions' mouths."],
      ["What is the shortest verse in the Bible?", ["God is love", "Jesus wept", "Pray always", "Rejoice evermore"], 1, "\"Jesus wept\" — John 11:35."],
      ["Who built the ark?", ["Moses", "Abraham", "Noah", "Jacob"], 2, "Noah built the ark by God's instruction."],
      ["On which day did God create man?", ["Third", "Fifth", "Sixth", "Seventh"], 2, "Genesis 1 — man was created on the sixth day."],
    ],
  },
  {
    slug: "the-holy-spirit",
    title: "The Holy Spirit",
    description: "Test your understanding of the Person and ministry of the Holy Spirit.",
    audience: "adults",
    color: "#58CC02",
    icon: "flash",
    reward_xp: 30,
    questions: [
      ["Jesus called the Holy Spirit the…", ["Messenger", "Comforter", "Servant", "Judge"], 1, "John 14:26 — the Comforter, who teaches us all things."],
      ["On which day was the Holy Spirit poured out on the Church?", ["Passover", "Pentecost", "Sabbath", "Jubilee"], 1, "Acts 2 — the day of Pentecost."],
      ["The fruit of the Spirit begins with…", ["Faith", "Joy", "Love", "Peace"], 2, "Galatians 5:22 — love, joy, peace…"],
      ["Speaking in tongues is described as speaking to…", ["Men", "Angels", "God", "Yourself"], 2, "1 Corinthians 14:2 — he that speaks in a tongue speaks to God."],
      ["Who did the Spirit descend on like a dove?", ["John", "Peter", "Jesus", "Paul"], 2, "At Jesus' baptism the Spirit descended on Him like a dove."],
    ],
  },
  {
    slug: "champions-league",
    title: "Champions League",
    description: "Heroes of faith and their mighty exploits — for the bold!",
    audience: "teens",
    color: "#CE82FF",
    icon: "trophy",
    reward_xp: 25,
    questions: [
      ["Who defeated Goliath?", ["Saul", "David", "Samson", "Joshua"], 1, "David defeated Goliath with a sling and a stone."],
      ["Whose strength was in his hair?", ["Gideon", "Samson", "Elisha", "Caleb"], 1, "Samson's Nazarite vow included never cutting his hair."],
      ["Who led Israel across the Red Sea?", ["Joshua", "Aaron", "Moses", "Miriam"], 2, "Moses stretched out his hand and God parted the sea."],
      ["Around which city did Israel march for seven days?", ["Jericho", "Ai", "Bethel", "Nineveh"], 0, "Jericho's walls fell after the seventh-day march."],
      ["Who was taken to heaven in a chariot of fire?", ["Enoch", "Elijah", "Elisha", "Isaiah"], 1, "Elijah went up by a whirlwind with chariots of fire."],
    ],
  },
];

let schemaPromise = null;
function ensureQuizSchema() {
  if (!schemaPromise) {
    schemaPromise = withClient(async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.quizzes (
          id          BIGSERIAL PRIMARY KEY,
          slug        TEXT UNIQUE NOT NULL,
          title       TEXT NOT NULL,
          description TEXT,
          audience    TEXT NOT NULL DEFAULT 'adults',
          color       TEXT,
          icon        TEXT,
          reward_xp   INTEGER NOT NULL DEFAULT 25,
          active      BOOLEAN NOT NULL DEFAULT TRUE,
          sort        INTEGER NOT NULL DEFAULT 0
        )
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.quiz_questions (
          id            BIGSERIAL PRIMARY KEY,
          quiz_id       BIGINT NOT NULL REFERENCES public.quizzes(id) ON DELETE CASCADE,
          question      TEXT NOT NULL,
          options       JSONB NOT NULL,
          correct_index INTEGER NOT NULL,
          explanation   TEXT,
          sort          INTEGER NOT NULL DEFAULT 0
        )
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.quiz_attempts (
          id         BIGSERIAL PRIMARY KEY,
          email      TEXT NOT NULL,
          quiz_id    BIGINT NOT NULL,
          score      INTEGER NOT NULL,
          total      INTEGER NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await db.query(
        `CREATE INDEX IF NOT EXISTS quiz_attempts_email_idx
           ON public.quiz_attempts (email, quiz_id)`,
      );

      for (let qi = 0; qi < SEED.length; qi++) {
        const q = SEED[qi];
        const ins = await db.query(
          `INSERT INTO public.quizzes (slug, title, description, audience, color, icon, reward_xp, sort)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (slug) DO NOTHING
           RETURNING id`,
          [q.slug, q.title, q.description, q.audience, q.color, q.icon, q.reward_xp, qi],
        );
        if (ins.rowCount > 0) {
          const quizId = ins.rows[0].id;
          for (let i = 0; i < q.questions.length; i++) {
            const [question, options, correct, explanation] = q.questions[i];
            await db.query(
              `INSERT INTO public.quiz_questions (quiz_id, question, options, correct_index, explanation, sort)
               VALUES ($1,$2,$3,$4,$5,$6)`,
              [quizId, question, JSON.stringify(options), correct, explanation, i],
            );
          }
        }
      }
    }).catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

module.exports = function pcdlQuizRoutes() {
  const router = Router();

  // ---------------- List quizzes ----------------
  router.get(
    "/pcdl/quizzes",
    asyncHandler(async (req, res) => {
      await ensureQuizSchema();
      const email = (req.query.email || "").trim();

      const data = await withClient(async (db) => {
        const { rows } = await db.query(`
          SELECT q.id, q.slug, q.title, q.description, q.audience, q.color,
                 q.icon, q.reward_xp,
                 (SELECT COUNT(*)::int FROM public.quiz_questions x WHERE x.quiz_id = q.id) AS question_count
            FROM public.quizzes q
           WHERE q.active
           ORDER BY q.sort, q.id
        `);
        let best = {};
        if (email) {
          const b = await db.query(
            `SELECT quiz_id, MAX((score::float / NULLIF(total,0)) * 100)::int AS best_pct
               FROM public.quiz_attempts WHERE email = $1 GROUP BY quiz_id`,
            [email],
          );
          for (const r of b.rows) best[r.quiz_id] = Number(r.best_pct);
        }
        return rows.map((r) => ({ ...r, best_pct: best[r.id] ?? null }));
      });
      return res.json({ status: true, data });
    }),
  );

  // ---------------- Quiz detail (questions) ----------------
  router.get(
    "/pcdl/quizzes/:id",
    asyncHandler(async (req, res) => {
      await ensureQuizSchema();
      const id = Number(req.params.id);
      const data = await withClient(async (db) => {
        const q = await db.query(
          `SELECT id, slug, title, description, audience, color, icon, reward_xp
             FROM public.quizzes WHERE id = $1 AND active`,
          [id],
        );
        if (q.rowCount === 0) return null;
        const items = await db.query(
          `SELECT id, question, options, correct_index, explanation
             FROM public.quiz_questions WHERE quiz_id = $1 ORDER BY sort, id`,
          [id],
        );
        return { ...q.rows[0], questions: items.rows };
      });
      if (!data)
        return res
          .status(404)
          .json({ status: false, error: "not_found", message: "quiz not found" });
      return res.json({ status: true, data });
    }),
  );

  // ---------------- Submit an attempt ----------------
  router.post(
    "/pcdl/quizzes/:id/submit",
    asyncHandler(async (req, res) => {
      await ensureQuizSchema();
      const id = Number(req.params.id);
      const b = req.body || {};
      const email = (b.email || "").trim();
      const token = (b.token || "").trim();
      const score = Math.max(0, Number(b.score) || 0);
      const total = Math.max(1, Number(b.total) || 1);
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

      const day = new Date().toISOString().slice(0, 10);
      const result = await withClient(async (db) => {
        const q = await db.query(
          `SELECT id, reward_xp FROM public.quizzes WHERE id = $1 AND active`,
          [id],
        );
        if (q.rowCount === 0) return { error: "not_found" };
        const rewardXp = Number(q.rows[0].reward_xp);

        await db.query(
          `INSERT INTO public.quiz_attempts (email, quiz_id, score, total)
           VALUES ($1,$2,$3,$4)`,
          [email, id, score, total],
        );

        // XP: pass mark is 60%, rewarded once per quiz per day.
        const passed = score / total >= 0.6;
        if (!passed) return { ok: true, passed: false, points_awarded: 0 };

        const idempotencyKey = [email, "quiz_reward", id, day].join("|");
        await db.query("BEGIN");
        try {
          const dup = await db.query(
            `SELECT 1 FROM public.xp_events WHERE idempotency_key = $1`,
            [idempotencyKey],
          );
          if (dup.rowCount > 0) {
            await db.query("ROLLBACK");
            return { ok: true, passed: true, duplicate: true, points_awarded: 0 };
          }
          await db.query(
            `INSERT INTO public.xp_events (email, action, points, meta, idempotency_key)
             VALUES ($1,'quiz_reward',$2,$3,$4)`,
            [email, rewardXp, { quiz_id: id, score, total }, idempotencyKey],
          );
          const xp = await applyXp(db, email, rewardXp);
          if (!xp) {
            await db.query("ROLLBACK");
            return { error: "not_found" };
          }
          await db.query("COMMIT");
          return { ok: true, passed: true, duplicate: false, ...xp };
        } finally {
          await db.query("ROLLBACK").catch(() => {});
        }
      });

      if (result.error === "not_found") {
        return res
          .status(404)
          .json({ status: false, error: "not_found", message: "quiz not found" });
      }
      const { ok, error, ...rest } = result;
      return res.json({ status: true, ...rest });
    }),
  );

  // ---------------- Usage activity (growth tracking) ----------------
  router.get(
    "/pcdl/gamification/activity",
    asyncHandler(async (req, res) => {
      const email = (req.query.email || "").trim();
      const token = (req.query.token || "").trim();
      const days = Math.max(7, Math.min(90, Number(req.query.days) || 14));
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

      const data = await withClient(async (db) => {
        const { rows } = await db.query(
          `
            SELECT to_char(date_trunc('day', e.created_at AT TIME ZONE 'utc'), 'YYYY-MM-DD') AS day,
                   SUM(e.points)::int AS xp,
                   COUNT(*) FILTER (WHERE e.action = 'watch_completed')::int  AS watch,
                   COUNT(*) FILTER (WHERE e.action = 'listen_completed')::int AS listen,
                   COUNT(*) FILTER (WHERE e.action = 'quest_reward')::int     AS quests,
                   COUNT(*) FILTER (WHERE e.action = 'quiz_reward')::int      AS quizzes,
                   COUNT(*) FILTER (WHERE e.action = 'daily_checkin')::int    AS checkins,
                   COALESCE(SUM((e.meta->>'duration_seconds')::float) FILTER (
                     WHERE e.action IN ('watch_completed','listen_completed')
                   ), 0)::int AS seconds
              FROM public.xp_events e
             WHERE e.email = $1
               AND e.created_at >= (now() AT TIME ZONE 'utc') - ($2 || ' days')::interval
             GROUP BY 1
             ORDER BY 1
          `,
          [email, String(days)],
        );

        const totals = rows.reduce(
          (acc, r) => ({
            xp: acc.xp + r.xp,
            watch: acc.watch + r.watch,
            listen: acc.listen + r.listen,
            quests: acc.quests + r.quests,
            quizzes: acc.quizzes + r.quizzes,
            checkins: acc.checkins + r.checkins,
            seconds: acc.seconds + r.seconds,
          }),
          { xp: 0, watch: 0, listen: 0, quests: 0, quizzes: 0, checkins: 0, seconds: 0 },
        );
        return { days: rows, totals, window_days: days };
      });

      return res.json({ status: true, data });
    }),
  );

  return router;
};
