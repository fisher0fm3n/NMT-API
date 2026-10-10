// KingsPresenter's account service (routes/kingspresenter.js) against a local Postgres
// and a stand-in for KingsChat. Run: node --test test/kingspresenter.test.js
// (KP_TEST_DATABASE_URL picks the database; it is created, and dropped after.)
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Client } = require("pg");

const DB_URL = process.env.KP_TEST_DATABASE_URL || "postgres://localhost/kingspresenter_test";
// Only a database on this computer: the test makes and deletes accounts, and drops the database.
if (!["localhost", "127.0.0.1", "::1", ""].includes(new URL(DB_URL).hostname)) throw new Error("KP_TEST_DATABASE_URL must be a database on this computer");
const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), "kp-media-"));
const RELEASES = fs.mkdtempSync(path.join(os.tmpdir(), "kp-releases-"));

// OpenAI, as far as summaries go: answers with whatever the test puts in `aiAnswer`.
const aiCalls = [];
let aiAnswer = null;
const openai = { chat: { completions: { create: async (args) => { aiCalls.push(args); if (aiAnswer instanceof Error) throw aiAnswer; return { choices: [{ message: { content: typeof aiAnswer === "string" ? aiAnswer : JSON.stringify(aiAnswer) } }] }; } } } };

// KingsChat, as far as sign-in goes: a code becomes a token, a token a profile.
const kcCalls = [];
const kingschat = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    kcCalls.push({ url: req.url, body: body ? JSON.parse(body) : null, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.url === "/token") {
      const { code } = JSON.parse(body);
      if (code !== "good-code" && code !== "second-code") { res.statusCode = 400; return res.end("{}"); }
      return res.end(JSON.stringify({ access_token: `kc-${code}`, refresh_token: "kc-refresh", expires_in_millis: 3600000 }));
    }
    if (req.url === "/profile") {
      if (!/^Bearer kc-/.test(req.headers.authorization || "")) { res.statusCode = 401; return res.end("{}"); }
      return res.end(JSON.stringify({ profile: { user: { id: "kc-123", username: "@pastor_ade", firstName: "Ade", lastName: "Bello", profilePicture: "https://kc/ade.jpg" }, email: "ade@church.org" } }));
    }
    res.statusCode = 404; res.end("{}");
  });
});

let base;
let server;
let routes;

test.before(async () => {
  await new Promise((r) => kingschat.listen(0, "127.0.0.1", r));
  const kc = `http://127.0.0.1:${kingschat.address().port}`;
  // The API's .env is not read (KP_SKIP_ENV_FILE), and the database is set outright.
  Object.assign(process.env, {
    KP_SKIP_ENV_FILE: "1", KINGSPRESENTER_DATABASE_URL: DB_URL, KP_DATABASE_URL: DB_URL, KP_KC_CLIENT_ID: "test-client", KP_KC_CLIENT_SECRET: "shh", KP_KC_TOKEN_URL: `${kc}/token`, KP_KC_PROFILE_URL: `${kc}/profile`,
    KP_API_KEY: "app-key", KP_RELAY_KEY: "relay-key", KP_MEDIA_DIR: MEDIA, KP_RELAY_URL: "wss://relay.test", KP_SITE_URL: "http://localhost:3000",
    KP_RELEASES_DIR: RELEASES, KP_UPDATE_UPLOAD_KEY: "upload-key", KP_SUMMARY_MAX_CHARS: "5000",
  });
  delete process.env.KP_TOKEN_SECRET;
  routes = require("../routes/kingspresenter");
  const express = require("express");
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(routes({ openai }));
  app.use((err, _req, res, _next) => res.status(500).json({ status: false, error: "internal_error", message: err.message }));
  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  kingschat.close();
  await routes.pool.end();
  const admin = new Client({ connectionString: DB_URL.replace(/\/[^/?]+(\?|$)/, "/postgres$1") });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${new URL(DB_URL).pathname.slice(1)}`);
  await admin.end();
  fs.rmSync(MEDIA, { recursive: true, force: true });
  fs.rmSync(RELEASES, { recursive: true, force: true });
});

const call = async (method, url, { body, token, key = "app-key", headers = {} } = {}) => {
  const h = { ...headers };
  if (key) h["x-api-key"] = key;
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined && !Buffer.isBuffer(body)) h["content-type"] = "application/json";
  const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html or empty */ }
  return { status: r.status, json, text };
};

test("the database and its tables are made on first use", async () => {
  const r = await call("GET", "/kp/ping", { key: null });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, true);
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  const t = await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`);
  await c.end();
  assert.deepEqual(t.rows.map((x) => x.table_name), ["devices", "documents", "installs", "media_objects", "recording_summaries", "refresh_tokens", "relays", "releases", "remote_joins", "remote_sessions", "settings", "signin_tickets", "users"]);
});

