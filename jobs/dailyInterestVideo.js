// jobs/dailyInterestVideo.js
//
// Once a day, tells each user about one new video from a channel in a
// category they chose as an interest.
//
// Who:   users with a registered Expo push token, notifications enabled,
//        and at least one saved interest.
// What:  the newest video uploaded in the last LOOKBACK_HOURS whose channel's
//        category is one of their interests - and that they have not been
//        sent before. Someone with nothing new in their categories gets no
//        notification rather than a stale one.
// When:  RUN_AT_HOUR local server time. The run is claimed in Mongo per
//        calendar day, so pm2 restarts (this service restarts itself on file
//        changes) cannot send the same day twice.
//
// Test without sending:  node -e 'require("./jobs/dailyInterestVideo").run({ dryRun: true })'
// Send on demand:        POST /ceflix/notifications/daily-interest/run  (see routes/ceflix.js)

const { getImmtvPool } = require("../lib/immtvDb");
const {
  sendExpoPushNotifications,
  isExpoPushToken,
  isDeadTokenTicket,
} = require("../lib/expoPush");

const RUN_AT_HOUR = Number(process.env.DAILY_INTEREST_RUN_HOUR || 9);
const LOOKBACK_HOURS = Number(process.env.DAILY_INTEREST_LOOKBACK_HOURS || 48);
const MAX_CANDIDATES = 500;
const SQL_CHUNK = 500;

const TOKENS = "ceflix_notification_tokens";
const SETTINGS = "ceflix_user_notification_settings";
const SENDS = "ceflix_daily_interest_sends";
const RUNS = "ceflix_daily_interest_runs";

function log(...args) {
  console.log("[daily-interest]", ...args);
}

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function chunk(items, size) {
  const out = [];

  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));

  return out;
}

// ------------------------------------------------------------------ data

/** userID -> Set(category_id) for the given users. */
async function loadInterests(pool, userIDs) {
  const interests = new Map();

  for (const ids of chunk(userIDs, SQL_CHUNK)) {
    const [rows] = await pool.query(
      "SELECT userID, category_id FROM user_interests WHERE userID IN (?)",
      [ids],
    );

    for (const row of rows) {
      const key = String(row.userID);

      if (!interests.has(key)) interests.set(key, new Set());

      interests.get(key).add(Number(row.category_id));
    }
  }

  return interests;
}

/** Recent public videos with their channel's category, newest first. */
async function loadCandidateVideos(pool) {
  const since = Math.floor(Date.now() / 1000) - LOOKBACK_HOURS * 3600;

  const [rows] = await pool.query(
    `SELECT v.id, v.videos_title AS title, v.slug, v.thumbnail, v.channel_id,
            c.cat_id AS category_id, c.channel AS channel_name,
            CAST(v.uploadtime AS UNSIGNED) AS uploaded_at
       FROM video_tbl v
       JOIN channels c ON c.id = v.channel_id
      WHERE v.active = 1
        AND v.isShort <> 'yes'
        AND c.active = 1
        AND CAST(v.uploadtime AS UNSIGNED) >= ?
      ORDER BY CAST(v.uploadtime AS UNSIGNED) DESC
      LIMIT ?`,
    [since, MAX_CANDIDATES],
  );

  return rows.map((row) => ({
    id: Number(row.id),
    title: String(row.title || "").trim() || "New video",
    slug: row.slug ? String(row.slug) : "",
    thumbnail: row.thumbnail ? String(row.thumbnail) : "",
    channelId: Number(row.channel_id),
    categoryId: Number(row.category_id),
    channelName: String(row.channel_name || "").trim(),
    uploadedAt: Number(row.uploaded_at),
  }));
}

// ------------------------------------------------------------- selection

/**
 * Picks one video per user: the newest candidate in one of their interest
 * categories that they have not already been sent.
 *
 * Pure, so it can be tested without a database.
 *
 * @param {Map<string, Set<number>>} interestsByUser
 * @param {object[]} candidates  newest first
 * @param {Map<string, Set<number>>} alreadySent  userID -> video ids
 * @returns {Map<string, object>} userID -> video
 */
function selectVideosForUsers(interestsByUser, candidates, alreadySent) {
  const picks = new Map();

  for (const [userID, categories] of interestsByUser) {
    if (!categories.size) continue;

    const sent = alreadySent.get(userID) || new Set();
    const video = candidates.find(
      (item) => categories.has(item.categoryId) && !sent.has(item.id),
    );

    if (video) picks.set(userID, video);
  }

  return picks;
}

function buildMessage(token, video) {
  const body = video.channelName
    ? `${video.channelName} just posted: ${video.title}`
    : video.title;

  return {
    to: token,
    title: "New in your interests",
    body,
    sound: "default",
    channelId: "default",
    priority: "high",
    data: {
      // The app opens data.url directly; /watch/[id] is its video screen.
      url: `/watch/${video.id}`,
      id: String(video.id),
      videoId: String(video.id),
      type: "video",
      source: "daily-interest",
      ...(video.slug ? { slug: video.slug } : {}),
    },
  };
}

// ------------------------------------------------------------------- run

/**
 * @param {object} options
 * @param {import("mongodb").Db} [options.db]   Mongo handle (defaults to lib/db)
 * @param {boolean} [options.dryRun]            select and report, send nothing
 * @param {boolean} [options.force]             run even if today was already claimed
 */
