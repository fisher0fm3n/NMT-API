// routes/pcdl.routes.js
const { Router } = require("express");
const { Client } = require("pg");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// === local upload dirs for routes file ===
const UPLOAD_ROOT = path.join(process.cwd(), "uploads");
const AVATAR_DIR = path.join(UPLOAD_ROOT, "avatars");
const PLAYLIST_DIR = path.join(UPLOAD_ROOT, "playlists");
const CODE_RE =
  /^(?=.{4,12}$)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9](?:[A-Za-z0-9_]*[A-Za-z0-9])$/;

fs.mkdirSync(AVATAR_DIR, { recursive: true });
fs.mkdirSync(PLAYLIST_DIR, { recursive: true });

// put near your other helpers
const RESERVED_USERNAMES = new Set([
  "admin",
  "root",
  "support",
  "api",
  "system",
  "pcdl",
]);
function isValidUsername(u) {
  if (typeof u !== "string") return false;
  const s = u.trim();
  if (RESERVED_USERNAMES.has(s)) return false;
  return /^[a-z][a-z0-9._]{2,19}$/.test(s);
}

function validateAdminListPayload(b) {
  const errors = [];
  const id = (b.id || b.lists_id || b.ListsId || "").trim();
  const title = (b.title || b.Title || "").trim();
  const type = String(b.type || b.Type || "").toLowerCase();
  const items = b.items ?? b.Items;

  // NEW: normalize position (optional)
  let position = null;
  if (b.position !== undefined && b.position !== null && b.position !== "") {
    const n = parseInt(String(b.position), 10);
    if (Number.isFinite(n) && n >= 0) position = n;
    else errors.push("position must be a non-negative integer");
  }

  if (!id) errors.push("id is required");
  if (!title) errors.push("title is required");
  if (!["messages", "series", "items"].includes(type))
    errors.push("type must be 'messages' | 'series' | 'items'");
  if (!Array.isArray(items)) errors.push("items must be an array");

  if (Array.isArray(items)) {
    if (type === "messages" || type === "series") {
      const ok = items.every((x) => typeof x === "string" && x.trim());
      if (!ok)
        errors.push(
          "items must be an array of non-empty strings for 'messages' or 'series'",
        );
    } else if (type === "items") {
      const ok = items.every(
        (o) =>
          o &&
          typeof o === "object" &&
          typeof o.id === "string" &&
          o.id.trim() &&
          typeof o.title === "string" &&
          o.title.trim(),
      );
      if (!ok)
        errors.push(
          "each object item must have at least {id, title}; optional: pos, tag, thumbnail",
        );
    }
  }
  return { errors, id, title, type, items, position };
}

// ---------------------------------------------------------------------
// DB (fixed credentials, same pattern you use elsewhere)
// ---------------------------------------------------------------------
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

// ---------------------------------------------------------------------
// Helpers / Guards
// ---------------------------------------------------------------------
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// Admin guard for CUD endpoints you want extra protection on
function requireAdmin(req, res, next) {
  const token = req.header("x-admin-token");
  if (!token || token !== "49736993-2038-44f6-9273-5527b4b8779e") {
    return res.status(400).json({ status: false, error: "forbidden" });
  }
  next();
}

const KC_CODE_TTL_MS = 60 * 1000;
const kcCodeStore = new Map();

function putKcCode(payload) {
  const code = crypto.randomBytes(32).toString("hex"); // ✅ always supported
  kcCodeStore.set(code, { ...payload, exp: Date.now() + KC_CODE_TTL_MS });
  return code;
}

function takeKcCode(code) {
  const item = kcCodeStore.get(code);
  if (!item) return null;
  kcCodeStore.delete(code); // one-time use
  if (Date.now() > item.exp) return null;
  return item;
}

setInterval(() => {
  const now = Date.now();
  for (const [code, item] of kcCodeStore.entries()) {
    if (!item || item.exp < now) kcCodeStore.delete(code);
  }
}, 30 * 1000).unref();

// Global API key guard for all /pcdl/* routes
const REQUIRED_API_KEY = "ee115610-738b-4e7b-97e2-446468ba550c";
function requireApiKey(req, res, next) {
  const k = req.header("x-api-key");
  if (!k || k !== REQUIRED_API_KEY) {
    return res
      .status(401)
      .json({ status: false, error: "unauthorized_api_key" });
  }
  next();
}

// External token verification (series-only watchlist + users CRUD + award, etc)
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
    return {
      ok: apiToken === token,
      reason: apiToken === token ? null : "token_mismatch",
    };
  } catch (err) {
    return {
      ok: false,
      reason: err?.response?.data || err.message || "auth_api_failed",
    };
  }
}

// ---------------------------------------------------------------------
// Row shaping helper: series -> seasons -> messages
// ---------------------------------------------------------------------
function nestSeriesRows(rows) {
  const seriesMap = new Map();
  for (const r of rows) {
    let s = seriesMap.get(r.series_id);
    if (!s) {
      s = {
        id: r.series_id,
        title: r.series_title,
        description: r.series_description,
        status: r.series_status,
        cover_url: r.series_cover_url,
        thumbnail_url: r.series_thumbnail_url,
        created_at: r.series_created_at,
        seasons: [],
      };
      seriesMap.set(r.series_id, s);
    }
    if (r.season_id) {
      let season = s.seasons.find((z) => z.id === r.season_id);
      if (!season) {
        season = {
          id: r.season_id,
          title: r.season_title,
          status: r.season_status,
          position: r.season_position,
          messages: [],
        };
        s.seasons.push(season);
      }
      if (r.message_id) {
        season.messages.push({
          id: r.message_id,
          series_id: r.message_series_id,
          title: r.message_title,
          description: r.message_description,
          status: r.message_status,
          thumbnail_url: r.message_thumbnail_url,
          video_duration_seconds: r.message_video_duration_seconds,
          position: r.message_position ?? null,
          video:
            r.video_id || r.video_price != null
              ? { video_id: r.video_id || null, price: r.video_price }
              : null,
          audio:
            r.audio_id || r.audio_price != null
              ? { audio_id: r.audio_id || null, price: r.audio_price }
              : null,
        });
      }
    }
  }
  for (const s of seriesMap.values()) {
    s.seasons.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    for (const se of s.seasons) {
      se.messages.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    }
  }
  return Array.from(seriesMap.values());
}

// --- put these near the top of routes file (with other helpers) ----------------
function ylwSortDescByTitle(aTitle, bTitle) {
  const parse = (t) => {
    if (!t) return [0, 0, 0];
    const m = String(t).match(/Season\s+(\d+)\s+Phase\s+(\d+)\s+Day\s+(\d+)/i);
    return m
      ? [Number(m[1]) || 0, Number(m[2]) || 0, Number(m[3]) || 0]
      : [0, 0, 0];
  };
  const [sa, pa, da] = parse(aTitle);
  const [sb, pb, db] = parse(bTitle);
  if (sb !== sa) return sb - sa;
  if (pb !== pa) return pb - pa;
  return db - da;
}

async function fetchYourLoveWorldMessages(db, perLimit) {
  const { rows } = await db.query(
    `
      SELECT
        m.id,
        m.series_id,
        m.title,
        m.description,
        m.status,
        m.thumbnail_url,
        m.video_duration_seconds,
        m.video_id,
        m.video_price,
        m.audio_id,
        m.audio_price
      FROM public.messages m
      WHERE m.series_id = $1
    `,
    ["hGPFmF-VlVI"],
  );

  const shaped = rows.map((r) => ({
    id: r.id,
    title: r.title,
    thumbnail: r.thumbnail_url,
    description: r.description,
    status: r.status,
    series_id: r.series_id,
    video_duration_seconds: r.video_duration_seconds,
    videoID: r.video_id,
    videoPrice: r.video_price,
    audioID: r.audio_id,
    audioPrice: r.audio_price,
    audioUrl: null,
    videoUrl: null,
    trailer: null,
    tags: null,
    position: 0,
  }));

  shaped.sort((a, b) => ylwSortDescByTitle(a.title, b.title));
  return shaped.slice(0, perLimit);
}

async function fetchMessagesByIdsPG(db, ids, limit) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const capped = ids.filter(Boolean).slice(0, limit);
  const { rows } = await db.query(
    `
      SELECT
        m.id,
        m.series_id,
        m.title,
        m.description,
        m.status,
        m.thumbnail_url,
        m.video_duration_seconds,
        m.video_id,
        m.video_price,
        m.audio_id,
        m.audio_price,
        array_position($1::text[], m.id) AS ord
      FROM public.messages m
      WHERE m.id = ANY($1::text[])
      ORDER BY ord ASC
    `,
    [capped],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    thumbnail: r.thumbnail_url,
    description: r.description,
    status: r.status,
    series_id: r.series_id,
    video_duration_seconds: r.video_duration_seconds,
    videoID: r.video_id,
    videoPrice: r.video_price,
    audioID: r.audio_id,
    audioPrice: r.audio_price,
    audioUrl: null,
    videoUrl: null,
    trailer: null,
    tags: null,
    position: 0,
  }));

  function putKcCode(payload) {
    const code = crypto.randomBytes(24).toString("base64url"); // Node 16+ supports base64url
    kcCodeStore.set(code, { ...payload, exp: Date.now() + KC_CODE_TTL_MS });
    return code;
  }

  function takeKcCode(code) {
    const item = kcCodeStore.get(code);
    if (!item) return null;
    kcCodeStore.delete(code); // one-time
    if (Date.now() > item.exp) return null;
    return item;
  }
}

