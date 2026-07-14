// routes/kingsspace.search.routes.js
const { Router } = require("express");
const mysql = require("mysql2/promise");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const OpenAI = require("openai");

const router = Router();

/**
 * ---------------------------------------------------------------------------
 * ENV
 * ---------------------------------------------------------------------------
 */
const CEFLIX_VIDEO_API =
  process.env.CEFLIX_VIDEO_API || "https://webapi.ceflix.org/api/video";

const CEFLIX_APPLICATION_KEY =
  process.env.CEFLIX_APPLICATION_KEY || "2567a5ec9705eb7ac2c984033e06189d";

const GENERAL_API_KEY = process.env.GENERAL_API_KEY || "";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || undefined;
const OPENAI_CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini";

const WHISPER_MODEL = process.env.WHISPER_MODEL || "small";
const WHISPER_MODEL_DIR =
  process.env.WHISPER_MODEL_DIR ||
  path.join(process.cwd(), "models", "whisper");
const WHISPER_BIN = process.env.WHISPER_BIN || "whisper";
const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";

const SEARCH_MAX_LIMIT = Math.max(
  1,
  Number(process.env.KINGSSPACE_SEARCH_MAX_LIMIT || 50),
);

const ASK_MAX_RESULTS = Math.max(
  1,
  Number(process.env.KINGSSPACE_ASK_MAX_RESULTS || 8),
);

const TRANSCRIPT_TMP_DIR =
  process.env.KINGSSPACE_TRANSCRIPT_TMP_DIR ||
  path.join(os.tmpdir(), "kingspace-search");

/**
 * ---------------------------------------------------------------------------
 * MYSQL DB
 * ---------------------------------------------------------------------------
 */
const IMMTV_DB_HOST =
  process.env.IMMTV_DB_HOST ||
  process.env.DB_HOST ||
  "myinstance-cluster.cluster-cuisll1bhvo4.us-east-1.rds.amazonaws.com";

const IMMTV_DB_PORT = Number(
  process.env.IMMTV_DB_PORT || process.env.DB_PORT || 3306,
);

const IMMTV_DB_USER =
  process.env.IMMTV_DB_USER || process.env.DB_USERNAME || "usr_immtv_web";

const IMMTV_DB_PASSWORD =
  process.env.IMMTV_DB_PASSWORD ||
  process.env.DB_PASSWORD ||
  "094ru394utjg3jt3SJDJJD";

const IMMTV_DB_NAME =
  process.env.IMMTV_DB_NAME || process.env.DB_DATABASE || "db_immtv";

const IMMTV_DB_TABLE = process.env.IMMTV_DB_TABLE || "video_tbl";
const IMMTV_CHANNEL_TABLE = process.env.IMMTV_CHANNEL_TABLE || "channels";

const AI_VIDEO_TABLE = process.env.IMMTV_AI_VIDEO_TABLE || "ks_ai_videos";
const AI_SEGMENT_TABLE =
  process.env.IMMTV_AI_SEGMENT_TABLE || "ks_ai_video_segments";

const externalMysqlPool = mysql.createPool({
  host: IMMTV_DB_HOST,
  port: IMMTV_DB_PORT,
  user: IMMTV_DB_USER,
  password: IMMTV_DB_PASSWORD,
  database: IMMTV_DB_NAME,
  waitForConnections: true,
  connectionLimit: Number(process.env.IMMTV_DB_POOL_SIZE || 10),
  queueLimit: 0,
  charset: "utf8mb4",
  connectTimeout: 10000,
  ssl:
    String(process.env.IMMTV_DB_SSL || "").toLowerCase() === "false"
      ? undefined
      : { rejectUnauthorized: false },
});

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL,
});

let schemaReadyPromise = null;

/**
 * ---------------------------------------------------------------------------
 * SCHEMA
 * ---------------------------------------------------------------------------
 */
async function ensureSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      const conn = await externalMysqlPool.getConnection();
      try {
        await conn.query(`
          CREATE TABLE IF NOT EXISTS \`${AI_VIDEO_TABLE}\` (
            video_id BIGINT NOT NULL PRIMARY KEY,
            channel_id BIGINT NULL,
            title TEXT NOT NULL,
            slug VARCHAR(255) NULL,
            description LONGTEXT NULL,
            raw_tags TEXT NULL,
            tags_json JSON NULL,
            thumbnail TEXT NULL,
            playback_url TEXT NULL,
            ios_url TEXT NULL,
            vod_playback TEXT NULL,
            duration_seconds DECIMAL(10,2) NULL,
            video_type VARCHAR(100) NULL,
            is_short TINYINT(1) NOT NULL DEFAULT 0,
            is_public TINYINT(1) NOT NULL DEFAULT 1,
            is_live TINYINT(1) NOT NULL DEFAULT 0,
            channel_name VARCHAR(255) NULL,
            category_id BIGINT NULL,
            num_views INT NOT NULL DEFAULT 0,
            likes_count INT NOT NULL DEFAULT 0,
            comments_count INT NOT NULL DEFAULT 0,
            created_at_remote DATETIME NULL,
            updated_at_remote DATETIME NULL,
            published_label VARCHAR(255) NULL,
            transcript_status VARCHAR(50) NOT NULL DEFAULT 'pending',
            transcript_text LONGTEXT NULL,
            transcript_language VARCHAR(50) NULL,
            transcript_error TEXT NULL,
            searchable_text LONGTEXT NULL,
            metadata JSON NULL,
            last_ingested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

            INDEX idx_ai_videos_channel_id (channel_id),
            INDEX idx_ai_videos_created_remote (created_at_remote),
            INDEX idx_ai_videos_updated_remote (updated_at_remote),
            INDEX idx_ai_videos_is_live (is_live),
            INDEX idx_ai_videos_is_short (is_short),
            FULLTEXT INDEX ft_ai_videos_search (
              title,
              description,
              raw_tags,
              channel_name,
              transcript_text,
              searchable_text
            )
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await conn.query(`
          CREATE TABLE IF NOT EXISTS \`${AI_SEGMENT_TABLE}\` (
            id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            video_id BIGINT NOT NULL,
            segment_index INT NOT NULL,
            start_seconds DECIMAL(10,2) NOT NULL DEFAULT 0,
            end_seconds DECIMAL(10,2) NOT NULL DEFAULT 0,
            text LONGTEXT NOT NULL,
            searchable_text LONGTEXT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

            UNIQUE KEY uq_video_segment (video_id, segment_index),
            INDEX idx_ai_segments_video_id (video_id),
            INDEX idx_ai_segments_start_seconds (start_seconds),
            FULLTEXT INDEX ft_ai_segments_search (text, searchable_text),

            CONSTRAINT fk_ai_segments_video
              FOREIGN KEY (video_id) REFERENCES \`${AI_VIDEO_TABLE}\`(video_id)
              ON DELETE CASCADE
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        console.log("[kingsspace search] mysql AI schema ready");
      } finally {
        conn.release();
      }
    })();
  }

  return schemaReadyPromise;
}

/**
 * ---------------------------------------------------------------------------
 * HELPERS
 * ---------------------------------------------------------------------------
 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function requireApiKey(req, res, next) {
  if (!GENERAL_API_KEY) return next();

  const incoming =
    req.header("x-api-key") ||
    req
      .header("authorization")
      ?.replace(/^Bearer\s+/i, "")
      .trim();

  if (!incoming || incoming !== GENERAL_API_KEY) {
    return res.status(401).json({
      status: false,
      message: "Unauthorized",
    });
  }

  next();
}

function ensureOpenAIConfigured() {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set");
  }
}

function toInt(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function toNum(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toBoolLoose(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value == null) return fallback;
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes"].includes(s)) return true;
  if (["0", "false", "no"].includes(s)) return false;
  return fallback;
}

function cleanText(input) {
  return String(input || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSearchText(input) {
  return cleanText(input).normalize("NFKC").toLowerCase();
}

function normalizeTag(tag) {
  return String(tag || "")
    .replace(/^#+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parseTags(rawTags) {
  if (!rawTags) return [];
  const parts = String(rawTags)
    .split(",")
    .map((s) => normalizeTag(s))
    .filter(Boolean);

  return [...new Set(parts)];
}

function safeJsonParse(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toMysqlDateTime(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hrs = String(d.getHours()).padStart(2, "0");
  const mins = String(d.getMinutes()).padStart(2, "0");
  const secs = String(d.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hrs}:${mins}:${secs}`;
}

function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds || 0)));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(
      2,
      "0",
    )}`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function buildSearchableText(video, transcriptText = "") {
  const parts = [
    video.title,
    video.slug,
    video.description,
    video.raw_tags,
    Array.isArray(video.tags) ? video.tags.join(" ") : "",
    video.channel_name,
    transcriptText,
  ];

  return normalizeSearchText(parts.filter(Boolean).join(" "));
}

function isM3U8Url(value) {
  const url = cleanText(value || "").toLowerCase();
  if (!url) return false;
  return url.includes(".m3u8");
}

function pickBestPlaybackUrl(video) {
  const url = cleanText(video.url || "");
  const vodPlayback = cleanText(video.vodPlayBack || "");
  const iosUrl = cleanText(video.ios_url || "");

  if (url && !isM3U8Url(url)) return url;
  if (vodPlayback && !isM3U8Url(vodPlayback)) return vodPlayback;
  if (iosUrl && !isM3U8Url(iosUrl)) return iosUrl;

  return "";
}

function buildChannelPayload(input = {}) {
  const id = input.id == null || input.id === "" ? null : toInt(input.id, null);

  const name = cleanText(input.name || "");
  const thumbnail = cleanText(input.thumbnail || "");
  const slug = cleanText(input.slug || "");

  return {
    id,
    name,
    thumbnail,
    slug,
    isVerified: toBoolLoose(input.isVerified, false),
  };
}

function normalizeFetchedVideo(video) {
  const title = cleanText(video.videos_title || video.title || "");
  const description = cleanText(video.description || "");
  const rawTags = cleanText(video.tags || "");
  const tags = parseTags(rawTags);
  const playbackUrl = pickBestPlaybackUrl(video);

  return {
    video_id: toInt(video.id),
    channel_id:
      video.channel_id == null || video.channel_id === ""
        ? null
        : toInt(video.channel_id, null),
    title,
    slug: cleanText(video.slug || ""),
    description,
    raw_tags: rawTags,
    tags,
    thumbnail: cleanText(video.thumbnail || ""),
    playback_url: playbackUrl,
    ios_url: cleanText(video.ios_url || ""),
    vod_playback: cleanText(video.vodPlayBack || ""),
    duration_seconds:
      video.duration == null || video.duration === ""
        ? null
        : toNum(video.duration, null),
    video_type: cleanText(video.type || "video"),
    is_short: toBoolLoose(video.isShort, false),
    is_public: toBoolLoose(video.isPublic, true),
    is_live: toBoolLoose(video.isLive, false),
    channel_name: cleanText(video.channel || ""),
    category_id:
      video.category == null || video.category === ""
        ? null
        : toInt(video.category, null),
    num_views: toInt(video.numOfViews, 0),
    likes_count: toInt(video.likes, 0),
    comments_count: toInt(video.numOfComments, 0),
    created_at_remote: video.created_at || null,
    updated_at_remote: video.updated_at || null,
    published_label: cleanText(video.datePublished || ""),
    metadata: video,
  };
}

function arraysEqual(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (String(left[i]) !== String(right[i])) return false;
  }
  return true;
}

function buildVideoFirstAnswer(question, results, messages = []) {
  const normalizedMessages = normalizeConversationMessages(messages);
  const rawQuestion = getLatestUserQuestion(question, normalizedMessages);
  const latestQuestion = normalizeSearchText(rawQuestion);

  const casualMessages = new Set([
    "hi",
    "hello",
    "hey",
    "good morning",
    "good afternoon",
    "good evening",
  ]);

  if (casualMessages.has(latestQuestion)) {
    return "Hi! What would you like to watch today?";
  }

  if (!results.length) {
    return "I couldn’t find a matching video for that. Try a title, topic, speaker, or keyword.";
  }

  if (isAskingForMore(latestQuestion)) {
    return "Here are more videos you may like.";
  }

  const top = results[0];
  const channel = cleanText(top.channel?.name || top.channelName || "");
  const views = Number(top.views || 0);

  const reasons = [];
  if (top.match?.startLabel) {
    reasons.push(`it covers this around ${top.match.startLabel}`);
  }
  if (channel) reasons.push(`it's from ${channel}`);
  if (views > 0) reasons.push(`${views.toLocaleString()} views`);

  const reasonText = reasons.length
    ? ` — ${reasons.join(", ")}, and the closest match to "${rawQuestion}".`
    : ` — the closest match to "${rawQuestion}".`;

  return `Watch this: ${top.title}${reasonText}`;
}

