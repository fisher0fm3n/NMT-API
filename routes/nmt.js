// routes/nmt.webhooks.routes.js
// Standalone webhook router for NMT-related events.
// Requires server.js to do:
//   const server = http.createServer(app);
//   const io = new Server(server, { ... });
//   app.set("io", io);

const { Router } = require("express");
const { Client } = require("pg");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

/**
 * ---------------------------------------------------------------------------
 * ENV
 * ---------------------------------------------------------------------------
 */
const GENERAL_API_KEY =
  process.env.PCDL_API_KEY ||
  process.env.GENERAL_API_KEY ||
  "ee115610-738b-4e7b-97e2-446468ba550c";

const PCDL_FN_REGISTRATION_TABLE =
  process.env.PCDL_FN_REGISTRATION_TABLE || "pcdl_fn_registration";

const PCDL_FN_TRANSLATORS_TABLE =
  process.env.PCDL_FN_TRANSLATORS_TABLE || "pcdl_fn_translators";

const PCDL_FN_ADMINS_TABLE =
  process.env.PCDL_FN_ADMINS_TABLE || "pcdl_fn_admins";

/**
 * ---------------------------------------------------------------------------
 * PRIVATE upload storage
 * ---------------------------------------------------------------------------
 */
const UPLOAD_ROOT = path.join(process.cwd(), "uploads");
const PCO_FN_ROOT = path.join(UPLOAD_ROOT, "pco_fn");
const TRANSLATORS_PICTURE_DIR = path.join(PCO_FN_ROOT, "translators");

fs.mkdirSync(TRANSLATORS_PICTURE_DIR, { recursive: true });

const MAX_TRANSLATOR_PICTURE_BYTES = 1024 * 1024; // 1MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_TRANSLATOR_PICTURE_BYTES },
  fileFilter: (_req, file, cb) => {
    const ok = new Set(["image/jpeg", "image/png", "image/webp"]).has(
      file.mimetype,
    );
    if (!ok) return cb(new Error("Only JPG, PNG, or WEBP images are allowed"));
    cb(null, true);
  },
});

// Reusable wrapper to convert Multer's size error to a friendly message
function translatorPictureUpload(field = "picture") {
  return (req, res, next) => {
    upload.single(field)(req, res, (err) => {
      if (!err) return next();
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          status: false,
          error: "upload_error",
          message: "picture must be ≤ 1MB",
        });
      }
      return res.status(400).json({
        status: false,
        error: "upload_error",
        message: err.message || "upload failed",
      });
    });
  };
}

/**
 * ---------------------------------------------------------------------------
 * DB
 * ---------------------------------------------------------------------------
 */
function newClient() {
  return new Client({
    user: process.env.PCO_FN_DB_USER || "postgres",
    host: process.env.PCO_FN_DB_HOST || "102.219.189.166",
    database: process.env.PCO_FN_DB_NAME || "pco_fn",
    password: process.env.PCO_FN_DB_PASSWORD || "B8Mgs81D58eTub9GhnO2FOp2",
    port: Number(process.env.PCO_FN_DB_PORT || 5432),
  });
}

