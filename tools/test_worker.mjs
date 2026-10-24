// Tes lokal worker HaruRich dengan KV & ASSETS tiruan.
// Jalankan: node tools/test_worker.mjs
import worker from "../src/worker.js";

class MockKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v) { this.m.set(k, String(v)); }
  async delete(k) { this.m.delete(k); }
  async list({ prefix }) {
    return { keys: [...this.m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
  }
}
const env = {
  HARURICH_KV: new MockKV(),
  ASSETS: { fetch: async () => new Response("STATIC-OK", { status: 200 }) },
};
const WS = "test-workspace-1234";
const H = { "x-workspace-id": WS, "content-type": "application/json" };
let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log("✓", name); } else { fail++; console.log("✗ GAGAL:", name); } }
async function call(path, opts = {}) {
  const req = new Request("https://harurich.pages.dev" + path, opts);
  return worker.fetch(req, env);
}

// health
let r = await call("/api/health"); let j = await r.json();
check("health ok + kv true", j.ok && j.kv === true);

// ws tidak valid -> 400
r = await call("/api/drafts", { headers: { "x-workspace-id": "x" } }); j = await r.json();
check("workspace invalid ditolak", r.status === 400 && !j.ok);

// simpan draft
const draftBody = { title: "Tes Draft", blocks: [{ type: "heading", text: "Halo", size: 2 }, { type: "paragraph", text: "Isi" }], form: { chat_id: "-100123", method: "sendRichMessage" } };
r = await call("/api/drafts", { method: "POST", headers: H, body: JSON.stringify(draftBody) }); j = await r.json();
check("simpan draft ok", j.ok && !!j.id);
const did = j.id;

// daftar draft -> meta saja
r = await call("/api/drafts", { headers: H }); j = await r.json();
check("daftar draft berisi 1 + blocks_count 2", j.ok && j.drafts.length === 1 && j.drafts[0].blocks_count === 2 && !("blocks" in j.drafts[0]));

// ambil satu draft utuh
r = await call(`/api/drafts?id=${did}`, { headers: H }); j = await r.json();
check("ambil draft utuh", j.ok && j.draft.blocks.length === 2 && j.draft.form.chat_id === "-100123");

// update draft yang sama (id sama -> tidak dobel)
draftBody.id = did; draftBody.title = "Tes Draft v2";
r = await call("/api/drafts", { method: "POST", headers: H, body: JSON.stringify(draftBody) }); j = await r.json();
r = await call("/api/drafts", { headers: H }); j = await r.json();
check("update draft tidak dobel", j.ok && j.drafts.length === 1 && j.drafts[0].title === "Tes Draft v2");

// blocks kosong ditolak
r = await call("/api/drafts", { method: "POST", headers: H, body: JSON.stringify({ title: "x", blocks: [] }) }); j = await r.json();
check("blocks kosong ditolak", r.status === 400);

// riwayat: catat + baca
r = await call("/api/history", { method: "POST", headers: H, body: JSON.stringify({ method: "sendRichMessage", chat_id: "-100123", message_id: 77, ok: true, title: "Tes", blocks: draftBody.blocks }) }); j = await r.json();
check("catat riwayat ok", j.ok);
r = await call("/api/history", { headers: H }); j = await r.json();
check("riwayat terbaca + message_id", j.ok && j.history.length === 1 && j.history[0].message_id === "77");

// workspace lain tidak bisa melihat data
r = await call("/api/drafts", { headers: { "x-workspace-id": "workspace-lain-9999" } }); j = await r.json();
check("isolasi workspace", j.ok && j.drafts.length === 0);

// hapus draft
r = await call(`/api/drafts?id=${did}`, { method: "DELETE", headers: H }); j = await r.json();
r = await call("/api/drafts", { headers: H }); j = await r.json();
check("hapus draft", j.ok && j.drafts.length === 0);

// aset statis fallback
r = await call("/index.html"); const t = await r.text();
check("static ASSETS fallback", t === "STATIC-OK");

console.log(`\n${pass} lolos, ${fail} gagal`);
process.exit(fail ? 1 : 0);
