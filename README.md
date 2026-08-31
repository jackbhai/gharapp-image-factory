# ⚡ GharApp Image Factory

GitHub Pages pe chalne wali React app — **2,657 Indian food items** seeded, PixelSter (free) se images generate karke **permanent host** (tumhara GitHub repo + jsDelivr CDN / imgbb) pe mirror karti hai, aur end me ready-to-use `gharapp_seed_with_images.json` download deti hai.

## Features
- 🎛 **Live Dashboard** — total/done/pending/failed/speed/ETA + animated progress + live worker activity
- 🖼 **Live Wall** — abhi-abhi bani images real-time
- 🗂 **Explorer** — saara 2,657-item data search/filter (category, status) ke saath
- 📜 **Live Logs** — har event terminal-style
- 📦 **Auto-export** — 100% pe final seed JSON + map auto-download
- 💾 **Resume-safe** — progress browser localStorage me; refresh/crash ke baad wahin se continue
- 🔁 **Auto-retry rounds** + rate-limit cooldown
- 🔐 Keys/PAT **kabhi code me hardcode nahi** — sirf tumhare browser ke localStorage me

## Deploy (naye repo pe — 5 minute)
```bash
./deploy.sh <naya-repo-name>     # e.g. ./deploy.sh gharapp-image-factory
```
Phir GitHub pe repo banao aur push karo (script bata deti hai), aur:
**Repo → Settings → Pages → Source: "Deploy from a branch" → Branch: `main` / `/docs` → Save**
30-60s me site live: `https://<username>.github.io/<repo>/`

## Chalane ka flow
1. Site kholo → Dashboard → provider choose karo (GitHub recommended)
2. GitHub PAT paste karo (fine-grained: **Contents: Read+Write** sirf us repo pe) → **START**
3. Live Wall/Logs dekho ☕
4. End me `gharapp_seed_with_images.json` auto-download — ye GharApp ka final seeded data

## Tech
Vite + React 18 · `docs/` prebuilt bundle (GitHub Pages `/docs` mode) · PixelSter `/api/tti` (Flux) · GitHub Contents API / imgbb API · jsDelivr CDN
