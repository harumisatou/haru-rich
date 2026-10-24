# 🌸 HaruRich — Telegram Rich Message Sender

Web tool untuk mengirim **pesan Telegram Rich Text** (`sendRichMessage`, Bot API 10.1+ / mode blocks 10.2+) langsung dari browser, pakai **bot token milik pengguna sendiri**.

🔗 **Live:** https://harurich.pages.dev
📦 **Repo:** https://github.com/harumisatou/haru-rich

## Fitur

- **Token + method + tujuan**: bot token, pilih `sendRichMessage` / `editMessageText`, chat_id (+ topic ID & message_id untuk edit), tombol Cek Bot (`getMe`) dan ambil chat_id dari `getUpdates`.
- **Builder bebas** — format tidak dikunci ke satu template:
  - Mode **Builder visual** (blok: Judul, Paragraf, Quote, Foto, Divider, Details lipat, Pre/Kode, Collage, Footer) dengan tombol ganti tipe blok, naik/turun, duplikat, hapus.
  - Mode teks per blok: **teks polos** atau **RichText JSON** (bold, italic, url, code, dll).
  - Mode isi Details: Pre/MediaInfo, Paragraf, atau Collage foto (SHOTS).
  - Mode **JSON** untuk JSON blocks mentah apa pun (termasuk blok tanpa editor visual), dan mode **Preview** mirip Telegram.
  - Preset contoh: Pengumuman, Rilisan (ala Haru), Tutorial — semuanya bebas diedit.
  - Penghitung blok & karakter (batas Telegram: 500 blok, ±32.768 karakter).
- **Draft & riwayat di server** (Cloudflare KV): simpan draft, riwayat kirim otomatis tercatat, pesan terkirim bisa dimuat lagi lalu **diedit di tempat** lewat `editMessageText`. Data dipisah per *workspace anonim* (ID acak yang dibuat browser, disimpan di localStorage perangkat).

## Keamanan token

**Bot token TIDAK PERNAH dikirim/disimpan ke server HaruRich.** Browser pengguna memanggil `api.telegram.org` langsung. Server hanya menerima isi blocks, tujuan, dan message_id untuk draft/riwayat — tanpa token. Opsi "ingat token" hanya menyimpan token di localStorage perangkat pengguna sendiri.

## Arsitektur

- Cloudflare Pages (advanced mode): aset statis di `public/`, worker di `src/worker.js` (disalin jadi `public/_worker.js` saat build/deploy) menangani `/api/*` + menyajikan aset via binding `ASSETS`.
- Penyimpanan: Cloudflare KV namespace `harurich-store` (binding `HARURICH_KV`), kunci `ws:<workspaceId>:d:<draftId>` & `ws:<workspaceId>:h:<historyId>`.
- Deploy: `python3 tools/deploy_pages.py` (Direct Upload API, pola yang sama seperti project Pages Haru lainnya).

## Pengembangan lokal

```bash
node tools/test_worker.mjs   # tes worker dengan KV/ASSETS tiruan
python3 tools/deploy_pages.py  # build + deploy ke harurich.pages.dev
```
