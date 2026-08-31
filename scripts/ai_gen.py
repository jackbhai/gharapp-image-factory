#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AI image generator (GitHub Actions worker) — REVERSED order to pair with sandbox worker.
Pollinations (primary, ~4s) -> PixelSter (fallback). Upload -> food-images via Contents API."""
import base64, json, os, random, re, time
from io import BytesIO
import requests
from PIL import Image

TOKEN = os.environ["GH_TOKEN"]
REPO = "jackbhai/gharapp-image-factory"
BRANCH = "food-images"
FOLDER = "images/items"
SEED_PATH = "public/gharapp_seed.json"
DESC_PATH = "src/data/desc.js"
CDN = f"https://cdn.jsdelivr.net/gh/{REPO}@{BRANCH}/{FOLDER}/"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"

def gh_headers():
    return {"Authorization": "Bearer " + TOKEN, "Accept": "application/vnd.github+json"}

def done_ids():
    r = requests.get(f"https://api.github.com/repos/{REPO}/git/trees/{BRANCH}?recursive=1", headers=gh_headers(), timeout=60)
    r.raise_for_status()
    return {t["path"][len(FOLDER)+1:-4] for t in r.json().get("tree", [])
            if t["path"].startswith(FOLDER + "/") and t["path"].endswith(".jpg")}

def upload(item_id, img_bytes):
    path = f"{FOLDER}/{item_id}.jpg"
    url = f"https://api.github.com/repos/{REPO}/contents/{path}"
    body = {"message": f"ai img: {item_id}", "content": base64.b64encode(img_bytes).decode(), "branch": BRANCH}
    for _ in range(3):
        r = requests.put(url, headers=gh_headers(), json=body, timeout=60)
        if r.status_code in (200, 201): return True
        if r.status_code == 422:
            g = requests.get(url + f"?ref={BRANCH}", headers=gh_headers(), timeout=30)
            if g.ok and g.json().get("sha"):
                body["sha"] = g.json()["sha"]; continue
        time.sleep(2)
    return False

def load_rules():
    try:
        src = open(DESC_PATH, encoding="utf-8").read()
        pairs = re.findall(r'\[R\("((?:[^"\\]|\\.)*)"\),\s*"((?:[^"\\]|\\.)*)"\]', src)
        return [(re.compile(p, re.I), d) for p, d in pairs]
    except Exception:
        return []

def prompt_for(item, rules):
    name = re.sub(r"\s+", " ", item["name"]).strip()
    d = ""
    for rx, desc in rules:
        if rx.search(name): d = desc; break
    subject = (d or name)
    return (f"Studio food photograph of {subject} ({name}), single serving on a plain ceramic plate, "
            "seamless white background, soft natural daylight, sharp focus on the food, appetizing, "
            "ultra realistic, professional food photography, close-up, no people, no hands, no text, no kitchen")

def via_pollinations(prompt):
    u = ("https://image.pollinations.ai/prompt/" + requests.utils.quote(prompt[:400])
         + f"?width=1024&height=1024&nologo=true&seed={random.randint(1,10**8)}")
    r = requests.get(u, timeout=150, headers={"User-Agent": UA})
    return r.content if r.status_code == 200 and len(r.content) > 20000 else None

def via_pixelster(prompt):
    try:
        r = requests.post("https://ahm7xmakki.com/api/tti", json={"prompt": prompt, "ratio": "1:1"}, timeout=90)
        if r.status_code != 200: return None
        d = r.json()
        url = d.get("imageUrl") or d.get("url") or (d.get("data") or {}).get("url")
        if not url: return None
        ir = requests.get(url, timeout=60)
        return ir.content if ir.ok and len(ir.content) > 15000 else None
    except requests.RequestException:
        return None

def to_jpeg(raw):
    im = Image.open(BytesIO(raw)); im.load(); im = im.convert("RGB")
    im.thumbnail((1000, 1000), Image.LANCZOS)
    buf = BytesIO(); im.save(buf, "JPEG", quality=88, optimize=True)
    return buf.getvalue()

def work(it, rules):
    p = prompt_for(it, rules)
    raw = None
    try: raw = via_pollinations(p)
    except requests.RequestException: raw = None
    if not raw:
        time.sleep(1)
        try: raw = via_pollinations(p)
        except requests.RequestException: raw = None
    if not raw: raw = via_pixelster(p)
    if not raw: return it["id"], False
    try:
        return it["id"], upload(it["id"], to_jpeg(raw))
    except Exception as e:
        print("ERR", it["id"], str(e)[:80], flush=True)
        return it["id"], False

def main():
    from concurrent.futures import ThreadPoolExecutor, as_completed
    items = json.load(open(SEED_PATH))["items"]
    rules = load_rules()
    done = done_ids()
    pending = [it for it in reversed(items) if it["id"] not in done]   # REVERSED
    SHARD = int(os.environ.get("SHARD", "0")); NSHARDS = int(os.environ.get("NSHARDS", "1"))
    pending = [it for i, it in enumerate(pending) if i % NSHARDS == SHARD]
    print(f"GH-AI shard{SHARD}/{NSHARDS} | TOTAL {len(items)} | HAVE {len(done)} | GEN {len(pending)}", flush=True)
    gen = fail = processed = 0
    t0 = time.time()
    from threading import Lock
    lock = Lock()
    with ThreadPoolExecutor(max_workers=5) as ex:
        futs = {ex.submit(work, it, rules): it for it in pending}
        for fut in as_completed(futs):
            _, ok = fut.result()
            with lock:
                processed += 1
                if ok: gen += 1
                else: fail += 1
                if processed % 20 == 0:
                    el = time.time() - t0
                    print(f"[{processed}/{len(pending)}] gen={gen} fail={fail} {el/processed:.2f}s/it ETA={(len(pending)-processed)*(el/processed)/60:.0f}m", flush=True)
    print(f"GH-AI FINISHED gen={gen} fail={fail}", flush=True)

if __name__ == "__main__":
    main()
