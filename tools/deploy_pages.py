#!/usr/bin/env python3
"""Deploy HaruRich ke Cloudflare Pages (project: harurich) via Direct Upload API.

- Menyalin src/worker.js -> public/_worker.js (Pages advanced mode).
- Membuat project bila belum ada + memasang binding KV HARURICH_KV
  lewat deployment_configs.
- Hash aset = blake3(base64(isi) + ekstensi tanpa titik)[:32] (protokol Pages).
Kredensial: custom.cloudflare (surrogate); endpoint assets memakai JWT
dari upload-token.
"""
import base64
import json
import os
import shutil
import sys
import urllib.error
import urllib.request
import uuid

from blake3 import blake3

for _cand in ("/opt/muse/skills/custom-connector-setup/bin",
              "/opt/muse/skills/custom-connector-setup/templates/skill/bin",
              "/opt/hatch/workflow-skills/custom-connector-setup/bin"):
    if os.path.isdir(_cand) and _cand not in sys.path:
        sys.path.insert(0, _cand)
from dynamic_credentials import add_surrogate_to_request, read_json_response

API = "https://api.cloudflare.com"
NAME = "harurich"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, "public")
KV_ID = "d56e2b340f4e4205a4af7f599de60ade"
COMPAT = "2026-10-12"
FILES = ["index.html", "style.css", "app.js"]  # _worker.js dikirim sebagai part multipart khusus saat deployment (advanced mode), bukan aset statis
CTYPES = {"html": "text/html", "css": "text/css", "js": "application/javascript"}


def api(method, path, data=None, content_type=None, timeout=120, jwt=None,
        tolerate=False):
    req = urllib.request.Request(API + path, data=data, method=method)
    if content_type:
        req.add_header("Content-Type", content_type)
    if jwt:
        req.add_header("Authorization", f"Bearer {jwt}")
    else:
        add_surrogate_to_request(req, "custom.cloudflare",
                                 allowed_hosts=["api.cloudflare.com"])
    try:
        return read_json_response(urllib.request.urlopen(req, timeout=timeout))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:1500]
        if tolerate:
            try:
                return json.loads(body)
            except Exception:
                return {"success": False, "raw": body}
        raise SystemExit(f"HTTP {e.code} {e.reason} @ {path}\n{body}")


def main():
    # Build: worker -> public/_worker.js
    shutil.copyfile(os.path.join(ROOT, "src", "worker.js"),
                    os.path.join(PUBLIC, "_worker.js"))
    print("build: _worker.js tersalin", flush=True)

    accs = api("GET", "/client/v4/accounts", timeout=30)
    aid = accs["result"][0]["id"]
    print("ACCOUNT_ID=", aid, flush=True)

    # 1) project (toleransi sudah ada)
    r = api("POST", f"/client/v4/accounts/{aid}/pages/projects",
            data=json.dumps({"name": NAME, "production_branch": "main"}).encode(),
            content_type="application/json", tolerate=True)
    print("project ok/exists:", r.get("success"), flush=True)

    # 2) binding KV + compatibility date di deployment_configs
    cfg = {"kv_namespaces": {"HARURICH_KV": {"namespace_id": KV_ID}},
           "compatibility_date": COMPAT, "fail_open": True}
    r = api("PATCH", f"/client/v4/accounts/{aid}/pages/projects/{NAME}",
            data=json.dumps({"deployment_configs": {"production": cfg, "preview": cfg}}).encode(),
            content_type="application/json", tolerate=True)
    print("deployment_configs:", r.get("success"),
          json.dumps(r.get("errors") or "")[:200], flush=True)

    # 3) upload token
    r = api("GET", f"/client/v4/accounts/{aid}/pages/projects/{NAME}/upload-token")
    jwt = (r.get("result") or {}).get("jwt")
    if not jwt:
        raise SystemExit(f"upload-token gagal: {json.dumps(r)[:400]}")
    print("jwt OK", flush=True)

    # 4) hash + check-missing + upload aset yang kurang
    assets = {}  # hash -> (path, b64, ctype)
    for fname in FILES:
        content = open(os.path.join(PUBLIC, fname), "rb").read()
        b64 = base64.b64encode(content)
        ext = fname.rsplit(".", 1)[-1]
        h = blake3(b64 + ext.encode()).hexdigest()[:32]
        assets[h] = ("/" + fname, b64.decode(), CTYPES.get(ext, "application/octet-stream"))
        print(f"asset {fname}: {h}", flush=True)
    hashes = list(assets.keys())
    r = api("POST", "/client/v4/pages/assets/check-missing",
            data=json.dumps({"hashes": hashes}).encode(),
            content_type="application/json", jwt=jwt)
    missing = r.get("result") or []
    print("missing:", missing, flush=True)
    payload = [{"key": h, "value": assets[h][1],
                "metadata": {"contentType": assets[h][2]}, "base64": True}
               for h in missing]
    if payload:
        r = api("POST", "/client/v4/pages/assets/upload",
                data=json.dumps(payload).encode(),
                content_type="application/json", jwt=jwt)
        print("upload:", r.get("success"), flush=True)
    r = api("POST", "/client/v4/pages/assets/upsert-hashes",
            data=json.dumps({"hashes": hashes}).encode(),
            content_type="application/json", jwt=jwt)
    print("upsert:", r.get("success"), flush=True)

    # 5) deployment: manifest aset + part _worker.js (advanced mode)
    boundary = uuid.uuid4().hex
    manifest = json.dumps({assets[h][0]: h for h in hashes})
    worker_code = open(os.path.join(PUBLIC, "_worker.js"), "rb").read()
    body = b"".join([
        f"--{boundary}\r\n".encode(),
        b'Content-Disposition: form-data; name="manifest"\r\n'
        b"Content-Type: application/json\r\n\r\n" + manifest.encode() + b"\r\n",
        f"--{boundary}\r\n".encode(),
        b'Content-Disposition: form-data; name="_worker.js"; filename="_worker.js"\r\n'
        b"Content-Type: application/javascript\r\n\r\n" + worker_code + b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ])
    r = api("POST", f"/client/v4/accounts/{aid}/pages/projects/{NAME}/deployments",
            data=body, content_type=f"multipart/form-data; boundary={boundary}")
    if not r.get("success"):
        raise SystemExit(f"deployment gagal: {json.dumps(r)[:600]}")
    print("DEPLOY_OK", (r.get("result") or {}).get("url"), flush=True)
    print(f"URL=https://{NAME}.pages.dev", flush=True)


if __name__ == "__main__":
    main()
