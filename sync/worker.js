// Cloud sync for the tracker: a tiny Cloudflare Worker in front of one R2 bucket.
//
//   GET/HEAD /state        the latest saved state (JSON; photos replaced by blob refs)
//   PUT      /state        store a new state; header X-Saved-At carries its timestamp
//   GET/HEAD /blob/<sha>   a photo (its data URL as text), addressed by SHA-256
//   PUT      /blob/<sha>   upload a photo; rejected unless the body hashes to <sha>
//
// Every request needs "Authorization: Bearer <SYNC_TOKEN>". The token is a
// Worker secret (wrangler secret put SYNC_TOKEN) and never lives in the repo.
// Each PUT /state also overwrites history/<YYYY-MM-DD>.json, so there is one
// snapshot per day to roll back to.

const ALLOWED_ORIGINS = [
  "https://rask0l.github.io",
  "http://127.0.0.1:4000",
  "http://localhost:4000",
];
const MAX_STATE = 20 * 1024 * 1024;   // the state without photos is far smaller
const MAX_BLOB = 15 * 1024 * 1024;

function corsHeaders(req) {
  const origin = req.headers.get("Origin") || "";
  const h = {
    "Access-Control-Allow-Methods": "GET, HEAD, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Saved-At",
    "Access-Control-Expose-Headers": "X-Saved-At",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (ALLOWED_ORIGINS.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

// constant-time comparison so the token can't be guessed byte by byte
function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req);
    const reply = (body, status = 200, extra = {}) =>
      new Response(body, { status, headers: { ...cors, "Cache-Control": "no-store", ...extra } });

    if (req.method === "OPTIONS") return reply(null, 204);
    if (!env.SYNC_TOKEN) return reply("SYNC_TOKEN is not set on the worker", 500);
    if (!sameSecret(req.headers.get("Authorization") || "", "Bearer " + env.SYNC_TOKEN)) {
      return reply("unauthorized", 401);
    }

    const path = new URL(req.url).pathname;

    if (path === "/state") {
      if (req.method === "GET" || req.method === "HEAD") {
        const obj = req.method === "HEAD" ? await env.BUCKET.head("state.json")
                                          : await env.BUCKET.get("state.json");
        if (!obj) return reply(null, 404);
        const at = (obj.customMetadata && obj.customMetadata.savedAt) || "0";
        return reply(req.method === "HEAD" ? null : obj.body, 200,
                     { "Content-Type": "application/json", "X-Saved-At": at });
      }
      if (req.method === "PUT") {
        const at = req.headers.get("X-Saved-At") || String(Date.now());
        if (!/^\d{1,16}$/.test(at)) return reply("bad X-Saved-At", 400);
        const body = await req.text();
        if (body.length > MAX_STATE) return reply("state too large", 413);
        try { JSON.parse(body); } catch (e) { return reply("not JSON", 400); }
        const meta = { customMetadata: { savedAt: at }, httpMetadata: { contentType: "application/json" } };
        const day = new Date(+at).toISOString().slice(0, 10);
        await Promise.all([
          env.BUCKET.put("state.json", body, meta),
          env.BUCKET.put("history/" + day + ".json", body, meta),
        ]);
        return reply(JSON.stringify({ ok: true, savedAt: at }), 200, { "Content-Type": "application/json" });
      }
      return reply("method not allowed", 405);
    }

    const m = path.match(/^\/blob\/([a-f0-9]{64})$/);
    if (m) {
      const key = "blobs/" + m[1];
      if (req.method === "HEAD") return reply(null, (await env.BUCKET.head(key)) ? 200 : 404);
      if (req.method === "GET") {
        const obj = await env.BUCKET.get(key);
        if (!obj) return reply(null, 404);
        return reply(obj.body, 200, { "Content-Type": "text/plain" });
      }
      if (req.method === "PUT") {
        const body = await req.text();
        if (body.length > MAX_BLOB) return reply("photo too large", 413);
        if (!body.startsWith("data:image/")) return reply("not a photo", 400);
        if ((await sha256Hex(body)) !== m[1]) return reply("hash mismatch", 400);
        await env.BUCKET.put(key, body);
        return reply(JSON.stringify({ ok: true }), 200, { "Content-Type": "application/json" });
      }
      return reply("method not allowed", 405);
    }

    return reply("not found", 404);
  },
};
