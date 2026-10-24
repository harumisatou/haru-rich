// HaruRich — Telegram Rich Message Sender (frontend)
// Token bot TIDAK dikirim ke server HaruRich: semua panggilan Telegram
// dilakukan browser ini langsung ke api.telegram.org.
// Server hanya menyimpan draft & riwayat (per workspace anonim), tanpa token.
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------- Workspace anonim (pemisah draft/riwayat antar pengguna) ----------
let WS = localStorage.getItem("harurich_ws");
if (!WS) {
  WS = (crypto.randomUUID ? crypto.randomUUID() : "ws" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
  localStorage.setItem("harurich_ws", WS);
}

// ---------- State ----------
let blocks = [];
let currentDraftId = null;
let mode = "builder";
// KV Cloudflare bersifat eventually consistent (daftar bisa telat s/d ~60 dtk
// antar-PoP). Hint lokal ini menambal tampilan sesaat setelah simpan/kirim,
// dan deletedIds menyembunyikan entri yang baru dihapus sampai server sinkron.
let hintDraft = null;
let hintHistory = null;
const deletedIds = new Set();

const BLOCK_TYPES = ["heading", "paragraph", "blockquote", "photo", "divider", "details", "pre", "collage", "footer"];
const TYPE_LABEL = { heading: "Judul", paragraph: "Paragraf", blockquote: "Quote", photo: "Foto", divider: "Divider", details: "Details (lipat)", pre: "Pre / Kode", collage: "Collage", footer: "Footer" };

const photoBlock = (u) => ({ type: "photo", photo: { type: "photo", media: String(u || "").trim() } });
const photoUrl = (b) => (b && b.photo && b.photo.media) || b.media || "";

function defaultBlock(type) {
  switch (type) {
    case "heading": return { type, text: "Judul Bagian", size: 2 };
    case "paragraph": return { type, text: "Tulis teks di sini…" };
    case "blockquote": return { type, blocks: [{ type: "paragraph", text: "Kutipan / sinopsis…" }] };
    case "photo": return photoBlock("https://contoh.com/gambar.jpg");
    case "divider": return { type };
    case "details": return { type, summary: "MEDIAINFO", is_open: false, blocks: [{ type: "pre", text: "Isi yang bisa dilipat…" }] };
    case "pre": return { type, text: "teks monospace…" };
    case "collage": return { type, blocks: [photoBlock("https://contoh.com/1.jpg"), photoBlock("https://contoh.com/2.jpg")] };
    case "footer": return { type, text: "Catatan kaki…" };
    default: return { type: "paragraph", text: "" };
  }
}

function anyText(b) {
  if (!b) return "";
  if (typeof b.text === "string") return b.text;
  if (Array.isArray(b.text)) return b.text.map((s) => (typeof s === "string" ? s : s.text || "")).join("");
  if (Array.isArray(b.blocks) && b.blocks[0]) return anyText(b.blocks[0]);
  return "";
}

function convertBlock(b, type) {
  const t = anyText(b);
  const nb = defaultBlock(type);
  if (type === "heading") nb.text = t || nb.text;
  if (type === "paragraph" || type === "pre" || type === "footer") nb.text = t || nb.text;
  if (type === "blockquote") nb.blocks[0].text = t || nb.blocks[0].text;
  if (type === "photo") { const u = photoUrl(b); if (u) nb.photo.media = u; }
  if (type === "details") nb.blocks[0].text = t || nb.blocks[0].text;
  return nb;
}

// ---------- Presets ----------
function preset(name) {
  if (name === "blank") return [];
  if (name === "announce") return [
    { type: "heading", text: "📣 Pengumuman", size: 2 },
    { type: "paragraph", text: "Halo semua! Ada info penting hari ini…" },
    { type: "divider" },
    { type: "paragraph", text: ["Detail lengkapnya bisa dibaca di ", { type: "url", text: "tautan ini", url: "https://example.com" }, "."] },
    { type: "footer", text: "— Admin" },
  ];
  if (name === "tutorial") return [
    { type: "heading", text: "📚 Judul Tutorial", size: 2 },
    { type: "paragraph", text: "Pembuka tutorial…" },
    { type: "heading", text: "Langkah 1", size: 3 },
    { type: "paragraph", text: "Jelaskan langkahnya di sini." },
    { type: "details", summary: "Contoh kode / detail (klik buat buka)", is_open: false, blocks: [{ type: "pre", text: "{\n  \"contoh\": true\n}" }] },
    { type: "footer", text: "Semoga membantu 🌸" },
  ];
  // release — ala format rilisan Haru (hanya contoh, bebas diubah)
  return [
    photoBlock("https://image.tmdb.org/t/p/w1280/backdrop.jpg"),
    { type: "heading", text: "Judul Film (2026)", size: 2 },
    { type: "blockquote", blocks: [{ type: "paragraph", text: "Sinopsis singkat filmnya di sini…" }] },
    { type: "divider" },
    { type: "paragraph", text: [{ type: "bold", text: "Judul.Film.2026.1080p.WEB-DL.mkv" }, "\n💾 Ukuran: 1.4 GB\n", { type: "url", text: "HaruDrive", url: "https://example.com/file" }, " | ", { type: "url", text: "Transfer.it", url: "https://example.com/file2" }] },
    { type: "details", summary: "SHOTS", is_open: false, blocks: [{ type: "collage", blocks: [photoBlock("https://contoh.com/shot1.jpg"), photoBlock("https://contoh.com/shot2.jpg")] }] },
    { type: "details", summary: "MEDIAINFO", is_open: false, blocks: [{ type: "pre", text: "Filename : Judul.Film.2026.1080p.WEB-DL.mkv\nFormat : Matroska\n…" }] },
    { type: "footer", text: "📢 Join: https://t.me/channelkamu" },
  ];
}

// ---------- Builder UI ----------
const blocksEl = $("#blocks");

function field(labelText, el) {
  const wrap = document.createElement("div");
  const lab = document.createElement("label"); lab.textContent = labelText;
  wrap.append(lab, el); return wrap;
}
function textInput(value, oninput, placeholder) {
  const i = document.createElement("input"); i.type = "text"; i.value = value || ""; i.placeholder = placeholder || "";
  i.addEventListener("input", () => oninput(i.value)); return i;
}
function textArea(value, oninput, rows) {
  const t = document.createElement("textarea"); t.value = value || ""; t.rows = rows || 3; t.spellcheck = false;
  t.addEventListener("input", () => oninput(t.value)); return t;
}

function renderBlocks() {
  blocksEl.innerHTML = "";
  blocks.forEach((b, idx) => blocksEl.appendChild(blockCard(b, idx)));
  updateCounters();
}

function blockCard(b, idx) {
  const card = document.createElement("div"); card.className = "block-card";
  const head = document.createElement("div"); head.className = "block-head";
  const name = document.createElement("span"); name.className = "btype"; name.textContent = `${idx + 1}. ${TYPE_LABEL[b.type] || b.type}`;
  const switcher = document.createElement("select"); switcher.title = "Ganti tipe blok";
  BLOCK_TYPES.forEach((t) => { const o = document.createElement("option"); o.value = t; o.textContent = TYPE_LABEL[t]; switcher.appendChild(o); });
  switcher.value = b.type;
  switcher.addEventListener("change", () => { blocks[idx] = convertBlock(b, switcher.value); renderBlocks(); });
  const ops = document.createElement("div"); ops.className = "ops";
  const mk = (label, title, fn) => { const btn = document.createElement("button"); btn.type = "button"; btn.textContent = label; btn.title = title; btn.addEventListener("click", fn); return btn; };
  ops.append(
    mk("↑", "Naik", () => { if (idx > 0) { [blocks[idx - 1], blocks[idx]] = [blocks[idx], blocks[idx - 1]]; renderBlocks(); } }),
    mk("↓", "Turun", () => { if (idx < blocks.length - 1) { [blocks[idx + 1], blocks[idx]] = [blocks[idx], blocks[idx + 1]]; renderBlocks(); } }),
    mk("⧉", "Duplikat", () => { blocks.splice(idx + 1, 0, JSON.parse(JSON.stringify(b))); renderBlocks(); }),
    mk("🗑", "Hapus", () => { blocks.splice(idx, 1); renderBlocks(); }),
  );
  head.append(name, switcher, ops); card.appendChild(head);

  const body = document.createElement("div");
  if (b.type === "heading") {
    body.appendChild(field("Teks judul", textInput(b.text, (v) => { b.text = v; updateCounters(); })));
    const sel = document.createElement("select");
    [1, 2, 3, 4, 5, 6].forEach((n) => { const o = document.createElement("option"); o.value = n; o.textContent = "Ukuran " + n; sel.appendChild(o); });
    sel.value = b.size || 2; sel.addEventListener("change", () => { b.size = Number(sel.value); });
    body.appendChild(field("Ukuran", sel));
  } else if (b.type === "paragraph" || b.type === "footer" || b.type === "pre") {
    const isRich = Array.isArray(b.text);
    const modeSel = document.createElement("select");
    [["plain", "Teks polos"], ["rich", "RichText JSON (bold/url/dll)"]].forEach(([v, l]) => { const o = document.createElement("option"); o.value = v; o.textContent = l; modeSel.appendChild(o); });
    modeSel.value = isRich ? "rich" : "plain";
    const ta = textArea(isRich ? JSON.stringify(b.text, null, 1) : (b.text || ""), () => {});
    const err = document.createElement("div"); err.className = "error";
    const apply = () => {
      if (modeSel.value === "plain") { b.text = ta.value; err.textContent = ""; }
      else {
        try { const v = JSON.parse(ta.value); if (!Array.isArray(v)) throw new Error("harus array"); b.text = v; err.textContent = ""; }
        catch (e) { err.textContent = "RichText JSON belum valid: " + e.message; return; }
      }
      updateCounters();
    };
    ta.addEventListener("input", apply);
    modeSel.addEventListener("change", () => {
      if (modeSel.value === "rich" && !Array.isArray(b.text)) { b.text = [String(b.text || "")]; ta.value = JSON.stringify(b.text, null, 1); }
      if (modeSel.value === "plain" && Array.isArray(b.text)) { b.text = anyText(b); ta.value = b.text; }
      apply();
    });
    body.append(field("Mode teks", modeSel), field("Teks", ta), err);
  } else if (b.type === "blockquote") {
    if (!Array.isArray(b.blocks) || !b.blocks[0]) b.blocks = [{ type: "paragraph", text: "" }];
    body.appendChild(field("Isi quote (paragraf di dalamnya)", textArea(anyText(b), (v) => { b.blocks[0] = { type: "paragraph", text: v }; updateCounters(); }, 3)));
  } else if (b.type === "photo") {
    body.appendChild(field("URL foto", textInput(photoUrl(b), (v) => { b.photo = { type: "photo", media: v.trim() }; delete b.media; updateCounters(); })));
  } else if (b.type === "collage") {
    const urls = (b.blocks || []).map(photoUrl).join("\n");
    body.appendChild(field("URL foto, satu per baris (maks 10)", textArea(urls, (v) => {
      b.blocks = v.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 10).map(photoBlock); updateCounters();
    }, 4)));
  } else if (b.type === "details") {
    body.appendChild(field("Summary (judul yang selalu tampil)", textInput(b.summary, (v) => { b.summary = v; updateCounters(); })));
    const openSel = document.createElement("select");
    [["false", "Mulai tertutup (is_open: false)"], ["true", "Mulai terbuka (is_open: true)"]].forEach(([v, l]) => { const o = document.createElement("option"); o.value = v; o.textContent = l; openSel.appendChild(o); });
    openSel.value = String(!!b.is_open); openSel.addEventListener("change", () => { b.is_open = openSel.value === "true"; });
    body.appendChild(field("Keadaan awal", openSel));
    const inner = (Array.isArray(b.blocks) && b.blocks[0]) || { type: "pre", text: "" };
    const innerSel = document.createElement("select");
    [["pre", "Pre / MediaInfo"], ["paragraph", "Paragraf"], ["collage", "Collage foto (SHOTS)"]].forEach(([v, l]) => { const o = document.createElement("option"); o.value = v; o.textContent = l; innerSel.appendChild(o); });
    innerSel.value = inner.type === "collage" ? "collage" : (inner.type === "paragraph" ? "paragraph" : "pre");
    const content = inner.type === "collage" ? (inner.blocks || []).map(photoUrl).join("\n") : (inner.text || "");
    const ta = textArea(content, () => {});
    const applyInner = () => {
      const v = ta.value;
      if (innerSel.value === "collage") b.blocks = [{ type: "collage", blocks: v.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 10).map(photoBlock) }];
      else if (innerSel.value === "paragraph") b.blocks = [{ type: "paragraph", text: v }];
      else b.blocks = [{ type: "pre", text: v }];
      updateCounters();
    };
    ta.addEventListener("input", applyInner);
    innerSel.addEventListener("change", applyInner);
    body.append(field("Mode isi details", innerSel), field(innerSel.value === "collage" ? "URL foto, satu per baris" : "Isi", ta));
  } else if (b.type === "divider") {
    const p = document.createElement("p"); p.className = "muted"; p.textContent = "Garis pemisah — tidak ada isian."; body.appendChild(p);
  } else {
    body.appendChild(field("Blok tipe ini belum ada editor visualnya — edit lewat mode JSON. JSON mentahnya:", textArea(JSON.stringify(b, null, 1), (v) => {
      try { blocks[idx] = JSON.parse(v); updateCounters(); } catch (_) { /* abaikan sampai valid */ }
    }, 4)));
  }
  card.appendChild(body);
  return card;
}

