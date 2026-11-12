// Lineo backend: serves the web app and forwards photos to a cloud image model.
// The API keys live only in this server's environment; the browser never sees them.
// Node.js 18+ with no dependencies.

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const env = process.env;
const PORT = Number(env.PORT || 8787);
const PASSCODE = env.APP_PASSCODE || "";
const LIMIT_PER_HOUR = Number(env.RATE_LIMIT_PER_HOUR || 30);
const MAX_BODY = 12 * 1024 * 1024;
const OPENAI_BASE = env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const GEMINI_BASE = env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";

const PROVIDERS = {
  openai: { key: env.OPENAI_API_KEY, model: env.OPENAI_MODEL || "gpt-image-2", label: "OpenAI" },
  gemini: { key: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || "gemini-3.1-flash-image", label: "Google Gemini" },
};
const available = () => Object.keys(PROVIDERS).filter((p) => PROVIDERS[p].key);
const defaultProvider = () => (available().includes(env.AI_PROVIDER) ? env.AI_PROVIDER : available()[0]);

// The prompt is fixed on the server so the key can only be used for coloring pages.
const STYLE = {
  cute: "Draw it in a cute, friendly cartoon style with slightly simplified, rounded shapes and expressive faces.",
  real: "Stay faithful to the photo: keep the real proportions, pose and important details, drawn like a professional coloring book illustration.",
};
const prompt = (style) =>
  "Redraw this photo as a printable coloring book page for children aged 3 to 10. " +
  "Keep only the main subject and remove the whole background. " +
  "Use clean, smooth, confident black outlines on a pure white background, with closed shapes that are easy to color in. " +
  "No shading, no gray tones, no hatching, no color fills, no text, no border, no frame. " +
  (STYLE[style] || STYLE.cute) + " Center the subject and leave a white margin around it.";

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function upstreamError(r, who) {
  let detail = "";
  try { const j = await r.json(); detail = (j.error && (j.error.message || j.error.status)) || ""; } catch {}
  console.error(`[${who}] ${r.status} ${detail}`);
  if (r.status === 401 || r.status === 403) return new HttpError(502, `${who} 拒绝了服务器上的 API key，请管理员检查配置。`);
  if (r.status === 429) return new HttpError(429, `${who} 额度不足或请求太频繁，请稍后再试。`);
  if (r.status === 404) return new HttpError(502, `${who} 找不到配置的模型，请管理员检查模型名称。`);
  if (r.status === 400) return new HttpError(400, `${who} 不接受这张图片${detail ? "：" + detail : ""}`);
  return new HttpError(502, `${who} 出错了（${r.status}），请稍后再试。`);
}

async function callOpenAI(jpeg, style, ratio) {
  const p = PROVIDERS.openai;
  const size = ratio > 1.15 ? "1536x1024" : ratio < 0.87 ? "1024x1536" : "1024x1024";
  const fd = new FormData();
  fd.append("model", p.model);
  fd.append("prompt", prompt(style));
  fd.append("size", size);
  fd.append("quality", env.OPENAI_QUALITY || "medium");
  fd.append("image[]", new Blob([jpeg], { type: "image/jpeg" }), "photo.jpg");
  const r = await fetch(`${OPENAI_BASE}/images/edits`, {
    method: "POST", headers: { Authorization: `Bearer ${p.key}` }, body: fd, signal: AbortSignal.timeout(180000),
  });
  if (!r.ok) throw await upstreamError(r, "OpenAI");
  const j = await r.json();
  const b64 = j.data && j.data[0] && j.data[0].b64_json;
  if (!b64) throw new HttpError(502, "AI 没有返回图片，请再试一次。");
  return { image: b64, mime: "image/png" };
}

async function callGemini(jpeg, style) {
  const p = PROVIDERS.gemini;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt(style) }, { inline_data: { mime_type: "image/jpeg", data: jpeg.toString("base64") } }] }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
  };
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(p.model)}:generateContent`;
  const r = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": p.key },
    body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
  });
  if (!r.ok) throw await upstreamError(r, "Gemini");
  const j = await r.json();
  for (const c of j.candidates || []) for (const part of (c.content && c.content.parts) || []) {
    const d = part.inlineData || part.inline_data;
    if (d && d.data) return { image: d.data, mime: d.mimeType || d.mime_type || "image/png" };
  }
  const why = j.promptFeedback && j.promptFeedback.blockReason;
  throw new HttpError(422, why ? `AI 拒绝了这张图片（${why}），请换一张试试。` : "AI 没有返回图片，请再试一次。");
}

// ---- small helpers ----
const hits = new Map(); // ip -> timestamps in the last hour
function rateLimit(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (list.length >= LIMIT_PER_HOUR) throw new HttpError(429, "这一小时画得太多了，请稍后再试。");
  list.push(now); hits.set(ip, list);
}
setInterval(() => { const now = Date.now(); for (const [ip, l] of hits) if (!l.some((t) => now - t < 3600e3)) hits.delete(ip); }, 600e3).unref();

function passOk(given) {
  if (!PASSCODE) return true;
  const a = Buffer.from(String(given || "")), b = Buffer.from(PASSCODE);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(new HttpError(413, "图片太大了。")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new HttpError(400, "请求格式不对。")); } });
    req.on("error", reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon" };
async function serveStatic(req, res) {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    if (!(await stat(file)).isFile()) throw new Error();
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(await readFile(file));
  } catch { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Not found"); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const ip = (env.TRUST_PROXY ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "") || req.socket.remoteAddress;
  try {
    if (url.pathname === "/api/config" && req.method === "GET") {
      return send(res, 200, {
        passcodeRequired: !!PASSCODE,
        providers: available().map((id) => ({ id, label: PROVIDERS[id].label })),
        defaultProvider: defaultProvider() || null,
      });
    }
    if (url.pathname === "/api/redraw" && req.method === "POST") {
      const body = await readJson(req);
      if (!passOk(body.passcode)) throw new HttpError(401, "访问口令不对。");
      rateLimit(ip);
      const provider = available().includes(body.provider) ? body.provider : defaultProvider();
      if (!provider) throw new HttpError(503, "服务器还没有配置任何 AI 服务的 API key。");
      const jpeg = Buffer.from(String(body.image || "").replace(/^data:[^,]*,/, ""), "base64");
      if (jpeg.length < 1000) throw new HttpError(400, "没有收到图片。");
      const ratio = Number(body.ratio) || 1;
      const style = STYLE[body.style] ? body.style : "cute";
      const t = Date.now();
      const out = provider === "openai" ? await callOpenAI(jpeg, style, ratio) : await callGemini(jpeg, style);
      console.log(`[redraw] ${provider} ${style} ${Math.round(jpeg.length / 1024)}KB ${Date.now() - t}ms`);
      return send(res, 200, out);
    }
    if (url.pathname.startsWith("/api/")) throw new HttpError(404, "Not found");
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
    return serveStatic(req, res);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    const timeout = e && (e.name === "TimeoutError" || e.name === "AbortError");
    return send(res, timeout ? 504 : 500, { error: timeout ? "AI 服务太久没有回应，请再试一次。" : "服务器出错了，请稍后再试。" });
  }
});

server.listen(PORT, () => {
  console.log(`Lineo running on http://localhost:${PORT}`);
  console.log(`AI services configured: ${available().join(", ") || "none (set OPENAI_API_KEY or GEMINI_API_KEY)"}`);
  if (!PASSCODE) console.log("Warning: APP_PASSCODE is not set, so anyone who can reach this server can use your API quota.");
});
