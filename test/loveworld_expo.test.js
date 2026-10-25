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

// Espees' payments API: charges from a wallet or a card (espeesCharges: { path, token, body,
// reference }) and what transactionstatus says of each reference (espeesStatus[reference]: { status,
// amount? }; status "1", the amount charged, until set). espeesRefuse: the next charge is refused
// with that message. espeesBroken: charges answer with a server error. espeesSlow: ms a charge takes.
const espeesCharges = [];
const espeesStatus = {};
let espeesRefuse = null;
let espeesBroken = false;
let espeesSlow = 0;
const espees = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    res.setHeader("content-type", "application/json");
    const json = JSON.parse(body || "{}");
    if (req.url === "/makepayment" || req.url === "/cardpayment") {
      if (espeesSlow) await new Promise((r) => setTimeout(r, espeesSlow));
      if (espeesBroken) { res.statusCode = 500; res.setHeader("content-type", "text/html"); return res.end("<h1>Server Error</h1>"); }
      if (espeesRefuse) { const message = espeesRefuse; espeesRefuse = null; return res.end(JSON.stringify({ status: false, message })); }
      const reference = `esp-ref-${espeesCharges.length + 1}`;
      espeesCharges.push({ path: req.url, token: req.headers["api-token"], body: json, reference });
      return res.end(JSON.stringify({ status: true, data: { reference } }));
    }
    if (req.url === "/transactionstatus") {
      const c = espeesCharges.find((x) => x.reference === json.reference);
      if (!c) return res.end(JSON.stringify({ status: false, message: "Transaction not found" }));
      const st = espeesStatus[c.reference] || { status: "1" };
      return res.end(JSON.stringify({ status: true, data: { username: c.body.username ?? "username", espeesAmount: st.amount ?? Number(c.body.espeesAmount ?? c.body.amount), reference: c.reference, status: st.status, merchantID: "merchantID", narration: null } }));
    }
    res.statusCode = 404; res.end("{}");
  });
});
/** The reference Espees will give the next charge. */
const nextEspeesRef = () => `esp-ref-${espeesCharges.length + 1}`;