function updateCounters() {
  const n = blocks.length;
  const chars = JSON.stringify({ blocks }).length;
  $("#blockCount").textContent = `${n} blok`;
  $("#blockCount").className = n > 500 ? "over" : "";
  $("#charCount").textContent = `${chars.toLocaleString("id-ID")} karakter`;
  $("#charCount").className = chars > 32768 ? "over" : "";
}

// ---------- Preview ----------
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function richTextHtml(rt) {
  if (typeof rt === "string") return esc(rt).replace(/\n/g, "<br>");
  if (!Array.isArray(rt)) return "";
  return rt.map((s) => {
    if (typeof s === "string") return esc(s).replace(/\n/g, "<br>");
    const t = esc(s.text || "").replace(/\n/g, "<br>");
    switch (s.type) {
      case "bold": return `<b>${t}</b>`;
      case "italic": return `<i>${t}</i>`;
      case "code": return `<code>${t}</code>`;
      case "url": case "text_link": return `<a href="${esc(s.url || "#")}" target="_blank" rel="noopener">${t}</a>`;
      case "underline": return `<u>${t}</u>`;
      case "strikethrough": return `<s>${t}</s>`;
      case "spoiler": return `<span style="background:#333;border-radius:4px">${t}</span>`;
      default: return t;
    }
  }).join("");
}
function blockHtml(b) {
  switch (b.type) {
    case "heading": { const s = Math.min(6, Math.max(1, b.size || 2)); return `<h${s}>${richTextHtml(b.text)}</h${s}>`; }
    case "paragraph": return `<p>${richTextHtml(b.text)}</p>`;
    case "blockquote": return `<blockquote>${(b.blocks || []).map(blockHtml).join("")}</blockquote>`;
    case "photo": return `<img src="${esc(photoUrl(b))}" alt="" loading="lazy">`;
    case "divider": return "<hr>";
    case "details": return `<details ${b.is_open ? "open" : ""}><summary>${esc(b.summary || "")}</summary>${(b.blocks || []).map(blockHtml).join("")}</details>`;
    case "pre": return `<pre>${esc(b.text || "")}</pre>`;
    case "collage": return `<div class="collage">${(b.blocks || []).map((x) => `<img src="${esc(photoUrl(x))}" alt="" loading="lazy">`).join("")}</div>`;
    case "footer": return `<p class="foot">${richTextHtml(b.text)}</p>`;
    default: return `<pre>${esc(JSON.stringify(b, null, 1))}</pre>`;
  }
}

