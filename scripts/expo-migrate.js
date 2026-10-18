// Makes the LoveWorld Expo database and tables now, rather than on the API's first request,
// and loads the exhibitors in scripts/expo-seed.json when the table is empty:
//   node scripts/expo-migrate.js            # tables, and the seed if there are no exhibitors yet
//   node scripts/expo-migrate.js --seed     # the seed again (each exhibitor made or updated by id)
// Uses the same settings as the API (LOVEWORLD_EXPO_DATABASE_URL, or the KingsPresenter / NMM
// Postgres server with the database `loveworld_expo`). Safe to run again: it only adds what is missing.
require("dotenv").config();
const path = require("path");
const expo = require("../routes/loveworld_expo");

(async () => {
  try {
    await expo.ensureSchema();
    const n = (await expo.pool.query(`SELECT count(*)::int AS n FROM exhibitors`)).rows[0].n;
    if (n === 0 || process.argv.includes("--seed")) {
      const seed = require(path.join(__dirname, "expo-seed.json"));
      let done = 0;
      for (const [i, item] of seed.entries()) {
        const f = expo.exhibitorFields(item, { forInsert: true });
        if (!f) continue;
        if (f.sort === undefined) f.sort = i;
        await expo.upsertExhibitor(item.id, f);
        done++;
      }
      console.log(`Seeded ${done} exhibitors.`);
    }
    const rows = (await expo.pool.query(
      `SELECT current_database() AS db, string_agg(table_name, ', ' ORDER BY table_name) AS tables
       FROM information_schema.tables WHERE table_schema = 'public' GROUP BY 1`)).rows[0];
    console.log(`LoveWorld Expo database "${rows.db}" ready: ${rows.tables}`);
  } catch (err) {
    console.error("Could not set up the LoveWorld Expo database:", err.message);
    process.exitCode = 1;
  } finally {
    await expo.pool.end().catch(() => {});
  }
})();