test("the app key is asked for, and the apps learn where to sign in and which relay to use", async () => {
  assert.equal((await call("GET", "/kp/config", { key: null })).json.error, "unauthorized_api_key");
  const cfg = (await call("GET", "/kp/config")).json;
  assert.equal(cfg.kingschat.clientId, "test-client");
  assert.equal(cfg.kingschat.redirectUri, "http://localhost:3000/auth/kingschat/callback");
  assert.deepEqual(cfg.relays.map((r) => r.url), ["wss://relay.test"]);
});

let auth;
test("signing in with KingsChat: the code is exchanged, the profile read, the account made", async () => {
  const bad = await call("POST", "/kp/auth/kingschat", { body: { code: "nope" } });
  assert.deepEqual([bad.status, bad.json.error], [502, "kc_exchange_failed"]);
  assert.equal((await call("POST", "/kp/auth/kingschat", { body: {} })).json.error, "missing_code");

  const r = await call("POST", "/kp/auth/kingschat", { body: { code: "good-code", deviceName: "Main Hall Mac", deviceKind: "desktop" } });
  assert.equal(r.status, 200);
  auth = r.json;
  assert.deepEqual(kcCalls.find((c) => c.url === "/token" && c.body.code === "good-code").body, { grant_type: "code", client_id: "test-client", code: "good-code", client_secret: "shh" });
  assert.deepEqual([auth.user.kcId, auth.user.username, auth.user.name, auth.user.email], ["kc-123", "pastor_ade", "Ade Bello", "ade@church.org"]);
  assert.match(auth.accessToken, /^[\w-]+\.[\w-]+\.[\w-]+$/);
  const claims = JSON.parse(Buffer.from(auth.accessToken.split(".")[1], "base64url"));
  assert.deepEqual([claims.sub, claims.dev], [auth.user.id, auth.deviceId]);

  // The same KingsChat person again: the same account.
  const again = await call("POST", "/kp/auth/kingschat", { body: { code: "second-code", deviceName: "Pastor's phone", deviceKind: "phone" } });
  assert.equal(again.json.user.id, auth.user.id);
  assert.notEqual(again.json.deviceId, auth.deviceId);
});

test("the access token works; a refresh token is used once and replaced; signing out ends it", async () => {
  assert.equal((await call("GET", "/kp/me", { token: auth.accessToken })).json.user.username, "pastor_ade");
  assert.equal((await call("GET", "/kp/me", { token: `${auth.accessToken}x` })).json.error, "invalid_token");
  assert.equal((await call("GET", "/kp/me")).json.error, "no_token");

  const fresh = (await call("POST", "/kp/auth/refresh", { body: { refreshToken: auth.refreshToken } })).json;
  assert.equal(fresh.status, true);
  assert.equal(fresh.deviceId, auth.deviceId, "the same computer");
  assert.equal((await call("POST", "/kp/auth/refresh", { body: { refreshToken: auth.refreshToken } })).json.error, "invalid_token");

  const devices = (await call("GET", "/kp/devices", { token: fresh.accessToken })).json.devices;
  assert.deepEqual(devices.map((d) => [d.name, d.kind]).sort(), [["Main Hall Mac", "desktop"], ["Pastor's phone", "phone"]]);
  assert.equal(devices.find((d) => d.current).name, "Main Hall Mac");

  await call("POST", "/kp/auth/logout", { body: { refreshToken: fresh.refreshToken } });
  assert.equal((await call("POST", "/kp/auth/refresh", { body: { refreshToken: fresh.refreshToken } })).json.error, "invalid_token");
  auth = (await call("POST", "/kp/auth/kingschat", { body: { code: "good-code", deviceId: auth.deviceId } })).json;
});