// ---------- Mode tabs ----------
function setMode(m) {
  mode = m;
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === m));
  $("#modeBuilder").style.display = m === "builder" ? "" : "none";
  $("#modeJson").style.display = m === "json" ? "" : "none";
  $("#modePreview").style.display = m === "preview" ? "" : "none";
  if (m === "json") $("#jsonText").value = JSON.stringify({ blocks }, null, 2);
  if (m === "preview") $("#preview").innerHTML = blocks.map(blockHtml).join("") || '<p class="muted">(kosong)</p>';
}
$$(".tab").forEach((t) => t.addEventListener("click", () => setMode(t.dataset.mode)));
$("#applyJson").addEventListener("click", () => {
  try {
    const v = JSON.parse($("#jsonText").value);
    const arr = Array.isArray(v) ? v : v.blocks;
    if (!Array.isArray(arr)) throw new Error("tidak ada array blocks");
    blocks = arr; currentDraftId = currentDraftId; $("#jsonError").textContent = "";
    renderBlocks(); setMode("builder");
  } catch (e) { $("#jsonError").textContent = "JSON tidak valid: " + e.message; }
});
$$("[data-add]").forEach((btn) => btn.addEventListener("click", () => { blocks.push(defaultBlock(btn.dataset.add)); renderBlocks(); }));
$("#preset").addEventListener("change", (e) => {
  if (!e.target.value) return;
  blocks = preset(e.target.value); currentDraftId = null; $("#draftTitle").value = "";
  renderBlocks(); setMode("builder"); e.target.value = "";
});