function isAskingForMore(question) {
  const s = normalizeSearchText(question);

  return [
    "more",
    "show more",
    "give me more",
    "another",
    "another one",
    "next",
    "more videos",
    "show me more",
    "any others",
    "others",
  ].some((phrase) => s.includes(phrase));
}

function shouldReturnRecommendedVideos(question, messages = []) {
  const s = normalizeSearchText(question);
  if (!s) return false;

  const casualMessages = new Set([
    "hi",
    "hello",
    "hey",
    "thanks",
    "thank you",
    "good morning",
    "good afternoon",
    "good evening",
  ]);

  if (casualMessages.has(s)) return false;

  return true;
}

function sameNullableNumber(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Number(a) === Number(b);
}

function sameNullableString(a, b) {
  return cleanText(a || "") === cleanText(b || "");
}

function sameNullableDateish(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;

  const aTime = new Date(a).getTime();
  const bTime = new Date(b).getTime();

  if (Number.isNaN(aTime) || Number.isNaN(bTime)) {
    return String(a || "") === String(b || "");
  }

  return aTime === bTime;
}

async function getExistingVideo(videoId) {
  const [rows] = await externalMysqlPool.query(
    `
    SELECT *
    FROM \`${AI_VIDEO_TABLE}\`
    WHERE video_id = ?
    LIMIT 1
    `,
    [videoId],
  );

  if (!rows.length) return null;

  const row = rows[0];
  return {
    ...row,
    tags: safeJsonParse(row.tags_json, []),
    metadata: safeJsonParse(row.metadata, {}),
  };
}

async function getExistingSegments(videoId) {
  const [rows] = await externalMysqlPool.query(
    `
    SELECT
      segment_index,
      start_seconds,
      end_seconds,
      text,
      searchable_text
    FROM \`${AI_SEGMENT_TABLE}\`
    WHERE video_id = ?
    ORDER BY segment_index ASC
    `,
    [videoId],
  );

  return rows.map((row) => ({
    segment_index: Number(row.segment_index),
    start_seconds: row.start_seconds != null ? Number(row.start_seconds) : 0,
    end_seconds: row.end_seconds != null ? Number(row.end_seconds) : 0,
    text: cleanText(row.text || ""),
    searchable_text: cleanText(row.searchable_text || ""),
  }));
}

function hasVideoContentChanged(existing, normalizedVideo) {
  if (!existing) return true;

  return !(
    Number(existing.video_id) === Number(normalizedVideo.video_id) &&
    sameNullableNumber(existing.channel_id, normalizedVideo.channel_id) &&
    sameNullableString(existing.title, normalizedVideo.title) &&
    sameNullableString(existing.slug, normalizedVideo.slug) &&
    sameNullableString(existing.description, normalizedVideo.description) &&
    sameNullableString(existing.raw_tags, normalizedVideo.raw_tags) &&
    arraysEqual(existing.tags, normalizedVideo.tags) &&
    sameNullableString(existing.thumbnail, normalizedVideo.thumbnail) &&
    sameNullableString(existing.playback_url, normalizedVideo.playback_url) &&
    sameNullableString(existing.ios_url, normalizedVideo.ios_url) &&
    sameNullableString(existing.vod_playback, normalizedVideo.vod_playback) &&
    sameNullableNumber(
      existing.duration_seconds,
      normalizedVideo.duration_seconds,
    ) &&
    sameNullableString(existing.video_type, normalizedVideo.video_type) &&
    Boolean(existing.is_short) === Boolean(normalizedVideo.is_short) &&
    Boolean(existing.is_public) === Boolean(normalizedVideo.is_public) &&
    Boolean(existing.is_live) === Boolean(normalizedVideo.is_live) &&
    sameNullableString(existing.channel_name, normalizedVideo.channel_name) &&
    sameNullableNumber(existing.category_id, normalizedVideo.category_id)
  );
}

function hasVideoMetadataChanged(existing, normalizedVideo) {
  if (!existing) return true;

  return !(
    Number(existing.num_views || 0) ===
      Number(normalizedVideo.num_views || 0) &&
    Number(existing.likes_count || 0) ===
      Number(normalizedVideo.likes_count || 0) &&
    Number(existing.comments_count || 0) ===
      Number(normalizedVideo.comments_count || 0) &&
    sameNullableDateish(
      existing.created_at_remote,
      normalizedVideo.created_at_remote,
    ) &&
    sameNullableDateish(
      existing.updated_at_remote,
      normalizedVideo.updated_at_remote,
    ) &&
    sameNullableString(
      existing.published_label,
      normalizedVideo.published_label,
    )
  );
}

async function fetchVideoFromCeflix(videoId) {
  const res = await fetch(CEFLIX_VIDEO_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Application-Key": CEFLIX_APPLICATION_KEY,
    },
    body: JSON.stringify({
      video: Number(videoId),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ceflix API failed (${res.status}): ${text.slice(0, 500)}`);
  }

  const json = await res.json();

  if (!json?.status || !json?.data?.video) {
    throw new Error("Video was not found in Ceflix API response");
  }

  return json.data.video;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (buf) => {
      stdout += String(buf);
    });

    child.stderr.on("data", (buf) => {
      stderr += String(buf);
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${command} exited with code ${code}\n${
              stderr || stdout || ""
            }`.trim(),
          ),
        );
      }
    });
  });
}

