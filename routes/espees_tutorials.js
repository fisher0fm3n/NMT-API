// EspeesMax tutorial videos: the list the web app (web.espees.org) and the
// mobile app show as the "Learning path". Kept in Mongo so the videos can be
// changed without shipping either app.
//
// Public (no key):
//   GET    /nmt/espees/tutorials              published videos, in step order
//   GET    /nmt/espees/tutorials/:slug        one published video
//
// Managing the list (no key required):
//   GET    /nmt/espees/admin/tutorials        every video, published or not
//   POST   /nmt/espees/admin/tutorials        add a video
//   PATCH  /nmt/espees/admin/tutorials/:slug  change some fields of a video
//   DELETE /nmt/espees/admin/tutorials/:slug  remove a video
//   PUT    /nmt/espees/admin/tutorials/order  { slugs: [...] } renumbers steps 1..n
//   POST   /nmt/espees/admin/tutorials/seed   adds the original seven videos that are missing
//
// Every reply is { status: true, data } or { status: false, error, message }.
// The full contract is in ESPEES_TUTORIALS_API.md.

const { Router } = require("express");
const { asyncHandler } = require("../lib/utils");

const COLLECTION = "espees_tutorials";
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// The fields a video has, and what each accepts. Anything else in a request is ignored.
const LIMITS = {
  slug: 80,
  title: 120,
  summary: 240,
  description: 2000,
  outcomes: 10,
  outcome: 240,
  relatedLinks: 8,
  linkLabel: 60,
  linkHref: 500,
  url: 1000,
  step: 999,
  durationSeconds: 36000,
};

const MEDIA = "https://d1zx0zj5kmre28.cloudfront.net/videos/espeesmax";
const media = (file) => `${MEDIA}/${encodeURIComponent(file)}`;