// ---------- Form & token ----------
const tokenEl = $("#token");
if (localStorage.getItem("harurich_token")) {
  tokenEl.value = localStorage.getItem("harurich_token"); $("#rememberToken").checked = true;
}
$("#rememberToken").addEventListener("change", (e) => {
  if (e.target.checked) localStorage.setItem("harurich_token", tokenEl.value);
  else localStorage.removeItem("harurich_token");
});
tokenEl.addEventListener("input", () => { if ($("#rememberToken").checked) localStorage.setItem("harurich_token", tokenEl.value); });
$("#toggleToken").addEventListener("click", () => { tokenEl.type = tokenEl.type === "password" ? "text" : "password"; });
$("#method").addEventListener("change", (e) => { $("#msgIdRow").style.display = e.target.value === "editMessageText" ? "" : "none"; });

function parseChatId(v) {
  v = String(v || "").trim();
  return /^-?\d+$/.test(v) ? Number(v) : v;
}
async function tgCall(method, payload) {
  const token = tokenEl.value.trim();
  if (!token) throw new Error("Bot token masih kosong.");
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload || {}),
  });
  return r.json();
}
$("#checkBot").addEventListener("click", async () => {
  $("#botInfo").textContent = "Mengecek…";
  try {
    const res = await tgCall("getMe");
    $("#botInfo").textContent = res.ok ? `✅ Bot aktif: @${res.result.username} (${res.result.first_name})` : `❌ ${res.description || "token ditolak"}`;
  } catch (e) { $("#botInfo").textContent = "❌ " + e.message; }
});
$("#findChats").addEventListener("click", async () => {
  const box = $("#chatList"); box.textContent = "Mengambil getUpdates…";
  try {
    const res = await tgCall("getUpdates");
    if (!res.ok) { box.textContent = "❌ " + (res.description || "gagal"); return; }
    const seen = new Map();
    for (const u of res.result || []) {
      for (const k of ["message", "channel_post", "my_chat_member", "chat_member", "edited_message"]) {
        const o = u[k]; if (o && o.chat) seen.set(String(o.chat.id), `${o.chat.title || o.chat.username || o.chat.first_name || ""} (${o.chat.type})`);
      }
    }
    if (!seen.size) { box.textContent = "Belum ada chat yang terlihat — kirim pesan ke bot / jadikan bot admin channel dulu, lalu coba lagi."; return; }
    box.innerHTML = "";
    seen.forEach((label, id) => {
      const btn = document.createElement("button"); btn.type = "button"; btn.className = "small ghost";
      btn.textContent = `${id} — ${label}`; btn.addEventListener("click", () => { $("#chatId").value = id; });
      box.appendChild(btn);
    });
  } catch (e) { box.textContent = "❌ " + e.message; }
});

