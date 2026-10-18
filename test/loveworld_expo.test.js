// The LoveWorld Expo service (routes/loveworld_expo.js) against a local Postgres and a
// stand-in for KingsChat. Run: node --test test/loveworld_expo.test.js
// (EXPO_TEST_DATABASE_URL picks the database; it is created, and dropped after.)
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { Client } = require("pg");

const DB_URL = process.env.EXPO_TEST_DATABASE_URL || "postgres://localhost/loveworld_expo_test";
if (!["localhost", "127.0.0.1", "::1", ""].includes(new URL(DB_URL).hostname)) throw new Error("EXPO_TEST_DATABASE_URL must be a database on this computer");

// KingsChat, as far as sign-in goes: a code becomes a token, a token a profile.
const kingschat = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/token") {
      const { code } = JSON.parse(body);
      if (!["good-code", "second-code"].includes(code)) { res.statusCode = 400; return res.end("{}"); }
      return res.end(JSON.stringify({ access_token: `kc-${code}`, refresh_token: "kc-refresh" }));
    }
    if (req.url === "/profile") {
      const auth = req.headers.authorization || "";
      if (!/^Bearer kc-/.test(auth)) { res.statusCode = 401; return res.end("{}"); }
      if (auth === "Bearer kc-second-code") return res.end(JSON.stringify({ profile: { id: "kc-456", name: "Grace Okafor", username: "grace_o", user: { kcID: "kc-777", profilePicture: "https://kc/grace.jpg", emailAddress: "grace@church.org" } } }));
      return res.end(JSON.stringify({ profile: { id: "kc-123", name: "Ade Bello", username: "pastor_ade", email: "ade@church.org", phone_number: "+2348000000000", avatar: "https://kc/ade.jpg" } }));
    }
    res.statusCode = 404; res.end("{}");
  });
});

let base, server, routes;
const api = async (method, path, { body, token, headers = {} } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json", "x-api-key": "app-key", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
};

test.before(async () => {
  await new Promise((r) => kingschat.listen(0, "127.0.0.1", r));
  const kc = `http://127.0.0.1:${kingschat.address().port}`;
  Object.assign(process.env, {
    EXPO_SKIP_ENV_FILE: "1", LOVEWORLD_EXPO_DATABASE_URL: DB_URL, EXPO_KC_CLIENT_ID: "test-client", EXPO_KC_TOKEN_URL: `${kc}/token`, EXPO_KC_PROFILE_URL: `${kc}/profile`,
    EXPO_API_KEY: "app-key", EXPO_ADMIN_KEY: "admin-key", EXPO_SITE_URL: "http://localhost:3000", EXPO_MAX_BOOKINGS_PER_DAY: "2",
  });
  delete process.env.EXPO_TOKEN_SECRET;
  routes = require("../routes/loveworld_expo");
  const express = require("express");
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(routes({}));
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
  const name = new URL(DB_URL).pathname.slice(1);
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
});

let token, refreshToken, user;

test("ping makes the database and the app key is asked for", async () => {
  const r = await api("GET", "/expo/ping");
  assert.equal(r.status, 200);
  assert.equal(r.json.exhibitors, 0);
  const no = await fetch(`${base}/expo/config`);
  assert.equal(no.status, 401);
  const cfg = await api("GET", "/expo/config");
  assert.equal(cfg.json.kingschat.clientId, "test-client");
  assert.equal(cfg.json.kingschat.redirectUri, "http://localhost:3000/auth/kingschat/callback");
  assert.equal(cfg.json.event.days.length, 7);
});

