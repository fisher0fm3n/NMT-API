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

      // A highlighted passage. The text itself is stored, not just offsets:
      // the transcriptions get proofread, and a highlight should survive a
      // corrected comma three paragraphs earlier. `block_index` and
      // `start_offset` are hints for finding it again quickly.
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.library_highlights (
          id              BIGSERIAL PRIMARY KEY,
          email           TEXT NOT NULL,
          publication_id  TEXT NOT NULL,
          surface_id      TEXT NOT NULL,
          block_index     INTEGER NOT NULL DEFAULT 0,
          start_offset    INTEGER NOT NULL DEFAULT 0,
          text            TEXT NOT NULL,
          note            TEXT,
          title           TEXT,
          surface_title   TEXT,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);

      // One free-form note per reader per chapter.
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.library_notes (
          id              BIGSERIAL PRIMARY KEY,
          email           TEXT NOT NULL,
          publication_id  TEXT NOT NULL,
          surface_id      TEXT NOT NULL,
          body            TEXT NOT NULL,
          title           TEXT,
          surface_title   TEXT,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (email, publication_id, surface_id)
        )
      `);

      await db.query(
        `CREATE INDEX IF NOT EXISTS library_progress_email_idx
           ON public.library_progress (email, updated_at DESC)`,
      );
      await db.query(
        `CREATE INDEX IF NOT EXISTS library_highlights_email_idx
           ON public.library_highlights (email, publication_id)`,
      );
      await db.query(
        `CREATE INDEX IF NOT EXISTS library_notes_email_idx
           ON public.library_notes (email, publication_id)`,
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

const HIGHLIGHT_COLS = `id, publication_id, surface_id, block_index, start_offset,
                        text, note, title, surface_title, created_at, updated_at`;
const NOTE_COLS = `id, publication_id, surface_id, body, title, surface_title,
                   created_at, updated_at`;

/**
 * Creates a highlight, or — when `id` is given — changes the note on one the
 * reader already has. Returns the row, or null if the id is not theirs.
 */
async function saveHighlight(db, email, input) {
  if (input.id != null) {
    const { rows } = await db.query(
      `UPDATE public.library_highlights
          SET note = $3, updated_at = now()
        WHERE id = $1 AND email = $2
        RETURNING ${HIGHLIGHT_COLS}`,
      [String(input.id), email, trimTo(input.note, 4000)],
    );
    return rows[0] ?? null;
  }
  const publicationId = trimTo(input.publication_id, 120);
  const surfaceId = trimTo(input.surface_id, 120);
  const text = trimTo(input.text, 2000);
  if (!publicationId || !surfaceId || !text) throw new Error("publication_id, surface_id and text are required");
  const { rows } = await db.query(
    `INSERT INTO public.library_highlights
       (email, publication_id, surface_id, block_index, start_offset, text, note, title, surface_title)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${HIGHLIGHT_COLS}`,
    [
      email, publicationId, surfaceId,
      clampInt(input.block_index, 0, 10000), clampInt(input.start_offset, 0, 1000000),
      text, trimTo(input.note, 4000), trimTo(input.title, 300), trimTo(input.surface_title, 300),
    ],
  );
  return rows[0];
}

async function deleteHighlight(db, email, id) {
  const { rowCount } = await db.query(
    `DELETE FROM public.library_highlights WHERE id = $1 AND email = $2`,
    [String(id), email],
  );
  return rowCount > 0;
}

/**
 * Writes the reader's note for a chapter. An empty body removes it, so the
 * client has one call for "the reader cleared the box" as well as for typing.
 */
async function saveNote(db, email, input) {
  const publicationId = trimTo(input.publication_id, 120);
  const surfaceId = trimTo(input.surface_id, 120);
  if (!publicationId || !surfaceId) throw new Error("publication_id and surface_id are required");
  const body = trimTo(input.body, 20000);
  if (!body) {
    await db.query(
      `DELETE FROM public.library_notes WHERE email = $1 AND publication_id = $2 AND surface_id = $3`,
      [email, publicationId, surfaceId],
    );
    return null;
  }
  const { rows } = await db.query(
    `INSERT INTO public.library_notes (email, publication_id, surface_id, body, title, surface_title)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (email, publication_id, surface_id) DO UPDATE SET
       body = EXCLUDED.body, title = EXCLUDED.title, surface_title = EXCLUDED.surface_title,
       updated_at = now()
     RETURNING ${NOTE_COLS}`,
    [email, publicationId, surfaceId, body, trimTo(input.title, 300), trimTo(input.surface_title, 300)],
  );
  return rows[0];
}

/** Everything the reader's library screens need, in one round trip. */
async function readState(db, email) {
  const [progress, stars, bookmarks, highlights, notes] = await Promise.all([
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
    db.query(
      `SELECT ${HIGHLIGHT_COLS}
         FROM public.library_highlights
        WHERE email = $1
        ORDER BY created_at DESC
        LIMIT 2000`,
      [email],
    ),
    db.query(
      `SELECT ${NOTE_COLS}
         FROM public.library_notes
        WHERE email = $1
        ORDER BY updated_at DESC
        LIMIT 1000`,
      [email],
    ),
  ]);

  return {
    progress: progress.rows,
    stars: stars.rows,
    star_count: stars.rows.length,
    bookmarks: bookmarks.rows,
    highlights: highlights.rows,
    notes: notes.rows,
  };
}

module.exports = {
  ensureLibrarySchema,
  isComplete,
  saveProgress,
  saveHighlight,
  deleteHighlight,
  saveNote,
  readState,
  clampInt,
  trimTo,
};
