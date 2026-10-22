// The LoveWorld Expo routes alone, for working on the website locally:
//   LOVEWORLD_EXPO_DATABASE_URL=postgres://localhost/loveworld_expo node scripts/expo-dev.js
// Listens on EXPO_DEV_PORT (3001). Reads the API's .env unless EXPO_SKIP_ENV_FILE is set.
const express = require("express");
const routes = require("../routes/loveworld_expo");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use((req, _res, next) => { console.log(new Date().toISOString().slice(11, 19), req.method, req.url); next(); });
app.use(routes({}));
app.use((err, _req, res, _next) => {
  console.error("[expo-dev]", err.message);
  res.status(err.statusCode || 500).json({ status: false, error: "internal_error", message: err.message });
});
const port = Number(process.env.EXPO_DEV_PORT || 3001);
// Express 5 hands a listen error (the port already taken) to this callback rather than throwing.
app.listen(port, "127.0.0.1", (err) => {
  if (err) {
    console.error(`Could not start on port ${port}: ${err.code === "EADDRINUSE" ? "something is already listening there (another copy of this?)" : err.message}`);
    process.exit(1);
  }
  console.log(`LoveWorld Expo dev API on http://127.0.0.1:${port}/expo`);
  const passes = routes.passesSetup();
  console.log(`Passes: ${passes.onSale ? `on sale (KingsPass at ${passes.kingspass})` : `not on sale, missing ${passes.missing.join(", ")}`}${passes.debug ? ", logging every Espees and KingsPass request (EXPO_PAY_DEBUG)" : " (EXPO_PAY_DEBUG=1 logs every Espees and KingsPass request)"}`);
  console.log(`KingsChat messages: ${process.env.EXPO_KC_API_KEY || process.env.KINGSCHAT_API_KEY ? "on" : "off (no EXPO_KC_API_KEY, so sends are skipped)"}${["1", "true", "on"].includes(String(process.env.EXPO_KC_DEBUG || "").toLowerCase()) ? ", logging request bodies" : ""}`);
});
