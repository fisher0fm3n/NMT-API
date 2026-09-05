// routes/pcdl_library.js
// The interactive library (interactive.pcdl.co): reading progress, bookmarks,
// and a star for every SCRIPTEX or e-magazine a reader finishes.
//
// Endpoints:
//   GET    /pcdl/library/state      ?email&token                      (auth)
//   POST   /pcdl/library/progress   {email, token, publication_id, …} (auth)
//   POST   /pcdl/library/bookmarks  {email, token, publication_id, …} (auth)
//   DELETE /pcdl/library/bookmarks  {email, token, publication_id, surface_id} (auth)
//   GET    /pcdl/library/stars      ?email&token                      (auth)
//
// A star is awarded once per publication, the first time the reader reaches the
// last page. Asking again is harmless: the endpoint reports the star it already
// holds rather than granting another.

const { Router } = require("express");
const { Client } = require("pg");
const axios = require("axios");

const {
  ensureLibrarySchema,
  saveProgress,
  readState,
  clampInt,
  trimTo,
} = require("../lib/library");

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

/** Pulls email + token from the query string or the body, and checks them. */
async function authed(req, res) {
  const src = req.method === "GET" || req.method === "DELETE" ? { ...req.query, ...req.body } : req.body || {};
  const email = String(src.email || "").trim().toLowerCase();
  const token = String(src.token || "").trim();
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
    res.status(400).json({ status: false, error: "unauthorized" });
    return null;
  }
  return email;
}

module.exports = function pcdlLibraryRoutes() {
  const router = Router();

  // ---------------- Everything the reader has, in one call ----------------
  router.get(
    "/pcdl/library/state",
    asyncHandler(async (req, res) => {
      const email = await authed(req, res);
      if (!email) return;
      await ensureLibrarySchema(withClient);
      const data = await withClient((db) => readState(db, email));
      return res.json({ status: true, data });
    }),
  );

  // ---------------- Just the stars, for a profile badge ----------------
  router.get(
    "/pcdl/library/stars",
    asyncHandler(async (req, res) => {
      const email = await authed(req, res);
      if (!email) return;
      await ensureLibrarySchema(withClient);
      const data = await withClient(async (db) => {
        const { rows } = await db.query(
          `SELECT publication_id, kind, title, awarded_at
             FROM public.library_stars
            WHERE email = $1
            ORDER BY awarded_at DESC`,
          [email],
        );
        return { stars: rows, star_count: rows.length };
      });
      return res.json({ status: true, data });
    }),
  );

  // ---------------- Record where the reader is ----------------
  // Also the only place a star is granted: reaching the last surface earns one,
  // and `star` comes back non-null only on the call that actually awarded it.
  router.post(
    "/pcdl/library/progress",
    asyncHandler(async (req, res) => {
      const email = await authed(req, res);
      if (!email) return;
      if (!String(req.body?.publication_id || "").trim()) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "publication_id is required",
        });
      }
      await ensureLibrarySchema(withClient);
      const data = await withClient((db) => saveProgress(db, email, req.body || {}));
      return res.json({ status: true, data });
    }),
  );

  // ---------------- Bookmarks ----------------
  router.post(
    "/pcdl/library/bookmarks",
    asyncHandler(async (req, res) => {
      const email = await authed(req, res);
      if (!email) return;
      const b = req.body || {};
      const publicationId = trimTo(b.publication_id, 120);
      const surfaceId = trimTo(b.surface_id, 120);
      if (!publicationId || !surfaceId) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "publication_id and surface_id are required",
        });
      }
      await ensureLibrarySchema(withClient);
      const data = await withClient(async (db) => {
        // Bookmarking the same page twice updates the note rather than
        // stacking duplicates in the list.
        const { rows } = await db.query(
          `
            INSERT INTO public.library_bookmarks
              (email, publication_id, surface_id, surface_index, title, surface_title, note)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (email, publication_id, surface_id) DO UPDATE SET
              surface_index = EXCLUDED.surface_index,
              title         = EXCLUDED.title,
              surface_title = EXCLUDED.surface_title,
              note          = EXCLUDED.note,
              created_at    = now()
            RETURNING id, publication_id, surface_id, surface_index, title,
                      surface_title, note, created_at
          `,
          [
            email,
            publicationId,
            surfaceId,
            clampInt(b.surface_index, 0, 10000),
            trimTo(b.title, 300),
            trimTo(b.surface_title, 300),
            trimTo(b.note, 1000),
          ],
        );
        return { bookmark: rows[0] };
      });
      return res.json({ status: true, data });
    }),
  );

  router.delete(
    "/pcdl/library/bookmarks",
    asyncHandler(async (req, res) => {
      const email = await authed(req, res);
      if (!email) return;
      const src = { ...req.query, ...(req.body || {}) };
      const publicationId = trimTo(src.publication_id, 120);
      const surfaceId = trimTo(src.surface_id, 120);
      if (!publicationId || !surfaceId) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "publication_id and surface_id are required",
        });
      }
      await ensureLibrarySchema(withClient);
      const removed = await withClient(async (db) => {
        const { rowCount } = await db.query(
          `DELETE FROM public.library_bookmarks
            WHERE email = $1 AND publication_id = $2 AND surface_id = $3`,
          [email, publicationId, surfaceId],
        );
        return rowCount > 0;
      });
      return res.json({ status: true, data: { removed } });
    }),
  );

  return router;
};