// The series as first published. POST .../seed adds whichever of these are missing,
// so it is safe to run again and never overwrites an edited video.
const DEFAULT_TUTORIALS = [
  {
    step: 1,
    slug: "before-you-begin",
    title: "Before you begin",
    summary: "What you need in place before setting up EspeesMax.",
    description:
      "A quick orientation before you set anything up. Learn what EspeesMax is, what you need to get started, and how the steps in this series fit together.",
    outcomes: [
      "Understand what Espees are and what EspeesMax lets you do",
      "Know what to have ready: a KingsChat account or email, a phone and a valid card",
      "Follow the set-up journey in the right order",
    ],
    relatedLinks: [
      { label: "About Espees", href: "/about" },
      { label: "Create an account", href: "/login" },
    ],
    poster: media("01_before_you_begin.jpg"),
    video: media("ESPEES_MAX_1_SET_UP.mp4"),
    durationSeconds: 33,
  },
  {
    step: 2,
    slug: "download-and-connect",
    title: "Download & connect",
    summary: "Install the app, sign in and connect your wallet.",
    description:
      "Get the EspeesMax app from the Loveworld Appstore, sign in with KingsChat or your email, and connect your Espees wallet so your balance and transactions appear on every device.",
    outcomes: [
      "Download EspeesMax from the Loveworld Appstore",
      "Sign in with KingsChat or your email and password",
      "See your wallet balance and recent activity on the dashboard",
    ],
    relatedLinks: [
      { label: "Sign in", href: "/login" },
      { label: "Dashboard", href: "/dashboard" },
    ],
    poster: media("02_download_connect.jpg"),
    video: media("ESPEES_MAX_2_DWNLOAD_&_CONNECT.mp4"),
    durationSeconds: 37,
  },
  {
    step: 3,
    slug: "stay-connected",
    title: "Stay connected",
    summary: "Use EspeesMax on the web and on your phone together.",
    description:
      "EspeesMax works on the web and in the mobile app with one account. Learn how login verification keeps your sessions safe and how to pick up where you left off on any device.",
    outcomes: [
      "Sign in on web.espees.org and on your phone with the same account",
      "Complete login verification with your authenticator or security questions",
      "Log out of all devices if you ever lose a phone",
    ],
    relatedLinks: [
      { label: "Login verification help", href: "/validate-login/help" },
      { label: "Support Center", href: "/support" },
    ],
    poster: media("03_stay_connected.jpg"),
    video: media("ESPEES_MAX_3_STAY_CONNECTED.mp4"),
    durationSeconds: 51,
  },
  {
    step: 4,
    slug: "secure-your-account",
    title: "Secure your account",
    summary: "Turn on 2FA, set security questions and freeze if needed.",
    description:
      "Protect your money with two-factor authentication through the Omnia Authenticator app, set up security questions for recovery, and learn how to freeze your account instantly if you suspect something is wrong.",
    outcomes: [
      "Enable two-factor authentication (2FA) with Omnia Authenticator",
      "Choose three security questions only you can answer",
      "Freeze and unfreeze your account to block outgoing transfers",
    ],
    relatedLinks: [
      { label: "Two-factor authentication", href: "/security/2fa/home" },
      { label: "Freeze account", href: "/security/freeze" },
    ],
    poster: media("04_secure_account.jpg"),
    video: media("ESPEES_MAX_4__SECURITY.mp4"),
    durationSeconds: 38,
  },
  {
    step: 5,
    slug: "buy-espees",
    title: "Buy Espees",
    summary: "Top up your wallet in NGN or USD with a card.",
    description:
      "Fund your wallet in a few taps. See the live exchange rate, pay in NGN or USD with a new or saved card, and set up auto top-up so you never run low at the wrong moment.",
    outcomes: [
      "Check the current exchange rate before you buy",
      "Pay with a new card or a saved card (2FA protects saved cards)",
      "Set an auto top-up threshold and amount",
    ],
    relatedLinks: [
      { label: "Buy Espees", href: "/espees/buy" },
      { label: "Manage cards", href: "/manage-cards" },
    ],
    poster: media("05_buy_espees.jpg"),
    video: media("ESPEES_MAX_5__BUY_ESPEES.mp4"),
    durationSeconds: 47,
  },
  {
    step: 6,
    slug: "send-espees",
    title: "Send Espees",
    summary: "Pay merchants, friends and wallets, and track every transfer.",
    description:
      "Send Espees to a merchant, a username, an email or a wallet ID. Confirm with your PIN, pay from your wallet or a voucher, and review every transaction in your history.",
    outcomes: [
      "Choose the right recipient type: merchant, username, email or wallet ID",
      "Confirm a transfer with your 4-digit PIN",
      "Pay merchants from a voucher and export your transaction history",
    ],
    relatedLinks: [
      { label: "Send Espees", href: "/transactions/transfer" },
      { label: "Transactions", href: "/transactions" },
      { label: "Vouchers", href: "/vouchers" },
    ],
    poster: media("06_send_espees.jpg"),
    video: media("ESPEES_MAX_6__SEND_ESPEES.mp4"),
    durationSeconds: 36,
  },
  {
    step: 7,
    slug: "manage-your-pin",
    title: "Manage your PIN",
    summary: "Change your PIN, or reset it if you forget it.",
    description:
      "Your 4-digit PIN confirms every transfer. Learn how to change it regularly, and how to reset it safely with 2FA or your security questions if you ever forget it.",
    outcomes: [
      "Change your transaction PIN from the Security menu",
      "Reset a forgotten PIN using 2FA or security questions",
      "Keep your PIN private and recognise phishing attempts",
    ],
    relatedLinks: [
      { label: "Change PIN", href: "/security/changepin" },
      { label: "Reset PIN", href: "/security/resetpin" },
    ],
    poster: media("07_manage_pin.jpg"),
    video: media("ESPEES_MAX_7_MANAGE_PIN.mp4"),
    durationSeconds: 86,
  },
];

