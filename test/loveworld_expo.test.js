// The LoveWorld Expo service (routes/loveworld_expo.js) against a local Postgres and a
// stand-in for KingsChat. Run: node --test test/loveworld_expo.test.js
// (EXPO_TEST_DATABASE_URL picks the database; it is created, and dropped after.)
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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
      if (!["good-code", "second-code", "third-code", "rita-code"].includes(code) && !/^extra-\d+$/.test(code)) { res.statusCode = 400; return res.end("{}"); }
      return res.end(JSON.stringify({ access_token: `kc-${code}`, refresh_token: "kc-refresh" }));
    }
    if (req.url === "/profile") {
      const auth = req.headers.authorization || "";
      if (!/^Bearer kc-/.test(auth)) { res.statusCode = 401; return res.end("{}"); }
      const extra = auth.match(/^Bearer kc-extra-(\d+)$/);
      if (extra) return res.end(JSON.stringify({ profile: { id: `kc-extra-${extra[1]}`, name: `Extra ${extra[1]}`, username: `extra_${extra[1]}`, email: `extra${extra[1]}@example.com` } }));
      if (auth === "Bearer kc-rita-code") return res.end(JSON.stringify({ profile: { id: "kc-rita", name: "Rita", username: "PastorRita", email: "rita@example.com" } }));
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

/** A stand-in MP4 `seconds` long: just the boxes its length is read from (ftyp, then moov with its mvhd after the media). */
function fakeMp4(seconds) {
  const box = (type, body) => { const head = Buffer.alloc(8); head.writeUInt32BE(8 + body.length); head.write(type, 4, "latin1"); return Buffer.concat([head, body]); };
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(seconds * 1000, 16);
  return Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isom")), box("mdat", Buffer.alloc(64, 7)), box("moov", box("mvhd", mvhd))]);
}
// Where the officials' training video plays from (CloudFront, for real): /video.mp4 in ranges, as a CDN
// sends it; /no-ranges.mp4 always whole (videoWholeSends counts those); anything else 404.
const trainingVideo = fakeMp4(120);
let videoWholeSends = 0;
const videos = http.createServer((req, res) => {
  if (req.url === "/no-ranges.mp4") { videoWholeSends++; res.setHeader("content-type", "video/mp4"); return res.end(trainingVideo); }
  if (req.url !== "/video.mp4") { res.statusCode = 404; return res.end(); }
  const m = (req.headers.range || "").match(/^bytes=(\d+)-(\d+)$/);
  if (!m) { res.setHeader("content-type", "video/mp4"); return res.end(trainingVideo); }
  const from = Number(m[1]);
  const to = Math.min(Number(m[2]), trainingVideo.length - 1);
  res.writeHead(206, { "content-type": "video/mp4", "content-range": `bytes ${from}-${to}/${trainingVideo.length}` });
  res.end(trainingVideo.subarray(from, to + 1));
});

/** Waits until the stand-in KingsChat has been sent `n` messages in all (they go in the background). */
async function messagesSoFar(n) {
  for (let i = 0; i < 100 && kcMessages.length < n; i++) await new Promise((r) => setTimeout(r, 30));
  return kcMessages;
}

let base, server, routes;
// Where the service keeps ad artwork files in these tests: made fresh, removed after.
const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), "expo-ad-files-"));
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
  await new Promise((r) => videos.listen(0, "127.0.0.1", r));
  const kc = `http://127.0.0.1:${kingschat.address().port}`;
  const pay = `http://127.0.0.1:${espees.address().port}`;
  Object.assign(process.env, {
    EXPO_SKIP_ENV_FILE: "1", LOVEWORLD_EXPO_DATABASE_URL: DB_URL, EXPO_KC_CLIENT_ID: "test-client", EXPO_KC_TOKEN_URL: `${kc}/token`, EXPO_KC_PROFILE_URL: `${kc}/profile`,
    EXPO_API_KEY: "app-key", EXPO_ADMIN_KEY: "admin-key", EXPO_SITE_URL: "http://localhost:3000", EXPO_MAX_BOOKINGS_PER_DAY: "2",
    EXPO_KC_API_KEY: "kc-project-key", EXPO_KC_MESSAGES_URL: `${kc}/messages`,
    EXPO_ESPEES_API_TOKEN: "esp-test-token", EXPO_ESPEES_URL: pay,
    EXPO_KINGSPASS_URL: `http://127.0.0.1:${kingspassServer.address().port}`, EXPO_KINGSPASS_EVENT_TOKEN: "event-token", EXPO_KINGSPASS_TEST2_TICKET: "2599",
    EXPO_AD_FILES_DIR: filesDir,
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
  videos.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
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

test("@pastorrita is made an admin as she signs in; nobody else is", async () => {
  const rita = (await api("POST", "/expo/auth/kingschat", { body: { code: "rita-code" } })).json;
  assert.equal(rita.created, true);
  assert.equal(rita.user.admin, true, "her first sign-in makes her an admin");
  assert.equal((await api("GET", "/expo/me", { token: rita.accessToken })).json.user.admin, true);
  // Signing in again keeps it.
  assert.equal((await api("POST", "/expo/auth/kingschat", { body: { code: "rita-code" } })).json.user.admin, true);
  // Anyone else signing in is not.
  assert.equal((await api("POST", "/expo/auth/kingschat", { body: { code: "third-code" } })).json.user.admin, false);
});

test("ad spaces: proposed, approved with a payment link, paid in Espees; the owner told on KingsChat at every step", async () => {
  const admin = { "x-admin-key": "admin-key" };
  const signIn = async (code) => (await api("POST", "/expo/auth/kingschat", { body: { code } })).json.accessToken;
  const [ade, grace, rita, tolu] = [await signIn("good-code"), await signIn("second-code"), await signIn("rita-code"), await signIn("third-code")];
  const n0 = kcMessages.length;
  const told = (ref) => kcMessages.slice(n0).map((m) => m.message.body.text.body).filter((t) => t.includes(ref));
  const eventually = async (check) => { for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 30)); return check(); };
  const propose = (body, t = ade) => api("POST", "/expo/advertising/proposals", { token: t, body: { title: "Ade's Bakery", description: "Fresh bread daily", ...body } });
  const step = (id, action, body = {}) => api("POST", `/expo/admin/advertising/${id}/${action}`, { headers: admin, body });
  const stored = async (sql, params) => {
    const db = new Client({ connectionString: DB_URL });
    await db.connect();
    const rows = (await db.query(sql, params)).rows;
    await db.end();
    return rows;
  };

  // The spaces as they start; signed out, nothing is held. The video advert has no limit.
  let spaces = (await api("GET", "/expo/advertising/spaces", { token: ade })).json.spaces;
  assert.deepEqual(spaces.map((s) => [s.id, s.kind, s.price, s.spots, s.remaining, s.perProduct, s.held]), [
    ["lampposts", "print", 300, 31, 31, 2, []], ["walkway-banners", "print", 1200, 29, 29, 5, []], ["amphitheatre", "print", 3000, 36, 25, 4, []],
    ["light-boxes", "print", 1500, 171, 70, 4, []], ["video", "video", 2000, null, null, null, []],
  ]);
  // Walkway banners come in three sizes, each at its own price; the others in one (sizes null).
  assert.deepEqual(spaces[1].sizes, [
    { id: "4x2.5", size: "4 m wide × 2.5 m high", price: 1500 },
    { id: "2.5x2.5", size: "2.5 m wide × 2.5 m high", price: 1200 },
    { id: "2x2.5", size: "2 m wide × 2.5 m high", price: 1200 },
  ]);
  assert.equal(spaces[0].sizes, null);
  // 101 light boxes and 11 Amphitheatre spaces are already gone outside the site: they count as taken.
  assert.deepEqual(spaces.filter((s) => s.taken).map((s) => [s.id, s.taken]), [["amphitheatre", 11], ["light-boxes", 101]]);
  assert.equal((await api("GET", "/expo/advertising/spaces")).json.spaces[0].held, null);

  // Refused before anything is kept.
  assert.equal((await api("POST", "/expo/advertising/proposals", { body: { space: "lampposts", title: "x", description: "y" } })).status, 401);
  assert.equal((await propose({ space: "billboards" })).json.error, "bad_space");
  assert.equal((await propose({ space: "toString" })).json.error, "bad_space");
  assert.equal((await propose({ space: "lampposts", title: "" })).json.error, "missing_fields");
  assert.equal((await propose({ space: "lampposts", quantity: 0 })).json.error, "bad_quantity");
  assert.equal((await propose({ space: "lampposts", quantity: 1.5 })).json.error, "bad_quantity");
  assert.equal((await propose({ space: "lampposts", expectedPrice: 20 })).json.error, "price_changed");
  assert.equal((await propose({ space: "lampposts", quantity: 3 })).json.error, "over_limit");
  // A space in sizes needs one of its own.
  assert.equal((await propose({ space: "walkway-banners" })).json.error, "bad_size");
  assert.equal((await propose({ space: "walkway-banners", size: "5x5" })).json.error, "bad_size");
  assert.equal((await propose({ space: "walkway-banners", size: "toString" })).json.error, "bad_size");
  assert.equal((await propose({ space: "walkway-banners", size: "4x2.5", expectedPrice: 1200 })).json.error, "price_changed");

  // Submitted: pending, at the space's price, nothing charged, and the owner told it's in.
  const charges = espeesCharges.length;
  const p = await propose({ space: "lampposts", quantity: 1, expectedPrice: 300 });
  assert.equal(p.status, 201, JSON.stringify(p.json));
  const ad = p.json.proposal;
  assert.deepEqual([ad.status, ad.quantity, ad.unitPrice, ad.total, ad.spaceName, ad.payUrl], ["pending", 1, 300, 300, "Main Road Lamp Posts", null]);
  assert.match(ad.reference, /^AD-/);
  assert.equal(espeesCharges.length, charges);
  assert.ok(await eventually(() => told(ad.reference).length === 1));
  assert.match(told(ad.reference)[0], /proposal received/);
  assert.match(told(ad.reference)[0], /1 × Main Road Lamp Posts/);

  // A proposal being reviewed counts toward its product's limit (2), not the space's spots: the same
  // title, however it's spaced or capitalised.
  const over = await propose({ space: "lampposts", quantity: 2 });
  assert.deepEqual([over.status, over.json.error], [409, "over_limit"]);
  assert.match(over.json.message, /ask for 1 more/);
  assert.equal((await propose({ space: "lampposts", quantity: 2, title: "  ade's   BAKERY " })).json.error, "over_limit");
  spaces = (await api("GET", "/expo/advertising/spaces", { token: ade })).json.spaces;
  assert.deepEqual([spaces[0].remaining, spaces[0].held], [31, [{ title: "Ade's Bakery", quantity: 1 }]]);

  // Artwork: images only (told by their content), the owner's own, while it's being reviewed.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  const art = (data, t = ade) => api("POST", `/expo/advertising/proposals/${ad.id}/artwork`, { token: t, body: { name: "design.png", data } });
  assert.equal((await art(Buffer.from("not an image").toString("base64"))).json.error, "bad_type");
  assert.equal((await art(png.toString("base64"), grace)).status, 404);
  const up = await art(png.toString("base64"));
  assert.equal(up.status, 201);
  assert.deepEqual([up.json.artwork.type, up.json.artwork.size], ["image/png", png.length]);

  // The admin sees it with the account and the artwork, and can open the image.
  assert.equal((await api("GET", "/expo/admin/advertising")).status, 401);
  const listed = (await api("GET", "/expo/admin/advertising?status=pending", { headers: admin })).json.proposals.find((x) => x.id === ad.id);
  assert.equal(listed.user.username, "pastor_ade");
  assert.equal(listed.artwork.length, 1);
  const img = await fetch(`${base}/expo/admin/advertising/artwork/${listed.artwork[0].id}`, { headers: admin });
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);

  // Approved: the spots are held, a payment link is made and sent to the owner on KingsChat.
  const approved = await step(ad.id, "approve", { note: "Lovely design" });
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  const payUrl = approved.json.proposal.payUrl;
  assert.match(payUrl, /^http:\/\/localhost:3000\/advertise\/pay\?link=[\w-]{32}$/);
  const link = payUrl.split("link=").pop();
  assert.ok(await eventually(() => told(ad.reference).some((t) => t.includes("is approved") && t.includes(`Pay 300 Espees here: ${payUrl}`) && t.includes("Note: Lovely design") && t.includes("Print file: a print-ready PDF at 0.76 m wide × 2.01 m high, full size, with images at 150 dpi (ppi), by Wednesday 4 November, 3pm (GMT+1)."))));
  assert.equal((await step(ad.id, "approve")).json.error, "not_pending");
  assert.equal((await art(png.toString("base64"))).json.error, "not_pending");
  assert.equal((await api("GET", "/expo/advertising/spaces")).json.spaces[0].remaining, 30);

  // The link shows the ad and what's owed to whoever has it, and nothing about the account.
  const view = await api("GET", `/expo/advertising/pay/${link}`);
  assert.deepEqual([view.json.proposal.total, view.json.proposal.status, view.json.proposal.title], [300, "approved", "Ade's Bakery"]);
  assert.ok(!JSON.stringify(view.json).includes("pastor_ade"));
  assert.equal((await api("GET", "/expo/advertising/pay/not-a-link")).status, 404);

  // Espees refuses first (nothing taken, it can be tried again), then it's paid from a card.
  const pay = (payment, body = {}) => api("POST", `/expo/advertising/pay/${link}`, { body: { payment, ...body } });
  assert.equal((await pay({ method: "wallet", username: "ade" })).json.error, "missing_payment");
  assert.equal((await pay({ method: "wallet", username: "ade", pin: "1234" }, { expectedTotal: 50 })).json.error, "price_changed");
  espeesRefuse = "Insufficient balance";
  const no = await pay({ method: "wallet", username: "ade", pin: "1234" });
  assert.deepEqual([no.status, no.json.error, no.json.message], [402, "payment_declined", "Insufficient balance"]);
  assert.equal((await api("GET", `/expo/advertising/pay/${link}`)).json.proposal.paymentError, "Insufficient balance");
  const paid = await pay({ method: "card", cardNum: "5399 1234 5678 9012", pin: "4321" }, { expectedTotal: 300 });
  assert.equal(paid.status, 201, JSON.stringify(paid.json));
  assert.equal(paid.json.proposal.paymentStatus, "CHARGED");
  assert.deepEqual(espeesCharges.at(-1).body, { cardNum: "5399123456789012", pin: "4321", amount: "300" });
  // Paying again while it's with Espees (or once paid) isn't charged.
  const again = await pay({ method: "card", cardNum: "5399123456789012", pin: "4321" });
  assert.ok(["payment_in_progress", "already_paid"].includes(again.json.error), again.json.error);
  assert.equal(espeesCharges.length, charges + 1);
  assert.ok(await eventually(() => told(ad.reference).some((t) => t.includes("Payment received"))));
  const done = (await api("POST", `/expo/advertising/pay/${link}/confirm`)).json.proposal;
  assert.deepEqual([done.status, done.paymentStatus], ["paid", "PAID"]);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(told(ad.reference).filter((t) => t.includes("Payment received")).length, 1, "told once");
  assert.match(told(ad.reference).find((t) => t.includes("Payment received")), /Paid: 300 Espees/);
  // The PIN and the whole card number went to Espees and nowhere else.
  const row = JSON.stringify(await stored(`SELECT * FROM ad_proposals WHERE id = $1`, [ad.id]));
  assert.ok(!row.includes("4321") && !row.includes("5399123456789012"));
  assert.deepEqual((await stored(`SELECT kind FROM notifications WHERE ad_id = $1 ORDER BY id`, [ad.id])).map((n) => n.kind), ["ad:submitted", "ad:approved", "ad:paid"]);
  const mine = (await api("GET", "/expo/advertising/proposals", { token: ade })).json;
  assert.deepEqual(mine.proposals.map((x) => [x.reference, x.status, x.payer, x.payUrl, x.artwork.length]), [[ad.reference, "paid", "card ****9012", payUrl, 1]]);
  // Paid: it can't be cancelled or turned down.
  assert.equal((await api("POST", `/expo/advertising/proposals/${ad.id}/cancel`, { token: ade })).json.error, "not_cancellable");
  assert.equal((await step(ad.id, "reject", { reason: "x" })).json.error, "not_rejectable");

  // Turned down with a reason, which the owner is told; that frees their limit again. The limit is the
  // product's: the same account can still propose another product (withdrawn here, so it holds none).
  const g = (await propose({ space: "walkway-banners", size: "4x2.5", quantity: 5, title: "Grace Fashion", expectedPrice: 1500 }, grace)).json.proposal;
  assert.deepEqual([g.size, g.sizeId, g.unitPrice, g.total], ["4 m wide × 2.5 m high", "4x2.5", 1500, 7500]);
  assert.ok(await eventually(() => told(g.reference).some((t) => t.includes("5 × Walkway Banners, 4 m wide × 2.5 m high"))));
  // The limit is for all the sizes together.
  assert.equal((await propose({ space: "walkway-banners", size: "2x2.5", quantity: 1, title: "Grace Fashion" }, grace)).json.error, "over_limit");
  const shoes = await propose({ space: "walkway-banners", size: "2x2.5", quantity: 1, title: "Grace Shoes", expectedPrice: 1200 }, grace);
  assert.equal(shoes.status, 201, JSON.stringify(shoes.json));
  assert.deepEqual([shoes.json.proposal.size, shoes.json.proposal.unitPrice], ["2 m wide × 2.5 m high", 1200]);
  assert.deepEqual((await stored(`SELECT size, unit_price::float AS price FROM ad_proposals WHERE id = $1`, [shoes.json.proposal.id]))[0], { size: "2x2.5", price: 1200 });
  assert.equal((await api("POST", `/expo/advertising/proposals/${shoes.json.proposal.id}/cancel`, { token: grace })).json.proposal.status, "cancelled");
  assert.equal((await step(g.id, "reject")).json.error, "missing_reason");
  assert.equal((await step(g.id, "reject", { reason: "The artwork is missing" })).json.proposal.status, "rejected");
  assert.ok(await eventually(() => told(g.reference).some((t) => t.includes("wasn't approved") && t.includes("Reason: The artwork is missing"))));
  // Withdrawn by its owner (only theirs), and they're told.
  const g2 = (await propose({ space: "walkway-banners", size: "2.5x2.5", quantity: 5, title: "Grace Fashion" }, grace)).json.proposal;
  assert.equal((await api("POST", `/expo/advertising/proposals/${g2.id}/cancel`, { token: ade })).status, 404);
  assert.equal((await api("POST", `/expo/advertising/proposals/${g2.id}/cancel`, { token: grace })).json.proposal.status, "cancelled");
  assert.ok(await eventually(() => told(g2.reference).some((t) => t.includes("is cancelled") && t.includes("You cancelled it"))));

  // Approvals take spots: 29 walkway banners in all their sizes, five accounts' 5 each approved leave
  // 4, which Tolu's 4 then take, so his last one can't be approved, and no new one for more than is
  // left is taken, whatever its size.
  const [extra1, extra2] = [await signIn("extra-1"), await signIn("extra-2")];
  const ids = [];
  for (const [t, title, size] of [[grace, "Grace Fashion", "4x2.5"], [ade, "Ade's Bakery", "2.5x2.5"], [extra1, "Extra One", "2x2.5"], [extra2, "Extra Two", "4x2.5"], [rita, "Rita's Books", "2x2.5"]]) {
    const x = (await propose({ space: "walkway-banners", size, quantity: 5, title }, t)).json.proposal;
    ids.push(x);
  }
  const t2 = (await propose({ space: "walkway-banners", size: "2.5x2.5", quantity: 4, title: "Tolu Tech" }, tolu)).json.proposal;
  const t3 = (await propose({ space: "walkway-banners", size: "4x2.5", quantity: 1, title: "Tolu Tech" }, tolu)).json.proposal;
  for (const x of ids) assert.equal((await step(x.id, "approve")).json.proposal.status, "approved");
  assert.equal((await step(t2.id, "approve")).json.proposal.status, "approved");
  const full = await step(t3.id, "approve");
  assert.deepEqual([full.status, full.json.error], [409, "not_enough_spaces"]);
  assert.equal((await propose({ space: "walkway-banners", size: "2x2.5", quantity: 1 }, await signIn("extra-3"))).json.error, "not_enough_spaces");
  // An approved one cancelled by the team gives its spots back.
  assert.equal((await step(t2.id, "cancel", { reason: "Duplicate" })).json.proposal.status, "cancelled");
  assert.ok(await eventually(() => told(t2.reference).some((t) => t.includes("The Expo team cancelled it") && t.includes("Note: Duplicate"))));
  assert.equal((await step(t3.id, "approve")).json.proposal.status, "approved");

  // No clear answer from Espees: kept for the team, not paid again; once checked, opened for payment
  // again, or marked paid by hand (and the owner told).
  const rl = (await api("GET", "/expo/advertising/proposals", { token: rita })).json.proposals[0];
  const ritaLink = rl.payUrl.split("link=").pop();
  espeesBroken = true;
  const unclear = await api("POST", `/expo/advertising/pay/${ritaLink}`, { body: { payment: { method: "wallet", username: "rita", pin: "9999" } } });
  espeesBroken = false;
  assert.deepEqual([unclear.status, unclear.json.error], [502, "payment_unknown"]);
  assert.equal((await api("POST", `/expo/advertising/pay/${ritaLink}`, { body: { payment: { method: "wallet", username: "rita", pin: "9999" } } })).json.error, "payment_in_progress");
  assert.equal((await api("POST", `/expo/advertising/proposals/${rl.id}/cancel`, { token: rita })).json.error, "not_cancellable");
  assert.equal((await step(rl.id, "reopen")).json.proposal.paymentStatus, null);
  assert.equal((await step(rl.id, "reopen")).json.error, "not_reopenable");
  const marked = await step(rl.id, "paid");
  assert.deepEqual([marked.json.proposal.status, marked.json.proposal.paymentStatus], ["paid", "MARKED_PAID"]);
  assert.ok(await eventually(() => told(rl.reference).some((t) => t.includes("Payment received") && t.includes("Print file: a print-ready PDF at 2 m wide × 2.5 m high, full size, with images at 100 dpi (ppi)"))));
  assert.equal((await api("GET", "/expo/advertising/spaces")).json.spaces[1].remaining, 3);

  // The test space, 0.001 Espees a space, for admins only: hidden from everyone else and refused them.
  const spaceIds = async (t) => (await api("GET", "/expo/advertising/spaces", t ? { token: t } : {})).json.spaces.map((s) => s.id);
  assert.deepEqual(await spaceIds(tolu), ["lampposts", "walkway-banners", "amphitheatre", "light-boxes", "video"]);
  assert.deepEqual(await spaceIds(null), ["lampposts", "walkway-banners", "amphitheatre", "light-boxes", "video"]);
  assert.deepEqual(await spaceIds(rita), ["lampposts", "walkway-banners", "amphitheatre", "light-boxes", "video", "test"]);
  assert.equal((await propose({ space: "test", title: "Tolu test" }, tolu)).json.error, "bad_space");
  const tp = (await propose({ space: "test", quantity: 3, title: "Rita's test", expectedPrice: 0.001 }, rita)).json.proposal;
  assert.deepEqual([tp.unitPrice, tp.total], [0.001, 0.003]);
  const testLink = (await step(tp.id, "approve")).json.proposal.payUrl.split("link=").pop();
  const testPaid = await api("POST", `/expo/advertising/pay/${testLink}`, { body: { payment: { method: "wallet", username: "rita", pin: "1111" }, expectedTotal: 0.003 } });
  assert.equal(testPaid.status, 201, JSON.stringify(testPaid.json));
  assert.equal(espeesCharges.at(-1).body.espeesAmount, 0.003);
  assert.ok(await eventually(() => told(tp.reference).some((t) => t.includes("Payment received") && t.includes("Paid: 0.003 Espees"))));
  assert.ok((await api("GET", "/expo/admin/advertising", { headers: admin })).json.spaces.some((s) => s.id === "test" && s.adminOnly));
});

