#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GitHub Actions runner pe BigBasket mass image scrape.
Fresh IP + curl_cffi (Chrome TLS impersonation) + gentle rate.
Images -> repo food-images branch (Contents API, GITHUB_TOKEN).
Map -> bb_map.json (artifact me download hoga)."""
import base64, json, os, random, re, sys, time, threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from curl_cffi import requests as cr
import requests

TOKEN = os.environ["GH_TOKEN"]
REPO = os.environ.get("GH_REPO", "jackbhai/gharapp-image-factory")
BRANCH = "food-images"
FOLDER = "images/items"
SEED_PATH = os.environ.get("SEED_PATH", "docs/gharapp_seed.json")
MAP = "bb_map.json"
MIN_SCORE = 0.5
WORKERS = 3

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
LOC = {"bb_location": "110001", "bb_pincode": "110001", "bb_city": "New Delhi", "bb_lat": "28.6139", "bb_lon": "77.2090"}
HOME = "https://www.bigbasket.com/"
API = "https://www.bigbasket.com/listing-svc/v2/products"

STOP = set("the a an of with and or ki ke ka style dish recipe photo image file jpg jpeg png from indian india food foods close shot".split())

def tokens(s):
    return [w for w in re.sub(r"[^a-z0-9 ]", " ", re.sub(r"\([^)]*\)", " ", s.lower())).split() if len(w) > 2 and w not in STOP]

def score(name, title):
    nt = tokens(name)
    if not nt:
        return 0.0
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

jar_lock = threading.Lock()
jar = {"s": None}

def fresh_session():
    s = cr.Session(impersonate="chrome124")
    s.cookies.update(LOC)
    try:
        s.get(HOME, timeout=25, headers={"x-channel": "BB-WEB"})
    except Exception as e:
        print("jar err", str(e)[:80], flush=True)
    return s

def get_sess():
    with jar_lock:
        if jar["s"] is None:
            jar["s"] = fresh_session()
        return jar["s"]

def reset_sess():
    with jar_lock:
        jar["s"] = fresh_session()
    return jar["s"]

def gh_headers():
    return {"Authorization": "Bearer " + TOKEN, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}

def gh_upload(item_id, img_bytes):
    path = f"{FOLDER}/{item_id}.jpg"
    url = f"https://api.github.com/repos/{REPO}/contents/{path}"
    body = {"message": f"bb img: {item_id}", "content": base64.b64encode(img_bytes).decode(), "branch": BRANCH}
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

def load_map():
    try:
        return json.load(open(MAP))
    except Exception:
        return {}

map_lock = threading.Lock()
def save_map(m):
    with map_lock:
        json.dump(m, open(MAP, "w"))

def process(item):
    sess = get_sess()
    best = None
    for q in build_queries(item):
        try:
            r = sess.get(API, params={"type": "ps", "slug": q, "page": 1, "bucket_id": 1},
                         headers={"x-channel": "BB-WEB", "Referer": HOME + "ps/?q=" + q}, timeout=30)
            if r.status_code in (400, 403):
                sess = reset_sess()
                time.sleep(3 + random.random() * 3)
                r = sess.get(API, params={"type": "ps", "slug": q, "page": 1, "bucket_id": 1},
                             headers={"x-channel": "BB-WEB"}, timeout=30)
            if r.status_code != 200:
                continue
            prods = ((r.json().get("tabs") or [{}])[0].get("product_info") or {}).get("products") or []
            for p in prods[:12]:
                title = ((p.get("desc") or "") + " " + ((p.get("brand") or {}).get("name") or "")).strip()
                sc = score(item["name"], title)
                if sc >= MIN_SCORE and (best is None or sc > best[0]):
                    img = (p.get("images") or [{}])[0]
                    u = img.get("l") or img.get("m") or img.get("s")
                    if u:
                        best = (sc, u, title)
            if best:
                break
        except Exception:
            time.sleep(1.5)
    if not best:
        return item["id"], None, None
    try:
        ir = cr.get(best[1], impersonate="chrome124", timeout=30)
        if not ir.ok or len(ir.content) < 8000:
            return item["id"], None, None
        url = gh_upload(item["id"], ir.content)
        return item["id"], url, best[2]
    except Exception as e:
        print("UPFAIL", item["id"], str(e)[:60], flush=True)
        return item["id"], None, None

def ensure_branch():
    r = requests.get(f"https://api.github.com/repos/{REPO}/git/ref/heads/{BRANCH}", headers=gh_headers(), timeout=20)
    if r.ok:
        return
    j = requests.get(f"https://api.github.com/repos/{REPO}", headers=gh_headers(), timeout=20).json()
    ref = requests.get(f"https://api.github.com/repos/{REPO}/git/ref/heads/{j['default_branch']}", headers=gh_headers(), timeout=20).json()
    requests.post(f"https://api.github.com/repos/{REPO}/git/refs", headers=gh_headers(),
                  json={"ref": f"refs/heads/{BRANCH}", "sha": ref["object"]["sha"]}, timeout=20)

def main():
    ensure_branch()
    items = json.load(open(SEED_PATH))["items"]
    m = load_map()
    todo = [it for it in items if it["id"] not in m]
    print(f"BB scrape start: {len(todo)} items (resume, done {len(m)})", flush=True)
    got = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(process, it): it for it in todo}
        for i, fu in enumerate(as_completed(futs), 1):
            try:
                _id, url, title = fu.result()
            except Exception:
                _id, url, title = futs[fu]["id"], None, None
            if url:
                m[_id] = url
                got += 1
            if i % 40 == 0:
                save_map(m)
                rate = i / max(1, time.time() - t0)
                print(f"[{i}/{len(todo)}] matched {got} | {rate:.2f}/s | eta {(len(todo)-i)/max(rate,0.05)/60:.0f} min", flush=True)
            time.sleep(0.4 + random.random() * 0.8)
    save_map(m)
    print(f"BB DONE: {got}/{len(todo)} matched in {(time.time()-t0)/60:.1f} min", flush=True)
    print(f"MAP_TOTAL {len(m)}", flush=True)

if __name__ == "__main__":
    main()