async function transcribeFromVideoUrl(videoId, sourceUrl) {
  if (!sourceUrl) {
    throw new Error("No source video URL available for transcription");
  }

  await fs.promises.mkdir(TRANSCRIPT_TMP_DIR, { recursive: true });
  await fs.promises.mkdir(WHISPER_MODEL_DIR, { recursive: true });

  const workDir = path.join(
    TRANSCRIPT_TMP_DIR,
    `${videoId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  );

  await fs.promises.mkdir(workDir, { recursive: true });

  const wavPath = path.join(workDir, "audio.wav");
  const whisperOutDir = path.join(workDir, "whisper");
  await fs.promises.mkdir(whisperOutDir, { recursive: true });

  try {
    await runCommand(FFMPEG_BIN, [
      "-y",
      "-i",
      sourceUrl,
      "-vn",
      "-acodec",
      "pcm_s16le",
      "-ar",
      "16000",
      "-ac",
      "1",
      wavPath,
    ]);

    const whisperArgs = [
      wavPath,
      "--model",
      WHISPER_MODEL,
      "--model_dir",
      WHISPER_MODEL_DIR,
      "--output_dir",
      whisperOutDir,
      "--output_format",
      "json",
      "--verbose",
      "True",
    ];

    await runCommand(WHISPER_BIN, whisperArgs);

    const jsonFile = path.join(whisperOutDir, "audio.json");
    if (!fs.existsSync(jsonFile)) {
      throw new Error("Whisper JSON output file not found");
    }

    const parsed = JSON.parse(await fs.promises.readFile(jsonFile, "utf8"));
    const segments = Array.isArray(parsed?.segments) ? parsed.segments : [];
    const text = cleanText(
      parsed?.text || segments.map((s) => s.text).join(" "),
    );

    return {
      language: parsed?.language || null,
      text,
      segments: segments.map((s, index) => ({
        segment_index: index,
        start_seconds: toNum(s.start, 0),
        end_seconds: toNum(s.end, 0),
        text: cleanText(s.text || ""),
      })),
    };
  } finally {
    fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function upsertVideoAndSegments(
  normalizedVideo,
  transcriptResult,
  options = {},
) {
  const conn = await externalMysqlPool.getConnection();

  try {
    await conn.beginTransaction();

    const reuseExistingTranscript = Boolean(
      transcriptResult?.reuseExistingTranscript,
    );

    const transcriptText = cleanText(transcriptResult?.text || "");
    const searchableText = buildSearchableText(normalizedVideo, transcriptText);

    const transcriptStatus = cleanText(
      options.transcriptStatus || (transcriptResult ? "ready" : "failed"),
    );

    const transcriptError = options.transcriptError
      ? String(options.transcriptError).slice(0, 5000)
      : null;

    await conn.query(
      `
      INSERT INTO \`${AI_VIDEO_TABLE}\` (
        video_id,
        channel_id,
        title,
        slug,
        description,
        raw_tags,
        tags_json,
        thumbnail,
        playback_url,
        ios_url,
        vod_playback,
        duration_seconds,
        video_type,
        is_short,
        is_public,
        is_live,
        channel_name,
        category_id,
        num_views,
        likes_count,
        comments_count,
        created_at_remote,
        updated_at_remote,
        published_label,
        transcript_status,
        transcript_text,
        transcript_language,
        transcript_error,
        searchable_text,
        metadata,
        last_ingested_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE
        channel_id = VALUES(channel_id),
        title = VALUES(title),
        slug = VALUES(slug),
        description = VALUES(description),
        raw_tags = VALUES(raw_tags),
        tags_json = VALUES(tags_json),
        thumbnail = VALUES(thumbnail),
        playback_url = VALUES(playback_url),
        ios_url = VALUES(ios_url),
        vod_playback = VALUES(vod_playback),
        duration_seconds = VALUES(duration_seconds),
        video_type = VALUES(video_type),
        is_short = VALUES(is_short),
        is_public = VALUES(is_public),
        is_live = VALUES(is_live),
        channel_name = VALUES(channel_name),
        category_id = VALUES(category_id),
        num_views = VALUES(num_views),
        likes_count = VALUES(likes_count),
        comments_count = VALUES(comments_count),
        created_at_remote = VALUES(created_at_remote),
        updated_at_remote = VALUES(updated_at_remote),
        published_label = VALUES(published_label),
        transcript_status = VALUES(transcript_status),
        transcript_text = VALUES(transcript_text),
        transcript_language = VALUES(transcript_language),
        transcript_error = VALUES(transcript_error),
        searchable_text = VALUES(searchable_text),
        metadata = VALUES(metadata),
        last_ingested_at = NOW()
      `,
      [
        normalizedVideo.video_id,
        normalizedVideo.channel_id,
        normalizedVideo.title,
        normalizedVideo.slug,
        normalizedVideo.description,
        normalizedVideo.raw_tags,
        JSON.stringify(normalizedVideo.tags || []),
        normalizedVideo.thumbnail,
        normalizedVideo.playback_url,
        normalizedVideo.ios_url,
        normalizedVideo.vod_playback,
        normalizedVideo.duration_seconds,
        normalizedVideo.video_type,
        normalizedVideo.is_short ? 1 : 0,
        normalizedVideo.is_public ? 1 : 0,
        normalizedVideo.is_live ? 1 : 0,
        normalizedVideo.channel_name,
        normalizedVideo.category_id,
        normalizedVideo.num_views,
        normalizedVideo.likes_count,
        normalizedVideo.comments_count,
        toMysqlDateTime(normalizedVideo.created_at_remote),
        toMysqlDateTime(normalizedVideo.updated_at_remote),
        normalizedVideo.published_label,
        transcriptStatus,
        transcriptText || null,
        transcriptResult?.language || null,
        transcriptError,
        searchableText,
        JSON.stringify(normalizedVideo.metadata || {}),
      ],
    );

    if (!reuseExistingTranscript) {
      await conn.query(
        `DELETE FROM \`${AI_SEGMENT_TABLE}\` WHERE video_id = ?`,
        [normalizedVideo.video_id],
      );

      if (
        Array.isArray(transcriptResult?.segments) &&
        transcriptResult.segments.length
      ) {
        for (const seg of transcriptResult.segments) {
          const segText = cleanText(seg.text);
          if (!segText) continue;

          await conn.query(
            `
            INSERT INTO \`${AI_SEGMENT_TABLE}\` (
              video_id,
              segment_index,
              start_seconds,
              end_seconds,
              text,
              searchable_text
            )
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              start_seconds = VALUES(start_seconds),
              end_seconds = VALUES(end_seconds),
              text = VALUES(text),
              searchable_text = VALUES(searchable_text)
            `,
            [
              normalizedVideo.video_id,
              seg.segment_index,
              seg.start_seconds,
              seg.end_seconds,
              segText,
              normalizeSearchText(
                [
                  normalizedVideo.title,
                  normalizedVideo.channel_name,
                  normalizedVideo.raw_tags,
                  segText,
                ].join(" "),
              ),
            ],
          );
        }
      }
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();

    try {
      await conn.query(
        `
        INSERT INTO \`${AI_VIDEO_TABLE}\` (
          video_id,
          channel_id,
          title,
          slug,
          description,
          raw_tags,
          tags_json,
          thumbnail,
          playback_url,
          ios_url,
          vod_playback,
          duration_seconds,
          video_type,
          is_short,
          is_public,
          is_live,
          channel_name,
          category_id,
          num_views,
          likes_count,
          comments_count,
          created_at_remote,
          updated_at_remote,
          published_label,
          transcript_status,
          transcript_error,
          searchable_text,
          metadata,
          last_ingested_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          channel_id = VALUES(channel_id),
          title = VALUES(title),
          slug = VALUES(slug),
          description = VALUES(description),
          raw_tags = VALUES(raw_tags),
          tags_json = VALUES(tags_json),
          thumbnail = VALUES(thumbnail),
          playback_url = VALUES(playback_url),
          ios_url = VALUES(ios_url),
          vod_playback = VALUES(vod_playback),
          duration_seconds = VALUES(duration_seconds),
          video_type = VALUES(video_type),
          is_short = VALUES(is_short),
          is_public = VALUES(is_public),
          is_live = VALUES(is_live),
          channel_name = VALUES(channel_name),
          category_id = VALUES(category_id),
          num_views = VALUES(num_views),
          likes_count = VALUES(likes_count),
          comments_count = VALUES(comments_count),
          created_at_remote = VALUES(created_at_remote),
          updated_at_remote = VALUES(updated_at_remote),
          published_label = VALUES(published_label),
          transcript_status = VALUES(transcript_status),
          transcript_error = VALUES(transcript_error),
          searchable_text = VALUES(searchable_text),
          metadata = VALUES(metadata),
          last_ingested_at = NOW()
        `,
        [
          normalizedVideo.video_id,
          normalizedVideo.channel_id,
          normalizedVideo.title,
          normalizedVideo.slug,
          normalizedVideo.description,
          normalizedVideo.raw_tags,
          JSON.stringify(normalizedVideo.tags || []),
          normalizedVideo.thumbnail,
          normalizedVideo.playback_url,
          normalizedVideo.ios_url,
          normalizedVideo.vod_playback,
          normalizedVideo.duration_seconds,
          normalizedVideo.video_type,
          normalizedVideo.is_short ? 1 : 0,
          normalizedVideo.is_public ? 1 : 0,
          normalizedVideo.is_live ? 1 : 0,
          normalizedVideo.channel_name,
          normalizedVideo.category_id,
          normalizedVideo.num_views,
          normalizedVideo.likes_count,
          normalizedVideo.comments_count,
          toMysqlDateTime(normalizedVideo.created_at_remote),
          toMysqlDateTime(normalizedVideo.updated_at_remote),
          normalizedVideo.published_label,
          "failed",
          String(err.message || "Transcription failed").slice(0, 5000),
          buildSearchableText(normalizedVideo, ""),
          JSON.stringify(normalizedVideo.metadata || {}),
        ],
      );
    } catch (secondaryErr) {
      console.error(
        "[kingsspace search] fallback upsert failed:",
        secondaryErr,
      );
    }

    throw err;
  } finally {
    conn.release();
  }
}

/**
 * ---------------------------------------------------------------------------
 * INTERNAL AI SEARCH
 * ---------------------------------------------------------------------------
 */
