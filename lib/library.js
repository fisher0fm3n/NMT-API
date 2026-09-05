// lib/library.js
// Schema and helpers for the interactive library (interactive.pcdl.co): how far
// a reader has got through each SCRIPTEX or e-magazine, the pages they have
// bookmarked, and the stars they earn for finishing one.
//
// A star is the achievement: one per publication, awarded the first time the
// reader reaches the end, and never awarded twice. Progress is a single row per
// reader per publication that is overwritten as they read.
//
// Everything is keyed by the reader's email, the same key the rest of the PCDL
// gamification tables use, so a reader's stars sit alongside their XP.

let schemaPromise = null;

/** Creates the tables once per process. Safe to call on every request. */
function ensureLibrarySchema(withClient) {
  if (!schemaPromise) {
    schemaPromise = withClient(async (db) => {
      // One row per reader per publication: where they are, and whether they
      // have ever finished it. `furthest_index` never goes backwards, so
      // re-reading chapter one does not lose the fact that they got to the end.
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.library_progress (
          email           TEXT NOT NULL,
          publication_id  TEXT NOT NULL,
          kind            TEXT NOT NULL DEFAULT 'ebook',
          surface_id      TEXT,
          surface_index   INTEGER NOT NULL DEFAULT 0,
          surface_count   INTEGER NOT NULL DEFAULT 0,
          furthest_index  INTEGER NOT NULL DEFAULT 0,
          completed_at    TIMESTAMPTZ,
          started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (email, publication_id)
        )
      `);

      // The achievement. One row is one star; the primary key is what makes it
      // impossible to earn a second for the same publication.
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.library_stars (
          email           TEXT NOT NULL,
          publication_id  TEXT NOT NULL,
          kind            TEXT NOT NULL DEFAULT 'ebook',
          title           TEXT,
          awarded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (email, publication_id)
        )
      `);

      await db.query(`
        CREATE TABLE IF NOT EXISTS public.library_bookmarks (
          id              BIGSERIAL PRIMARY KEY,
          email           TEXT NOT NULL,
          publication_id  TEXT NOT NULL,
          surface_id      TEXT NOT NULL,
          surface_index   INTEGER NOT NULL DEFAULT 0,
          title           TEXT,
          surface_title   TEXT,
          note            TEXT,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (email, publication_id, surface_id)
        )
      `);

      await db.query(
        `CREATE INDEX IF NOT EXISTS library_progress_email_idx
           ON public.library_progress (email, updated_at DESC)`,
      );
      await db.query(
        `CREATE INDEX IF NOT EXISTS library_stars_email_idx
           ON public.library_stars (email, awarded_at DESC)`,
      );
      await db.query(
        `CREATE INDEX IF NOT EXISTS library_bookmarks_email_idx
           ON public.library_bookmarks (email, created_at DESC)`,
      );
    }).catch((err) => {
      // Let the next request try again rather than caching the failure.
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

const clampInt = (v, min, max) => {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
};

const trimTo = (v, len) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, len) : null;
};

/**
 * A publication counts as finished when the reader reaches its last surface.
 * The caller sends the count, so this stays true whatever a title is made of.
 */
function isComplete(surfaceIndex, surfaceCount) {
  return surfaceCount > 0 && surfaceIndex >= surfaceCount - 1;
}

/**
 * Records where the reader is, and awards the star if this is the first time
 * they have reached the end.
 *
 * Returns { progress, star } where `star` is the row only when it was awarded
 * by this call — so the site knows when to celebrate and when to stay quiet.
 */
async function saveProgress(db, email, input) {
  const publicationId = trimTo(input.publication_id, 120);
  if (!publicationId) throw new Error("publication_id is required");

  const kind = input.kind === "newsletter" ? "newsletter" : "ebook";
  const surfaceCount = clampInt(input.surface_count, 0, 10000);
  const surfaceIndex = clampInt(input.surface_index, 0, Math.max(0, surfaceCount - 1) || 10000);
  const surfaceId = trimTo(input.surface_id, 120);
  const title = trimTo(input.title, 300);
  const complete = isComplete(surfaceIndex, surfaceCount);

  const { rows } = await db.query(
    `
      INSERT INTO public.library_progress
        (email, publication_id, kind, surface_id, surface_index, surface_count,
         furthest_index, completed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $5, CASE WHEN $7 THEN now() ELSE NULL END)
      ON CONFLICT (email, publication_id) DO UPDATE SET
        kind           = EXCLUDED.kind,
        surface_id     = EXCLUDED.surface_id,
        surface_index  = EXCLUDED.surface_index,
        surface_count  = GREATEST(public.library_progress.surface_count, EXCLUDED.surface_count),
        furthest_index = GREATEST(public.library_progress.furthest_index, EXCLUDED.surface_index),
        completed_at   = COALESCE(public.library_progress.completed_at,
                                  CASE WHEN $7 THEN now() ELSE NULL END),
        updated_at     = now()
      RETURNING *
    `,
    [email, publicationId, kind, surfaceId, surfaceIndex, surfaceCount, complete],
  );

  let star = null;
  if (complete) {
    // ON CONFLICT DO NOTHING means the second finish returns no row, which is
    // exactly the "already had this star" signal.
    const awarded = await db.query(
      `
        INSERT INTO public.library_stars (email, publication_id, kind, title)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (email, publication_id) DO NOTHING
        RETURNING publication_id, kind, title, awarded_at
      `,
      [email, publicationId, kind, title],
    );
    star = awarded.rows[0] ?? null;
  }

  return { progress: rows[0], star };
}

/** Everything the reader's library screens need, in one round trip. */
async function readState(db, email) {
  const [progress, stars, bookmarks] = await Promise.all([
    db.query(
      `SELECT publication_id, kind, surface_id, surface_index, surface_count,
              furthest_index, completed_at, updated_at
         FROM public.library_progress
        WHERE email = $1
        ORDER BY updated_at DESC`,
      [email],
    ),
    db.query(
      `SELECT publication_id, kind, title, awarded_at
         FROM public.library_stars
        WHERE email = $1
        ORDER BY awarded_at DESC`,
      [email],
    ),
    db.query(
      `SELECT id, publication_id, surface_id, surface_index, title, surface_title,
              note, created_at
         FROM public.library_bookmarks
        WHERE email = $1
        ORDER BY created_at DESC
        LIMIT 200`,
      [email],
    ),
  ]);

  return {
    progress: progress.rows,
    stars: stars.rows,
    star_count: stars.rows.length,
    bookmarks: bookmarks.rows,
  };
}

module.exports = {
  ensureLibrarySchema,
  isComplete,
  saveProgress,
  readState,
  clampInt,
  trimTo,
};