async function withClient(fn) {
  const db = newClient();
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

let schemaReadyPromise = null;

/**
 * ---------------------------------------------------------------------------
 * SCHEMA
 * ---------------------------------------------------------------------------
 */
async function ensureSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = withClient(async (db) => {
      // registrations
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.${PCDL_FN_REGISTRATION_TABLE} (
          id BIGSERIAL PRIMARY KEY,
          title VARCHAR(50) NOT NULL,
          first_name VARCHAR(191) NOT NULL,
          surname VARCHAR(191) NOT NULL,
          email_address VARCHAR(191) NOT NULL,
          country VARCHAR(191) NOT NULL,
          phone_number VARCHAR(100) NOT NULL,
          gender VARCHAR(50) NOT NULL,
          ministry_name VARCHAR(255) NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);

      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_${PCDL_FN_REGISTRATION_TABLE}_email
        ON public.${PCDL_FN_REGISTRATION_TABLE} (lower(email_address));
      `);

      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_${PCDL_FN_REGISTRATION_TABLE}_country
        ON public.${PCDL_FN_REGISTRATION_TABLE} (country);
      `);

      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_${PCDL_FN_REGISTRATION_TABLE}_phone
        ON public.${PCDL_FN_REGISTRATION_TABLE} (phone_number);
      `);

      await db.query(`
        CREATE OR REPLACE FUNCTION public.set_${PCDL_FN_REGISTRATION_TABLE}_updated_at()
        RETURNS trigger AS $$
        BEGIN
          NEW.updated_at = now();
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);

      await db.query(`
        DROP TRIGGER IF EXISTS trg_${PCDL_FN_REGISTRATION_TABLE}_updated_at
        ON public.${PCDL_FN_REGISTRATION_TABLE};
      `);

      await db.query(`
        CREATE TRIGGER trg_${PCDL_FN_REGISTRATION_TABLE}_updated_at
        BEFORE UPDATE ON public.${PCDL_FN_REGISTRATION_TABLE}
        FOR EACH ROW
        EXECUTE FUNCTION public.set_${PCDL_FN_REGISTRATION_TABLE}_updated_at();
      `);

      // translators
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.${PCDL_FN_TRANSLATORS_TABLE} (
          id BIGSERIAL PRIMARY KEY,
          title VARCHAR(50) NOT NULL,
          first_name VARCHAR(191) NOT NULL,
          surname VARCHAR(191) NOT NULL,
          gender VARCHAR(50) NOT NULL,
          email_address VARCHAR(191) NOT NULL,
          phone_number VARCHAR(100) NOT NULL,
          country VARCHAR(191) NOT NULL,
          first_language VARCHAR(191) NOT NULL,
          english_fluency BOOLEAN NOT NULL,
          english_fluency_label TEXT NOT NULL,
          translation_language VARCHAR(191) NOT NULL,
          picture_path TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);

      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_${PCDL_FN_TRANSLATORS_TABLE}_email
        ON public.${PCDL_FN_TRANSLATORS_TABLE} (lower(email_address));
      `);

      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_${PCDL_FN_TRANSLATORS_TABLE}_country
        ON public.${PCDL_FN_TRANSLATORS_TABLE} (country);
      `);

      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_${PCDL_FN_TRANSLATORS_TABLE}_translation_language
        ON public.${PCDL_FN_TRANSLATORS_TABLE} (translation_language);
      `);

      await db.query(`
        CREATE OR REPLACE FUNCTION public.set_${PCDL_FN_TRANSLATORS_TABLE}_updated_at()
        RETURNS trigger AS $$
        BEGIN
          NEW.updated_at = now();
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);

      await db.query(`
        DROP TRIGGER IF EXISTS trg_${PCDL_FN_TRANSLATORS_TABLE}_updated_at
        ON public.${PCDL_FN_TRANSLATORS_TABLE};
      `);

      await db.query(`
        CREATE TRIGGER trg_${PCDL_FN_TRANSLATORS_TABLE}_updated_at
        BEFORE UPDATE ON public.${PCDL_FN_TRANSLATORS_TABLE}
        FOR EACH ROW
        EXECUTE FUNCTION public.set_${PCDL_FN_TRANSLATORS_TABLE}_updated_at();
      `);

      // admins table
      // id stores the admin email according to your note
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.${PCDL_FN_ADMINS_TABLE} (
          id TEXT PRIMARY KEY,
          name TEXT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);

      await db.query(`
        CREATE OR REPLACE FUNCTION public.set_${PCDL_FN_ADMINS_TABLE}_updated_at()
        RETURNS trigger AS $$
        BEGIN
          NEW.updated_at = now();
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);

      await db.query(`
        DROP TRIGGER IF EXISTS trg_${PCDL_FN_ADMINS_TABLE}_updated_at
        ON public.${PCDL_FN_ADMINS_TABLE};
      `);

      await db.query(`
        CREATE TRIGGER trg_${PCDL_FN_ADMINS_TABLE}_updated_at
        BEFORE UPDATE ON public.${PCDL_FN_ADMINS_TABLE}
        FOR EACH ROW
        EXECUTE FUNCTION public.set_${PCDL_FN_ADMINS_TABLE}_updated_at();
      `);

      console.log("[nmt webhooks] postgres schema ready");
    });
  }

  return schemaReadyPromise;
}

/**
 * ---------------------------------------------------------------------------
 * HELPERS
 * ---------------------------------------------------------------------------
 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function hasGeneralApiKey(req) {
  return (req.header("x-api-key") || "").trim() === GENERAL_API_KEY;
}

function requireApiKey(req, res, next) {
  if (!GENERAL_API_KEY) return next();

  const incoming =
    req.header("x-api-key") ||
    req
      .header("authorization")
      ?.replace(/^Bearer\s+/i, "")
      .trim();

  if (!incoming || incoming !== GENERAL_API_KEY) {
    return res.status(401).json({
      status: false,
      error: "unauthorized_api_key",
      message: "Unauthorized",
    });
  }

  next();
}

function trimString(v) {
  return typeof v === "string" ? v.trim() : v;
}

function trimAllStrings(obj) {
  if (!obj || typeof obj !== "object") return obj;

  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object" && !Buffer.isBuffer(v)) {
      out[k] = trimAllStrings(v);
    } else {
      out[k] = trimString(v);
    }
  }
  return out;
}

function cleanText(input) {
  return String(input || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEmail(email) {
  return cleanText(email).toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function normalizeEnglishFluency(value) {
  if (typeof value === "boolean") {
    return {
      value,
      label: value
        ? "Yes - I speak & write English fluently"
        : "No - I don't speak & write English fluently",
    };
  }

  const s = cleanText(value).toLowerCase();

  if (
    [
      "yes",
      "true",
      "1",
      "yes - i speak & write english fluently",
      "yes - i speak and write english fluently",
      "i speak & write english fluently",
      "i speak and write english fluently",
    ].includes(s)
  ) {
    return {
      value: true,
      label: "Yes - I speak & write English fluently",
    };
  }

  if (
    [
      "no",
      "false",
      "0",
      "no - i don't speak & write english fluently",
      "no - i dont speak & write english fluently",
      "no - i do not speak & write english fluently",
      "no - i don't speak and write english fluently",
      "no - i do not speak and write english fluently",
    ].includes(s)
  ) {
    return {
      value: false,
      label: "No - I don't speak & write English fluently",
    };
  }

  return null;
}

function getAdminEmail(req) {
  const body = req.body || {};
  const query = req.query || {};

  return normalizeEmail(
    body.admin_email ||
      body.email ||
      query.admin_email ||
      query.email ||
      req.header("x-admin-email") ||
      "",
  );
}

async function isFnAdmin(db, email) {
  if (!email) return false;

  const r = await db.query(
    `
    SELECT 1
    FROM public.${PCDL_FN_ADMINS_TABLE}
    WHERE lower(id) = lower($1)
    LIMIT 1
    `,
    [email],
  );

  return r.rowCount > 0;
}

/**
 * ---------------------------------------------------------------------------
 * ROUTER
 * ---------------------------------------------------------------------------
 */
module.exports = function nmtWebhookRoutes() {
  const router = Router();

  // 1) Generic NMT webhook
  router.post(
    "/nmt/webhook",
    requireApiKey,
    asyncHandler(async (req, res) => {
      const io = req.app.get("io");
      const body = trimAllStrings(req.body || {});
      const eventName =
        (body.event && String(body.event).trim()) || "generic_event";

      const payload = {
        event: eventName,
        data: body.data ?? body,
        receivedAt: new Date().toISOString(),
        ip: req.ip,
        userAgent: req.get("user-agent") || null,
      };

      console.log("[nmt webhook] /nmt/webhook:", payload);

      if (io) {
        io.emit("nmt_webhook", payload);
      }

      return res.status(200).json({
        status: true,
        message: "nmt_webhook_received",
        event: eventName,
      });
    }),
  );

  // 2) Transaction-specific NMT webhook
  router.post(
    "/nmt/webhook/transactions",
    requireApiKey,
    asyncHandler(async (req, res) => {
      const io = req.app.get("io");
      const body = req.body || {};

      const payload = {
        type: "transaction",
        receivedAt: new Date().toISOString(),
        data: body,
        ip: req.ip,
        userAgent: req.get("user-agent") || null,
      };

      console.log("[nmt webhook] /nmt/webhook/transactions:", payload);

      if (io) {
        io.emit("nmt_transaction_webhook", payload);
      }

      return res.status(200).json({
        status: true,
        message: "nmt_transaction_webhook_received",
      });
    }),
  );

  // 3) User-specific NMT webhook
  router.post(
    "/nmt/webhook/users",
    requireApiKey,
    asyncHandler(async (req, res) => {
      const io = req.app.get("io");
      const body = trimAllStrings(req.body || {});
      const email =
        typeof body.email === "string" ? body.email.trim().toLowerCase() : null;

      const payload = {
        type: "user",
        receivedAt: new Date().toISOString(),
        email,
        data: body,
        ip: req.ip,
        userAgent: req.get("user-agent") || null,
      };

      console.log("[nmt webhook] /nmt/webhook/users:", payload);

      if (io) {
        io.emit("nmt_user_webhook", payload);
      }

      return res.status(200).json({
        status: true,
        message: "nmt_user_webhook_received",
      });
    }),
  );

  // 4) Simple test NMT webhook
  router.post(
    "/nmt/webhook/test",
    requireApiKey,
    asyncHandler(async (req, res) => {
      const io = req.app.get("io");

      const payload = {
        type: "test",
        receivedAt: new Date().toISOString(),
        data: req.body || {},
      };

      console.log("[nmt webhook] /nmt/webhook/test:", payload);

      if (io) {
        io.emit("nmt_webhook_test", payload);
      }

      return res.status(200).json({
        status: true,
        message: "nmt_test_webhook_received",
      });
    }),
  );

  // 5) FN registration submission
  router.post(
    "/nmt/pco_fn/registration",
    asyncHandler(async (req, res) => {
      await ensureSchema();

      const io = req.app.get("io");
      const body = trimAllStrings(req.body || {});

      const title = cleanText(body.title || "");
      const firstName = cleanText(body.first_name || body.firstName || "");
      const surname = cleanText(body.surname || "");
      const emailAddress = normalizeEmail(
        body.email_address || body.email || "",
      );
      const country = cleanText(body.country || "");
      const phoneNumber = cleanText(body.phone_number || body.phone || "");
      const gender = cleanText(body.gender || "");
      const ministryName = cleanText(
        body.ministry_name ||
          body.ministry ||
          body.name_of_ministry_fellowship_outreach_evangelical_group ||
          "",
      );

      const errors = {};

      if (!title) errors.title = "Title is required";
      if (!firstName) errors.first_name = "First Name is required";
      if (!surname) errors.surname = "Surname is required";

      if (!emailAddress) {
        errors.email_address = "Email address is required";
      } else if (!isValidEmail(emailAddress)) {
        errors.email_address = "Email address is invalid";
      }

      if (!country) errors.country = "Country is required";
      if (!phoneNumber) errors.phone_number = "Phone number is required";
      if (!gender) errors.gender = "Gender is required";
      if (!ministryName) {
        errors.ministry_name =
          "Name of ministry/fellowship/Outreach/Evangelical group is required";
      }

      if (Object.keys(errors).length > 0) {
        return res.status(400).json({
          status: false,
          message: "Validation failed",
          errors,
        });
      }

      const saved = await withClient(async (db) => {
        const r = await db.query(
          `
          INSERT INTO public.${PCDL_FN_REGISTRATION_TABLE} (
            title,
            first_name,
            surname,
            email_address,
            country,
            phone_number,
            gender,
            ministry_name
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING *
          `,
          [
            title,
            firstName,
            surname,
            emailAddress,
            country,
            phoneNumber,
            gender,
            ministryName,
          ],
        );

        return r.rows[0];
      });

      const payload = {
        type: "pcdl_fn_registration",
        registrationId: Number(saved.id),
        receivedAt: new Date().toISOString(),
        data: {
          id: Number(saved.id),
          title: saved.title,
          first_name: saved.first_name,
          surname: saved.surname,
          email_address: saved.email_address,
          country: saved.country,
          phone_number: saved.phone_number,
          gender: saved.gender,
          ministry_name: saved.ministry_name,
          created_at: saved.created_at,
          updated_at: saved.updated_at,
        },
        ip: req.ip,
        userAgent: req.get("user-agent") || null,
      };

      console.log("[nmt webhook] /nmt/pco_fn/registration:", payload);

      if (io) {
        io.emit("pcdl_fn_registration_created", payload);
      }

      return res.status(201).json({
        status: true,
        message: "Registration submitted successfully",
        data: payload.data,
      });
    }),
  );

  // 6) FN translators submission
  // multipart/form-data
  // picture field: picture
  router.post(
    "/nmt/pco_fn/translators",
    translatorPictureUpload("picture"),
    asyncHandler(async (req, res) => {
      await ensureSchema();

      const io = req.app.get("io");
      req.body = trimAllStrings(req.body || {});
      const body = req.body || {};

      const title = cleanText(body.title || "");
      const firstName = cleanText(body.first_name || body.firstName || "");
      const surname = cleanText(body.surname || "");
      const gender = cleanText(body.gender || "");
      const emailAddress = normalizeEmail(
        body.email_address || body.email || "",
      );
      const phoneNumber = cleanText(body.phone_number || body.phone || "");
      const country = cleanText(body.country || "");
      const firstLanguage = cleanText(
        body.first_language ||
          body.firstLanguage ||
          body.what_is_your_first_language ||
          "",
      );

      const englishFluencyInput =
        body.english_fluency ??
        body.speaks_writes_english_fluently ??
        body.do_you_speak_write_english_fluently ??
        "";

      const englishFluency = normalizeEnglishFluency(englishFluencyInput);

      const translationLanguage = cleanText(
        body.translation_language ||
          body.language_to_translate_to ||
          body.what_language_will_you_like_to_translate_pastor_chris_messages_into ||
          "",
      );

      const errors = {};

      if (!title) errors.title = "Title is required";
      if (!firstName) errors.first_name = "First Name is required";
      if (!surname) errors.surname = "Surname is required";
      if (!gender) errors.gender = "Gender is required";

      if (!emailAddress) {
        errors.email_address = "Email address is required";
      } else if (!isValidEmail(emailAddress)) {
        errors.email_address = "Email address is invalid";
      }

      if (!phoneNumber) {
        errors.phone_number = "Phone number is required";
      }
      if (!country) errors.country = "Country is required";
      if (!firstLanguage) {
        errors.first_language = "First Language is required";
      }
      if (!englishFluency) {
        errors.english_fluency = "English fluency answer is required";
      }
      if (!translationLanguage) {
        errors.translation_language = "Translation language is required";
      }
      if (!req.file) {
        errors.picture = "Picture upload is required";
      }

      if (Object.keys(errors).length > 0) {
        return res.status(400).json({
          status: false,
          message: "Validation failed",
          errors,
        });
      }

      const safeEmail = emailAddress.replace(/[^a-zA-Z0-9._-]/g, "_");
      const ext =
        req.file.mimetype === "image/png"
          ? ".png"
          : req.file.mimetype === "image/webp"
            ? ".webp"
            : ".jpg";

      const filename = `${safeEmail}_${Date.now()}${ext}`;
      const absoluteFilePath = path.join(TRANSLATORS_PICTURE_DIR, filename);
      const storedPicturePath = `/uploads/pco_fn/translators/${filename}`;

      await fs.promises.writeFile(absoluteFilePath, req.file.buffer);

      const saved = await withClient(async (db) => {
        const r = await db.query(
          `
          INSERT INTO public.${PCDL_FN_TRANSLATORS_TABLE} (
            title,
            first_name,
            surname,
            gender,
            email_address,
            phone_number,
            country,
            first_language,
            english_fluency,
            english_fluency_label,
            translation_language,
            picture_path
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          RETURNING *
          `,
          [
            title,
            firstName,
            surname,
            gender,
            emailAddress,
            phoneNumber,
            country,
            firstLanguage,
            englishFluency.value,
            englishFluency.label,
            translationLanguage,
            storedPicturePath,
          ],
        );

        return r.rows[0];
      });

      const payload = {
        type: "pcdl_fn_translator",
        translatorId: Number(saved.id),
        receivedAt: new Date().toISOString(),
        data: {
          id: Number(saved.id),
          title: saved.title,
          first_name: saved.first_name,
          surname: saved.surname,
          gender: saved.gender,
          email_address: saved.email_address,
          phone_number: saved.phone_number,
          country: saved.country,
          first_language: saved.first_language,
          english_fluency: saved.english_fluency,
          english_fluency_label: saved.english_fluency_label,
          translation_language: saved.translation_language,
          picture_path: saved.picture_path,
          created_at: saved.created_at,
          updated_at: saved.updated_at,
        },
        ip: req.ip,
        userAgent: req.get("user-agent") || null,
      };

      console.log("[nmt webhook] /nmt/pco_fn/translators:", payload);

      if (io) {
        io.emit("pcdl_fn_translator_created", payload);
      }

      return res.status(201).json({
        status: true,
        message: "Translator submitted successfully",
        data: payload.data,
      });
    }),
  );

  // 7) Return registrations
  // admin email can come from:
  // - body.admin_email
  // - body.email
  // - query.admin_email
  // - query.email
  // - x-admin-email header
  router.post(
    "/nmt/pco_fn/registrations",
    asyncHandler(async (req, res) => {
      await ensureSchema();

      req.body = trimAllStrings(req.body || {});
      const adminEmail = getAdminEmail(req);

      if (!adminEmail || !isValidEmail(adminEmail)) {
        return res.status(400).json({
          status: false,
          error: "admin_email_required",
          message: "A valid admin email is required",
        });
      }

      const limit = Math.max(
        1,
        Math.min(200, Number(req.body?.limit || req.query?.limit || 50)),
      );
      const offset = Math.max(
        0,
        Number(req.body?.offset || req.query?.offset || 0),
      );
      const q = cleanText(req.body?.q || req.query?.q || "");

      const result = await withClient(async (db) => {
        const adminOk = await isFnAdmin(db, adminEmail);
        if (!adminOk) return { unauthorized: true };

        const params = [];
        const whereParts = [];

        if (q) {
          params.push(`%${q}%`);
          const p = `$${params.length}`;
          whereParts.push(`
            (
              title ILIKE ${p}
              OR first_name ILIKE ${p}
              OR surname ILIKE ${p}
              OR email_address ILIKE ${p}
              OR country ILIKE ${p}
              OR phone_number ILIKE ${p}
              OR gender ILIKE ${p}
              OR ministry_name ILIKE ${p}
            )
          `);
        }

        const whereSql = whereParts.length
          ? `WHERE ${whereParts.join(" AND ")}`
          : "";

        params.push(limit, offset);
        const limitIdx = params.length - 1;
        const offsetIdx = params.length;

        const sql = `
          SELECT
            id,
            title,
            first_name,
            surname,
            email_address,
            country,
            phone_number,
            gender,
            ministry_name,
            created_at,
            updated_at,
            COUNT(*) OVER() AS __total_count
          FROM public.${PCDL_FN_REGISTRATION_TABLE}
          ${whereSql}
          ORDER BY created_at DESC, id DESC
          LIMIT $${limitIdx} OFFSET $${offsetIdx}
        `;

        const r = await db.query(sql, params);
        return { rows: r.rows };
      });

      if (result.unauthorized) {
        return res.status(403).json({
          status: false,
          error: "not_admin",
          message: "You are not authorized to view registrations",
        });
      }

      const rows = result.rows || [];
      const total = rows.length ? Number(rows[0].__total_count || 0) : 0;
      const data = rows.map(({ __total_count, ...row }) => row);

      return res.json({
        status: true,
        admin_email: adminEmail,
        total,
        limit,
        offset,
        q: q || null,
        data,
      });
    }),
  );

  // health / ping
  router.get(
    "/nmt/webhook/ping",
    asyncHandler(async (_req, res) => {
      res.json({ status: true, message: "nmt webhooks alive" });
    }),
  );

  // schema / table test
  router.get(
    "/nmt/pcdl/fn-registration/test",
    requireApiKey,
    asyncHandler(async (_req, res) => {
      await ensureSchema();

      const out = await withClient(async (db) => {
        const registrations = await db.query(
          `SELECT COUNT(*)::bigint AS total FROM public.${PCDL_FN_REGISTRATION_TABLE}`,
        );
        const translators = await db.query(
          `SELECT COUNT(*)::bigint AS total FROM public.${PCDL_FN_TRANSLATORS_TABLE}`,
        );
        const admins = await db.query(
          `SELECT COUNT(*)::bigint AS total FROM public.${PCDL_FN_ADMINS_TABLE}`,
        );

        return {
          registrations: Number(registrations.rows[0]?.total || 0),
          translators: Number(translators.rows[0]?.total || 0),
          admins: Number(admins.rows[0]?.total || 0),
        };
      });

      return res.json({
        status: true,
        database: process.env.PCO_FN_DB_NAME || "pco_fn",
        tables: {
          registrations: PCDL_FN_REGISTRATION_TABLE,
          translators: PCDL_FN_TRANSLATORS_TABLE,
          admins: PCDL_FN_ADMINS_TABLE,
        },
        totals: out,
      });
    }),
  );

  router.use((err, _req, res, _next) => {
    console.error("[nmt webhooks] error:", err.stack || err);

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

    router.post(
    "/miniapp/pcdl/login",
    asyncHandler(async (req, res) => {
      const { code, origin } = req.body || {};
      return res.status(200).json({
        status: true,
        message: "Espees Login Successful",
        code,
      });
    }),
  );

  router.post(
    "/miniapp/espees/login",
    asyncHandler(async (req, res) => {
      const { code, origin } = req.body || {};
      return res.status(200).json({
        status: true,
        message: "Espees Login Successful",
        code,
      });
    }),
  );

  router.post(
    "/miniapp/espeecart/login",
    asyncHandler(async (req, res) => {
      const { code, origin } = req.body || {};
      return res.status(200).json({
        status: true,
        message: "Espees Login Successful",
        code,
      });
    }),
  );

  router.post(
    "/nmt/espees/login",
    asyncHandler(async (req, res) => {
      const CLIENT_ID = "db669cb7-8697-439e-add0-38024aec691b";
      const TOKEN_URL = "https://connect.kingsch.at/developer/api/oauth2/token";

      const { code, origin } = req.body || {};

      if (!code) {
        return res.status(400).json({
          status: false,
          message: "Missing authorization code",
        });
      }

      try {
        const tokenResponse = await fetch(TOKEN_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            grant_type: "code",
            client_id: CLIENT_ID,
            code,
          }),
        });

        const rawText = await tokenResponse.text();

        let tokenData;
        try {
          tokenData = rawText ? JSON.parse(rawText) : {};
        } catch {
          tokenData = { raw: rawText };
        }

        if (!tokenResponse.ok) {
          console.error("KingsChat token exchange failed:", {
            status: tokenResponse.status,
            body: tokenData,
          });

          return res.status(tokenResponse.status).json({
            status: false,
            message: "Failed to exchange authorization code",
            error: tokenData,
          });
        }

        const accessToken = tokenData.access_token;
        const refreshToken = tokenData.refresh_token;
        const expiresInMillis = tokenData.expires_in_millis;

        if (!accessToken || !refreshToken) {
          return res.status(500).json({
            status: false,
            message: "Token response missing access or refresh token",
            data: tokenData,
          });
        }

        return res.status(200).json({
          status: true,
          message: "Espees Login Successful",
          accessToken,
          refreshToken,
          expiresInMillis,
          origin: origin || null,
        });
      } catch (err) {
        console.error("Espees login callback error:", err);

        return res.status(500).json({
          status: false,
          message: "Login handler error",
          error: err?.message || "Unknown login error",
        });
      }
    }),
  );

  router.post(
    "/miniapp/kingsspace/login",
    asyncHandler(async (req, res) => {
      const { code, origin } = req.body || {};
      return res.status(200).json({
        status: true,
        message: "Espees Login Successful",
        code,
      });
    }),
  );

  //   router.post(
  //   "/miniapp/kingsspace/login",
  //   asyncHandler(async (req, res) => {
  //     const CLIENT_ID = "f610b805-61ac-4a5f-811c-12e64c637a64";
  //     const TOKEN_URL = "https://connect.kingsch.at/developer/api/oauth2/token";

  //     const { code, origin } = req.body || {};

  //     if (!code) {
  //       return res.status(400).json({
  //         status: false,
  //         message: "Missing authorization code",
  //       });
  //     }

  //     try {
  //       const tokenResponse = await fetch(TOKEN_URL, {
  //         method: "POST",
  //         headers: {
  //           "Content-Type": "application/json",
  //         },
  //         body: JSON.stringify({
  //           grant_type: "code",
  //           client_id: CLIENT_ID,
  //           code,
  //         }),
  //       });

  //       const rawText = await tokenResponse.text();

  //       let tokenData;
  //       try {
  //         tokenData = rawText ? JSON.parse(rawText) : {};
  //       } catch {
  //         tokenData = { raw: rawText };
  //       }

  //       if (!tokenResponse.ok) {
  //         console.error("KingsChat token exchange failed:", {
  //           status: tokenResponse.status,
  //           body: tokenData,
  //         });

  //         return res.status(tokenResponse.status).json({
  //           status: false,
  //           message: "Failed to exchange authorization code",
  //           error: tokenData,
  //         });
  //       }

  //       const accessToken = tokenData.access_token;
  //       const refreshToken = tokenData.refresh_token;
  //       const expiresInMillis = tokenData.expires_in_millis;

  //       if (!accessToken || !refreshToken) {
  //         return res.status(500).json({
  //           status: false,
  //           message: "Token response missing access or refresh token",
  //           data: tokenData,
  //         });
  //       }

  //       return res.status(200).json({
  //         status: true,
  //         message: "Espees Login Successful",
  //         accessToken,
  //         refreshToken,
  //         expiresInMillis,
  //         origin: origin || null,
  //       });
  //     } catch (err) {
  //       console.error("Espees login callback error:", err);

  //       return res.status(500).json({
  //         status: false,
  //         message: "Login handler error",
  //         error: err?.message || "Unknown login error",
  //       });
  //     }
  //   }),
  // );

  router.post(
    "/nmt/pcdl/login",
    asyncHandler(async (req, res) => {
      const { accessToken, refreshToken } = req.body || {};

      if (!accessToken || !refreshToken) {
        return res.status(400).json({
          status: false,
          message: "Missing tokens",
        });
      }

      try {
        // Fetch KingsChat profile
        const response = await fetch(
          "https://connect.kingsch.at/developer/api/profile",
          {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
          },
        );

        if (response.status !== 200) {
          const errorBody = await response.text();

          throw new Error(
            `Failed to fetch profile (Status ${response.status}): ${errorBody}`,
          );
        }

        const kcData = await response.json();
        const profileId = kcData?.profile?.id;

        if (!profileId) {
          throw new Error("No ID returned from KingsChat profile API.");
        }

        const safeProfileId = String(profileId)
          .replace(/\\/g, "\\\\")
          .replace(/'/g, "\\'");

        const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Redirecting...</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />

            <script>
              window.onload = function () {
                setTimeout(function () {
                  if (
                    window.ReactNativeWebView &&
                    window.ReactNativeWebView.postMessage
                  ) {
                    window.ReactNativeWebView.postMessage(
                      JSON.stringify({
                        type: 'login',
                        profileId: '${safeProfileId}'
                      })
                    );
                  }
                }, 300);
              };
            </script>
          </head>

          <body>
            <h2 style="text-align:center;margin-top:40vh;"></h2>
          </body>
        </html>
      `;

        return res.status(200).send(html);
      } catch (err) {
        console.error("KingsChat profile login error:", err);
        console.error("AccessToken:", accessToken);

        const safeMessage = (
          err && err.message ? String(err.message) : "Unknown login error"
        )
          .replace(/\\/g, "\\\\")
          .replace(/'/g, "\\'")
          .replace(/\n/g, "\\n")
          .replace(/\r/g, "\\r")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");

        const errorHtml = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Login Failed</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />

            <script>
              window.onload = function () {
                var payload = {
                  type: 'login_error',
                  message: '${safeMessage}'
                };

                if (
                  window.ReactNativeWebView &&
                  window.ReactNativeWebView.postMessage
                ) {
                  window.ReactNativeWebView.postMessage(
                    JSON.stringify(payload)
                  );
                }
              };
            </script>
          </head>

          <body></body>
        </html>
      `;

        return res.status(500).send(errorHtml);
      }
    }),
  );

  return router;
};
