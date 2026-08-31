// ============================================================
// GharApp Image Factory — core logic
// PixelSter (free, no key) -> mirror to permanent host -> map
// ============================================================
import { DESC } from './data/desc.js'

export const PIXELSTER = 'https://ahm7xmakki.com/api/tti'
export const IMGBB_UP = 'https://api.imgbb.com/1/upload'

// ---------- prompt builder (ported from gen_item_images.py) ----------
export function descFor(name) {
  const n = name.toLowerCase()
  for (const [rx, d] of DESC) if (rx.test(n)) return d
  return null
}

export function promptFor(item) {
  const name = item.name
  const cooked = item.ft === 'cooked'
  const d = descFor(name)
  let what, shot
  if (cooked) {
    what = `${name} — authentic Indian dish` + (d ? `, ${d}` : '')
    shot = 'served in traditional tableware on rustic wooden table, appetizing close-up'
  } else {
    what = d ? `${name} — ${d}` : `${name} — fresh raw whole ingredient`
    shot = 'arranged on wooden board, close-up studio shot'
  }
  return (
    `Professional food photograph for an app card thumbnail: ${what}. ${shot}, ` +
    `warm natural light, vibrant realistic colors, appetizing, square 1:1 composition, ` +
    `no people, no text, no watermark`
  )
}

// ---------- helpers ----------
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchJsonTimeout(url, opts, timeoutMs = 60000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal })
    return await res.json()
  } finally {
    clearTimeout(t)
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result).split(',')[1])
    fr.onerror = reject
    fr.readAsDataURL(blob)
  })
}

// ---------- PixelSter generation ----------
// returns { imageUrl } — TEMP url, mirror turant karna hota hai
export async function generateOne(prompt, tries = 3, onRetry) {
  let lastErr = 'unknown'
  for (let a = 1; a <= tries; a++) {
    try {
      const j = await fetchJsonTimeout(
        PIXELSTER,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, ratio: '1:1' }),
        },
        90000
      )
      if (j && j.success && j.imageUrl) return j
      lastErr = (j && (j.error || j.message)) || 'no imageUrl'
    } catch (e) {
      lastErr = e.name === 'AbortError' ? 'timeout' : String(e.message || e)
    }
    if (a < tries) {
      onRetry && onRetry(a, lastErr)
      await sleep(2500 * a)
    }
  }
  throw new Error(lastErr)
}

// fetch temp image bytes (vheer CDN sends CORS *, browser can read it)
export async function fetchImageBlob(url, timeoutMs = 30000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error('img ' + res.status)
    return await res.blob()
  } finally {
    clearTimeout(t)
  }
}

// ---------- Host A: imgbb (permanent, free, per-key rate limit) ----------
export async function uploadImgbb(imageUrl, blob, name, key) {
  const b64 = await blobToBase64(blob)
  const fd = new FormData()
  fd.append('key', key)
  fd.append('image', b64)
  fd.append('name', name)
  const j = await fetchJsonTimeout(IMGBB_UP, { method: 'POST', body: fd }, 60000)
  if (j && j.success && j.data) return j.data.image?.url || j.data.display_url || j.data.url
  const msg = j?.error?.message || 'imgbb upload failed'
  const err = new Error(msg)
  if (/rate limit/i.test(msg)) err.rateLimited = true
  throw err
}

// ---------- Host B: GitHub repo (PERMANENT — tumhara apna repo) ----------
// images -> branch (default food-images) -> jsDelivr CDN URL
export function jsDelivrUrl(owner, repo, branch, path) {
  return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path}`
}

const GH_API = 'https://api.github.com'
async function gh(pat, method, url, body) {
  const res = await fetch(GH_API + url, {
    method,
    headers: {
      Authorization: 'Bearer ' + pat,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const j = await res.json().catch(() => ({}))
  return { status: res.status, json: j }
}

// ensure branch exists (default branch ka sha se fork)
export async function ensureGhBranch({ pat, owner, repo, branch }, log) {
  const r = await gh(pat, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`)
  if (r.status === 200) return true
  const repoInfo = await gh(pat, 'GET', `/repos/${owner}/${repo}`)
  if (repoInfo.status !== 200) throw new Error('repo not found / PAT scope issue: ' + (repoInfo.json.message || repoInfo.status))
  const def = repoInfo.json.default_branch
  const defRef = await gh(pat, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${def}`)
  if (defRef.status !== 200) throw new Error('default branch ref fail: ' + (defRef.json.message || defRef.status))
  const sha = defRef.json.object.sha
  const c = await gh(pat, 'POST', `/repos/${owner}/${repo}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha,
  })
  if (c.status === 201) {
    log && log(`🌿 branch '${branch}' ban gaya (${def} se)`, 'ok')
    return true
  }
  if (c.status === 422) return true // already exists (race)
  throw new Error('branch create fail: ' + (c.json.message || c.status))
}

// single-file commit via Contents API (1 call/file; ~5000 req/h core limit se aaram se fit)
export async function uploadGithub({ pat, owner, repo, branch, folder }, item, blob) {
  const path = `${folder}/${item.id}.jpg`.replace(/^\/+/, '')
  const b64 = await blobToBase64(blob)
  const body = {
    message: `img: ${item.id} (${item.name})`,
    content: b64,
    branch,
  }
  let r = await gh(pat, 'PUT', `/repos/${owner}/${repo}/contents/${path}`, body)
  if (r.status === 422) {
    // file exists (resume case) -> sha leke overwrite
    const g = await gh(pat, 'GET', `/repos/${owner}/${repo}/contents/${path}?ref=${branch}`)
    if (g.status === 200 && g.json.sha) {
      r = await gh(pat, 'PUT', `/repos/${owner}/${repo}/contents/${path}`, { ...body, sha: g.json.sha })
    }
  }
  if (r.status === 200 || r.status === 201) return jsDelivrUrl(owner, repo, branch, path)
  const msg = r.json.message || ('github ' + r.status)
  const err = new Error(msg)
  if (r.status === 403 && /rate limit/i.test(msg)) err.rateLimited = true
  throw err
}

// ---------- export helpers ----------
export function download(name, text, type = 'application/json') {
  const b = new Blob([text], { type })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(b)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

export function buildFinalSeed(fullSeed, mergedMap, catMap) {
  const out = JSON.parse(JSON.stringify(fullSeed))
  let perItem = 0, cat = 0, old = 0
  for (const it of out.items) {
    if (mergedMap[it.id]) {
      it.image = mergedMap[it.id]
      perItem++
    } else if (it.image && /^https?:/.test(it.image)) {
      old++ // pehle se hi koi live url (purane imgbb/category)
    } else if (catMap[it.slug]) {
      it.image = catMap[it.slug]
      cat++
    }
  }
  return { seed: out, stats: { perItem, cat, old, total: out.items.length } }
}