test("the library syncs between computers, the latest change winning; media by its hash", async () => {
  const t = auth.accessToken;
  const song = { id: "s1", title: "Amazing God", updatedAt: "2026-10-09T10:00:00.000Z", rev: 1 };
  const push = (await call("POST", "/kp/sync/push", { token: t, body: { docs: [{ kind: "songs", id: "s1", doc: song }, { kind: "nonsense", id: "x", doc: {} }] } })).json;
  assert.deepEqual(push.accepted, [{ kind: "songs", id: "s1", rev: 1 }]);
  const older = (await call("POST", "/kp/sync/push", { token: t, body: { docs: [{ kind: "songs", id: "s1", doc: { ...song, title: "Old", updatedAt: "2026-10-01T00:00:00.000Z" } }] } })).json;
  assert.equal(older.rejected[0].current.title, "Amazing God");
  const pull = (await call("GET", "/kp/sync/pull?since=0", { token: t })).json;
  assert.deepEqual(pull.changes.map((c) => [c.kind, c.id, c.doc.title]), [["songs", "s1", "Amazing God"]]);
  assert.equal((await call("GET", `/kp/sync/pull?since=${pull.cursor}`, { token: t })).json.changes.length, 0);

  const bytes = Buffer.from("a picture");
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.equal((await call("HEAD", `/kp/media/${sha}`, { token: t })).status, 404);
  assert.equal((await call("PUT", `/kp/media/${"0".repeat(64)}`, { token: t, body: bytes, headers: { "content-type": "image/jpeg" } })).json.error, "hash_mismatch");
  assert.equal((await call("PUT", `/kp/media/${sha}`, { token: t, body: bytes, headers: { "content-type": "image/jpeg" } })).status, 201);
  assert.equal((await call("HEAD", `/kp/media/${sha}`, { token: t })).status, 200);
  const got = await call("GET", `/kp/media/${sha}`, { token: t });
  assert.equal(got.text, "a picture");
});

test("relays report church computers' sessions and the phones that join; the account sees them", async () => {
  const events = { relay: "wss://relay.test", events: [
    { t: "opened", sessionId: "sess-1", name: "Main Hall", userId: auth.user.id },
    { t: "join", sessionId: "sess-1", remoteId: "r1", phone: "Pastor's iPhone", mode: "preacher", via: "code" },
    { t: "leave", sessionId: "sess-1", remoteId: "r1" },
    { t: "closed", sessionId: "sess-1", reason: "closed" },
  ] };
  assert.equal((await call("POST", "/kp/relay/events", { body: events, key: null })).json.error, "unauthorized_relay");
  assert.equal((await call("POST", "/kp/relay/events", { body: events, key: null, headers: { "x-relay-key": "relay-key" } })).json.received, 4);
  const sessions = (await call("GET", "/kp/remote/sessions", { token: auth.accessToken })).json.sessions;
  assert.equal(sessions.length, 1);
  assert.deepEqual([sessions[0].name, sessions[0].joins, sessions[0].relay, sessions[0].closeReason], ["Main Hall", 1, "wss://relay.test", "closed"]);
  assert.ok(sessions[0].closedAt);
});