// ---------- Server API (draft & riwayat) ----------
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { "content-type": "application/json", "x-workspace-id": WS, ...(opts.headers || {}) } });
  return r.json();
}
function formData() {
  return { chat_id: $("#chatId").value.trim(), thread_id: $("#threadId").value.trim(), method: $("#method").value, message_id: $("#messageId").value.trim() };
}
function loadForm(f) {
  if (!f) return;
  if (f.chat_id) $("#chatId").value = f.chat_id;
  if (f.thread_id) $("#threadId").value = f.thread_id;
  if (f.method) { $("#method").value = f.method; $("#msgIdRow").style.display = f.method === "editMessageText" ? "" : "none"; }
  if (f.message_id) $("#messageId").value = f.message_id;
}
const fmtDate = (ts) => new Date(ts).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });

async function refreshLists() {
  const dl = $("#draftList"), hl = $("#historyList");
  try {
    const d = await api("/api/drafts");
    if (!d.ok) { dl.textContent = "⚠️ " + d.error; }
    else {
      const items = d.drafts.filter((x) => !deletedIds.has(x.id));
      if (hintDraft && !items.some((x) => x.id === hintDraft.id) && !deletedIds.has(hintDraft.id)) items.unshift(hintDraft);
      if (!items.length) { dl.textContent = "Belum ada draft tersimpan."; }
      else { dl.innerHTML = "";
      items.forEach((it) => {
        const row = document.createElement("div"); row.className = "item";
        row.innerHTML = `<span class="badge draft">DRAFT</span><div class="meta">${esc(it.title)}<small>${it.blocks_count} blok · ${fmtDate(it.updated_at)}</small></div>`;
        const open = document.createElement("button"); open.className = "small"; open.textContent = "Buka";
        open.addEventListener("click", async () => {
          const one = await api(`/api/drafts?id=${encodeURIComponent(it.id)}`);
          if (!one.ok) { alert(one.error); return; }
          blocks = one.draft.blocks || []; currentDraftId = one.draft.id;
          $("#draftTitle").value = one.draft.title || ""; loadForm(one.draft.form);
          renderBlocks(); setMode("builder");
        });
        const del = document.createElement("button"); del.className = "small"; del.textContent = "🗑";
        del.addEventListener("click", async () => { deletedIds.add(it.id); if (hintDraft && hintDraft.id === it.id) hintDraft = null; await api(`/api/drafts?id=${encodeURIComponent(it.id)}`, { method: "DELETE" }); if (currentDraftId === it.id) currentDraftId = null; refreshLists(); });
        row.append(open, del); dl.appendChild(row);
      });
      }
    }
  } catch (e) { dl.textContent = "⚠️ Gagal memuat draft: " + e.message; }
  try {
    const h = await api("/api/history");
    if (!h.ok) { hl.textContent = "⚠️ " + h.error; }
    else {
      const items = h.history.filter((x) => !deletedIds.has(x.id));
      if (hintHistory && !items.some((x) => x.id === hintHistory.id) && !deletedIds.has(hintHistory.id)) items.unshift(hintHistory);
      if (!items.length) { hl.textContent = "Belum ada riwayat kirim."; }
      else { hl.innerHTML = "";
      items.forEach((it) => {
        const row = document.createElement("div"); row.className = "item";
        row.innerHTML = `<span class="badge sent">${it.ok ? "TERKIRIM" : "GAGAL"}</span><div class="meta">${esc(it.title || "(tanpa judul)")}<small>${esc(it.method)} → ${esc(it.chat_id)}${it.message_id ? " · msg " + esc(it.message_id) : ""} · ${fmtDate(it.ts)}</small></div>`;
        const load = document.createElement("button"); load.className = "small"; load.textContent = "Muat";
        load.addEventListener("click", () => {
          blocks = it.blocks || []; currentDraftId = null; $("#draftTitle").value = it.title || "";
          loadForm({ chat_id: it.chat_id, thread_id: it.thread_id, method: "sendRichMessage" });
          renderBlocks(); setMode("builder");
        });
        row.appendChild(load);
        if (it.ok && it.message_id) {
          const ed = document.createElement("button"); ed.className = "small"; ed.textContent = "✏️ Edit pesan ini";
          ed.addEventListener("click", () => {
            blocks = it.blocks || []; currentDraftId = null; $("#draftTitle").value = it.title || "";
            loadForm({ chat_id: it.chat_id, thread_id: it.thread_id, method: "editMessageText", message_id: it.message_id });
            renderBlocks(); setMode("builder"); window.scrollTo({ top: 0, behavior: "smooth" });
          });
          row.appendChild(ed);
        }
        const del = document.createElement("button"); del.className = "small"; del.textContent = "🗑";
        del.addEventListener("click", async () => { deletedIds.add(it.id); if (hintHistory && hintHistory.id === it.id) hintHistory = null; await api(`/api/history?id=${encodeURIComponent(it.id)}`, { method: "DELETE" }); refreshLists(); });
        row.appendChild(del); hl.appendChild(row);
      });
      }
    }
  } catch (e) { hl.textContent = "⚠️ Gagal memuat riwayat: " + e.message; }
}
$("#refreshLists").addEventListener("click", refreshLists);
$("#newDraft").addEventListener("click", () => { blocks = []; currentDraftId = null; $("#draftTitle").value = ""; renderBlocks(); });

