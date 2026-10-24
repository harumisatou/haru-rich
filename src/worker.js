// HaruRich — Telegram Rich Message Sender
// Cloudflare Pages (advanced mode: file ini disalin jadi public/_worker.js).
//
// Tanggung jawab worker ini HANYA:
//  - menyajikan aset statis (via binding ASSETS bawaan Pages)
//  - API draft & riwayat kirim di /api/* yang disimpan di KV (HARURICH_KV),
//    dipisah per "workspace" anonim (ID acak dari browser pengguna).
//
// BOT TOKEN TIDAK PERNAH menyentuh server ini: browser pengguna memanggil
// api.telegram.org langsung. Yang disimpan di KV hanya isi blocks, tujuan
// kirim, dan message_id hasil — tanpa token.

const WS_RE = /^[A-Za-z0-9-]{8,64}$/;
const ID_RE = /^[A-Za-z0-9-]{4,48}$/;
const MAX_PAYLOAD = 300000; // karakter JSON per draft/riwayat
const MAX_DRAFTS = 100;
const MAX_HISTORY = 50;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function wsId(req) {
  const id = req.headers.get("x-workspace-id") || "";
  return WS_RE.test(id) ? id : null;
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function listKeys(kv, prefix, limit = 200) {
  const out = [];
  let cursor;
  do {
    const r = await kv.list({ prefix, cursor, limit: 256 });
    for (const k of r.keys) out.push(k.name);
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor && out.length < limit);
  return out.slice(0, limit);
}

function checkBlocks(body) {
  if (!Array.isArray(body.blocks)) return "blocks harus berupa array";
  if (body.blocks.length === 0) return "blocks kosong";
  if (body.blocks.length > 500) return "blocks melebihi batas Telegram (500)";
  if (JSON.stringify(body.blocks).length > MAX_PAYLOAD) return "payload terlalu besar";
  return null;
}

async function api(req, env, url) {
  const kv = env.HARURICH_KV;
  if (url.pathname === "/api/health") {
    return json({ ok: true, kv: !!kv, service: "harurich" });
  }
  if (!kv) return json({ ok: false, error: "Penyimpanan server (KV) belum terhubung." }, 500);
  const ws = wsId(req);
  if (!ws) return json({ ok: false, error: "X-Workspace-Id tidak valid." }, 400);
  const p = url.pathname;

  // ---------- Drafts ----------
  if (p === "/api/drafts" && req.method === "GET") {
    const one = url.searchParams.get("id");
    if (one) {
      if (!ID_RE.test(one)) return json({ ok: false, error: "id tidak valid" }, 400);
      const raw = await kv.get(`ws:${ws}:d:${one}`);
      if (!raw) return json({ ok: false, error: "draft tidak ditemukan" }, 404);
      return json({ ok: true, draft: JSON.parse(raw) });
    }
    const keys = await listKeys(kv, `ws:${ws}:d:`, MAX_DRAFTS);
    const drafts = [];
    for (const k of keys) {
      const raw = await kv.get(k);
      if (!raw) continue;
      try {
        const d = JSON.parse(raw);
        drafts.push({
          id: d.id, title: d.title || "(tanpa judul)",
          updated_at: d.updated_at || 0,
          blocks_count: Array.isArray(d.blocks) ? d.blocks.length : 0,
          form: d.form || {},
        });
      } catch (_) { /* lewati entri rusak */ }
    }
    drafts.sort((a, b) => b.updated_at - a.updated_at);
    return json({ ok: true, drafts });
  }

  if (p === "/api/drafts" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body) return json({ ok: false, error: "JSON tidak valid" }, 400);
    const err = checkBlocks(body);
    if (err) return json({ ok: false, error: err }, 400);
    let id = String(body.id || "");
    if (!ID_RE.test(id)) id = newId();
    const keys = await listKeys(kv, `ws:${ws}:d:`, MAX_DRAFTS + 1);
    if (!keys.includes(`ws:${ws}:d:${id}`) && keys.length >= MAX_DRAFTS) {
      return json({ ok: false, error: `Batas ${MAX_DRAFTS} draft tercapai. Hapus sebagian dulu.` }, 400);
    }
    const draft = {
      id,
      title: String(body.title || "").slice(0, 120),
      blocks: body.blocks,
      form: {
        chat_id: String((body.form || {}).chat_id || "").slice(0, 64),
        thread_id: String((body.form || {}).thread_id || "").slice(0, 16),
        method: String((body.form || {}).method || "sendRichMessage").slice(0, 32),
        message_id: String((body.form || {}).message_id || "").slice(0, 16),
      },
      updated_at: Date.now(),
    };
    await kv.put(`ws:${ws}:d:${id}`, JSON.stringify(draft));
    return json({ ok: true, id, updated_at: draft.updated_at });
  }

  if (p === "/api/drafts" && req.method === "DELETE") {
    const id = url.searchParams.get("id") || "";
    if (!ID_RE.test(id)) return json({ ok: false, error: "id tidak valid" }, 400);
    await kv.delete(`ws:${ws}:d:${id}`);
    return json({ ok: true });
  }

  // ---------- History ----------
  if (p === "/api/history" && req.method === "GET") {
    const keys = await listKeys(kv, `ws:${ws}:h:`, 200);
    const items = [];
    for (const k of keys) {
      const raw = await kv.get(k);
      if (!raw) continue;
      try { items.push(JSON.parse(raw)); } catch (_) { /* lewati */ }
    }
    items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return json({ ok: true, history: items.slice(0, MAX_HISTORY) });
  }

  if (p === "/api/history" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body) return json({ ok: false, error: "JSON tidak valid" }, 400);
    const err = checkBlocks(body);
    if (err) return json({ ok: false, error: err }, 400);
    const entry = {
      id: newId(),
      ts: Date.now(),
      method: String(body.method || "sendRichMessage").slice(0, 32),
      chat_id: String(body.chat_id || "").slice(0, 64),
      thread_id: String(body.thread_id || "").slice(0, 16),
      message_id: body.message_id != null ? String(body.message_id).slice(0, 16) : null,
      ok: !!body.ok,
      title: String(body.title || "").slice(0, 120),
      blocks: body.blocks,
    };
    await kv.put(`ws:${ws}:h:${entry.id}`, JSON.stringify(entry));
    // Pangkas riwayat lama melebihi batas.
    const keys = await listKeys(kv, `ws:${ws}:h:`, 300);
    if (keys.length > MAX_HISTORY) {
      const entries = [];
      for (const k of keys) {
        const raw = await kv.get(k);
        try { entries.push({ k, ts: JSON.parse(raw).ts || 0 }); } catch (_) { entries.push({ k, ts: 0 }); }
      }
      entries.sort((a, b) => b.ts - a.ts);
      for (const e of entries.slice(MAX_HISTORY)) await kv.delete(e.k);
    }
    return json({ ok: true, id: entry.id });
  }

  if (p === "/api/history" && req.method === "DELETE") {
    const id = url.searchParams.get("id") || "";
    if (!ID_RE.test(id)) return json({ ok: false, error: "id tidak valid" }, 400);
    await kv.delete(`ws:${ws}:h:${id}`);
    return json({ ok: true });
  }

  return json({ ok: false, error: "endpoint tidak dikenal" }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(req, env, url);
      } catch (e) {
        return json({ ok: false, error: String((e && e.message) || e) }, 500);
      }
    }
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response("Not found", { status: 404 });
  },
};