test("KingsChat's redirect to this API: a phone's sign-in view is handed its tokens; the code by any name, with the client secret", async () => {
  const r = await fetch(`${base}/kp/auth/kingschat/callback?kind=phone`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "code=good-code" });
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.match(html, /ReactNativeWebView/);
  assert.doesNotMatch(html, /window\.opener/, "tokens are not posted to whatever opened the window");
  const data = JSON.parse(html.match(/var d=(\{.*?\});try/)[1]);
  assert.deepEqual([data.type, data.status, data.user.username], ["kp-auth", true, "pastor_ade"]);
  assert.ok(data.accessToken && data.refreshToken);
  assert.match(data.deepLink, /^kingspresenter:\/\/auth\?ticket=/);
  assert.equal(kcCalls.filter((c) => c.url === "/token").at(-1).body.client_secret, "shh");
  // The code as JSON, under KingsChat's other name for it.
  const j = await fetch(`${base}/kp/auth/kingschat/callback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ authCode: "second-code" }) });
  assert.equal(j.status, 200);
  const bad = await fetch(`${base}/kp/auth/kingschat/callback?code=nope`);
  assert.equal(bad.status, 502);
  assert.match(await bad.text(), /did not work/);
  assert.equal((await fetch(`${base}/kp/auth/kingschat/callback`)).status, 400);
});

test("a sign-in finished in a browser: the desktop app collects its tokens with the page's ticket, once, and the page's own tokens are retired", async () => {
  const before = (await call("GET", "/kp/devices", { token: auth.accessToken })).json.devices.length;
  const r = await fetch(`${base}/kp/auth/kingschat/callback`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "code=good-code" });
  const data = JSON.parse((await r.text()).match(/var d=(\{.*?\});try/)[1]);
  assert.equal((await call("GET", "/kp/devices", { token: auth.accessToken })).json.devices.length, before + 1, "the page's sign-in is a device for now");
  const got = await call("POST", "/kp/auth/ticket", { body: { ticket: data.ticket, deviceName: "Main Hall Mac", deviceKind: "desktop" } });
  assert.equal(got.status, 200, got.text);
  assert.ok(got.json.accessToken && got.json.refreshToken);
  assert.equal(got.json.user.username, "pastor_ade");
  const devices = (await call("GET", "/kp/devices", { token: auth.accessToken })).json.devices;
  assert.equal(devices.length, before + 1, "the page's phantom device is gone; the desktop took its place");
  assert.ok(devices.some((d) => d.name === "Main Hall Mac" && d.kind === "desktop"));
  // The page's refresh token no longer works; the ticket is spent.
  assert.equal((await call("POST", "/kp/auth/refresh", { body: { refreshToken: data.refreshToken } })).json.error, "invalid_token");
  assert.equal((await call("POST", "/kp/auth/ticket", { body: { ticket: data.ticket } })).json.error, "invalid_ticket");
  assert.equal((await call("POST", "/kp/auth/ticket", { body: { ticket: "made-up" } })).status, 401);
  assert.equal((await call("POST", "/kp/auth/ticket", { body: {} })).json.error, "missing_ticket");
  assert.equal((await call("POST", "/kp/auth/ticket", { body: { ticket: "x" }, key: null })).status, 401, "needs the app key");
});

const SUMMARY = {
  version: 1, language: "en", title: "Cell leaders' meeting", summary: { short: "Reports, outreach and prayer.", full: "The meeting opened with a word on serving.\n\nThe outreach is on Saturday." },
  keyPoints: [{ point: "Serve fervent in spirit.", t: 25.9, time: "0:25", scriptures: ["Romans 12:11"] }],
  scriptures: [{ reference: "Romans 12:11", bookId: "rom", chapter: 12, verse: 11, verseEnd: null, mentions: [{ t: 12.1, time: "0:12", said: "Romans chapter 12 verse 11" }] }, { reference: "Mark 16:15", bookId: "MRK", chapter: 16, verse: 15, verseEnd: null, mentions: [{ t: 164.9, time: "2:44", said: "Mac 16 verse 15" }], note: "Heard as Mac." }],
  decisions: [{ decision: "Outreach on Saturday at 10 am.", t: 134.5, time: "2:14" }],
  actionItems: [{ task: "Order 200 copies.", owner: "Brother James", due: "This week", t: 156.8, time: "2:36" }],
  openQuestions: [], speakers: [{ name: null, role: "the pastor" }, { name: "Brother James", role: "reports" }], themes: ["Serving", "Outreach"],
};
const transcript = [{ t: 0, text: "Okay let's get started." }, { t: 12.1, text: "Turn with me to Romans chapter 12 verse 11." }, { t: 164.9, text: "Remember the great commission in Mac 16 verse 15." }];

test("a recording's transcript is summarised by the AI, kept by recording, and the same transcript again costs nothing", async () => {
  aiAnswer = SUMMARY;
  const r = await call("POST", "/kp/recordings/summary", { token: auth.accessToken, body: { recordingId: "2026-10-14-7c31d2", language: "en", transcript } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, true);
  assert.equal(r.json.title, "Cell leaders' meeting");
  assert.equal(r.json.scriptures[0].bookId, "ROM", "tidied");
  assert.equal(r.json.scriptures[1].note, "Heard as Mac.");
  assert.deepEqual(r.json.actionItems[0], { task: "Order 200 copies.", owner: "Brother James", due: "This week", t: 156.8, time: "2:36" });
  assert.equal(aiCalls.length, 1);
  const sent = JSON.parse(aiCalls[0].messages[1].content);
  assert.deepEqual(sent.transcript[1], { t: 12.1, text: "Turn with me to Romans chapter 12 verse 11." });
  assert.equal(aiCalls[0].response_format.type, "json_schema");
  assert.match(aiCalls[0].messages[0].content, /Never invent/);
  // Again: what is kept, no second call.
  const again = await call("POST", "/kp/recordings/summary", { token: auth.accessToken, body: { recordingId: "2026-10-14-7c31d2", transcript } });
  assert.equal(again.json.cached, true);
  assert.equal(aiCalls.length, 1);
  assert.equal((await call("GET", "/kp/recordings/summary/2026-10-14-7c31d2", { token: auth.accessToken })).json.title, "Cell leaders' meeting");
  // A changed transcript for the same recording: summarised afresh.
  await call("POST", "/kp/recordings/summary", { token: auth.accessToken, body: { recordingId: "2026-10-14-7c31d2", transcript: [...transcript, { t: 200, text: "Amen." }] } });
  assert.equal(aiCalls.length, 2);
  // What cannot be summarised.
  assert.equal((await call("POST", "/kp/recordings/summary", { token: auth.accessToken, body: { transcript: [] } })).json.error, "bad_request");
  assert.equal((await call("POST", "/kp/recordings/summary", { token: auth.accessToken, body: { transcript: [{ text: "no time" }] } })).json.error, "bad_request");
  const long = await call("POST", "/kp/recordings/summary", { token: auth.accessToken, body: { transcript: [{ t: 0, text: "word ".repeat(1200) }] } });
  assert.deepEqual([long.status, long.json.error], [413, "too_long"]);
  aiAnswer = Object.assign(new Error("rate limited"), { status: 429 });
  const busy = await call("POST", "/kp/recordings/summary", { token: auth.accessToken, body: { recordingId: "x", transcript } });
  assert.deepEqual([busy.status, busy.json.error], [503, "ai_busy"]);
  aiAnswer = "not json at all";
  const bad = await call("POST", "/kp/recordings/summary", { token: auth.accessToken, body: { recordingId: "y", transcript } });
  assert.deepEqual([bad.status, bad.json.error], [502, "ai_failed"]);
  assert.equal((await call("POST", "/kp/recordings/summary", { body: { transcript } })).json.error, "no_token");
});

test("installers: uploaded by the build with the key, checked against their hash; the latest offered to an older app, and sent", async () => {
  const dmg = crypto.randomBytes(20000);
  const sha = crypto.createHash("sha256").update(dmg).digest("hex");
  const headers = (over = {}) => ({ "x-upload-key": "upload-key", "x-version": "0.1.2", "x-platform": "darwin", "x-arch": "arm64", "x-filename": "KingsPresenter-0.1.2-arm64.dmg", "x-sha256": sha, "x-notes": Buffer.from("- Better\n- Faster").toString("base64"), ...over });
  assert.equal((await call("PUT", "/kp/updates/upload", { body: dmg, key: null, headers: headers({ "x-upload-key": "wrong" }) })).json.error, "unauthorized_upload_key");
  assert.equal((await call("PUT", "/kp/updates/upload", { body: dmg, key: null, headers: headers({ "x-platform": "linux" }) })).json.error, "bad_request");
  assert.equal((await call("PUT", "/kp/updates/upload", { body: crypto.randomBytes(100), key: null, headers: headers() })).json.error, "hash_mismatch");
  const up = await call("PUT", "/kp/updates/upload", { body: dmg, key: null, headers: headers() });
  assert.equal(up.status, 201, up.text);
  assert.deepEqual([up.json.release.version, up.json.release.platform, up.json.release.size, up.json.release.notes], ["0.1.2", "darwin", 20000, "- Better\n- Faster"]);
  assert.deepEqual(fs.readdirSync(path.join(RELEASES, "0.1.2")), ["darwin-arm64-KingsPresenter-0.1.2-arm64.dmg"]);
  // A Windows build too, and an older Mac one.
  const exe = crypto.randomBytes(3000);
  await call("PUT", "/kp/updates/upload", { body: exe, key: null, headers: headers({ "x-platform": "win32", "x-arch": "x64", "x-filename": "KingsPresenter Setup 0.1.2.exe", "x-sha256": crypto.createHash("sha256").update(exe).digest("hex") }) });
  const old = crypto.randomBytes(1000);
  await call("PUT", "/kp/updates/upload", { body: old, key: null, headers: headers({ "x-version": "0.1.0", "x-sha256": crypto.createHash("sha256").update(old).digest("hex") }) });

  // An older app is offered the latest; the latest itself, nothing.
  const latest = await call("GET", "/kp/updates/latest?platform=darwin&arch=arm64&version=0.1.1", { token: auth.accessToken });
  assert.equal(latest.status, 200);
  assert.deepEqual([latest.json.version, latest.json.size, latest.json.sha256, latest.json.notes], ["0.1.2", 20000, sha, "- Better\n- Faster"]);
  assert.equal(latest.json.url, `${base}/kp/updates/files/0.1.2/darwin/arm64`);
  assert.equal((await call("GET", "/kp/updates/latest?platform=darwin&arch=arm64&version=0.1.2", { token: auth.accessToken })).status, 204);
  assert.equal((await call("GET", "/kp/updates/latest?platform=darwin&arch=arm64&version=0.2.0", { token: auth.accessToken })).status, 204);
  assert.equal((await call("GET", "/kp/updates/latest?platform=win32&arch=x64&version=0.1.0", { token: auth.accessToken })).json.filename, "KingsPresenter Setup 0.1.2.exe");
  assert.equal((await call("GET", "/kp/updates/latest?platform=win32&arch=arm64", { token: auth.accessToken })).status, 204, "no such build");
  assert.equal((await call("GET", "/kp/updates/latest?platform=darwin&arch=arm64")).json.error, "no_token");
  // The installer itself, whole.
  const file = await fetch(latest.json.url, { headers: { "x-api-key": "app-key", authorization: `Bearer ${auth.accessToken}` } });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("x-sha256"), sha);
  assert.equal(Buffer.compare(Buffer.from(await file.arrayBuffer()), dmg), 0);
  assert.equal((await call("GET", "/kp/updates/files/0.9.9/darwin/arm64", { token: auth.accessToken })).status, 404);
  const list = (await call("GET", "/kp/updates/releases", { token: auth.accessToken })).json.releases;
  assert.deepEqual(list.map((r) => `${r.version} ${r.platform}`).sort(), ["0.1.0 darwin", "0.1.2 darwin", "0.1.2 win32"]);
  // The same version uploaded again replaces the file.
  const dmg2 = crypto.randomBytes(5000);
  await call("PUT", "/kp/updates/upload", { body: dmg2, key: null, headers: headers({ "x-filename": "KingsPresenter-0.1.2-arm64-fixed.dmg", "x-sha256": crypto.createHash("sha256").update(dmg2).digest("hex") }) });
  assert.deepEqual(fs.readdirSync(path.join(RELEASES, "0.1.2")).sort(), ["darwin-arm64-KingsPresenter-0.1.2-arm64-fixed.dmg", "win32-x64-KingsPresenter Setup 0.1.2.exe"]);
  assert.equal((await call("GET", "/kp/updates/latest?platform=darwin&arch=arm64&version=0.1.1", { token: auth.accessToken })).json.size, 5000);
});

test("signed-in devices are counted, and a limit (KP_MAX_DEVICES) refuses one more until one signs out", async () => {
  const me = (await call("GET", "/kp/me", { token: auth.accessToken })).json;
  assert.equal(typeof me.devices.signedIn, "number");
  assert.equal(me.devices.max, 0, "no limit by default");
  const list = (await call("GET", "/kp/devices", { token: auth.accessToken })).json;
  assert.equal(list.signedIn, list.devices.filter((d) => d.signedIn).length);
  process.env.KP_MAX_DEVICES = String(list.signedIn);
  try {
    const more = await call("POST", "/kp/auth/kingschat", { body: { code: "good-code", deviceName: "One too many", deviceKind: "phone" } });
    assert.deepEqual([more.status, more.json.error], [403, "device_limit"]);
    assert.match(more.json.message, /signed in on \d+ devices? already/);
    assert.equal((await call("GET", "/kp/me", { token: auth.accessToken })).json.devices.max, list.signedIn);
    // The same device again: allowed (it is not one more).
    const again = await call("POST", "/kp/auth/kingschat", { body: { code: "good-code", deviceId: auth.deviceId, deviceName: "Desk again" } });
    assert.equal(again.status, 200, again.text);
    auth.accessToken = again.json.accessToken; auth.refreshToken = again.json.refreshToken;
    // One signed out: room for one more.
    const other = list.devices.find((d) => d.signedIn && !d.current);
    assert.ok(other, "another signed-in device to sign out");
    assert.equal((await call("DELETE", `/kp/devices/${other.id}`, { token: auth.accessToken })).json.deleted, true);
    const now = await call("POST", "/kp/auth/kingschat", { body: { code: "good-code", deviceName: "One more", deviceKind: "phone" } });
    assert.equal(now.status, 200, now.text);
  } finally { delete process.env.KP_MAX_DEVICES; }
});

test("may this copy run: an oldest version allowed, a copy or an account disabled, by the administrator's key", async () => {
  const install = crypto.randomUUID();
  const check = (version = "0.1.1", token) => call("GET", `/kp/app/check?installId=${install}&version=${version}&platform=darwin&arch=arm64&name=Main%20Hall%20Mac`, { token });
  // Nothing set: allowed, and the copy is on the list.
  assert.deepEqual([(await check()).json.allowed, (await check()).json.reason], [true, ""]);
  const admin = { "x-admin-key": "admin-key" };
  assert.equal((await call("GET", "/kp/admin/installs", { headers: admin })).json.error, "admin_off", "no admin key on the server: no admin");
  process.env.KP_ADMIN_KEY = "admin-key";
  try {
    assert.equal((await call("GET", "/kp/admin/installs", { headers: { "x-admin-key": "wrong" } })).status, 401);
    const listed = (await call("GET", "/kp/admin/installs?q=Main Hall", { headers: admin })).json.installs.find((i) => i.id === install);
    assert.deepEqual([listed.name, listed.version, listed.platform, listed.disabled], ["Main Hall Mac", "0.1.1", "darwin", false]);

    // An oldest version: older copies must update first; that version and newer may run.
    assert.equal((await call("PUT", "/kp/admin/policy", { headers: admin, body: { minVersion: "nope" } })).json.error, "bad_request");
    assert.equal((await call("PUT", "/kp/admin/policy", { headers: admin, body: { minVersion: "0.2.0" } })).json.minVersion, "0.2.0");
    const old = (await check("0.1.1")).json;
    assert.deepEqual([old.allowed, old.reason, old.minVersion], [false, "update", "0.2.0"]);
    assert.match(old.message, /0\.1\.1\) is no longer supported\. Update to 0\.2\.0/);
    assert.equal((await check("0.2.0")).json.allowed, true);
    await call("PUT", "/kp/admin/policy", { headers: admin, body: { message: "Please update before Sunday." } });
    assert.equal((await check("0.1.1")).json.message, "Please update before Sunday.");
    await call("PUT", "/kp/admin/policy", { headers: admin, body: { minVersion: "", message: "" } });
    assert.equal((await check("0.1.1")).json.allowed, true, "cleared: every version again");

    // One copy disabled, with what it is told; on again.
    const off = await call("POST", `/kp/admin/installs/${install}`, { headers: admin, body: { disabled: true, reason: "Licence ended." } });
    assert.equal(off.json.install.disabled, true);
    assert.deepEqual([(await check()).json.allowed, (await check()).json.reason, (await check()).json.message], [false, "disabled", "Licence ended."]);
    await call("POST", `/kp/admin/installs/${install}`, { headers: admin, body: { disabled: false } });
    assert.equal((await check()).json.allowed, true);

    // An account disabled (by its KingsChat username): its copies stop, it cannot use the API or sign in.
    await check("0.1.1", auth.accessToken); // this copy now knows who uses it
    const user = await call("POST", "/kp/admin/users/@pastor_ade", { headers: admin, body: { disabled: true } });
    assert.equal(user.json.user.disabled, true);
    assert.deepEqual([(await check()).json.allowed, (await check()).json.reason], [false, "disabled"], "even asked without a token");
    assert.match((await check()).json.message, /has been disabled/);
    assert.equal((await call("GET", "/kp/me", { token: auth.accessToken })).json.error, "account_disabled");
    assert.equal((await call("POST", "/kp/auth/kingschat", { body: { code: "good-code" } })).json.error, "account_disabled");
    const users = (await call("GET", "/kp/admin/users?q=pastor", { headers: admin })).json.users;
    assert.deepEqual([users[0].username, users[0].disabled, users[0].installs >= 1], ["pastor_ade", true, true]);
    await call("POST", `/kp/admin/users/${user.json.user.id}`, { headers: admin, body: { disabled: false } });
    assert.equal((await call("GET", "/kp/me", { token: auth.accessToken })).status, 200);
    assert.equal((await check()).json.allowed, true);

    // A release uploaded as required becomes the oldest version allowed.
    const exe = crypto.randomBytes(500);
    const up = await call("PUT", "/kp/updates/upload", { body: exe, key: null, headers: { "x-upload-key": "upload-key", "x-version": "0.3.0", "x-platform": "win32", "x-arch": "x64", "x-filename": "KingsPresenter Setup 0.3.0.exe", "x-sha256": crypto.createHash("sha256").update(exe).digest("hex"), "x-required": "1" } });
    assert.equal(up.json.required, true);
    assert.equal((await call("GET", "/kp/admin/policy", { headers: admin })).json.minVersion, "0.3.0");
    assert.equal((await check("0.2.9")).json.reason, "update");
    await call("PUT", "/kp/admin/policy", { headers: admin, body: { minVersion: "" } });
  } finally { delete process.env.KP_ADMIN_KEY; }
});

test("versions compare as numbers", () => {
  const { newer } = routes;
  assert.equal(newer("0.1.2", "0.1.1"), true);
  assert.equal(newer("0.10.0", "0.9.9"), true);
  assert.equal(newer("v1.0.0", "1.0.0"), false);
  assert.equal(newer("0.1.2-beta", "0.1.2"), false);
  assert.equal(newer("0.1.1", "0.1.2"), false);
});

test("deleting the account removes it and its media", async () => {
  assert.equal((await call("DELETE", "/kp/account", { token: auth.accessToken })).json.deleted, true);
  assert.equal((await call("GET", "/kp/me", { token: auth.accessToken })).json.error, "invalid_token");
  assert.deepEqual(fs.readdirSync(MEDIA).flatMap((d) => fs.readdirSync(path.join(MEDIA, d))), []);
});

test("the database is found from KINGSPRESENTER_DATABASE_URL, else NMM reporting's server, else PCO_FN's", () => {
  const { dbConfigFrom } = routes;
  assert.deepEqual(dbConfigFrom({ KP_DATABASE_URL: "postgres://a:b@h/kp", NMM_DATABASE_URL: "postgres://x:y@z/nmm" }), { connectionString: "postgres://a:b@h/kp" });
  assert.deepEqual(dbConfigFrom({ KINGSPRESENTER_DATABASE_URL: "postgres://d:e@h/kingspresenter", NMM_DATABASE_URL: "postgres://x:y@z/nmm" }), { connectionString: "postgres://d:e@h/kingspresenter" });
  assert.deepEqual(dbConfigFrom({ DATABASE_URL: "postgres://other@h/app", NMM_DATABASE_URL: "postgres://x:y@z/nmm" }), { connectionString: "postgres://x:y@z/kingspresenter" }, "a general DATABASE_URL is not KingsPresenter's");
  assert.deepEqual(dbConfigFrom({ NMM_DATABASE_URL: "postgres://nmm:p%40ss@db.example:5433/nmm_reporting?sslmode=require" }),
    { connectionString: "postgres://nmm:p%40ss@db.example:5433/kingspresenter?sslmode=require" }, "the same server, its own database");
  const fields = dbConfigFrom({ NMM_DB_USER: "nmm", NMM_DB_HOST: "db.example", NMM_DB_PASSWORD: "secret", PCO_FN_DB_PASSWORD: "other" });
  assert.deepEqual([fields.user, fields.host, fields.database, fields.password, fields.port], ["nmm", "db.example", "kingspresenter", "secret", 5432]);
  assert.equal(dbConfigFrom({ PCO_FN_DB_PASSWORD: "pco" }).password, "pco");
  assert.equal(dbConfigFrom({}).password, undefined);
});