test("ad spaces: a proposal or an image sent again with the same key gives back the one already made", async () => {
  const tolu = (await api("POST", "/expo/auth/kingschat", { body: { code: "third-code" } })).json.accessToken;
  const n0 = kcMessages.length;
  const propose = (body) => api("POST", "/expo/advertising/proposals", { token: tolu, body: { space: "lampposts", quantity: 2, title: "Tolu Tech", description: "Gadgets", ...body } });

  // Sent again after a dropped connection: the same proposal, though it fills the account's limit.
  const first = await propose({ key: "proposal-key-0001" });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const again = await propose({ key: "proposal-key-0001" });
  assert.deepEqual([again.status, again.json.repeated, again.json.proposal.id], [200, true, first.json.proposal.id]);
  // Another key is another proposal (refused here: the account holds its 2); a bad key is no key.
  assert.equal((await propose({ quantity: 1, key: "proposal-key-0002" })).json.error, "over_limit");
  assert.equal((await propose({ quantity: 1, key: "no" })).json.error, "over_limit");
  // One message, for the one proposal.
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(kcMessages.slice(n0).filter((m) => m.message.body.text.body.includes(first.json.proposal.reference)).length, 1);

  // An image sent twice with the same key is stored once.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
  const art = (key) => api("POST", `/expo/advertising/proposals/${first.json.proposal.id}/artwork`, { token: tolu, body: { name: "a.png", data: png.toString("base64"), key } });
  const a1 = await art("image-key-0001");
  assert.equal(a1.status, 201);
  const a2 = await art("image-key-0001");
  assert.deepEqual([a2.status, a2.json.repeated, a2.json.artwork.id], [200, true, a1.json.artwork.id]);
  assert.equal((await art("image-key-0002")).status, 201);
  const mine = (await api("GET", "/expo/advertising/proposals", { token: tolu })).json.proposals.find((p) => p.id === first.json.proposal.id);
  assert.equal(mine.artwork.length, 2);
});

