const { Router } = require("express");
const axios = require("axios");
const crypto = require("crypto");
const {
  asyncHandler,
  trimDeep,
  providerKey,
  confirmEspeesWithRetry,
} = require("../lib/utils");

// ---------------------------------------------------------------------
// Push notification helpers
// ---------------------------------------------------------------------
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

module.exports = function espeesRoutes({ getDb }) {
  const router = Router();

  router.post(
    "/espees/payment",
    asyncHandler(async (req, res) => {
      const body = trimDeep(req.body ?? {});
      const {
        product_sku,
        narration,
        price,
        merchant_wallet,
        data,
        merchant_api_key,
        merchant,
        merchant_callback_method,
        merchant_callback_url,
      } = body;

      const missing = [];
      if (!product_sku) missing.push("product_sku");
      if (!narration) missing.push("narration");
      if (price === undefined || price === null || price === "")
        missing.push("price");
      if (!merchant_wallet) missing.push("merchant_wallet");
      if (!merchant_api_key) missing.push("merchant_api_key");
      if (!merchant) missing.push("merchant");
      if (!merchant_callback_method) missing.push("merchant_callback_method");
      if (!merchant_callback_url) missing.push("merchant_callback_url");
      if (missing.length)
        return res.status(400).json({
          status: false,
          msg: `Missing required field(s): ${missing.join(", ")}`,
        });

      const paymentintent = crypto.randomBytes(8).toString("base64url");
      const provSlug = providerKey(merchant || "espees");

      const success_url = `https://nmt.loveworldapis.com/espees/payment/${provSlug}/checkout?ref=${paymentintent}`;
      const fail_url = `https://nmt.loveworldapis.com/espees/payment/${provSlug}/checkout?ref=${paymentintent}`;

      const user_data = {
        paymentintent,
        data: data || {},
        merchant,
        narration,
        price,
        merchant_callback_url,
        merchant_callback_method: String(
          merchant_callback_method,
        ).toLowerCase(),
        merchant_wallet,
      };

      const response2 = await axios({
        method: "POST",
        url: "https://api.espees.org/v2/payment/product",
        headers: {
          "content-type": "application/json",
          "x-api-key": merchant_api_key,
        },
        data: {
          product_sku,
          narration: `${narration ?? ""} - ${paymentintent}`,
          price: String(price),
          merchant_wallet,
          success_url,
          fail_url,
          user_data,
        },
        timeout: 15000,
      });

      const payment_ref = response2?.data?.payment_ref;
      if (!payment_ref) {
        return res.status(502).json({
          status: false,
          msg: "Payment merchant response missing payment_ref",
          raw: response2?.data,
        });
      }

      const db = await getDb();
      await db.collection("espees_payment_intents").insertOne({
        id: paymentintent,
        paymentRef: payment_ref,
        merchant,
        createdAt: new Date(),
      });

      res.status(200).json({
        status: true,
        paymentRef: payment_ref,
        url: `https://payment.espees.org/pay/${payment_ref}`,
      });
    }),
  );

  router.post(
    "/espees/payment/confirm",
    asyncHandler(async (req, res) => {
      const body = trimDeep(req.body ?? {});
      const { payment_intent, merchant_api_key } = body;
      if (!payment_intent)
        return res
          .status(400)
          .json({ status: false, msg: "payment_intent is required" });
      if (!merchant_api_key)
        return res
          .status(400)
          .json({ status: false, msg: "merchant_api_key is required" });

      const db = await getDb();
      const intent = await db
        .collection("espees_payment_intents")
        .findOne({ id: payment_intent });
      if (!intent)
        return res
          .status(404)
          .json({ status: false, msg: "payment_intent not found" });

      const { paymentRef, paid, merchant } = intent;
      if (!paymentRef)
        return res
          .status(500)
          .json({ status: false, msg: "Stored intent missing paymentRef" });

      let confirmResp;
      try {
        confirmResp = await confirmEspeesWithRetry(
          paymentRef,
          merchant_api_key,
        );
      } catch (e) {
        const providerErr = e?.response?.data || e?.message || e;
        return res.status(502).json({
          status: false,
          msg: "Confirm call failed after retries",
          error: providerErr,
        });
      }

      const data = confirmResp.data || {};
      const {
        transaction_status,
        status_details,
        transaction_date,
        description,
        user_data = {},
      } = data;

      let callbackSent = false;
      let callbackStatus = "User has paid";
      const alreadyPaid = !!paid;

      if (transaction_status === "APPROVED" && !alreadyPaid) {
        const {
          merchant_callback_url,
          merchant_callback_method,
          data: callbackBody,
        } = user_data;
        if (merchant_callback_url) {
          try {
            if (merchant_callback_method === "get") {
              const cb = await axios.get(merchant_callback_url, {
                timeout: 10000,
                validateStatus: () => true,
              });
              callbackSent = true;
              callbackStatus = {
                ok: cb.status >= 200 && cb.status < 300,
                status: cb.status,
                data: cb.data,
              };
            } else {
              const cb = await axios.post(
                merchant_callback_url,
                callbackBody ?? {},
                { timeout: 10000, validateStatus: () => true },
              );
              callbackSent = true;
              callbackStatus = {
                ok: cb.status >= 200 && cb.status < 300,
                status: cb.status,
                data: cb.data,
              };
            }
          } catch (cbErr) {
            callbackSent = true;
            callbackStatus = {
              status: cbErr?.response?.status || null,
              error: cbErr?.response?.data || cbErr?.message || String(cbErr),
            };
          }
        }

        await db.collection("espees_payment_intents").updateOne(
          { id: payment_intent },
          {
            $set: {
              paid: true,
              paidAt: new Date(),
              lastStatus: transaction_status,
              lastStatusDetails: status_details,
              lastConfirmAt: new Date(),
              lastConfirmPayload: data,
            },
          },
        );

        try {
          const amount =
            typeof user_data?.price === "number"
              ? user_data.price
              : Number(user_data?.price);
          await db.collection("espees_espees_transactions").updateOne(
            { paymentRef },
            {
              $set: {
                paymentRef,
                payment_intent,
                merchant: merchant || user_data?.provider || null,
                description: description || null,
                amount: Number.isFinite(amount) ? amount : null,
                currency: user_data?.currency || null,
                status: transaction_status,
                status_details: status_details || null,
                transaction_date: transaction_date || null,
                callback: { sent: callbackSent, status: callbackStatus },
                updatedAt: new Date(),
              },
              $setOnInsert: { createdAt: new Date() },
            },
            { upsert: true },
          );
        } catch (logErr) {
          console.error("Transaction log failed:", logErr);
        }
      } else {
        await db.collection("espees_payment_intents").updateOne(
          { id: payment_intent },
          {
            $set: {
              lastStatus: transaction_status,
              lastStatusDetails: status_details,
              lastConfirmAt: new Date(),
              lastConfirmPayload: data,
            },
          },
        );
      }

      res.status(200).json({
        status: true,
        payment_intent,
        paymentRef,
        transaction_status,
        status_details,
        transaction_date,
        description,
        alreadyPaid,
        callback: { sent: callbackSent, status: callbackStatus },
      });
    }),
  );

  // Store Expo push token (Option A)
  router.post(
    "/espees/notifications/token",
    asyncHandler(async (req, res) => {
      const body = trimDeep(req.body ?? {});

      const {
        userID,
        expoPushToken,
        platform,
        appVersion, // optional
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

      // Basic Expo token validation (accepts both old/new prefix)
      const tokenStr = String(expoPushToken).trim();
      const isExpoToken =
        /^ExponentPushToken\[[^\]]+\]$/.test(tokenStr) ||
        /^ExpoPushToken\[[^\]]+\]$/.test(tokenStr);

      if (!isExpoToken) {
        return res.status(400).json({
          status: false,
          msg: "Invalid expoPushToken format",
        });
      }

      const now = new Date();
      const db = await getDb();

      // One doc per (userID + token); allows multiple devices per user
      const filter = { userID: String(userID), expoPushToken: tokenStr };

      const update = {
        $set: {
          userID: String(userID),
          expoPushToken: tokenStr,
          platform: platform ? String(platform) : null,
          appVersion: appVersion ? String(appVersion) : null,
          lastSeenAt: now,
          revoked: false,
          updatedAt: now,
        },
        $setOnInsert: {
          createdAt: now,
        },
      };

      await db
        .collection("espeesmax_notification_tokens")
        .updateOne(filter, update, { upsert: true });

      res.status(200).json({
        status: true,
        msg: "Token stored",
      });
    }),
  );

  router.post(
    "/espees/notifications/token/revoke",
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
      await db.collection("espeesmax_notification_tokens").updateOne(
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

      res.json({ status: true, msg: "Token revoked" });
    }),
  );

  // ---------------- Send notification to specific user(s) by ID ----------------
  router.post(
    "/espees/notifications/send",
    asyncHandler(async (req, res) => {
      const body = trimDeep(req.body ?? {});

      const {
        userID, // single id (string) OR
        userIDs, // array of ids
        title,
        body: messageBody,
        image, // optional
        data, // optional extra payload
        subtitle,
        sound = "default",
        ttl,
        expiration,
        priority = "high",
        badge,
      } = body;

      // Accept either `userID` (single) or `userIDs` (array); dedupe + clean.
      const targetUserIDs = [
        ...new Set(
          []
            .concat(userIDs ?? [])
            .concat(userID ?? [])
            .map((id) =>
              id !== undefined && id !== null ? String(id).trim() : null,
            )
            .filter(Boolean),
        ),
      ];

      const missing = [];
      if (!targetUserIDs.length) missing.push("userID or userIDs");
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

      const tokenDocs = await db
        .collection("espeesmax_notification_tokens")
        .find({
          userID: { $in: targetUserIDs },
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
          msg: "No active Expo push tokens found for the specified user(s)",
          requestedUsers: targetUserIDs.length,
        });
      }

      const extraData = stringifyDataObject(data);

      const notificationData = {
        ...extraData,
        type: extraData.type || "user",
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

      await db.collection("espeesmax_notification_logs").insertOne({
        userIDs: targetUserIDs,
        title: String(title),
        body: String(messageBody),
        data: notificationData,
        image: safeImage,
        requestedUsers: targetUserIDs.length,
        tokensFound: expoTokens.length,
        okCount,
        errorCount,
        tickets,
        createdAt: new Date(),
      });

      return res.json({
        status: true,
        msg: "User notification processed",
        requestedUsers: targetUserIDs.length,
        tokensFound: expoTokens.length,
        sent: messages.length,
        okCount,
        errorCount,
        tickets,
      });
    }),
  );

  // Demo (unchanged)
  router.get(
    "/users",
    asyncHandler(async (req, res) => {
      const db = await getDb();
      const docs = await db
        .collection("espees_payment_intents")
        .find({})
        .toArray();
      res.json(docs);
    }),
  );

  return router;
};