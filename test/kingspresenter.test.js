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
const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), "kp-media-"));

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
  Object.assign(process.env, {
    KP_DATABASE_URL: DB_URL, KP_KC_CLIENT_ID: "test-client", KP_KC_TOKEN_URL: `${kc}/token`, KP_KC_PROFILE_URL: `${kc}/profile`,
    KP_API_KEY: "app-key", KP_RELAY_KEY: "relay-key", KP_MEDIA_DIR: MEDIA, KP_RELAY_URL: "wss://relay.test", KP_SITE_URL: "http://localhost:3000",
  });
  delete process.env.KP_TOKEN_SECRET;
  routes = require("../routes/kingspresenter");
  const express = require("express");
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(routes());
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
  assert.deepEqual(t.rows.map((x) => x.table_name), ["devices", "documents", "media_objects", "refresh_tokens", "relays", "remote_joins", "remote_sessions", "settings", "users"]);
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
  assert.deepEqual(kcCalls.find((c) => c.url === "/token" && c.body.code === "good-code").body, { grant_type: "code", client_id: "test-client", code: "good-code" });
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

test("KingsChat's redirect to this API: a phone's sign-in view is handed its tokens", async () => {
  const r = await fetch(`${base}/kp/auth/kingschat/callback?kind=phone`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "code=good-code" });
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.match(html, /ReactNativeWebView/);
  const data = JSON.parse(html.match(/var d=(\{.*?\});try/)[1]);
  assert.deepEqual([data.type, data.status, data.user.username], ["kp-auth", true, "pastor_ade"]);
  assert.ok(data.accessToken && data.refreshToken);
  const bad = await fetch(`${base}/kp/auth/kingschat/callback?code=nope`);
  assert.equal(bad.status, 502);
  assert.match(await bad.text(), /did not work/);
});

test("deleting the account removes it and its media", async () => {
  assert.equal((await call("DELETE", "/kp/account", { token: auth.accessToken })).json.deleted, true);
  assert.equal((await call("GET", "/kp/me", { token: auth.accessToken })).json.error, "invalid_token");
  assert.deepEqual(fs.readdirSync(MEDIA).flatMap((d) => fs.readdirSync(path.join(MEDIA, d))), []);
});

test("the database is found from KP_DATABASE_URL / DATABASE_URL, else NMM reporting's server, else PCO_FN's", () => {
  const { dbConfigFrom } = routes;
  assert.deepEqual(dbConfigFrom({ KP_DATABASE_URL: "postgres://a:b@h/kp", NMM_DATABASE_URL: "postgres://x:y@z/nmm" }), { connectionString: "postgres://a:b@h/kp" });
  assert.deepEqual(dbConfigFrom({ DATABASE_URL: "postgres://d:e@h/kingspresenter", NMM_DATABASE_URL: "postgres://x:y@z/nmm" }), { connectionString: "postgres://d:e@h/kingspresenter" });
  assert.deepEqual(dbConfigFrom({ KP_DATABASE_URL: "postgres://a:b@h/kp", DATABASE_URL: "postgres://d:e@h/kingspresenter" }), { connectionString: "postgres://a:b@h/kp" }, "KingsPresenter's own first");
  assert.deepEqual(dbConfigFrom({ NMM_DATABASE_URL: "postgres://nmm:p%40ss@db.example:5433/nmm_reporting?sslmode=require" }),
    { connectionString: "postgres://nmm:p%40ss@db.example:5433/kingspresenter?sslmode=require" }, "the same server, its own database");
  const fields = dbConfigFrom({ NMM_DB_USER: "nmm", NMM_DB_HOST: "db.example", NMM_DB_PASSWORD: "secret", PCO_FN_DB_PASSWORD: "other" });
  assert.deepEqual([fields.user, fields.host, fields.database, fields.password, fields.port], ["nmm", "db.example", "kingspresenter", "secret", 5432]);
  assert.equal(dbConfigFrom({ PCO_FN_DB_PASSWORD: "pco" }).password, "pco");
  assert.equal(dbConfigFrom({}).password, undefined);
});