// ---------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------
module.exports = function pcdlRoutes(deps) {
  const { upload } = deps;
  const router = Router();

  // Apply API key to every /pcdl/* route
  // router.use("/pcdl", requireApiKey);

  const CAPTION_DIR = path.join(UPLOAD_ROOT, "captions");
  fs.mkdirSync(CAPTION_DIR, { recursive: true });

  function multerSingleCaption(upload) {
    return (req, res, next) => {
      const mw = upload.single("caption");
      mw(req, res, (err) => {
        if (err) {
          return res.status(400).json({
            status: false,
            error: "upload_error",
            message: err.message || "Caption upload failed",
          });
        }
        next();
      });
    };
  }

  function parseTimeToSeconds(value) {
    const clean = String(value || "")
      .trim()
      .replace(",", ".");
    const parts = clean.split(":").map(Number);

    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }

    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }

    return Number(clean) || 0;
  }

  function parseCaptionFile(text) {
    const lines = String(text || "")
      .replace(/\r/g, "")
      .split("\n");

    const segments = [];
    let i = 0;

    while (i < lines.length) {
      let line = lines[i].trim();

      if (!line || line === "WEBVTT") {
        i++;
        continue;
      }

      if (/^\d+$/.test(line)) {
        i++;
        line = lines[i]?.trim() || "";
      }

      const match = line.match(
        /(\d{1,2}:\d{2}:\d{2}[.,]\d{3}|\d{1,2}:\d{2}[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{3}|\d{1,2}:\d{2}[.,]\d{3})/,
      );

      if (!match) {
        i++;
        continue;
      }

      const start_seconds = parseTimeToSeconds(match[1]);
      const end_seconds = parseTimeToSeconds(match[2]);

      i++;

      const textLines = [];
      while (i < lines.length && lines[i].trim()) {
        textLines.push(lines[i].trim());
        i++;
      }

      const captionText = textLines
        .join(" ")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();

      if (captionText) {
        segments.push({
          start_seconds,
          end_seconds,
          text: captionText,
        });
      }

      i++;
    }

    return segments;
  }

  function detectCaptionFormat(filename, mimetype) {
    const ext = path.extname(filename || "").toLowerCase();

    if (ext === ".vtt") return "vtt";
    if (ext === ".srt") return "srt";
    if (mimetype === "text/vtt") return "vtt";

    return "srt";
  }

  async function saveCaptionFile(messageId, languageCode, file) {
    const format = detectCaptionFormat(file.originalname, file.mimetype);
    const safeMessage = String(messageId).replace(/[^a-zA-Z0-9._-]/g, "_");
    const safeLang = String(languageCode).replace(/[^a-zA-Z0-9._-]/g, "_");
    const filename = `${safeMessage}_${safeLang}_${Date.now()}.${format}`;
    const absPath = path.join(CAPTION_DIR, filename);

    await fs.promises.writeFile(absPath, file.buffer);

    return {
      file_url: `/uploads/captions/${filename}`,
      file_format: format,
      raw_text: file.buffer.toString("utf8"),
    };
  }

  // ---------------- Health / Ping ----------------
  router.get("/pcdl/test", (_req, res) =>
    res.json({ status: true, test: "hello m8" }),
  );

  router.get(
    "/pcdl/db/ping",
    asyncHandler(async (_req, res) => {
      const data = await withClient(async (db) => {
        const { rows } = await db.query(
          "SELECT now() AS now, current_user AS user",
        );
        return rows[0];
      });
      res.json({ status: true, db: data });
    }),
  );

  // POST /pcdl/auth/login
  // POST /pcdl/auth/login  (accepts user.login = email OR username)
  router.post(
    "/pcdl/auth/login",
    asyncHandler(async (req, res) => {
      try {
        const creds = req.body?.user || {};
        const { login, password } = creds || {};

        if (!login || !password) {
          return res.status(400).json({
            status: false,
            error: "bad_request",
            message: "user.login and user.password are required",
          });
        }

        const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

        let email = login;

        if (!isEmail(login)) {
          const row = await withClient(async (db) => {
            const r = await db.query(
              `SELECT email FROM public.users WHERE username = $1`,
              [login],
            );
            return r.rows[0] || null;
          });

          if (!row || !row.email) {
            return res.status(401).json({
              status: false,
              error: "unauthorized",
              message: "Invalid login or password",
            });
          }

          email = row.email;
        }

        const loginResp = await fetch(
          "https://sjvv8a3ys1.execute-api.us-east-1.amazonaws.com/Dev/newLogin",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ user: { email, password } }),
          },
        );

        let loginJson;
        try {
          loginJson = await loginResp.json();
        } catch {
          return res.status(502).json({
            status: false,
            error: "bad_gateway",
            message: "Invalid JSON from login provider",
          });
        }

        if (
          !loginResp.ok ||
          !loginJson ||
          loginJson.statusCode !== 200 ||
          !loginJson.body ||
          !loginJson.body.email ||
          !loginJson.body.token
        ) {
          return res.status(401).json({
            status: false,
            error: "unauthorized",
            message:
              loginJson?.message || "Login failed with external provider",
          });
        }

        const apiBody = loginJson.body;

        await withClient(async (db) => {
          const { rows: existingRows } = await db.query(
            `SELECT * FROM public.users WHERE email = $1`,
            [apiBody.email],
          );

          let dbUser;

          if (existingRows.length === 0) {
            const fields = [
              "title",
              "first_name",
              "last_name",
              "country",
              "church",
              "user_zone",
              "user_group",
              "christ_embassy_member",
              "avatar_url",
              "phone_number",
              "username",
              "is_profile_public",
            ];

            const payload = {
              email: apiBody.email,
              title: apiBody.title ?? null,
              first_name: apiBody.first_name ?? null,
              last_name: apiBody.last_name ?? null,
              country: null,
              church: null,
              user_zone: null,
              user_group: null,
              christ_embassy_member: null,
              avatar_url: null,
              phone_number: null,
              username: null,
              is_profile_public: true,
            };

            const cols = ["email"].concat(fields);
            const vals = [payload.email].concat(
              fields.map((f) => (payload[f] === undefined ? null : payload[f])),
            );
            const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
            const updates = fields
              .filter((f) => f !== "username" && f !== "country")
              .map((f) => `${f} = EXCLUDED.${f}`)
              .join(", ");

            const sql = `
            INSERT INTO public.users (${cols.join(",")})
            VALUES (${placeholders})
            ON CONFLICT (email) DO UPDATE SET ${updates}, updated_at = now()
            RETURNING *;
          `;

            const ins = await db.query(sql, vals);
            dbUser = ins.rows[0];
          } else {
            dbUser = existingRows[0];
          }

          const { avatar_url: apiAvatar, ...restApi } = apiBody;

          const merged = {
            ...dbUser,
            ...restApi,
            country: dbUser.country ?? restApi.country ?? null,
            avatar_url: (apiAvatar ?? dbUser.avatar_url) || dbUser.avatar_url,
          };

          const { admin, ...safeMerged } = merged;

          return res.status(200).json({
            status: true,
            data: safeMerged,
            message: loginJson?.message || "Login Successfully",
          });
        });
      } catch (err) {
        return res.status(500).json({
          status: false,
          error: "server_error",
          message: "Unexpected error while processing login",
        });
      }
    }),
  );

  router.post(
    "/pcdl/auth/admin_login",
    asyncHandler(async (req, res) => {
      try {
        // const creds = req.body?.user || {};
        // const { login, password } = creds || {};

        const creds = req.body?.user || {};
        const login = creds?.login || creds?.email || "";
        const password = creds?.password || "";

        if (!login || !password) {
          return res.status(400).json({
            status: false,
            debug: {
              body: req.body,
              user: req.body?.user,
              login,
              password,
              bodyType: typeof req.body,
              contentType: req.headers["content-type"],
            },
            message: "user.login and user.password are required",
          });
        }

        if (!login || !password) {
          return res.status(400).json({
            status: false,
            error: "bad_request",
            message: "user.login and user.password are required",
          });
        }

        const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

        let email = login;

        if (!isEmail(login)) {
          const row = await withClient(async (db) => {
            const r = await db.query(
              `SELECT email FROM public.users WHERE username = $1`,
              [login],
            );
            return r.rows[0] || null;
          });

          if (!row || !row.email) {
            return res.status(401).json({
              status: false,
              error: "unauthorized",
              message: "Invalid login or password",
            });
          }

          email = row.email;
        }

        // 1) Authenticate against external provider
        const loginResp = await fetch(
          "https://sjvv8a3ys1.execute-api.us-east-1.amazonaws.com/Dev/newLogin",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ user: { email, password } }),
          },
        );

        let loginJson;
        try {
          loginJson = await loginResp.json();
        } catch {
          return res.status(502).json({
            status: false,
            error: "bad_gateway",
            message: "Invalid JSON from login provider",
          });
        }

        if (
          !loginResp.ok ||
          !loginJson ||
          loginJson.statusCode !== 200 ||
          !loginJson.body ||
          !loginJson.body.email ||
          !loginJson.body.token
        ) {
          return res.status(401).json({
            status: false,
            error: "unauthorized",
            message:
              loginJson?.message || "Login failed with external provider",
          });
        }

        const apiBody = loginJson.body;

        await withClient(async (db) => {
          // 2) Find or create local user
          const { rows: existingRows } = await db.query(
            `SELECT * FROM public.users WHERE email = $1`,
            [apiBody.email],
          );

          let dbUser;

          if (existingRows.length === 0) {
            const fields = [
              "title",
              "first_name",
              "last_name",
              "country",
              "church",
              "user_zone",
              "user_group",
              "christ_embassy_member",
              "avatar_url",
              "phone_number",
              "username",
              "is_profile_public",
            ];

            const payload = {
              email: apiBody.email,
              title: apiBody.title ?? null,
              first_name: apiBody.first_name ?? null,
              last_name: apiBody.last_name ?? null,
              country: null,
              church: null,
              user_zone: null,
              user_group: null,
              christ_embassy_member: null,
              avatar_url: null,
              phone_number: null,
              username: null,
              is_profile_public: true,
            };

            const cols = ["email"].concat(fields);
            const vals = [payload.email].concat(
              fields.map((f) => (payload[f] === undefined ? null : payload[f])),
            );
            const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
            const updates = fields
              .filter((f) => f !== "username" && f !== "country")
              .map((f) => `${f} = EXCLUDED.${f}`)
              .join(", ");

            const sql = `
            INSERT INTO public.users (${cols.join(",")})
            VALUES (${placeholders})
            ON CONFLICT (email) DO UPDATE SET ${updates}, updated_at = now()
            RETURNING *;
          `;

            const ins = await db.query(sql, vals);
            dbUser = ins.rows[0];
          } else {
            dbUser = existingRows[0];
          }

          // 3) Admin gate
          if (dbUser?.admin !== true) {
            return res.status(403).json({
              status: false,
              error: "forbidden",
              message: "Admin access required",
            });
          }

          // 4) Merge external payload with DB user
          const { avatar_url: apiAvatar, ...restApi } = apiBody;

          const merged = {
            ...dbUser,
            ...restApi,
            country: dbUser.country ?? restApi.country ?? null,
            avatar_url: (apiAvatar ?? dbUser.avatar_url) || dbUser.avatar_url,
          };

          // 5) Remove admin field from returned payload
          const { admin, ...safeMerged } = merged;

          return res.status(200).json({
            status: true,
            data: safeMerged,
            message: loginJson?.message || "Admin login successful",
          });
        });
      } catch (err) {
        return res.status(500).json({
          status: false,
          error: "server_error",
          message: "Unexpected error while processing admin login",
        });
      }
    }),
  );

  // ---------------- SERIES ----------------
  router.get(
    "/pcdl/series",
    asyncHandler(async (req, res) => {
      const { q, limit = 50, offset = 0 } = req.query;
      const { data } = await withClient(async (db) => {
        const params = [];
        let where = "";
        if (q) {
          params.push(`%${q}%`);
          where = `WHERE s.title ILIKE $${params.length}`;
        }
        const sql = `
          WITH joined AS (
            SELECT
              s.id   AS series_id,
              s.title AS series_title,
              s.description AS series_description,
              s.status AS series_status,
              s.cover_url AS series_cover_url,
              s.thumbnail_url AS series_thumbnail_url,
              s.created_at AS series_created_at,

              se.id AS season_id,
              se.title AS season_title,
              se.status AS season_status,
              se.position AS season_position,

              m.id AS message_id,
              m.series_id AS message_series_id,
              m.title AS message_title,
              m.description AS message_description,
              m.status AS message_status,
              m.thumbnail_url AS message_thumbnail_url,
              m.video_duration_seconds AS message_video_duration_seconds,
              sm.position AS message_position,

              mv.video_id, mv.price AS video_price,
              ma.audio_id, ma.price AS audio_price
            FROM series s
            LEFT JOIN seasons se ON se.series_id = s.id
            LEFT JOIN season_messages sm ON sm.season_id = se.id
            LEFT JOIN messages m ON m.id = sm.message_id
            LEFT JOIN message_video mv ON mv.message_id = m.id
            LEFT JOIN message_audio ma ON ma.message_id = m.id
            ${where}
            ORDER BY s.created_at DESC, se.position ASC NULLS LAST, sm.position ASC NULLS LAST
          )
          SELECT * FROM joined
          LIMIT $${params.push(Number(limit))} OFFSET $${params.push(
            Number(offset),
          )}
        `;
        const rows = await db.query(sql, params);
        return { data: nestSeriesRows(rows.rows) };
      });
      res.json({
        status: true,
        data,
        limit: Number(limit),
        offset: Number(offset),
      });
    }),
  );

  router.get(
    "/pcdl/series/all",
    asyncHandler(async (req, res) => {
      const { q } = req.query;

      const { data } = await withClient(async (db) => {
        const params = [];
        const whereParts = [`s.status = 'Published'`];

        if (q) {
          params.push(`%${String(q).trim()}%`);
          whereParts.push(`s.title ILIKE $${params.length}`);
        }

        const where = whereParts.length
          ? `WHERE ${whereParts.join(" AND ")}`
          : "";

        const sql = `
        SELECT
          s.id            AS id,
          s.title         AS title,
          s.description   AS description,
          s.cover_url     AS cover_url,
          s.thumbnail_url AS thumbnail_url,
          s.created_at    AS created_at
        FROM series s
        ${where}
        ORDER BY s.title ASC
      `;

        const rows = await db.query(sql, params);

        return {
          data: rows.rows,
        };
      });

      res.json({
        status: true,
        data,
      });
    }),
  );

  router.post(
    "/pcdl/series",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};

      const email = b.email ? String(b.email).trim() : "";
      const token = b.token ? String(b.token).trim() : "";

      const id = b.id ? String(b.id).trim() : "";
      const title = b.title ?? null;
      const description = b.description ?? null;
      const status = b.status ?? null;
      const cover_url = b.cover_url ?? null;
      const thumbnail_url = b.thumbnail_url ?? null;
      const categories = Array.isArray(b.categories) ? b.categories : [];

      if (!id) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "id is required",
        });
      }

      if (!title) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "title is required",
        });
      }

      const auth = await verifyUserToken(email, token);
      if (!auth.ok)
        return res.status(400).json({
          status: false,
          error: "unauthorized",
          message: "token verification failed",
        });

      const row = await withClient(async (db) => {
        const { rows } = await db.query(
          `SELECT * FROM public.users WHERE email = $1 LIMIT 1`,
          [email],
        );
        return rows[0] || null;
      });

      if (!row.admin) {
        return res.status(400).json({
          status: false,
          error: "unauthorized",
          message: "Not an admin user",
        });
      }

      await withClient(async (db) => {
        await db.query("BEGIN");
        try {
          await db.query(
            `
            INSERT INTO series (
              id,
              title,
              description,
              status,
              cover_url,
              thumbnail_url
            )
            VALUES ($1, $2, $3, $4, $5, $6)
          `,
            [id, title, description, status, cover_url, thumbnail_url],
          );

          const cleanCategories = [
            ...new Set(
              categories.map((v) => String(v || "").trim()).filter(Boolean),
            ),
          ];

          for (const categoryId of cleanCategories) {
            await db.query(
              `
              INSERT INTO series_categories (series_id, category_id)
              VALUES ($1, $2)
              ON CONFLICT (series_id, category_id) DO NOTHING
            `,
              [id, categoryId],
            );
          }

          await db.query("COMMIT");
        } catch (err) {
          await db.query("ROLLBACK");
          throw err;
        }
      });

      res.json({
        status: true,
        id,
        categories: Array.isArray(b.categories) ? b.categories : [],
      });
    }),
  );

  router.post(
    "/pcdl/series/detail",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const seriesId = String(b.series_id || b.seriesid || b.id || "").trim();

      if (!seriesId) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "series_id is required in request body",
        });
      }

      // ---- Optional watchlist check (email + token) ----
      const email = String(b.email || "").trim();
      const token = String(b.token || "").trim();
      let watchlist = { in_watchlist: false };

      if (email && token) {
        const auth = await verifyUserToken(email, token);

        if (auth.ok) {
          const row = await withClient(async (db) => {
            const { rows } = await db.query(
              `
              SELECT id, created_at
              FROM public.watchlist
              WHERE email = $1 AND series_id = $2
              LIMIT 1
            `,
              [email, seriesId],
            );
            return rows[0] || null;
          });

          if (row) {
            watchlist = {
              in_watchlist: true,
              id: row.id,
              added_at: row.created_at,
            };
          }
        } else {
          watchlist = { in_watchlist: false };
        }
      }

      const { data } = await withClient(async (db) => {
        // ---- Main series payload ----
        const mainSql = `
        SELECT
          s.id AS series_id,
          s.title AS series_title,
          s.description AS series_description,
          s.status AS series_status,
          s.cover_url AS series_cover_url,
          s.thumbnail_url AS series_thumbnail_url,
          s.created_at AS series_created_at,

          se.id AS season_id,
          se.title AS season_title,
          se.status AS season_status,
          se.position AS season_position,

          m.id AS message_id,
          m.series_id AS message_series_id,
          m.title AS message_title,
          m.description AS message_description,
          m.status AS message_status,
          m.thumbnail_url AS message_thumbnail_url,
          m.video_duration_seconds AS message_video_duration_seconds,
          sm.position AS message_position,

          mv.video_id,
          mv.price AS video_price,
          ma.audio_id,
          ma.price AS audio_price
        FROM series s
        LEFT JOIN seasons se
          ON se.series_id = s.id
        LEFT JOIN season_messages sm
          ON sm.season_id = se.id
        LEFT JOIN messages m
          ON m.id = sm.message_id
        LEFT JOIN message_video mv
          ON mv.message_id = m.id
        LEFT JOIN message_audio ma
          ON ma.message_id = m.id
        WHERE s.id = $1
        ORDER BY se.position ASC NULLS LAST, sm.position ASC NULLS LAST
      `;

        const mainRows = await db.query(mainSql, [seriesId]);
        const mainData = (nestSeriesRows(mainRows.rows) || [])[0] || null;

        if (!mainData) {
          return { data: null };
        }

        // ---- Categories for this series ----
        const categoriesResult = await db.query(
          `
          SELECT
            c.id,
            c.name,
            c.thumbnail_url
          FROM series_categories sc
          JOIN categories c
            ON c.id = sc.category_id
          WHERE sc.series_id = $1
          ORDER BY c.name ASC
        `,
          [seriesId],
        );

        mainData.categories = categoriesResult.rows.map((r) => ({
          id: r.id,
          name: r.name,
        }));

        // ---- Suggestions ----
        const hasCats = await db.query(
          `SELECT 1 FROM series_categories WHERE series_id = $1 LIMIT 1`,
          [seriesId],
        );

        let moreRows = [];

        if (hasCats.rowCount > 0) {
          const suggestSql = `
          WITH sel_cats AS (
            SELECT sc.category_id
            FROM series_categories sc
            WHERE sc.series_id = $1
          ),
          overlap AS (
            SELECT
              s.id,
              s.title,
              s.description,
              s.status,
              s.cover_url,
              s.thumbnail_url,
              s.created_at,
              COUNT(DISTINCT sc.category_id) AS overlap_count
            FROM series s
            JOIN series_categories sc
              ON sc.series_id = s.id
            WHERE s.id <> $1
              AND sc.category_id IN (SELECT category_id FROM sel_cats)
            GROUP BY s.id
          ),
          cats_for_sug AS (
            SELECT
              sc.series_id,
              ARRAY_AGG(DISTINCT c.name ORDER BY c.name) AS category_names
            FROM series_categories sc
            JOIN categories c
              ON c.id = sc.category_id
            WHERE sc.series_id IN (SELECT id FROM overlap)
            GROUP BY sc.series_id
          )
          SELECT
            o.id,
            o.title,
            o.description,
            o.status,
            o.cover_url,
            o.thumbnail_url,
            o.created_at,
            o.overlap_count,
            COALESCE(cf.category_names, ARRAY[]::text[]) AS categories
          FROM overlap o
          LEFT JOIN cats_for_sug cf
            ON cf.series_id = o.id
          ORDER BY o.overlap_count DESC, RANDOM()
          LIMIT 12
        `;

          const r = await db.query(suggestSql, [seriesId]);
          moreRows = r.rows;
        } else {
          const fallback = await db.query(
            `
            WITH cats AS (
              SELECT
                sc.series_id,
                ARRAY_AGG(DISTINCT c.name ORDER BY c.name) AS category_names
              FROM series_categories sc
              JOIN categories c
                ON c.id = sc.category_id
              GROUP BY sc.series_id
            )
            SELECT
              s.id,
              s.title,
              s.description,
              s.status,
              s.cover_url,
              s.thumbnail_url,
              s.created_at,
              0 AS overlap_count,
              COALESCE(cats.category_names, ARRAY[]::text[]) AS categories
            FROM series s
            LEFT JOIN cats
              ON cats.series_id = s.id
            WHERE s.id <> $1
            ORDER BY RANDOM()
            LIMIT 12
          `,
            [seriesId],
          );
          moreRows = fallback.rows;
        }

        const more = moreRows.map((r) => ({
          id: r.id,
          title: r.title,
          description: r.description,
          status: r.status,
          cover_url: r.cover_url,
          thumbnail_url: r.thumbnail_url,
          created_at: r.created_at,
          overlap_count: Number(r.overlap_count || 0),
          categories: Array.isArray(r.categories) ? r.categories : [],
        }));

        mainData.more = more;
        mainData.watchlist = watchlist;

        return { data: mainData };
      });

      if (!data) {
        return res.status(400).json({
          status: false,
          error: "series not found",
        });
      }

      return res.json({
        status: true,
        data,
      });
    }),
  );

  router.post(
    "/pcdl/series.update",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const id = b.id ? String(b.id).trim() : "";
      const email = b.email ? String(b.email).trim() : "";
      const token = b.token ? String(b.token).trim() : "";

      if (!id) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "id is required in request body",
        });
      }

      const auth = await verifyUserToken(email, token);
      if (!auth.ok)
        return res.status(400).json({
          status: false,
          error: "unauthorized",
          message: "token verification failed",
        });

      const row = await withClient(async (db) => {
        const { rows } = await db.query(
          `SELECT * FROM public.users WHERE email = $1 LIMIT 1`,
          [email],
        );
        return rows[0] || null;
      });

      if (!row.admin) {
        return res.status(400).json({
          status: false,
          error: "unauthorized",
          message: "Not an admin user",
        });
      }

      const fields = [
        "title",
        "description",
        "status",
        "cover_url",
        "thumbnail_url",
      ];

      const sets = [];
      const params = [];

      for (const f of fields) {
        if (b[f] !== undefined) {
          params.push(b[f]);
          sets.push(`${f} = $${params.length}`);
        }
      }

      const categoriesProvided = Object.prototype.hasOwnProperty.call(
        b,
        "categories",
      );

      const cleanCategories = categoriesProvided
        ? [
            ...new Set(
              (Array.isArray(b.categories) ? b.categories : [])
                .map((v) => String(v || "").trim())
                .filter(Boolean),
            ),
          ]
        : [];

      const result = await withClient(async (db) => {
        await db.query("BEGIN");
        try {
          let rowCount = 0;

          if (sets.length) {
            params.push(id);
            const r = await db.query(
              `UPDATE series SET ${sets.join(", ")} WHERE id = $${params.length}`,
              params,
            );
            rowCount = r.rowCount;
          } else {
            const r = await db.query(`SELECT id FROM series WHERE id = $1`, [
              id,
            ]);
            rowCount = r.rowCount;
          }

          if (rowCount === 0) {
            await db.query("ROLLBACK");
            return { notFound: true };
          }

          if (categoriesProvided) {
            await db.query(
              `DELETE FROM series_categories WHERE series_id = $1`,
              [id],
            );

            for (const categoryId of cleanCategories) {
              await db.query(
                `
                INSERT INTO series_categories (series_id, category_id)
                VALUES ($1, $2)
                ON CONFLICT (series_id, category_id) DO NOTHING
              `,
                [id, categoryId],
              );
            }
          }

          await db.query("COMMIT");
          return { notFound: false };
        } catch (err) {
          await db.query("ROLLBACK");
          throw err;
        }
      });

      if (result?.notFound) {
        return res.status(400).json({
          status: false,
          error: "not_found",
          message: "series not found",
        });
      }

      if (!sets.length && !categoriesProvided) {
        return res.json({
          status: true,
          id,
          message: "nothing to update",
        });
      }

      res.json({
        status: true,
        id,
        ...(categoriesProvided ? { categories: cleanCategories } : {}),
      });
    }),
  );

  router.post(
    "/pcdl/series.delete",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const id = b.id ? String(b.id).trim() : "";
      const email = b.email ? String(b.email).trim() : "";
      const token = b.token ? String(b.token).trim() : "";

      if (!id) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "id is required in request body",
        });
      }

      const auth = await verifyUserToken(email, token);
      if (!auth.ok)
        return res.status(400).json({
          status: false,
          error: "unauthorized",
          message: "token verification failed",
        });

      const row = await withClient(async (db) => {
        const { rows } = await db.query(
          `SELECT * FROM public.users WHERE email = $1 LIMIT 1`,
          [email],
        );
        return rows[0] || null;
      });

      if (!row.admin) {
        return res.status(400).json({
          status: false,
          error: "unauthorized",
          message: "Not an admin user",
        });
      }

      const result = await withClient(async (db) => {
        await db.query("BEGIN");
        try {
          await db.query(`DELETE FROM series_categories WHERE series_id = $1`, [
            id,
          ]);

          const r = await db.query(`DELETE FROM series WHERE id = $1`, [id]);

          if (r.rowCount === 0) {
            await db.query("ROLLBACK");
            return { rowCount: 0 };
          }

          await db.query("COMMIT");
          return { rowCount: r.rowCount };
        } catch (err) {
          await db.query("ROLLBACK");
          throw err;
        }
      });

      if (result.rowCount === 0) {
        return res.status(400).json({
          status: false,
          error: "not_found",
          message: "series not found",
        });
      }

      res.json({ status: true, id });
    }),
  );

  // ---------------- CATEGORIES ----------------
  router.get(
    "/pcdl/categories",
    asyncHandler(async (req, res) => {
      const { q, limit = 100, offset = 0 } = req.query;
      const result = await withClient(async (db) => {
        const params = [];
        let where = "";
        if (q) {
          params.push(`%${q}%`);
          where = `WHERE c.name ILIKE $${params.length}`;
        }
        const { rows } = await db.query(
          `SELECT id, name, thumbnail_url FROM categories c ${where}
           ORDER BY name ASC
           LIMIT $${params.push(Number(limit))} OFFSET $${params.push(
             Number(offset),
           )}`,
          params,
        );
        return rows;
      });
      res.json({
        status: true,
        data: result,
        limit: Number(limit),
        offset: Number(offset),
      });
    }),
  );

  router.get(
    "/pcdl/categories/:id",
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      const rows = await withClient(async (db) => {
        const { rows } = await db.query(
          `
            SELECT
              c.id   AS category_id,
              c.name AS category_name,
              s.id   AS series_id,
              s.title AS series_title,
              s.status AS series_status,
              s.thumbnail_url AS series_thumbnail_url
            FROM categories c
            JOIN series_categories sc ON sc.category_id = c.id
            JOIN series s ON s.id = sc.series_id
            WHERE c.id = $1
              AND s.status = 'Published'
            ORDER BY s.title ASC
          `,
          [id],
        );
        return rows;
      });

      if (!rows.length) {
        return res
          .status(400)
          .json({ status: false, error: "category not found or empty" });
      }

      const payload = {
        id: rows[0].category_id,
        name: rows[0].category_name,
        series: [],
      };

      const seen = new Set();
      for (const r of rows) {
        if (seen.has(r.series_id)) continue;
        seen.add(r.series_id);
        payload.series.push({
          id: r.series_id,
          title: r.series_title,
          status: r.series_status,
          thumbnail_url: r.series_thumbnail_url,
        });
      }

      res.json({ status: true, data: payload });
    }),
  );

  router.post(
    "/pcdl/categories",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { id, name } =
        req.body && typeof req.body === "object" ? req.body : {};
      if (!id || !name)
        return res
          .status(400)
          .json({ status: false, error: "id and name are required" });
      await withClient(async (db) => {
        await db.query(
          `INSERT INTO categories (id, name) VALUES ($1,$2)
           ON CONFLICT (id) DO UPDATE SET name=$2`,
          [id, name],
        );
      });
      res.status(200).json({ status: true, id });
    }),
  );

  router.patch(
    "/pcdl/categories/:id",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      const { name } = req.body && typeof req.body === "object" ? req.body : {};
      if (name === undefined)
        return res.json({ status: true, id, message: "nothing to update" });
      await withClient(async (db) => {
        await db.query(`UPDATE categories SET name=$1 WHERE id=$2`, [name, id]);
      });
      res.json({ status: true, id });
    }),
  );

  router.delete(
    "/pcdl/categories/:id",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      const count = await withClient(async (db) => {
        const r = await db.query(`DELETE FROM categories WHERE id=$1`, [id]);
        return r.rowCount;
      });
      if (count === 0)
        return res.status(400).json({ status: false, error: "not found" });
      res.json({ status: true, id });
    }),
  );

  // ---------------- MESSAGES ----------------
  router.get(
    "/pcdl/messages/:id",
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      const data = await withClient(async (db) => {
        const { rows } = await db.query(
          `
            WITH msg AS (
              SELECT
                m.*,
                mv.video_id, mv.price AS video_price,
                ma.audio_id, ma.price AS audio_price
              FROM messages m
              LEFT JOIN message_video mv ON mv.message_id = m.id
              LEFT JOIN message_audio ma ON ma.message_id = m.id
              WHERE m.id = $1
            ),
            seasons_for_msg AS (
              SELECT se.id, se.title, se.position, se.series_id
              FROM season_messages sm
              JOIN seasons se ON se.id = sm.season_id
              WHERE sm.message_id = $1
              ORDER BY se.position ASC
            )
            SELECT
              (SELECT row_to_json(msg) FROM msg) AS message,
              (SELECT json_agg(row_to_json(seasons_for_msg)) FROM seasons_for_msg) AS seasons
          `,
          [id],
        );
        if (!rows.length || !rows[0].message) return null;
        return { ...rows[0].message };
      });
      if (!data)
        return res
          .status(400)
          .json({ status: false, error: "message not found" });
      res.json({ status: true, data });
    }),
  );

  // Playback (subscription check + upnext)
  // Playback (subscription check + upnext) + series title
  router.post(
    "/pcdl/messages/playback",
    asyncHandler(async (req, res) => {
      const { media, message_id, email, token } =
        req.body && typeof req.body === "object" ? req.body : {};

      if (!message_id || !media || !email || !token) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message:
            "Required fields: media ('audio'|'video'), message_id, email, token",
        });
      }

      const mediaType = String(media).toLowerCase();
      if (!["audio", "video"].includes(mediaType)) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "media must be 'audio' or 'video'",
        });
      }

      // Message data + series title
      const msgData = await withClient(async (db) => {
        const { rows } = await db.query(
          `
          SELECT
            m.*,
            -- if these columns exist on messages, keep them
            m.video_id, m.video_price,
            m.audio_id, m.audio_price,
            s.title AS series_title
          FROM public.messages m
          LEFT JOIN public.series s ON s.id = m.series_id
          WHERE m.id = $1
          LIMIT 1
        `,
          [message_id],
        );

        if (!rows.length) return null;
        return rows[0];
      });

      if (!msgData) {
        return res.status(400).json({
          status: false,
          error: "message_not_found",
          message: "Message not found",
        });
      }

      // upnext
      const upnext = await withClient(async (db) => {
        const { rows: curRows } = await db.query(
          `SELECT sm.season_id, sm.position
         FROM season_messages sm
         WHERE sm.message_id = $1
         ORDER BY sm.position ASC
         LIMIT 1`,
          [message_id],
        );

        if (curRows.length) {
          const { season_id, position } = curRows[0];
          const { rows: nrows } = await db.query(
            `SELECT m.id, m.title, m.thumbnail_url, m.series_id
           FROM season_messages sm
           JOIN messages m ON m.id = sm.message_id
           WHERE sm.season_id = $1 AND sm.position > $2
           ORDER BY sm.position ASC
           LIMIT 1`,
            [season_id, position],
          );
          if (nrows.length) {
            return { type: "season_next", ...nrows[0] };
          }
        }

        const { rows: rrows } = await db.query(
          `SELECT m2.id, m2.title, m2.thumbnail_url, m2.series_id
         FROM series_categories sc
         JOIN series_categories sc2 ON sc2.category_id = sc.category_id
         JOIN series s2 ON s2.id = sc2.series_id
         JOIN messages m2 ON m2.series_id = s2.id
         WHERE sc.series_id = (SELECT series_id FROM messages WHERE id = $1)
           AND m2.id <> $1
         ORDER BY random()
         LIMIT 1`,
          [message_id],
        );
        if (rrows.length) {
          return { type: "similar_random", ...rrows[0] };
        }
        return null;
      });

      // Subscription check
      let subscription = null;
      try {
        const subResp = await axios.post(
          "https://api.pastorchrisdigitallibrary.org/payment/subscriptionstatus",
          { email },
          { timeout: 8000, headers: { "Content-Type": "application/json" } },
        );
        subscription = subResp.data;
      } catch (err) {
        return res.status(400).json({
          status: false,
          error: "subscription_status_failed",
          message:
            err?.response?.data || err.message || "subscription status failed",
        });
      }

      const subscriptionName =
        subscription?.body?.subscription_name ||
        subscription?.subscription_name ||
        "";
      const isGold = /gold/i.test(String(subscriptionName));

      // If not subscribed, still return message data (now includes series_title) + subscription + upnext
      if (!isGold) {
        return res.json({
          status: false,
          data: msgData,
          subscription,
          upnext,
        });
      }

      const albumid =
        mediaType === "audio"
          ? msgData.audio_id || null
          : msgData.video_id || null;

      if (!albumid) {
        return res.status(400).json({
          status: false,
          message:
            "No albumid available on this message for the requested media type",
        });
      }

      let playbackResponse = null;
      try {
        const playbackResp = await axios.post(
          "https://api.pastorchrisdigitallibrary.org/external/mediaplayback",
          { email, albumid, token },
          { timeout: 10000, headers: { "Content-Type": "application/json" } },
        );
        playbackResponse = playbackResp.data;
      } catch (err) {
        return res.status(400).json({
          status: false,
          error: "mediaplayback_failed",
          message: err?.response?.data || err.message || "mediaplayback failed",
        });
      }

      // attach playback + upnext
      msgData.playback = playbackResponse?.albumlinks?.[0] ?? null;
      msgData.upnext = upnext || null;

      return res.json({
        status: true,
        data: msgData, // includes series_title
        subscription,
      });
    }),
  );

  // Create/Update/Delete messages (admin)
  router.post(
    "/pcdl/messages",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      for (const k of ["id", "series_id", "title"]) {
        if (!b[k])
          return res
            .status(400)
            .json({ status: false, error: `${k} is required` });
      }
      await withClient(async (db) => {
        await db.query(
          `INSERT INTO messages (id, series_id, title, description, status, thumbnail_url, video_duration_seconds)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (id) DO UPDATE
           SET series_id=$2, title=$3, description=$4, status=$5, thumbnail_url=$6, video_duration_seconds=$7`,
          [
            b.id,
            b.series_id,
            b.title,
            b.description || null,
            b.status || "Draft",
            b.thumbnail_url || null,
            b.video_duration_seconds != null ? b.video_duration_seconds : null,
          ],
        );
        if (b.video || b.video_id || b.video_price != null) {
          await db.query(
            `INSERT INTO message_video (message_id, video_id, price)
             VALUES ($1,$2,$3)
             ON CONFLICT (message_id) DO UPDATE SET video_id=$2, price=$3`,
            [
              b.id,
              b.video?.video_id || b.video_id || null,
              b.video?.price ?? b.video_price ?? null,
            ],
          );
        }
        if (b.audio || b.audio_id || b.audio_price != null) {
          await db.query(
            `INSERT INTO message_audio (message_id, audio_id, price)
             VALUES ($1,$2,$3)
             ON CONFLICT (message_id) DO UPDATE SET audio_id=$2, price=$3`,
            [
              b.id,
              b.audio?.audio_id || b.audio_id || null,
              b.audio?.price ?? b.audio_price ?? null,
            ],
          );
        }
      });
      res.status(200).json({ status: true, id: b.id });
    }),
  );

  router.patch(
    "/pcdl/messages/:id",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const up = [],
        params = [];
      for (const k of [
        "series_id",
        "title",
        "description",
        "status",
        "thumbnail_url",
        "video_duration_seconds",
      ]) {
        if (b[k] !== undefined) {
          params.push(b[k]);
          up.push(`${k} = $${params.length}`);
        }
      }
      await withClient(async (db) => {
        if (up.length) {
          params.push(id);
          await db.query(
            `UPDATE messages SET ${up.join(", ")} WHERE id = $${params.length}`,
            params,
          );
        }
        if (b.video || b.video_id || b.video_price != null) {
          await db.query(
            `INSERT INTO message_video (message_id, video_id, price)
             VALUES ($1,$2,$3)
             ON CONFLICT (message_id) DO UPDATE SET video_id=$2, price=$3`,
            [
              id,
              b.video?.video_id || b.video_id || null,
              b.video?.price ?? b.video_price ?? null,
            ],
          );
        }
        if (b.audio || b.audio_id || b.audio_price != null) {
          await db.query(
            `INSERT INTO message_audio (message_id, audio_id, price)
             VALUES ($1,$2,$3)
             ON CONFLICT (message_id) DO UPDATE SET audio_id=$2, price=$3`,
            [
              id,
              b.audio?.audio_id || b.audio_id || null,
              b.audio?.price ?? b.audio_price ?? null,
            ],
          );
        }
      });
      res.json({ status: true, id });
    }),
  );

  router.delete(
    "/pcdl/messages/:id",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      const count = await withClient(async (db) => {
        await db.query(`DELETE FROM message_video WHERE message_id = $1`, [id]);
        await db.query(`DELETE FROM message_audio WHERE message_id = $1`, [id]);
        const r = await db.query(`DELETE FROM messages WHERE id = $1`, [id]);
        return r.rowCount;
      });
      if (count === 0)
        return res.status(400).json({ status: false, error: "not found" });
      res.json({ status: true, id });
    }),
  );

  // ---------------- Languages ----------------
  router.get(
    "/pcdl/languages/:langId",
    asyncHandler(async (req, res) => {
      const { langId } = req.params;
      const limit = Number(req.query.limit ?? 50);
      const offset = Number(req.query.offset ?? 0);

      if (!langId) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "langId is required",
        });
      }

      const { data, language } = await withClient(async (db) => {
        // 1) Fetch matching messages (unchanged logic)
        const { rows } = await db.query(
          `
          WITH normalized AS (
            SELECT
              m.*,
              CASE
                WHEN pg_typeof(m.language_tags)::text = 'jsonb' THEN m.language_tags
                ELSE to_jsonb(m.language_tags)
              END AS lang_json
            FROM messages m
          ),
          filtered AS (
            SELECT n.*
            FROM normalized n
            WHERE n.lang_json IS NOT NULL
              AND jsonb_typeof(n.lang_json) = 'array'
              AND EXISTS (
                SELECT 1
                FROM jsonb_array_elements(n.lang_json) AS e(elem)
                WHERE
                  (jsonb_typeof(e.elem) = 'string' AND e.elem #>> '{}' = $1)
                  OR
                  (jsonb_typeof(e.elem) = 'object' AND e.elem->>'id' = $1)
              )
          )
          SELECT
            f.id, f.series_id, f.title, f.description, f.status, f.thumbnail_url,
            f.video_duration_seconds, f.video_id, f.video_price, f.audio_id, f.audio_price
          FROM filtered f
          ORDER BY f.title ASC
          LIMIT $2 OFFSET $3
        `,
          [langId, limit, offset],
        );

        // 2) Fetch the language title from the languages table
        const { rows: langRows } = await db.query(
          `SELECT id, title FROM languages WHERE id = $1 LIMIT 1`,
          [langId],
        );

        return {
          data: rows,
          language: langRows[0] ?? { id: langId, title: null },
        };
      });

      // Include id and title at the top level, as requested
      return res.json({
        status: true,
        data,
        limit,
        offset,
        id: language.id,
        title: language.title,
      });
    }),
  );

  router.get(
    "/pcdl/languages",
    asyncHandler(async (req, res) => {
      const limit = Number(req.query.limit ?? 100);
      const offset = Number(req.query.offset ?? 0);
      const rows = await withClient(async (db) => {
        try {
          const { rows } = await db.query(
            `SELECT id, code, name FROM languages
             ORDER BY name ASC NULLS LAST, id ASC
             LIMIT $1 OFFSET $2`,
            [limit, offset],
          );
          return rows;
        } catch (e) {
          const { rows } = await db.query(
            `SELECT * FROM languages ORDER BY 1 ASC LIMIT $1 OFFSET $2`,
            [limit, offset],
          );
          return rows;
        }
      });
      return res.json({ status: true, data: rows, limit, offset });
    }),
  );

  // ---------------- Search (Published only, trigram if available) ----------------
  router.get(
    "/pcdl/search",
    asyncHandler(async (req, res) => {
      const qRaw = (req.query.q || "").trim();
      const limit = Number(req.query.limit ?? 50);
      const offset = Number(req.query.offset ?? 0);
      if (!qRaw) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "Query parameter 'q' is required",
        });
      }
      const data = await withClient(async (db) => {
        const { rows: exts } = await db.query(
          "SELECT extname FROM pg_extension WHERE extname IN ('pg_trgm','unaccent')",
        );
        const hasTrgm = exts.some((e) => e.extname === "pg_trgm");
        const hasUnaccent = exts.some((e) => e.extname === "unaccent");
        const q = qRaw.replace(/\s+/g, " ").trim();

        if (hasTrgm) {
          const titleExpr = hasUnaccent ? "unaccent(s.title)" : "s.title";
          const qExpr = hasUnaccent ? "unaccent($1)" : "$1";
          const params = [q, 0.2, limit, offset];
          const sql = `
            SELECT
              s.id, s.title, s.description, s.thumbnail_url, s.cover_url, s.created_at,
              GREATEST(similarity(${titleExpr}, ${qExpr}), similarity(lower(${titleExpr}), lower(${qExpr}))) AS score
            FROM public.series s
            WHERE s.status = 'Published'
              AND (
                ${titleExpr} ILIKE '%' || ${qExpr} || '%'
                OR similarity(${titleExpr}, ${qExpr}) >= $2
              )
            ORDER BY score DESC NULLS LAST, s.title ASC
            LIMIT $3 OFFSET $4
          `;
          const { rows } = await db.query(sql, params);
          return rows;
        }

        const titleExpr = hasUnaccent ? "unaccent(s.title)" : "s.title";
        const qExpr = hasUnaccent ? "unaccent($1)" : "$1";
        const params = [q, limit, offset];
        const sql = `
          SELECT s.id, s.title, s.description, s.thumbnail_url, s.cover_url, s.created_at
          FROM public.series s
          WHERE s.status = 'Published'
            AND ${titleExpr} ILIKE '%' || ${qExpr} || '%'
          ORDER BY s.title ASC
          LIMIT $2 OFFSET $3
        `;
        const { rows } = await db.query(sql, params);
        return rows;
      });

      return res.json({ status: true, data, q: qRaw, limit, offset });
    }),
  );

  // ---------------- Watchlist (Series only) ----------------
  // Add (ignore if exists)
  router.post(
    "/pcdl/watchlist",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const { email, token, series_id } = b;

      if (!email || !token || !series_id) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "Required: email, token, series_id",
        });
      }

      const auth = await verifyUserToken(email, token);
      if (!auth.ok)
        return res.status(400).json({ status: false, error: "unauthorized" });

      const exists = await withClient(async (db) => {
        const { rows } = await db.query(
          `SELECT 1 FROM public.series WHERE id = $1 AND status = 'Published'`,
          [series_id],
        );
        return rows.length > 0;
      });
      if (!exists) {
        return res.status(400).json({
          status: false,
          error: "not_found",
          message: "Series does not exist or is not Published",
        });
      }

      const row = await withClient(async (db) => {
        await db.query(
          `INSERT INTO public.watchlist (email, series_id)
           VALUES ($1,$2)
           ON CONFLICT (email, series_id) DO NOTHING`,
          [email, series_id],
        );
        const { rows } = await db.query(
          `SELECT * FROM public.watchlist WHERE email = $1 AND series_id = $2`,
          [email, series_id],
        );
        return rows[0];
      });

      return res.status(200).json({ status: true, data: row });
    }),
  );

  // Get
  router.get(
    "/pcdl/watchlist",
    asyncHandler(async (req, res) => {
      const email = (req.query.email || "").trim();
      const token = (req.query.token || "").trim();
      const limit = Number(req.query.limit ?? 100);
      const offset = Number(req.query.offset ?? 0);

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
            SELECT
              w.*,
              jsonb_build_object(
                'id', s.id,
                'title', s.title,
                'thumbnail_url', s.thumbnail_url,
                'status', s.status
              ) AS series
            FROM public.watchlist w
            LEFT JOIN public.series s ON s.id = w.series_id
            WHERE w.email = $1
            ORDER BY w.created_at DESC
            LIMIT $2 OFFSET $3
          `,
          [email, limit, offset],
        );
        return rows;
      });

      return res.json({ status: true, data, email, limit, offset });
    }),
  );

  // Delete one
  router.delete(
    "/pcdl/watchlist",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : req.query;
      const { id, email, token, series_id } = b || {};

      if (!token || (!id && (!email || !series_id))) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "Provide token AND either id OR (email, series_id)",
        });
      }
      const userEmail = id ? email || "" : email;
      if (!userEmail) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "email is required",
        });
      }

      const auth = await verifyUserToken(userEmail, token);
      if (!auth.ok)
        return res.status(400).json({ status: false, error: "unauthorized" });

      const deleted = await withClient(async (db) => {
        if (id) {
          const r = await db.query(
            `DELETE FROM public.watchlist WHERE id = $1`,
            [id],
          );
          return r.rowCount;
        } else {
          const r = await db.query(
            `DELETE FROM public.watchlist WHERE email = $1 AND series_id = $2`,
            [email, series_id],
          );
          return r.rowCount;
        }
      });

      if (deleted === 0) {
        return res.status(400).json({
          status: false,
          error: "not_found",
          message: "nothing deleted",
        });
      }
      return res.json({ status: true, deleted });
    }),
  );

  // Clear all
  router.delete(
    "/pcdl/watchlist/clear",
    asyncHandler(async (req, res) => {
      const email = (req.body?.email || req.query?.email || "").trim();
      const token = (req.body?.token || req.query?.token || "").trim();
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

      const deleted = await withClient(async (db) => {
        const r = await db.query(
          `DELETE FROM public.watchlist WHERE email = $1`,
          [email],
        );
        return r.rowCount;
      });
      return res.json({ status: true, deleted });
    }),
  );

  // ---------------- Users CRUD (email-scoped) ----------------
  // wrap multer.single so errors become JSON
  function multerSingleAvatar(upload) {
    return (req, res, next) => {
      const mw = upload.single("avatar"); // field name: avatar
      mw(req, res, (err) => {
        if (err) {
          return res.status(400).json({
            status: false,
            error: "upload_error",
            message: err.message || "Upload failed",
            code: err.code || undefined,
          });
        }
        next();
      });
    };
  }

  // only accept these types (multer fileFilter should already enforce)
  const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

  async function deleteExistingAvatarIfAny(db, email) {
    const { rows } = await db.query(
      `SELECT avatar_url FROM public.users WHERE email = $1 LIMIT 1`,
      [email],
    );
    const current = rows[0]?.avatar_url;
    if (!current) return;

    const prefix = "/uploads/avatars/";
    if (!current.startsWith(prefix)) return;

    const fname = current.slice(prefix.length);
    if (!/^[a-zA-Z0-9._-]+$/.test(fname)) return;

    const abs = path.join(AVATAR_DIR, fname);
    if (!abs.startsWith(AVATAR_DIR)) return; // safety

    try {
      await fs.promises.unlink(abs);
    } catch (_) {
      /* ignore */
    }
  }

  async function saveNewAvatarAndGetUrl(email, file) {
    if (!file || !ALLOWED_MIME.has(file.mimetype)) return null;
    const ext =
      file.mimetype === "image/jpeg"
        ? ".jpg"
        : file.mimetype === "image/png"
          ? ".png"
          : file.mimetype === "image/webp"
            ? ".webp"
            : ".jpg";

    const safeEmail = email.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filename = `${safeEmail}_${Date.now()}${ext}`;
    const absPath = path.join(AVATAR_DIR, filename);
    await fs.promises.writeFile(absPath, file.buffer);
    return `/uploads/avatars/${filename}`;
  }

  // Convert Multer errors to JSON (field name: 'thumbnail')
  function multerSingleThumbnail(upload) {
    return (req, res, next) => {
      const mw = upload.single("thumbnail");
      mw(req, res, (err) => {
        if (err) {
          return res.status(400).json({
            status: false,
            error: "upload_error",
            message: err.message || "Upload failed",
            code: err.code || undefined,
          });
        }
        next();
      });
    };
  }

  async function deleteExistingPlaylistThumbIfAny(db, playlistId) {
    const { rows } = await db.query(
      `SELECT thumbnail_url FROM public.playlists WHERE id = $1 LIMIT 1`,
      [playlistId],
    );
    const current = rows[0]?.thumbnail_url;
    if (!current) return;

    const prefix = "/uploads/playlists/";
    if (!current.startsWith(prefix)) return;

    const fname = current.slice(prefix.length);
    if (!/^[a-zA-Z0-9._-]+$/.test(fname)) return;

    const abs = path.join(PLAYLIST_DIR, fname);
    if (!abs.startsWith(PLAYLIST_DIR)) return; // safety

    try {
      await fs.promises.unlink(abs);
    } catch (_) {
      /* ignore */
    }
  }

  async function saveNewPlaylistThumbAndGetUrl(playlistOwnerEmail, file) {
    if (!file || !ALLOWED_MIME.has(file.mimetype)) return null;

    const ext =
      file.mimetype === "image/jpeg"
        ? ".jpg"
        : file.mimetype === "image/png"
          ? ".png"
          : file.mimetype === "image/webp"
            ? ".webp"
            : ".jpg";

    const safeOwner = String(playlistOwnerEmail || "anon").replace(
      /[^a-zA-Z0-9._-]/g,
      "_",
    );
    const filename = `${safeOwner}_${Date.now()}${ext}`;
    const absPath = path.join(PLAYLIST_DIR, filename);

    await fs.promises.writeFile(absPath, file.buffer);
    return `/uploads/playlists/${filename}`;
  }

  // --- CREATE / UPSERT user (username set-once allowed) ---
  router.post(
    "/pcdl/users",
    multerSingleAvatar(upload),
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const { email, token } = b;

      if (!email || !token) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "email and token are required",
        });
      }

      const auth = await verifyUserToken(email, token);
      if (!auth.ok) {
        return res.status(400).json({
          status: false,
          error: "unauthorized",
          message: "token verification failed",
        });
      }

      // Optional avatar upload (delete old then save new) — same as before
      let avatarUrl = null;
      await withClient(async (db) => {
        if (req.file) {
          await deleteExistingAvatarIfAny(db, email);
          avatarUrl = await saveNewAvatarAndGetUrl(email, req.file);
        }

        // Username: set-once only
        let username = (b.username ?? "").trim() || null;

        if (username !== null) {
          // Validate + reserve
          if (!isValidUsername(username)) {
            return res.status(400).json({
              status: false,
              error: "invalid_username",
              message:
                "3-20 chars, lowercase, start with letter, only a-z 0-9 . _",
            });
          }
          // check not already set for this user
          const me = await db.query(
            `SELECT username FROM public.users WHERE email = $1`,
            [email],
          );
          const existingMine = me.rows[0]?.username || null;
          if (existingMine) {
            return res.status(400).json({
              status: false,
              error: "username_locked",
              message: "username already set and cannot be changed",
            });
          }
          // check uniqueness
          const taken = await db.query(
            `SELECT 1 FROM public.users WHERE username = $1`,
            [username],
          );
          if (taken.rowCount > 0) {
            return res
              .status(400)
              .json({ status: false, error: "username_taken" });
          }
        }

        const fields = [
          "title",
          "first_name",
          "last_name",
          "country",
          "church",
          "user_zone",
          "user_group",
          "christ_embassy_member",
          "avatar_url",
          "phone_number",
          "username",
          "is_profile_public", // <-- add this
        ];

        const payload = { ...b };
        if (avatarUrl) payload.avatar_url = avatarUrl;
        if (username !== null) payload.username = username;

        const cols = ["email"].concat(fields);
        const vals = [email].concat(
          fields.map((f) => (payload[f] === undefined ? null : payload[f])),
        );
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
        const updates = fields
          .filter((f) => f !== "username") // DO NOT update username on conflict
          .map((f) => `${f} = EXCLUDED.${f}`)
          .join(", ");

        const sql = `
        INSERT INTO public.users (${cols.join(",")})
        VALUES (${placeholders})
        ON CONFLICT (email) DO UPDATE SET ${updates}, updated_at = now()
        RETURNING *;
      `;
        const { rows } = await db.query(sql, vals);
        return res.status(200).json({ status: true, data: rows[0] });
      });
    }),
  );

  // Email + password sanity (tweak as you like)
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  // Upper/lower allowed, 4–12, at least one letter, start/end alnum, only A-Za-z0-9_
  const USERNAME_RE =
    /^(?=.{4,12}$)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9](?:[A-Za-z0-9_]*[A-Za-z0-9])$/;

  router.post(
    "/pcdl/auth/signup",
    multerSingleAvatar(upload),
    asyncHandler(async (req, res) => {
      try {
        const b = req.body && typeof req.body === "object" ? req.body : {};
        const {
          email,
          password,
          title,
          first_name,
          last_name,
          country,
          telephone,
          username, // optional
        } = b;

        // ---------- 1) Validate inputs BEFORE provider call ----------
        if (!email || !password) {
          return res.status(400).json({
            status: false,
            error: "bad_request",
            message: "email and password are required",
          });
        }
        if (!EMAIL_RE.test(email)) {
          return res.status(400).json({
            status: false,
            error: "invalid_email",
            message: "email format is invalid",
          });
        }
        if (String(password).length < 6) {
          return res.status(400).json({
            status: false,
            error: "weak_password",
            message: "password must be at least 6 characters",
          });
        }

        // Check email not already used (exact-case, per your rules)
        const emailTaken = await withClient(async (db) => {
          const r = await db.query(
            `SELECT 1 FROM public.users WHERE email = $1`,
            [email],
          );
          return r.rowCount > 0;
        });
        if (emailTaken) {
          return res.status(409).json({
            status: false,
            error: "email_taken",
            message: "An account with this email already exists.",
          });
        }

        // Optional username validation + pre-check uniqueness
        let finalUsername = null;
        if (
          username !== undefined &&
          username !== null &&
          `${username}`.trim() !== ""
        ) {
          const uname = `${username}`.trim();
          if (!USERNAME_RE.test(uname)) {
            return res.status(400).json({
              status: false,
              error: "invalid_username",
              message:
                "Username must be 4–12 chars, letters/digits/underscore, at least one letter, start & end with a letter/digit.",
            });
          }
          const unameTaken = await withClient(async (db) => {
            const r = await db.query(
              `SELECT 1 FROM public.users WHERE username = $1`,
              [uname],
            );
            return r.rowCount > 0;
          });
          if (unameTaken) {
            return res.status(400).json({
              status: false,
              error: "username_taken",
              message: "That username is already taken. Please choose another.",
            });
          }
          finalUsername = uname;
        }

        // ---------- 2) Call provider ----------
        const signUpResp = await fetch(
          "https://sjvv8a3ys1.execute-api.us-east-1.amazonaws.com/Dev/newSignUp",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              email,
              password,
              title,
              first_name,
              last_name,
              country,
              api_key:
                "iw56io43dfgh56djka453lskjfhj283jd64hw88djbu3jgldkl705896als54k778d5g",
              telephone,
            }),
          },
        );

        let signUpJson;
        try {
          signUpJson = await signUpResp.json();
        } catch {
          return res.status(502).json({
            status: false,
            error: "bad_gateway",
            message: "Invalid JSON from signup provider",
          });
        }

        // More tolerant success detection:
        // - HTTP 2xx OR statusCode 200/201
        // - prefer body.email; fall back to request email
        const httpOk = signUpResp.ok; // 2xx
        const code = Number(
          signUpJson?.statusCode ?? signUpJson?.status ?? (httpOk ? 200 : 500),
        );
        const providerOk = httpOk || code === 200 || code === 201;

        if (!providerOk) {
          return res.status(400).json({
            status: false,
            error: "signup_failed",
            message:
              signUpJson?.message || "Signup failed with external provider",
            provider: { code, ok: httpOk },
          });
        }

        const apiBody = signUpJson?.body ?? {};
        const providerEmail = apiBody?.email ?? email; // fallback to request email

        // ---------- 3) Save avatar (optional) + Upsert to Postgres ----------
        let avatarUrl = null;
        await withClient(async (db) => {
          if (req.file) {
            await deleteExistingAvatarIfAny(db, providerEmail);
            avatarUrl = await saveNewAvatarAndGetUrl(providerEmail, req.file);
          }

          const fields = [
            "title",
            "first_name",
            "last_name",
            "country",
            "church",
            "user_zone",
            "user_group",
            "christ_embassy_member",
            "avatar_url",
            "phone_number",
            "username",
            "is_profile_public",
          ];

          const payload = {
            title: apiBody.title ?? title ?? null,
            first_name: apiBody.first_name ?? first_name ?? null,
            last_name: apiBody.last_name ?? last_name ?? null,
            country: apiBody.country ?? country ?? null,
            church: null,
            user_zone: null,
            user_group: null,
            christ_embassy_member: null,
            avatar_url: avatarUrl ?? apiBody.avatar_url ?? null,
            phone_number: telephone ?? null,
            username: finalUsername ?? null,
            is_profile_public: true,
          };

          const cols = ["email"].concat(fields);
          const vals = [providerEmail].concat(
            fields.map((f) => (payload[f] === undefined ? null : payload[f])),
          );
          const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
          const updates = fields
            .filter((f) => f !== "username")
            .map((f) => `${f} = EXCLUDED.${f}`)
            .join(", ");

          try {
            const sql = `
            INSERT INTO public.users (${cols.join(",")})
            VALUES (${placeholders})
            ON CONFLICT (email) DO UPDATE SET ${updates}, updated_at = now()
            RETURNING *;
          `;
            const { rows } = await db.query(sql, vals);

            const merged = { ...rows[0], ...apiBody };

            return res.status(201).json({
              status: true,
              data: merged,
              message: signUpJson?.message || "Signup successful",
            });
          } catch (err) {
            if (err?.code === "23505") {
              return res.status(400).json({
                status: false,
                error: "username_taken",
                message:
                  "That username is already taken. Please choose another.",
              });
            }
            throw err;
          }
        });
      } catch (err) {
        return res.status(500).json({
          status: false,
          error: "server_error",
          message: "Unexpected error while processing signup",
        });
      }
    }),
  );

  // --- PATCH user ---
  router.patch(
    "/pcdl/users",
    multerSingleAvatar(upload),
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const { email, token } = b;

      if (!email || !token) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "email and token are required",
        });
      }

      const auth = await verifyUserToken(email, token);
      if (!auth.ok) {
        return res.status(400).json({
          status: false,
          error: "unauthorized",
          message: "token verification failed",
        });
      }

      await withClient(async (db) => {
        // If a new avatar file came in, delete the old and save the new
        let avatarUrl = null;
        if (req.file) {
          await deleteExistingAvatarIfAny(db, email);
          avatarUrl = await saveNewAvatarAndGetUrl(email, req.file);
        }

        // --- username validation + duplicate handling ---
        if (Object.prototype.hasOwnProperty.call(b, "username")) {
          const raw = b.username;

          // Allow clearing with null
          if (raw === null) {
            // ok, clearing is allowed
          } else if (typeof raw === "string") {
            const candidate = raw.trim();
            if (!CODE_RE.test(candidate)) {
              return res.status(400).json({
                status: false,
                error: "invalid_username",
                message:
                  "Username must be 4–12 chars, lowercase, at least one letter, only a–z, 0–9, and underscore.",
              });
            }

            // Pre-check duplicates (exclude current user by email; emails are case-sensitive)
            const taken = await db.query(
              `SELECT 1 FROM public.users WHERE username = $1 AND email <> $2`,
              [candidate, email],
            );
            if (taken.rowCount > 0) {
              return res.status(400).json({
                status: false,
                error: "username_taken",
                message:
                  "That username is already taken. Please choose another.",
              });
            }

            // Write the normalized value back (candidate already lowercase by regex)
            b.username = candidate;
          } else {
            return res.status(400).json({
              status: false,
              error: "invalid_username",
              message: "Username must be a string or null to clear.",
            });
          }
        }
        // --------------------------------------------------

        const fields = [
          "title",
          "first_name",
          "last_name",
          "country",
          "church",
          "user_zone",
          "user_group",
          "christ_embassy_member",
          "avatar_url",
          "phone_number",
          "is_profile_public",
          "username",
        ];

        const sets = [],
          params = [];
        for (const f of fields) {
          if (b[f] !== undefined) {
            params.push(b[f]);
            sets.push(`${f} = $${params.length}`);
          }
        }
        if (avatarUrl) {
          params.push(avatarUrl);
          sets.push(`avatar_url = $${params.length}`);
        }

        if (!sets.length) {
          return res.json({ status: true, message: "nothing to update" });
        }

        params.push(email);

        try {
          const { rows } = await db.query(
            `UPDATE public.users
             SET ${sets.join(", ")}, updated_at = now()
           WHERE email = $${params.length}
           RETURNING *;`,
            params,
          );

          if (!rows[0]) {
            return res.status(400).json({
              status: false,
              error: "not_found",
              message: "user not found",
            });
          }
          return res.json({ status: true, data: rows[0] });
        } catch (err) {
          // Safety for race condition: Postgres unique violation
          if (err?.code === "23505") {
            return res.status(400).json({
              status: false,
              error: "username_taken",
              message: "That username is already taken. Please choose another.",
            });
          }
          // If the old trigger is still present, it may throw P0001 — drop it per step #1
          if (err?.code === "P0001") {
            return res.status(400).json({
              status: false,
              error: "db_error",
              code: "P0001",
              message:
                "A database rule is preventing username changes. Remove the trigger that enforces immutability.",
            });
          }
          throw err;
        }
      });
    }),
  );

  router.get(
    "/pcdl/users",
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
        return res.status(400).json({
          status: false,
          error: "unauthorized",
          message: "token verification failed",
        });

      const row = await withClient(async (db) => {
        const { rows } = await db.query(
          `SELECT * FROM public.users WHERE email = $1 LIMIT 1`,
          [email],
        );
        return rows[0] || null;
      });

      if (!row)
        return res.status(400).json({
          status: false,
          error: "not_found",
          message: "user not found",
        });
      return res.json({ status: true, data: row });
    }),
  );

  router.delete(
    "/pcdl/users",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : req.query;
      const email = (b?.email || "").trim();
      const token = (b?.token || "").trim();
      if (!email || !token) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "email and token are required",
        });
      }

      const auth = await verifyUserToken(email, token);
      if (!auth.ok)
        return res.status(400).json({
          status: false,
          error: "unauthorized",
          message: "token verification failed",
        });

      const deleted = await withClient(async (db) => {
        const r = await db.query(`DELETE FROM public.users WHERE email = $1`, [
          email,
        ]);
        return r.rowCount;
      });

      if (deleted === 0)
        return res.status(400).json({
          status: false,
          error: "not_found",
          message: "nothing deleted",
        });
      return res.json({ status: true, deleted });
    }),
  );

  /**
   * GET /pcdl/users/profile
   * One of:
   *  - ?username=someuser            (public if user made profile public)
   *  - ?email=me&token=...           (owner can always view own profile)
   *  - Optionally both: if both are provided and resolve to same user, allow.
   */
  router.get(
    "/pcdl/users/profile",
    asyncHandler(async (req, res) => {
      const username = (req.query.username || "").trim();
      const emailQ = (req.query.email || "").trim();
      const tokenQ = (req.query.token || "").trim();

      if (!username && !(emailQ && tokenQ)) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "Provide username OR (email+token)",
        });
      }

      // Resolve target (the profile owner) by username OR email
      const profile = await withClient(async (db) => {
        if (username) {
          const r = await db.query(
            `SELECT email, username, is_profile_public
             FROM public.users
            WHERE username = $1
            LIMIT 1`,
            [username],
          );
          return r.rows[0] || null;
        } else {
          const r = await db.query(
            `SELECT email, username, is_profile_public
             FROM public.users
            WHERE email = $1
            LIMIT 1`,
            [emailQ],
          );
          return r.rows[0] || null;
        }
      });

      if (!profile) {
        return res.status(404).json({
          status: false,
          error: "not_found",
          message: "user not found",
        });
      }

      // Determine if requester is the owner
      let requesterIsOwner = false;
      if (emailQ && tokenQ) {
        const auth = await verifyUserToken(emailQ, tokenQ);
        requesterIsOwner = auth.ok && emailQ === profile.email;
      }

      // Privacy gate
      if (!profile.is_profile_public && !requesterIsOwner) {
        return res.status(403).json({
          status: false,
          error: "forbidden",
          message: "This profile is private",
        });
      }

      // Fetch the public/profile payload (same as before, now including is_profile_public)
      const data = await withClient(async (db) => {
        const r = await db.query(
          `WITH base AS (
           SELECT u.email, u.username, u.first_name, u.last_name, u.avatar_url, u.country,
                  u.level, u.xp, u.created_at, u.is_profile_public
             FROM public.users u
            WHERE u.email = $1
           LIMIT 1
         ),
         friends AS (
           SELECT COUNT(*)::int AS cnt
             FROM public.user_friends f
             JOIN base b ON b.email = f.user_email
         ),
         playlists_pub AS (
           SELECT COUNT(*)::int AS cnt
             FROM public.playlists p
             JOIN base b ON b.email = p.owner_email
            WHERE p.is_public = TRUE
         )
         SELECT (SELECT row_to_json(base) FROM base) AS user,
                (SELECT cnt FROM friends) AS friends_count,
                (SELECT cnt FROM playlists_pub) AS playlists_public_count;`,
          [profile.email],
        );
        const row = r.rows[0];
        if (!row || !row.user) return null;

        // If profile is private and requester is not owner, you could also redact fields here.
        return {
          ...row.user,
          friends_count: row.friends_count || 0,
          playlists_public_count: row.playlists_public_count || 0,
        };
      });

      if (!data) {
        return res.status(404).json({
          status: false,
          error: "not_found",
          message: "user not found",
        });
      }

      return res.json({ status: true, data });
    }),
  );

  // ---------------- Gamification ----------------
  // GET profile
  router.get(
    "/pcdl/gamification/profile",
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

      const data = await withClient(async (db) => {
        const { rows } = await db.query(
          `
            SELECT u.email, u.xp, u.level, u.streak_current, u.streak_longest, u.streak_last_at, u.last_activity_at
            FROM public.users u
            WHERE u.email = $1
          `,
          [email],
        );

        const recent = await db.query(
          `
            SELECT action, points, meta, message_id, event_id, created_at
            FROM public.xp_events
            WHERE email = $1
            ORDER BY created_at DESC
            LIMIT 25
          `,
          [email],
        );

        if (!rows.length) return null;
        return { profile: rows[0], recent_events: recent.rows };
      });

      if (!data)
        return res.status(400).json({
          status: false,
          error: "not_found",
          message: "user not found",
        });
      return res.json({ status: true, data });
    }),
  );

  // Levels
  router.get(
    "/pcdl/gamification/levels",
    asyncHandler(async (_req, res) => {
      const levels = await withClient(async (db) => {
        const { rows } = await db.query(
          `SELECT level, xp_required FROM public.gamification_levels ORDER BY level ASC`,
        );
        return rows;
      });
      res.json({ status: true, data: levels });
    }),
  );

  // Award XP (+ streaks, idempotent)
  router.post(
    "/pcdl/gamification/award",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const { email, token, action } = b;
      if (!email || !token || !action) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "email, token, action are required",
        });
      }

      const auth = await verifyUserToken(email, token);
      if (!auth.ok)
        return res.status(400).json({ status: false, error: "unauthorized" });

      const BASE = {
        watch_completed: 30,
        listen_completed: 20,
        event_completed: 100,
        daily_checkin: 5,
      };
      const durationSec = Number(b.duration_seconds ?? 0);
      const durationBonus =
        durationSec > 0 ? Math.min(Math.ceil(durationSec / 600), 6) * 2 : 0; // +2 per 10min (max +12)
      const eventSize = String(b.event_size || "").toLowerCase();
      const EVENT_POINTS_BY_SIZE = { small: 50, medium: 100, large: 150 };
      const eventPointsExplicit =
        b.event_points != null
          ? Math.max(0, Math.min(300, Number(b.event_points)))
          : null;

      const basePoints = (() => {
        switch (action) {
          case "watch_completed":
            return BASE.watch_completed + durationBonus;
          case "listen_completed":
            return BASE.listen_completed + durationBonus;
          case "event_completed":
            return (
              eventPointsExplicit ??
              EVENT_POINTS_BY_SIZE[eventSize] ??
              BASE.event_completed
            );
          case "daily_checkin":
            return BASE.daily_checkin;
          default:
            return 0;
        }
      })();
      if (basePoints <= 0) {
        return res.status(400).json({
          status: false,
          error: "unsupported_action",
          message: `Unknown action: ${action}`,
        });
      }

      const todayStr = new Date().toISOString().slice(0, 10);
      const idempotencyKey =
        (b.idempotency_key && String(b.idempotency_key)) ||
        [email, action, b.message_id || "", b.event_id || "", todayStr].join(
          "|",
        );

      const result = await withClient(async (db) => {
        await db.query("BEGIN");

        const dup = await db.query(
          `SELECT 1 FROM public.xp_events WHERE idempotency_key = $1`,
          [idempotencyKey],
        );
        if (dup.rowCount > 0) {
          await db.query("ROLLBACK");
          return { duplicate: true };
        }

        const ures = await db.query(
          `SELECT email, xp, level, streak_current, streak_longest, streak_last_at
           FROM public.users WHERE email=$1 FOR UPDATE`,
          [email],
        );
        if (ures.rowCount === 0) {
          await db.query("ROLLBACK");
          return { missingUser: true };
        }
        const user = ures.rows[0];

        const today = new Date().toISOString().slice(0, 10);
        const last = user.streak_last_at ? String(user.streak_last_at) : null;
        let streakCurrent = user.streak_current || 0;
        let streakLongest = user.streak_longest || 0;

        let streakIncrementedThisRequest = false;
        if (last !== today) {
          const d = new Date();
          d.setUTCDate(d.getUTCDate() - 1);
          const yesterday = d.toISOString().slice(0, 10);
          if (last === yesterday) {
            streakCurrent += 1;
          } else {
            streakCurrent = 1;
          }
          streakLongest = Math.max(streakLongest, streakCurrent);
          streakIncrementedThisRequest = true;
        }

        const streakBonus = streakIncrementedThisRequest
          ? Math.min(streakCurrent, 10) * 2
          : 0;
        const points = basePoints + streakBonus;

        const meta = {
          ...(b.message_id ? { message_id: b.message_id } : {}),
          ...(b.event_id ? { event_id: b.event_id } : {}),
          ...(durationSec ? { duration_seconds: durationSec } : {}),
          ...(eventSize ? { event_size: eventSize } : {}),
          ...(eventPointsExplicit != null
            ? { event_points_explicit: eventPointsExplicit }
            : {}),
          streak_bonus: streakBonus,
          base_points: basePoints,
        };
        await db.query(
          `INSERT INTO public.xp_events (email, action, points, meta, message_id, event_id, idempotency_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            email,
            action,
            points,
            meta,
            b.message_id || null,
            b.event_id || null,
            idempotencyKey,
          ],
        );

        const newXp = Number(user.xp) + points;
        await db.query(
          `UPDATE public.users
             SET xp = $1,
                 streak_current = $2,
                 streak_longest = $3,
                 streak_last_at = $4,
                 last_activity_at = now()
           WHERE email = $5`,
          [newXp, streakCurrent, streakLongest, today, email],
        );

        const lvl = await db.query(`SELECT public.level_for_xp($1) AS level`, [
          newXp,
        ]);
        const newLevel = Number(lvl.rows[0].level);
        const leveledUp = newLevel !== Number(user.level);

        if (leveledUp) {
          await db.query(
            `UPDATE public.users SET level = $1 WHERE email = $2`,
            [newLevel, email],
          );
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

        await db.query("COMMIT");
        return {
          duplicate: false,
          points_awarded: points,
          base_points: basePoints,
          streak_bonus: streakBonus,
          streak_current: streakCurrent,
          streak_longest: streakLongest,
          level: newLevel,
          leveled_up: leveledUp,
          xp_total: newXp,
          xp_this_level: Math.max(0, newXp - thisLevelXp),
          xp_to_next: Math.max(0, nextLevelXp - newXp),
          next_level: next.rows.length ? Number(next.rows[0].level) : newLevel,
        };
      });

      if (result.duplicate) {
        return res.json({
          status: true,
          duplicate: true,
          message: "idempotent: already recorded",
        });
      }
      if (result.missingUser) {
        return res.status(400).json({
          status: false,
          error: "not_found",
          message: "user not found",
        });
      }

      return res.json({ status: true, action, ...result });
    }),
  );

  // ---------------- Users: avatar upload (uses injected Multer) ----------------

  // ---- Avatar upload (delete old file first, then save new) ----
  router.post(
    "/pcdl/users/avatar",
    // Wrap multer so errors become JSON instead of crashing
    (req, res, next) => {
      const mw = upload.single("avatar");
      mw(req, res, (err) => {
        if (err) {
          return res.status(400).json({
            status: false,
            error: "upload_error",
            message: err.message || "Upload failed",
            code: err.code || undefined,
          });
        }
        next();
      });
    },
    asyncHandler(async (req, res) => {
      const email = (req.body?.email || "").trim();
      const token = (req.body?.token || "").trim();

      // Basic validations
      if (!email || !token) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "email and token are required",
        });
      }
      if (!req.file) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "avatar file is required (field name: avatar)",
        });
      }
      // Extra guard (multer fileFilter should already enforce this)
      const allowed = ["image/jpeg", "image/png", "image/webp"];
      if (!allowed.includes(req.file.mimetype)) {
        return res.status(400).json({
          status: false,
          error: "upload_error",
          message: "Only JPG, PNG, or WEBP images are allowed",
        });
      }

      // Verify user token
      const auth = await verifyUserToken(email, token);
      if (!auth.ok) {
        return res.status(400).json({ status: false, error: "unauthorized" });
      }

      const safeEmail = email.replace(/[^a-zA-Z0-9._-]/g, "_");
      const extFromMime =
        req.file.mimetype === "image/jpeg"
          ? ".jpg"
          : req.file.mimetype === "image/png"
            ? ".png"
            : req.file.mimetype === "image/webp"
              ? ".webp"
              : ".jpg"; // shouldn't hit due to fileFilter
      const filename = `${safeEmail}_${Date.now()}${extFromMime}`;

      // 1) Look up existing avatar_url for this user
      const current = await withClient(async (db) => {
        const { rows } = await db.query(
          `SELECT avatar_url FROM public.users WHERE email = $1 LIMIT 1`,
          [email],
        );
        return rows[0]?.avatar_url || null;
      });

      // 2) If there is an existing avatar, delete the file safely
      if (current && typeof current === "string") {
        // Expecting something like "/uploads/avatars/oldfile.jpg"
        const prefix = "/uploads/avatars/";
        if (current.startsWith(prefix)) {
          const oldName = current.substring(prefix.length); // "oldfile.jpg"
          // Allow only safe filenames
          if (/^[a-zA-Z0-9._-]+$/.test(oldName)) {
            const oldAbs = path.join(AVATAR_DIR, oldName);
            // Defense-in-depth: ensure we stay inside AVATAR_DIR
            if (oldAbs.startsWith(AVATAR_DIR)) {
              try {
                await fs.promises.unlink(oldAbs);
              } catch (_) {
                // ignore if not found / cannot delete
              }
            }
          }
        }
      }

      // 3) Save the new file
      const absPath = path.join(AVATAR_DIR, filename);
      await fs.promises.writeFile(absPath, req.file.buffer);
      const relativeUrl = `/uploads/avatars/${filename}`;

      // 4) Upsert DB with new path
      const userRow = await withClient(async (db) => {
        const { rows } = await db.query(
          `
        INSERT INTO public.users (email, avatar_url)
        VALUES ($1, $2)
        ON CONFLICT (email) DO UPDATE
          SET avatar_url = EXCLUDED.avatar_url,
              updated_at = now()
        RETURNING *;
        `,
          [email, relativeUrl],
        );
        return rows[0];
      });

      return res.json({
        status: true,
        data: {
          email,
          avatar_url: relativeUrl,
          user: userRow,
        },
      });
    }),
  );

  router.get(
    "/pcdl/avatars/:filename",
    asyncHandler(async (req, res) => {
      const { filename } = req.params;

      // simple sanitization: only allow safe filenames
      if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "invalid filename",
        });
      }

      const absPath = path.join(AVATAR_DIR, filename);
      if (!absPath.startsWith(AVATAR_DIR)) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "invalid path",
        });
      }

      if (!fs.existsSync(absPath)) {
        return res.status(404).json({ status: false, error: "not_found" });
      }

      res.setHeader("Cache-Control", "public, max-age=86400"); // 1 day
      return res.sendFile(absPath);
    }),
  );

  /* ========================= PLAYLISTS (MESSAGE-ONLY) ========================= */

  /**
   * Create playlist (owner only, token required)
   * body: { email, token, title, description?, thumbnail_url?, is_public? }
   */
  router.post(
    "/pcdl/playlists",
    multerSingleThumbnail(upload), // <-- add this
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const { email, token, title } = b;
      const description = b.description ?? null;
      const is_public = Boolean(b.is_public ?? false);

      if (!email || !token || !title) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "email, token, title are required",
        });
      }

      const auth = await verifyUserToken(email, token);
      if (!auth.ok)
        return res.status(400).json({ status: false, error: "unauthorized" });

      const row = await withClient(async (db) => {
        // Save thumbnail if uploaded
        let thumbnail_url = null;
        if (req.file) {
          if (!ALLOWED_MIME.has(req.file.mimetype)) {
            return res.status(400).json({
              status: false,
              error: "upload_error",
              message: "Only JPG, PNG, or WEBP images are allowed",
            });
          }
          thumbnail_url = await saveNewPlaylistThumbAndGetUrl(email, req.file);
        } else if (b.thumbnail_url) {
          // Optional: accept direct URL in body if no file
          thumbnail_url = b.thumbnail_url;
        }

        const { rows } = await db.query(
          `
        INSERT INTO public.playlists (owner_email, title, description, thumbnail_url, is_public)
        VALUES ($1,$2,$3,$4,$5)
        RETURNING *;
        `,
          [email, title, description, thumbnail_url, is_public],
        );
        return rows[0];
      });

      return res.status(200).json({ status: true, data: row });
    }),
  );

  /**
   * Get playlist by id
   * - Public: anyone can view
   * - Private: only owner with email+token
   * query optional for private: ?email=&token=
   */
  router.get(
    "/pcdl/playlists/:id",
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const qEmail = (req.query.email || "").trim();
      const qToken = (req.query.token || "").trim();

      const pl = await withClient(async (db) => {
        const { rows } = await db.query(
          `SELECT * FROM public.playlists WHERE id=$1`,
          [id],
        );
        return rows[0] || null;
      });
      if (!pl)
        return res.status(400).json({
          status: false,
          error: "not_found",
          message: "playlist not found",
        });

      if (!pl.is_public) {
        if (!qEmail || !qToken || qEmail !== pl.owner_email) {
          return res.status(400).json({
            status: false,
            error: "forbidden",
            message: "private playlist",
          });
        }
        const auth = await verifyUserToken(qEmail, qToken);
        if (!auth.ok)
          return res.status(400).json({ status: false, error: "unauthorized" });
      }

      const items = await withClient(async (db) => {
        const { rows } = await db.query(
          `
        SELECT
          i.message_id, i.position, i.added_at,
          jsonb_build_object(
            'id', m.id,
            'title', m.title,
            'thumbnail_url', m.thumbnail_url,
            'status', m.status,
            'series_id', m.series_id
          ) AS message
        FROM public.playlist_items i
        LEFT JOIN public.messages m ON m.id = i.message_id
        WHERE i.playlist_id = $1
        ORDER BY COALESCE(i.position, 2147483647) ASC, i.added_at ASC
        `,
          [id],
        );
        return rows;
      });

      return res.json({ status: true, data: { ...pl, items } });
    }),
  );

  /**
   * List playlists for owner (requires email+token)
   * query: ?email=&token=&limit=50&offset=0
   */
  router.get(
    "/pcdl/playlists",
    asyncHandler(async (req, res) => {
      const email = (req.query.email || "").trim();
      const token = (req.query.token || "").trim();
      const limit = Number(req.query.limit ?? 50);
      const offset = Number(req.query.offset ?? 0);

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

      const rows = await withClient(async (db) => {
        const { rows } = await db.query(
          `
        SELECT * FROM public.playlists
        WHERE owner_email = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
        `,
          [email, limit, offset],
        );
        return rows;
      });

      return res.json({ status: true, data: rows, limit, offset });
    }),
  );

  // helpers (once in file)
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(n, hi));
  const intParam = (v, def) => {
    if (v === undefined || v === null || v === "") return def;
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) ? n : def;
  };

  /**
   * POST /pcdl/playlist/query
   *
   * Body (JSON):
   *   // LIST MODE (no id):
   *   {
   *     "scope": "public" | "mine",      // default: "public"
   *     "email": "...",                   // required for scope=mine
   *     "token": "...",                   // required for scope=mine
   *     "q": "search text",               // optional (title/description)
   *     "limit": 50,                      // optional, default 50, max 100
   *     "offset": 0                       // optional, default 0
   *   }
   *
   *   // DETAIL MODE (id present):
   *   {
   *     "id": 123,                        // playlist id (number)
   *     "include_items": true,            // optional, default false
   *     "email": "...",                   // required if playlist is private
   *     "token": "..."                    // required if playlist is private
   *   }
   *
   * Responses:
   *   LIST:   { status: true, data: [ { ...playlist, item_count }, ... ], scope, limit, offset }
   *   DETAIL: { status: true, data: { playlist: { ... , item_count }, items? } }
   */
  router.post(
    "/pcdl/playlist/query",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};

      // ---------------- DETAIL MODE ----------------
      if (b.id !== undefined && b.id !== null && b.id !== "") {
        const id = intParam(b.id, 0);
        if (id <= 0) {
          return res.status(400).json({
            status: false,
            error: "bad_request",
            message: "invalid id",
          });
        }

        // fetch playlist
        const pl = await withClient(async (db) => {
          const r = await db.query(
            `SELECT p.*,
                  COALESCE(pi.cnt, 0)::int AS item_count
             FROM public.playlists p
             LEFT JOIN LATERAL (
               SELECT COUNT(*)::int AS cnt
                 FROM public.playlist_items i
                WHERE i.playlist_id = p.id
             ) pi ON TRUE
            WHERE p.id = $1
            LIMIT 1`,
            [id],
          );
          return r.rows[0] || null;
        });
        if (!pl) {
          return res.status(404).json({
            status: false,
            error: "not_found",
            message: "playlist not found",
          });
        }

        // auth if private
        if (!pl.is_public) {
          const email = (b.email || "").trim();
          const token = (b.token || "").trim();
          if (!email || !token || email !== pl.owner_email) {
            return res.status(403).json({
              status: false,
              error: "forbidden",
              message: "private playlist",
            });
          }
          const auth = await verifyUserToken(email, token);
          if (!auth.ok)
            return res
              .status(401)
              .json({ status: false, error: "unauthorized" });
        }

        // include items?
        if (b.include_items === true) {
          const items = await withClient(async (db) => {
            const r = await db.query(
              `SELECT
               i.message_id,
               i.position,
               i.added_at,
               jsonb_build_object(
                 'id', m.id,
                 'title', m.title,
                 'thumbnail_url', m.thumbnail_url,
                 'status', m.status,
                 'series_id', m.series_id
               ) AS message
             FROM public.playlist_items i
             LEFT JOIN public.messages m ON m.id = i.message_id
            WHERE i.playlist_id = $1
            ORDER BY COALESCE(i.position, 2147483647) ASC, i.added_at ASC`,
              [id],
            );
            return r.rows;
          });
          return res.json({ status: true, data: { playlist: pl, items } });
        }

        return res.json({ status: true, data: { playlist: pl } });
      }

      // ---------------- LIST MODE ----------------
      const LIMIT_DEFAULT = 50;
      const LIMIT_MAX = 100;

      let limit = intParam(b.limit, LIMIT_DEFAULT);
      let offset = intParam(b.offset, 0);
      limit = clamp(limit, 1, LIMIT_MAX);
      offset = Math.max(offset, 0);

      const scope = String(b.scope || "public").toLowerCase();
      const qRaw = (b.q || "").trim();

      // scope=mine requires auth
      let ownerEmail = null;
      if (scope === "mine") {
        const email = (b.email || "").trim();
        const token = (b.token || "").trim();
        if (!email || !token) {
          return res.status(400).json({
            status: false,
            error: "bad_request",
            message: "email and token are required for scope=mine",
          });
        }
        const auth = await verifyUserToken(email, token);
        if (!auth.ok)
          return res.status(401).json({ status: false, error: "unauthorized" });
        ownerEmail = email;
      }

      const rows = await withClient(async (db) => {
        const base = `SELECT p.*,
                COALESCE(pi.cnt, 0)::int AS item_count
           FROM public.playlists p
           LEFT JOIN LATERAL (
             SELECT COUNT(*)::int AS cnt
               FROM public.playlist_items i
              WHERE i.playlist_id = p.id
           ) pi ON TRUE
          WHERE 1=1`;

        const conds = [];
        const params = [];

        if (scope === "mine") {
          params.push(ownerEmail);
          conds.push(`p.owner_email = $${params.length}`);
        } else {
          conds.push(`p.is_public = TRUE`);
        }

        if (qRaw) {
          params.push(qRaw);
          conds.push(
            `(p.title ILIKE '%' || $${params.length} || '%' OR p.description ILIKE '%' || $${params.length} || '%')`,
          );
        }

        params.push(limit);
        const li = params.length;
        params.push(offset);
        const oi = params.length;

        const sql = `${base}
           AND ${conds.join(" AND ")}
         ORDER BY p.created_at DESC
         LIMIT $${li}::int OFFSET $${oi}::int`;

        const r = await db.query(sql, params);
        return r.rows;
      });

      return res.json({
        status: true,
        data: rows,
        scope: scope === "mine" ? "mine" : "public",
        limit,
        offset,
      });
    }),
  );

  /**
   * Update playlist (owner only)
   * body: { email, token, title?, description?, thumbnail_url?, is_public? }
   */
  router.patch(
    "/pcdl/playlists/:id",
    multerSingleThumbnail(upload), // <-- add this
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const { email, token } = b;

      if (!email || !token) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "email and token are required",
        });
      }

      const pl = await withClient(async (db) => {
        const { rows } = await db.query(
          `SELECT * FROM public.playlists WHERE id=$1`,
          [id],
        );
        return rows[0] || null;
      });
      if (!pl)
        return res.status(400).json({
          status: false,
          error: "not_found",
          message: "playlist not found",
        });
      if (pl.owner_email !== email)
        return res.status(400).json({ status: false, error: "forbidden" });

      const auth = await verifyUserToken(email, token);
      if (!auth.ok)
        return res.status(400).json({ status: false, error: "unauthorized" });

      const row = await withClient(async (db) => {
        const fields = ["title", "description", "thumbnail_url", "is_public"];
        const sets = [];
        const params = [];

        // normal scalar fields in body
        for (const f of fields) {
          if (f !== "thumbnail_url" && b[f] !== undefined) {
            params.push(b[f]);
            sets.push(`${f} = $${params.length}`);
          }
        }

        // If a file was uploaded, delete old and set new file path
        if (req.file) {
          if (!ALLOWED_MIME.has(req.file.mimetype)) {
            return res.status(400).json({
              status: false,
              error: "upload_error",
              message: "Only JPG, PNG, or WEBP images are allowed",
            });
          }
          await deleteExistingPlaylistThumbIfAny(db, id);
          const newUrl = await saveNewPlaylistThumbAndGetUrl(email, req.file);
          params.push(newUrl);
          sets.push(`thumbnail_url = $${params.length}`);
        } else if (b.thumbnail_url !== undefined) {
          // If client explicitly wants to set/remove URL (no file)
          params.push(b.thumbnail_url);
          sets.push(`thumbnail_url = $${params.length}`);
        }

        if (!sets.length) {
          // nothing to change
          const { rows } = await db.query(
            `SELECT * FROM public.playlists WHERE id=$1`,
            [id],
          );
          return rows[0];
        }

        params.push(id);
        const { rows } = await db.query(
          `UPDATE public.playlists SET ${sets.join(
            ", ",
          )}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
          params,
        );
        return rows[0] || null;
      });

      return res.json({ status: true, data: row });
    }),
  );

  /**
   * Delete playlist (owner only)
   * body or query: { email, token }
   */
  router.delete(
    "/pcdl/playlists",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : req.query;
      const id = Number(b.id);
      const email = (b?.email || "").trim();
      const token = (b?.token || "").trim();

      if (!email || !token) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "email and token are required",
        });
      }

      const pl = await withClient(async (db) => {
        const { rows } = await db.query(
          `SELECT owner_email FROM public.playlists WHERE id=$1`,
          [id],
        );
        return rows[0] || null;
      });
      if (!pl)
        return res.status(400).json({
          status: false,
          error: "not_found",
          message: "playlist not found",
        });
      if (pl.owner_email !== email)
        return res.status(400).json({ status: false, error: "forbidden" });

      const auth = await verifyUserToken(email, token);
      if (!auth.ok)
        return res.status(400).json({ status: false, error: "unauthorized" });

      const deleted = await withClient(async (db) => {
        const r = await db.query(`DELETE FROM public.playlists WHERE id=$1`, [
          id,
        ]);
        return r.rowCount;
      });

      if (deleted === 0)
        return res.status(400).json({
          status: false,
          error: "not_found",
          message: "nothing deleted",
        });
      return res.json({ status: true, deleted });
    }),
  );

  /* ---------- Playlist Items (message-only) ---------- */

  /**
   * Add messages to a playlist (owner only)
   * body: { email, token, message_ids: [ "msg1", "msg2", ... ], position? }
   * - Duplicates ignored
   */
  router.post(
    "/pcdl/playlists/:id/items",
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const { email, token, message_ids } = b;
      const position = b.position ?? null; // optional default position for all

      if (
        !email ||
        !token ||
        !Array.isArray(message_ids) ||
        message_ids.length === 0
      ) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "email, token, message_ids[] required",
        });
      }

      const pl = await withClient(async (db) => {
        const { rows } = await db.query(
          `SELECT owner_email FROM public.playlists WHERE id=$1`,
          [id],
        );
        return rows[0] || null;
      });
      if (!pl)
        return res.status(400).json({
          status: false,
          error: "not_found",
          message: "playlist not found",
        });
      if (pl.owner_email !== email)
        return res.status(400).json({ status: false, error: "forbidden" });

      const auth = await verifyUserToken(email, token);
      if (!auth.ok)
        return res.status(400).json({ status: false, error: "unauthorized" });

      const added = await withClient(async (db) => {
        let cnt = 0;
        for (const mid of message_ids) {
          if (!mid) continue;
          await db.query(
            `INSERT INTO public.playlist_items (playlist_id, message_id, position)
           VALUES ($1,$2,$3)
           ON CONFLICT (playlist_id, message_id) DO NOTHING`,
            [id, mid, position],
          );
          cnt++;
        }
        return cnt;
      });

      return res.status(200).json({ status: true, added });
    }),
  );

  /**
   * Remove a message from playlist (owner only)
   * body or query: { email, token, message_id }
   */
  router.delete(
    "/pcdl/playlists/items",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : req.query;
      const email = (b?.email || "").trim();
      const token = (b?.token || "").trim();
      const id = (b?.id || "").trim();
      const message_id = b?.message_id;

      if (!email || !token || !message_id) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "email, token, message_id required",
        });
      }

      const pl = await withClient(async (db) => {
        const { rows } = await db.query(
          `SELECT owner_email FROM public.playlists WHERE id=$1`,
          [id],
        );
        return rows[0] || null;
      });
      if (!pl)
        return res.status(400).json({
          status: false,
          error: "not_found",
          message: "playlist not found",
        });
      if (pl.owner_email !== email)
        return res.status(400).json({ status: false, error: "forbidden" });

      const auth = await verifyUserToken(email, token);
      if (!auth.ok)
        return res.status(400).json({ status: false, error: "unauthorized" });

      const deleted = await withClient(async (db) => {
        const r = await db.query(
          `DELETE FROM public.playlist_items WHERE playlist_id=$1 AND message_id=$2`,
          [id, message_id],
        );
        return r.rowCount;
      });

      if (deleted === 0)
        return res.status(400).json({
          status: false,
          error: "not_found",
          message: "nothing deleted",
        });
      return res.json({ status: true, deleted });
    }),
  );

  /**
   * Reorder messages (owner only)
   * body: { email, token, updates: [{ message_id, position }, ...] }
   */
  router.patch(
    "/pcdl/playlists/items/reorder",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const { id, email, token, updates } = b;

      if (!email || !token || !Array.isArray(updates) || !updates.length) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "email, token, updates[] required",
        });
      }

      const pl = await withClient(async (db) => {
        const { rows } = await db.query(
          `SELECT owner_email FROM public.playlists WHERE id=$1`,
          [id],
        );
        return rows[0] || null;
      });
      if (!pl)
        return res.status(400).json({
          status: false,
          error: "not_found",
          message: "playlist not found",
        });
      if (pl.owner_email !== email)
        return res.status(400).json({ status: false, error: "forbidden" });

      const auth = await verifyUserToken(email, token);
      if (!auth.ok)
        return res.status(400).json({ status: false, error: "unauthorized" });

      const changed = await withClient(async (db) => {
        let cnt = 0;
        for (const u of updates) {
          if (!u || u.message_id === undefined || u.position === undefined)
            continue;
          const r = await db.query(
            `UPDATE public.playlist_items SET position=$1 WHERE playlist_id=$2 AND message_id=$3`,
            [u.position, id, u.message_id],
          );
          cnt += r.rowCount;
        }
        return cnt;
      });

      return res.json({ status: true, updated: changed });
    }),
  );

  /* ---------- Follow / Unfollow public playlists ---------- */

  /**
   * POST /pcdl/playlists/follow
   * Body JSON: { email, token, playlist_id, state? }
   *
   * - If `state` is omitted → TOGGLE (follow if not following, else unfollow)
   * - If `state` is true/false → SET that state idempotently
   * - Private playlists cannot be followed unless owner
   * Response: { status:true, playlist_id, followed:<bool>, changed:<bool> }
   */
  router.post(
    "/pcdl/playlists/follow",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const email = (b.email || "").trim();
      const token = (b.token || "").trim();
      const playlist_id = Number(b.playlist_id);
      const hasState = Object.prototype.hasOwnProperty.call(b, "state");
      const desired = hasState ? Boolean(b.state) : null; // null = toggle

      if (!email || !token || !Number.isFinite(playlist_id)) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "email, token and numeric playlist_id are required",
        });
      }

      // auth
      const auth = await verifyUserToken(email, token);
      if (!auth.ok)
        return res.status(400).json({ status: false, error: "unauthorized" });

      // fetch playlist for visibility rules
      const pl = await withClient(async (db) => {
        const r = await db.query(
          `SELECT owner_email, is_public
           FROM public.playlists
          WHERE id = $1`,
          [playlist_id],
        );
        return r.rows[0] || null;
      });
      if (!pl) {
        return res.status(400).json({
          status: false,
          error: "not_found",
          message: "playlist not found",
        });
      }
      if (!pl.is_public && pl.owner_email !== email) {
        return res.status(400).json({
          status: false,
          error: "forbidden",
          message: "cannot follow a private playlist you do not own",
        });
      }

      // current follow status
      const currentlyFollowing = await withClient(async (db) => {
        const r = await db.query(
          `SELECT 1 FROM public.playlist_follows WHERE email=$1 AND playlist_id=$2`,
          [email, playlist_id],
        );
        return r.rowCount > 0;
      });

      // decide target state
      const targetFollow = hasState ? desired : !currentlyFollowing;

      // no-op?
      if (targetFollow === currentlyFollowing) {
        return res.json({
          status: true,
          playlist_id,
          followed: currentlyFollowing,
          changed: false,
        });
      }

      // apply change
      const changed = await withClient(async (db) => {
        if (targetFollow) {
          await db.query(
            `INSERT INTO public.playlist_follows (email, playlist_id)
           VALUES ($1,$2)
           ON CONFLICT (email, playlist_id) DO NOTHING`,
            [email, playlist_id],
          );
          return true;
        } else {
          const r = await db.query(
            `DELETE FROM public.playlist_follows WHERE email=$1 AND playlist_id=$2`,
            [email, playlist_id],
          );
          return r.rowCount > 0;
        }
      });

      return res.status(200).json({
        status: true,
        playlist_id,
        followed: targetFollow,
        changed,
      });
    }),
  );

  /**
   * List playlists the user follows (requires email+token)
   * query: ?email=&token=&limit=&offset=
   */
  router.get(
    "/pcdl/playlists/following",
    asyncHandler(async (req, res) => {
      const email = (req.query.email || "").trim();
      const token = (req.query.token || "").trim();
      const limit = Number(req.query.limit ?? 50);
      const offset = Number(req.query.offset ?? 0);

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

      const rows = await withClient(async (db) => {
        const { rows } = await db.query(
          `
        SELECT p.*
        FROM public.playlist_follows f
        JOIN public.playlists p ON p.id = f.playlist_id
        WHERE f.email = $1
        ORDER BY f.followed_at DESC
        LIMIT $2 OFFSET $3
        `,
          [email, limit, offset],
        );
        return rows;
      });

      return res.json({ status: true, data: rows, limit, offset });
    }),
  );

  /**
   * POST /pcdl/users/friends/add
   * Body: { email, token, friend_username }
   */
  router.post(
    "/pcdl/users/friends/add",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const email = (b.email || "").trim();
      const token = (b.token || "").trim();
      const friendUsername = (b.friend_username || "").trim();

      if (!email || !token || !friendUsername) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "email, token, friend_username are required",
        });
      }

      const auth = await verifyUserToken(email, token);
      if (!auth.ok)
        return res.status(400).json({ status: false, error: "unauthorized" });

      const result = await withClient(async (db) => {
        // Find friend by username
        const friend = await db.query(
          `SELECT email FROM public.users WHERE username = $1`,
          [friendUsername],
        );
        if (friend.rowCount === 0) {
          return { error: "friend_not_found" };
        }
        const friendEmail = friend.rows[0].email;
        if (friendEmail === email) {
          return { error: "cannot_friend_self" };
        }

        // Insert both directions (idempotent)
        await db.query(
          `INSERT INTO public.user_friends (user_email, friend_email)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [email, friendEmail],
        );
        await db.query(
          `INSERT INTO public.user_friends (user_email, friend_email)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [friendEmail, email],
        );

        return { ok: true, friend_email: friendEmail };
      });

      if (result.error === "friend_not_found") {
        return res.status(400).json({
          status: false,
          error: "not_found",
          message: "friend username not found",
        });
      }
      if (result.error === "cannot_friend_self") {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "cannot add yourself",
        });
      }

      return res.status(200).json({ status: true, added: true });
    }),
  );

  /**
   * DELETE /pcdl/users/friends/remove
   * Body or Query: { email, token, friend_username }
   */
  router.delete(
    "/pcdl/users/friends/remove",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : req.query;
      const email = (b.email || "").trim();
      const token = (b.token || "").trim();
      const friendUsername = (b.friend_username || "").trim();

      if (!email || !token || !friendUsername) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "email, token, friend_username are required",
        });
      }

      const auth = await verifyUserToken(email, token);
      if (!auth.ok)
        return res.status(400).json({ status: false, error: "unauthorized" });

      const deleted = await withClient(async (db) => {
        const f = await db.query(
          `SELECT email FROM public.users WHERE username = $1`,
          [friendUsername],
        );
        if (f.rowCount === 0) return { missing: true };

        const friendEmail = f.rows[0].email;

        const r1 = await db.query(
          `DELETE FROM public.user_friends WHERE user_email = $1 AND friend_email = $2`,
          [email, friendEmail],
        );
        const r2 = await db.query(
          `DELETE FROM public.user_friends WHERE user_email = $1 AND friend_email = $2`,
          [friendEmail, email],
        );
        return { count: r1.rowCount + r2.rowCount };
      });

      if (deleted.missing) {
        return res.status(400).json({
          status: false,
          error: "not_found",
          message: "friend username not found",
        });
      }

      return res.json({ status: true, deleted: deleted.count });
    }),
  );

  /**
   * GET /pcdl/users/friends
   * Query: (?username=foo) OR (email+token for self)
   * Supports pagination
   */
  router.get(
    "/pcdl/users/friends",
    asyncHandler(async (req, res) => {
      const username = (req.query.username || "").trim();
      const emailQ = (req.query.email || "").trim();
      const tokenQ = (req.query.token || "").trim();

      const LIMIT_DEFAULT = 50;
      const LIMIT_MAX = 100;
      const intParam = (v, d) => {
        if (v === undefined || v === null || v === "") return d;
        const n = parseInt(String(v), 10);
        return Number.isFinite(n) ? n : d;
      };
      const clamp = (n, lo, hi) => Math.max(lo, Math.min(n, hi));

      let limit = clamp(intParam(req.query.limit, LIMIT_DEFAULT), 1, LIMIT_MAX);
      let offset = Math.max(intParam(req.query.offset, 0), 0);

      let ownerEmail = null;

      if (username) {
        const row = await withClient(async (db) => {
          const r = await db.query(
            `SELECT email FROM public.users WHERE username = $1`,
            [username],
          );
          return r.rows[0] || null;
        });
        if (!row)
          return res.status(404).json({
            status: false,
            error: "not_found",
            message: "user not found",
          });
        ownerEmail = row.email;
      } else {
        if (!emailQ || !tokenQ) {
          return res.status(400).json({
            status: false,
            error: "bad_request",
            message: "username OR (email+token) required",
          });
        }
        const auth = await verifyUserToken(emailQ, tokenQ);
        if (!auth.ok)
          return res.status(400).json({ status: false, error: "unauthorized" });
        ownerEmail = emailQ;
      }

      const friends = await withClient(async (db) => {
        const r = await db.query(
          `SELECT u.email, u.username, u.first_name, u.last_name, u.avatar_url, u.country, u.level, u.xp,
           FROM public.user_friends f
           JOIN public.users u ON u.email = f.friend_email
          WHERE f.user_email = $1
          ORDER BY u.username NULLS LAST, u.first_name NULLS LAST
          LIMIT $2::int OFFSET $3::int`,
          [ownerEmail, limit, offset],
        );
        return r.rows;
      });

      return res.json({ status: true, data: friends, limit, offset });
    }),
  );

  /**
   * (A) POST /pcdl/users/friends
   * body:
   *  - EITHER: { username }
   *  - OR:     { email, token }  // to view your own friends even if private
   *  - optional: { limit?, offset?, q? }  // q filters friends by name/username/email
   * Returns: { data: [...friends], total, limit, offset, owner }
   */
  router.post(
    "/pcdl/users/friends",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const username = (b.username || "").trim();
      const emailQ = (b.email || "").trim();
      const tokenQ = (b.token || "").trim();
      const q = (b.q || "").trim();

      const LIMIT_DEFAULT = 50,
        LIMIT_MAX = 100;
      let limit = clamp(intParam(b.limit, LIMIT_DEFAULT), 1, LIMIT_MAX);
      let offset = Math.max(intParam(b.offset, 0), 0);

      let ownerEmail = null;
      let ownerIsPublic = true;

      if (username) {
        const owner = await withClient(async (db) => {
          const r = await db.query(
            `SELECT email, is_profile_public
             FROM public.users
            WHERE username = $1`,
            [username],
          );
          return r.rows[0] || null;
        });
        if (!owner)
          return res.status(404).json({
            status: false,
            error: "not_found",
            message: "user not found",
          });

        ownerEmail = owner.email;
        ownerIsPublic = owner.is_profile_public !== false; // default public if null
        if (!ownerIsPublic) {
          return res.status(403).json({
            status: false,
            error: "forbidden",
            message: "profile is private",
          });
        }
      } else {
        // self-view requires auth
        if (!emailQ || !tokenQ) {
          return res.status(400).json({
            status: false,
            error: "bad_request",
            message: "Provide username OR (email + token)",
          });
        }
        const auth = await verifyUserToken(emailQ, tokenQ);
        if (!auth.ok)
          return res.status(400).json({ status: false, error: "unauthorized" });
        ownerEmail = emailQ;
      }

      // build optional search filter across friend fields
      const params = [ownerEmail, limit, offset];
      let whereExtra = "";
      if (q) {
        params.push(`%${q}%`);
        whereExtra = `
        AND (
          u.username   ILIKE $${params.length}
          OR u.first_name ILIKE $${params.length}
          OR u.last_name  ILIKE $${params.length}
          OR u.email      ILIKE $${params.length}
        )
      `;
      }

      const rows = await withClient(async (db) => {
        const r = await db.query(
          `
          SELECT
            u.username,
            u.avatar_url,
            u.country,
            u.level,
            u.xp,
            COUNT(*) OVER() AS total
          FROM public.user_friends f
          JOIN public.users u ON u.email = f.friend_email
          WHERE f.user_email = $1
          ${whereExtra}
          ORDER BY u.username NULLS LAST, u.first_name NULLS LAST, u.last_name NULLS LAST
          LIMIT $2::int OFFSET $3::int
        `,
          params,
        );
        return r.rows;
      });

      const total = rows[0]?.total ? Number(rows[0].total) : 0;

      return res.json({
        status: true,
        data: rows.map(({ total: _t, ...r }) => r),
        total,
        limit,
        offset,
        owner: {
          email: ownerEmail,
          username: username || null,
          public: ownerIsPublic,
        },
        q: q || null,
      });
    }),
  );

  /**
   * (B) POST /pcdl/users/search
   * body: { q, limit?, offset? }
   * - Searches PUBLIC profiles only (profile_public = true OR NULL)
   * - Matches username, first_name, last_name, and email
   * Returns: { data, total, limit, offset, q }
   */
  router.post(
    "/pcdl/users/search",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const q = (b.q || "").trim();

      const LIMIT_DEFAULT = 50,
        LIMIT_MAX = 100;
      let limit = clamp(intParam(b.limit, LIMIT_DEFAULT), 1, LIMIT_MAX);
      let offset = Math.max(intParam(b.offset, 0), 0);

      if (!q) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "q is required",
        });
      }

      const like = `%${q}%`;
      const rows = await withClient(async (db) => {
        const r = await db.query(
          `
          SELECT
            u.username,
            u.avatar_url,
            u.country,
            COUNT(*) OVER() AS total
          FROM public.users u
          WHERE (u.is_profile_public IS DISTINCT FROM FALSE)
            AND (
              u.username   ILIKE $1
              OR u.first_name ILIKE $1
              OR u.last_name  ILIKE $1
              OR u.email      ILIKE $1
            )
          ORDER BY
            (CASE WHEN u.username ILIKE $1 THEN 0 ELSE 1 END),
            u.username NULLS LAST,
            u.first_name NULLS LAST,
            u.last_name NULLS LAST
          LIMIT $2::int OFFSET $3::int
        `,
          [like, limit, offset],
        );
        return r.rows;
      });

      const total = rows[0]?.total ? Number(rows[0].total) : 0;

      return res.json({
        status: true,
        data: rows.map(({ total: _t, ...r }) => r),
        total,
        limit,
        offset,
        q,
      });
    }),
  );

  /**
   * (C) POST /pcdl/users/by-username
   * body: { username, viewer_email?, viewer_token? }
   * - If profile is public -> return basic profile
   * - If profile is private -> only return if viewer matches and token verifies
   * Returns: { data } or 403 if private
   */
  router.post(
    "/pcdl/users/by-username",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const username = (b.username || "").trim();
      const viewerEmail = (b.viewer_email || "").trim();
      const viewerToken = (b.viewer_token || "").trim();

      if (!username) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "username is required",
        });
      }

      const user = await withClient(async (db) => {
        const r = await db.query(
          `SELECT username, avatar_url, country, level, xp, is_profile_public
           FROM public.users
          WHERE username = $1`,
          [username],
        );
        return r.rows[0] || null;
      });

      if (!user) {
        return res.status(404).json({
          status: false,
          error: "not_found",
          message: "user not found",
        });
      }

      const isPublic = user.is_profile_public !== false;

      if (!isPublic) {
        // allow only if viewer is the same user and token is valid
        if (!viewerEmail || !viewerToken || viewerEmail !== user.email) {
          return res.status(403).json({
            status: false,
            error: "forbidden",
            message: "profile is private",
          });
        }
        const auth = await verifyUserToken(viewerEmail, viewerToken);
        if (!auth.ok)
          return res.status(400).json({ status: false, error: "unauthorized" });
      }

      // You can redact email for public views if desired:
      const result = { ...user };
      if (isPublic && viewerEmail !== user.email) {
        // Example: hide email for public viewers
        // delete result.email;
      }

      return res.json({ status: true, data: result });
    }),
  );

  /**
   * Upsert progress for a message (records history, powers resume)
   * POST /pcdl/history
   * body: {
   *   email, token, message_id,
   *   media: "video"|"audio",
   *   position_seconds,          // >= 0
   *   duration_seconds?,         // optional but recommended
   *   mark_completed?            // optional true to force completed
   * }
   */
  router.post(
    "/pcdl/history",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const email = (b.email || "").trim();
      const token = (b.token || "").trim();
      const message_id = (b.message_id || "").trim();
      const media = String(b.media || "").toLowerCase();
      const pos = Math.max(0, intParam(b.position_seconds, 0));
      const dur =
        b.duration_seconds == null
          ? null
          : Math.max(0, intParam(b.duration_seconds, 0));
      const forceDone = Boolean(b.mark_completed);

      if (
        !email ||
        !token ||
        !message_id ||
        !["video", "audio"].includes(media)
      ) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message:
            "email, token, message_id, media('video'|'audio') and position_seconds are required",
        });
      }

      const auth = await verifyUserToken(email, token);
      if (!auth.ok)
        return res.status(400).json({ status: false, error: "unauthorized" });

      const data = await withClient(async (db) => {
        // compute completion based on either force or 90% rule
        // if no duration yet, we won't auto-complete unless force is true
        let completedFlag = false;
        let completedAt = null;

        if (forceDone) {
          completedFlag = true;
          completedAt = new Date().toISOString();
        } else if (dur && dur > 0 && pos / dur >= 0.9) {
          completedFlag = true;
          completedAt = new Date().toISOString();
        }

        const { rows } = await db.query(
          `
        INSERT INTO public.watch_history
          (email, message_id, media_type, last_position_seconds, duration_seconds, completed, updated_at, started_at, completed_at)
        VALUES
          ($1, $2, $3, $4, $5, $6, now(),
           COALESCE(
             (SELECT started_at FROM public.watch_history WHERE email=$1 AND message_id=$2 AND media_type=$3),
             now()
           ),
           CASE WHEN $6 THEN now() ELSE
             (SELECT completed_at FROM public.watch_history WHERE email=$1 AND message_id=$2 AND media_type=$3)
           END
          )
        ON CONFLICT (email, message_id, media_type)
        DO UPDATE SET
          last_position_seconds = EXCLUDED.last_position_seconds,
          duration_seconds      = COALESCE(EXCLUDED.duration_seconds, public.watch_history.duration_seconds),
          completed             = EXCLUDED.completed OR public.watch_history.completed,
          updated_at            = now(),
          completed_at          = CASE
                                    WHEN EXCLUDED.completed AND public.watch_history.completed = FALSE
                                    THEN now()
                                    ELSE public.watch_history.completed_at
                                  END
        RETURNING *;
        `,
          [email, message_id, media, pos, dur, completedFlag],
        );
        return rows[0];
      });

      return res.status(201).json({ status: true, data });
    }),
  );

  /**
   * Get recent watch history (all items; completed or not)
   * POST /pcdl/history/list
   * body: { email, token, limit?, offset? }
   * returns recent items with joined message fields + total
   */
  router.post(
    "/pcdl/history/list",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const email = (b.email || "").trim();
      const token = (b.token || "").trim();

      const LIMIT_DEFAULT = 50,
        LIMIT_MAX = 100;
      let limit = clamp(intParam(b.limit, LIMIT_DEFAULT), 1, LIMIT_MAX);
      let offset = Math.max(intParam(b.offset, 0), 0);

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

      const rows = await withClient(async (db) => {
        const r = await db.query(
          `
        SELECT
          h.*,
          m.title,
          m.description,
          m.thumbnail_url,
          m.series_id,
          COUNT(*) OVER() AS total
        FROM public.watch_history h
        LEFT JOIN public.messages m ON m.id = h.message_id
        WHERE h.email = $1
        ORDER BY h.updated_at DESC
        LIMIT $2::int OFFSET $3::int
        `,
          [email, limit, offset],
        );
        return r.rows;
      });

      const total = rows[0]?.total ? Number(rows[0].total) : 0;
      const data = rows.map(({ total: _t, ...r }) => r);

      return res.json({ status: true, data, total, limit, offset });
    }),
  );

  /**
   * Get "resume watching" (watch later) — items not completed with progress > 0
   * POST /pcdl/history/resume
   * body: { email, token, limit?, offset? }
   */
  router.post(
    "/pcdl/history/resume",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const email = (b.email || "").trim();
      const token = (b.token || "").trim();

      const LIMIT_DEFAULT = 50,
        LIMIT_MAX = 100;
      let limit = clamp(intParam(b.limit, LIMIT_DEFAULT), 1, LIMIT_MAX);
      let offset = Math.max(intParam(b.offset, 0), 0);

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

      const rows = await withClient(async (db) => {
        const r = await db.query(
          `
        SELECT
          h.*,
          m.title,
          m.thumbnail_url,
          m.series_id,
          COUNT(*) OVER() AS total
        FROM public.watch_history h
        LEFT JOIN public.messages m ON m.id = h.message_id
        WHERE h.email = $1
          AND h.completed = FALSE
          AND h.last_position_seconds > 0
        ORDER BY h.updated_at DESC
        LIMIT $2::int OFFSET $3::int
        `,
          [email, limit, offset],
        );
        return r.rows;
      });

      const total = rows[0]?.total ? Number(rows[0].total) : 0;
      const data = rows.map(({ total: _t, ...r }) => r);

      return res.json({ status: true, data, total, limit, offset });
    }),
  );

  /**
   * Clear a single item from history (or "watch later")
   * DELETE /pcdl/history/item
   * body: { email, token, message_id, media }
   */
  router.delete(
    "/pcdl/history/item",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const email = (b.email || "").trim();
      const token = (b.token || "").trim();
      const message_id = (b.message_id || "").trim();
      const media = String(b.media || "").toLowerCase();

      if (
        !email ||
        !token ||
        !message_id ||
        !["video", "audio"].includes(media)
      ) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message:
            "email, token, message_id, and media('video'|'audio') are required",
        });
      }
      const auth = await verifyUserToken(email, token);
      if (!auth.ok)
        return res.status(400).json({ status: false, error: "unauthorized" });

      const deleted = await withClient(async (db) => {
        const r = await db.query(
          `DELETE FROM public.watch_history WHERE email=$1 AND message_id=$2 AND media_type=$3`,
          [email, message_id, media],
        );
        return r.rowCount;
      });

      if (deleted === 0) {
        return res.status(400).json({
          status: false,
          error: "not_found",
          message: "nothing deleted",
        });
      }
      return res.json({ status: true, deleted });
    }),
  );

  /**
   * Clear ALL history
   * DELETE /pcdl/history/clear
   * body: { email, token }
   */
  router.delete(
    "/pcdl/history/clear",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const email = (b.email || "").trim();
      const token = (b.token || "").trim();

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

      const deleted = await withClient(async (db) => {
        const r = await db.query(
          `DELETE FROM public.watch_history WHERE email=$1`,
          [email],
        );
        return r.rowCount;
      });

      return res.json({ status: true, deleted });
    }),
  );

  router.post(
    "/pcdl/admin/lists",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const { errors, id, title, type, items, position } =
        validateAdminListPayload(b);
      if (errors.length)
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: errors.join("; "),
        });

      const row = await withClient(async (db) => {
        const { rows } = await db.query(
          `INSERT INTO public.admin_lists (id, title, type, items, position, updated_at)
   VALUES ($1, $2, $3, $4::jsonb, $5, now())
   ON CONFLICT (id)
   DO UPDATE SET title    = EXCLUDED.title,
                 type     = EXCLUDED.type,
                 items    = EXCLUDED.items,
                 position = COALESCE(EXCLUDED.position, public.admin_lists.position),
                 updated_at = now()
   RETURNING *;`,
          [id, title, type, JSON.stringify(items), position],
        );

        return rows[0];
      });

      return res.status(201).json({ status: true, data: row });
    }),
  );

  // --- External “list” sections --------------------------------------------------
  async function fetchSodlSection() {
    try {
      const resp = await axios.get(
        "https://sjvv8a3ys1.execute-api.us-east-1.amazonaws.com/Dev/getSchoolOfDivineLife",
        { timeout: 8000 },
      );
      const payload = (resp?.data?.courses || []).filter(
        (c) => String(c.active) === "true",
      );
      return {
        id: "sodl",
        title: "School of Divine Life",
        type: "items",
        position: null,
        payload,
        count: payload.length,
      };
    } catch (e) {
      return {
        id: "sodl",
        title: "School of Divine Life",
        type: "items",
        position: null,
        payload: [],
        count: 0,
        error: { message: e?.message || "sodl_fetch_failed" },
      };
    }
  }

  function mapKidsItem(item) {
    return {
      id: item?.id ?? null,
      title: item?.name ?? null,
      thumbnail: item?.image ?? null,
    };
  }

  async function fetchPCDL4KidsSection() {
    try {
      const resp = await axios.get(
        "https://pcdl4kids.com/portal/api/recent?user_id=4",
        {
          timeout: 8000,
          headers: {
            Authorization: "Bearer EAACva1Mk73MBAPCKAhIAxF01sWkiFYAwcViL6MXEi",
          },
        },
      );
      const ok = !!resp?.data?.status;
      const raw = ok ? resp.data.data || [] : [];
      const payload = raw.map(mapKidsItem).filter((x) => x.id && x.title);
      return {
        id: "pcdl4kids",
        title: "PCDL4Kids",
        type: "items",
        position: null,
        payload,
        count: payload.length,
      };
    } catch (e) {
      return {
        id: "pcdl4kids",
        title: "PCDL4Kids",
        type: "items",
        position: null,
        payload: [],
        count: 0,
        error: { message: e?.message || "pcdl4kids_fetch_failed" },
      };
    }
  }

  // --- the homepage route -------------------------------------------------------
  router.post(
    "/pcdl/homepage",
    asyncHandler(async (_req, res) => {
      // ---- fixed inputs (no body usage) ----
      const INPUTS = {
        section_ids: [
          "languages",
          "newreleases",
          "sodl",
          "yourloveworld",
          "everydaysolutions",
          "faith",
          "gcs",
          "gdop",
          "holyspirit",
          "hs_messages",
          "inchrist",
          "jesus",
          "motw",
          "moty",
          "prayers",
          "testimony",
          "thewordworks",
          "weekend",
          "documentary",
        ],
        order: [
          "sodl",
          "yourloveworld",
          "languages",
          "newreleases",
          "motw",
          "everydaysolutions",
          "testimony",
          "documentary",
          "gdop",
          "gcs",
          "holyspirit",
          "faith",
          "hs_messages",
          "inchrist",
          "jesus",
          "moty",
          "prayers",
          "thewordworks",
          "weekend",
        ],
        per_section_limit: 12,
      };

      // ---- constants/helpers ----
      const LIMIT_PER_SECTION_DEFAULT = 15;
      const LIMIT_PER_SECTION_MAX = 30;
      const clamp = (n, lo, hi) => Math.max(lo, Math.min(n, hi));

      const perLimit = clamp(
        Number.isFinite(INPUTS.per_section_limit)
          ? INPUTS.per_section_limit
          : LIMIT_PER_SECTION_DEFAULT,
        1,
        LIMIT_PER_SECTION_MAX,
      );

      const onlyIds =
        Array.isArray(INPUTS.section_ids) && INPUTS.section_ids.length
          ? new Set(INPUTS.section_ids.map(String))
          : null;

      // Ensure hero sorts first
      const ORDER_FIRST = ["homepage_hero"];
      const baseOrder = Array.isArray(INPUTS.order)
        ? INPUTS.order.map(String)
        : [];
      const orderIds = [
        ...ORDER_FIRST,
        ...baseOrder.filter((id) => !ORDER_FIRST.includes(id)),
      ];

      const includeCounts = true;

      // 1) load admin lists
      const adminRows = await withClient(async (db) => {
        const r = await db.query(
          `SELECT id, title, type, position, items
         FROM public.admin_lists
         ORDER BY position ASC NULLS LAST, title ASC`,
        );
        return r.rows || [];
      });

      const rowToSection = (row) => ({
        id: row.id,
        title: row.title,
        type: row.type,
        position: row.position,
        payload: row.items || [],
        meta: { source: "admin_lists" },
      });

      let sections = adminRows.map(rowToSection);
      if (onlyIds) sections = sections.filter((s) => onlyIds.has(s.id));

      const dbIndex = new Map(adminRows.map((r) => [r.id, r]));

      // 2) computed Your Loveworld
      const ylwSection = await withClient(async (db) => {
        const payload = await fetchYourLoveWorldMessages(db, perLimit);
        return {
          id: "yourloveworld",
          title: "Your Loveworld Specials",
          type: "messages_raw",
          position: null,
          payload,
          meta: { source: "computed_yourloveworld" },
          count: payload.length,
        };
      });

      const ylwAdmin = dbIndex.get("yourloveworld");
      if (ylwAdmin) {
        if (ylwAdmin.title) ylwSection.title = ylwAdmin.title;
        if (ylwAdmin.position !== null && ylwAdmin.position !== undefined) {
          ylwSection.position = ylwAdmin.position;
        }
      }

      if (!onlyIds || onlyIds.has("yourloveworld")) sections.push(ylwSection);

      // 3) external sections (SODL)
      const [sodl] = await Promise.all([fetchSodlSection()]);
      for (const ext of [sodl]) {
        if (!ext) continue;
        const dbRow = dbIndex.get(ext.id);
        if (dbRow) {
          ext.title = dbRow.title || ext.title;
          ext.position = dbRow.position ?? ext.position;
        }
        if (!onlyIds || onlyIds.has(ext.id)) {
          if (Array.isArray(ext.payload))
            ext.payload = ext.payload.slice(0, perLimit);
          sections.push(ext);
        }
      }

      // 3b) NEW: homepage hero section with LIVE LINKS
      const CDN_BASE = "https://d1zx0zj5kmre28.cloudfront.net/images/covers";
      const homepageHero = {
        id: "homepage_hero",
        title: "Featured",
        type: "items",
        position: null, // orderIds puts this first
        meta: { source: "inline_hero" },
        payload: [
          {
            image: `https://d1zx0zj5kmre28.cloudfront.net/images/misc/Ingathering_Backround.jpg`,
            logo: `https://d1zx0zj5kmre28.cloudfront.net/images/misc/Ingathering_Logo.png`,
            title: "November 2025 – The Month of Ingathering",
            blurb:
              "The month of November 2025 was declared by the man of God, Pastor Chris Oyakhilome to be ‘The Month of Ingathering.’The Lord had guided in His word from Exodus 34:22-24 that we gather thrice in a year before His presence, because he wants to drive out the nations before us and enlarge our borders. As you watch this message, you’ll gain insight into the feast of ingathering at the year’s end and its significance to the Church of Jesus Christ in this Year of Completeness.",
            cta: {
              label: "Start Watching",
              href: "/watch/jaFSzYLOemk",
              external: false,
            },
          },
          {
            image: `${CDN_BASE}/UAFO_D1_BACKROUND.jpg`,
            logo: `${CDN_BASE}/UAFO_D1_logo.png`,
            title: "Upward and Forward Only",
            blurb:
              "Every meeting held with the man of God Pastor Chris is full of the enveiling of God’s word, His power, miracles, signs and wonders. The Upward and Forward Only program, which held in Abuja, Nigeria was marked with a manifestation of the miraculous tens of thousands received salvation and many were healed of diverse diseases and conditions. Learn from this special teaching by the man of God, Pastor Chris Oyakhilome DSc, DSc, DD, seven important truths about Jesus Christ.",
            cta: {
              label: "Start Watching",
              href: "/watch/80nEPHLOPNs/upward-and-forward-only-day-1",
              external: false,
            },
          },
          {
            image: `${CDN_BASE}/Year_of_Completeness_backround.jpg`,
            logo: `${CDN_BASE}/Year_of_Comp_logo.png`,
            title: "2025 – The Year of Completeness",
            blurb:
              "The scriptures in James 1:4 says, “But let patience have her perfect work, that ye may be perfect and entire, wanting nothing.” 2025 has been declared to be the Year of Completeness. As you relive the moments at this program with the man of God, Rev. Chris Oyakhilome DSc, DSc, DD, you will be capatulted to a whole new level of faith and expectation of the coming of the Lord. For the time is short and this gospel of the Kingdom shall be preached unhindered in all nations; and then the end will come as the scriptures foretold. You’ll understand from this insightful teaching that 2025 is the year to complete the full preaching of the gospel to all nations.",
            cta: {
              label: "Start Watching",
              href: "/watch/VSI7ge89fcx/2025-the-year-of-completeness",
              external: false,
            },
          },
        ],
      };

      if (!onlyIds || onlyIds.has("homepage_hero")) {
        if (Array.isArray(homepageHero.payload)) {
          homepageHero.payload = homepageHero.payload.slice(0, perLimit);
        }
        if (includeCounts) homepageHero.count = homepageHero.payload.length;
        sections.push(homepageHero);
      }

      // 4) expand messages/messagesid → full objects; keep messages_raw as-is
      await withClient(async (db) => {
        for (const s of sections) {
          if (s.type === "messages_raw") {
            if (Array.isArray(s.payload))
              s.payload = s.payload.slice(0, perLimit);
          } else if (s.type === "messages" || s.type === "messagesid") {
            const ids = Array.isArray(s.payload) ? s.payload : [];
            s.payload = await fetchMessagesByIdsPG(db, ids, perLimit);
          } else {
            if (Array.isArray(s.payload))
              s.payload = s.payload.slice(0, perLimit);
          }
          if (includeCounts)
            s.count = Array.isArray(s.payload) ? s.payload.length : 0;
        }
      });

      // 5) final sort: explicit order[] > position > title
      const sortSections = (arr, orderIds) => {
        const indexOf = (id) => (orderIds ? orderIds.indexOf(id) : -1);
        return arr.sort((a, b) => {
          const ao = indexOf(a.id),
            bo = indexOf(b.id);
          if (ao !== -1 || bo !== -1) {
            if (ao === -1) return 1;
            if (bo === -1) return -1;
            if (ao !== bo) return ao - bo;
          }
          const ap = a.position ?? Number.POSITIVE_INFINITY;
          const bp = b.position ?? Number.POSITIVE_INFINITY;
          if (ap !== bp) return ap - bp;
          return String(a.title || "").localeCompare(String(b.title || ""));
        });
      };
      sections = sortSections(sections, orderIds);

      // 6) response
      return res.json({
        status: true,
        data: {
          sections,
          meta: {
            api: { ver: "1.0.2" },
            generated_at: new Date().toISOString(),
          },
          pcdltv: {
            url: "https://cdn-out1-los1.ceflixcdn.com/pcdltvapp/pcdltv/playlist.m3u8",
            adUrl:
              "https://cdn-out1-los1.ceflixcdn.com/pcdltvapp/pcdltv/playlist.m3u8",
          },
          espees: {
            price: {
              ngn: 2050,
              usd: {
                source: "1.2050000000000000710542735760100185871124267578125",
                parsedValue: 1.205,
              },
            },
          },
        },
      });
    }),
  );

  // === BEGIN: GEO HELPERS & ROUTE (server-side ipstack only) ===
  const IPSTACK_KEY = "d423505aa1e822ef57156f4ea6a0c1ce";

  // If you're behind a proxy/load balancer (Cloudflare/ELB/Nginx), set this once in your server entry:
  // app.set("trust proxy", true);

  function getClientIp(req) {
    const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const ip = xff || req.ip || req.connection?.remoteAddress || "";
    return ip.replace(/^::ffff:/, ""); // strip IPv6 prefix for IPv4-mapped
  }

  // GET /affiliate/geo
  // Returns: { status: true, data: { country_name, country_code } }
  router.get(
    "/pcdl/geo",
    asyncHandler(async (req, res) => {
      if (!IPSTACK_KEY) {
        return res.status(500).json({
          status: false,
          error: "missing_ipstack_key",
          message: "Set IPSTACK_KEY in server env or keep the inline default.",
        });
      }

      // Prefer explicit ?ip=... for testing; otherwise detect client IP
      const ipParam = (req.query.ip || "").trim();
      const ip = ipParam || getClientIp(req);

      // If we couldn't detect a usable IP, last resort: /check (ipstack will infer from server IP)
      // But you asked to avoid server location; so we *only* call /{ip} when we have an IP.
      if (!ip) {
        return res.status(200).json({
          status: true,
          data: { country_name: null, country_code: null },
          note: "no_client_ip_detected",
        });
      }

      const url = `https://api.ipstack.com/${encodeURIComponent(
        ip,
      )}?access_key=${encodeURIComponent(
        IPSTACK_KEY,
      )}&fields=country_name,country_code`;

      try {
        const resp = await axios.get(url, { timeout: 6000 });
        const body = resp?.data || {};
        if (body?.success === false) {
          return res.status(502).json({
            status: false,
            error: "ipstack_error",
            details: body.error || null,
          });
        }

        const country_name = body?.country_name || null;
        const country_code = (body?.country_code || "").toLowerCase() || null;

        return res.json({
          status: true,
          data: { country_name, country_code },
        });
      } catch (e) {
        return res.status(502).json({
          status: false,
          error: "ipstack_request_failed",
          message:
            e?.response?.data?.error?.info || e.message || "request failed",
        });
      }
    }),
  );
  // === END: GEO HELPERS & ROUTE ===

  // APP ROUTES

  // --- the homepage route -------------------------------------------------------
  router.post(
    "/pcdl/app/homepage",
    asyncHandler(async (_req, res) => {
      // ---- fixed inputs (no body usage) ----
      const INPUTS = {
        section_ids: [
          "languages",
          "newreleases",
          "yourloveworld",
          "everydaysolutions",
          "faith",
          "gcs",
          "gdop",
          "holyspirit",
          "inchrist",
          "jesus",
          "motw",
          "moty",
          "prayers",
          "testimony",
          "thewordworks",
          "weekend",
          "documentary",
        ],
        order: [
          // 'homepage_hero' will be injected to the front so it appears first
          "yourloveworld",
          "languages",
          "newreleases",
          "motw",
          "everydaysolutions",
          "testimony",
          "documentary",
          "gdop",
          "gcs",
          "holyspirit",
          "faith",
          "inchrist",
          "jesus",
          "moty",
          "prayers",
          "thewordworks",
          "weekend",
        ],
        per_section_limit: 12,
      };

      // ---- constants/helpers ----
      const LIMIT_PER_SECTION_DEFAULT = 15;
      const LIMIT_PER_SECTION_MAX = 30;
      const clamp = (n, lo, hi) => Math.max(lo, Math.min(n, hi));

      // Use fixed inputs
      const perLimit = clamp(
        Number.isFinite(INPUTS.per_section_limit)
          ? INPUTS.per_section_limit
          : LIMIT_PER_SECTION_DEFAULT,
        1,
        LIMIT_PER_SECTION_MAX,
      );

      const onlyIds =
        Array.isArray(INPUTS.section_ids) && INPUTS.section_ids.length
          ? new Set(INPUTS.section_ids.map(String))
          : null;

      // Ensure hero sorts first by injecting it into the order list
      const ORDER_FIRST = ["homepage_hero"];
      const baseOrder =
        Array.isArray(INPUTS.order) && INPUTS.order.length
          ? INPUTS.order.map(String)
          : [];
      const orderIds = [
        ...ORDER_FIRST,
        ...baseOrder.filter((id) => !ORDER_FIRST.includes(id)),
      ];

      const includeCounts = true; // fixed: always include counts

      // 1) load admin lists
      const adminRows = await withClient(async (db) => {
        const r = await db.query(
          `SELECT id, title, type, position, items
         FROM public.admin_lists
         ORDER BY position ASC NULLS LAST, title ASC`,
        );
        return r.rows || [];
      });

      // normalize admin rows → sections
      const rowToSection = (row) => ({
        id: row.id,
        title: row.title,
        type: row.type, // 'messages' (ids), 'messagesid' (ids), 'series', 'items'
        payload: row.items || [],
        meta: { source: "admin_lists" },
      });

      let sections = adminRows.map(rowToSection);
      if (onlyIds) sections = sections.filter((s) => onlyIds.has(s.id));

      const dbIndex = new Map(adminRows.map((r) => [r.id, r]));

      // 2) computed Your Loveworld (messages_raw so we don't re-expand)
      const ylwSection = await withClient(async (db) => {
        const payload = await fetchYourLoveWorldMessages(db, perLimit);
        return {
          id: "yourloveworld",
          title: "Your Loveworld Specials",
          type: "messages_raw", // already-shaped items; skip expansion
          payload,
          meta: { source: "computed_yourloveworld" },
          count: payload.length,
        };
      });

      // Allow admin_lists to override ylw title/position if there’s a matching row
      const ylwAdmin = dbIndex.get("yourloveworld");
      if (ylwAdmin) {
        if (ylwAdmin.title) ylwSection.title = ylwAdmin.title;
        if (ylwAdmin.position !== null && ylwAdmin.position !== undefined) {
          ylwSection.position = ylwAdmin.position;
        }
      }

      if (!onlyIds || onlyIds.has("yourloveworld")) {
        sections.push(ylwSection);
      }

      // 3) external list sections (SODL)
      const [sodl] = await Promise.all([fetchSodlSection()]);

      for (const ext of [sodl]) {
        if (!ext) continue;
        const dbRow = dbIndex.get(ext.id);
        if (dbRow) {
          ext.title = dbRow.title || ext.title;
          ext.position = dbRow.position ?? ext.position;
        }
        if (!onlyIds || onlyIds.has(ext.id)) {
          if (Array.isArray(ext.payload))
            ext.payload = ext.payload.slice(0, perLimit);
          sections.push(ext);
        }
      }

      // 3b) NEW + ACTIVATED: homepage hero section with LIVE LINKS (always included)
      const CDN_BASE = "https://d1zx0zj5kmre28.cloudfront.net/images/covers";
      const homepageHero = {
        id: "homepage_hero",
        title: "Featured",
        type: "items",
        position: null, // orderIds puts this first
        meta: { source: "inline_hero" },
        payload: [
          // {
          //   image:
          //     "https://d1zx0zj5kmre28.cloudfront.net/images/misc/focus_background.jpg",
          //   logo: "https://d1zx0zj5kmre28.cloudfront.net/images/misc/focus_logo2.png",
          //   title: "March 2026 – The Month of Focus",
          //   blurb:
          //     "Focus is a concentration of the attention or energy or convergence on something. It also means to give full attention to an object or interest. What are you focusing on this month? The scripture said in Isaiah 26:3 KJV; “Thou wilt keep him in perfect peace, whose mind is stayed on thee: because he trusteth in thee.”This month of March and onward, the Lord wants you to be focused on His word.",
          //   cta: {
          //     label: "Start Watching",
          //     href: "/watch/HzhQxrFxiEk",
          //     external: false,
          //   },
          // },
          {
            image:
              "https://d1zx0zj5kmre28.cloudfront.net/images/misc/Year_of_Manifestation_Cover_new.webp",
            logo: "https://d1zx0zj5kmre28.cloudfront.net/images/misc/Year_of_Manifestation_Logo_2.webp",
            title: "2026 – The Year of Manifestation",
            blurb:
              "Did you know that we are in the era of the ‘Extra Time’? Who is that last man or woman to come into the kingdom? We are in that final lap of the Church age where the race for the last lost soul must be completed. The day of the revelation of Christ is at hand. While it is day, we must do the work of Him who sent us until the full number of the gentiles come into the kingdom as the scriptures foretold. Relive the moments at the December 31st New Year’s Eve Service, where the man of God, Pastor Chris Oyakhilome DSc, DSc, DD, declared 2026 to be the Year of Manifestation.",
            cta: {
              label: "Start Watching",
              href: "/watch/qAIFp2O_2Lw",
              external: false,
            },
          },
          // {
          //   image: `https://d1zx0zj5kmre28.cloudfront.net/images/misc/Ingathering_Backround.jpg`,
          //   logo: `https://d1zx0zj5kmre28.cloudfront.net/images/misc/Ingathering_Logo.png`,
          //   title: "November 2025 – The Month of Ingathering",
          //   blurb:
          //     "The month of November 2025 was declared by the man of God, Pastor Chris Oyakhilome to be ‘The Month of Ingathering.’The Lord had guided in His word from Exodus 34:22-24 that we gather thrice in a year before His presence, because he wants to drive out the nations before us and enlarge our borders. As you watch this message, you’ll gain insight into the feast of ingathering at the year’s end and its significance to the Church of Jesus Christ in this Year of Completeness.",
          //   cta: {
          //     label: "Start Watching",
          //     href: "/watch/jaFSzYLOemk",
          //     external: false,
          //   },
          // },
        ],
      };

      // Always include and cap length/counts consistently
      if (Array.isArray(homepageHero.payload)) {
        homepageHero.payload = homepageHero.payload.slice(0, perLimit);
      }
      if (includeCounts) homepageHero.count = homepageHero.payload.length;
      sections.push(homepageHero);

      // 4) expand messages/messagesid to full message objects, but skip messages_raw
      await withClient(async (db) => {
        for (const s of sections) {
          if (s.type === "messages_raw") {
            if (Array.isArray(s.payload))
              s.payload = s.payload.slice(0, perLimit);
          } else if (s.type === "messages" || s.type === "messagesid") {
            const ids = Array.isArray(s.payload) ? s.payload : [];
            s.payload = await fetchMessagesByIdsPG(db, ids, perLimit);
          } else {
            // 'items' or other: just cap length
            if (Array.isArray(s.payload))
              s.payload = s.payload.slice(0, perLimit);
          }
          if (includeCounts) {
            s.count = Array.isArray(s.payload) ? s.payload.length : 0;
          }
        }
      });

      // 5) final sort: explicit order[] > position > title
      const sortSections = (arr, orderIds) => {
        const indexOf = (id) => (orderIds ? orderIds.indexOf(id) : -1);
        return arr.sort((a, b) => {
          const ao = indexOf(a.id),
            bo = indexOf(b.id);
          if (ao !== -1 || bo !== -1) {
            if (ao === -1) return 1;
            if (bo === -1) return -1;
            if (ao !== bo) return ao - bo;
          }
          const ap = a.position ?? Number.POSITIVE_INFINITY;
          const bp = b.position ?? Number.POSITIVE_INFINITY;
          if (ap !== bp) return ap - bp;
          return String(a.title || "").localeCompare(String(b.title || ""));
        });
      };
      sections = sortSections(sections, orderIds);

      // 6) response
      return res.json({
        status: true,
        data: {
          sections,
          pcdltv: {
            url: "https://cdn-out1-los1.ceflixcdn.com/pcdltvapp/pcdltv/playlist.m3u8",
            adUrl:
              "https://cdn-out1-los1.ceflixcdn.com/pcdltvapp/pcdltv/playlist.m3u8",
          },
        },
      });
    }),
  );

  // POST /pcdl/admin/lists/get
  // Body: { id: string }
  // Auth: admin
  router.post(
    "/pcdl/admin/lists/get",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const id = String(req.body?.id ?? "").trim();
      if (!id) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "id_required",
        });
      }

      const row = await withClient(async (db) => {
        const { rows } = await db.query(
          `SELECT id, title, type, items, position, created_at, updated_at
           FROM public.admin_lists
          WHERE id = $1
          LIMIT 1;`,
          [id],
        );
        return rows[0];
      });

      if (!row) {
        return res.status(404).json({ status: false, error: "not_found" });
      }

      return res.json({ status: true, data: row });
    }),
  );

  router.post(
    "/pcdl/token/validate",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const email = (b.email || "").trim();
      const token = (b.token || "").trim();

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

      return res.status(200).json({ status: true, error: "Token is Valid" });
    }),
  );

  router.post(
    "/pcdl/pcdl_solutions/search",
    asyncHandler(async (req, res) => {
      const b = req.body || {};
      const email = (b.email || "").trim();
      const searchText = (b.searchText || "").trim();

      if (!email || !searchText) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "email and searchText are required",
        });
      }

      const url =
        "https://searchengine.pastorchrisdigitallibrary.org:447/phps/mongos/pcdl_search_engine/pcdl_search.php";

      try {
        const resp = await axios.post(
          url,
          {
            operation: "pcdl_solutions_search", // static
            email,
            searchText,
            token: "PCDL_WEB_03052023", // static
          },
          { headers: { "Content-Type": "application/json" } },
        );

        // Pass through upstream status & data
        return res.status(resp.status).json(resp.data);
      } catch (err) {
        // Mirror your error style
        return res.status(400).json({
          status: false,
          error: "pcdl_solutions_failed",
          message:
            err?.response?.data ||
            err?.message ||
            "pcdl_solutions request failed",
        });
      }
    }),
  );

  router.post(
    "/pcdl/pcdl_solutions/all",
    asyncHandler(async (req, res) => {
      const b = req.body || {};

      const url =
        "https://searchengine.pastorchrisdigitallibrary.org:447/phps/mongos/pcdl_solutions/pcdl_solutions_all.php";

      try {
        const resp = await axios.post(
          url,
          {
            token: "PCDL_WEB_03052023", // static
          },
          { headers: { "Content-Type": "application/json" } },
        );

        // Pass through upstream status & data
        return res.status(resp.status).json(resp.data);
      } catch (err) {
        // Mirror your error style
        return res.status(400).json({
          status: false,
          error: "pcdl_solutions_failed",
          message:
            err?.response?.data ||
            err?.message ||
            "pcdl_solutions request failed",
        });
      }
    }),
  );

  router.post(
    "/pcdl/pcdl_search/search",
    asyncHandler(async (req, res) => {
      const b = req.body || {};
      const email = (b.email || "").trim();
      const searchText = (b.searchText || "").trim();

      if (!email || !searchText) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "email and searchText are required",
        });
      }

      const url =
        "https://searchengine.pastorchrisdigitallibrary.org:447/phps/mongos/pcdl_search_engine/pcdl_search.php";

      try {
        const resp = await axios.post(
          url,
          {
            operation: "pcdl_search", // static
            email,
            searchText,
            token: "PCDL_WEB_03052023", // static
          },
          { headers: { "Content-Type": "application/json" } },
        );

        // Pass through upstream status & data
        return res.status(resp.status).json(resp.data);
      } catch (err) {
        // Mirror your error style
        return res.status(400).json({
          status: false,
          error: "pcdl_search_failed",
          message:
            err?.response?.data || err?.message || "pcdl_search request failed",
        });
      }
    }),
  );

  // Calls the kingsChatLogin endpoint with the provided ID.
  // If that call succeeds → returns result: 1.
  // If it fails, it checks Postgres for a matching kc_id in public.users:
  // if found → result: 2
  // if not found → result: 0

  router.post(
    "/pcdl/kc/check",
    asyncHandler(async (req, res) => {
      const kcId = String(
        req.body?.id || req.body?.kingsChatUserId || req.query?.id || "",
      ).trim();

      if (!kcId) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "id required",
        });
      }

      // 1) Try external kingsChatLogin
      let foundExternally = false;
      try {
        const { data } = await axios.post(
          "https://sjvv8a3ys1.execute-api.us-east-1.amazonaws.com/Dev/kingsChatLogin",
          { kingsChatUserId: kcId },
          { timeout: 8000, headers: { "Content-Type": "application/json" } },
        );
        // success response sample: { statusCode:200, body:{ email, token, ... }, message:"Login Successfully" }
        foundExternally =
          Number(data?.statusCode) === 200 &&
          data?.body &&
          (data.body.email || data.body.token);
      } catch (_) {
        // treat errors/timeouts as 'not found externally' and fall through to DB check
      }

      if (foundExternally) {
        // Found by external API
        return res.json({ status: true, result: 1 });
      }

      // 2) Not found externally — check DB kc_id
      const presentInDb = await withClient(async (db) => {
        const r = await db.query(
          `SELECT 1 FROM public.users WHERE kc_id = $1 LIMIT 1`,
          [kcId],
        );
        return r.rowCount > 0;
      });

      // 2 => exists in DB; 0 => not present at all
      return res.json({ status: true, result: presentInDb ? 2 : 0 });
    }),
  );

  router.post(
    "/pcdl/auth/signin/redirect",
    asyncHandler(async (req, res) => {
      try {
        const b = req.body && typeof req.body === "object" ? req.body : {};
        const accessToken = (b.accessToken || "").trim();
        const refreshToken = (b.refreshToken || "").trim();
        const redirectTo = (b.redirectTo || "/").toString();

        if (!accessToken || !refreshToken) {
          return res
            .status(400)
            .json({ status: false, error: "Missing tokens" });
        }

        // Create one-time code (store tokens server-side)
        const code = putKcCode({ accessToken, refreshToken });

        // Redirect to SPA with ONLY the code
        const spaProcessUrl = "https://pcdl.co/kc/signin/process"; // inline
        const u = new URL(spaProcessUrl);
        u.searchParams.set("code", code);
        u.searchParams.set("redirectTo", redirectTo);

        return res.redirect(303, u.toString());
      } catch (err) {
        console.error("kc_login redirect bridge error:", err);
        return res.status(500).json({
          status: false,
          error: "server_error",
          message: "Unexpected error while processing login",
        });
      }
    }),
  );

  router.get(
    "/pcdl/auth/kc_login_cookie",
    asyncHandler(async (req, res) => {
      try {
        const accessToken = (req.cookies?.pcdl_at || "").trim();
        const refreshToken = (req.cookies?.pcdl_rt || "").trim();

        if (!accessToken || !refreshToken) {
          return res
            .status(401)
            .json({ status: false, error: "Missing auth cookies" });
        }

        // TODO: replace this with your existing kc_login logic:
        // - validate tokens / fetch profile / create app session / etc.
        // For demo purposes, just echo minimal
        const data = {
          accessTokenPresent: true,
          refreshTokenPresent: true,
        };

        return res.json({ status: true, message: "Login Successfully", data });
      } catch (err) {
        console.error("kc_login_cookie error:", err);
        return res.status(500).json({
          status: false,
          error: "server_error",
          message: "Unexpected error while processing login",
        });
      }
    }),
  );

  router.post(
    "/pcdl/auth/signup/redirect",
    asyncHandler(async (req, res) => {
      try {
        // Accept JSON or form-encoded bodies
        const b = req.body && typeof req.body === "object" ? req.body : {};
        const accessToken = (b.accessToken || "").trim();
        const refreshToken = (b.refreshToken || "").trim();
        const redirectTo = (b.redirectTo || "/").toString();

        if (!accessToken || !refreshToken) {
          return res
            .status(400)
            .json({ status: false, error: "Missing tokens" });
        }

        // Build the GET redirect to your SPA for processing
        const base =
          process.env.KC_PROCESS_REDIRECT ||
          "https://pcdl.co/kc/signup/process";

        const u = new URL(base);
        u.searchParams.set("accessToken", accessToken);
        u.searchParams.set("refreshToken", refreshToken);
        u.searchParams.set("redirectTo", redirectTo);

        // 303 = See Other (forces browser to re-GET the URL after a POST)
        return res.redirect(303, u.toString());
      } catch (err) {
        console.error("kc_login redirect bridge error:", err);
        return res.status(500).json({
          status: false,
          error: "server_error",
          message: "Unexpected error while processing login",
        });
      }
    }),
  );

  router.post(
    "/pcdl/auth/kc_login",
    asyncHandler(async (req, res) => {
      try {
        let b = {};
        if (
          req.body &&
          typeof req.body === "object" &&
          Object.keys(req.body).length
        ) {
          b = req.body;
        } else if (req.body && typeof req.body === "string") {
          try {
            b = JSON.parse(req.body);
          } catch {
            b = {};
          }
        } else {
          const raw = await new Promise((resolve) => {
            let data = "";
            req.on("data", (chunk) => (data += chunk));
            req.on("end", () => resolve(data));
            req.on("error", () => resolve(""));
          });
          try {
            b = raw ? JSON.parse(raw) : {};
          } catch {
            b = {};
          }
        }

        const accessToken = String(b.accessToken || "").trim();
        const refreshToken = String(b.refreshToken || "").trim();

        if (!accessToken || !refreshToken) {
          return res.status(400).json({
            status: false,
            error: "bad_request",
            message: "accessToken and refreshToken are required",
          });
        }

        function safeJsonParse(value) {
          if (!value) return null;
          if (typeof value === "object") return value;
          try {
            return JSON.parse(value);
          } catch {
            return null;
          }
        }

        function sleep(ms) {
          return new Promise((resolve) => setTimeout(resolve, ms));
        }

        function normalizeLambdaBody(json) {
          if (!json) return null;
          const parsedBody = safeJsonParse(json.body);
          return {
            ...json,
            body: parsedBody ?? json.body ?? null,
          };
        }

        function extractMessage(result) {
          return String(
            result?.json?.message ||
              result?.json?.error ||
              result?.json?.body?.message ||
              result?.json?.body?.error ||
              result?.body?.message ||
              result?.body?.error ||
              result?.text ||
              "",
          ).trim();
        }

        function isAccountNotInDatabase(result) {
          return extractMessage(result)
            .toLowerCase()
            .includes("kingschat account not in database");
        }

        function isLoginSuccess(result) {
          return !!(
            result?.ok &&
            result?.json &&
            Number(result.json.statusCode) === 200 &&
            result?.body &&
            result.body.token
          );
        }

        function isSignupSuccess(result) {
          const msg = extractMessage(result).toLowerCase();
          const statusCode =
            Number(result?.json?.statusCode) ||
            Number(result?.body?.statusCode) ||
            Number(result?.status) ||
            0;

          return !!(
            result?.ok &&
            (result?.json?.status === true ||
              statusCode === 200 ||
              msg.includes("new user successfully created") ||
              msg.includes("successfully created") ||
              msg.includes("user successfully created") ||
              msg.includes("success") ||
              msg.includes("created") ||
              msg.includes("already exists") ||
              msg.includes("user exists") ||
              msg.includes("account exists"))
          );
        }

        function normalizeText(value) {
          if (value === undefined || value === null) return null;
          const s = String(value).trim();
          return s === "" ? null : s;
        }

        function pickAvatar(dbUser, profile, kcBody) {
          return (
            normalizeText(dbUser?.avatar_url) ||
            normalizeText(kcBody?.avatar_url) ||
            normalizeText(profile?.avatar_url) ||
            normalizeText(profile?.avatarURL) ||
            normalizeText(profile?.photo_url) ||
            normalizeText(profile?.avatar) ||
            ""
          );
        }

        const kcResp = await fetch(
          "https://connect.kingsch.at/developer/api/profile",
          {
            method: "GET",
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
          },
        );

        const kcText = await kcResp.text();
        let kcData = null;
        try {
          kcData = kcText ? JSON.parse(kcText) : null;
        } catch {}

        if (!kcResp.ok) {
          return res.status(502).json({
            status: false,
            error: `kc_profile_fetch_failed_${kcResp.status}`,
            details: kcData ?? kcText ?? null,
          });
        }

        const profile = kcData?.profile ?? null;
        const kingsChatUserId = normalizeText(profile?.id);

        if (!kingsChatUserId) {
          return res.status(502).json({
            status: false,
            error: "kc_profile_missing_fields",
            details: kcData ?? null,
          });
        }

        async function callKingsChatLogin(kingsChatUserId) {
          const r = await fetch(
            "https://sjvv8a3ys1.execute-api.us-east-1.amazonaws.com/Dev/kingsChatLogin",
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json",
              },
              body: JSON.stringify({ kingsChatUserId }),
            },
          );

          const text = await r.text();
          let json = safeJsonParse(text);
          json = normalizeLambdaBody(json);

          return {
            ok: r.ok,
            status: r.status,
            text,
            json,
            body: json?.body ?? null,
          };
        }

        async function signUpKingsChatUser(profile, kingsChatUserId) {
          const syntheticEmail = `${kingsChatUserId}@pcdl.co`;

          const payload = {
            email: syntheticEmail,
            password: kingsChatUserId,
            title: "",
            first_name: kingsChatUserId,
            last_name: "",
            country: normalizeText(profile?.country) || "Nigeria",
            api_key:
              "iw56io43dfgh56djka453lskjfhj283jd64hw88djbu3jgldkl705896als54k778d5g",
            telephone: "112233445566",
            affiliate: "",
            avatarURL: pickAvatar(null, profile, null),
            kingsChatUserId,
          };

          const r = await fetch(
            "https://sjvv8a3ys1.execute-api.us-east-1.amazonaws.com/Dev/kingsChatSignUp",
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json",
              },
              body: JSON.stringify(payload),
            },
          );

          const text = await r.text();
          let json = safeJsonParse(text);
          json = normalizeLambdaBody(json);

          return {
            ok: r.ok,
            status: r.status,
            text,
            json,
            body: json?.body ?? null,
            payload,
          };
        }

        let kcLoginResult = await callKingsChatLogin(kingsChatUserId);

        if (
          !isLoginSuccess(kcLoginResult) &&
          isAccountNotInDatabase(kcLoginResult)
        ) {
          const signupResult = await signUpKingsChatUser(
            profile,
            kingsChatUserId,
          );

          if (!isSignupSuccess(signupResult)) {
            return res.status(502).json({
              status: false,
              error: "kingschat_signup_failed",
              message: "KingsChat account was not found and signup failed",
              details: signupResult.json ?? signupResult.text ?? null,
            });
          }

          let retryCount = 0;
          const maxRetries = 8;

          while (retryCount < maxRetries) {
            retryCount += 1;
            await sleep(1200);
            kcLoginResult = await callKingsChatLogin(kingsChatUserId);
            if (isLoginSuccess(kcLoginResult)) break;
          }
        }

        const kcLoginJson = kcLoginResult.json;
        const kcBody = kcLoginResult.body;

        if (!isLoginSuccess(kcLoginResult)) {
          return res.status(502).json({
            status: false,
            error: "kingschat_login_failed",
            message: extractMessage(kcLoginResult) || "KingsChat login failed",
            details: kcLoginJson ?? kcLoginResult.text ?? null,
          });
        }

        const normalizedEmail = normalizeText(kcBody?.email);
        if (!normalizedEmail || !kcBody?.token) {
          return res.status(401).json({
            status: false,
            error: "unauthorized",
            message: "Invalid login or password",
          });
        }

        const dbUser = await withClient(async (db) => {
          const currentDb = await db.query(`SELECT current_database() AS db`);
          const currentSchema = await db.query(
            `SELECT current_schema() AS schema`,
          );
          const colsResult = await db.query(
            `
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'users'
          `,
          );

          const existingCols = new Set(
            colsResult.rows.map((r) => r.column_name),
          );

          console.log("kc_login live db/schema:", {
            db: currentDb.rows[0]?.db,
            schema: currentSchema.rows[0]?.schema,
            columns: [...existingCols],
          });

          const existing = await db.query(
            `SELECT * FROM public.users WHERE email = $1`,
            [normalizedEmail],
          );

          const candidatePayload = {
            email: normalizedEmail,
            title: normalizeText(kcBody.title),
            last_name: normalizeText(kcBody.last_name),
            country: normalizeText(kcBody.country),
            first_name: normalizeText(kcBody.first_name),
            kc_username:
              normalizeText(profile?.username) ||
              normalizeText(kcBody.kc_username),
            phone: normalizeText(kcBody.phone_number),
            plan: normalizeText(kcBody.subscription_name),
            type: "kingschat",
          };

          const payload = Object.fromEntries(
            Object.entries(candidatePayload).filter(([key]) =>
              existingCols.has(key),
            ),
          );

          if (existing.rows.length > 0) {
            const updatableCols = Object.keys(payload).filter(
              (k) => k !== "email",
            );

            if (updatableCols.length === 0) {
              return existing.rows[0];
            }

            const values = [normalizedEmail];
            const sets = [];
            let idx = 2;

            for (const col of updatableCols) {
              sets.push(`${col} = COALESCE(${col}, $${idx})`);
              values.push(payload[col]);
              idx += 1;
            }

            sets.push(`updated_at = now()`);

            const sql = `
            UPDATE public.users
            SET ${sets.join(", ")}
            WHERE email = $1
            RETURNING *;
          `;

            const updated = await db.query(sql, values);
            return updated.rows[0];
          }

          const insertPayload = { ...payload };
          if (existingCols.has("created_at"))
            insertPayload.created_at = new Date();
          if (existingCols.has("updated_at"))
            insertPayload.updated_at = new Date();

          const cols = Object.keys(insertPayload);
          const vals = cols.map((c) => insertPayload[c]);
          const placeholders = vals.map((_, i) => `$${i + 1}`).join(", ");

          const inserted = await db.query(
            `
            INSERT INTO public.users (${cols.join(", ")})
            VALUES (${placeholders})
            RETURNING *;
          `,
            vals,
          );

          return inserted.rows[0];
        });

        const email = String(dbUser?.email || normalizedEmail || "").trim();

        async function fetchSubFromGatekeeper(email) {
          const r = await fetch(
            "https://pcdlsub.loveworldapis.com/api/gatekeeper/c/checksubscriptionstatus",
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json",
              },
              body: JSON.stringify({ email }),
            },
          );

          const t = await r.text();
          let j = null;
          try {
            j = t ? JSON.parse(t) : null;
          } catch {}

          if (!r.ok || !j || j.statusCode !== 200) {
            const err = new Error("gatekeeper_failed");
            err.details = j ?? t ?? null;
            throw err;
          }

          return j;
        }

        async function fetchSubFromPcdl(email) {
          const r = await fetch(
            "https://api.pastorchrisdigitallibrary.org/payment/subscriptionstatus",
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json",
              },
              body: JSON.stringify({ email }),
            },
          );

          const t = await r.text();
          let j = null;
          try {
            j = t ? JSON.parse(t) : null;
          } catch {}

          if (!r.ok || !j || j.statusCode !== 200) {
            const err = new Error("pcdl_failed");
            err.details = j ?? t ?? null;
            throw err;
          }

          return j;
        }

        let subscription = null;
        let subSource = "none";

        try {
          const gk = await fetchSubFromGatekeeper(email);
          subscription = gk.body || gk.data || null;
          subSource = "gatekeeper";
        } catch {
          try {
            const p = await fetchSubFromPcdl(email);
            subscription = p.body || p.data || null;
            subSource = "pcdl";
          } catch {
            subscription = null;
            subSource = "none";
          }
        }

        const merged = {
          email: dbUser.email ?? email,
          token: kcBody.token,
          title: dbUser.title ?? normalizeText(kcBody.title) ?? "",
          first_name:
            dbUser.first_name ?? normalizeText(kcBody.first_name) ?? "",
          last_name: dbUser.last_name ?? normalizeText(kcBody.last_name) ?? "",
          country: dbUser.country ?? normalizeText(kcBody.country) ?? "",
          church: normalizeText(kcBody.church) ?? "",
          zone: normalizeText(kcBody.zone) ?? "",
          christ_embassy_member: kcBody.christ_embassy_member ?? "",
          avatar_url: pickAvatar(dbUser, profile, kcBody) || null,
          phone_number:
            dbUser.phone ?? normalizeText(kcBody.phone_number) ?? null,
          username:
            dbUser.kc_username ?? normalizeText(profile?.username) ?? null,
          kc_id: kingsChatUserId,
          kc_username:
            dbUser.kc_username ??
            normalizeText(profile?.username) ??
            normalizeText(kcBody.kc_username) ??
            null,
          kc_display_name: normalizeText(profile?.display_name) ?? null,
          affiliate: normalizeText(kcBody.affiliate) ?? "",
          zonal_code: normalizeText(kcBody.zonal_code) ?? "",
          wallet_address: "",
          library: Array.isArray(kcBody.library) ? kcBody.library : [],
          wallet_balance:
            subscription?.wallet_balance ?? kcBody.wallet_balance ?? 0,
          subscription_expiration:
            subscription?.subscription_expiration ??
            kcBody.subscription_expiration ??
            null,
          subscription_name:
            subscription?.subscription_name ??
            kcBody.subscription_name ??
            dbUser.plan ??
            "",
          subscription_source: subSource,
        };

        return res.status(200).json({
          status: true,
          data: merged,
          message: kcLoginJson.message || "Login Successfully",
        });
      } catch (err) {
        console.error("kc_login server_error:", err);
        return res.status(500).json({
          status: false,
          error: "server_error",
          message: err?.message || "Unexpected error while processing login",
        });
      }
    }),
  );

  router.post(
    "/pcdl/auth/kc_exchange",
    asyncHandler(async (req, res) => {
      try {
        const b = req.body && typeof req.body === "object" ? req.body : {};
        const code = (b.code || "").trim();

        if (!code) {
          return res.status(400).json({ status: false, error: "Missing code" });
        }

        const stored = takeKcCode(code);
        if (!stored) {
          return res
            .status(401)
            .json({ status: false, error: "Invalid or expired code" });
        }

        const { accessToken, refreshToken } = stored;

        // Call your existing logic here:
        // - validate tokens
        // - fetch/create user session
        // - return json.data just like kc_login
        //
        // Example stub:
        const data = {
          accessToken, // (you can omit these if you don't want frontend to store them)
          refreshToken,
        };

        return res.json({ status: true, message: "Login Successfully", data });
      } catch (err) {
        console.error("kc_exchange error:", err);
        return res.status(500).json({
          status: false,
          error: "server_error",
          message: "Unexpected error while exchanging code",
        });
      }
    }),
  );

  // POST /pcdl/auth/kc_signup
  // Body: { accessToken: "...", refreshToken: "..." }  (same as kc_login)
  router.post(
    "/pcdl/auth/kc_signup",
    asyncHandler(async (req, res) => {
      try {
        // --- Input parsing (accepts parsed JSON or raw) -----------------------
        let b = {};
        if (
          req.body &&
          typeof req.body === "object" &&
          Object.keys(req.body).length
        ) {
          b = req.body;
        } else if (req.body && typeof req.body === "string") {
          try {
            b = JSON.parse(req.body);
          } catch {
            b = {};
          }
        } else {
          const raw = await new Promise((resolve) => {
            let data = "";
            req.on("data", (chunk) => (data += chunk));
            req.on("end", () => resolve(data));
            req.on("error", () => resolve(""));
          });
          try {
            b = raw ? JSON.parse(raw) : {};
          } catch {
            b = {};
          }
        }
        // ----------------------------------------------------------------------

        const accessToken = String(b.accessToken || "").trim();
        const refreshToken = String(b.refreshToken || "").trim();
        if (!accessToken || !refreshToken) {
          return res
            .status(400)
            .json({ status: false, error: "Missing tokens" });
        }

        // 1) Fetch KC profile
        const kcResp = await fetch(
          "https://connect.kingsch.at/developer/api/profile",
          {
            method: "GET",
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
          },
        );
        const kcText = await kcResp.text();
        let kcData = null;
        try {
          kcData = kcText ? JSON.parse(kcText) : null;
        } catch {}
        if (!kcResp.ok || !kcData?.profile?.id) {
          return res.status(502).json({
            status: false,
            error: `kc_profile_fetch_failed_${kcResp.status || "unknown"}`,
            details: kcData ?? kcText ?? null,
          });
        }

        const kcId = String(kcData.profile.id);

        // If this KC already exists locally, short-circuit to avoid dup signup
        const existing = await withClient(async (db) => {
          const r = await db.query(
            `SELECT email FROM public.users WHERE kc_id = $1 LIMIT 1`,
            [kcId],
          );
          return r.rows[0] || null;
        });
        if (existing?.email) {
          // Already signed up; fetch token and return as success
          const tokenResp = await fetch(
            "https://sjvv8a3ys1.execute-api.us-east-1.amazonaws.com/Dev/fetchUserToken",
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json",
              },
              body: JSON.stringify({
                email: existing.email,
                token: "SFG89VKUG98DPGWJRW4",
              }),
            },
          );
          const tokenJson = await tokenResp.json().catch(() => ({}));
          return res.status(200).json({
            status: true,
            data: {
              email: existing.email,
              token: tokenJson?.token || null,
              kc_id: kcId,
              already_existed: true,
            },
            message: "User already exists; returning token.",
          });
        }

        // 2) Generate base-68 (length 8) slug for email local part
        // Alphabet = 10 digits + 26 lower + 26 upper + 6 safe symbols = 68
        function randomBase68(n) {
          const alphabet =
            "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_.~!*";
          const mod = alphabet.length; // 68
          const bytes = crypto.randomBytes(n);
          let out = "";
          for (let i = 0; i < n; i++) out += alphabet[bytes[i] % mod];
          return out;
        }
        const localPart = randomBase68(8);
        const generatedEmail = `kc_${localPart}@pcdl.co`;
        const generatedPassword = kcId; // per requirement

        // Basic KC profile fields (fallbacks)
        const first_name =
          kcData.profile.first_name ||
          kcData.profile.firstname ||
          kcData.profile.firstName ||
          "";
        const last_name =
          kcData.profile.last_name ||
          kcData.profile.lastname ||
          kcData.profile.lastName ||
          "";
        const title = ""; // not provided by KC
        const country = ""; // optional
        const telephone = "";
        const affiliate = "";
        const avatarURL =
          kcData.profile.avatar_url ||
          kcData.profile.avatarURL ||
          kcData.profile.avatar ||
          "";

        // 3) Call kingsChatSignUp
        const signUpPayload = {
          email: generatedEmail,
          password: generatedPassword,
          title,
          first_name,
          last_name,
          country,
          api_key:
            "iw56io43dfgh56djka453lskjfhj283jd64hw88djbu3jgldkl705896als54k778d5g",
          telephone,
          affiliate,
          avatarURL,
          kingsChatUserId: kcId,
        };

        let signUpJson = null;
        try {
          const signResp = await axios.post(
            "https://sjvv8a3ys1.execute-api.us-east-1.amazonaws.com/Dev/kingsChatSignUp",
            signUpPayload,
            { timeout: 12000, headers: { "Content-Type": "application/json" } },
          );
          signUpJson = signResp?.data || null;
        } catch (err) {
          return res.status(502).json({
            status: false,
            error: "kingsChatSignUp_failed",
            details: err?.response?.data || err.message || null,
          });
        }

        const code = Number(signUpJson?.statusCode ?? signUpJson?.status ?? 0);
        const providerOk =
          (code && (code === 200 || code === 201)) ||
          (!!signUpJson?.body?.email && !!signUpJson?.message);

        if (!providerOk) {
          return res.status(400).json({
            status: false,
            error: "signup_failed",
            message: signUpJson?.message || "Provider did not confirm signup",
            provider: signUpJson || null,
          });
        }

        const providerEmail = signUpJson?.body?.email || generatedEmail;

        // 4) Upsert locally with kc_id
        const dbUser = await withClient(async (db) => {
          const fields = [
            "kc_id",
            "title",
            "first_name",
            "last_name",
            "country",
            "church",
            "user_zone",
            "user_group",
            "christ_embassy_member",
            "avatar_url",
            "phone_number",
            "username",
            "is_profile_public",
          ];
          const payload = {
            kc_id: kcId,
            title: title || null,
            first_name: first_name || null,
            last_name: last_name || null,
            country: country || null,
            church: null,
            user_zone: null,
            user_group: null,
            christ_embassy_member: null,
            avatar_url: avatarURL || null,
            phone_number: telephone || null,
            username: null,
            is_profile_public: true,
          };
          const cols = ["email"].concat(fields);
          const vals = [providerEmail].concat(fields.map((f) => payload[f]));
          const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
          const updates = fields
            .filter((f) => f !== "username") // keep username immutable unless explicitly set elsewhere
            .map((f) => `${f} = EXCLUDED.${f}`)
            .join(", ");

          const sql = `
          INSERT INTO public.users (${cols.join(",")})
          VALUES (${placeholders})
          ON CONFLICT (email) DO UPDATE SET ${updates}, updated_at = now()
          RETURNING *;
        `;
          const r = await db.query(sql, vals);
          return r.rows[0];
        });

        // 5) Fetch token for the new user
        let tokenValue = null;
        try {
          const tokenResp = await fetch(
            "https://sjvv8a3ys1.execute-api.us-east-1.amazonaws.com/Dev/fetchUserToken",
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json",
              },
              body: JSON.stringify({
                email: providerEmail,
                token: "SFG89VKUG98DPGWJRW4",
              }),
            },
          );
          const tokenJson = await tokenResp.json().catch(() => ({}));
          if (tokenResp.ok && tokenJson?.token) tokenValue = tokenJson.token;
        } catch {}

        // Final response
        return res.status(201).json({
          status: true,
          data: {
            email: providerEmail,
            token: tokenValue,
            kc_id: kcId,
            first_name: dbUser?.first_name ?? first_name ?? null,
            last_name: dbUser?.last_name ?? last_name ?? null,
            avatar_url: dbUser?.avatar_url ?? avatarURL ?? null,
          },
          message: signUpJson?.message || "KingsChat signup successful",
        });
      } catch (err) {
        console.error("kc_signup server_error:", err);
        return res.status(500).json({
          status: false,
          error: "server_error",
          message: "Unexpected error while processing KingsChat signup",
        });
      }
    }),
  );

  // ---------------- Helpers ----------------
  async function nextSeasonPosition(db, seriesId) {
    const { rows } = await db.query(
      `SELECT COALESCE(MAX(position), 0) + 1 AS next FROM seasons WHERE series_id = $1`,
      [seriesId],
    );
    return Number(rows[0]?.next || 1);
  }

  async function nextSeasonMessagePosition(db, seasonId) {
    const { rows } = await db.query(
      `SELECT COALESCE(MAX(position), 0) + 1 AS next FROM season_messages WHERE season_id = $1`,
      [seasonId],
    );
    return Number(rows[0]?.next || 1);
  }

  // ---------------- SEASONS (all input in body) ----------------

  /**
   * POST /pcdl/seasons.get
   * Body: { season_id }
   */
  router.post(
    "/pcdl/seasons.get",
    asyncHandler(async (req, res) => {
      const { season_id } = req.body || {};

      if (!season_id) {
        return res.status(400).json({
          status: false,
          error: "season_id is required",
        });
      }

      const row = await withClient(async (db) => {
        const { rows } = await db.query(
          `SELECT id, series_id, title, status, position
         FROM seasons
         WHERE id = $1
         LIMIT 1`,
          [season_id],
        );
        return rows[0] || null;
      });

      if (!row) {
        return res.status(404).json({
          status: false,
          error: "not_found",
          message: "season not found",
        });
      }

      return res.json({
        status: true,
        data: row,
        season_id,
      });
    }),
  );

  /**
   * POST /pcdl/seasons.list
   * Body: { series_id }
   */
  router.post(
    "/pcdl/seasons.list",
    asyncHandler(async (req, res) => {
      const { series_id } = req.body || {};
      if (!series_id) {
        return res
          .status(400)
          .json({ status: false, error: "series_id is required" });
      }
      const rows = await withClient(async (db) => {
        const { rows } = await db.query(
          `SELECT id, series_id, title, status, position
         FROM seasons
         WHERE series_id = $1
         ORDER BY position ASC NULLS LAST, title ASC`,
          [series_id],
        );
        return rows;
      });
      return res.json({ status: true, data: rows, series_id });
    }),
  );

  /**
   * POST /pcdl/seasons.create
   * Body: { id, series_id, title, status?, position? }
   */
  router.post(
    "/pcdl/seasons.create",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};

      const email = b.email ? String(b.email).trim() : "";
      const token = b.token ? String(b.token).trim() : "";

      const { id, series_id, title } = b || {};
      if (!id || !series_id || !title) {
        return res.status(400).json({
          status: false,
          error: "id, series_id, and title are required",
        });
      }

      const auth = await verifyUserToken(email, token);
      if (!auth.ok)
        return res.status(400).json({
          status: false,
          error: "unauthorized",
          message: "token verification failed",
        });

      const row = await withClient(async (db) => {
        const { rows } = await db.query(
          `SELECT * FROM public.users WHERE email = $1 LIMIT 1`,
          [email],
        );
        return rows[0] || null;
      });

      if (!row.admin) {
        return res.status(400).json({
          status: false,
          error: "unauthorized",
          message: "Not an admin user",
        });
      }

      await withClient(async (db) => {
        const pos =
          b.position !== undefined && b.position !== null && b.position !== ""
            ? Number(b.position)
            : await nextSeasonPosition(db, series_id);

        await db.query(
          `INSERT INTO seasons (id, series_id, title, status, position)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE
         SET series_id=$2, title=$3, status=$4, position=$5`,
          [id, series_id, title, b.status || "Draft", pos],
        );
      });
      return res.status(201).json({ status: true, id, series_id });
    }),
  );

  /**
   * PATCH /pcdl/seasons.update
   * Body: { season_id, title?, status?, position? }
   */
  router.post(
    "/pcdl/seasons.update",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};

      const season_id = b.season_id ? String(b.season_id).trim() : "";
      const email = b.email ? String(b.email).trim() : "";
      const token = b.token ? String(b.token).trim() : "";

      if (!season_id) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "season_id is required",
        });
      }

      const auth = await verifyUserToken(email, token);
      if (!auth.ok) {
        return res.status(401).json({
          status: false,
          error: "unauthorized",
          message: "token verification failed",
        });
      }

      const user = await withClient(async (db) => {
        const { rows } = await db.query(
          `SELECT email, admin FROM public.users WHERE email = $1 LIMIT 1`,
          [email],
        );
        return rows[0] || null;
      });

      if (!user || !user.admin) {
        return res.status(403).json({
          status: false,
          error: "unauthorized",
          message: "Not an admin user",
        });
      }

      const fields = ["title", "status", "position"];
      const sets = [];
      const params = [];

      for (const f of fields) {
        if (b[f] !== undefined) {
          params.push(b[f]);
          sets.push(`${f} = $${params.length}`);
        }
      }

      if (!sets.length) {
        const exists = await withClient(async (db) => {
          const r = await db.query(
            `SELECT id FROM seasons WHERE id = $1 LIMIT 1`,
            [season_id],
          );
          return r.rowCount > 0;
        });

        if (!exists) {
          return res.status(404).json({
            status: false,
            error: "not_found",
            message: "season not found",
          });
        }

        return res.json({
          status: true,
          id: season_id,
          message: "nothing to update",
        });
      }

      params.push(season_id);

      const result = await withClient(async (db) => {
        return db.query(
          `UPDATE seasons SET ${sets.join(", ")} WHERE id = $${params.length}`,
          params,
        );
      });

      if (result.rowCount === 0) {
        return res.status(404).json({
          status: false,
          error: "not_found",
          message: "season not found",
        });
      }

      return res.json({ status: true, id: season_id });
    }),
  );

  /**
   * DELETE /pcdl/seasons.delete
   * Body: { season_id }
   */
  router.post(
    "/pcdl/seasons.delete",
    asyncHandler(async (req, res) => {
      const { season_id, email, token } = req.body || {};
      if (!season_id) {
        return res
          .status(400)
          .json({ status: false, error: "season_id is required" });
      }

      const auth = await verifyUserToken(email, token);
      if (!auth.ok)
        return res.status(400).json({
          status: false,
          error: "unauthorized",
          message: "token verification failed",
        });

      const row = await withClient(async (db) => {
        const { rows } = await db.query(
          `SELECT * FROM public.users WHERE email = $1 LIMIT 1`,
          [email],
        );
        return rows[0] || null;
      });

      if (!row.admin) {
        return res.status(400).json({
          status: false,
          error: "unauthorized",
          message: "Not an admin user",
        });
      }

      const deleted = await withClient(async (db) => {
        await db.query(`DELETE FROM season_messages WHERE season_id = $1`, [
          season_id,
        ]);
        const r = await db.query(`DELETE FROM seasons WHERE id = $1`, [
          season_id,
        ]);
        return r.rowCount;
      });
      if (deleted === 0)
        return res.status(400).json({ status: false, error: "not_found" });
      return res.json({ status: true, id: season_id });
    }),
  );

  // ---------------- SEASON <-> MESSAGES (all input in body) ----------------

  /**
   * POST /pcdl/season_messages.list
   * Body: { season_id }
   */
  router.post(
    "/pcdl/season_messages.list",
    asyncHandler(async (req, res) => {
      const { season_id } = req.body || {};
      if (!season_id) {
        return res
          .status(400)
          .json({ status: false, error: "season_id is required" });
      }
      const rows = await withClient(async (db) => {
        const { rows } = await db.query(
          `SELECT
           m.id, m.series_id, m.title, m.description, m.status, m.thumbnail_url,
           m.video_duration_seconds,
           sm.position,
           mv.video_id, mv.price AS video_price,
           ma.audio_id, ma.price AS audio_price
         FROM season_messages sm
         JOIN messages m ON m.id = sm.message_id
         LEFT JOIN message_video mv ON mv.message_id = m.id
         LEFT JOIN message_audio ma ON ma.message_id = m.id
         WHERE sm.season_id = $1
         ORDER BY sm.position ASC NULLS LAST, m.title ASC`,
          [season_id],
        );
        return rows;
      });
      return res.json({ status: true, data: rows, season_id });
    }),
  );

  /**
   * POST /pcdl/season_messages.add
   * Attach existing OR create+attach a message into a season—scoped by main series.
   *
   * Body (choose one path):
   *  A) Attach existing: { series_id, season_id, message_id, position? }
   *  B) Create+attach: {
   *        series_id, season_id,
   *        id, title, description?, status?, thumbnail_url?, video_duration_seconds?,
   *        video?: { video_id?, price? }, audio?: { audio_id?, price? },
   *        video_id?, video_price?, audio_id?, audio_price?,
   *        position?
   *     }
   */
  router.post(
    "/pcdl/season_messages.add",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const email = b.email ? String(b.email).trim() : "";
      const token = b.token ? String(b.token).trim() : "";

      const series_id = b.series_id ? String(b.series_id).trim() : "";
      const season_id = b.season_id ? String(b.season_id).trim() : "";

      if (!series_id || !season_id) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "series_id and season_id are required",
        });
      }

      const auth = await verifyUserToken(email, token);
      if (!auth.ok) {
        return res.status(401).json({
          status: false,
          error: "unauthorized",
          message: "token verification failed",
        });
      }

      const user = await withClient(async (db) => {
        const { rows } = await db.query(
          `SELECT email, admin FROM public.users WHERE email = $1 LIMIT 1`,
          [email],
        );
        return rows[0] || null;
      });

      if (!user || !user.admin) {
        return res.status(403).json({
          status: false,
          error: "unauthorized",
          message: "Not an admin user",
        });
      }

      let messageId = String(b.message_id || b.id || "").trim();
      if (!messageId && !b.title) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message:
            "Provide message_id to attach, or provide at least { id, title } to create.",
        });
      }

      const cleanLanguageTags = [
        ...new Set(
          (Array.isArray(b.language_tags) ? b.language_tags : [])
            .map((v) => String(v || "").trim())
            .filter(Boolean),
        ),
      ];

      const result = await withClient(async (db) => {
        await db.query("BEGIN");
        try {
          const seasonCheck = await db.query(
            `SELECT 1 FROM seasons WHERE id = $1 AND series_id = $2 LIMIT 1`,
            [season_id, series_id],
          );

          if (seasonCheck.rowCount === 0) {
            await db.query("ROLLBACK");
            return {
              error: {
                statusCode: 404,
                body: {
                  status: false,
                  error: "not_found",
                  message: "Season not found for this series",
                },
              },
            };
          }

          if (cleanLanguageTags.length) {
            const langCheck = await db.query(
              `SELECT id FROM languages WHERE id = ANY($1::text[])`,
              [cleanLanguageTags],
            );

            const validSet = new Set(langCheck.rows.map((r) => String(r.id)));
            const invalidLanguageTags = cleanLanguageTags.filter(
              (tag) => !validSet.has(tag),
            );

            if (invalidLanguageTags.length) {
              await db.query("ROLLBACK");
              return {
                error: {
                  statusCode: 400,
                  body: {
                    status: false,
                    error: "invalid_language_tags",
                    message: "One or more language tags do not exist",
                    invalid_language_tags: invalidLanguageTags,
                  },
                },
              };
            }
          }

          if (!b.message_id) {
            if (!b.id || !b.title) {
              await db.query("ROLLBACK");
              return {
                error: {
                  statusCode: 400,
                  body: {
                    status: false,
                    error: "bad_request",
                    message:
                      "id and title are required to create a new message",
                  },
                },
              };
            }

            await db.query(
              `
              INSERT INTO messages (
                id,
                series_id,
                title,
                description,
                status,
                thumbnail_url,
                video_id,
                video_price,
                phase,
                audio_id,
                audio_price,
                language_tags
              )
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
              ON CONFLICT (id) DO UPDATE
              SET
                series_id = EXCLUDED.series_id,
                title = EXCLUDED.title,
                description = EXCLUDED.description,
                status = EXCLUDED.status,
                thumbnail_url = EXCLUDED.thumbnail_url,
                video_id = EXCLUDED.video_id,
                video_price = EXCLUDED.video_price,
                phase = EXCLUDED.phase,
                audio_id = EXCLUDED.audio_id,
                audio_price = EXCLUDED.audio_price,
                language_tags = EXCLUDED.language_tags
            `,
              [
                b.id,
                series_id,
                b.title,
                b.description || null,
                b.status || "Draft",
                b.thumbnail_url || null,
                b.video_id != null ? b.video_id : null,
                b.video_price != null ? b.video_price : 10,
                b.phase != null ? b.phase : null,
                b.audio_id != null ? b.audio_id : null,
                b.audio_price != null ? b.audio_price : 5,
                JSON.stringify(cleanLanguageTags),
              ],
            );

            messageId = String(b.id).trim();
          } else {
            const msg = await db.query(
              `SELECT series_id FROM messages WHERE id = $1 LIMIT 1`,
              [b.message_id],
            );

            if (msg.rowCount === 0) {
              await db.query("ROLLBACK");
              return {
                error: {
                  statusCode: 404,
                  body: {
                    status: false,
                    error: "not_found",
                    message: "message_id not found",
                  },
                },
              };
            }

            if (msg.rows[0].series_id !== series_id) {
              await db.query("ROLLBACK");
              return {
                error: {
                  statusCode: 400,
                  body: {
                    status: false,
                    error: "bad_request",
                    message:
                      "message series_id does not match the provided series_id",
                  },
                },
              };
            }

            if (Object.prototype.hasOwnProperty.call(b, "language_tags")) {
              await db.query(
                `UPDATE messages SET language_tags = $1::jsonb WHERE id = $2`,
                [JSON.stringify(cleanLanguageTags), b.message_id],
              );
            }
          }

          const pos =
            b.position !== undefined && b.position !== null && b.position !== ""
              ? Number(b.position)
              : await nextSeasonMessagePosition(db, season_id);

          await db.query(
            `
            INSERT INTO season_messages (season_id, message_id, position)
            VALUES ($1,$2,$3)
            ON CONFLICT (season_id, message_id) DO UPDATE
            SET position = EXCLUDED.position
          `,
            [season_id, messageId, pos],
          );

          await db.query("COMMIT");
          return { ok: true, messageId, position: pos };
        } catch (err) {
          await db.query("ROLLBACK");
          throw err;
        }
      });

      if (result?.error) {
        return res.status(result.error.statusCode).json(result.error.body);
      }

      return res.status(201).json({
        status: true,
        series_id,
        season_id,
        message_id: result.messageId,
        position: result.position,
        language_tags: cleanLanguageTags,
      });
    }),
  );

  /**
   * PATCH /pcdl/messages.update
   * Body:
   * {
   *   message_id,
   *   title?,
   *   description?,
   *   status?,
   *   thumbnail_url?,
   *   video_duration_seconds?,
   *   phase?,
   *   video_id?,
   *   video_price?,
   *   audio_id?,
   *   audio_price?,
   *   language_tags?
   * }
   */
  router.post(
    "/pcdl/messages.update",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const message_id = b.message_id ? String(b.message_id).trim() : "";
      const email = b.email ? String(b.email).trim() : "";
      const token = b.token ? String(b.token).trim() : "";

      if (!message_id) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "message_id is required",
        });
      }

      const auth = await verifyUserToken(email, token);
      if (!auth.ok) {
        return res.status(401).json({
          status: false,
          error: "unauthorized",
          message: "token verification failed",
        });
      }

      const user = await withClient(async (db) => {
        const { rows } = await db.query(
          `SELECT email, admin FROM public.users WHERE email = $1 LIMIT 1`,
          [email],
        );
        return rows[0] || null;
      });

      if (!user || !user.admin) {
        return res.status(403).json({
          status: false,
          error: "unauthorized",
          message: "Not an admin user",
        });
      }

      const fields = [
        "title",
        "description",
        "status",
        "thumbnail_url",
        "video_duration_seconds",
        "phase",
        "video_id",
        "video_price",
        "audio_id",
        "audio_price",
      ];

      const sets = [];
      const params = [];

      for (const field of fields) {
        if (Object.prototype.hasOwnProperty.call(b, field)) {
          params.push(b[field]);
          sets.push(`${field} = $${params.length}`);
        }
      }

      const languageTagsProvided = Object.prototype.hasOwnProperty.call(
        b,
        "language_tags",
      );

      const cleanLanguageTags = languageTagsProvided
        ? [
            ...new Set(
              (Array.isArray(b.language_tags) ? b.language_tags : [])
                .map((v) => String(v || "").trim())
                .filter(Boolean),
            ),
          ]
        : [];

      if (languageTagsProvided && cleanLanguageTags.length) {
        const invalidLanguageTags = await withClient(async (db) => {
          const r = await db.query(
            `SELECT id FROM languages WHERE id = ANY($1::text[])`,
            [cleanLanguageTags],
          );
          const validSet = new Set(r.rows.map((row) => String(row.id)));
          return cleanLanguageTags.filter((tag) => !validSet.has(tag));
        });

        if (invalidLanguageTags.length) {
          return res.status(400).json({
            status: false,
            error: "invalid_language_tags",
            message: "One or more language tags do not exist",
            invalid_language_tags: invalidLanguageTags,
          });
        }
      }

      if (languageTagsProvided) {
        params.push(JSON.stringify(cleanLanguageTags));
        sets.push(`language_tags = $${params.length}::jsonb`);
      }

      if (!sets.length) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message:
            "provide at least one updatable field: title, description, status, thumbnail_url, video_duration_seconds, phase, video_id, video_price, audio_id, audio_price, language_tags",
        });
      }

      params.push(message_id);

      const result = await withClient(async (db) => {
        return db.query(
          `UPDATE messages SET ${sets.join(", ")} WHERE id = $${params.length}`,
          params,
        );
      });

      if (result.rowCount === 0) {
        return res.status(404).json({
          status: false,
          error: "not_found",
          message: "message not found",
        });
      }

      return res.json({
        status: true,
        message_id,
        ...(Object.prototype.hasOwnProperty.call(b, "title")
          ? { title: b.title }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(b, "description")
          ? { description: b.description }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(b, "status")
          ? { status: b.status }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(b, "thumbnail_url")
          ? { thumbnail_url: b.thumbnail_url }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(b, "video_duration_seconds")
          ? { video_duration_seconds: b.video_duration_seconds }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(b, "phase")
          ? { phase: b.phase }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(b, "video_id")
          ? { video_id: b.video_id }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(b, "video_price")
          ? { video_price: b.video_price }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(b, "audio_id")
          ? { audio_id: b.audio_id }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(b, "audio_price")
          ? { audio_price: b.audio_price }
          : {}),
        ...(languageTagsProvided ? { language_tags: cleanLanguageTags } : {}),
      });
    }),
  );

  /**
   * DELETE /pcdl/season_messages.delete
   * Body: { season_id, message_id }
   */
  router.post(
    "/pcdl/season_messages.delete",
    asyncHandler(async (req, res) => {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const season_id = b.season_id ? String(b.season_id).trim() : "";
      const message_id = b.message_id ? String(b.message_id).trim() : "";
      const email = b.email ? String(b.email).trim() : "";
      const token = b.token ? String(b.token).trim() : "";

      if (!season_id || !message_id) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "season_id and message_id are required",
        });
      }

      const auth = await verifyUserToken(email, token);
      if (!auth.ok) {
        return res.status(401).json({
          status: false,
          error: "unauthorized",
          message: "token verification failed",
        });
      }

      const user = await withClient(async (db) => {
        const { rows } = await db.query(
          `SELECT email, admin FROM public.users WHERE email = $1 LIMIT 1`,
          [email],
        );
        return rows[0] || null;
      });

      if (!user || !user.admin) {
        return res.status(403).json({
          status: false,
          error: "unauthorized",
          message: "Not an admin user",
        });
      }

      const result = await withClient(async (db) => {
        await db.query("BEGIN");
        try {
          const relationDelete = await db.query(
            `DELETE FROM season_messages WHERE season_id = $1 AND message_id = $2`,
            [season_id, message_id],
          );

          if (relationDelete.rowCount === 0) {
            await db.query("ROLLBACK");
            return { notFound: true };
          }

          await db.query(`DELETE FROM messages WHERE id = $1`, [message_id]);

          await db.query("COMMIT");
          return { notFound: false };
        } catch (err) {
          await db.query("ROLLBACK");
          throw err;
        }
      });

      if (result.notFound) {
        return res.status(404).json({
          status: false,
          error: "not_found",
          message: "season message not found",
        });
      }

      return res.json({
        status: true,
        season_id,
        message_id,
      });
    }),
  );

  // POST /pcdl/admin/lists/messages
  // Body: { id: "newreleases", limit?: 50 }
  // Returns messages from admin_lists.items as full message array
  router.post(
    "/pcdl/lists/messages",
    asyncHandler(async (req, res) => {
      const id = String(req.body?.id ?? "").trim();
      const limit = Number(req.body?.limit ?? 50);

      if (!id) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "id is required",
        });
      }

      const data = await withClient(async (db) => {
        const listResult = await db.query(
          `
          SELECT id, title, type, items
          FROM public.admin_lists
          WHERE id = $1
          LIMIT 1
        `,
          [id],
        );

        const list = listResult.rows[0];

        if (!list) {
          return { notFound: true };
        }

        if (!Array.isArray(list.items)) {
          return {
            list,
            messages: [],
          };
        }

        const messages = await fetchMessagesByIdsPG(db, list.items, limit);

        return {
          list,
          messages,
        };
      });

      if (data.notFound) {
        return res.status(404).json({
          status: false,
          error: "not_found",
          message: "admin list not found",
        });
      }

      return res.json({
        status: true,
        data: data.messages,
        meta: {
          id: data.list.id,
          title: data.list.title,
          type: data.list.type,
          count: data.messages.length,
        },
      });
    }),
  );

  router.post(
    "/pcdl/messages/captions",
    requireAdmin,
    multerSingleCaption(upload),
    asyncHandler(async (req, res) => {
      const message_id = String(req.body?.message_id || "").trim();
      const language_code = String(req.body?.language_code || "")
        .trim()
        .toLowerCase();
      const language_name = req.body?.language_name
        ? String(req.body.language_name).trim()
        : null;

      if (!message_id || !language_code || !req.file) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "message_id, language_code and caption file are required",
        });
      }

      const saved = await saveCaptionFile(message_id, language_code, req.file);
      const segments = parseCaptionFile(saved.raw_text);

      const result = await withClient(async (db) => {
        await db.query("BEGIN");

        try {
          const exists = await db.query(
            `SELECT id FROM public.messages WHERE id = $1 LIMIT 1`,
            [message_id],
          );

          if (exists.rowCount === 0) {
            await db.query("ROLLBACK");
            return { notFound: true };
          }

          const caption = await db.query(
            `
          INSERT INTO public.message_captions
            (message_id, language_code, language_name, file_url, file_format, raw_text, search_vector, updated_at)
          VALUES
            ($1, $2, $3, $4, $5, $6, to_tsvector('simple', unaccent($6)), now())
          ON CONFLICT (message_id, language_code)
          DO UPDATE SET
            language_name = EXCLUDED.language_name,
            file_url = EXCLUDED.file_url,
            file_format = EXCLUDED.file_format,
            raw_text = EXCLUDED.raw_text,
            search_vector = EXCLUDED.search_vector,
            updated_at = now()
          RETURNING *;
          `,
            [
              message_id,
              language_code,
              language_name,
              saved.file_url,
              saved.file_format,
              saved.raw_text,
            ],
          );

          const captionId = caption.rows[0].id;

          await db.query(
            `DELETE FROM public.message_caption_segments WHERE caption_id = $1`,
            [captionId],
          );

          for (const seg of segments) {
            await db.query(
              `
            INSERT INTO public.message_caption_segments
              (caption_id, message_id, language_code, start_seconds, end_seconds, text, search_vector)
            VALUES
              ($1, $2, $3, $4, $5, $6, to_tsvector('simple', unaccent($6)))
            `,
              [
                captionId,
                message_id,
                language_code,
                seg.start_seconds,
                seg.end_seconds,
                seg.text,
              ],
            );
          }

          await db.query("COMMIT");

          return {
            caption: caption.rows[0],
            segments_count: segments.length,
          };
        } catch (err) {
          await db.query("ROLLBACK");
          throw err;
        }
      });

      if (result.notFound) {
        return res.status(404).json({
          status: false,
          error: "message_not_found",
        });
      }

      return res.status(201).json({
        status: true,
        data: result,
      });
    }),
  );

  router.post(
    "/pcdl/messages/captions/get",
    asyncHandler(async (req, res) => {
      const message_id = String(req.body?.message_id || "").trim();
      const language_code = String(req.body?.language_code || "")
        .trim()
        .toLowerCase();

      if (!message_id || !language_code) {
        return res.status(400).json({
          status: false,
          error: "bad_request",
          message: "message_id and language_code are required",
        });
      }

      const data = await withClient(async (db) => {
        const caption = await db.query(
          `
        SELECT *
        FROM public.message_captions
        WHERE message_id = $1 AND language_code = $2
        LIMIT 1
        `,
          [message_id, language_code],
        );

        if (!caption.rows[0]) return null;

        const segments = await db.query(
          `
        SELECT start_seconds, end_seconds, text
        FROM public.message_caption_segments
        WHERE caption_id = $1
        ORDER BY start_seconds ASC NULLS LAST, id ASC
        `,
          [caption.rows[0].id],
        );

        return {
          ...caption.rows[0],
          segments: segments.rows,
        };
      });

      if (!data) {
        return res.status(404).json({
          status: false,
          error: "caption_not_found",
        });
      }

      return res.json({
        status: true,
        data,
      });
    }),
  );

    // ---------------- EXPOSÉ (CORS passthrough for legacy PHP endpoint) ----------------
  const EXPOSE_UPSTREAM_URL =
    "https://pastorchrisdigitallibrary.org/pcdl_app_v6/get_current_expose_details.php";

  // small in-memory cache so we don't hammer the PHP endpoint on every page load
  let exposeCache = { at: 0, data: null };
  const EXPOSE_TTL_MS = 60 * 1000;

  function normalizeExposePayload(raw) {
    const delimiter = raw?.videoDelimiter || "Day";
    const days = Array.isArray(raw?.videos) ? raw.videos : [];

    const videos = [];
    for (const day of days) {
      const payload = Array.isArray(day?.videoPayload) ? day.videoPayload : [];
      payload.forEach((item, i) => {
        videos.push({
          id: item?.contentId || `${day?.id ?? videos.length}-${i}`,
          day: day?.dayAlias ?? day?.id ?? null,
          dateLabel: `${delimiter} ${day?.dayAlias ?? day?.id ?? ""}`.trim(),
          title: item?.title || "",
          description: item?.description || "",
          type: item?.type || "message",
          videoUrl: item?.url || "",
          poster: item?.thumbnail || "",
          completed: Boolean(item?.completed),
        });
      });
    }

    return {
      campaignName: raw?.campaignName || "Exposé",
      videoDelimiter: delimiter,
      avatarURL: raw?.avatarURL || "",
      testimonyURL: raw?.testimonyURL || "",
      studyGuideURL: raw?.studyGuideURL || "",
      quizURL: raw?.quizURL || "",
      completionPercentage: raw?.completionPercentage || "",
      completionPercentageInt: Number(raw?.completionPercentageInt || 0),
      videos,
    };
  }

  // GET /pcdl/expose/current            -> normalized, flat video list
  // GET /pcdl/expose/current?raw=1      -> exact upstream JSON, untouched
  router.get(
    "/pcdl/expose/current",
    asyncHandler(async (req, res) => {
      const wantRaw = String(req.query.raw || "") === "1";

      const fresh = Date.now() - exposeCache.at < EXPOSE_TTL_MS;
      let raw = fresh ? exposeCache.data : null;

      if (!raw) {
        try {
          const resp = await axios.get(EXPOSE_UPSTREAM_URL, {
            timeout: 10000,
            headers: { Accept: "application/json" },
            // upstream sends Content-Type: text/html, so parse defensively
            transformResponse: [
              (d) => {
                if (typeof d !== "string") return d;
                try {
                  return JSON.parse(d);
                } catch {
                  return null;
                }
              },
            ],
          });

          raw = resp?.data || null;
          if (!raw || typeof raw !== "object") {
            return res.status(502).json({
              status: false,
              error: "bad_upstream_payload",
              message: "Exposé endpoint did not return valid JSON",
            });
          }

          exposeCache = { at: Date.now(), data: raw };
        } catch (err) {
          // serve stale data rather than breaking the page
          if (exposeCache.data) {
            raw = exposeCache.data;
          } else {
            return res.status(502).json({
              status: false,
              error: "expose_fetch_failed",
              message:
                err?.response?.data || err.message || "expose request failed",
            });
          }
        }
      }

      res.set("Cache-Control", "public, max-age=60");

      if (wantRaw) {
        return res.json(raw);
      }

      return res.json({ status: true, data: normalizeExposePayload(raw) });
    }),
  );

  // ---------------- Error handler (last) ----------------
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
    res.status(500).json({
      status: false,
      error: "internal_error",
      message: err?.message || "Internal Server Error",
    });
  });

  return router;
};
