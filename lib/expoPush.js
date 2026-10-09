// lib/expoPush.js
//
// Sends notifications through Expo's push service, which forwards them to
// FCM/APNs for the device tokens the app registered. Kept here so the
// on-demand routes and the scheduled jobs send the same way.
const axios = require("axios");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const MAX_PER_REQUEST = 100;

function isExpoPushToken(token) {
  const value = String(token || "").trim();

  return (
    /^ExponentPushToken\[[^\]]+\]$/.test(value) ||
    /^ExpoPushToken\[[^\]]+\]$/.test(value)
  );
}

function chunk(items, size) {
  const out = [];

  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));

  return out;
}

/**
 * @param {object[]} messages  Expo push messages ({ to, title, body, data, ... }).
 * @returns {Promise<object[]>} One ticket per message, in order. A ticket is
 *   { status: "ok", id } or { status: "error", message, details }.
 */
async function sendExpoPushNotifications(messages = []) {
  if (!Array.isArray(messages) || !messages.length) return [];

  const tickets = [];

  for (const batch of chunk(messages, MAX_PER_REQUEST)) {
    const { data } = await axios.post(EXPO_PUSH_URL, batch, {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      timeout: 30000,
    });

    // Expo returns { data: [ticket, ...] } for a batch.
    const batchTickets = Array.isArray(data?.data) ? data.data : [];

    for (let i = 0; i < batch.length; i += 1) {
      tickets.push(batchTickets[i] || { status: "error", message: "No ticket returned" });
    }
  }

  return tickets;
}

/** True when Expo says this token will never work again. */
function isDeadTokenTicket(ticket) {
  return (
    ticket?.status === "error" &&
    ticket?.details?.error === "DeviceNotRegistered"
  );
}

module.exports = { sendExpoPushNotifications, isExpoPushToken, isDeadTokenTicket };
