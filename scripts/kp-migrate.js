// Makes KingsPresenter's database and tables now, rather than on the API's first request:
//   node scripts/kp-migrate.js
// Uses the same settings as the API (KP_DATABASE_URL, or KP_DB_* / PCO_FN_DB_*; database
// `kingspresenter` by default). Safe to run again: it only adds what is missing.
require("dotenv").config();
const kp = require("../routes/kingspresenter");

(async () => {
  try {
    await kp.ensureSchema();
    const rows = (await kp.pool.query(
      `SELECT current_database() AS db, string_agg(table_name, ', ' ORDER BY table_name) AS tables
       FROM information_schema.tables WHERE table_schema = 'public' GROUP BY 1`)).rows[0];
    console.log(`KingsPresenter database "${rows.db}" ready: ${rows.tables}`);
  } catch (err) {
    console.error("Could not set up the KingsPresenter database:", err.message);
    process.exitCode = 1;
  } finally {
    await kp.pool.end().catch(() => {});
  }
})();
