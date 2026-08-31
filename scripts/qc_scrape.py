#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Quick-commerce scapers (GitHub Actions): blinkit (now) — zepto/jiomart need browser.
Skip items jo food-images branch me already hain (Git Trees listing = source of truth).
Images -> food-images branch. Map -> scraped/blinkit_map.json (main branch)."""
import base64, json, os, random, re, time, threading
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests

TOKEN = os.environ["GH_TOKEN"]
REPO = os.environ.get("GH_REPO", "jackbhai/gharapp-image-factory")
BRANCH = "food-images"
FOLDER = "images/items"
SEED_PATH = os.environ.get("SEED_PATH", "docs/gharapp_seed.json")
MIN_SCORE = 0.5
WORKERS = 4

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
LAT, LON = "28.6139", "77.2090"

STOP = set("the a an of with and or ki ke ka style dish recipe photo image file jpg jpeg png from indian india food foods close shot".split())
def tokens(s):
    return [w for w in re.sub(r"[^a-z0-9 ]", " ", re.sub(r"\([^)]*\)", " ", s.lower())).split() if len(w) > 2 and w not in STOP]
def score(name, title):
    nt = tokens(name)
    if not nt: return 0.0
    tt = set(tokens(title))
    return sum(1 for w in nt if w in tt) / len(nt)
def build_queries(item):
    base = re.sub(r"\s+", " ", item["name"].replace("+", " ")).strip()
    paren = re.search(r"\(([^)]+)\)", item["name"])
    stripped = re.sub(r"\(.*?\)", "", base).strip()
    qs = []
    if len(stripped) >= 3: qs.append(stripped)
    if paren and len(paren.group(1).strip()) >= 3: qs.append(paren.group(1).strip())
    return list(dict.fromkeys(qs))[:2]

def gh_headers():
    return {"Authorization": "Bearer " + TOKEN, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}

def done_ids_from_tree():
    """food-images branch ka pura listing (Git Trees API — 100k+ files handle)."""
    r = requests.get(f"https://api.github.com/repos/{REPO}/git/trees/{BRANCH}?recursive=1", headers=gh_headers(), timeout=60)
    if not r.ok: raise RuntimeError("tree " + str(r.status_code))
    ids = set()
    for t in r.json().get("tree", []):
        p = t.get("path", "")
        if p.startswith(FOLDER + "/") and p.endswith(".jpg"):
            ids.add(p[len(FOLDER) + 1:-4])
    return ids

def gh_upload(item_id, img_bytes):
    path = f"{FOLDER}/{item_id}.jpg"
    url = f"https://api.github.com/repos/{REPO}/contents/{path}"
    body = {"message": f"blinkit img: {item_id}", "content": base64.b64encode(img_bytes).decode(), "branch": BRANCH}
    for _ in range(3):
        r = requests.put(url, headers=gh_headers(), json=body, timeout=60)
        if r.status_code in (200, 201):
            return f"https://cdn.jsdelivr.net/gh/{REPO}@{BRANCH}/{path}"
        if r.status_code == 422:
            g = requests.get(url + f"?ref={BRANCH}", headers=gh_headers(), timeout=30)
            if g.ok and g.json().get("sha"):
                body["sha"] = g.json()["sha"]
                continue
        time.sleep(2)
    raise RuntimeError("gh " + str(r.status_code) + " " + r.text[:80])

def gh_commit_main(path, content_str, msg):
    url = f"https://api.github.com/repos/{REPO}/contents/{path}"
    g = requests.get(url + "?ref=main", headers=gh_headers(), timeout=30)
    body = {"message": msg, "content": base64.b64encode(content_str.encode()).decode(), "branch": "main"}
    if g.ok and g.json().get("sha"): body["sha"] = g.json()["sha"]
    r = requests.put(url, headers=gh_headers(), json=body, timeout=60)
    return r.status_code in (200, 201)

# ---------------- BLINKIT ----------------
def blinkit_search(item):
    best = None
    for q in build_queries(item):
        try:
            r = requests.post(
                f"https://blinkit.com/v1/layout/search?q={requests.utils.quote(q)}&start=0&size=20",
                headers={
                    "accept": "application/json", "content-type": "application/json",
                    "app_client": "consumer_web", "app_version": "52434332",
                    "lat": LAT, "lon": LON, "origin": "https://blinkit.com",
                    "referer": f"https://blinkit.com/s/?q={requests.utils.quote(q)}",
                    "user-agent": UA,
                },
                json={}, timeout=25,
            )
            if r.status_code == 429:
                time.sleep(5 + random.random() * 3); continue
            if r.status_code != 200: continue
            snippets = ((r.json().get("response") or {}).get("snippets") or [])
            for s in snippets[:14]:
                if s.get("widget_type") != "product_card_snippet_type_2": continue
                d = s.get("data") or {}
                name = d.get("display_name")
                name = name.get("text") if isinstance(name, dict) else (name or "")
                imgs = ((d.get("media_container") or {}).get("items") or [])
                img = (imgs[0].get("image") or {}).get("url") if imgs else ((d.get("image") or {}).get("url"))
                if not img: continue
                sc = score(item["name"], name)
                if sc >= MIN_SCORE and (best is None or sc > best[0]):
                    best = (sc, img, name)
            if best and best[0] >= 1.0: break
        except requests.RequestException:
            time.sleep(2)
    return best

def process(item):
    b = blinkit_search(item)
    if not b: return item["id"], None, None
    try:
        ir = requests.get(b[1], headers={"User-Agent": UA}, timeout=30)
        if not ir.ok or len(ir.content) < 8000: return item["id"], None, None
        url = gh_upload(item["id"], ir.content)
        return item["id"], url, b[2]
    except Exception as e:
        print("UPFAIL", item["id"], str(e)[:60], flush=True)
        return item["id"], None, None

def main():
    items = json.load(open(SEED_PATH))["items"]
    done = done_ids_from_tree()
    todo = [it for it in items if it["id"] not in done]
    print(f"BLINKIT scrape start: {len(todo)} pending (already done {len(done)})", flush=True)
    out_map = {}
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(process, it): it for it in todo}
        for i, fu in enumerate(as_completed(futs), 1):
            try: _id, url, title = fu.result()
            except Exception: _id, url, title = futs[fu]["id"], None, None
            if url:
                out_map[_id] = url
            if i % 40 == 0:
                rate = i / max(1, time.time() - t0)
                print(f"[{i}/{len(todo)}] matched {len(out_map)} | {rate:.2f}/s | eta {(len(todo)-i)/max(rate,0.05)/60:.0f} min", flush=True)
            time.sleep(0.3 + random.random() * 0.6)
    ok = gh_commit_main("scraped/blinkit_map.json", json.dumps(out_map), f"blinkit map: {len(out_map)} images")
    print(f"BLINKIT DONE: {len(out_map)}/{len(todo)} matched in {(time.time()-t0)/60:.1f} min | map commit: {ok}", flush=True)

if __name__ == "__main__":
    main()
