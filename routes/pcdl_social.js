// routes/pcdl_social.js
// Block / unblock endpoints. Complements the public-profile endpoint in
// routes/pcdl.js, which reports is_blocked and hides friendships accordingly.
//
//   POST   /pcdl/users/block   {email, token, target_username}
//   DELETE /pcdl/users/block   {email, token, target_username}
//   POST   /pcdl/users/blocked {email, token}          -> list of blocked usernames

const { Router } = require("express");
const { Client } = require("pg");
const axios = require("axios");

const { ensureBlockTable } = require("../lib/blocks");

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

async function emailForUsername(db, username) {
  const r = await db.query(
    `SELECT email FROM public.users WHERE username = $1 LIMIT 1`,
    [username],
  );
  return r.rows[0]?.email || null;
}

module.exports = function pcdlSocialRoutes() {
  const router = Router();

  router.post(
    "/pcdl/users/block",
    asyncHandler(async (req, res) => {
      const b = req.body || {};
      const email = (b.email || "").trim();
      const token = (b.token || "").trim();
      const target = (b.target_username || "").trim();
      if (!email || !token || !target) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "email, token, target_username required",
        });
      }
      const auth = await verifyUserToken(email, token);
      if (!auth.ok)
        return res.status(400).json({ status: false, error: "unauthorized" });

      await ensureBlockTable(withClient);
      const done = await withClient(async (db) => {
        const targetEmail = await emailForUsername(db, target);
        if (!targetEmail) return { error: "not_found" };
        if (targetEmail === email) return { error: "self" };
        await db.query(
          `INSERT INTO public.user_blocks (blocker_email, blocked_email)
           VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [email, targetEmail],
        );
        // A block also severs any friendship both ways.
        await db.query(
          `DELETE FROM public.user_friends
            WHERE (user_email=$1 AND friend_email=$2)
               OR (user_email=$2 AND friend_email=$1)`,
          [email, targetEmail],
        );
        return { ok: true };
      });

      if (done.error === "not_found")
        return res
          .status(404)
          .json({ status: false, error: "not_found", message: "user not found" });
      if (done.error === "self")
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "cannot block yourself",
        });
      return res.json({ status: true });
    }),
  );

  router.delete(
    "/pcdl/users/block",
    asyncHandler(async (req, res) => {
      const b = req.body || {};
      const email = (b.email || "").trim();
      const token = (b.token || "").trim();
      const target = (b.target_username || "").trim();
      if (!email || !token || !target) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "email, token, target_username required",
        });
      }
      const auth = await verifyUserToken(email, token);
      if (!auth.ok)
        return res.status(400).json({ status: false, error: "unauthorized" });

      await ensureBlockTable(withClient);
      await withClient(async (db) => {
        const targetEmail = await emailForUsername(db, target);
        if (targetEmail) {
          await db.query(
            `DELETE FROM public.user_blocks
              WHERE blocker_email=$1 AND blocked_email=$2`,
            [email, targetEmail],
          );
        }
      });
      return res.json({ status: true });
    }),
  );

  router.post(
    "/pcdl/users/blocked",
    asyncHandler(async (req, res) => {
      const b = req.body || {};
      const email = (b.email || "").trim();
      const token = (b.token || "").trim();
      if (!email || !token) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "email and token required",
        });
      }
      const auth = await verifyUserToken(email, token);
      if (!auth.ok)
        return res.status(400).json({ status: false, error: "unauthorized" });

      await ensureBlockTable(withClient);
      const list = await withClient(async (db) => {
        const r = await db.query(
          `SELECT u.username, u.avatar_url
             FROM public.user_blocks bl
             JOIN public.users u ON u.email = bl.blocked_email
            WHERE bl.blocker_email = $1
            ORDER BY bl.created_at DESC`,
          [email],
        );
        return r.rows;
      });
      return res.json({ status: true, data: list });
    }),
  );

  return router;
};
