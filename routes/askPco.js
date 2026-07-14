// routes/askPco.js
// Usage from server.js:
//   const askPcoRoutes = require("./routes/askPco");
//   app.use(askPcoRoutes({ upload, openai, embedTexts, getDb, EMBED_MODEL, CHAT_MODEL }));

const { Router } = require("express");

// ------------------------------
// Small helpers (self-contained)
// ------------------------------
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ---- Simple SRT parser (no external lib) ----
function parseSrt(srtText) {
  const blocks = String(srtText).replace(/\r/g, "").split("\n\n");
  const items = [];
  for (const b of blocks) {
    const lines = b.trim().split("\n");
    if (lines.length < 2) continue;
    // typical: index line, time line, then text lines
    const timeLine = lines[1] || "";
    const m = timeLine.match(
      /(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/
    );
    if (!m) continue;
    const start = srtToMs(m[1]);
    const end = srtToMs(m[2]);
    const text = lines.slice(2).join(" ").replace(/\s+/g, " ").trim();
    if (text) items.push({ start, end, text });
  }
  return items;
}

function srtToMs(t) {
  // "HH:MM:SS,mmm"
  const [hh, mm, rest] = t.split(":");
  const [ss, ms] = rest.split(",");
  return +hh * 3600000 + +mm * 60000 + +ss * 1000 + +ms;
}
function msToTimestamp(ms) {
  const sign = ms < 0 ? "-" : "";
  ms = Math.abs(ms);
  const hh = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const mm = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  const mmm = String(ms % 1000).padStart(3, "0");
  return `${sign}${hh}:${mm}:${ss},${mmm}`;
}

// ---- Chunking: merge captions to ~500-800 chars windows ----
function chunkCaptions(captions, { targetChars = 800, overlap = 1 } = {}) {
  const out = [];
  let buf = [];
  let charCount = 0;
  for (const c of captions) {
    const segLen = c.text.length + 1;
    if (charCount + segLen > targetChars && buf.length) {
      const start = buf[0].start;
      const end = buf[buf.length - 1].end;
      const text = buf.map((x) => x.text).join(" ");
      out.push({ start, end, text });
      // retain last `overlap` items as context
      buf = buf.slice(-overlap);
      charCount = buf.reduce((n, x) => n + x.text.length + 1, 0);
    }
    buf.push(c);
    charCount += segLen;
  }
  if (buf.length) {
    const start = buf[0].start;
    const end = buf[buf.length - 1].end;
    const text = buf.map((x) => x.text).join(" ");
    out.push({ start, end, text });
  }
  return out;
}

// ---- Cosine similarity (float arrays) ----
function cosine(a, b) {
  let dot = 0,
    na = 0,
    nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

// ---- Guards for /qa ----
function looksLikeQuestion(q) {
  const s = String(q || "").trim();
  if (!s) return false;
  if (s.includes("?")) return true;
  const lower = s.toLowerCase();
  const wh = ["who", "what", "when", "where", "why", "how", "which", "whom", "whose"];
  if (wh.some((w) => lower.startsWith(w + " "))) return true;
  const imperatives = [
    "explain", "describe", "summarize", "write", "compose", "draft", "generate",
    "list", "outline", "discuss", "tell me about", "give me", "create", "produce", "make", "enumerate",
  ];
  if (imperatives.some((w) => lower.startsWith(w + " "))) return false;
  return false;
}

function isIrrelevant(q) {
  const s = String(q || "").toLowerCase();
  const bioAdmin = [
    "how old", "age", "born", "birthday", "birth day", "date of birth",
    "net worth", "worth", "height", "where does", "where is he from", "from where",
    "wife", "husband", "married", "children", "kids", "family", "parents",
    "address", "phone", "email", "contact", "office location",
    "biography", "bio", "real name", "full name", "citizenship", "nationality",
  ];
  if (bioAdmin.some((k) => s.includes(k))) return true;

  const logistics = [
    "ticket price", "registration", "venue", "schedule", "itinerary",
    "visa", "hotel", "parking", "livestream", "youtube link",
  ];
  if (logistics.some((k) => s.includes(k))) return true;

  return false;
}

function buildReferencesBlock(cites) {
  if (!cites?.length) return "";
  const lines = cites.map((c, i) => {
    const name = c.title || "Untitled message";
    const id = c.externalId || "N/A";
    const tsStart = c.startTimestamp || msToTimestamp(c.start);
    const tsEnd = c.endTimestamp || msToTimestamp(c.end);
    const range = tsEnd ? ` → ${tsEnd}` : "";
    return `${i + 1}) ${name} | ${id} | ${tsStart}${range}`;
  });
  return `\n\nReferences:\n${lines.join("\n")}`;
}

// ------------------------------
// Router factory
// ------------------------------
module.exports = function askPcoRoutes(deps) {
  const {
    upload,            // multer instance (memory storage)
    openai,            // OpenAI client (with fetch polyfill)
    embedTexts,        // function(openai, model, texts) -> embeddings[]
    getDb,             // async () => db
    EMBED_MODEL,       // e.g. "text-embedding-3-small"
    CHAT_MODEL,        // e.g. "gpt-4.1-mini"
  } = deps;

  const router = Router();

  /**
   * POST /ask-pco/upload
   * Form-Data:
   *   - id (string, required)
   *   - title (string, optional)
   *   - speaker (string, default "Pastor Chris")
   *   - date (string | ISO, optional)
   *   - tags (string, optional, comma-separated)
   *   - metadata (json, optional)
   *   - file (SRT file, required)
   *
   * Behavior:
   *   - parses SRT, chunks, embeds chunks, stores sermon doc + chunk docs
   */
  router.post("/ask-pco/upload", upload.single("file"), asyncHandler(async (req, res) => {
    const externalId = String(req.body.id || "").trim();
    if (!externalId) return res.status(400).json({ error: "id is required" });
    if (!req.file) return res.status(400).json({ error: "SRT file is required (field: file)" });

    const title = (req.body.title || "").trim() || null;
    const speaker = (req.body.speaker || "Pastor Chris").trim();
    const date = (req.body.date || "").trim() || null;

    let tags = [];
    if (req.body.tags) {
      tags = String(req.body.tags)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    let extra = {};
    if (req.body.metadata) {
      try { extra = JSON.parse(req.body.metadata); } catch {}
    }

    const srtText = req.file.buffer.toString("utf8");
    const captions = parseSrt(srtText);
    if (!captions.length) {
      return res.status(400).json({ error: "No captions parsed from SRT" });
    }

    const chunks = chunkCaptions(captions, { targetChars: 800, overlap: 1 });
    const texts = chunks.map((c) => c.text);
    const embeddings = await embedTexts(openai, EMBED_MODEL, texts);

    const db = await getDb();
    const sermons = db.collection("pcdl_ask_pco");
    const sermon_chunks = db.collection("pcdl_ask_pco_chunks");

    // Upsert sermon metadata
    await sermons.updateOne(
      { externalId },
      {
        $set: {
          externalId,
          title,
          speaker,
          date: date ? new Date(date) : null,
          tags,
          metadata: extra,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );

    // Remove old chunks (idempotent re-upload)
    await sermon_chunks.deleteMany({ externalId });

    // Insert new chunks
    const docs = chunks.map((ch, i) => ({
      externalId,
      title,
      speaker,
      date: date ? new Date(date) : null,
      tags,
      start: ch.start, // ms
      end: ch.end,     // ms
      text: ch.text,
      embedding: embeddings[i],
      createdAt: new Date(),
    }));
    if (docs.length) await sermon_chunks.insertMany(docs);

    res.json({ ok: true, externalId, chunks: docs.length });
  }));

  /**
   * POST /ask-pco/qa
   * Body: {
   *   question: string,
   *   topK?: number (default 6),
   *   filter?: { externalIds?: string[], tags?: string[] }
   * }
   * Returns: {
   *   answer: string, // includes a "References" block with title | id | timestamp when applicable
   *   citations: [{title,externalId,start,end,startTimestamp,endTimestamp,text}],
   *   recommended: [externalId,...],
   *   recommendedTitles: [title,...]
   * }
   */
  router.post("/ask-pco/qa", asyncHandler(async (req, res) => {
    const { question } = req.body || {};
    const topK = Math.max(1, Math.min(12, req.body?.topK || 6));
    const filter = req.body?.filter || {};

    if (!question || typeof question !== "string") {
      return res.status(400).json({ error: "question is required" });
    }

    // --- Guard 1: only answer actual QUESTIONS (reject instructions/commands) ---
    if (!looksLikeQuestion(question)) {
      return res.json({
        answer: "This endpoint only answers questions. Please rephrase your request as a question.",
        citations: [],
        recommended: [],
        recommendedTitles: [],
      });
    }

    // --- Guard 2: refuse IRRELEVANT questions ---
    const OUT_OF_SCOPE_MSG = "Please ask a question on something you'd like to get more insight on.";
    // if (isIrrelevant(question)) {
    //   return res.json({
    //     answer: OUT_OF_SCOPE_MSG,
    //     citations: [],
    //     recommended: [],
    //     recommendedTitles: [],
    //   });
    // }

    // 1) Embed query
    const qEmbed = (await embedTexts(openai, EMBED_MODEL, [question]))[0];

    // 2) Fetch candidate chunks
    const db = await getDb();
    const sermon_chunks = db.collection("pcdl_ask_pco_chunks");

    const q = {};
    if (filter.externalIds?.length) q.externalId = { $in: filter.externalIds };
    if (filter.tags?.length) q.tags = { $in: filter.tags };

    const candidates = await sermon_chunks
      .find(q, {
        projection: {
          embedding: 1,
          externalId: 1,
          start: 1,
          end: 1,
          text: 1,
          title: 1,
        },
      })
      .limit(1500)
      .toArray();

    // 3) Score & rank
    let results = candidates
      .map((c) => ({ ...c, score: cosine(qEmbed, c.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(20, topK));

    // 4) Diversify across messages
    const seenMsg = new Set();
    const picked = [];
    for (const r of results) {
      if (picked.length >= topK) break;
      if (!seenMsg.has(r.externalId) || picked.length < Math.ceil(topK * 0.67)) {
        picked.push(r);
        seenMsg.add(r.externalId);
      }
    }

    // 5) Recommendations (ids + titles)
    const byMsg = new Map();
    for (const r of results) {
      const prev = byMsg.get(r.externalId);
      if (!prev || r.score > prev.score) {
        byMsg.set(r.externalId, {
          id: r.externalId,
          title: r.title || "Untitled message",
          score: r.score,
        });
      }
    }
    const rankedMsgs = Array.from(byMsg.values()).sort((a, b) => b.score - a.score);
    const recommended = rankedMsgs.slice(0, 5).map((x) => x.id);
    const recommendedTitles = rankedMsgs.slice(0, 5).map((x) => x.title);

    // 6) Confidence gate
    const MIN_STRONG_SCORE = 0.22;
    const bestScore = results[0]?.score ?? 0;
    const haveStrongEvidence = picked.length > 0 && bestScore >= MIN_STRONG_SCORE;

    // 7) Build citations from picked
    const citations = picked.map((r) => ({
      title: r.title,
      externalId: r.externalId,
      start: r.start,
      end: r.end,
      startTimestamp: msToTimestamp(r.start),
      endTimestamp: msToTimestamp(r.end),
      text: r.text,
    }));

    if (!haveStrongEvidence) {
      const suggestionLines = rankedMsgs
        .slice(0, 5)
        .map((m, i) => `${i + 1}) ${m.title} | ${m.id}`)
        .join("\n");

      const declineAnswer =
        "I can’t directly answer this from the available sermon excerpts right now. " +
        "Here are some messages that may help:\n\n" +
        suggestionLines;

      return res.json({
        answer: declineAnswer,
        citations: [],
        recommended,
        recommendedTitles,
      });
    }

    // 8) Compose prompt for model
    const contextBlocks = picked
      .map((r, i) => {
        const ts = `${msToTimestamp(r.start)} -> ${msToTimestamp(r.end)}`;
        return `#${i + 1} | title: ${r.title} | id: ${r.externalId} | time: ${ts}\n"${r.text}"`;
      })
      .join("\n\n");

    const system = [
      "You are a quoting assistant for Pastor Chris sermons.",
      "Answer strictly from the provided sermon excerpts in a pastoral, concise, and clear tone.",
      "When you cite inline, include (title | id | start timestamp).",
      "If the question cannot be answered from the excerpts, say so briefly and suggest the closest relevant point.",
    ].join(" ");

    const userPrompt =
      `Question: ${question}\n\nContext:\n${contextBlocks}\n\n` +
      "Instructions:\n" +
      "- Provide a direct answer.\n" +
      "- List 2–5 key citations or just give the specifics amount of points if mentioned in the excerpt with (title | id | start timestamp).\n" +
      "- Optionally recommend other titles from the context that the user should also check.";

    const chatResp = await openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ],
    });

    const modelAnswer =
      chatResp.choices?.[0]?.message?.content?.trim() ||
      "I can’t directly answer this from the available sermon excerpts. Here are some messages that may help.";

    const finalAnswer = modelAnswer + buildReferencesBlock(citations);

    return res.json({
      answer: finalAnswer,
      citations,
      recommended,
      recommendedTitles,
    });
  }));

  return router;
};