async function searchVideos(query, limit = 10) {
  const q = cleanText(query);
  const qLower = normalizeSearchText(query);
  const cappedLimit = Math.max(
    1,
    Math.min(Number(limit || 10), SEARCH_MAX_LIMIT),
  );

  if (!q) return [];

  const likeQ = `%${qLower}%`;

  const [rows] = await externalMysqlPool.query(
    `
    SELECT
      v.video_id,
      v.channel_id,
      v.title,
      v.slug,
      v.description,
      v.tags_json,
      v.thumbnail,
      v.playback_url,
      v.duration_seconds,
      v.channel_name,
      v.num_views,
      v.likes_count,
      v.comments_count,
      v.created_at_remote,
      v.is_short,
      v.transcript_status,
      v.metadata,
      v.transcript_text,

      (
        MATCH(v.title, v.description, v.raw_tags, v.channel_name, v.transcript_text, v.searchable_text)
        AGAINST (? IN NATURAL LANGUAGE MODE)
      ) AS fts_score,

      (
        CASE WHEN LOWER(COALESCE(v.title, '')) LIKE ? THEN 30 ELSE 0 END +
        CASE WHEN LOWER(COALESCE(v.description, '')) LIKE ? THEN 10 ELSE 0 END +
        CASE WHEN LOWER(COALESCE(v.raw_tags, '')) LIKE ? THEN 18 ELSE 0 END +
        CASE WHEN LOWER(COALESCE(v.channel_name, '')) LIKE ? THEN 8 ELSE 0 END +
CASE WHEN LOWER(COALESCE(v.transcript_text, '')) LIKE ? THEN 2 ELSE 0 END
      ) AS like_score

    FROM \`${AI_VIDEO_TABLE}\` v
    WHERE
      MATCH(v.title, v.description, v.raw_tags, v.channel_name, v.transcript_text, v.searchable_text)
        AGAINST (? IN NATURAL LANGUAGE MODE)
      OR LOWER(COALESCE(v.title, '')) LIKE ?
      OR LOWER(COALESCE(v.description, '')) LIKE ?
      OR LOWER(COALESCE(v.raw_tags, '')) LIKE ?
      OR LOWER(COALESCE(v.channel_name, '')) LIKE ?
      OR LOWER(COALESCE(v.transcript_text, '')) LIKE ?
    ORDER BY
      (COALESCE(like_score, 0) + COALESCE(fts_score, 0) + LEAST(COALESCE(v.num_views, 0), 50000) / 5000) DESC,
      v.created_at_remote DESC,
      v.video_id DESC
    LIMIT ?
    `,
    [
      q,
      likeQ,
      likeQ,
      likeQ,
      likeQ,
      likeQ,
      q,
      likeQ,
      likeQ,
      likeQ,
      likeQ,
      likeQ,
      cappedLimit,
    ],
  );

  const videoIds = rows.map((r) => Number(r.video_id)).filter(Boolean);
  const segmentMap = new Map();

  if (videoIds.length) {
    const placeholders = videoIds.map(() => "?").join(",");

    const [segmentRows] = await externalMysqlPool.query(
      `
      SELECT
        s.video_id,
        s.start_seconds,
        s.end_seconds,
        s.text,
        (
          MATCH(s.text, s.searchable_text)
          AGAINST (? IN NATURAL LANGUAGE MODE)
        ) AS seg_score
      FROM \`${AI_SEGMENT_TABLE}\` s
      WHERE
        s.video_id IN (${placeholders})
        AND (
          MATCH(s.text, s.searchable_text) AGAINST (? IN NATURAL LANGUAGE MODE)
          OR LOWER(COALESCE(s.text, '')) LIKE ?
          OR LOWER(COALESCE(s.searchable_text, '')) LIKE ?
        )
      ORDER BY s.video_id ASC, seg_score DESC, s.start_seconds ASC
      `,
      [q, ...videoIds, q, likeQ, likeQ],
    );

    for (const row of segmentRows) {
      if (!segmentMap.has(Number(row.video_id))) {
        segmentMap.set(Number(row.video_id), row);
      }
    }
  }

  return rows.map((row) => {
    const durationSeconds =
      row.duration_seconds != null ? Number(row.duration_seconds) : null;

    const rawMeta = safeJsonParse(row.metadata, {});
    const tags = safeJsonParse(row.tags_json, []);

    const channel = buildChannelPayload({
      id: row.channel_id,
      name: row.channel_name,
      thumbnail:
        rawMeta.channel_thumbnail ||
        rawMeta.channel_image ||
        rawMeta.channelThumbnail ||
        "",
      slug: rawMeta.channel_slug || rawMeta.channelSlug || "",
      isVerified: rawMeta.isVerified ?? rawMeta.channel_is_verified ?? false,
    });

    const matchRow = segmentMap.get(Number(row.video_id));

    return {
      videoId: row.video_id,
      channelId: row.channel_id,
      title: row.title,
      slug: row.slug,
      description: row.description,
      tags: Array.isArray(tags) ? tags : [],
      thumbnail: row.thumbnail,
      playbackUrl: row.playback_url,
      duration: durationSeconds,
      durationSeconds,
      channel,
      channelName: channel.name,
      channelThumbnail: channel.thumbnail,
      views: row.num_views,
      likes: row.likes_count,
      comments: row.comments_count,
      createdAt: row.created_at_remote,
      isShort: Boolean(row.is_short),
      transcriptStatus: row.transcript_status,
      match: matchRow
        ? {
            startSeconds: Number(matchRow.start_seconds || 0),
            endSeconds: Number(matchRow.end_seconds || 0),
            startLabel: formatTimestamp(matchRow.start_seconds || 0),
            endLabel: formatTimestamp(matchRow.end_seconds || 0),
            text: matchRow.text,
          }
        : null,
      score: Number(
        (Number(row.fts_score || 0) * 3 + Number(row.like_score || 0)).toFixed(
          3,
        ),
      ),
    };
  });
}

async function attachTranscriptMatches(results, query) {
  const q = cleanText(query);
  if (!q || !results.length) return results;

  const videoIds = results.map((r) => Number(r.videoId)).filter(Boolean);
  if (!videoIds.length) return results;

  const qLower = normalizeSearchText(query);
  const likeQ = `%${qLower}%`;
  const placeholders = videoIds.map(() => "?").join(",");

  const [segmentRows] = await externalMysqlPool.query(
    `
    SELECT
      s.video_id,
      s.start_seconds,
      s.end_seconds,
      s.text,
      (
        MATCH(s.text, s.searchable_text)
        AGAINST (? IN NATURAL LANGUAGE MODE)
      ) AS seg_score
    FROM \`${AI_SEGMENT_TABLE}\` s
    WHERE
      s.video_id IN (${placeholders})
      AND (
        MATCH(s.text, s.searchable_text) AGAINST (? IN NATURAL LANGUAGE MODE)
        OR LOWER(COALESCE(s.text, '')) LIKE ?
        OR LOWER(COALESCE(s.searchable_text, '')) LIKE ?
      )
    ORDER BY s.video_id ASC, seg_score DESC, s.start_seconds ASC
    `,
    [q, ...videoIds, q, likeQ, likeQ],
  );

  const segmentMap = new Map();
  for (const row of segmentRows) {
    if (!segmentMap.has(Number(row.video_id))) {
      segmentMap.set(Number(row.video_id), row);
    }
  }

  return results.map((r) => {
    const matchRow = segmentMap.get(Number(r.videoId));
    if (!matchRow) return r;

    return {
      ...r,
      match: {
        startSeconds: Number(matchRow.start_seconds || 0),
        endSeconds: Number(matchRow.end_seconds || 0),
        startLabel: formatTimestamp(matchRow.start_seconds || 0),
        endLabel: formatTimestamp(matchRow.end_seconds || 0),
        text: matchRow.text,
      },
    };
  });
}

/**
 * ---------------------------------------------------------------------------
 * EXTERNAL SEARCH HELPERS
 * ---------------------------------------------------------------------------
 */
function getFirstField(row, keys, fallback = null) {
  for (const key of keys) {
    if (row[key] != null && row[key] !== "") {
      return row[key];
    }
  }
  return fallback;
}

function splitLooseTags(value) {
  return String(value || "")
    .split(/[,#|;]/)
    .map((v) => normalizeTag(v))
    .filter(Boolean);
}

function normalizeExternalVideo(row) {
  const rawTags = cleanText(
    getFirstField(row, [
      "tags",
      "video_tags",
      "tag",
      "keywords",
      "meta_keywords",
    ]) || "",
  );

  const title = cleanText(
    getFirstField(row, ["videos_title", "video_title", "title", "name"]) || "",
  );

  const description = cleanText(
    getFirstField(row, [
      "description",
      "video_description",
      "details",
      "summary",
      "about",
    ]) || "",
  );

  const slug = cleanText(getFirstField(row, ["slug", "video_slug"]) || "");
  const thumbnail = cleanText(
    getFirstField(row, ["thumbnail", "thumb", "poster", "image"]) || "",
  );
  const playbackUrl = cleanText(
    getFirstField(row, ["url", "video_url", "playback_url", "source"]) || "",
  );
  const iosUrl = cleanText(getFirstField(row, ["ios_url", "iosUrl"]) || "");
  const vodPlayback = cleanText(
    getFirstField(row, ["vodPlayBack", "vod_playback"]) || "",
  );
  const hlsPlayBack = cleanText(
    getFirstField(row, ["hlsPlayBack", "hls_playback"]) || "",
  );

  const channel = buildChannelPayload({
    id: getFirstField(row, [
      "channel_join_id",
      "channel_id",
      "channelID",
      "channelId",
    ]),
    name: getFirstField(row, [
      "channel_name",
      "channel",
      "author",
      "owner",
      "username",
    ]),
    thumbnail: getFirstField(row, [
      "channel_thumbnail",
      "channel_image",
      "channel_url",
      "channel_thumb",
      "url",
    ]),
    slug: getFirstField(row, ["channel_slug"]),
    isVerified: getFirstField(row, ["channel_is_verified", "isVerified"]),
  });

  const publishedLabel = cleanText(
    getFirstField(row, [
      "datePublished",
      "published_label",
      "publish_date",
      "date",
    ]) || "",
  );

  const durationSeconds = toNum(
    getFirstField(row, ["duration", "duration_seconds", "video_duration"]),
    null,
  );

  return {
    videoId: toInt(getFirstField(row, ["id", "videoID", "video_id"]), null),
    channelId: channel.id,
    title,
    slug,
    description,
    category: cleanText(
      getFirstField(row, ["video_category", "category", "category_name"]) || "",
    ),
    tags: splitLooseTags(rawTags),
    rawTags,
    thumbnail,
    playbackUrl,
    iosUrl,
    vodPlayBack: vodPlayback,
    hlsPlayBack,
    rawUrl: cleanText(getFirstField(row, ["rawUrl", "raw_url"]) || ""),
    duration: durationSeconds,
    durationSeconds,
    channel,
    channelName: channel.name,
    channelThumbnail: channel.thumbnail,
    views: toInt(getFirstField(row, ["numOfViews", "views", "view_count"]), 0),
    likes: toInt(getFirstField(row, ["likes", "likes_count", "like_count"]), 0),
    comments: toInt(
      getFirstField(row, ["numOfComments", "comments", "comments_count"]),
      0,
    ),
    createdAt: getFirstField(row, [
      "created_at",
      "date_added",
      "uploadtime",
      "publish_date",
    ]),
    updatedAt: getFirstField(row, ["updated_at", "date_updated"], null),
    publishedLabel,
    isShort: toBoolLoose(getFirstField(row, ["isShort", "is_short"]), false),
    isPremium: toBoolLoose(
      getFirstField(row, ["isPremium", "is_premium"]),
      false,
    ),
    isPublic: toBoolLoose(getFirstField(row, ["isPublic", "is_public"]), true),
    isLive: toBoolLoose(getFirstField(row, ["isLive", "is_live"]), false),
    active: toBoolLoose(getFirstField(row, ["active"]), true),
    processingStatus: cleanText(
      getFirstField(row, ["processingStatus", "processing_status"]) || "",
    ),
    schedule: cleanText(getFirstField(row, ["schedule"]) || ""),
    filename: cleanText(getFirstField(row, ["filename"]) || ""),
    uploadtime: toInt(getFirstField(row, ["uploadtime"]), null),
    uploadtimeTs: toInt(getFirstField(row, ["uploadtime_ts", "uploadtime"]), 0),
    start: getFirstField(row, ["start"], null),
    end: getFirstField(row, ["end"], null),
    startDate: getFirstField(row, ["startDate", "start_date"], null),
    endDate: getFirstField(row, ["endDate", "end_date"], null),
    showdate: getFirstField(row, ["showdate", "show_date"], null),
    source: "immtv",
    raw: row,
  };
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function singularizeWord(word) {
  const w = normalizeSearchText(word);
  if (!w) return "";
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (w.endsWith("ses") && w.length > 3) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3)
    return w.slice(0, -1);
  return w;
}

const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "their",
  "this",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "with",
  "you",
  "your",
]);