// KingsPass's add-attendee API: each attendee added (its form fields and the event token) is kept
// in kingspass; a ticket id in kingspassRefuse is refused, and kingspassReply, when set, is the next
// answer ({ status, body }) instead.
const kingspass = [];
const kingspassRefuse = new Set();
let kingspassReply = null;
const kingspassServer = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    res.setHeader("content-type", "application/json");
    if (req.url !== "/api/public/attendees" || req.method !== "POST") { res.statusCode = 404; return res.end("{}"); }
    const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": req.headers["content-type"] } }).formData();
    const fields = Object.fromEntries(form);
    if (kingspassReply) { const { status, body } = kingspassReply; kingspassReply = null; res.statusCode = status; return res.end(JSON.stringify(body)); }
    if (kingspassRefuse.has(Number(fields.ticket_id))) { res.statusCode = 500; return res.end(JSON.stringify({ success: false, message: "Server error" })); }
    kingspass.push({ token: req.headers["x-event-token"], fields });
    return res.end(JSON.stringify({ success: true, attendee: { id: 9000 + kingspass.length } }));
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
  await new Promise((r) => espees.listen(0, "127.0.0.1", r));
  await new Promise((r) => kingspassServer.listen(0, "127.0.0.1", r));
  const kc = `http://127.0.0.1:${kingschat.address().port}`;
  const pay = `http://127.0.0.1:${espees.address().port}`;
  Object.assign(process.env, {
    EXPO_SKIP_ENV_FILE: "1", LOVEWORLD_EXPO_DATABASE_URL: DB_URL, EXPO_KC_CLIENT_ID: "test-client", EXPO_KC_TOKEN_URL: `${kc}/token`, EXPO_KC_PROFILE_URL: `${kc}/profile`,
    EXPO_API_KEY: "app-key", EXPO_ADMIN_KEY: "admin-key", EXPO_SITE_URL: "http://localhost:3000", EXPO_MAX_BOOKINGS_PER_DAY: "2",
    EXPO_KC_API_KEY: "kc-project-key", EXPO_KC_MESSAGES_URL: `${kc}/messages`,
    EXPO_ESPEES_API_TOKEN: "esp-test-token", EXPO_ESPEES_URL: pay,
    EXPO_KINGSPASS_URL: `http://127.0.0.1:${kingspassServer.address().port}`, EXPO_KINGSPASS_EVENT_TOKEN: "event-token", EXPO_KINGSPASS_TEST2_TICKET: "2599",
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
  espees.close();
  kingspassServer.close();
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
  assert.match(text, /9–15 Nov 2026\./);
  assert.doesNotMatch(text, /IPPC/, "the Expo isn't described as held during IPPC");
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

test("passes: charged to an Espees wallet or card, each ticket issued on KingsPass, the buyer told once", async () => {
  const admin = { "x-admin-key": "admin-key" };
  const n0 = kcMessages.length;
  const wallet = { method: "wallet", username: "pastor_ade", pin: "1234" };
  const buy = (body, t = token) => api("POST", "/expo/passes/checkout", { token: t, body: { payment: wallet, ...body } });
  const confirm = (id, t = token) => api("POST", `/expo/passes/${id}/confirm`, { token: t });
  const toldAbout = (ref) => kcMessages.slice(n0).filter((m) => m.message.body.text.body.includes(ref));
  // Checkout answers once Espees has the money; confirming and issuing go on in the background.
  const settled = () => new Promise((ok) => setTimeout(ok, 250));
  const stored = async (id) => {
    const db = new Client({ connectionString: DB_URL });
    await db.connect();
    const row = (await db.query(`SELECT * FROM registrations WHERE id = $1`, [id])).rows[0];
    await db.end();
    return JSON.stringify(row);
  };

  // Refused before anything is charged: the wrong number of days, days outside the Expo, a pass not
  // on sale (the test pass is for admins), a price the website shows differently, no PIN, a bad card.
  assert.equal((await buy({ pass: "three-day", days: ["2026-11-10", "2026-11-11"] })).json.error, "bad_days");
  assert.equal((await buy({ pass: "three-day", days: ["2026-11-10", "2026-11-10", "2026-11-11"] })).json.error, "bad_days");
  assert.equal((await buy({ pass: "day", days: ["2026-12-01"] })).json.error, "bad_days");
  assert.equal((await buy({ pass: "test" })).json.error, "bad_pass");
  assert.equal((await buy({ pass: "toString" })).json.error, "bad_pass");
  const stale = await buy({ pass: "week", expectedPrice: 30 });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, "price_changed");
  assert.equal((await buy({ pass: "week", payment: { method: "wallet", username: "pastor_ade" } })).json.error, "missing_payment");
  assert.equal((await buy({ pass: "week", payment: { method: "card", cardNum: "12ab", pin: "1111" } })).json.error, "missing_payment");
  assert.equal(espeesCharges.length, 0);

  // A 3-day pass from the wallet: charged at its price with the merchant token, answered at once,
  // then confirmed with Espees and a ticket issued for each day. KingsPass refuses one at first, so
  // it's paid, not confirmed.
  kingspassRefuse.add(2580);
  const r = await buy({ pass: "three-day", days: ["2026-11-12", "2026-11-10", "2026-11-11"], expectedPrice: 15 });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual([r.json.registration.status, r.json.registration.paymentStatus], ["pending", "CHARGED"]);
  assert.deepEqual(espeesCharges.at(-1), { path: "/makepayment", token: "esp-test-token", body: { username: "pastor_ade", pin: "1234", espeesAmount: 15 }, reference: "esp-ref-1" });
  await settled();
  const reg = (await confirm(r.json.registration.id)).json.registration;
  assert.equal(reg.status, "paid");
  assert.deepEqual([reg.paymentMethod, reg.payer, reg.passPrice], ["wallet", "@pastor_ade", 15]);
  assert.deepEqual(reg.passDays, ["2026-11-10", "2026-11-11", "2026-11-12"]);
  assert.deepEqual(reg.tickets.map((t) => [t.day, t.ticketId, t.status]), [["2026-11-10", 2580, "failed"], ["2026-11-11", 2579, "issued"], ["2026-11-12", 2578, "issued"]]);
  assert.deepEqual(kingspass.find((k) => k.fields.ticket_id === "2579"), {
    token: "event-token",
    fields: { title: "Pastor", firstname: "Adewale", lastname: "Bello", email: "ade@church.org", phone_number: "+2348000000000", country: "Nigeria", zone: reg.zone, church: "Christ Embassy Lekki", ticket_id: "2579" },
  });
  // The PIN went to Espees and nowhere else.
  assert.ok(!JSON.stringify(r.json).includes("1234"));
  assert.ok(!(await stored(reg.id)).includes("1234"));
  assert.equal(toldAbout(reg.reference).length, 0);

  // Tried again: only the refused ticket goes again; confirmed, and the buyer told on KingsChat.
  kingspassRefuse.clear();
  const issued = kingspass.length;
  let c = await confirm(reg.id);
  assert.equal(c.json.registration.status, "confirmed");
  assert.equal(kingspass.length, issued + 1);
  assert.equal(kingspass.at(-1).fields.ticket_id, "2580");
  for (let i = 0; i < 100 && !toldAbout(reg.reference).length; i++) await new Promise((ok) => setTimeout(ok, 30));
  const text = toldAbout(reg.reference)[0]?.message.body.text.body || "";
  assert.match(text, /3-day pass is confirmed/);
  assert.match(text, /Days: Tue 10 Nov, Wed 11 Nov, Thu 12 Nov/);
  assert.match(text, /Paid: 15 Espees/);
  assert.match(text, /3 tickets are on KingsPass, issued to ade@church\.org/);
  // Bought again straight after: not charged a second time.
  const again = await buy({ pass: "three-day", days: ["2026-11-10", "2026-11-11", "2026-11-12"], expectedPrice: 15 });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, "already_paid");
  // And again: nothing more issued, charged or sent. Nobody else can check it.
  // (Further down: a refusal with field errors is recorded as KingsPass gave it.)
  c = await confirm(reg.id);
  assert.equal(c.json.registration.status, "confirmed");
  assert.equal(kingspass.length, issued + 1);
  assert.equal(espeesCharges.length, 1);
  await new Promise((ok) => setTimeout(ok, 200));
  assert.equal(toldAbout(reg.reference).length, 1);
  const grace = (await api("POST", "/expo/auth/kingschat", { body: { code: "second-code" } })).json;
  assert.equal((await confirm(reg.id, grace.accessToken)).status, 404);

  // Espees refuses: nothing taken, its reason shown, the attempt kept as cancelled with the reason.
  espeesRefuse = "Insufficient balance";
  const declined = await buy({ pass: "week", expectedPrice: 25 });
  assert.equal(declined.status, 402);
  assert.equal(declined.json.error, "payment_declined");
  assert.equal(declined.json.message, "Insufficient balance");
  const tried = (await api("GET", "/expo/registrations", { token })).json.registrations.find((x) => x.pass === "week");
  assert.deepEqual([tried.status, tried.paymentError], ["cancelled", "Insufficient balance"]);

  // An Espees card: its number and PIN, the amount as text; only its last four digits are kept.
  const card = await buy({ pass: "day", days: ["2026-11-13"], expectedPrice: 10, payment: { method: "card", cardNum: "1111 2222 3333 4444", pin: "9999" } });
  assert.equal(card.status, 201, JSON.stringify(card.json));
  assert.deepEqual([espeesCharges.at(-1).path, espeesCharges.at(-1).body], ["/cardpayment", { cardNum: "1111222233334444", pin: "9999", amount: "10" }]);
  await settled();
  const cardReg = (await confirm(card.json.registration.id)).json.registration;
  assert.deepEqual([cardReg.status, cardReg.payer], ["confirmed", "card ****4444"]);
  assert.ok(!(await stored(card.json.registration.id)).match(/1111222233334444|9999/));

  // Charged, but Espees hasn't confirmed it yet: pending until it does. The admin can bring it up to date.
  const vipRef = nextEspeesRef();
  espeesStatus[vipRef] = { status: "0" };
  const waiting = await buy({ pass: "vip", expectedPrice: 100 });
  assert.equal(waiting.status, 201);
  await settled();
  const stillWaiting = (await confirm(waiting.json.registration.id)).json.registration;
  assert.deepEqual([stillWaiting.status, stillWaiting.paymentStatus], ["pending", "CHARGED"]);
  espeesStatus[vipRef] = { status: "1" };
  const bySettle = await api("POST", `/expo/admin/registrations/${waiting.json.registration.id}/settle`, { headers: admin });
  assert.equal(bySettle.json.registration.status, "confirmed");
  assert.equal(bySettle.json.registration.tickets[0].attendeeId, String(9000 + kingspass.length));

  // Confirmed by Espees for another amount: left pending, nothing issued.
  espeesStatus[nextEspeesRef()] = { status: "1", amount: 0.01 };
  const odd = await buy({ pass: "day", days: ["2026-11-14"], expectedPrice: 10 });
  await settled();
  const oddReg = (await confirm(odd.json.registration.id)).json.registration;
  assert.deepEqual([oddReg.status, oddReg.paymentStatus], ["pending", "MISMATCH"]);
  assert.deepEqual(oddReg.tickets.map((t) => t.status), ["to_issue"]);

  // No clear answer from Espees: kept, flagged, and the buyer told not to pay again.
  espeesBroken = true;
  const unclear = await buy({ pass: "day", days: ["2026-11-15"], expectedPrice: 10 });
  espeesBroken = false;
  assert.equal(unclear.status, 502);
  assert.equal(unclear.json.error, "payment_unknown");

  // Pay pressed twice at once: the second is refused while the first is with Espees.
  espeesSlow = 300;
  const both = await Promise.all([buy({ pass: "week", expectedPrice: 25 }), buy({ pass: "week", expectedPrice: 25 })]);
  espeesSlow = 0;
  assert.deepEqual(both.map((x) => x.status).sort(), [201, 409]);
  assert.equal(both.find((x) => x.status === 409).json.error, "payment_in_progress");
  await settled();

  // The test pass: an admin with a complete profile, 0.001 Espees, KingsPass's test ticket.
  assert.equal((await buy({ pass: "test" }, grace.accessToken)).json.error, "profile_incomplete");
  await api("PATCH", "/expo/me", { token: grace.accessToken, body: { title: "Sis.", firstName: "Grace", lastName: "Okafor", phone: "+2348000000002", country: "Nigeria", zone: "Abuja Zone", church: "Christ Embassy Wuse" } });
  const t = await buy({ pass: "test", expectedPrice: 0.001, payment: { method: "wallet", username: "grace_o", pin: "0000" } }, grace.accessToken);
  assert.equal(t.status, 201, JSON.stringify(t.json));
  assert.equal(espeesCharges.at(-1).body.espeesAmount, 0.001);
  await settled();
  const testReg = (await confirm(t.json.registration.id, grace.accessToken)).json.registration;
  assert.deepEqual([testReg.status, testReg.passPrice], ["confirmed", 0.001]);
  assert.deepEqual([kingspass.at(-1).fields.ticket_id, kingspass.at(-1).fields.title], ["2582", "Sis."]);
  // Test pass 2: the second test ticket, from its setting.
  const t2 = await buy({ pass: "test-2", expectedPrice: 0.001, payment: { method: "wallet", username: "grace_o", pin: "0000" } }, grace.accessToken);
  assert.equal(t2.status, 201, JSON.stringify(t2.json));
  await settled();
  assert.equal((await confirm(t2.json.registration.id, grace.accessToken)).json.registration.status, "confirmed");
  assert.equal(kingspass.at(-1).fields.ticket_id, "2599");

  // KingsPass refuses (its answer as it really comes): the reason is kept as it gave it, for the admin.
  kingspassReply = { status: 400, body: { success: false, error: true, msg: { attend: "attendee already registered for this event" } } };
  const fussy = await buy({ pass: "day", days: ["2026-11-09"], expectedPrice: 10 });
  await settled();
  const refused = (await api("GET", "/expo/admin/registrations?pass=day", { headers: admin })).json.registrations.find((x) => x.id === fussy.json.registration.id);
  assert.equal(refused.status, "paid");
  assert.equal(refused.tickets[0].error, "400 attend: attendee already registered for this event");
  assert.match(refused.tickets[0].response, /"error":true/);
  // Tried again once KingsPass accepts it: confirmed.
  const fussyReg = (await api("POST", `/expo/admin/registrations/${fussy.json.registration.id}/settle`, { headers: admin })).json.registration;
  assert.equal(fussyReg.status, "confirmed");

  // The admin sees each ticket's KingsPass attendee; the person's own list doesn't.
  const list = (await api("GET", "/expo/admin/registrations?pass=three-day", { headers: admin })).json.registrations;
  assert.ok(list.find((x) => x.id === reg.id).tickets.every((x) => x.attendeeId));
  const mine = (await api("GET", "/expo/registrations", { token })).json.registrations.find((x) => x.id === reg.id);
  assert.equal(mine.tickets[0].attendeeId, undefined);
});