test("ad spaces: artwork files up to 200 MB, sent in pieces and kept on disk; a link to the artwork as well", async () => {
  const admin = { "x-admin-key": "admin-key" };
  const MB = 1024 * 1024;
  const me = (await api("POST", "/expo/auth/kingschat", { body: { code: "extra-81" } })).json.accessToken;
  // Someone else: an account other tests make (this test adds only the one it deletes at the end).
  const other = (await api("POST", "/expo/auth/kingschat", { body: { code: "third-code" } })).json.accessToken;
  const propose = (body) => api("POST", "/expo/advertising/proposals", { token: me, body: { space: "lampposts", quantity: 1, title: "Big Files Ltd", description: "Print-ready artwork", ...body } });

  // A link to the artwork (KingsCloud, Google Drive…) is a web address.
  assert.equal((await propose({ artworkUrl: "my google drive" })).json.error, "bad_artwork_link");
  const made = await propose({ artworkUrl: "https://drive.google.com/file/d/abc/view" });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const ad = made.json.proposal;
  assert.equal(ad.artworkUrl, "https://drive.google.com/file/d/abc/view");

  const files = (body, t = me) => api("POST", `/expo/advertising/proposals/${ad.id}/files`, { token: t, body });
  const put = async (fileId, offset, bytes, t = me) => {
    const res = await fetch(`${base}/expo/advertising/proposals/${ad.id}/files/${fileId}?offset=${offset}`, {
      method: "PUT", headers: { "content-type": "application/octet-stream", "x-api-key": "app-key", authorization: `Bearer ${t}` }, body: bytes,
    });
    return { status: res.status, json: await res.json() };
  };
  const listed = async () => (await api("GET", "/expo/admin/advertising", { headers: admin })).json.proposals.find((x) => x.id === ad.id);

  // Up to 200 MB, its size said first; only to the person's own proposal.
  assert.deepEqual([(await files({ name: "huge.pdf", size: 200 * MB + 1 })).status, (await files({ name: "huge.pdf", size: 200 * MB + 1 })).json.error], [413, "too_large"]);
  assert.equal((await files({ name: "none.pdf", size: 0 })).json.error, "bad_size");
  assert.equal((await files({ name: "x.pdf", size: 10 }, other)).status, 404);

  // A 3 MB PDF in three pieces.
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), crypto.randomBytes(3 * MB - 9)]);
  const started = await files({ name: "Banner print.pdf", size: pdf.length, key: "file-key-0001" });
  assert.equal(started.status, 201, JSON.stringify(started.json));
  assert.deepEqual([started.json.received, started.json.chunkMax, started.json.artwork.complete, started.json.artwork.preview], [0, 8 * MB, false, false]);
  const id = started.json.artwork.id;
  let r = await put(id, 0, pdf.subarray(0, MB));
  assert.deepEqual([r.status, r.json.received, r.json.complete], [200, MB, false], JSON.stringify(r.json));
  // The same piece again (its answer lost on the way back) is taken, not written twice; one past a gap
  // is refused with where to carry on from; someone else can't add to it.
  r = await put(id, 0, pdf.subarray(0, MB));
  assert.deepEqual([r.status, r.json.received], [200, MB]);
  r = await put(id, 2 * MB, pdf.subarray(2 * MB));
  assert.deepEqual([r.status, r.json.error, r.json.received], [409, "bad_offset", MB]);
  assert.equal((await put(id, MB, pdf.subarray(MB, 2 * MB), other)).status, 404);
  // Started again with the same key (the page sending it again): the same file, and how far it got.
  const resumed = await files({ name: "Banner print.pdf", size: pdf.length, key: "file-key-0001" });
  assert.deepEqual([resumed.status, resumed.json.repeated, resumed.json.artwork.id, resumed.json.received], [200, true, id, MB]);
  assert.equal((await put(id, MB, pdf.subarray(MB, 2 * MB))).json.received, 2 * MB);
  // Longer than it said it was: refused. Then the rest.
  assert.equal((await put(id, 2 * MB, Buffer.concat([pdf.subarray(2 * MB), Buffer.alloc(5)]))).json.error, "too_long");
  r = await put(id, 2 * MB, pdf.subarray(2 * MB));
  assert.deepEqual([r.json.received, r.json.complete, r.json.artwork.type, r.json.artwork.size], [pdf.length, true, "application/pdf", pdf.length]);

  // Kept whole on disk; the admin sees it with the link and downloads it as it was sent. A PDF has no review copy.
  assert.ok(fs.readFileSync(path.join(filesDir, id)).equals(pdf));
  const seen = await listed();
  assert.equal(seen.artworkUrl, "https://drive.google.com/file/d/abc/view");
  assert.deepEqual(seen.artwork.map((a) => [a.name, a.type, a.size, a.complete, a.preview]), [["Banner print.pdf", "application/pdf", pdf.length, true, false]]);
  const dl = await fetch(`${base}/expo/admin/advertising/artwork/${id}/file`, { headers: admin });
  assert.deepEqual([dl.status, dl.headers.get("content-type"), dl.headers.get("content-disposition"), dl.headers.get("content-length")],
    [200, "application/pdf", 'attachment; filename="Banner_print.pdf"', String(pdf.length)]);
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(pdf));
  assert.equal((await fetch(`${base}/expo/admin/advertising/artwork/${id}`, { headers: admin })).status, 404);
  // A piece sent signed out is refused.
  assert.equal((await fetch(`${base}/expo/advertising/proposals/${ad.id}/files/${id}?offset=0`, { method: "PUT", headers: { "content-type": "application/octet-stream", "x-api-key": "app-key" }, body: pdf.subarray(0, 10) })).status, 401);

  // An image (TIFF) with its review copy for the team to look at.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
  const tiff = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), crypto.randomBytes(5000)]);
  const t1 = await files({ name: "poster.tif", size: tiff.length, preview: png.toString("base64") });
  assert.equal(t1.json.artwork.preview, true);
  r = await put(t1.json.artwork.id, 0, tiff);
  assert.deepEqual([r.json.complete, r.json.artwork.type], [true, "image/tiff"]);
  assert.equal((await fetch(`${base}/expo/admin/advertising/artwork/${t1.json.artwork.id}`, { headers: admin })).headers.get("content-type"), "image/png");
  assert.equal((await files({ name: "bad.tif", size: 10, preview: Buffer.from("not an image").toString("base64") })).json.error, "bad_preview");
  // A file that isn't artwork is refused at its first piece.
  const exe = await files({ name: "setup.exe", size: 100 });
  assert.equal((await put(exe.json.artwork.id, 0, Buffer.from("MZ" + "x".repeat(98)))).json.error, "bad_type");
  // One left partway: the admin sees how far it got, and it can't be downloaded yet.
  const half = await files({ name: "half.pdf", size: 2 * MB });
  await put(half.json.artwork.id, 0, pdf.subarray(0, MB));
  const partway = (await listed()).artwork.find((a) => a.id === half.json.artwork.id);
  assert.deepEqual([partway.complete, partway.received, partway.size], [false, MB, 2 * MB]);
  const early = await fetch(`${base}/expo/admin/advertising/artwork/${half.json.artwork.id}/file`, { headers: admin });
  assert.deepEqual([early.status, (await early.json()).error], [409, "not_complete"]);

  // Six to a proposal, files and images together.
  assert.equal((await files({ name: "5.pdf", size: 10 })).status, 201);
  assert.equal((await files({ name: "6.pdf", size: 10 })).status, 201);
  assert.equal((await files({ name: "7.pdf", size: 10 })).json.error, "too_many");
  // Not once the proposal has been looked at.
  await api("POST", `/expo/admin/advertising/${ad.id}/reject`, { headers: admin, body: { reason: "Too big" } });
  assert.equal((await files({ name: "late.pdf", size: 10 })).json.error, "not_pending");

  // The account deleted: its artwork files go from disk.
  const meId = (await api("GET", "/expo/me", { token: me })).json.user.id;
  const gone = await api("DELETE", `/expo/admin/users/${meId}`, { headers: admin });
  assert.equal(gone.status, 200, JSON.stringify(gone.json));
  assert.equal(gone.json.removed.artworkFiles, 6);
  assert.deepEqual([fs.existsSync(path.join(filesDir, id)), fs.existsSync(path.join(filesDir, t1.json.artwork.id))], [false, false]);
});

