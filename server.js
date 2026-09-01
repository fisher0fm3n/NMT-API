require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const http = require("http");
const { Server } = require("socket.io");
const cookieParser = require("cookie-parser");

// Undici globals
const {
  fetch,
  Headers,
  Request,
  Response,
  FormData,
  File,
  Blob,
} = require("undici");
globalThis.fetch = fetch;
globalThis.Headers = Headers;
globalThis.Request = Request;
globalThis.Response = Response;
globalThis.FormData = FormData;
globalThis.File = File;
globalThis.Blob = Blob;

const { makeOpenAI, embedTexts } = require("./lib/openai");
const { getDb, closeDb } = require("./lib/db");
const { confirmEspeesWithRetry } = require("./lib/utils");
const buildRoutes = require("./routes");

const EMBED_MODEL = "text-embedding-3-small";
const CHAT_MODEL = "gpt-4.1-mini";

// OpenAI client (don’t crash if key missing—routes can handle null if you want)
const openai = process.env.OPENAI_API_KEY
  ? makeOpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch })
  : null;

// Ensure upload dirs exist (for avatar route)
const UPLOAD_ROOT = path.join(process.cwd(), "uploads");
const AVATAR_DIR = path.join(UPLOAD_ROOT, "avatars");
const PLAYLIST_DIR = path.join(UPLOAD_ROOT, "playlists");
fs.mkdirSync(AVATAR_DIR, { recursive: true });
fs.mkdirSync(PLAYLIST_DIR, { recursive: true });

const MAX_BYTES = 500 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
  fileFilter: (req, file, cb) => {
    // allow only jpg, png, webp
    const ok = ["image/jpeg", "image/png", "image/webp"].includes(
      file.mimetype
    );
    if (ok) return cb(null, true);
    // reject with a Multer error so we can catch and return JSON
    const err = new multer.MulterError("LIMIT_UNEXPECTED_FILE", "avatar");
    err.message = "Only JPG, PNG, or WEBP images are allowed";
    return cb(err);
  },
});

const app = express();

// If behind a proxy (Heroku/NGINX/ALB), this helps with correct IPs
app.set("trust proxy", true);
app.use(cookieParser());

// Wider JSON body limit, just in case
app.use(express.json({ limit: "2mb" }));

app.use(express.urlencoded({ extended: true }));

// Serve uploads so URLs like /uploads/avatars/xyz.jpg work
app.use(
  "/uploads",
  express.static(UPLOAD_ROOT, { fallthrough: false, maxAge: "1d" })
);

// CORS
const allowed = [
  "https://ceflix.org",
  "https://www.ceflix.org",
  "https://www.pcdl.co",
  "https://pcdl.co",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:5173",
  "https://nmt-dev.netlify.app",
  "https://ceflixtv.netlify.app",
  "https://pcdlcms.netlify.app",
  "https://pcdlupload.loveworldapis.com"
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS"
  );
  // include x-admin-token used by your routes
res.setHeader(
  "Access-Control-Allow-Headers",
  "Content-Type, Authorization, x-api-key, x-admin-token, x-user-token"
);
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowed,
    methods: ["GET", "POST"],
  },
});

app.set("io", io);

app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));
app.get("/readyz", async (_req, res) => {
  res.status(200).json({ ok: true });
});

// Mount routes
app.use(
  buildRoutes({
    upload,
    openai,
    embedTexts,
    getDb,
    confirmEspeesWithRetry,
    EMBED_MODEL,
    CHAT_MODEL,
  })
);

// Global error handler (so we don’t crash and LB gets a clean 500)
app.use((err, _req, res, _next) => {
  console.error("[server] uncaught error:", err && (err.stack || err));
  const code =
    err?.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 500;
  res.status(code).json({
    status: false,
    error: "internal_error",
    message: err?.message || "Internal Server Error",
  });
});

// Socket.IO connection logs
io.on("connection", (socket) => {
  console.log("[socket.io] client connected:", socket.id);

  socket.on("disconnect", (reason) => {
    console.log(
      "[socket.io] client disconnected:",
      socket.id,
      "reason:",
      reason
    );
  });
});

// Boot
const port = Number(process.env.PORT || 3001);
// Bind to all interfaces so the load balancer can reach you
const host = process.env.HOST || "0.0.0.0";

// IMPORTANT: listen on the HTTP server, not app
server.listen(port, host, () => {
  console.log(`API + Socket.IO up on port ${port}`);
  console.log(`Local:   http://localhost:${port}`);
  console.log(`Network: http://YOUR_SERVER_IP:${port}`);
});
// Graceful shutdown
async function shutdown() {
  try {
    await closeDb();
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Last-resort guards: don’t let the process die without a log
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[server] uncaughtException:", err);
});