test("page views: only the page and the day, tidy pages only, at most 300 pages a day; totals for the admin", async () => {
  const admin = { "x-admin-key": "admin-key" };
  for (const path of ["/", "/about", "/about/", "/about?ref=kingschat#vision", "/programme/eagles-nest"]) {
    const r = await api("POST", "/expo/views", { body: { path } });
    assert.equal(r.status, 200, path);
    assert.equal(r.json.counted, true, path);
  }
  for (const path of ["", "about", "/About", "/admin", "/admin/users", "/api/views", "/auth/kingschat/continue", "/a/b/c/d/e", "/<script>", "/x y", "/a//b"]) {
    assert.equal((await api("POST", "/expo/views", { body: { path } })).status, 400, `refused: ${JSON.stringify(path)}`);
  }
  // Only from the website (the app key).
  const bare = await fetch(`${base}/expo/views`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/" }) });
  assert.equal(bare.status, 401);

  const stats = (await api("GET", "/expo/admin/page-views?days=7", { headers: admin })).json;
  assert.equal(stats.days.length, 7);
  assert.equal(stats.days.at(-1).day, stats.to);
  assert.equal(stats.days.at(-1).views, 5);
  assert.equal(stats.total, 5);
  assert.deepEqual(stats.pages, [{ path: "/about", views: 3 }, { path: "/", views: 1 }, { path: "/programme/eagles-nest", views: 1 }]);
  assert.equal(stats.allTime.views, 5);
  assert.equal(stats.allTime.since, stats.to);
  assert.equal((await api("GET", "/expo/admin/page-views")).status, 401, "admins only");

  // A flood of made-up pages stops at 300 a day; pages already counted still count.
  for (let i = 0; i < 297; i++) await api("POST", "/expo/views", { body: { path: `/flood-${i}` } });
  assert.equal((await api("POST", "/expo/views", { body: { path: "/one-too-many" } })).json.counted, false);
  assert.equal((await api("POST", "/expo/views", { body: { path: "/about" } })).json.counted, true);
  const after = (await api("GET", "/expo/admin/page-views?days=1", { headers: admin })).json;
  assert.equal(after.pages.length, 300);
  assert.equal(after.pages[0].path, "/about");
  assert.equal(after.pages[0].views, 4);
});

test("not a member of Christ Embassy: no zone or church needed; KingsPass gets lwexpo and lwexpo delegate", async () => {
  const grace = (await api("POST", "/expo/auth/kingschat", { body: { code: "second-code" } })).json;
  const token = grace.accessToken;
  // An account from before the question, with a zone and church: counted as a member.
  let me = (await api("GET", "/expo/me", { token })).json.user;
  assert.equal(me.christEmbassy, true);
  assert.equal(me.profileComplete, true);
  // A member who empties their church isn't complete; saying they aren't a member makes it complete.
  me = (await api("PATCH", "/expo/me", { token, body: { zone: "", church: "" } })).json.user;
  assert.equal(me.profileComplete, false);
  assert.equal((await api("PATCH", "/expo/me", { token, body: { christEmbassy: "no" } })).json.error, "bad_membership");
  me = (await api("PATCH", "/expo/me", { token, body: { christEmbassy: false } })).json.user;
  assert.deepEqual([me.christEmbassy, me.profileComplete, me.zone, me.church], [false, true, "", null]);

  // Their pass: nothing stored for zone or church; KingsPass gets the placeholders.
  const bought = await api("POST", "/expo/passes/checkout", { token, body: { pass: "day", days: ["2026-11-13"], expectedPrice: 10, payment: { method: "wallet", username: "grace_o", pin: "1234" } } });
  assert.equal(bought.status, 201, JSON.stringify(bought.json));
  await new Promise((ok) => setTimeout(ok, 250));
  const reg = (await api("POST", `/expo/passes/${bought.json.registration.id}/confirm`, { token })).json.registration;
  assert.equal(reg.status, "confirmed");
  assert.deepEqual([reg.zone, reg.church], ["", ""]);
  assert.deepEqual([kingspass.at(-1).fields.zone, kingspass.at(-1).fields.church], ["lwexpo", "lwexpo delegate"]);

  // They can still give a zone and church on their profile; then those go to KingsPass.
  me = (await api("PATCH", "/expo/me", { token, body: { zone: "Abuja Zone", church: "Christ Embassy Wuse" } })).json.user;
  assert.deepEqual([me.christEmbassy, me.profileComplete, me.zone, me.church], [false, true, "Abuja Zone", "Christ Embassy Wuse"]);
  // A member must give both.
  me = (await api("PATCH", "/expo/me", { token, body: { christEmbassy: true, church: "" } })).json.user;
  assert.equal(me.profileComplete, false);
});
