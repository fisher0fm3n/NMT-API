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
app.listen(port, "127.0.0.1", () => console.log(`LoveWorld Expo dev API on http://127.0.0.1:${port}/expo`));
