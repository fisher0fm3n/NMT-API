// routes/pcdl_daily.js
// The "Today" experience (Gospel-Partner-style daily journey) and personal
// notes/journal.
//
//   GET    /pcdl/daily          ?date=YYYY-MM-DD&period=morning|evening[&email&token]
//   GET    /pcdl/notes          ?email&token[&notebook=journal|message|general]
//   POST   /pcdl/notes          {email, token, title, body, notebook, message_id?, scripture_ref?}
//   PATCH  /pcdl/notes/:id      {email, token, ...fields}
//   DELETE /pcdl/notes/:id      {email, token}
//
// Curated copy (headline, scripture, selah prompt, hero image) is seeded per
// day-of-week × period. The messages themselves are picked deterministically
// from the live catalogue for the requested date, so the journey is always
// real content and never goes stale.

const { Router } = require("express");
const { Client } = require("pg");
const axios = require("axios");

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
// Seed: curated copy per day-of-week (0 = Sunday) × period
// ---------------------------------------------------------------------
const hero = (key) => `https://picsum.photos/seed/pcdl-${key}/1080/1350`;

const SEED = [
  // Sunday
  [0, "morning", "The Lord is your Shepherd; you shall not lack.", "Psalm 23:1-3",
    "Sit quietly with the Shepherd. What has He provided this week that you haven't yet thanked Him for?", hero("sun-am")],
  [0, "evening", "Be still, and know that He is God.", "Psalm 46:10-11",
    "Before you sleep, hand tomorrow to Him. Write out one worry and beside it, one promise.", hero("sun-pm")],
  // Monday
  [1, "morning", "True prosperity comes from the Lord, the Source of all your supply!", "Genesis 26:2-3",
    "Where have you been tempted to 'go down to Egypt' for provision? Bring it to the Lord in writing.", hero("mon-am")],
  [1, "evening", "His mercies are new every morning; great is His faithfulness.", "Lamentations 3:22-23",
    "Recall one mercy from today, however small. Thank Him for it by name.", hero("mon-pm")],
  // Tuesday
  [2, "morning", "You are the righteousness of God in Christ Jesus.", "2 Corinthians 5:21",
    "Speak this over yourself: 'I am the righteousness of God in Christ.' Journal how it changes your posture today.", hero("tue-am")],
  [2, "evening", "Cast all your cares on Him, for He cares for you.", "1 Peter 5:6-7",
    "List what you carried today. One by one, release each to Him.", hero("tue-pm")],
  // Wednesday
  [3, "morning", "The Word of God is living and active — let it work in you today.", "Hebrews 4:12",
    "Which word from Scripture has been 'alive' to you lately? Write it out and what it is doing in you.", hero("wed-am")],
  [3, "evening", "He gives His beloved sleep.", "Psalm 127:1-2",
    "Rest is worship. Note one thing you will stop striving over tonight.", hero("wed-pm")],
  // Thursday
  [4, "morning", "Greater is He that is in you than he that is in the world.", "1 John 4:4",
    "What feels bigger than you right now? Write it down, then write who is in you.", hero("thu-am")],
  [4, "evening", "Give thanks in everything; this is the will of God for you.", "1 Thessalonians 5:16-18",
    "Three thanksgivings from today, and one for tomorrow before it arrives.", hero("thu-pm")],
  // Friday
  [5, "morning", "Faith comes by hearing, and hearing by the Word of God.", "Romans 10:17",
    "What have you been listening to this week? Journal what it has built in you.", hero("fri-am")],
  [5, "evening", "The joy of the Lord is your strength.", "Nehemiah 8:10",
    "Where did joy show up today? Where will you carry it tomorrow?", hero("fri-pm")],
  // Saturday
  [6, "morning", "Delight yourself in the Lord and He will give you the desires of your heart.", "Psalm 37:3-5",
    "Write the desires of your heart honestly. Then commit each one to Him.", hero("sat-am")],
  [6, "evening", "In His presence is fullness of joy.", "Psalm 16:8-11",
    "Draw near. Sit for two minutes in silence, then write what you sensed.", hero("sat-pm")],
];

