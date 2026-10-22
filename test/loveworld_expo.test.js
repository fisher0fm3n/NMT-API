// The LoveWorld Expo service (routes/loveworld_expo.js) against a local Postgres and a
// stand-in for KingsChat. Run: node --test test/loveworld_expo.test.js
// (EXPO_TEST_DATABASE_URL picks the database; it is created, and dropped after.)
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { Client } = require("pg");

const DB_URL = process.env.EXPO_TEST_DATABASE_URL || "postgres://localhost/loveworld_expo_test";
if (!["localhost", "127.0.0.1", "::1", ""].includes(new URL(DB_URL).hostname)) throw new Error("EXPO_TEST_DATABASE_URL must be a database on this computer");

// KingsChat, as far as sign-in goes: a code becomes a token, a token a profile. And its messages
// API: what is sent is kept in kcMessages; kcRefuse makes it refuse as KingsChat does.
const kcMessages = [];
let kcRefuse = false;
// The project's own KingsChat profile: messages sent as the project cannot go to it.
let kcProjectProfile = null;
const kingschat = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/token") {
      const { code } = JSON.parse(body);
      if (!["good-code", "second-code", "third-code"].includes(code)) { res.statusCode = 400; return res.end("{}"); }
      return res.end(JSON.stringify({ access_token: `kc-${code}`, refresh_token: "kc-refresh" }));
    }
    if (req.url === "/profile") {
      const auth = req.headers.authorization || "";
      if (!/^Bearer kc-/.test(auth)) { res.statusCode = 401; return res.end("{}"); }
      if (auth === "Bearer kc-third-code") return res.end(JSON.stringify({ profile: { id: "kc-999", name: "Tolu Ade", username: "tolu_a", email: "tolu@example.com" } }));
      if (auth === "Bearer kc-second-code") return res.end(JSON.stringify({ profile: { id: "kc-456", name: "Grace Okafor", username: "grace_o", user: { kcID: "kc-777", profilePicture: "https://kc/grace.jpg", emailAddress: "grace@church.org" } } }));
      return res.end(JSON.stringify({ profile: { id: "kc-123", name: "Ade Bello", username: "pastor_ade", email: "ade@church.org", phone_number: "+2348000000000", avatar: "https://kc/ade.jpg" } }));
    }
    if (req.url === "/messages" && req.method === "POST") {
      const msg = JSON.parse(body);
      kcMessages.push({ apiKey: req.headers["api-key"], ...msg });
      if (kcRefuse) { res.statusCode = 403; return res.end(JSON.stringify({ error: "recipient_not_authorized", message: "The recipient has not authorized your project." })); }
      if (kcProjectProfile === msg.recipient_id) { res.statusCode = 400; return res.end(JSON.stringify({ error: "cannot_send_to_self", message: "recipient_id is the sender itself." })); }
      return res.end(JSON.stringify({ status: "ok", conversation: { identifier: `conv-${msg.recipient_id}` }, message: { id: `msg-${kcMessages.length}`, sent_at_millis: Date.now() } }));
    }
    res.statusCode = 404; res.end("{}");
  });
});

/** Waits until the stand-in KingsChat has been sent `n` messages in all (they go in the background). */
async function messagesSoFar(n) {
  for (let i = 0; i < 100 && kcMessages.length < n; i++) await new Promise((r) => setTimeout(r, 30));
  return kcMessages;
}

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
    EXPO_KC_API_KEY: "kc-project-key", EXPO_KC_MESSAGES_URL: `${kc}/messages`,
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

