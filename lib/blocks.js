// lib/blocks.js
// User-block storage: lets a member hide another member's profile, and keeps
// blocked users out of each other's friend lists. Table is created lazily.

let schemaPromise = null;

function ensureBlockTable(withClient) {
  if (!schemaPromise) {
    schemaPromise = withClient(async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.user_blocks (
          blocker_email TEXT NOT NULL,
          blocked_email TEXT NOT NULL,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (blocker_email, blocked_email)
        )
      `);
      await db.query(
        `CREATE INDEX IF NOT EXISTS user_blocks_blocked_idx
           ON public.user_blocks (blocked_email)`,
      );
    }).catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

module.exports = { ensureBlockTable };