$("#saveDraft").addEventListener("click", async () => {
  const out = $("#sendResult"); out.innerHTML = "";
  if (!blocks.length) { out.innerHTML = '<div class="err-box">Isi pesan masih kosong.</div>'; return; }
  const res = await api("/api/drafts", { method: "POST", body: JSON.stringify({ id: currentDraftId, title: $("#draftTitle").value.trim(), blocks, form: formData() }) });
  if (res.ok) {
    currentDraftId = res.id;
    hintDraft = { id: res.id, title: $("#draftTitle").value.trim() || "(tanpa judul)", updated_at: res.updated_at, blocks_count: blocks.length, form: formData() };
    out.innerHTML = '<div class="ok-box">💾 Draft tersimpan di server.</div>'; refreshLists();
  }
  else out.innerHTML = `<div class="err-box">Gagal menyimpan draft: ${esc(res.error || "?")}</div>`;
});

// ---------- Kirim ----------
$("#send").addEventListener("click", async () => {
  const out = $("#sendResult"); out.innerHTML = "";
  const method = $("#method").value;
  const chatRaw = $("#chatId").value.trim();
  if (!chatRaw) { out.innerHTML = '<div class="err-box">Chat ID tujuan masih kosong.</div>'; return; }
  if (!blocks.length) { out.innerHTML = '<div class="err-box">Isi pesan masih kosong.</div>'; return; }
  if (blocks.length > 500) { out.innerHTML = '<div class="err-box">Blok melebihi 500.</div>'; return; }
  const payload = { chat_id: parseChatId(chatRaw), rich_message: { blocks } };
  const thread = $("#threadId").value.trim();
  if (thread) payload.message_thread_id = Number(thread);
  if (method === "editMessageText") {
    const mid = $("#messageId").value.trim();
    if (!mid) { out.innerHTML = '<div class="err-box">Message ID wajib diisi untuk edit.</div>'; return; }
    payload.message_id = Number(mid);
  }
  out.innerHTML = '<p class="muted">Mengirim ke Telegram…</p>';
  let res;
  try { res = await tgCall(method, payload); }
  catch (e) { out.innerHTML = `<div class="err-box">❌ ${esc(e.message)}</div>`; return; }
  const msgId = res.ok && res.result ? res.result.message_id : null;
  if (res.ok) {
    out.innerHTML = `<div class="ok-box">✅ Terkirim! message_id: ${esc(msgId ?? "?")} di chat ${esc(chatRaw)}</div><pre>${esc(JSON.stringify(res, null, 2))}</pre>`;
  } else {
    out.innerHTML = `<div class="err-box">❌ Telegram menolak: ${esc(res.description || "error")}</div><pre>${esc(JSON.stringify(res, null, 2))}</pre>`;
  }
  // Catat riwayat di server (tanpa token).
  const firstHeading = blocks.find((b) => b.type === "heading");
  const histTitle = $("#draftTitle").value.trim() || (firstHeading ? anyText(firstHeading) : "");
  const hr = await api("/api/history", { method: "POST", body: JSON.stringify({
    method, chat_id: chatRaw, thread_id: thread, message_id: msgId, ok: !!res.ok,
    title: histTitle, blocks,
  }) }).catch(() => null);
  if (hr && hr.ok) hintHistory = { id: hr.id, ts: Date.now(), method, chat_id: chatRaw, thread_id: thread, message_id: msgId != null ? String(msgId) : null, ok: !!res.ok, title: histTitle, blocks };
  refreshLists();
});

// ---------- Init ----------
$("#wsInfo").textContent = "Workspace: " + WS.slice(0, 8) + "…";
blocks = preset("release");
renderBlocks();
refreshLists();
