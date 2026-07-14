// routes/pcdl.routes.js
const { Router } = require("express");
const { Client } = require("pg");
const axios = require("axios");
const { trimDeep } = require("../lib/utils");
const { getFirebaseAdmin } = require("../lib/firebaseAdmin");

// ---------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------
function newClient() {
  return new Client({
    user: "postgres",
    host: "102.219.189.166",
    database: "ceflix",
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

// ---------------------------------------------------------------------
// Helpers / Guards
// ---------------------------------------------------------------------
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function topicNameForCategory(categorySlug) {
  return `category_${String(categorySlug)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")}`;
}

function isExpoPushToken(token) {
  const tokenStr = String(token || "").trim();
  return (
    /^ExponentPushToken\[[^\]]+\]$/.test(tokenStr) ||
    /^ExpoPushToken\[[^\]]+\]$/.test(tokenStr)
  );
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function stringifyDataObject(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  return Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, String(v ?? "")]),
  );
}

function isValidHttpsImageUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(String(value).trim());
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

async function sendExpoPushNotifications(messages = []) {
  if (!Array.isArray(messages) || !messages.length) return [];

  const chunks = chunkArray(messages, 100);
  const responses = [];

  for (const chunk of chunks) {
    const { data } = await axios.post(
      "https://exp.host/--/api/v2/push/send",
      chunk,
      {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 30000,
      },
    );

    responses.push(data);
  }

  return responses;
}

async function getUserNotificationSetting(db, userID) {
  const doc = await db.collection("ceflix_user_notification_settings").findOne({
    userID: String(userID),
  });

  return {
    enabled: doc?.enabled !== false,
    disabled: doc?.enabled === false,
    updatedAt: doc?.updatedAt || null,
    disabledAt: doc?.disabledAt || null,
    enabledAt: doc?.enabledAt || null,
  };
}