function tokenizeSearchQuery(query) {
  const raw = normalizeSearchText(query);
  const words = raw
    .split(/[^a-z0-9]+/i)
    .map((w) => singularizeWord(w))
    .filter(Boolean)
    .filter((w) => w.length >= 2)
    .filter((w) => !SEARCH_STOP_WORDS.has(w));

  return uniqueStrings(words);
}

function buildWordVariants(word) {
  const out = new Set();
  const w = singularizeWord(word);
  if (!w) return [];

  out.add(w);

  if (w.includes("-")) {
    out.add(w.replace(/-/g, " "));
  }

  if (w === "loveworld") {
    out.add("loveworld");
    out.add("love world");
    out.add("pastor chris");
    out.add("yourloveworld");
    out.add("christ embassy");
  }

  return [...out];
}

function buildExpandedQueryWords(query) {
  const baseWords = tokenizeSearchQuery(query);
  const expanded = [];

  for (const word of baseWords) {
    expanded.push(...buildWordVariants(word));
  }

  return {
    baseWords,
    expandedWords: uniqueStrings(expanded),
  };
}

function buildLikeVariants(word) {
  return uniqueStrings(
    buildWordVariants(word).map((variant) => `%${variant}%`),
  );
}

function pickExternalQueryFromRequest(req) {
  return cleanText(req.query.q || req.body?.query || req.body?.q || "");
}

function pickExternalLimitFromRequest(req, fallback = 10) {
  return toInt(req.query.limit || req.body?.limit || req.body?.count, fallback);
}

function pickExternalSortFromRequest(req, fallback = "relevance") {
  return cleanText(req.query.sort || req.body?.sort || fallback).toLowerCase();
}

function extractNumberIntent(text) {
  const s = normalizeSearchText(text);

  const patterns = [
    /\b(day)\s+(\d+)\b/i,
    /\b(part)\s+(\d+)\b/i,
    /\b(episode)\s+(\d+)\b/i,
    /\b(ep)\s+(\d+)\b/i,
    /\b(session)\s+(\d+)\b/i,
    /\b(chapter)\s+(\d+)\b/i,
    /\b(volume)\s+(\d+)\b/i,
    /\b(vol)\s+(\d+)\b/i,
    /\b(series)\s+(\d+)\b/i,
    /\b(no|number)\s+(\d+)\b/i,
  ];

  for (const pattern of patterns) {
    const match = s.match(pattern);
    if (match) {
      return {
        label: match[1].toLowerCase(),
        number: Number(match[2]),
      };
    }
  }

  return null;
}