async function ensureSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.daily_experiences (
      dow            SMALLINT NOT NULL,
      period         TEXT NOT NULL CHECK (period IN ('morning','evening')),
      headline       TEXT NOT NULL,
      scripture_ref  TEXT NOT NULL,
      scripture_text TEXT,
      selah_prompt   TEXT NOT NULL,
      hero_image_url TEXT,
      PRIMARY KEY (dow, period)
    );
    CREATE TABLE IF NOT EXISTS public.user_notes (
      id            BIGSERIAL PRIMARY KEY,
      email         TEXT NOT NULL,
      notebook      TEXT NOT NULL DEFAULT 'general'
                    CHECK (notebook IN ('journal','message','general')),
      title         TEXT NOT NULL DEFAULT '',
      body          TEXT NOT NULL DEFAULT '',
      message_id    TEXT,
      scripture_ref TEXT,
      pinned        BOOLEAN NOT NULL DEFAULT FALSE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS user_notes_email_idx
      ON public.user_notes (email, updated_at DESC);
  `);
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM public.daily_experiences`,
  );
  if (rows[0].n < SEED.length) {
    for (const [dow, period, headline, ref, prompt, img] of SEED) {
      await db.query(
        `INSERT INTO public.daily_experiences
           (dow, period, headline, scripture_ref, selah_prompt, hero_image_url)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (dow, period) DO NOTHING`,
        [dow, period, headline, ref, prompt, img],
      );
    }
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
const MESSAGE_SELECT = `
  SELECT m.id, m.title, m.description, m.thumbnail_url, m.series_id,
         s.title AS series_title,
         m.video_duration_seconds::float AS duration_seconds,
         (m.video_id IS NOT NULL) AS has_video,
         (m.audio_id IS NOT NULL) AS has_audio
    FROM public.messages m
    LEFT JOIN public.series s ON s.id = m.series_id
   WHERE m.status = 'Published'
     AND m.thumbnail_url IS NOT NULL
     AND m.video_duration_seconds IS NOT NULL`;

/** Deterministic pick: same date+slot always yields the same message. */
async function pickMessages(db, salt, { media, limit = 1, exclude = [] }) {
  const cond =
    media === "audio"
      ? "AND m.audio_id IS NOT NULL"
      : media === "video"
        ? "AND m.video_id IS NOT NULL"
        : "";
  const { rows } = await db.query(
    `${MESSAGE_SELECT} ${cond}
       AND NOT (m.id = ANY($3::text[]))
     ORDER BY md5($1 || m.id)
     LIMIT $2`,
    [salt, limit, exclude],
  );
  return rows.map(shapeMessage);
}

function shapeMessage(r) {
  if (!r) return null;
  const secs = Number(r.duration_seconds) || 0;
  return {
    id: r.id,
    title: r.title,
    description: r.description || undefined,
    thumbnail_url: r.thumbnail_url,
    series_id: r.series_id || undefined,
    series_title: r.series_title || undefined,
    duration_seconds: secs,
    minutes: secs ? Math.max(1, Math.round(secs / 60)) : undefined,
    has_video: Boolean(r.has_video),
    has_audio: Boolean(r.has_audio),
  };
}

/** A series with a week's worth of messages, fixed for the ISO week. */
async function pickPlan(db, weekSalt) {
  const { rows } = await db.query(
    `SELECT s.id, s.title, to_jsonb(s) AS raw, COUNT(m.id)::int AS count
       FROM public.series s
       JOIN public.messages m ON m.series_id = s.id AND m.status = 'Published'
      GROUP BY s.id
     HAVING COUNT(m.id) >= 7
      ORDER BY md5($1 || s.id)
      LIMIT 1`,
    [weekSalt],
  );
  const r = rows[0];
  if (!r) return null;
  const raw = r.raw || {};
  return {
    series_id: r.id,
    title: r.title,
    count: r.count,
    thumbnail_url:
      raw.thumbnail_url || raw.cover_url || raw.image_url || raw.image || null,
  };
}

async function scriptureText(db, row) {
  if (row.scripture_text) return row.scripture_text;
  try {
    const resp = await axios.get(
      `https://bible-api.com/${encodeURIComponent(row.scripture_ref)}?translation=web`,
      { timeout: 8000 },
    );
    const text = String(resp?.data?.text || "").replace(/\s+/g, " ").trim();
    if (text) {
      await db.query(
        `UPDATE public.daily_experiences SET scripture_text = $1
          WHERE dow = $2 AND period = $3`,
        [text, row.dow, row.period],
      );
      return text;
    }
  } catch {}
  return null;
}

function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------
module.exports = function pcdlDailyRoutes() {
  const router = Router();

  router.get(
    "/pcdl/daily",
    asyncHandler(async (req, res) => {
      const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ""))
        ? String(req.query.date)
        : new Date().toISOString().slice(0, 10);
      const period = req.query.period === "evening" ? "evening" : "morning";
      const d = new Date(`${dateStr}T00:00:00Z`);
      const dow = d.getUTCDay();

      const data = await withClient(async (db) => {
        await ensureSchema(db);
        const { rows } = await db.query(
          `SELECT * FROM public.daily_experiences WHERE dow = $1 AND period = $2`,
          [dow, period],
        );
        const row = rows[0];
        if (!row) return null;

        const salt = `${dateStr}:${period}:`;
        const [talk] = await pickMessages(db, salt + "talk", { media: "audio" });
        const [watch] = await pickMessages(db, salt + "watch", {
          media: "video",
          exclude: [talk?.id].filter(Boolean),
        });
        const [sermon] = await pickMessages(db, salt + "sermon", {
          media: "video",
          exclude: [talk?.id, watch?.id].filter(Boolean),
        });
        const [dailyPlay] = await pickMessages(db, `${dateStr}:play`, {
          media: "audio",
          exclude: [talk?.id].filter(Boolean),
        });
        const more = await pickMessages(db, salt + "more", {
          limit: 8,
          exclude: [talk?.id, watch?.id, sermon?.id, dailyPlay?.id].filter(Boolean),
        });
        const plan = await pickPlan(db, isoWeekKey(d));
        const text = await scriptureText(db, row);

        return {
          date: dateStr,
          period,
          headline: row.headline,
          hero_image_url: row.hero_image_url,
          scripture: { ref: row.scripture_ref, text },
          items: [
            talk && {
              kind: "talk",
              label: "Let's talk",
              title: talk.title,
              minutes: talk.minutes,
              message: talk,
            },
            {
              kind: "selah",
              label: "Selah and Journal",
              title: "Take time to draw near to the Lord",
              minutes: 3,
              prompt: row.selah_prompt,
            },
            watch && {
              kind: "watch",
              label: "Watch this",
              title: watch.title,
              minutes: watch.minutes,
              message: watch,
            },
          ].filter(Boolean),
          sermon: sermon || null,
          daily_play: dailyPlay || null,
          plan,
          more,
        };
      });

      if (!data) {
        return res
          .status(404)
          .json({ status: false, error: "not_found", message: "no experience" });
      }
      res.json({ status: true, data });
    }),
  );

  // ---- Notes ---------------------------------------------------------
  const NOTEBOOKS = new Set(["journal", "message", "general"]);

  async function authed(req, res) {
    const b = req.method === "GET" ? req.query : req.body || {};
    const email = String(b.email || "").trim();
    const token = String(b.token || "").trim();
    if (!email || !token) {
      res.status(400).json({
        status: false,
        error: "bad_request",
        message: "email and token are required",
      });
      return null;
    }
    const auth = await verifyUserToken(email, token);
    if (!auth.ok) {
      res.status(401).json({ status: false, error: "unauthorized" });
      return null;
    }
    return email;
  }

  router.get(
    "/pcdl/notes",
    asyncHandler(async (req, res) => {
      const email = await authed(req, res);
      if (!email) return;
      const notebook = NOTEBOOKS.has(req.query.notebook) ? req.query.notebook : null;
      const data = await withClient(async (db) => {
        await ensureSchema(db);
        const { rows } = await db.query(
          `SELECT n.*, m.title AS message_title, m.thumbnail_url AS message_thumbnail
             FROM public.user_notes n
             LEFT JOIN public.messages m ON m.id = n.message_id
            WHERE n.email = $1 AND ($2::text IS NULL OR n.notebook = $2)
            ORDER BY n.pinned DESC, n.updated_at DESC`,
          [email, notebook],
        );
        const counts = await db.query(
          `SELECT notebook, COUNT(*)::int AS n FROM public.user_notes
            WHERE email = $1 GROUP BY notebook`,
          [email],
        );
        const c = { journal: 0, message: 0, general: 0 };
        for (const r of counts.rows) c[r.notebook] = r.n;
        return { notes: rows, counts: { ...c, all: c.journal + c.message + c.general } };
      });
      res.json({ status: true, ...data });
    }),
  );

  router.post(
    "/pcdl/notes",
    asyncHandler(async (req, res) => {
      const email = await authed(req, res);
      if (!email) return;
      const b = req.body || {};
      const notebook = NOTEBOOKS.has(b.notebook) ? b.notebook : "general";
      const row = await withClient(async (db) => {
        await ensureSchema(db);
        const { rows } = await db.query(
          `INSERT INTO public.user_notes
             (email, notebook, title, body, message_id, scripture_ref, pinned)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [
            email,
            notebook,
            String(b.title || "").slice(0, 200),
            String(b.body || ""),
            b.message_id ? String(b.message_id) : null,
            b.scripture_ref ? String(b.scripture_ref).slice(0, 80) : null,
            Boolean(b.pinned),
          ],
        );
        return rows[0];
      });
      res.json({ status: true, data: row });
    }),
  );

  router.patch(
    "/pcdl/notes/:id",
    asyncHandler(async (req, res) => {
      const email = await authed(req, res);
      if (!email) return;
      const b = req.body || {};
      const sets = [];
      const params = [];
      const put = (col, val) => {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      };
      if (b.title !== undefined) put("title", String(b.title).slice(0, 200));
      if (b.body !== undefined) put("body", String(b.body));
      if (NOTEBOOKS.has(b.notebook)) put("notebook", b.notebook);
      if (b.message_id !== undefined) put("message_id", b.message_id || null);
      if (b.scripture_ref !== undefined) put("scripture_ref", b.scripture_ref || null);
      if (b.pinned !== undefined) put("pinned", Boolean(b.pinned));
      if (!sets.length) return res.json({ status: true, message: "nothing to update" });
      params.push(req.params.id, email);
      const row = await withClient(async (db) => {
        const { rows } = await db.query(
          `UPDATE public.user_notes SET ${sets.join(", ")}, updated_at = now()
            WHERE id = $${params.length - 1} AND email = $${params.length}
            RETURNING *`,
          params,
        );
        return rows[0] || null;
      });
      if (!row) return res.status(404).json({ status: false, error: "not_found" });
      res.json({ status: true, data: row });
    }),
  );

  router.delete(
    "/pcdl/notes/:id",
    asyncHandler(async (req, res) => {
      const email = await authed(req, res);
      if (!email) return;
      const count = await withClient(async (db) => {
        const r = await db.query(
          `DELETE FROM public.user_notes WHERE id = $1 AND email = $2`,
          [req.params.id, email],
        );
        return r.rowCount;
      });
      res.json({ status: count > 0 });
    }),
  );

  return router;
};