test("the profile starts from KingsChat and is complete once every field is there", async () => {
  // From the KingsChat sign-in: the name split in two, the email and the phone.
  let me = (await api("GET", "/expo/me", { token })).json.user;
  assert.equal(me.firstName, "Ade");
  assert.equal(me.lastName, "Bello");
  assert.equal(me.email, "ade@church.org");
  assert.equal(me.phone, "+2348000000000");
  assert.equal(me.profileComplete, false);
  // The rest (country came in the last test), and a first name of the person's own choosing.
  const r = await api("PATCH", "/expo/me", { token, body: { title: "Pastor", firstName: "Adewale", zone: "Lagos Zone 1", church: "Christ Embassy Lekki" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.title, "Pastor");
  assert.equal(r.json.user.church, "Christ Embassy Lekki");
  assert.equal(r.json.user.profileComplete, true);
  // Signing in again keeps what the person entered, and an emptied field makes the profile incomplete.
  const again = await api("POST", "/expo/auth/kingschat", { body: { accessToken: "kc-good-code" } });
  assert.equal(again.json.user.firstName, "Adewale");
  token = again.json.accessToken;
  me = (await api("PATCH", "/expo/me", { token, body: { church: "  " } })).json.user;
  assert.equal(me.profileComplete, false);
  me = (await api("PATCH", "/expo/me", { token, body: { church: "Christ Embassy Lekki" } })).json.user;
  assert.equal(me.profileComplete, true);
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

test("an exhibitor's team: the admin adds an account, which then runs the exhibitor", async () => {
  const admin = { "x-admin-key": "admin-key" };
  const other = await api("POST", "/expo/auth/kingschat", { body: { code: "second-code" } });
  const notYet = await api("GET", "/expo/exhibitor", { token });
  assert.equal(notYet.status, 403);
  assert.equal(notYet.json.error, "not_exhibitor");
  assert.equal((await api("POST", `/expo/admin/users/${user.id}/exhibitor`, { headers: admin, body: { exhibitorId: "nope" } })).status, 404);
  const added = await api("POST", `/expo/admin/users/${user.id}/exhibitor`, { headers: admin, body: { exhibitorId: "kingschat" } });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  assert.deepEqual(added.json.user.exhibitor, { id: "kingschat", name: "KingsChat" });
  assert.equal((await api("GET", "/expo/me", { token })).json.exhibitor.name, "KingsChat");
  assert.equal((await api("GET", "/expo/me", { token: other.json.accessToken })).json.exhibitor, null);
  const team = await api("GET", "/expo/admin/users?exhibitor=kingschat", { headers: admin });
  assert.deepEqual(team.json.users.map((u) => u.id), [user.id]);
  assert.equal((await api("GET", "/expo/admin/exhibitors", { headers: admin })).json.exhibitors.find((e) => e.id === "kingschat").team, 1);

  // The overview: the exhibitor with its availability, its meetings by day, the team.
  const overview = await api("GET", "/expo/exhibitor", { token });
  assert.equal(overview.status, 200, JSON.stringify(overview.json));
  assert.equal(overview.json.exhibitor.id, "kingschat");
  assert.deepEqual(overview.json.exhibitor.availability, {});
  assert.equal(overview.json.counts.bookings, 0); // Ade cancelled his
  assert.equal(overview.json.counts.cancelled, 1);
  assert.equal(overview.json.days.length, 7);
  assert.ok(overview.json.days[1].slots > 0);
  assert.deepEqual(overview.json.team.map((m) => m.username), ["pastor_ade"]);
  assert.equal((await api("GET", "/expo/exhibitor", { token: other.json.accessToken })).status, 403);

  // The team changes the stand's copy and SmartMeet; the name, stand and flags stay the admin's.
  const changed = await api("PATCH", "/expo/exhibitor", { token, body: { tagline: "Messaging for the kingdom", meetingTopics: ["SDK", "Communities"], availability: { dayStart: 11 }, name: "Hacked", stand: "Z99", active: false, featured: false } });
  assert.equal(changed.status, 200, JSON.stringify(changed.json));
  assert.equal(changed.json.exhibitor.tagline, "Messaging for the kingdom");
  assert.deepEqual(changed.json.exhibitor.meetingTopics, ["SDK", "Communities"]);
  assert.equal(changed.json.exhibitor.availability.dayStart, 11);
  assert.equal(changed.json.exhibitor.name, "KingsChat");
  assert.equal(changed.json.exhibitor.stand, "T01");
  assert.equal(changed.json.exhibitor.active, true);
  assert.equal(changed.json.exhibitor.featured, true);
  const av = await api("GET", "/expo/smartmeet/availability?exhibitor=kingschat&date=2026-11-10");
  assert.equal(av.json.slots[0].start, "2026-11-10T11:00:00");

  // Its bookings, with who booked; one day of them with ?date=.
  const booked = await api("POST", "/expo/smartmeet/bookings", { token: other.json.accessToken, body: { exhibitorId: "kingschat", start: "2026-11-11T11:00", topic: "Communities" } });
  assert.equal(booked.status, 201, JSON.stringify(booked.json));
  const all = await api("GET", "/expo/exhibitor/bookings", { token });
  assert.equal(all.status, 200);
  assert.deepEqual(all.json.bookings.map((b) => b.status), ["cancelled", "confirmed"]);
  assert.equal(all.json.bookings[1].username, "grace_o");
  assert.equal(all.json.bookings[1].name, "Grace Okafor");
  const day = await api("GET", "/expo/exhibitor/bookings?date=2026-11-11", { token });
  assert.equal(day.json.bookings.length, 1);
  assert.equal((await api("GET", "/expo/exhibitor/bookings?date=2026-12-01", { token })).status, 400);
  assert.equal((await api("GET", "/expo/exhibitor", { token })).json.counts.bookings, 1);

  // Off the team again.
  const removed = await api("POST", `/expo/admin/users/${user.id}/exhibitor`, { headers: admin, body: { exhibitorId: null } });
  assert.equal(removed.json.user.exhibitor, null);
  assert.equal((await api("GET", "/expo/exhibitor", { token })).status, 403);
});

test("admins: the flag on the account, granted by an admin, never taken from the last one", async () => {
  const admin = { "x-admin-key": "admin-key" };
  assert.equal((await api("GET", "/expo/me", { token })).json.user.admin, false);
  const granted = await api("POST", `/expo/admin/users/${user.id}`, { headers: admin, body: { admin: true } });
  assert.equal(granted.status, 200, JSON.stringify(granted.json));
  assert.equal(granted.json.admin, true);
  assert.equal(granted.json.user.admin, true);
  assert.equal((await api("GET", "/expo/me", { token })).json.user.admin, true);
  assert.equal((await api("GET", "/expo/admin/users", { headers: admin })).json.users.find((u) => u.id === user.id).admin, true);
  const last = await api("POST", `/expo/admin/users/${user.id}`, { headers: admin, body: { admin: false } });
  assert.equal(last.status, 409);
  assert.equal(last.json.error, "last_admin");
  const other = await api("POST", "/expo/auth/kingschat", { body: { code: "second-code" } });
  await api("POST", `/expo/admin/users/${other.json.user.id}`, { headers: admin, body: { admin: true } });
  const taken = await api("POST", `/expo/admin/users/${user.id}`, { headers: admin, body: { admin: false } });
  assert.equal(taken.json.admin, false);
  // Disabling still works on its own, and leaves the flag alone.
  const off = await api("POST", `/expo/admin/users/${other.json.user.id}`, { headers: admin, body: { disabled: true } });
  assert.equal(off.json.disabled, true);
  assert.equal(off.json.admin, true);
  assert.equal((await api("POST", `/expo/admin/users/${other.json.user.id}`, { headers: admin, body: { disabled: false } })).json.disabled, false);
});

test("registrations: the pass as quoted, pending until confirmed, the person's own list", async () => {
  const admin = { "x-admin-key": "admin-key" };
  const badDay = await api("POST", "/expo/registrations", { token, body: { firstName: "Ade", lastName: "Bello", email: "ade@church.org", pass: "day", passDay: "2026-12-01", passPrice: 5000, passCurrency: "ngn" } });
  assert.equal(badDay.status, 400);
  assert.equal(badDay.json.error, "bad_date");
  const paid = await api("POST", "/expo/registrations", { token, body: { firstName: "Ade", lastName: "Bello", email: "ade@church.org", pass: "day", passDay: "2026-11-10", passPrice: 5000, passCurrency: "ngn" } });
  assert.equal(paid.status, 201, JSON.stringify(paid.json));
  assert.equal(paid.json.registration.status, "pending");
  assert.equal(paid.json.registration.passPrice, 5000);
  assert.equal(paid.json.registration.passCurrency, "NGN");
  assert.equal(paid.json.registration.passDay, "2026-11-10");
  const free = await api("POST", "/expo/registrations", { body: { firstName: "Ngozi", lastName: "Eze", email: "ngozi@example.com", pass: "delegate", passPrice: 0 } });
  assert.equal(free.json.registration.status, "confirmed");
  assert.equal((await api("GET", "/expo/registrations")).status, 401);
  const mine = await api("GET", "/expo/registrations", { token });
  assert.equal(mine.json.registrations[0].reference, paid.json.reference);
  assert.ok(mine.json.registrations.every((r) => r.userId === user.id));
  const pending = await api("GET", "/expo/admin/registrations?status=pending&pass=day", { headers: admin });
  assert.deepEqual(pending.json.registrations.map((r) => r.reference), [paid.json.reference]);
  const confirmed = await api("POST", `/expo/admin/registrations/${paid.json.id}`, { headers: admin, body: { status: "confirmed" } });
  assert.equal(confirmed.json.status, "confirmed");
  assert.equal((await api("POST", `/expo/admin/registrations/${paid.json.id}`, { headers: admin, body: { status: "paid" } })).status, 400);
  const apps = await api("GET", "/expo/admin/applications?program=eagles-nest&status=shortlisted", { headers: admin });
  assert.equal(apps.json.applications.length, 1);
});

test("KingsChat messages: both sides hear about a booking, and about a cancellation by either side", async () => {
  const admin = { "x-admin-key": "admin-key" };
  const ade = (await api("POST", "/expo/auth/kingschat", { body: { code: "good-code" } })).json;
  const grace = (await api("POST", "/expo/auth/kingschat", { body: { code: "second-code" } })).json;
  // Grace runs LoveWorld TV. Her KingsChat profile.id (kc-456) is what messages go to, not her kcID (kc-777).
  assert.equal((await api("POST", `/expo/admin/users/${grace.user.id}/exhibitor`, { headers: admin, body: { exhibitorId: "loveworld-tv" } })).status, 200);
  await messagesSoFar(0);
  const start = kcMessages.length;
  const sent = () => kcMessages.slice(start);
  const to = (id) => sent().filter((m) => m.recipient_id === id);

  // Booked: a confirmation to the visitor, the details to the team.
  const booked = await api("POST", "/expo/smartmeet/bookings", { token: ade.accessToken, body: { exhibitorId: "loveworld-tv", start: "2026-11-12T10:00", topic: "Syndication", notes: "Two shows a week" } });
  assert.equal(booked.status, 201, JSON.stringify(booked.json));
  const ref = booked.json.booking.reference;
  await messagesSoFar(start + 2);
  assert.equal(sent().length, 2);
  for (const m of sent()) {
    assert.equal(m.apiKey, "kc-project-key");
    assert.equal(m.sender_id, undefined, "sent as the project, so no sender_id");
    assert.ok(Buffer.byteLength(m.message.body.text.body) <= 1024);
  }
  const confirm = to("kc-123")[0].message.body.text.body;
  assert.match(confirm, /SmartMeet confirmed/);
  assert.match(confirm, /With: LoveWorld TV · Stand M01/);
  assert.match(confirm, /When: Thu 12 Nov, 10:00–10:20 \(GMT\+1\)/);
  assert.match(confirm, /Where: SmartMeet Lounge · Table \d+/);
  assert.ok(confirm.includes(`Reference: ${ref}`));
  assert.ok(confirm.includes("http://localhost:3000/my-expo"));
  assert.equal(to("kc-777").length, 0);
  const news = to("kc-456")[0].message.body.text.body;
  assert.match(news, /New SmartMeet booking · LoveWorld TV/);
  assert.match(news, /Visitor: Ade Bello \(@pastor_ade\)/);
  assert.match(news, /Topic: Syndication/);
  assert.match(news, /Notes: Two shows a week/);

  // The visitor cancels, with a reason: both are told.
  const n1 = kcMessages.length;
  const cancelled = await api("DELETE", `/expo/smartmeet/bookings/${booked.json.booking.id}`, { token: ade.accessToken, body: { reason: "Flight moved" } });
  assert.equal(cancelled.json.booking.cancelledBy, "visitor");
  assert.equal(cancelled.json.booking.cancelReason, "Flight moved");
  await messagesSoFar(n1 + 2);
  const [c1, c2] = [kcMessages.slice(n1).find((m) => m.recipient_id === "kc-123"), kcMessages.slice(n1).find((m) => m.recipient_id === "kc-456")];
  assert.match(c1.message.body.text.body, /You cancelled your meeting\./);
  assert.match(c1.message.body.text.body, /Reason: Flight moved/);
  assert.match(c2.message.body.text.body, /Cancelled by: Ade Bello/);
  assert.match(c2.message.body.text.body, /The slot is open for booking again\./);

  // The exhibitor cancels: only someone on its team may, and both are told.
  const again = await api("POST", "/expo/smartmeet/bookings", { token: ade.accessToken, body: { exhibitorId: "loveworld-tv", start: "2026-11-12T10:20", topic: "Syndication" } });
  assert.equal(again.status, 201);
  await messagesSoFar(kcMessages.length + 2);
  const notTeam = await api("DELETE", `/expo/exhibitor/bookings/${again.json.booking.id}`, { token: ade.accessToken });
  assert.equal(notTeam.status, 403);
  const n2 = kcMessages.length;
  const byTeam = await api("DELETE", `/expo/exhibitor/bookings/${again.json.booking.id}`, { token: grace.accessToken, body: { reason: "Our studio lead is ill" } });
  assert.equal(byTeam.status, 200, JSON.stringify(byTeam.json));
  assert.equal(byTeam.json.booking.status, "cancelled");
  assert.equal(byTeam.json.booking.cancelledBy, "exhibitor");
  assert.equal(byTeam.json.booking.username, "pastor_ade");
  await messagesSoFar(n2 + 2);
  const v = kcMessages.slice(n2).find((m) => m.recipient_id === "kc-123").message.body.text.body;
  const t = kcMessages.slice(n2).find((m) => m.recipient_id === "kc-456").message.body.text.body;
  assert.match(v, /LoveWorld TV cancelled your meeting\./);
  assert.match(v, /Reason: Our studio lead is ill/);
  assert.ok(v.includes("http://localhost:3000/smartmeet?exhibitor=loveworld-tv"));
  assert.match(t, /Cancelled by: LoveWorld TV \(Grace Okafor\)/);
  assert.equal((await api("DELETE", `/expo/exhibitor/bookings/${again.json.booking.id}`, { token: grace.accessToken })).status, 404);
  const free = await api("GET", "/expo/smartmeet/availability?exhibitor=loveworld-tv&date=2026-11-12");
  assert.equal(free.json.slots.find((s) => s.start === "2026-11-12T10:20:00").available, true);

  // KingsChat refusing does not undo the booking; the refusal is kept for the admin.
  kcRefuse = true;
  const long = "x".repeat(1900);
  const refused = await api("POST", "/expo/smartmeet/bookings", { token: ade.accessToken, body: { exhibitorId: "loveworld-tv", start: "2026-11-13T10:00", topic: "Syndication", notes: long } });
  assert.equal(refused.status, 201);
  await messagesSoFar(kcMessages.length + 2);
  kcRefuse = false;
  assert.ok(kcMessages.slice(-2).every((m) => Buffer.byteLength(m.message.body.text.body) <= 1024), "long notes are cut to KingsChat's inline limit");
  let log;
  for (let i = 0; i < 50; i++) {
    log = await api("GET", `/expo/admin/notifications?booking=${refused.json.booking.id}`, { headers: admin });
    if (log.json.notifications.length === 2) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.deepEqual(log.json.notifications.map((n) => n.status), ["failed", "failed"]);
  assert.match(log.json.notifications[0].error, /recipient_not_authorized/);
  const first = await api("GET", `/expo/admin/notifications?booking=${booked.json.booking.id}`, { headers: admin });
  assert.deepEqual(first.json.notifications.map((n) => n.status).sort(), ["sent", "sent", "sent", "sent"]);
  assert.ok(first.json.notifications.every((n) => n.kcMessageId));
});

test("KingsChat messages: sent as the project; a message to the project's own profile is skipped", async () => {
  const admin = { "x-admin-key": "admin-key" };
  const ade = (await api("POST", "/expo/auth/kingschat", { body: { code: "good-code" } })).json;
  const statuses = async (bookingId, n) => {
    for (let i = 0; i < 100; i++) {
      const log = await api("GET", `/expo/admin/notifications?booking=${bookingId}`, { headers: admin });
      if (log.json.notifications.length >= n) return log.json.notifications;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error("the messages were not recorded");
  };

  // As the project, when the visitor is the project's own profile: skipped, not failed.
  kcProjectProfile = "kc-123";
  const own = await api("POST", "/expo/smartmeet/bookings", { token: ade.accessToken, body: { exhibitorId: "loveworld-tv", start: "2026-11-14T10:00", topic: "Syndication" } });
  assert.equal(own.status, 201);
  const ownLog = await statuses(own.json.booking.id, 2);
  kcProjectProfile = null;
  const toAde = ownLog.find((n) => n.recipientKcId === "kc-123");
  assert.equal(toAde.status, "skipped");
  assert.match(toAde.error, /project's own KingsChat profile/);
  assert.equal(ownLog.find((n) => n.recipientKcId === "kc-456").status, "sent");

  // Every message goes out as the project: never with a sender_id.
  assert.ok(kcMessages.every((m) => m.sender_id === undefined));
});

test("a new account is welcomed on KingsChat, once", async () => {
  const admin = { "x-admin-key": "admin-key" };
  // Ade's account was made by his first sign-in, in an earlier test; he has signed in many times since.
  let welcome = [];
  for (let i = 0; i < 50 && !welcome.length; i++) {
    const log = await api("GET", "/expo/admin/notifications?limit=2000", { headers: admin });
    welcome = log.json.notifications.filter((n) => n.kind === "welcome" && n.recipientKcId === "kc-123");
    if (!welcome.length) await new Promise((r) => setTimeout(r, 30));
  }
  assert.equal(welcome.length, 1, "one welcome, however often he signs in");
  assert.equal(welcome[0].status, "sent");
  assert.equal(welcome[0].bookingId, null);
  const text = welcome[0].body;
  assert.match(text, /^👋 Welcome to LoveWorld Expo 2026, Ade!/);
  assert.match(text, /9–15 Nov 2026/);
  assert.match(text, /enterprise, health, agriculture, fashion & creativity, technology, manufacturing and investment/);
  assert.match(text, /SmartMeet/);
  assert.ok(text.includes("http://localhost:3000/smartmeet"));
  assert.ok(Buffer.byteLength(text) <= 1024);
  // A sign-in that does not make an account says so, and sends nothing new.
  const again = await api("POST", "/expo/auth/kingschat", { body: { code: "good-code" } });
  assert.equal(again.json.created, false);
});

test("rescheduling: to another free slot, until 15 minutes before; both sides are told", async () => {
  const admin = { "x-admin-key": "admin-key" };
  const ade = (await api("POST", "/expo/auth/kingschat", { body: { code: "good-code" } })).json;
  const grace = (await api("POST", "/expo/auth/kingschat", { body: { code: "second-code" } })).json;
  const booked = await api("POST", "/expo/smartmeet/bookings", { token: ade.accessToken, body: { exhibitorId: "loveworld-tv", start: "2026-11-11T14:00", topic: "Syndication" } });
  assert.equal(booked.status, 201, JSON.stringify(booked.json));
  const id = booked.json.booking.id;
  assert.equal(booked.json.booking.rescheduleCount, 0);
  assert.equal(booked.json.booking.rescheduleUntil, new Date(new Date(booked.json.booking.startsAt).getTime() - 15 * 60000).toISOString());

  // Only the visitor's own, and only to a real slot of the same exhibitor.
  assert.equal((await api("PATCH", `/expo/smartmeet/bookings/${id}`, { token: grace.accessToken, body: { start: "2026-11-11T14:20" } })).status, 404);
  assert.equal((await api("PATCH", `/expo/smartmeet/bookings/${id}`, { token: ade.accessToken, body: { start: "2026-11-11T14:05" } })).json.error, "bad_slot");
  assert.equal((await api("PATCH", `/expo/smartmeet/bookings/${id}`, { token: ade.accessToken, body: { start: "2026-11-11T14:00" } })).json.error, "same_time");
  assert.equal((await api("PATCH", `/expo/smartmeet/bookings/${id}`, { token: ade.accessToken, body: { start: "2026-12-01T10:00" } })).json.error, "bad_date");
  const other = await api("POST", "/expo/smartmeet/bookings", { token: grace.accessToken, body: { exhibitorId: "loveworld-tv", start: "2026-11-11T15:00", topic: "Studio tour" } });
  assert.equal(other.status, 201);
  const taken = await api("PATCH", `/expo/smartmeet/bookings/${id}`, { token: ade.accessToken, body: { start: "2026-11-11T15:00" } });
  assert.equal(taken.status, 409);
  assert.equal(taken.json.error, "slot_taken");

  // Moved: the new time is his, the old one free again, and both sides get the old and new times.
  const n0 = kcMessages.length;
  const moved = await api("PATCH", `/expo/smartmeet/bookings/${id}`, { token: ade.accessToken, body: { start: "2026-11-11T14:20" } });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal(moved.json.booking.start, "2026-11-11T14:20:00");
  assert.equal(moved.json.booking.end, "2026-11-11T14:40:00");
  assert.equal(moved.json.booking.reference, booked.json.booking.reference);
  assert.equal(moved.json.booking.location, booked.json.booking.location);
  assert.equal(moved.json.booking.rescheduleCount, 1);
  assert.ok(moved.json.booking.rescheduledAt);
  const av = await api("GET", "/expo/smartmeet/availability?exhibitor=loveworld-tv&date=2026-11-11");
  assert.equal(av.json.slots.find((x) => x.start === "2026-11-11T14:00:00").available, true);
  assert.equal(av.json.slots.find((x) => x.start === "2026-11-11T14:20:00").available, false);
  await messagesSoFar(n0 + 2);
  const v = kcMessages.slice(n0).find((m) => m.recipient_id === "kc-123").message.body.text.body;
  const t = kcMessages.slice(n0).find((m) => m.recipient_id === "kc-456").message.body.text.body;
  assert.match(v, /SmartMeet moved/);
  assert.match(v, /New time: Wed 11 Nov, 14:20–14:40/);
  assert.match(v, /Was: Wed 11 Nov, 14:00–14:20/);
  assert.match(t, /Ade Bello \(@pastor_ade\) moved their meeting\./);
  assert.match(t, /The earlier slot is open for booking again\./);

  // Within 15 minutes of the start it can no longer be moved (only cancelled).
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  await db.query(`UPDATE bookings SET starts_at = now() + interval '10 minutes', ends_at = now() + interval '30 minutes' WHERE id = $1`, [id]);
  await db.end();
  const late = await api("PATCH", `/expo/smartmeet/bookings/${id}`, { token: ade.accessToken, body: { start: "2026-11-11T16:00" } });
  assert.equal(late.status, 409);
  assert.equal(late.json.error, "too_late");
  assert.match(late.json.message, /15 minutes/);
  // A cancelled meeting cannot be moved either.
  await api("DELETE", `/expo/smartmeet/bookings/${other.json.booking.id}`, { token: grace.accessToken });
  assert.equal((await api("PATCH", `/expo/smartmeet/bookings/${other.json.booking.id}`, { token: grace.accessToken, body: { start: "2026-11-11T16:00" } })).status, 404);
  assert.equal((await api("GET", "/expo/config")).json.event.rescheduleCutoffMinutes, 15);
  void admin;
});

test("admins delete an account and everything it made, but never the last admin", async () => {
  const admin = { "x-admin-key": "admin-key" };
  const n0 = kcMessages.length;
  const tolu = (await api("POST", "/expo/auth/kingschat", { body: { code: "third-code" } })).json;
  const booked = await api("POST", "/expo/smartmeet/bookings", { token: tolu.accessToken, body: { exhibitorId: "loveworld-tv", start: "2026-11-12T10:00", topic: "Partnership" } });
  assert.equal(booked.status, 201, JSON.stringify(booked.json));
  const reg = await api("POST", "/expo/registrations", { token: tolu.accessToken, body: { firstName: "Tolu", lastName: "Ade", email: "tolu@example.com", pass: "week", passPrice: 30 } });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  // The welcome and the booking messages go in the background; let them land first.
  await messagesSoFar(n0 + 2);
  await new Promise((ok) => setTimeout(ok, 200));

  assert.equal((await api("DELETE", `/expo/admin/users/${tolu.user.id}`)).status, 401);
  const gone = await api("DELETE", `/expo/admin/users/${tolu.user.id}`, { headers: admin });
  assert.equal(gone.status, 200, JSON.stringify(gone.json));
  assert.equal(gone.json.deleted, tolu.user.id);
  assert.equal(gone.json.removed.bookings, 1);
  assert.equal(gone.json.removed.registrations, 1);
  // Its welcome counts here; the booking's messages go with the booking.
  assert.ok(gone.json.removed.messages >= 1, JSON.stringify(gone.json.removed));
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  const left = await db.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 OR booking_id = $2`, [tolu.user.id, booked.json.booking.id]);
  await db.end();
  assert.equal(left.rows[0].n, 0);

  // The account and its sign-ins are gone, and the meeting's slot is open again.
  const me = await api("GET", "/expo/me", { token: tolu.accessToken });
  assert.equal(me.status, 401);
  assert.equal(me.json.error, "account_deleted");
  assert.equal((await api("POST", "/expo/auth/refresh", { body: { refreshToken: tolu.refreshToken } })).status, 401);
  assert.equal((await api("GET", "/expo/admin/users", { headers: admin })).json.users.some((u) => u.id === tolu.user.id), false);
  const av = await api("GET", "/expo/smartmeet/availability?exhibitor=loveworld-tv&date=2026-11-12");
  assert.equal(av.json.slots.find((x) => x.start === "2026-11-12T10:00:00").available, true);
  assert.equal((await api("DELETE", `/expo/admin/users/${tolu.user.id}`, { headers: admin })).status, 404);

  // Grace is the one admin left (see the admins test): she stays.
  const grace = (await api("GET", "/expo/admin/users?q=grace_o", { headers: admin })).json.users[0];
  assert.equal(grace.admin, true);
  const last = await api("DELETE", `/expo/admin/users/${grace.id}`, { headers: admin });
  assert.equal(last.status, 409);
  assert.equal(last.json.error, "last_admin");
});