function extractYearIntent(text) {
  const s = normalizeSearchText(text);
  const match = s.match(/\b(20\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function getNumberIntentScore(queryText, resultText) {
  const queryIntent = extractNumberIntent(queryText);
  const resultIntent = extractNumberIntent(resultText);

  if (!queryIntent) return 0;
  if (!resultIntent) return -40;

  const labelAliases = {
    ep: "episode",
    vol: "volume",
    no: "number",
  };

  const normalizeLabel = (label) => labelAliases[label] || label;

  const queryLabel = normalizeLabel(queryIntent.label);
  const resultLabel = normalizeLabel(resultIntent.label);

  if (queryIntent.number === resultIntent.number) {
    if (queryLabel === resultLabel) return 320;
    return 260;
  }

  if (queryLabel === resultLabel) {
    const distance = Math.abs(queryIntent.number - resultIntent.number);
    if (distance === 1) return -180;
    return -260;
  }

  return -120;
}

function getYearIntentScore(queryText, resultText) {
  const queryYear = extractYearIntent(queryText);
  const resultYear = extractYearIntent(resultText);

  if (!queryYear) return 0;
  if (!resultYear) return -20;
  if (queryYear === resultYear) return 80;
  return -140;
}

function buildExternalSortOrder(sort) {
  if (sort === "latest") {
    return `
      uploadtime_ts DESC,
      relevance_score DESC,
      strict_base_coverage DESC,
      matched_words DESC,
      COALESCE(numOfViews, 0) DESC,
      id DESC
    `;
  }

  if (sort === "oldest") {
    return `
      uploadtime_ts ASC,
      relevance_score DESC,
      strict_base_coverage DESC,
      matched_words DESC,
      COALESCE(numOfViews, 0) DESC,
      id DESC
    `;
  }

  if (sort === "most_viewed" || sort === "views") {
    return `
      COALESCE(numOfViews, 0) DESC,
      relevance_score DESC,
      strict_base_coverage DESC,
      matched_words DESC,
      uploadtime_ts DESC,
      id DESC
    `;
  }

  return `
    relevance_score DESC,
    strict_base_coverage DESC,
    matched_words DESC,
    uploadtime_ts DESC,
    COALESCE(numOfViews, 0) DESC,
    id DESC
  `;
}

async function searchExternalVideos(query, limit = 10, sort = "relevance") {
  const q = cleanText(query);
  const cappedLimit = Math.max(
    1,
    Math.min(Number(limit || 10), SEARCH_MAX_LIMIT),
  );

  if (!q) return [];

  const { baseWords } = buildExpandedQueryWords(q);
  if (!baseWords.length) return [];

  const qLower = normalizeSearchText(q);
  const fullLike = `%${qLower}%`;

  const wordScoreParts = [];
  const wordScoreParams = [];

  const anyWordClauses = [];
  const anyWordParams = [];

  const baseCoverageParts = [];
  const baseCoverageParams = [];

  const allWordsAnywhereClauses = [];
  const allWordsAnywhereParams = [];

  const matchedWordsParts = [];
  const matchedWordsParams = [];

  for (const word of baseWords) {
    const likes = buildLikeVariants(word);

    const perWordFieldChecks = likes
      .map(
        () => `
        LOWER(COALESCE(v.videos_title, '')) LIKE LOWER(?)
        OR LOWER(COALESCE(v.tags, '')) LIKE LOWER(?)
        OR LOWER(COALESCE(v.slug, '')) LIKE LOWER(?)
        OR LOWER(COALESCE(v.description, '')) LIKE LOWER(?)
        OR LOWER(COALESCE(v.video_category, '')) LIKE LOWER(?)
        OR LOWER(COALESCE(v.filename, '')) LIKE LOWER(?)
        OR LOWER(COALESCE(c.channel, '')) LIKE LOWER(?)
      `,
      )
      .join(" OR ");

    const scoreChunkPerVariant = likes
      .map(
        () => `
        (
          CASE WHEN LOWER(COALESCE(v.videos_title, '')) LIKE LOWER(?) THEN 20 ELSE 0 END +
          CASE WHEN LOWER(COALESCE(v.tags, '')) LIKE LOWER(?) THEN 14 ELSE 0 END +
          CASE WHEN LOWER(COALESCE(v.slug, '')) LIKE LOWER(?) THEN 12 ELSE 0 END +
          CASE WHEN LOWER(COALESCE(v.description, '')) LIKE LOWER(?) THEN 5 ELSE 0 END +
          CASE WHEN LOWER(COALESCE(v.video_category, '')) LIKE LOWER(?) THEN 4 ELSE 0 END +
          CASE WHEN LOWER(COALESCE(v.filename, '')) LIKE LOWER(?) THEN 1 ELSE 0 END +
          CASE WHEN LOWER(COALESCE(c.channel, '')) LIKE LOWER(?) THEN 8 ELSE 0 END
        )
      `,
      )
      .join(" + ");

    wordScoreParts.push(`(${scoreChunkPerVariant})`);
    for (const like of likes) {
      wordScoreParams.push(like, like, like, like, like, like, like);
    }

    anyWordClauses.push(`(${perWordFieldChecks})`);
    for (const like of likes) {
      anyWordParams.push(like, like, like, like, like, like, like);
    }

    allWordsAnywhereClauses.push(`(${perWordFieldChecks})`);
    for (const like of likes) {
      allWordsAnywhereParams.push(like, like, like, like, like, like, like);
    }

    baseCoverageParts.push(`
      CASE
        WHEN (${perWordFieldChecks}) THEN 1
        ELSE 0
      END
    `);
    for (const like of likes) {
      baseCoverageParams.push(like, like, like, like, like, like, like);
    }

    matchedWordsParts.push(`
      CASE
        WHEN (${perWordFieldChecks}) THEN 1
        ELSE 0
      END
    `);
    for (const like of likes) {
      matchedWordsParams.push(like, like, like, like, like, like, like);
    }
  }

  const havingCoverageClause =
    baseWords.length === 1
      ? `
        matched_words >= 1
      `
      : baseWords.length === 2
        ? `
          (
            strict_base_coverage >= 2
            OR (strict_base_coverage >= 1 AND relevance_score >= 35)
          )
        `
        : baseWords.length === 3
          ? `
            (
              strict_base_coverage >= 2
              OR (strict_base_coverage >= 1 AND relevance_score >= 140)
            )
          `
          : `
            (
              strict_base_coverage >= 2
              OR (strict_base_coverage >= 1 AND relevance_score >= 220)
            )
          `;

  const orderBy = buildExternalSortOrder(sort);

  const sql = `
    SELECT
      v.id,
      v.channel_id,
      v.videos_title,
      v.slug,
      v.description,
      v.video_category,
      v.tags,
      v.thumbnail,
      v.url,
      v.ios_url,
      v.schedule,
      v.uploadtime,
      v.start,
      v.end,
      v.startDate,
      v.endDate,
      v.showdate,
      v.duration,
      v.type,
      v.likes,
      v.numOfComments,
      v.numOfViews,
      v.isShort,
      v.isPremium,
      v.isPublic,
      v.active,
      v.processingStatus,
      v.rawUrl,
      v.isLive,
      v.filename,
      v.vodPlayBack,
      v.hlsPlayBack,
      v.created_at,
      v.updated_at,

      c.id AS channel_join_id,
      c.channel AS channel_name,
      c.url AS channel_thumbnail,
      c.slug AS channel_slug,
      c.isVerified AS channel_is_verified,

      CAST(COALESCE(NULLIF(TRIM(v.uploadtime), ''), '0') AS UNSIGNED) AS uploadtime_ts,

      (${matchedWordsParts.join(" + ")}) AS matched_words,
      (${baseCoverageParts.join(" + ")}) AS strict_base_coverage,

      (
        CASE WHEN LOWER(COALESCE(v.videos_title, '')) = LOWER(?) THEN 1800 ELSE 0 END +
        CASE WHEN LOWER(COALESCE(v.videos_title, '')) LIKE LOWER(?) THEN 620 ELSE 0 END +
        CASE WHEN LOWER(COALESCE(v.tags, '')) LIKE LOWER(?) THEN 340 ELSE 0 END +
        CASE WHEN LOWER(COALESCE(v.slug, '')) LIKE LOWER(?) THEN 260 ELSE 0 END +
        CASE WHEN LOWER(COALESCE(v.description, '')) LIKE LOWER(?) THEN 90 ELSE 0 END +
        CASE WHEN LOWER(COALESCE(v.video_category, '')) LIKE LOWER(?) THEN 70 ELSE 0 END +
        CASE WHEN LOWER(COALESCE(c.channel, '')) LIKE LOWER(?) THEN 120 ELSE 0 END +

        CASE
          WHEN ${allWordsAnywhereClauses.join(" AND ")} THEN 240
          ELSE 0
        END +

        CASE
          WHEN COALESCE(v.isShort, 0) = 1 THEN -100
          ELSE 0
        END +

        LEAST(COALESCE(v.numOfViews, 0), 50000) / 500.0 +

        ${wordScoreParts.join(" + ")}
      ) AS relevance_score

    FROM \`${IMMTV_DB_TABLE}\` v
    LEFT JOIN \`${IMMTV_CHANNEL_TABLE}\` c
      ON c.id = v.channel_id

    WHERE
      (${anyWordClauses.join(" OR ")})
      AND COALESCE(v.active, 1) = 1
      AND COALESCE(v.isPublic, 1) = 1

    HAVING
      relevance_score > 0
      AND (${havingCoverageClause})

    ORDER BY ${orderBy}
    LIMIT ?
  `;

  const finalParams = [
    ...matchedWordsParams,
    ...baseCoverageParams,

    qLower,
    fullLike,
    fullLike,
    fullLike,
    fullLike,
    fullLike,
    fullLike,

    ...allWordsAnywhereParams,
    ...wordScoreParams,
    ...anyWordParams,
    cappedLimit,
  ];

  const [rows] = await externalMysqlPool.query(sql, finalParams);

  const normalizedResults = rows.map((row) => {
    const title = cleanText(row.videos_title || "");
    const slug = cleanText(row.slug || "");
    const description = cleanText(row.description || "");
    const category = cleanText(row.video_category || "");
    const rawTags = cleanText(row.tags || "");

    const resultText = [
      title,
      slug,
      description,
      category,
      rawTags,
      cleanText(row.channel_name || ""),
    ]
      .filter(Boolean)
      .join(" ");

    const numberIntentScore = getNumberIntentScore(q, resultText);
    const yearIntentScore = getYearIntentScore(q, resultText);

    const adjustedScore =
      Number(row.relevance_score || 0) + numberIntentScore + yearIntentScore;

    const durationSeconds =
      row.duration != null && row.duration !== "" ? Number(row.duration) : null;

    const channel = buildChannelPayload({
      id: row.channel_join_id ?? row.channel_id,
      name: row.channel_name,
      thumbnail: row.channel_thumbnail,
      slug: row.channel_slug,
      isVerified: row.channel_is_verified,
    });

    return {
      videoId: row.id != null ? Number(row.id) : null,
      channelId: row.channel_id != null ? Number(row.channel_id) : null,
      title,
      slug,
      description,
      category,
      tags: parseTags(row.tags || ""),
      rawTags,
      thumbnail: cleanText(row.thumbnail || ""),
      playbackUrl: cleanText(row.url || ""),
      iosUrl: cleanText(row.ios_url || ""),
      vodPlayBack: cleanText(row.vodPlayBack || ""),
      hlsPlayBack: cleanText(row.hlsPlayBack || ""),
      rawUrl: cleanText(row.rawUrl || ""),
      duration: durationSeconds,
      durationSeconds,
      channel,
      channelName: channel.name,
      channelThumbnail: channel.thumbnail,
      views: toInt(row.numOfViews, 0),
      likes: toInt(row.likes, 0),
      comments: toInt(row.numOfComments, 0),
      isShort: toBoolLoose(row.isShort, false),
      isPremium: toBoolLoose(row.isPremium, false),
      isPublic: toBoolLoose(row.isPublic, true),
      isLive: toBoolLoose(row.isLive, false),
      active: toBoolLoose(row.active, true),
      processingStatus: cleanText(row.processingStatus || ""),
      schedule: cleanText(row.schedule || ""),
      filename: cleanText(row.filename || ""),
      uploadtime: row.uploadtime != null ? Number(row.uploadtime) : null,
      uploadtimeTs: row.uploadtime_ts != null ? Number(row.uploadtime_ts) : 0,
      start: row.start || null,
      end: row.end || null,
      startDate: row.startDate || null,
      endDate: row.endDate || null,
      showdate: row.showdate || null,
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
      relevanceScore: Number(adjustedScore.toFixed(3)),
      matchedWords: Number(row.matched_words || 0),
      strictBaseCoverage: Number(row.strict_base_coverage || 0),
      source: "immtv",
    };
  });

  normalizedResults.sort((a, b) => {
    if (b.relevanceScore !== a.relevanceScore) {
      return b.relevanceScore - a.relevanceScore;
    }

    if ((b.strictBaseCoverage || 0) !== (a.strictBaseCoverage || 0)) {
      return (b.strictBaseCoverage || 0) - (a.strictBaseCoverage || 0);
    }

    if ((b.matchedWords || 0) !== (a.matchedWords || 0)) {
      return (b.matchedWords || 0) - (a.matchedWords || 0);
    }

    return (b.uploadtimeTs || 0) - (a.uploadtimeTs || 0);
  });

  return normalizedResults;
}

function normalizeConversationMessages(messages) {
  if (!Array.isArray(messages)) return [];

  return messages
    .map((msg) => ({
      role: cleanText(msg?.role || "").toLowerCase(),
      content: cleanText(msg?.content || ""),
    }))
    .filter(
      (msg) =>
        ["system", "user", "assistant"].includes(msg.role) && msg.content,
    )
    .slice(-20);
}

function getLatestUserQuestion(question, messages) {
  const q = cleanText(question || "");
  if (q) return q;

  const normalized = normalizeConversationMessages(messages);
  for (let i = normalized.length - 1; i >= 0; i -= 1) {
    if (normalized[i].role === "user" && normalized[i].content) {
      return normalized[i].content;
    }
  }

  return "";
}

function isLikelyFollowUpQuestion(text) {
  const s = normalizeSearchText(text);

  if (!s) return false;

  if (s.split(/\s+/).length <= 5) return true;

  return [
    "tell me more",
    "more on that",
    "what about that",
    "what did he say",
    "what did they say",
    "explain that",
    "continue",
    "go on",
    "show more",
    "give me more",
    "another one",
    "others",
    "more",
    "that one",
    "this one",
    "about that",
    "about this",
    "newer ones",
    "older ones",
    "part 2",
    "episode 2",
  ].some((phrase) => s.includes(phrase));
}

function buildHeuristicConversationQuery(question, messages) {
  const normalized = normalizeConversationMessages(messages);
  const latestQuestion = getLatestUserQuestion(question, normalized);

  if (!latestQuestion) return "";

  if (!normalized.length) return latestQuestion;

  if (!isLikelyFollowUpQuestion(latestQuestion)) {
    return latestQuestion;
  }

  const recentUserMessages = normalized
    .filter((msg) => msg.role === "user")
    .map((msg) => msg.content)
    .filter(Boolean);

  const previousUserMessages = recentUserMessages.slice(-4, -1);
  if (!previousUserMessages.length) return latestQuestion;

  return uniqueStrings(
    [...previousUserMessages, latestQuestion]
      .join(" ")
      .split(/\s+/)
      .map((s) => cleanText(s))
      .filter(Boolean),
  ).join(" ");
}

async function buildConversationalSearchQuery(question, messages) {
  const normalized = normalizeConversationMessages(messages);
  const latestQuestion = getLatestUserQuestion(question, normalized);

  if (!latestQuestion) return "";

  if (!normalized.length) return latestQuestion;

  if (!OPENAI_API_KEY) {
    return buildHeuristicConversationQuery(latestQuestion, normalized);
  }

  try {
    const conversationText = normalized
      .slice(-12)
      .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
      .join("\n");

    const response = await openai.chat.completions.create({
      model: OPENAI_CHAT_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You convert a chat conversation into a short standalone video-search query.\n" +
            "Rules:\n" +
            "- Return only the rewritten search query.\n" +
            "- Keep it concise.\n" +
            "- Resolve pronouns like 'that', 'him', 'it', 'those'.\n" +
            "- Preserve episode/day/part/year intent.\n" +
            "- Do not add explanations or quotation marks.",
        },
        {
          role: "user",
          content:
            `Conversation:\n${conversationText}\n\n` +
            `Latest user question:\n${latestQuestion}\n\n` +
            "Rewrite this into a standalone search query.",
        },
      ],
    });

    const rewritten = cleanText(response?.choices?.[0]?.message?.content || "");
    return (
      rewritten || buildHeuristicConversationQuery(latestQuestion, normalized)
    );
  } catch (err) {
    console.warn(
      "[kingsspace search] conversational query rewrite fallback:",
      err.message,
    );
    return buildHeuristicConversationQuery(latestQuestion, normalized);
  }
}

/**
 * ---------------------------------------------------------------------------
 * ANSWERING
 * ---------------------------------------------------------------------------
 */
async function askOpenAI(question, searchResults, messages = []) {
  ensureOpenAIConfigured();

  const normalizedMessages = normalizeConversationMessages(messages);
  const latestQuestion = getLatestUserQuestion(question, normalizedMessages);

  const trimmed = searchResults.slice(0, 5);

  const context = trimmed
    .map((item, idx) => {
      const views = Number(item.views || 0);
      const duration = item.durationSeconds
        ? formatTimestamp(item.durationSeconds)
        : "unknown";

      const keyMoment = item.match
        ? `Key moment: at ${item.match.startLabel} (to ${item.match.endLabel}) — "${item.match.text}"`
        : null;

      return [
        `Video ${idx + 1}:`,
        `Title: ${item.title}`,
        `Channel: ${item.channel?.name || item.channelName || ""}`,
        `Views: ${views}`,
        `Duration: ${duration}`,
        `Description: ${(item.description || "").slice(0, 300)}`,
        `Tags: ${(item.tags || []).slice(0, 6).join(", ")}`,
        keyMoment,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  const recentMessages = normalizedMessages.slice(-8).map((msg) => ({
    role: msg.role === "system" ? "assistant" : msg.role,
    content: msg.content,
  }));

  const response = await openai.chat.completions.create({
    model: OPENAI_CHAT_MODEL,
    temperature: 0.2,
    max_tokens: 220,
    messages: [
      {
        role: "system",
        content:
          "You are KingsBot, a helpful KingsSpace video assistant.\n" +
          "You may ONLY use the supplied video search results. " +
          "Never use internet knowledge, outside facts, Bible quotes, or invented details.\n" +
          "Choose the single best video for the user's latest message, then explain why it fits.\n" +
          "Base every reason ONLY on the supplied fields (title, channel, tags, description, views, duration, " +
          "key moment) and how they match the request — e.g. the title matches the topic/episode, it's from " +
          "the right channel, or it's the most viewed relevant result.\n" +
          "If the chosen video has a Key moment field, cite that exact timestamp (e.g. 'around 12:34') and " +
          "briefly say what is said there, so the user knows where to skip to. Never invent a timestamp that " +
          "was not supplied.\n" +
          "Reply with a JSON object ONLY (no markdown, no backticks) in exactly this shape:\n" +
          '{"primaryVideo": <the 1-based number of the best video, or 0 if none fit>, ' +
          '"answer": "<2 to 3 sentences that name that video and give concrete reasons>"}\n' +
          "For greetings or when no videos are supplied, set primaryVideo to 0 and make answer a short " +
          "greeting asking what they want to watch.",
      },
      ...recentMessages,
      {
        role: "user",
        content:
          `Latest user message: ${latestQuestion}\n\n` +
          `Available video results only:\n${context || "(none)"}\n\n` +
          "Reply using only these results.",
      },
    ],
  });

  const raw = response?.choices?.[0]?.message?.content || "";

  let parsed = null;
  try {
    parsed = JSON.parse(
      String(raw)
        .replace(/```json|```/gi, "")
        .trim(),
    );
  } catch {
    parsed = null;
  }

  // Couldn't parse structured output — let the caller fall back to its
  // deterministic answer so the text and the recommended card stay in sync.
  if (!parsed) {
    return { answer: "", primaryIndex: -1 };
  }

  const answer = cleanText(parsed.answer || "");

  let oneBased = Number.parseInt(parsed.primaryVideo, 10);
  if (!Number.isFinite(oneBased)) oneBased = trimmed.length ? 1 : 0;

  const primaryIndex =
    oneBased >= 1 && oneBased <= trimmed.length ? oneBased - 1 : -1;

  return { answer, primaryIndex };
}

function buildFallbackAnswer(question, results, messages = []) {
  const normalizedMessages = normalizeConversationMessages(messages);
  const latestQuestion = getLatestUserQuestion(question, normalizedMessages);

  if (!results.length) {
    return {
      answer:
        "I couldn’t find a strong match for that yet. Try a title, speaker, topic, or a few more keywords.",
      recommendedVideos: [],
    };
  }

  const top = results.slice(0, 3);

  const titles = top
    .map((item) => item.title)
    .filter(Boolean)
    .join(", ");

  return {
    answer: `I found a few videos that look relevant to "${latestQuestion}". The best matches are ${titles}.`,
    recommendedVideos: top,
  };
}
function isSuccessfulTranscriptStatus(status) {
  const s = cleanText(status || "").toLowerCase();
  return ["ready", "success", "successful", "completed"].includes(s);
}
/**
 * ---------------------------------------------------------------------------
 * ROUTES
 * ---------------------------------------------------------------------------
 */
router.get(
  "/kingsspace/search/test",
  asyncHandler(async (_req, res) => {
    await ensureSchema();
    res.json({
      status: true,
      test: "ok",
      ceflix_video_api: CEFLIX_VIDEO_API,
      whisper_model: WHISPER_MODEL,
      openai_chat_model: OPENAI_CHAT_MODEL,
      openai_configured: Boolean(OPENAI_API_KEY),
      mysql_ai_video_table: AI_VIDEO_TABLE,
      mysql_ai_segment_table: AI_SEGMENT_TABLE,
    });
  }),
);

router.get(
  "/kingsspace/search/external/test",
  requireApiKey,
  asyncHandler(async (_req, res) => {
    const [rows] = await externalMysqlPool.query(
      `SELECT COUNT(*) AS total FROM \`${IMMTV_DB_TABLE}\``,
    );

    res.json({
      status: true,
      source: "immtv",
      host: IMMTV_DB_HOST,
      database: IMMTV_DB_NAME,
      table: IMMTV_DB_TABLE,
      channelTable: IMMTV_CHANNEL_TABLE,
      aiVideoTable: AI_VIDEO_TABLE,
      aiSegmentTable: AI_SEGMENT_TABLE,
      total: Number(rows?.[0]?.total || 0),
    });
  }),
);

router.post(
  "/kingsspace/search/ingest/:videoId",
  requireApiKey,
  asyncHandler(async (req, res) => {
    await ensureSchema();

    const videoId = toInt(req.params.videoId);
    if (!videoId) {
      return res.status(400).json({
        status: false,
        message: "A valid videoId is required",
      });
    }

    // EARLY SKIP:
    // If already in AI table and transcript was successful, do not fetch/transcribe again.
    const existingBeforeFetch = await getExistingVideo(videoId);

    if (
      existingBeforeFetch &&
      isSuccessfulTranscriptStatus(existingBeforeFetch.transcript_status)
    ) {
      return res.json({
        status: true,
        message:
          "Video already exists in AI table with successful transcript, skipping",
        skipped: true,
        updated: false,
        data: {
          videoId: Number(existingBeforeFetch.video_id),
          title: existingBeforeFetch.title || "",
          playbackUrl: existingBeforeFetch.playback_url || null,
          transcriptStatus: existingBeforeFetch.transcript_status || null,
          transcriptLanguage: existingBeforeFetch.transcript_language || null,
          transcriptChars: String(existingBeforeFetch.transcript_text || "")
            .length,
          alreadySuccessful: true,
        },
      });
    }

    const rawVideo = await fetchVideoFromCeflix(videoId);
    const normalized = normalizeFetchedVideo(rawVideo);

    if (!normalized.video_id) {
      return res.status(404).json({
        status: false,
        message: "Video not found or invalid API payload",
      });
    }

    const existing = await getExistingVideo(normalized.video_id);
    const contentChanged = hasVideoContentChanged(existing, normalized);
    const metadataChanged = hasVideoMetadataChanged(existing, normalized);

    if (existing && !contentChanged && !metadataChanged) {
      return res.json({
        status: true,
        message: "Video already exists and nothing changed, skipping",
        skipped: true,
        data: {
          videoId: normalized.video_id,
          title: normalized.title,
          playbackUrl: normalized.playback_url || null,
          transcriptStatus: existing.transcript_status || null,
          unchanged: true,
          contentChanged: false,
          metadataChanged: false,
        },
      });
    }

    let transcript = null;
    let transcriptError = null;
    let skippedReason = null;
    let reusedTranscript = false;
    let existingSegments = [];
    let finalTranscriptStatus = "failed";

    if (existing && !contentChanged && metadataChanged) {
      skippedReason = "Metadata changed only, transcription not needed";
      reusedTranscript = true;
      finalTranscriptStatus = "ready";
      existingSegments = await getExistingSegments(normalized.video_id);

      transcript = {
        text: existing.transcript_text || "",
        language: existing.transcript_language || null,
        segments: existingSegments,
        reuseExistingTranscript: true,
      };

      await upsertVideoAndSegments(normalized, transcript, {
        transcriptStatus: "ready",
        transcriptError: null,
      });
    } else if (!normalized.playback_url) {
      skippedReason =
        "Skipped transcription because url was .m3u8 and no usable vodPlayBack or ios_url was available";
      finalTranscriptStatus = "skipped";

      await upsertVideoAndSegments(normalized, null, {
        transcriptStatus: "skipped",
        transcriptError: null,
      });
    } else {
      try {
        transcript = await transcribeFromVideoUrl(
          normalized.video_id,
          normalized.playback_url,
        );
      } catch (err) {
        transcriptError = err;
        console.error("[kingsspace search] transcription failed:", err.message);
      }

      if (transcript) {
        finalTranscriptStatus = "ready";
        await upsertVideoAndSegments(normalized, transcript, {
          transcriptStatus: "ready",
          transcriptError: null,
        });
      } else {
        finalTranscriptStatus = "failed";
        await upsertVideoAndSegments(normalized, null, {
          transcriptStatus: "failed",
          transcriptError: transcriptError
            ? String(transcriptError.message || "")
            : null,
        });
      }
    }

    res.json({
      status: true,
      message: existing
        ? reusedTranscript
          ? "Existing video metadata updated, transcript reused"
          : transcript
            ? "Existing video updated and retranscribed successfully"
            : skippedReason
              ? "Existing video updated, transcription skipped"
              : "Existing video updated, but transcription failed"
        : transcript
          ? "Video ingested and transcribed successfully"
          : skippedReason
            ? "Video ingested, transcription skipped"
            : "Video ingested, but transcription failed",
      skipped: false,
      updated: Boolean(existing),
      data: {
        videoId: normalized.video_id,
        title: normalized.title,
        playbackUrl: normalized.playback_url || null,
        originalUrl: cleanText(rawVideo.url || ""),
        vodPlayBack: cleanText(rawVideo.vodPlayBack || ""),
        iosUrl: cleanText(rawVideo.ios_url || ""),
        duration: normalized.duration_seconds,
        durationSeconds: normalized.duration_seconds,
        channel: buildChannelPayload({
          id: normalized.channel_id,
          name: normalized.channel_name,
          thumbnail:
            cleanText(rawVideo.channel_thumbnail || "") ||
            cleanText(rawVideo.channel_image || "") ||
            cleanText(rawVideo.channelThumbnail || ""),
          slug: cleanText(rawVideo.channel_slug || ""),
          isVerified:
            rawVideo.isVerified ?? rawVideo.channel_is_verified ?? false,
        }),
        transcriptStatus: finalTranscriptStatus,
        transcriptLanguage: reusedTranscript
          ? existing?.transcript_language || null
          : transcript?.language || null,
        transcriptChars: reusedTranscript
          ? String(existing?.transcript_text || "").length
          : transcript?.text?.length || 0,
        segmentCount: reusedTranscript
          ? existingSegments.length
          : transcript?.segments?.length || 0,
        skippedReason,
        transcriptError: transcriptError
          ? String(transcriptError.message || "")
          : null,
        contentChanged,
        metadataChanged,
        reusedTranscript,
      },
    });
  }),
);

router.get(
  "/kingsspace/search/videos",
  requireApiKey,
  asyncHandler(async (req, res) => {
    await ensureSchema();

    const q = cleanText(req.query.q || "");
    const limit = toInt(req.query.limit, 10);

    if (!q) {
      return res.status(400).json({
        status: false,
        message: "Query parameter q is required",
      });
    }

    const results = await searchVideos(q, limit);

    res.json({
      status: true,
      query: q,
      count: results.length,
      results,
    });
  }),
);

router.get(
  "/kingsspace/search/external/videos",
  requireApiKey,
  asyncHandler(async (req, res) => {
    const q = pickExternalQueryFromRequest(req);
    const limit = pickExternalLimitFromRequest(req, 10);
    const sort = pickExternalSortFromRequest(req, "relevance");

    if (!q) {
      return res.status(400).json({
        status: false,
        message: "Query parameter q is required",
      });
    }

    const allowedSorts = new Set([
      "relevance",
      "latest",
      "oldest",
      "most_viewed",
      "views",
    ]);

    const safeSort = allowedSorts.has(sort) ? sort : "relevance";
    const results = await searchExternalVideos(q, limit, safeSort);

    res.json({
      status: true,
      source: "immtv",
      query: q,
      sort: safeSort,
      count: results.length,
      results,
    });
  }),
);

router.post(
  "/kingsspace/search/external/videos",
  requireApiKey,
  asyncHandler(async (req, res) => {
    const q = pickExternalQueryFromRequest(req);
    const limit = pickExternalLimitFromRequest(req, 24);
    const sort = pickExternalSortFromRequest(req, "relevance");

    if (!q) {
      return res.status(400).json({
        status: false,
        message: "query is required",
      });
    }

    const allowedSorts = new Set([
      "relevance",
      "latest",
      "oldest",
      "most_viewed",
      "views",
    ]);

    const safeSort = allowedSorts.has(sort) ? sort : "relevance";
    const results = await searchExternalVideos(q, limit, safeSort);

    res.json({
      status: true,
      source: "immtv",
      query: q,
      sort: safeSort,
      count: results.length,
      results,
    });
  }),
);

router.post(
  "/kingsspace/search/ask",
  requireApiKey,
  asyncHandler(async (req, res) => {
    await ensureSchema();

    const messages = normalizeConversationMessages(req.body?.messages || []);
    const question = getLatestUserQuestion(req.body?.question || "", messages);
    const limit = toInt(req.body?.limit, ASK_MAX_RESULTS);

    if (!question) {
      return res.status(400).json({
        status: false,
        message: "question is required",
      });
    }

    const includeRecommendedVideos = shouldReturnRecommendedVideos(
      question,
      messages,
    );

    let conversationalQuery = question;
    let results = [];

    if (includeRecommendedVideos) {
      conversationalQuery = await buildConversationalSearchQuery(
        question,
        messages,
      );

      results = await searchExternalVideos(
        conversationalQuery || question,
        limit,
        "relevance",
      );

      if (results.length) {
        // External metadata search has no transcript timestamps of its own —
        // attach any matching segment so the answer can cite a moment in the video.
        results = await attachTranscriptMatches(
          results,
          conversationalQuery || question,
        );
      } else {
        // fallback to transcript AI search only if external metadata search has nothing
        results = await searchVideos(conversationalQuery || question, limit);
      }
    }

    let answer = buildVideoFirstAnswer(question, results, messages);
    let usedModel = false;

    // Default: the SQL top-ranked result is the primary pick.
    let primaryIndex = results.length ? 0 : -1;

    if (OPENAI_API_KEY) {
      try {
        const modelResult = await askOpenAI(question, results, messages);

        if (modelResult?.answer) {
          answer = modelResult.answer;
          usedModel = true;
        }

        // Only override if the model actually picked a valid video.
        if (
          typeof modelResult?.primaryIndex === "number" &&
          modelResult.primaryIndex >= 0
        ) {
          primaryIndex = modelResult.primaryIndex;
        }
      } catch (err) {
        console.warn("[kingsspace search] openai fallback:", err.message);
      }
    }

    // Move the video named in `answer` to the front so the text and the
    // returned card always refer to the same video.
    let orderedResults = results;
    if (primaryIndex > 0 && primaryIndex < results.length) {
      orderedResults = [
        results[primaryIndex],
        ...results.slice(0, primaryIndex),
        ...results.slice(primaryIndex + 1),
      ];
    }

    const moreRequested = isAskingForMore(question);
    const recommendedCount = moreRequested
      ? Math.min(orderedResults.length, 5)
      : Math.min(orderedResults.length, 1);

    res.json({
      status: true,
      question,
      conversationalQuery,
      usedModel,
      answer,
      recommendedVideos: includeRecommendedVideos
        ? orderedResults.slice(0, recommendedCount)
        : [],
    });
  }),
);

router.use((err, _req, res, _next) => {
  console.error("[kingsspace search] error:", err.stack || err);
  res.status(500).json({
    status: false,
    error: "internal_error",
    message: err?.message || "Internal Server Error",
  });
});

module.exports = function kingspaceSearchRoutes() {
  return router;
};