test("ad spaces: a video advert is one video, given as a link, with no limit", async () => {
  const admin = { "x-admin-key": "admin-key" };
  const grace = (await api("POST", "/expo/auth/kingschat", { body: { code: "second-code" } })).json.accessToken;
  const n0 = kcMessages.length;
  const told = (ref) => kcMessages.slice(n0).map((m) => m.message.body.text.body).filter((t) => t.includes(ref));
  const eventually = async (check) => { for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 30)); return check(); };
  const propose = (body) => api("POST", "/expo/advertising/proposals", { token: grace, body: { space: "video", title: "Grace Fashion", description: "The new collection", videoUrl: "https://drive.example.com/grace.mp4", ...body } });

  // A web address to download it from, and one video to a proposal.
  assert.equal((await propose({ videoUrl: "" })).json.error, "bad_video_link");
  assert.equal((await propose({ videoUrl: "grace.mp4" })).json.error, "bad_video_link");
  assert.equal((await propose({ videoUrl: "javascript:alert(1)" })).json.error, "bad_video_link");
  assert.equal((await propose({ quantity: 2 })).json.error, "bad_quantity");
  assert.equal((await propose({ expectedPrice: 200 })).json.error, "price_changed");

  // No limit for a product, nor in all: five for the same one are all taken, and approved.
  const made = [];
  for (let i = 0; i < 5; i++) {
    const p = await propose({ expectedPrice: 2000 });
    assert.equal(p.status, 201, JSON.stringify(p.json));
    made.push(p.json.proposal);
  }
  assert.deepEqual([made[0].spaceName, made[0].quantity, made[0].total, made[0].videoUrl], ["Video Advert", 1, 2000, "https://drive.example.com/grace.mp4"]);
  const approved = await api("POST", `/expo/admin/advertising/${made[0].id}/approve`, { headers: admin, body: {} });
  assert.equal(approved.json.proposal.status, "approved", JSON.stringify(approved.json));
  const space = (await api("GET", "/expo/advertising/spaces", { token: grace })).json.spaces.find((s) => s.id === "video");
  assert.deepEqual([space.spots, space.remaining, space.perProduct, space.held], [null, null, null, [{ title: "Grace Fashion", quantity: 5 }]]);

  // The admin sees the link; the owner is told with it, and nothing about print.
  const listed = (await api("GET", "/expo/admin/advertising", { headers: admin })).json.proposals.find((x) => x.id === made[0].id);
  assert.equal(listed.videoUrl, "https://drive.example.com/grace.mp4");
  assert.ok(await eventually(() => told(made[0].reference).some((t) => t.includes("is approved"))));
  const approvedText = told(made[0].reference).find((t) => t.includes("is approved"));
  assert.match(approvedText, /Video: https:\/\/drive\.example\.com\/grace\.mp4/);
  assert.doesNotMatch(approvedText, /Print artwork|spaces are held/);
});