test("KingsChat sign-in by code and by access token, refresh and logout", async () => {
  const bad = await api("POST", "/expo/auth/kingschat", { body: { code: "nope" } });
  assert.equal(bad.status, 502);
  assert.equal(bad.json.error, "kc_exchange_failed");
  const r = await api("POST", "/expo/auth/kingschat", { body: { code: "good-code", deviceId: "browser-1" } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  ({ accessToken: token, refreshToken, user } = r.json);
  assert.equal(user.username, "pastor_ade");
  assert.equal(user.email, "ade@church.org");
  assert.equal(r.json.deviceId, "browser-1");
  // The same person by access token (the site exchanges the code itself): the same account.
  const again = await api("POST", "/expo/auth/kingschat", { body: { accessToken: "kc-good-code" } });
  assert.equal(again.json.user.id, user.id);
  const me = await api("GET", "/expo/me", { token });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.id, user.id);
  assert.equal(me.json.counts.bookings, 0);
  const fresh = await api("POST", "/expo/auth/refresh", { body: { refreshToken } });
  assert.equal(fresh.status, 200);
  const used = await api("POST", "/expo/auth/refresh", { body: { refreshToken } });
  assert.equal(used.status, 401);
  refreshToken = fresh.json.refreshToken;
  token = fresh.json.accessToken;
  const out = await api("POST", "/expo/auth/logout", { body: { refreshToken } });
  assert.equal(out.status, 200);
  assert.equal((await api("POST", "/expo/auth/refresh", { body: { refreshToken } })).status, 401);
  const nobody = await api("GET", "/expo/me", { token: "x.y.z" });
  assert.equal(nobody.status, 401);
});

test("profile fields are kept on the account", async () => {
  const r = await api("PATCH", "/expo/me", { token, body: { organisation: "Christ Embassy Lekki", role: "Partner", country: "Nigeria" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.organisation, "Christ Embassy Lekki");
  assert.equal(r.json.user.country, "Nigeria");
  const badMail = await api("PATCH", "/expo/me", { token, body: { email: "nope" } });
  assert.equal(badMail.status, 400);
});

test("exhibitors: admin makes them, everyone reads them", async () => {
  const noKey = await api("POST", "/expo/admin/exhibitors", { body: { name: "X" } });
  assert.equal(noKey.status, 401);
  const admin = { "x-admin-key": "admin-key" };
  const made = await api("POST", "/expo/admin/exhibitors", { headers: admin, body: { id: "kingschat", name: "KingsChat", category: "Technology", zone: "tech", stand: "T01", smartMeet: true, featured: true, meetingTopics: ["Platform integrations"] } });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const imported = await api("POST", "/expo/admin/exhibitors/import", { headers: admin, body: { exhibitors: [
    { id: "loveworld-tv", name: "LoveWorld TV", category: "Media", zone: "media", stand: "M01", smartMeet: true },
    { id: "healing-school", name: "Healing School", category: "Ministry", zone: "ministry", stand: "C01", smartMeet: false },
  ] } });
  assert.equal(imported.json.imported, 2);
  const all = await api("GET", "/expo/exhibitors");
  assert.deepEqual(all.json.exhibitors.map((e) => e.id), ["kingschat", "loveworld-tv", "healing-school"]);
  assert.equal(all.json.exhibitors[0].availability, undefined);
  const smart = await api("GET", "/expo/exhibitors?smartmeet=1&q=tv");
  assert.deepEqual(smart.json.exhibitors.map((e) => e.id), ["loveworld-tv"]);
  const one = await api("GET", "/expo/exhibitors/kingschat");
  assert.equal(one.json.exhibitor.meetingTopics[0], "Platform integrations");
  const hidden = await api("PUT", "/expo/admin/exhibitors/healing-school", { headers: admin, body: { active: false } });
  assert.equal(hidden.json.exhibitor.active, false);
  assert.equal((await api("GET", "/expo/exhibitors/healing-school")).status, 404);
});

test("SmartMeet: availability, booking, clashes, the daily limit and cancelling", async () => {
  const closed = await api("GET", "/expo/smartmeet/availability?exhibitor=healing-school&date=2026-11-10");
  assert.equal(closed.status, 404);
  const badDay = await api("GET", "/expo/smartmeet/availability?exhibitor=kingschat&date=2026-12-01");
  assert.equal(badDay.status, 400);
  const av = await api("GET", "/expo/smartmeet/availability?exhibitor=kingschat&date=2026-11-10");
  assert.equal(av.status, 200);
  const slots = av.json.slots;
  assert.equal(slots[0].start, "2026-11-10T10:00:00");
  assert.equal(slots[0].end, "2026-11-10T10:20:00");
  assert.ok(!slots.some((s) => s.start.startsWith("2026-11-10T13")), "lunch is skipped");
  assert.ok(slots.every((s) => s.available));

  const anon = await api("POST", "/expo/smartmeet/bookings", { body: { exhibitorId: "kingschat", start: "2026-11-10T10:00", topic: "Integrations" } });
  assert.equal(anon.status, 401);
  const signin = await api("POST", "/expo/auth/kingschat", { body: { accessToken: "kc-good-code", deviceId: "browser-1" } });
  token = signin.json.accessToken;
  const booked = await api("POST", "/expo/smartmeet/bookings", { token, body: { exhibitorId: "kingschat", start: "2026-11-10T10:00", topic: "Integrations", notes: "Bring the SDK" } });
  assert.equal(booked.status, 201, JSON.stringify(booked.json));
  const b = booked.json.booking;
  assert.match(b.reference, /^SM-[0-9A-F]{6}$/);
  assert.equal(b.start, "2026-11-10T10:00:00");
  assert.equal(b.end, "2026-11-10T10:20:00");
  assert.equal(b.name, "Ade Bello");
  assert.equal(b.email, "ade@church.org");
  assert.equal(b.organisation, "Christ Embassy Lekki");
  assert.match(b.location, /^SmartMeet Lounge · Table \d+$/);
  assert.equal(b.exhibitor.name, "KingsChat");

  const after = await api("GET", "/expo/smartmeet/availability?exhibitor=kingschat&date=2026-11-10");
  assert.equal(after.json.slots.find((s) => s.start === "2026-11-10T10:00:00").available, false);

  // Someone else wants the same slot.
  const other = await api("POST", "/expo/auth/kingschat", { body: { code: "second-code" } });
  const taken = await api("POST", "/expo/smartmeet/bookings", { token: other.json.accessToken, body: { exhibitorId: "kingschat", start: "2026-11-10T10:00", topic: "Hi" } });
  assert.equal(taken.status, 409);
  assert.equal(taken.json.error, "slot_taken");
  // The same person, another exhibitor, the same time.
  const clash = await api("POST", "/expo/smartmeet/bookings", { token, body: { exhibitorId: "loveworld-tv", start: "2026-11-10T10:00", topic: "Hi" } });
  assert.equal(clash.json.error, "double_booked");
  const offGrid = await api("POST", "/expo/smartmeet/bookings", { token, body: { exhibitorId: "kingschat", start: "2026-11-10T10:05", topic: "Hi" } });
  assert.equal(offGrid.json.error, "bad_slot");
  const second = await api("POST", "/expo/smartmeet/bookings", { token, body: { exhibitorId: "loveworld-tv", start: "2026-11-10T10:20", topic: "Syndication" } });
  assert.equal(second.status, 201);
  const third = await api("POST", "/expo/smartmeet/bookings", { token, body: { exhibitorId: "kingschat", start: "2026-11-10T10:40", topic: "More" } });
  assert.equal(third.json.error, "day_full");

  const mine = await api("GET", "/expo/smartmeet/bookings", { token });
  assert.equal(mine.json.bookings.length, 2);
  assert.equal((await api("GET", "/expo/me", { token })).json.counts.bookings, 2);
  const cancelled = await api("DELETE", `/expo/smartmeet/bookings/${b.id}`, { token });
  assert.equal(cancelled.json.booking.status, "cancelled");
  assert.equal((await api("DELETE", `/expo/smartmeet/bookings/${b.id}`, { token })).status, 404);
  const free = await api("GET", "/expo/smartmeet/availability?exhibitor=kingschat&date=2026-11-10");
  assert.equal(free.json.slots.find((s) => s.start === "2026-11-10T10:00:00").available, true);
  const notMine = await api("DELETE", `/expo/smartmeet/bookings/${second.json.booking.id}`, { token: other.json.accessToken });
  assert.equal(notMine.status, 404);
  const list = await api("GET", "/expo/admin/bookings?date=2026-11-10", { headers: { "x-admin-key": "admin-key" } });
  assert.equal(list.json.bookings.length, 2);
});

test("forms: registrations, sponsor enquiries and program applications", async () => {
  const bad = await api("POST", "/expo/registrations", { body: { firstName: "A", lastName: "B", email: "nope" } });
  assert.equal(bad.status, 400);
  const reg = await api("POST", "/expo/registrations", { token, body: { firstName: "Ade", lastName: "Bello", email: "ade@church.org", interests: ["visiting", "smartmeet"], country: "Nigeria", zone: "Lagos Zone 2" } });
  assert.equal(reg.status, 201);
  assert.match(reg.json.reference, /^REG-/);
  const me = await api("GET", "/expo/me", { token });
  assert.equal(me.json.user.zone, "Lagos Zone 2");
  assert.equal(me.json.counts.registrations, 1);
  const anon = await api("POST", "/expo/registrations", { body: { firstName: "Ngozi", lastName: "Eze", email: "ngozi@example.com" } });
  assert.equal(anon.status, 201);

  const sp = await api("POST", "/expo/sponsor/enquiries", { body: { name: "Tolu", email: "tolu@brand.com", organisation: "Brand Ltd", interest: "Program Partner", programs: "Eagles Nest", message: "Hello" } });
  assert.equal(sp.status, 201);
  assert.match(sp.json.reference, /^SP-/);

  const app1 = await api("POST", "/expo/programs/applications", { token, body: { program: "eagles-nest", name: "Ade Bello", email: "ade@church.org", summary: "A fintech for churches", data: { teamSize: 3 } } });
  assert.equal(app1.status, 201);
  assert.match(app1.json.reference, /^EN-/);
  const badProg = await api("POST", "/expo/programs/applications", { body: { program: "other", name: "x", email: "x@y.z" } });
  assert.equal(badProg.status, 400);
  const mine = await api("GET", "/expo/programs/applications", { token });
  assert.equal(mine.json.applications[0].program, "eagles-nest");

  const admin = { "x-admin-key": "admin-key" };
  assert.equal((await api("GET", "/expo/admin/registrations", { headers: admin })).json.registrations.length, 2);
  assert.equal((await api("GET", "/expo/admin/enquiries", { headers: admin })).json.enquiries.length, 1);
  const apps = await api("GET", "/expo/admin/applications?program=eagles-nest", { headers: admin });
  assert.equal(apps.json.applications.length, 1);
  const moved = await api("POST", `/expo/admin/applications/${apps.json.applications[0].id}`, { headers: admin, body: { status: "shortlisted" } });
  assert.equal(moved.json.status, "shortlisted");
  const stats = await api("GET", "/expo/admin/stats", { headers: admin });
  assert.equal(stats.json.stats.users, 2);
});

test("a disabled account is signed out at once", async () => {
  const admin = { "x-admin-key": "admin-key" };
  const off = await api("POST", `/expo/admin/users/${user.id}`, { headers: admin, body: { disabled: true, reason: "Testing" } });
  assert.equal(off.json.disabled, true);
  const me = await api("GET", "/expo/me", { token });
  assert.equal(me.status, 403);
  assert.equal(me.json.error, "account_disabled");
  const back = await api("POST", `/expo/admin/users/${user.id}`, { headers: admin, body: { disabled: false } });
  assert.equal(back.json.disabled, false);
  assert.equal((await api("GET", "/expo/me", { token })).status, 200);
});
