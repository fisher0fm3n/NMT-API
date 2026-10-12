// EspeesMax tutorial videos (routes/espees_tutorials.js) against an in-memory stand-in for
// the Mongo collection. Run: node --test test/espees_tutorials.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const espeesTutorialsRoutes = require("../routes/espees_tutorials");
const { validateTutorial, DEFAULT_TUTORIALS } = espeesTutorialsRoutes;

// Just the parts of a Mongo collection the route uses.
function fakeCollection() {
  let rows = [];
  const matches = (doc, filter) =>
    Object.entries(filter).every(([k, v]) =>
      v && typeof v === "object" && "$ne" in v ? doc[k] !== v.$ne : doc[k] === v,
    );
  const cursor = (list) => {
    let out = [...list];
    const c = {
      sort(spec) {
        const keys = Object.entries(spec);
        out.sort((a, b) => {
          for (const [k, dir] of keys) {
            if (a[k] < b[k]) return -dir;
            if (a[k] > b[k]) return dir;
          }
          return 0;
        });
        return c;
      },
      limit(n) { out = out.slice(0, n); return c; },
      toArray: async () => out.map((d) => ({ ...d })),
    };
    return c;
  };
  return {
    createIndex: async () => "ok",
    find: (filter = {}) => cursor(rows.filter((d) => matches(d, filter))),
    findOne: async (filter) => { const d = rows.find((r) => matches(r, filter)); return d ? { ...d } : null; },
    insertOne: async (doc) => {
      if (rows.some((r) => r.slug === doc.slug)) throw Object.assign(new Error("dup"), { code: 11000 });
      rows.push({ ...doc });
      return { acknowledged: true };
    },
    insertMany: async (docs) => { for (const d of docs) rows.push({ ...d }); return { acknowledged: true }; },
    updateOne: async (filter, { $set }) => {
      const d = rows.find((r) => matches(r, filter));
      if (d) Object.assign(d, $set);
      return { matchedCount: d ? 1 : 0 };
    },
    bulkWrite: async (ops) => { for (const { updateOne: u } of ops) { const d = rows.find((r) => matches(r, u.filter)); if (d) Object.assign(d, u.update.$set); } },
    deleteOne: async (filter) => { const before = rows.length; rows = rows.filter((r) => !matches(r, filter)); return { deletedCount: before - rows.length }; },
  };
}

let server, base;

test.before(async () => {
  const col = fakeCollection();
  const app = express();
  app.use(express.json());
  app.use(espeesTutorialsRoutes({ getDb: async () => ({ collection: () => col }) }));
  app.use((err, _req, res, _next) => res.status(500).json({ status: false, message: err.message }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function call(method, path, { body } = {}) {
  const headers = { "content-type": "application/json" };
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, headers: res.headers, json: await res.json() };
}

const sample = {
  slug: "pay-bills",
  title: "Pay bills",
  summary: "Airtime, data and electricity.",
  poster: "https://cdn.example.com/p.jpg",
  video: "https://cdn.example.com/v.mp4",
  durationSeconds: 42.4,
  outcomes: ["Buy airtime"],
  relatedLinks: [{ label: "Utilities", href: "/utilities" }],
};

test("the public list starts empty", async () => {
  const r = await call("GET", "/nmt/espees/tutorials");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.data.tutorials, []);
  assert.match(r.headers.get("cache-control"), /max-age=60/);
});

test("managing the list needs no key", async () => {
  const r = await call("GET", "/nmt/espees/admin/tutorials");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.data.tutorials, []);
});

test("seed adds the seven videos once", async () => {
  const first = await call("POST", "/nmt/espees/admin/tutorials/seed");
  assert.equal(first.json.data.added.length, 7);
  const again = await call("POST", "/nmt/espees/admin/tutorials/seed");
  assert.deepEqual(again.json.data.added, []);
  const list = await call("GET", "/nmt/espees/tutorials");
  assert.deepEqual(list.json.data.tutorials.map((t) => t.step), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(list.json.data.tutorials[0].slug, "before-you-begin");
  assert.ok(list.json.data.updatedAt);
});

test("a new video goes to the end and validation reports each bad field", async () => {
  const bad = await call("POST", "/nmt/espees/admin/tutorials", {
    body: { slug: "Bad Slug", title: "", poster: "http://insecure.jpg", video: "nope", relatedLinks: [{ label: "x", href: "//evil.com" }] },
  });
  assert.equal(bad.status, 400);
  assert.deepEqual(Object.keys(bad.json.fields).sort(), ["poster", "relatedLinks[0].href", "slug", "title", "video"]);

  const ok = await call("POST", "/nmt/espees/admin/tutorials", { body: sample });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.data.tutorial.step, 8);
  assert.equal(ok.json.data.tutorial.durationSeconds, 42);

  const dup = await call("POST", "/nmt/espees/admin/tutorials", { body: sample });
  assert.equal(dup.status, 409);
});

test("patch changes only the fields sent, and unpublished videos leave the public list", async () => {
  const r = await call("PATCH", "/nmt/espees/admin/tutorials/pay-bills", { body: { title: "Pay your bills", published: false } });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.tutorial.title, "Pay your bills");
  assert.equal(r.json.data.tutorial.summary, sample.summary);

  const pub = await call("GET", "/nmt/espees/tutorials");
  assert.ok(!pub.json.data.tutorials.some((t) => t.slug === "pay-bills"));
  assert.equal((await call("GET", "/nmt/espees/tutorials/pay-bills")).status, 404);
  const all = await call("GET", "/nmt/espees/admin/tutorials");
  assert.ok(all.json.data.tutorials.some((t) => t.slug === "pay-bills" && t.published === false));

  assert.equal((await call("PATCH", "/nmt/espees/admin/tutorials/pay-bills", { body: {} })).status, 400);
  assert.equal((await call("PATCH", "/nmt/espees/admin/tutorials/missing", { body: { title: "x" } })).status, 404);
  assert.equal((await call("PATCH", "/nmt/espees/admin/tutorials/pay-bills", { body: { slug: "buy-espees" } })).status, 409);
});

test("order renumbers steps, keeping unlisted videos after the listed ones", async () => {
  const r = await call("PUT", "/nmt/espees/admin/tutorials/order", { body: { slugs: ["send-espees", "buy-espees"] } });
  assert.equal(r.status, 200);
  const slugs = r.json.data.tutorials.map((t) => t.slug);
  assert.deepEqual(slugs.slice(0, 3), ["send-espees", "buy-espees", "before-you-begin"]);
  assert.deepEqual(r.json.data.tutorials.map((t) => t.step), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal((await call("PUT", "/nmt/espees/admin/tutorials/order", { body: { slugs: ["nope"] } })).status, 404);
  assert.equal((await call("PUT", "/nmt/espees/admin/tutorials/order", { body: { slugs: ["a", "a"] } })).status, 400);
});

test("delete removes a video", async () => {
  assert.equal((await call("DELETE", "/nmt/espees/admin/tutorials/pay-bills")).status, 200);
  assert.equal((await call("DELETE", "/nmt/espees/admin/tutorials/pay-bills")).status, 404);
});

test("the defaults are themselves valid", () => {
  for (const t of DEFAULT_TUTORIALS) assert.deepEqual(validateTutorial(t).errors, {}, t.slug);
});