test("ad spaces: a sponsor's proposal booked free, with nothing to pay", async () => {
  const admin = { "x-admin-key": "admin-key" };
  const ade = (await api("POST", "/expo/auth/kingschat", { body: { code: "good-code" } })).json.accessToken;
  const n0 = kcMessages.length;
  const told = (ref) => kcMessages.slice(n0).map((m) => m.message.body.text.body).filter((t) => t.includes(ref));
  const eventually = async (check) => { for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 30)); return check(); };
  const propose = (body) => api("POST", "/expo/advertising/proposals", { token: ade, body: { space: "amphitheatre", quantity: 2, title: "Ade's Diamond Sponsorship", description: "Sponsor's complimentary spaces", ...body } });
  const step = (id, action, body = {}) => api("POST", `/expo/admin/advertising/${id}/${action}`, { headers: admin, body });
  const remaining = async () => (await api("GET", "/expo/advertising/spaces")).json.spaces.find((s) => s.id === "amphitheatre").remaining;
  const espees = espeesCharges.length;

  // Admins only.
  const p = (await propose()).json.proposal;
  assert.equal((await api("POST", `/expo/admin/advertising/${p.id}/complimentary`, { body: {} })).status, 401);

  // From being reviewed straight to booked: paid with nothing charged, no payment link, its spots taken.
  const before = await remaining();
  const done = await step(p.id, "complimentary", { note: "Diamond sponsor, Tech City" });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.deepEqual([done.json.proposal.status, done.json.proposal.paymentStatus, done.json.proposal.payUrl, done.json.proposal.reviewNote], ["paid", "COMPLIMENTARY", null, "Diamond sponsor, Tech City"]);
  assert.ok(done.json.proposal.paidAt);
  assert.equal(await remaining(), before - 2);
  assert.equal(espeesCharges.length, espees);
  assert.ok(await eventually(() => told(p.reference).some((t) => t.includes("booked, complimentary"))));
  const text = told(p.reference).find((t) => t.includes("booked, complimentary"));
  assert.match(text, /nothing to pay/);
  assert.match(text, /To pay: nothing \(complimentary\)/);
  assert.match(text, /Note: Diamond sponsor, Tech City/);
  // Booked once: not again, and it can't then be turned down or cancelled.
  assert.equal((await step(p.id, "complimentary")).json.error, "not_complimentary");
  assert.equal((await step(p.id, "cancel")).json.error, "not_cancellable");

  // An approved one, its payment link out, can be made complimentary too; the link stops working.
  const q = (await propose({ quantity: 1, title: "Ade's Gold Sponsorship" })).json.proposal;
  const link = (await step(q.id, "approve")).json.proposal.payUrl.split("link=").pop();
  const made = (await step(q.id, "complimentary")).json.proposal;
  assert.deepEqual([made.status, made.paymentStatus, made.payUrl], ["paid", "COMPLIMENTARY", null]);
  assert.equal((await api("GET", `/expo/advertising/pay/${link}`)).status, 404);
});

