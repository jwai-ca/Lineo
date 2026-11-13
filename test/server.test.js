// Runs the real server against a fake OpenAI / Gemini, so no API key or network is needed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64").toString("base64");
const JPEG = Buffer.alloc(4000, 1).toString("base64");
const seen = [];
let fake, app, base;

function listen(server) { return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))); }

before(async () => {
  fake = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("latin1");
      seen.push({ url: req.url, auth: req.headers.authorization, gkey: req.headers["x-goog-api-key"], body });
      res.setHeader("Content-Type", "application/json");
      if (req.url.startsWith("/openai/images/edits")) return res.end(JSON.stringify({ data: [{ b64_json: PNG }] }));
      if (req.url.includes(":generateContent")) return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }, { inlineData: { mimeType: "image/png", data: PNG } }] } }] }));
      res.statusCode = 404; res.end("{}");
    });
  });
  const fakePort = await listen(fake);
  const port = 20000 + Math.floor(Math.random() * 20000);
  app = spawn(process.execPath, [fileURLToPath(new URL("../server/server.js", import.meta.url))], {
    env: { ...process.env, PORT: String(port), OPENAI_API_KEY: "sk-secret", GEMINI_API_KEY: "g-secret", APP_PASSCODE: "panda",
      RATE_LIMIT_PER_HOUR: "6", OPENAI_BASE_URL: `http://127.0.0.1:${fakePort}/openai`, GEMINI_BASE_URL: `http://127.0.0.1:${fakePort}/gemini` },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((r) => app.stdout.on("data", (d) => { if (String(d).includes("running")) r(); }));
  base = `http://127.0.0.1:${port}`;
});
after(() => { app.kill(); fake.close(); });

const redraw = (body) => fetch(base + "/api/redraw", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("config lists providers but never the keys", async () => {
  const text = await (await fetch(base + "/api/config")).text();
  const j = JSON.parse(text);
  assert.equal(j.passcodeRequired, true);
  assert.deepEqual(j.providers.map((p) => p.id), ["openai", "gemini"]);
  assert.ok(!text.includes("secret"));
});

test("wrong passcode is refused before any AI call", async () => {
  const n = seen.length;
  const r = await redraw({ image: JPEG, passcode: "nope" });
  assert.equal(r.status, 401);
  assert.equal(seen.length, n);
});

test("OpenAI path sends the server key and returns the image", async () => {
  const r = await redraw({ image: "data:image/jpeg;base64," + JPEG, passcode: "panda", provider: "openai", style: "real", ratio: 0.75 });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).image, PNG);
  const call = seen.at(-1);
  assert.equal(call.auth, "Bearer sk-secret");
  assert.match(call.body, /name="image\[\]"/);
  assert.match(call.body, /1024x1536/);
  assert.match(call.body, /coloring book page/);
});

test("Gemini path sends the server key and returns the image", async () => {
  const r = await redraw({ image: JPEG, passcode: "panda", provider: "gemini", style: "cute" });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).image, PNG);
  assert.equal(seen.at(-1).gkey, "g-secret");
  assert.match(seen.at(-1).url, /gemini-3\.1-flash-image:generateContent/);
});

test("static page is served and path traversal is blocked", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /线描/);
  const bad = await fetch(base + "/..%2fserver%2fserver.js");
  assert.notEqual(bad.status, 200);
});

test("detail level and background choice change the prompt", async () => {
  const r1 = await redraw({ image: JPEG, passcode: "panda", provider: "openai", detail: 0 });
  const simple = seen.at(-1).body;
  const r2 = await redraw({ image: JPEG, passcode: "panda", provider: "openai", detail: 4, background: true });
  const rich = seen.at(-1).body;
  assert.equal(r1.status, 200); assert.equal(r2.status, 200);
  assert.match(simple, /VERY SIMPLE/); assert.match(simple, /remove the whole background/); assert.doesNotMatch(simple, /#0000FF/);
  assert.match(rich, /VERY DETAILED/); assert.match(rich, /#0000FF/);
});

test("rate limit kicks in", async () => {
  let last;
  for (let i = 0; i < 6; i++) last = await redraw({ image: JPEG, passcode: "panda" });
  assert.equal(last.status, 429);
});