// ---------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function httpsUrl(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s || s.length > LIMITS.url) return null;
  try {
    return new URL(s).protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

function text(value, max, { required = false } = {}) {
  if (value === undefined || value === null) return required ? { error: "is required" } : { value: "" };
  if (typeof value !== "string") return { error: "must be text" };
  const s = value.trim();
  if (required && !s) return { error: "is required" };
  if (s.length > max) return { error: `must be at most ${max} characters` };
  return { value: s };
}

/**
 * Checks a video sent by an admin. With `partial`, only the fields present are
 * checked (PATCH); otherwise slug, title, poster and video are required.
 * Returns { value, errors } where errors maps a field to what is wrong with it.
 */
function validateTutorial(input, { partial = false } = {}) {
  const errors = {};
  const value = {};
  if (!isPlainObject(input)) return { value, errors: { body: "must be a JSON object" } };
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  const want = (k) => !partial || has(k);

  if (want("slug")) {
    const s = typeof input.slug === "string" ? input.slug.trim().toLowerCase() : "";
    if (!s) errors.slug = "is required";
    else if (s.length > LIMITS.slug || !SLUG_RE.test(s))
      errors.slug = "must be lowercase letters, numbers and single hyphens, e.g. buy-espees";
    else value.slug = s;
  }

  for (const [field, max, required] of [
    ["title", LIMITS.title, true],
    ["summary", LIMITS.summary, false],
    ["description", LIMITS.description, false],
  ]) {
    if (!want(field)) continue;
    const r = text(input[field], max, { required });
    if (r.error) errors[field] = r.error;
    else value[field] = r.value;
  }

  for (const field of ["poster", "video"]) {
    if (!want(field)) continue;
    const url = httpsUrl(input[field]);
    if (!url) errors[field] = "must be an https URL";
    else value[field] = url;
  }

  if (has("step")) {
    const n = Number(input.step);
    if (!Number.isInteger(n) || n < 1 || n > LIMITS.step) errors.step = `must be a whole number from 1 to ${LIMITS.step}`;
    else value.step = n;
  }

  if (has("durationSeconds")) {
    const n = Number(input.durationSeconds);
    if (!Number.isFinite(n) || n < 0 || n > LIMITS.durationSeconds)
      errors.durationSeconds = `must be a number of seconds from 0 to ${LIMITS.durationSeconds}`;
    else value.durationSeconds = Math.round(n);
  } else if (!partial) {
    value.durationSeconds = 0;
  }

  if (has("published")) {
    if (typeof input.published !== "boolean") errors.published = "must be true or false";
    else value.published = input.published;
  } else if (!partial) {
    value.published = true;
  }

  if (has("outcomes")) {
    const list = input.outcomes;
    if (!Array.isArray(list) || list.length > LIMITS.outcomes)
      errors.outcomes = `must be a list of at most ${LIMITS.outcomes} lines`;
    else {
      const out = [];
      list.forEach((item, i) => {
        const r = text(item, LIMITS.outcome, { required: true });
        if (r.error) errors[`outcomes[${i}]`] = r.error;
        else out.push(r.value);
      });
      value.outcomes = out;
    }
  } else if (!partial) {
    value.outcomes = [];
  }

  if (has("relatedLinks")) {
    const list = input.relatedLinks;
    if (!Array.isArray(list) || list.length > LIMITS.relatedLinks)
      errors.relatedLinks = `must be a list of at most ${LIMITS.relatedLinks} links`;
    else {
      const out = [];
      list.forEach((item, i) => {
        if (!isPlainObject(item)) return void (errors[`relatedLinks[${i}]`] = "must be { label, href }");
        const label = text(item.label, LIMITS.linkLabel, { required: true });
        const rawHref = typeof item.href === "string" ? item.href.trim() : "";
        // An app path ("/espees/buy") or a full https link.
        const href =
          rawHref.startsWith("/") && !rawHref.startsWith("//") && rawHref.length <= LIMITS.linkHref
            ? rawHref
            : httpsUrl(rawHref);
        if (label.error) errors[`relatedLinks[${i}].label`] = label.error;
        if (!href) errors[`relatedLinks[${i}].href`] = "must be an app path like /espees/buy or an https URL";
        if (!label.error && href) out.push({ label: label.value, href });
      });
      value.relatedLinks = out;
    }
  } else if (!partial) {
    value.relatedLinks = [];
  }

  return { value, errors };
}

/** A stored video as the apps see it (no Mongo id). */
function toPublic(doc) {
  return {
    slug: doc.slug,
    step: doc.step,
    title: doc.title,
    summary: doc.summary || "",
    description: doc.description || "",
    outcomes: Array.isArray(doc.outcomes) ? doc.outcomes : [],
    relatedLinks: Array.isArray(doc.relatedLinks) ? doc.relatedLinks : [],
    poster: doc.poster,
    video: doc.video,
    durationSeconds: doc.durationSeconds || 0,
    published: doc.published !== false,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
}

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------

const fail = (res, code, error, message, extra = {}) =>
  res.status(code).json({ status: false, error, message, ...extra });

module.exports = function espeesTutorialsRoutes({ getDb } = {}) {
  const router = Router();

  let indexed = null;
  async function collection() {
    const col = (await getDb()).collection(COLLECTION);
    if (!indexed) {
      indexed = Promise.all([
        col.createIndex({ slug: 1 }, { unique: true }),
        col.createIndex({ published: 1, step: 1 }),
      ]).catch((err) => {
        indexed = null;
        throw err;
      });
    }
    await indexed;
    return col;
  }

  async function listAll(col, filter = {}) {
    return col.find(filter).sort({ step: 1, slug: 1 }).toArray();
  }

  // --- Public -------------------------------------------------------------

  router.get(
    "/nmt/espees/tutorials",
    asyncHandler(async (_req, res) => {
      const col = await collection();
      const docs = await listAll(col, { published: { $ne: false } });
      const updatedAt = docs.reduce((latest, d) => {
        const t = d.updatedAt ? new Date(d.updatedAt).getTime() : 0;
        return t > latest ? t : latest;
      }, 0);
      // Short cache: an edit shows up within a minute, and the apps keep working from the
      // stale copy if this server is briefly down.
      res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=600");
      res.json({
        status: true,
        data: {
          tutorials: docs.map(toPublic),
          count: docs.length,
          updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
        },
      });
    }),
  );

  router.get(
    "/nmt/espees/tutorials/:slug",
    asyncHandler(async (req, res) => {
      const col = await collection();
      const doc = await col.findOne({ slug: String(req.params.slug).toLowerCase(), published: { $ne: false } });
      if (!doc) return fail(res, 404, "not_found", "No published tutorial has that slug.");
      res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=600");
      res.json({ status: true, data: { tutorial: toPublic(doc) } });
    }),
  );

  // --- Managing the list -------------------------------------------------

  router.get(
    "/nmt/espees/admin/tutorials",
    asyncHandler(async (_req, res) => {
      const col = await collection();
      const docs = await listAll(col);
      res.set("Cache-Control", "no-store");
      res.json({ status: true, data: { tutorials: docs.map(toPublic), count: docs.length } });
    }),
  );

  // Declared before "/:slug" routes so "order" and "seed" are not read as slugs.
  router.put(
    "/nmt/espees/admin/tutorials/order",
    asyncHandler(async (req, res) => {
      const slugs = req.body?.slugs;
      if (!Array.isArray(slugs) || !slugs.length || slugs.some((s) => typeof s !== "string"))
        return fail(res, 400, "invalid_body", "Send { slugs: [\"first-slug\", \"second-slug\", ...] }.");
      const wanted = slugs.map((s) => s.trim().toLowerCase());
      if (new Set(wanted).size !== wanted.length) return fail(res, 400, "duplicate_slug", "A slug is listed twice.");

      const col = await collection();
      const all = await listAll(col);
      const known = new Set(all.map((d) => d.slug));
      const unknown = wanted.filter((s) => !known.has(s));
      if (unknown.length) return fail(res, 404, "not_found", `Unknown slug(s): ${unknown.join(", ")}`);

      // Listed videos take steps 1..n in that order; any not listed follow, keeping their order.
      const rest = all.filter((d) => !wanted.includes(d.slug)).map((d) => d.slug);
      const now = new Date();
      const ordered = [...wanted, ...rest];
      await col.bulkWrite(
        ordered.map((slug, i) => ({ updateOne: { filter: { slug }, update: { $set: { step: i + 1, updatedAt: now } } } })),
      );
      res.json({ status: true, data: { tutorials: (await listAll(col)).map(toPublic) } });
    }),
  );

  router.post(
    "/nmt/espees/admin/tutorials/seed",
    asyncHandler(async (_req, res) => {
      const col = await collection();
      const existing = new Set((await listAll(col)).map((d) => d.slug));
      const now = new Date();
      const missing = DEFAULT_TUTORIALS.filter((t) => !existing.has(t.slug));
      if (missing.length) {
        await col.insertMany(missing.map((t) => ({ ...t, published: true, createdAt: now, updatedAt: now })));
      }
      res.json({
        status: true,
        data: { added: missing.map((t) => t.slug), tutorials: (await listAll(col)).map(toPublic) },
      });
    }),
  );

  router.post(
    "/nmt/espees/admin/tutorials",
    asyncHandler(async (req, res) => {
      const { value, errors } = validateTutorial(req.body);
      if (Object.keys(errors).length) return fail(res, 400, "invalid_tutorial", "Some fields are not valid.", { fields: errors });

      const col = await collection();
      if (await col.findOne({ slug: value.slug })) return fail(res, 409, "slug_taken", "A tutorial already has that slug.");
      if (value.step === undefined) {
        const last = await col.find({}).sort({ step: -1 }).limit(1).toArray();
        value.step = (last[0]?.step || 0) + 1;
      }
      const now = new Date();
      const doc = { ...value, createdAt: now, updatedAt: now };
      try {
        await col.insertOne(doc);
      } catch (err) {
        if (err?.code === 11000) return fail(res, 409, "slug_taken", "A tutorial already has that slug.");
        throw err;
      }
      res.status(201).json({ status: true, data: { tutorial: toPublic(doc) } });
    }),
  );

  router.patch(
    "/nmt/espees/admin/tutorials/:slug",
    asyncHandler(async (req, res) => {
      const slug = String(req.params.slug).toLowerCase();
      const { value, errors } = validateTutorial(req.body, { partial: true });
      if (Object.keys(errors).length) return fail(res, 400, "invalid_tutorial", "Some fields are not valid.", { fields: errors });
      if (!Object.keys(value).length) return fail(res, 400, "nothing_to_change", "Send at least one field to change.");

      const col = await collection();
      const current = await col.findOne({ slug });
      if (!current) return fail(res, 404, "not_found", "No tutorial has that slug.");
      if (value.slug && value.slug !== slug && (await col.findOne({ slug: value.slug })))
        return fail(res, 409, "slug_taken", "A tutorial already has that slug.");

      const update = { ...value, updatedAt: new Date() };
      try {
        await col.updateOne({ slug }, { $set: update });
      } catch (err) {
        if (err?.code === 11000) return fail(res, 409, "slug_taken", "A tutorial already has that slug.");
        throw err;
      }
      const doc = await col.findOne({ slug: value.slug || slug });
      res.json({ status: true, data: { tutorial: toPublic(doc) } });
    }),
  );

  router.delete(
    "/nmt/espees/admin/tutorials/:slug",
    asyncHandler(async (req, res) => {
      const col = await collection();
      const { deletedCount } = await col.deleteOne({ slug: String(req.params.slug).toLowerCase() });
      if (!deletedCount) return fail(res, 404, "not_found", "No tutorial has that slug.");
      res.json({ status: true, data: { deleted: req.params.slug } });
    }),
  );

  return router;
};

module.exports.validateTutorial = validateTutorial;
module.exports.DEFAULT_TUTORIALS = DEFAULT_TUTORIALS;