async function run({ db, dryRun = false, force = false } = {}) {
  const mongo = db || (await require("../lib/db").getDb());
  const today = dayKey();

  if (!dryRun && !force) {
    // Claim the day atomically; a second process gets nothing back.
    const claim = await mongo.collection(RUNS).findOneAndUpdate(
      { day: today },
      { $setOnInsert: { day: today, startedAt: new Date(), status: "running" } },
      { upsert: true, returnDocument: "before" },
    );
    const existing = claim?.value ?? claim;

    if (existing && existing.day) {
      log(`already ran for ${today} (status ${existing.status}); skipping`);
      return { skipped: true, day: today };
    }
  }

  const pool = getImmtvPool();
  const summary = { day: today, dryRun, users: 0, eligible: 0, picked: 0, sent: 0, failed: 0, deadTokens: 0 };

  try {
    // 1. Everyone with a live token, minus anyone who turned notifications off.
    const tokenDocs = await mongo
      .collection(TOKENS)
      .find({ revoked: { $ne: true }, expoPushToken: { $exists: true, $ne: null } })
      .project({ userID: 1, expoPushToken: 1 })
      .toArray();

    const tokensByUser = new Map();

    for (const doc of tokenDocs) {
      if (!doc.userID || !isExpoPushToken(doc.expoPushToken)) continue;

      const key = String(doc.userID);

      if (!tokensByUser.has(key)) tokensByUser.set(key, new Set());

      tokensByUser.get(key).add(String(doc.expoPushToken).trim());
    }

    summary.users = tokensByUser.size;

    if (!tokensByUser.size) return summary;

    const userIDs = [...tokensByUser.keys()];

    const disabled = await mongo
      .collection(SETTINGS)
      .find({ userID: { $in: userIDs }, enabled: false })
      .project({ userID: 1 })
      .toArray();

    for (const doc of disabled) tokensByUser.delete(String(doc.userID));

    // 2. Their interests, and what is new.
    const interestsByUser = await loadInterests(pool, [...tokensByUser.keys()]);

    summary.eligible = interestsByUser.size;

    if (!interestsByUser.size) return summary;

    const candidates = await loadCandidateVideos(pool);

    // 3. Never the same video twice for the same person.
    const candidateIds = candidates.map((item) => item.id);
    const priorSends = candidateIds.length
      ? await mongo
          .collection(SENDS)
          .find({ userID: { $in: [...interestsByUser.keys()] }, videoId: { $in: candidateIds } })
          .project({ userID: 1, videoId: 1 })
          .toArray()
      : [];

    const alreadySent = new Map();

    for (const doc of priorSends) {
      const key = String(doc.userID);

      if (!alreadySent.has(key)) alreadySent.set(key, new Set());

      alreadySent.get(key).add(Number(doc.videoId));
    }

    const picks = selectVideosForUsers(interestsByUser, candidates, alreadySent);

    summary.picked = picks.size;

    if (dryRun) {
      summary.sample = [...picks.entries()].slice(0, 5).map(([userID, video]) => ({
        userID,
        videoId: video.id,
        title: video.title,
        channel: video.channelName,
      }));

      return summary;
    }

    // 4. Send, then record.
    const messages = [];
    const owners = [];

    for (const [userID, video] of picks) {
      for (const token of tokensByUser.get(userID) || []) {
        messages.push(buildMessage(token, video));
        owners.push({ userID, token, video });
      }
    }

    const tickets = messages.length ? await sendExpoPushNotifications(messages) : [];
    const now = new Date();
    const sendRecords = new Map();
    const deadTokens = [];

    tickets.forEach((ticket, index) => {
      const { userID, token, video } = owners[index];

      if (ticket?.status === "ok") {
        summary.sent += 1;

        if (!sendRecords.has(userID)) {
          sendRecords.set(userID, {
            userID,
            videoId: video.id,
            title: video.title,
            channelId: video.channelId,
            categoryId: video.categoryId,
            day: today,
            sentAt: now,
          });
        }
      } else {
        summary.failed += 1;

        if (isDeadTokenTicket(ticket)) deadTokens.push(token);
      }
    });

    if (sendRecords.size) {
      await mongo.collection(SENDS).insertMany([...sendRecords.values()], { ordered: false });
    }

    if (deadTokens.length) {
      summary.deadTokens = deadTokens.length;

      await mongo.collection(TOKENS).updateMany(
        { expoPushToken: { $in: deadTokens } },
        { $set: { revoked: true, revokedAt: now, revokedReason: "DeviceNotRegistered" } },
      );
    }

    return summary;
  } finally {
    if (!dryRun) {
      await mongo
        .collection(RUNS)
        .updateOne({ day: today }, { $set: { finishedAt: new Date(), status: "done", summary } })
        .catch(() => {});
    }

    log(JSON.stringify(summary));
  }
}

// ------------------------------------------------------------- schedule

function msUntilNextRun(now = new Date()) {
  const next = new Date(now);

  next.setHours(RUN_AT_HOUR, 0, 0, 0);

  if (next <= now) next.setDate(next.getDate() + 1);

  return next - now;
}

/** Starts the daily timer. Safe to call once at boot. */
function start({ getDb } = {}) {
  if (String(process.env.DAILY_INTEREST_DISABLED || "").toLowerCase() === "true") {
    log("disabled by DAILY_INTEREST_DISABLED");
    return;
  }

  const tick = async () => {
    try {
      await run({ db: getDb ? await getDb() : undefined });
    } catch (error) {
      log("run failed:", error?.message || error);
    } finally {
      setTimeout(tick, msUntilNextRun()).unref();
    }
  };

  const delay = msUntilNextRun();

  log(`next run in ${Math.round(delay / 60000)} min (at ${RUN_AT_HOUR}:00 local)`);
  setTimeout(tick, delay).unref();
}

module.exports = { run, start, selectVideosForUsers, buildMessage, msUntilNextRun, LOOKBACK_HOURS };