test("admins page through the accounts: limit and offset, with how many match in all", async () => {
  const admin = { "x-admin-key": "admin-key" };
  const list = async (query) => (await api("GET", `/expo/admin/users?${query}`, { headers: admin })).json;
  const all = await list("limit=500");
  assert.equal(all.total, all.users.length);
  assert.ok(all.total > 4);
  const first = await list("limit=2");
  const second = await list("limit=2&offset=2");
  assert.deepEqual([first.users.length, second.users.length, first.total, first.offset, second.offset], [2, 2, all.total, 0, 2]);
  assert.deepEqual([...first.users, ...second.users].map((u) => u.id), all.users.slice(0, 4).map((u) => u.id));
  // The total counts every match, not just the page; past the end is an empty page.
  const extras = await list("q=extra&limit=1");
  assert.deepEqual([extras.users.length, extras.total], [1, 3]);
  assert.deepEqual((await list(`limit=2&offset=${all.total}`)).users, []);
});

test("officials: the video watched in full or not at all, the quiz passed at 80% after a go that wasn't; the certificate in their name, set once", async () => {
  const admin = { "x-admin-key": "admin-key" };
  const me = (await api("POST", "/expo/auth/kingschat", { body: { code: "extra-90" } })).json.accessToken;
  const other = (await api("POST", "/expo/auth/kingschat", { body: { code: "extra-91" } })).json.accessToken;
  const idle = (await api("POST", "/expo/auth/kingschat", { body: { code: "extra-92" } })).json.accessToken;
  const training = async (token = me) => (await api("GET", "/expo/officials", { token })).json.training;
  const progress = (seconds, token = me) => api("POST", "/expo/officials/progress", { token, body: { seconds } });
  const quiz = routes.officialsQuiz;

  // Signed in only. A video whose length can't be read (not there, or not sent in ranges) isn't available.
  const videoAt = (name) => `http://127.0.0.1:${videos.address().port}/${name}`;
  process.env.EXPO_OFFICIALS_VIDEO_URL = videoAt("missing.mp4");
  assert.equal((await api("GET", "/expo/officials")).status, 401);
  let t = await training();
  assert.deepEqual([t.video.available, t.video.url, t.started, t.quiz.questions, t.quiz.passMark, t.quiz.passPercent], [false, null, false, 25, 20, 80]);
  assert.equal((await progress(10)).json.error, "no_video");
  process.env.EXPO_OFFICIALS_VIDEO_URL = videoAt("no-ranges.mp4");
  assert.equal((await training()).video.available, false);
  assert.equal(videoWholeSends, 1, "asked once, and not read through");

  // The video at its link, 120 seconds long, read from the file there in ranges.
  process.env.EXPO_OFFICIALS_VIDEO_URL = videoAt("video.mp4");
  t = await training();
  assert.deepEqual([t.video.available, t.video.seconds, t.video.url], [true, 120, videoAt("video.mp4")]);

  // The quiz is open from the start; watching the video isn't required.
  assert.equal((await api("GET", "/expo/officials/quiz", { token: idle })).json.questions.length, 25);
  // The furthest point watched moves on only as fast as the video plays.
  const p0 = await progress(120);
  assert.equal(p0.status, 200, JSON.stringify(p0.json));
  t = p0.json.training;
  assert.deepEqual([t.started, t.watchedSeconds, t.watchedAt], [true, 30, null]);
  assert.equal((await progress(120)).json.training.watchedSeconds, 60);
  assert.equal((await progress(5)).json.training.watchedSeconds, 60);
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  await db.query(`UPDATE official_training SET progress_at = now() - interval '40 seconds' WHERE user_id = (SELECT id FROM users WHERE kc_username = 'extra_90')`);
  await db.end();
  t = (await progress(115)).json.training;
  assert.equal(t.watchedSeconds, 115);
  assert.ok(t.watchedAt, "within 10 seconds of the end is the whole video");

  // The quiz: 25 questions, four choices each, no answers given away.
  const qz = (await api("GET", "/expo/officials/quiz", { token: me })).json;
  assert.equal(qz.questions.length, 25);
  assert.deepEqual([qz.passMark, qz.passPercent], [20, 80]);
  assert.ok(qz.questions.every((x) => x.options.length === 4 && !("answer" in x)));
  assert.ok(!JSON.stringify(qz).includes('"answer"'));

  const answers = (wrong) => Object.fromEntries(quiz.map((x, i) => [i + 1, wrong.includes(i + 1) ? ["a", "b", "c", "d"].find((l) => l !== x.answer) : x.answer]));
  const go = (body) => api("POST", "/expo/officials/quiz", { token: me, body });
  const some = answers([]);
  delete some[25];
  assert.equal((await go({ answers: some })).json.error, "unanswered");

  // 19 of 25 (76%): not a pass. The questions missed are told, not their answers.
  const first = await go({ answers: answers([2, 4, 6, 8, 10, 12]), key: "quiz-go-0001" });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.deepEqual([first.json.attempt.score, first.json.attempt.total, first.json.attempt.passed, first.json.attempt.missed], [19, 25, false, [2, 4, 6, 8, 10, 12]]);
  assert.equal(first.json.training.passedAt, null);
  // The same go sent again isn't counted twice.
  const again = await go({ answers: answers([2, 4, 6, 8, 10, 12]), key: "quiz-go-0001" });
  assert.deepEqual([again.status, again.json.repeated, again.json.training.attempts.length], [200, true, 1]);

  // 20 of 25 (80%) passes; no more goes after that.
  const second = await go({ answers: answers([1, 3, 5, 7, 9]), key: "quiz-go-0002" });
  assert.deepEqual([second.json.attempt.score, second.json.attempt.passed], [20, true]);
  assert.ok(second.json.training.passedAt);
  assert.deepEqual(second.json.training.attempts.map((a) => a.score), [20, 19]);
  assert.equal((await go({ answers: answers([]) })).json.error, "already_passed");

  // The certificate: only after passing; the name tidied, and set once (the same name again is fine, another isn't).
  assert.equal((await api("POST", "/expo/officials/certificate", { token: other, body: { name: "Someone Else" } })).json.error, "not_passed");
  assert.equal((await api("POST", "/expo/officials/certificate", { token: me, body: { name: " " } })).json.error, "bad_name");
  const cert = (await api("POST", "/expo/officials/certificate", { token: me, body: { name: "  Ada   N. Obi  " } })).json.training.certificate;
  assert.equal(cert.name, "Ada N. Obi");
  const again2 = await api("POST", "/expo/officials/certificate", { token: me, body: { name: "Ada N. Obi" } });
  assert.deepEqual([again2.status, again2.json.training.certificate.issuedAt], [200, cert.issuedAt]);
  const renamed = await api("POST", "/expo/officials/certificate", { token: me, body: { name: "Someone Else" } });
  assert.deepEqual([renamed.status, renamed.json.error], [409, "name_set"]);
  assert.equal((await training()).certificate.name, "Ada N. Obi");

  // Someone who takes the quiz without watching the video: their training starts with it, and they can pass.
  const straight = await api("POST", "/expo/officials/quiz", { token: other, body: { answers: answers([]) } });
  assert.equal(straight.status, 201, JSON.stringify(straight.json));
  assert.deepEqual([straight.json.attempt.score, straight.json.attempt.passed, straight.json.training.started, straight.json.training.watchedSeconds, straight.json.training.watchedAt], [25, true, true, 0, null]);
  assert.ok(straight.json.training.passedAt);

  // The admin's view: everyone who started, each go, and how often each question is got right.
  assert.equal((await api("GET", "/expo/admin/officials")).status, 401);
  const view = (await api("GET", "/expo/admin/officials", { headers: admin })).json;
  const ada = view.officials.find((o) => o.user.username === "extra_90");
  assert.deepEqual(ada.attempts.map((a) => [a.score, a.passed]), [[19, false], [20, true]]);
  assert.deepEqual([ada.certificate.name, ada.watchedSeconds, !!ada.passedAt], ["Ada N. Obi", 115, true]);
  const quizOnly = view.officials.find((o) => o.user.username === "extra_91");
  assert.deepEqual([quizOnly.watchedSeconds, quizOnly.watchedAt, quizOnly.attempts.length, !!quizOnly.passedAt], [0, null, 1, true]);
  assert.ok(!view.officials.some((o) => o.user.username === "extra_92"), "only people who started the training (looking at the quiz isn't starting)");
  assert.deepEqual([view.questions.length, view.quiz.passMark, view.video.seconds], [25, 20, 120]);
  assert.deepEqual([view.questions[0].attempts, view.questions[0].right, view.questions[1].right], [3, 2, 2]);
  assert.equal(view.questions[24].right, 3);
  assert.equal(view.questions[0].answer, quiz[0].options[1]);
});