// ---------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------
module.exports = function ceflixRoutes({ getDb }) {
  const router = Router();

  router.get("/ceflix/test", (_req, res) =>
    res.json({ status: true, test: "hello m8" }),
  );

  router.get(
    "/ceflix/firebase/test",
    asyncHandler(async (_req, res) => {
      const admin = getFirebaseAdmin();
      const result = await admin.messaging().send({
        topic: "test_topic",
        notification: {
          title: "Firebase Working",
          body: "Admin SDK is configured correctly",
        },
      });

      res.json({ status: true, result });
    }),
  );

  // ---------------- User notification status ----------------
  router.post(
    "/ceflix/notifications/status",
    asyncHandler(async (req, res) => {
      const body = trimDeep(req.body ?? {});
      const { userID } = body;

      if (!userID) {
        return res.status(400).json({
          status: false,
          msg: "userID is required",
        });
      }

      const db = await getDb();

      const setting = await getUserNotificationSetting(db, userID);

      const activeTokenCount = await db
        .collection("ceflix_notification_tokens")
        .countDocuments({
          userID: String(userID),
          revoked: { $ne: true },
          expoPushToken: { $exists: true, $ne: null },
        });

      return res.json({
        status: true,
        userID: String(userID),
        notificationsEnabled: setting.enabled,
        notificationsDisabled: setting.disabled,
        activeTokenCount,
        updatedAt: setting.updatedAt,
        disabledAt: setting.disabledAt,
        enabledAt: setting.enabledAt,
      });
    }),
  );

  // ---------------- Enable notifications for user ----------------
  router.post(
    "/ceflix/notifications/enable",
    asyncHandler(async (req, res) => {
      const body = trimDeep(req.body ?? {});
      const { userID } = body;

      if (!userID) {
        return res.status(400).json({
          status: false,
          msg: "userID is required",
        });
      }

      const db = await getDb();
      const now = new Date();

      await db.collection("ceflix_user_notification_settings").updateOne(
        { userID: String(userID) },
        {
          $set: {
            userID: String(userID),
            enabled: true,
            enabledAt: now,
            updatedAt: now,
          },
          $unset: {
            disabledAt: "",
          },
          $setOnInsert: {
            createdAt: now,
          },
        },
        { upsert: true },
      );

      await db.collection("ceflix_notification_tokens").updateMany(
        { userID: String(userID) },
        {
          $set: {
            revoked: false,
            updatedAt: now,
            lastSeenAt: now,
          },
          $unset: {
            revokedAt: "",
          },
        },
      );

      return res.json({
        status: true,
        msg: "Notifications enabled",
        userID: String(userID),
        notificationsEnabled: true,
      });
    }),
  );

  // ---------------- Disable notifications for user ----------------
  router.post(
    "/ceflix/notifications/disable",
    asyncHandler(async (req, res) => {
      const body = trimDeep(req.body ?? {});
      const { userID } = body;

      if (!userID) {
        return res.status(400).json({
          status: false,
          msg: "userID is required",
        });
      }

      const db = await getDb();
      const now = new Date();

      await db.collection("ceflix_user_notification_settings").updateOne(
        { userID: String(userID) },
        {
          $set: {
            userID: String(userID),
            enabled: false,
            disabledAt: now,
            updatedAt: now,
          },
          $setOnInsert: {
            createdAt: now,
          },
        },
        { upsert: true },
      );

      await db.collection("ceflix_notification_tokens").updateMany(
        { userID: String(userID) },
        {
          $set: {
            revoked: true,
            revokedAt: now,
            updatedAt: now,
          },
        },
      );

      return res.json({
        status: true,
        msg: "Notifications disabled",
        userID: String(userID),
        notificationsEnabled: false,
      });
    }),
  );

  // ---------------- Subscribe device to category topic ----------------
  router.post(
    "/ceflix/notifications/subscribe-topic",
    asyncHandler(async (req, res) => {
      const body = trimDeep(req.body ?? {});
      const { category, devicePushToken, platform, userID } = body;

      if (!category || !devicePushToken) {
        return res.status(400).json({
          status: false,
          message: "category and devicePushToken are required",
        });
      }

      const topic = topicNameForCategory(category);

      if (String(platform).toLowerCase() !== "android") {
        return res.json({
          status: true,
          message: "Skipped FCM topic subscribe for non-Android device",
          topic,
        });
      }

      const admin = getFirebaseAdmin();

      const result = await admin
        .messaging()
        .subscribeToTopic([String(devicePushToken)], topic);

      const db = await getDb();

      await db.collection("ceflix_notification_topic_subscriptions").updateOne(
        {
          topic,
          devicePushToken: String(devicePushToken),
        },
        {
          $set: {
            userID: userID ? String(userID) : null,
            category: String(category),
            topic,
            platform: platform ? String(platform) : null,
            devicePushToken: String(devicePushToken),
            updatedAt: new Date(),
            revoked: false,
          },
          $setOnInsert: {
            createdAt: new Date(),
          },
        },
        { upsert: true },
      );

      return res.json({
        status: true,
        topic,
        result,
        userID: userID ?? null,
      });
    }),
  );

  // ---------------- Send notification to a category topic ----------------
  router.post(
    "/ceflix/notifications/send-category-upload",
    asyncHandler(async (req, res) => {
      const body = trimDeep(req.body ?? {});
      const { category, videoId, slug, title, body: messageBody, image } = body;

      if (!category || !videoId) {
        return res.status(400).json({
          status: false,
          message: "category and videoId are required",
        });
      }

      const topic = topicNameForCategory(category);
      const admin = getFirebaseAdmin();

      const safeImage = isValidHttpsImageUrl(image)
        ? String(image).trim()
        : null;

      const message = {
        topic,
        notification: {
          title: title || "New video uploaded",
          body: messageBody || "Tap to watch now",
          ...(safeImage ? { imageUrl: safeImage } : {}),
        },
        data: {
          url: slug ? `/videos/watch/${videoId}/${slug}` : `/watch/${videoId}`,
          route: slug
            ? `/videos/watch/${videoId}/${slug}`
            : `/watch/${videoId}`,
          videoId: String(videoId),
          id: String(videoId),
          category: String(category),
          type: "video",
          ...(slug ? { slug: String(slug) } : {}),
          ...(safeImage ? { image: safeImage } : {}),
        },
        android: {
          priority: "high",
          ...(safeImage
            ? {
                notification: {
                  imageUrl: safeImage,
                },
              }
            : {}),
        },
        ...(safeImage
          ? {
              apns: {
                fcmOptions: {
                  imageUrl: safeImage,
                },
              },
            }
          : {}),
      };

      const response = await admin.messaging().send(message);

      return res.json({
        status: true,
        topic,
        response,
      });
    }),
  );

  // ---------------- Store Expo token ----------------
  router.post(
    "/ceflix/notifications/token",
    asyncHandler(async (req, res) => {
      const body = trimDeep(req.body ?? {});

      const {
        userID,
        expoPushToken,
        devicePushToken,
        platform,
        appVersion,
        buildVersion,
        encID,
        purchase_token,
      } = body;

      const missing = [];
      if (!userID) missing.push("userID");
      if (!expoPushToken) missing.push("expoPushToken");

      if (missing.length) {
        return res.status(400).json({
          status: false,
          msg: `Missing required field(s): ${missing.join(", ")}`,
        });
      }

      const tokenStr = String(expoPushToken).trim();

      if (!isExpoPushToken(tokenStr)) {
        return res.status(400).json({
          status: false,
          msg: "Invalid expoPushToken format",
        });
      }

      const now = new Date();
      const db = await getDb();

      const setting = await getUserNotificationSetting(db, userID);
      const shouldRevoke = setting.enabled === false;

      const filter = {
        userID: String(userID),
        expoPushToken: tokenStr,
      };

      const update = {
        $set: {
          userID: String(userID),
          expoPushToken: tokenStr,
          devicePushToken: devicePushToken ? String(devicePushToken) : null,
          platform: platform ? String(platform) : null,
          appVersion: appVersion ? String(appVersion) : null,
          buildVersion: buildVersion ? String(buildVersion) : null,
          encID: encID ? String(encID) : null,
          purchase_token: purchase_token ? String(purchase_token) : null,
          lastSeenAt: now,
          revoked: shouldRevoke,
          updatedAt: now,
          ...(shouldRevoke ? { revokedAt: now } : {}),
        },
        $setOnInsert: {
          createdAt: now,
        },
      };

      if (!shouldRevoke) {
        update.$unset = {
          revokedAt: "",
        };
      }

      await db
        .collection("ceflix_notification_tokens")
        .updateOne(filter, update, { upsert: true });

      return res.status(200).json({
        status: true,
        msg: "Token stored",
        notificationsEnabled: !shouldRevoke,
      });
    }),
  );

  // ---------------- Revoke Expo token ----------------
  router.post(
    "/ceflix/notifications/token/revoke",
    asyncHandler(async (req, res) => {
      const body = trimDeep(req.body ?? {});
      const { userID, expoPushToken } = body;

      if (!userID || !expoPushToken) {
        return res.status(400).json({
          status: false,
          msg: "userID and expoPushToken are required",
        });
      }

      const db = await getDb();

      await db.collection("ceflix_notification_tokens").updateOne(
        {
          userID: String(userID),
          expoPushToken: String(expoPushToken).trim(),
        },
        {
          $set: {
            revoked: true,
            revokedAt: new Date(),
            updatedAt: new Date(),
          },
        },
      );

      return res.json({
        status: true,
        msg: "Token revoked",
      });
    }),
  );

  // ---------------- Channel notification status ----------------
  router.post(
    "/ceflix/notifications/channel/status",
    asyncHandler(async (req, res) => {
      const body = trimDeep(req.body ?? {});
      const { userID, channelID } = body;

      if (!userID || !channelID) {
        return res.status(400).json({
          status: false,
          msg: "userID and channelID are required",
        });
      }

      const db = await getDb();

      const doc = await db
        .collection("ceflix_user_channel_subscriptions")
        .findOne({
          userID: String(userID),
          channelID: String(channelID),
        });

      const userSetting = await getUserNotificationSetting(db, userID);

      return res.json({
        status: true,
        subscribed: !!doc && doc.revoked !== true,
        notificationsEnabled: userSetting.enabled,
        channelID: String(channelID),
        userID: String(userID),
      });
    }),
  );

  // ---------------- Subscribe user to channel ----------------
  router.post(
    "/ceflix/notifications/channel/subscribe",
    asyncHandler(async (req, res) => {
      const body = trimDeep(req.body ?? {});
      const { userID, channelID } = body;

      const missing = [];
      if (!userID) missing.push("userID");
      if (!channelID) missing.push("channelID");

      if (missing.length) {
        return res.status(400).json({
          status: false,
          msg: `Missing required field(s): ${missing.join(", ")}`,
        });
      }

      const db = await getDb();
      const now = new Date();

      await db.collection("ceflix_user_channel_subscriptions").updateOne(
        {
          userID: String(userID),
          channelID: String(channelID),
        },
        {
          $set: {
            userID: String(userID),
            channelID: String(channelID),
            revoked: false,
            updatedAt: now,
          },
          $unset: {
            revokedAt: "",
          },
          $setOnInsert: {
            createdAt: now,
          },
        },
        { upsert: true },
      );

      return res.status(200).json({
        status: true,
        msg: "Channel subscription stored",
      });
    }),
  );

  // ---------------- Revoke user channel subscription ----------------
  router.post(
    "/ceflix/notifications/channel/revoke",
    asyncHandler(async (req, res) => {
      const body = trimDeep(req.body ?? {});
      const { userID, channelID } = body;

      const missing = [];
      if (!userID) missing.push("userID");
      if (!channelID) missing.push("channelID");

      if (missing.length) {
        return res.status(400).json({
          status: false,
          msg: `Missing required field(s): ${missing.join(", ")}`,
        });
      }

      const db = await getDb();

      await db.collection("ceflix_user_channel_subscriptions").updateOne(
        {
          userID: String(userID),
          channelID: String(channelID),
        },
        {
          $set: {
            revoked: true,
            revokedAt: new Date(),
            updatedAt: new Date(),
          },
        },
      );

      return res.json({
        status: true,
        msg: "Channel subscription revoked",
      });
    }),
  );

  // ---------------- Send notification to all users subscribed to a channel ----------------
  router.post(
    "/ceflix/notifications/channel/send",
    asyncHandler(async (req, res) => {
      const body = trimDeep(req.body ?? {});

      const {
        channelID,
        title,
        body: messageBody,
        data,
        subtitle,
        sound = "default",
        ttl,
        expiration,
        priority = "high",
        badge,
        image,
      } = body;

      const missing = [];
      if (!channelID) missing.push("channelID");
      if (!title) missing.push("title");
      if (!messageBody) missing.push("body");

      if (missing.length) {
        return res.status(400).json({
          status: false,
          msg: `Missing required field(s): ${missing.join(", ")}`,
        });
      }

      const safeImage = isValidHttpsImageUrl(image)
        ? String(image).trim()
        : null;

      const db = await getDb();

      const subscriptions = await db
        .collection("ceflix_user_channel_subscriptions")
        .find({
          channelID: String(channelID),
          revoked: { $ne: true },
        })
        .toArray();

      if (!subscriptions.length) {
        return res.status(404).json({
          status: false,
          msg: "No active subscribers found for this channel",
          channelID: String(channelID),
        });
      }

      const subscribedUserIDs = [
        ...new Set(
          subscriptions
            .map((item) => (item?.userID ? String(item.userID) : null))
            .filter(Boolean),
        ),
      ];

      const disabledSettings = await db
        .collection("ceflix_user_notification_settings")
        .find({
          userID: { $in: subscribedUserIDs },
          enabled: false,
        })
        .project({ userID: 1 })
        .toArray();

      const disabledUserIDs = new Set(
        disabledSettings.map((item) => String(item.userID)),
      );

      const userIDs = subscribedUserIDs.filter(
        (userID) => !disabledUserIDs.has(String(userID)),
      );

      if (!userIDs.length) {
        return res.status(404).json({
          status: false,
          msg: "All subscribed users have notifications disabled",
          channelID: String(channelID),
          subscribedUsers: subscribedUserIDs.length,
          disabledUsers: disabledUserIDs.size,
        });
      }

      const tokenDocs = await db
        .collection("ceflix_notification_tokens")
        .find({
          userID: { $in: userIDs },
          revoked: { $ne: true },
          expoPushToken: { $exists: true, $ne: null },
        })
        .toArray();

      const expoTokens = [
        ...new Set(
          tokenDocs
            .map((item) =>
              item?.expoPushToken ? String(item.expoPushToken).trim() : null,
            )
            .filter((token) => token && isExpoPushToken(token)),
        ),
      ];

      if (!expoTokens.length) {
        return res.status(404).json({
          status: false,
          msg: "No active Expo push tokens found for subscribed users",
          channelID: String(channelID),
          subscribedUsers: subscribedUserIDs.length,
          enabledUsers: userIDs.length,
          disabledUsers: disabledUserIDs.size,
        });
      }

      const extraData = stringifyDataObject(data);

      const videoId = extraData.videoId || extraData.id || "";
      const slug = extraData.slug || "";
      const playlistId = extraData.playlistId || "";

      const targetUrl =
        extraData.url ||
        extraData.route ||
        (playlistId && videoId
          ? `/playlist/play/${playlistId}/${videoId}`
          : videoId && slug
            ? `/videos/watch/${videoId}/${slug}`
            : videoId
              ? `/watch/${videoId}`
              : `/channel/${channelID}`);

      const notificationData = {
        ...extraData,
        url: targetUrl,
        route: targetUrl,
        channelID: String(channelID),
        type: videoId ? "video" : "channel",
        ...(videoId ? { videoId: String(videoId), id: String(videoId) } : {}),
        ...(slug ? { slug: String(slug) } : {}),
        ...(playlistId ? { playlistId: String(playlistId) } : {}),
        ...(safeImage ? { image: safeImage } : {}),
      };

      const messages = expoTokens.map((token) => ({
        to: token,
        title: String(title),
        body: String(messageBody),
        data: notificationData,
        ...(subtitle ? { subtitle: String(subtitle) } : {}),
        ...(sound ? { sound: String(sound) } : {}),
        ...(ttl !== undefined && ttl !== null ? { ttl: Number(ttl) } : {}),
        ...(expiration !== undefined && expiration !== null
          ? { expiration: Number(expiration) }
          : {}),
        ...(priority ? { priority: String(priority) } : {}),
        ...(safeImage
          ? {
              richContent: {
                image: safeImage,
              },
            }
          : {}),
        ...(badge !== undefined && badge !== null
          ? { badge: Number(badge) }
          : {}),
        ...(safeImage ? { image: safeImage } : {}),
      }));

      const expoResponses = await sendExpoPushNotifications(messages);

      const tickets = expoResponses.flatMap((item) =>
        Array.isArray(item?.data) ? item.data : item?.data ? [item.data] : [],
      );

      const okCount = tickets.filter((t) => t?.status === "ok").length;
      const errorCount = tickets.filter((t) => t?.status !== "ok").length;

      await db.collection("ceflix_channel_notification_logs").insertOne({
        channelID: String(channelID),
        title: String(title),
        body: String(messageBody),
        data: notificationData,
        image: safeImage,
        subscribedUsers: subscribedUserIDs.length,
        enabledUsers: userIDs.length,
        disabledUsers: disabledUserIDs.size,
        tokensFound: expoTokens.length,
        okCount,
        errorCount,
        tickets,
        createdAt: new Date(),
      });

      return res.json({
        status: true,
        msg: "Channel notification processed",
        channelID: String(channelID),
        route: targetUrl,
        subscribedUsers: subscribedUserIDs.length,
        enabledUsers: userIDs.length,
        disabledUsers: disabledUserIDs.size,
        tokensFound: expoTokens.length,
        sent: messages.length,
        okCount,
        errorCount,
        tickets,
      });
    }),
  );

  // ---------------- Example signup route ----------------
  router.post(
    "/ceflix/gdoc/signup",
    asyncHandler(async (req, res) => {
      let {
        email,
        name,
        country = null,
        language = null,
        is_digital_crusader = false,
      } = req.body || {};

      const isCrusader =
        typeof is_digital_crusader === "string"
          ? ["true", "1", "yes", "on"].includes(
              is_digital_crusader.toLowerCase(),
            )
          : Boolean(is_digital_crusader);

      const trimOrNull = (v) =>
        v === undefined || v === null ? null : String(v).trim() || null;

      email = trimOrNull(email);
      name = trimOrNull(name);
      country = trimOrNull(country);
      language = trimOrNull(language);

      if (!isCrusader) {
        if (!email || !name) {
          return res.status(400).json({
            status: false,
            error: "bad_request",
            message: "Missing required fields: email, name",
          });
        }
      }

      if (email) {
        const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

        if (!emailOk) {
          return res.status(400).json({
            status: false,
            error: "bad_request",
            message: "Invalid email format",
          });
        }
      }

      const result = await withClient(async (db) => {
        const sql = `
          INSERT INTO ceflix_campaign_signup
            (email, name, country, language, is_digital_crusader)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (email) DO NOTHING
          RETURNING id, email, name, country, language, is_digital_crusader, created_at;
        `;

        const params = [email, name, country, language, isCrusader];

        const { rows } = await db.query(sql, params);

        if (rows.length === 0) return { skipped: true };

        return { skipped: false, row: rows[0] };
      });

      if (result.skipped) {
        return res.status(200).json({
          status: true,
          skipped: true,
          message: "Email already exists; signup skipped.",
        });
      }

      return res.status(201).json({
        status: true,
        skipped: false,
        data: result.row,
      });
    }),
  );

  // ---------------- Error handler ----------------
  router.use((err, _req, res, _next) => {
    console.error("[api] error:", err.stack || err);

    if (err && err.code && err.message) {
      return res.status(500).json({
        status: false,
        error: "db_error",
        code: err.code,
        message: err.message,
      });
    }

    return res.status(500).json({
      status: false,
      error: "internal_error",
      message: err?.message || "Internal Server Error",
    });
  });

  return router;
};