test("team votes: 1 Espee for one team, once and for good; a vote counts only once Espees confirms the payment", async () => {
  const admin = { "x-admin-key": "admin-key" };
  const signIn = async (n) => (await api("POST", "/expo/auth/kingschat", { body: { code: `extra-${n}` } })).json;
  const [ada, ben, cy, dee, eve, fay] = await Promise.all([60, 61, 62, 63, 64, 65].map(async (n) => (await signIn(n)).accessToken));
  const wallet = { method: "wallet", username: "voter", pin: "4321" };
  const cast = (t, team, body = {}) => api("POST", "/expo/votes", { token: t, body: { team, expectedPrice: 1, payment: wallet, ...body } });
  const board = async (t) => (await api("GET", "/expo/votes", { token: t })).json;
  const counts = async () => Object.fromEntries((await board()).teams.map((x) => [x.id, x.votes]));
  const adminVotes = async (query = "") => (await api("GET", `/expo/admin/votes${query}`, { headers: admin })).json;
  const sql = async (text, params = []) => {
    const db = new Client({ connectionString: DB_URL });
    await db.connect();
    try { return await db.query(text, params); } finally { await db.end(); }
  };
  const n0 = kcMessages.length;
  const told = () => kcMessages.slice(n0).filter((m) => /Your vote for/.test(m.message.body.text.body));

  // The board, for anyone: the three teams, nothing counted yet, votes being taken at 1 Espee.
  const start = await board();
  assert.deepEqual([start.open, start.price, start.total, start.vote], [true, 1, 0, null]);
  assert.deepEqual(start.teams, [{ id: "launchpad", name: "Launchpad", votes: 0 }, { id: "wealth-liquefiers", name: "Wealth Liquefiers", votes: 0 }, { id: "dynamic", name: "Dynamic", votes: 0 }]);

  // Voting is for a signed-in person, for one of the teams, at the price shown, with a way to pay.
  const charges = espeesCharges.length;
  assert.equal((await api("POST", "/expo/votes", { body: { team: "dynamic", payment: wallet } })).status, 401);
  assert.equal((await api("GET", "/expo/votes/me")).status, 401);
  assert.equal((await cast(ada, "the-winners")).json.error, "bad_team");
  assert.equal((await cast(ada, "toString")).json.error, "bad_team");
  assert.deepEqual([(await cast(ada, "dynamic", { expectedPrice: 0.5 })).status, (await cast(ada, "dynamic", { expectedPrice: 0.5 })).json.error], [409, "price_changed"]);
  assert.equal((await cast(ada, "dynamic", { payment: { method: "wallet", username: "voter" } })).json.error, "missing_payment");
  assert.equal(espeesCharges.length, charges);
  assert.equal((await sql(`SELECT 1 FROM team_votes`)).rowCount, 0);

  // Espees refuses: nothing taken, so no vote. The attempt is kept, cancelled, and they can try again.
  espeesRefuse = "Insufficient balance";
  const declined = await cast(ada, "dynamic");
  assert.deepEqual([declined.status, declined.json.error, declined.json.message], [402, "payment_declined", "Insufficient balance"]);
  assert.equal((await board(ada)).vote, null);
  assert.equal((await counts()).dynamic, 0);

  // A vote: charged 1 Espee with the merchant token, confirmed with Espees, counted. The PIN isn't kept.
  const v = await cast(ada, "launchpad");
  assert.equal(v.status, 201, JSON.stringify(v.json));
  assert.deepEqual([v.json.vote.team, v.json.vote.teamName, v.json.vote.status, v.json.vote.paymentStatus, v.json.vote.amount, v.json.vote.payer], ["launchpad", "Launchpad", "counted", "PAID", 1, "@voter"]);
  assert.match(v.json.vote.reference, /^VOTE-[0-9A-F]{10}$/);
  assert.deepEqual(espeesCharges.at(-1), { path: "/makepayment", token: "esp-test-token", body: { username: "voter", pin: "4321", espeesAmount: 1 }, reference: espeesCharges.at(-1).reference });
  assert.ok(!JSON.stringify(v.json).includes("4321"));
  assert.ok(!JSON.stringify((await sql(`SELECT * FROM team_votes`)).rows).includes("4321"));
  assert.deepEqual(await counts(), { launchpad: 1, "wealth-liquefiers": 0, dynamic: 0 });
  assert.equal((await board(ada)).vote.reference, v.json.vote.reference);
  assert.equal((await api("GET", "/expo/votes/me", { token: ada })).json.vote.team, "launchpad");
  // The voter hears on KingsChat, once.
  for (let i = 0; i < 100 && !told().length; i++) await new Promise((r) => setTimeout(r, 30));
  assert.match(told()[0]?.message.body.text.body || "", /Your vote for Launchpad is in!/);
  assert.match(told()[0].message.body.text.body, new RegExp(`Reference: ${v.json.vote.reference}`));

  // Once is for good: the same team again or another one is refused, and nothing more is charged.
  const paidOnce = espeesCharges.length;
  for (const team of ["launchpad", "dynamic"]) {
    const again = await cast(ada, team);
    assert.deepEqual([again.status, again.json.error], [409, "already_voted"]);
    assert.match(again.json.message, /already voted for Launchpad/);
  }
  assert.equal(espeesCharges.length, paidOnce);
  assert.deepEqual(await counts(), { launchpad: 1, "wealth-liquefiers": 0, dynamic: 0 });
  // The database itself refuses a second vote for the account, and for its KingsChat identity.
  const row = (await sql(`SELECT user_id, kc_id FROM team_votes WHERE status = 'counted'`)).rows[0];
  await assert.rejects(sql(`INSERT INTO team_votes (id, reference, user_id, team, amount, status) VALUES ($1, 'VOTE-X1', $2, 'dynamic', 1, 'counted')`, [crypto.randomUUID(), row.user_id]), /team_votes_one_per_user/);
  await assert.rejects(sql(`INSERT INTO team_votes (id, reference, kc_id, team, amount, status) VALUES ($1, 'VOTE-X2', $2, 'dynamic', 1, 'pending')`, [crypto.randomUUID(), row.kc_id]), /team_votes_one_per_kc/);

  // Vote pressed twice at once: one vote, one charge.
  espeesSlow = 300;
  const both = await Promise.all([cast(ben, "dynamic"), cast(ben, "wealth-liquefiers")]);
  espeesSlow = 0;
  assert.deepEqual(both.map((x) => x.status).sort(), [201, 409]);
  assert.equal(both.find((x) => x.status === 409).json.error, "payment_in_progress");
  assert.equal(espeesCharges.length, paidOnce + 1);

  // Charged, but Espees hasn't confirmed it: not a vote yet, and not to be paid for again. Counted
  // once Espees confirms it, when the person looks again.
  const slowRef = nextEspeesRef();
  espeesStatus[slowRef] = { status: "0" };
  const waiting = await cast(cy, "wealth-liquefiers");
  assert.deepEqual([waiting.status, waiting.json.vote.status, waiting.json.vote.paymentStatus], [201, "pending", "CHARGED"]);
  const before = await counts();
  assert.equal(before["wealth-liquefiers"], both.find((x) => x.status === 201).json.vote.team === "wealth-liquefiers" ? 1 : 0);
  const second = await cast(cy, "dynamic");
  assert.deepEqual([second.status, second.json.error], [409, "vote_pending"]);
  assert.equal((await api("POST", "/expo/votes/confirm", { token: cy })).json.vote.status, "pending");
  espeesStatus[slowRef] = { status: "1" };
  const confirmed = await api("POST", "/expo/votes/confirm", { token: cy });
  assert.deepEqual([confirmed.json.vote.status, confirmed.json.vote.paymentStatus], ["counted", "PAID"]);
  assert.equal((await counts())["wealth-liquefiers"], before["wealth-liquefiers"] + 1);
  assert.equal((await api("POST", "/expo/votes/confirm", { token: dee })).status, 404);

  // The same, with the page closed after paying: just looking at the board later brings it up to date.
  const lateRef = nextEspeesRef();
  espeesStatus[lateRef] = { status: "0" };
  assert.equal((await cast(fay, "dynamic")).json.vote.status, "pending");
  espeesStatus[lateRef] = { status: "1" };
  await sql(`UPDATE team_votes SET payment_checked_at = now() - interval '1 minute' WHERE payment_ref = $1`, [lateRef]);
  assert.equal((await board(fay)).vote.status, "counted");

  // No clear answer from Espees: kept for the team, the person told not to pay again, nothing counted.
  espeesBroken = true;
  const unclear = await cast(dee, "dynamic");
  espeesBroken = false;
  assert.deepEqual([unclear.status, unclear.json.error], [502, "payment_unknown"]);
  assert.deepEqual([(await board(dee)).vote.status, (await board(dee)).vote.paymentStatus], ["pending", "UNKNOWN"]);
  assert.equal((await cast(dee, "dynamic")).json.error, "vote_pending");
  // The team sees in Espees that nothing was taken, and reopens it: the attempt is kept, cancelled, and they vote.
  const stuck = (await adminVotes("?status=pending")).votes.find((x) => x.user.username === "extra_63");
  assert.deepEqual([stuck.paymentStatus, stuck.paymentRef], ["UNKNOWN", null]);
  assert.match(stuck.paymentError, /500/);
  assert.equal((await api("POST", `/expo/admin/votes/${stuck.id}/reopen`)).status, 401);
  const reopened = await api("POST", `/expo/admin/votes/${stuck.id}/reopen`, { headers: admin, body: { note: "Not in Espees" } });
  assert.deepEqual([reopened.json.vote.status, reopened.json.vote.paymentStatus, reopened.json.vote.paymentError], ["cancelled", "REOPENED", "Not in Espees"]);
  assert.equal((await board(dee)).vote, null);
  assert.equal((await cast(dee, "wealth-liquefiers")).json.vote.status, "counted");
  // A counted vote can't be reopened or counted again.
  const deeVote = (await board(dee)).vote;
  assert.equal((await api("POST", `/expo/admin/votes/${deeVote.id}/reopen`, { headers: admin })).json.error, "not_pending");
  assert.equal((await api("POST", `/expo/admin/votes/${deeVote.id}/paid`, { headers: admin })).json.error, "not_pending");

  // Confirmed by Espees for another amount: not counted. The team, having seen the payment, counts it by hand.
  espeesStatus[nextEspeesRef()] = { status: "1", amount: 0.01 };
  const odd = await cast(eve, "launchpad");
  assert.deepEqual([odd.json.vote.status, odd.json.vote.paymentStatus], ["pending", "MISMATCH"]);
  assert.equal((await counts()).launchpad, 1);
  const byHand = await api("POST", `/expo/admin/votes/${odd.json.vote.id}/paid`, { headers: admin, body: { note: "Seen in Espees" } });
  assert.deepEqual([byHand.json.vote.status, byHand.json.vote.paymentStatus], ["counted", "MARKED_PAID"]);
  assert.equal((await counts()).launchpad, 2);
  assert.equal((await api("POST", `/expo/admin/votes/${odd.json.vote.id}/settle`, { headers: admin })).json.vote.status, "counted");

  // The admin's view: the totals, and every vote with who, which team, when and Espees' reference.
  assert.equal((await api("GET", "/expo/admin/votes")).status, 401);
  const view = await adminVotes();
  const tally = await counts();
  assert.deepEqual(Object.fromEntries(view.teams.map((x) => [x.id, x.votes])), tally);
  assert.deepEqual(view.totals, { counted: 6, pending: 0, cancelled: 2, espees: 6 });
  assert.equal(tally.launchpad + tally["wealth-liquefiers"] + tally.dynamic, 6);
  assert.deepEqual([view.total, view.votes.length], [8, 8]);
  const adas = view.votes.find((x) => x.reference === v.json.vote.reference);
  assert.deepEqual([adas.user.username, adas.user.name, adas.team, adas.status, adas.payer, adas.paymentRef, !!adas.paidAt, !!adas.createdAt], ["extra_60", "Extra 60", "launchpad", "counted", "@voter", espeesCharges[paidOnce - 1].reference, true, true]);
  assert.deepEqual((await adminVotes("?status=cancelled")).votes.map((x) => x.paymentStatus).sort(), ["DECLINED", "REOPENED"]);
  assert.deepEqual([(await adminVotes("?team=launchpad&status=counted")).total, (await adminVotes("?q=extra_60")).total, (await adminVotes(`?q=${v.json.vote.reference.toLowerCase()}`)).total], [2, 2, 1]);
  assert.deepEqual([(await adminVotes("?limit=3")).votes.length, (await adminVotes("?limit=3&offset=6")).votes.length], [3, 2]);
  assert.equal((await api("GET", "/expo/admin/stats", { headers: admin })).json.stats.votes, 6);
  // A person never sees who else voted, Espees' reference or its errors.
  assert.deepEqual([v.json.vote.user, v.json.vote.paymentRef, v.json.vote.paymentError], [undefined, undefined, undefined]);

  // An account deleted and made again with the same KingsChat identity has still voted; the vote stays counted.
  assert.equal((await api("DELETE", "/expo/account", { token: ada })).json.deleted, true);
  const adaAgain = (await signIn(60)).accessToken;
  assert.equal((await board(adaAgain)).vote.team, "launchpad");
  assert.equal((await cast(adaAgain, "dynamic")).json.error, "already_voted");
  assert.equal((await counts()).launchpad, 2);

  // The running totals can be kept from the public, and voting closed.
  process.env.EXPO_VOTE_COUNTS = "off";
  const hidden = await board();
  assert.deepEqual([hidden.total, hidden.teams.map((x) => x.votes)], [null, [null, null, null]]);
  assert.equal((await adminVotes()).teams[0].votes, 2);
  delete process.env.EXPO_VOTE_COUNTS;
  process.env.EXPO_VOTING = "off";
  const newcomer = (await signIn(66)).accessToken;
  assert.equal((await board()).open, false);
  assert.deepEqual([(await cast(newcomer, "dynamic")).status, (await cast(newcomer, "dynamic")).json.error], [503, "voting_closed"]);
  delete process.env.EXPO_VOTING;
  assert.equal(espeesCharges.length, paidOnce + 5);
  assert.equal(told().length, 6);
});
