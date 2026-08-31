// ============================================================
// GharApp Image Factory v2 — SEARCH-FIRST core
// 1) Online real photos (Wikimedia/Wikipedia/OFF/Openverse/Pexels)
// 2) Jo na mile -> enhanced AI gen (PixelSter)
// Sab kuch -> permanent GitHub mirror (jsDelivr) / imgbb
// ============================================================
import { DESC } from './data/desc.js'

export const PIXELSTER = 'https://ahm7xmakki.com/api/tti'
export const IMGBB_UP = 'https://api.imgbb.com/1/upload'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------- Prompt builder (AI ke liye) ----------------
export function descFor(name) {
  const n = name.toLowerCase()
  for (const [rx, d] of DESC) if (rx.test(n)) return d
  return null
}

// category ke hisaab se photo style — accuracy badhane ke liye
const CAT_STYLE = [
  [/spice|masala|herb/i, 'in a small white ceramic bowl, top-down flat-lay, scattered a few pieces around'],
  [/dal|lentil|pulse|beans|legume/i, 'in a small ceramic bowl, top-down, some grains spilled on wooden table'],
  [/flour|grain|rice|atta|sooji|millets|cereal/i, 'in a bowl plus a small heap on rustic cloth, top-down'],
  [/oil|ghee|fat/i, 'golden liquid in a small glass bowl with a spoon, warm light'],
  [/sweet|mithai|dessert|halwa|ladoo|barfi|kheer/i, 'arranged on a decorative mithai plate, garnished, festive look'],
  [/snack|namkeen|chaat|pakora|samosa/i, 'served in a steel plate with green chutney on the side, street-food vibe'],
  [/beverage|drink| Juice|milk|lassi|chai/i, 'served in a clear glass, refreshing, condensation drops'],
  [/bread|roti|paratha|chapati|puri|naan/i, 'stacked in a cloth-lined basket, one torn to show texture, steam'],
  [/fruit/i, 'fresh whole fruits arranged on a wooden crate at a market stall'],
  [/meat|egg|chicken|mutton|fish/i, 'raw fresh cuts on a steel tray, garnish of herbs, butcher style'],
  [/vegetable/i, 'fresh vegetables arranged on a rustic wooden board at a sabzi mandi'],
]

export function promptFor(item) {
  const name = item.name
  const cooked = item.ft === 'cooked'
  const d = descFor(name)
  let style = ''
  for (const [rx, s] of CAT_STYLE) if (rx.test(item.cat || '') || rx.test(name)) { style = s; break }
  let what, shot
  if (cooked) {
    what = `${name} — authentic Indian dish` + (d ? `, ${d}` : '')
    shot = style || 'served in traditional Indian tableware on rustic wooden table, garnished, appetizing close-up'
  } else {
    what = d ? `${name} — ${d}` : `${name} — fresh raw whole ingredient`
    shot = style || 'arranged on wooden board, close-up studio shot'
  }
  return (
    `Award-winning professional food photograph for a food delivery app thumbnail: ${what}. ` +
    `${shot}, warm natural window light, shallow depth of field, vibrant realistic colors, ` +
    `appetizing, square 1:1 composition, no people, no text, no watermark`
  )
}

// ---------------- helpers ----------------
async function fetchJsonTimeout(url, opts, timeoutMs = 45000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal })
    const j = await res.json().catch(() => ({}))
    return { status: res.status, json: j }
  } finally { clearTimeout(t) }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => String(fr.result).split(',')[1] ? resolve(String(fr.result).split(',')[1]) : reject(new Error('b64'))
    fr.onerror = reject
    fr.readAsDataURL(blob)
  })
}

export async function fetchImageBlob(url, timeoutMs = 30000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error('http ' + res.status)
    const b = await res.blob()
    if (!/^image\//.test(b.type)) throw new Error('not-image ' + b.type)
    if (b.size < 15000) throw new Error('too-small ' + b.size)
    return b
  } finally { clearTimeout(t) }
}

// ---------------- ONLINE SEARCHERS ----------------
const STOP = new Set(['the', 'a', 'an', 'of', 'with', 'and', 'or', 'ki', 'ke', 'ka', 'style', 'dish', 'recipe', 'photo', 'image', 'file', 'jpg', 'jpeg', 'png', 'from', 'indian', 'india', 'food', 'foods', 'close', 'shot'])
const tokens = (s) => s.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w))
export function nameScore(name, title) {
  const nt = tokens(name)
  if (!nt.length) return 0
  const tt = new Set(tokens(title))
  let hit = 0
  for (const w of nt) if (tt.has(w)) hit++
  return hit / nt.length
}

export function buildQueries(item) {
  const base = item.name.replace(/\+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  const paren = (/\(([^)]+)\)/.exec(item.name) || [])[1]
  const stripped = base.replace(/\(.*?\)/g, '').trim()
  const qs = []
  if (stripped.length >= 3) qs.push(stripped)
  if (paren && paren.replace(/[^a-z]/gi, '').length >= 3) qs.push(paren.trim())
  if (base !== stripped) qs.push(base)
  if (item.ft === 'cooked') qs.push(stripped + ' dish')
  return [...new Set(qs)].slice(0, 3)
}

// 1) Wikimedia Commons — File: titles, size info ke saath
export async function commonsSearch(queries, minScore, szMin = 400) {
  const out = []
  for (const q of queries) {
    const u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search'
      + `&gsrsearch=${encodeURIComponent(q)}&gsrnamespace=6&gsrlimit=10&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=640`
    const { status, json } = await fetchJsonTimeout(u, {}, 20000)
    if (status === 429 || status === 503) throw Object.assign(new Error('commons ' + status), { srcDead: true })
    const pages = json?.query?.pages ? Object.values(json.query.pages) : []
    for (const p of pages) {
      const ii = p.imageinfo && p.imageinfo[0]
      if (!ii || !/image\/(jpeg|png)/.test(ii.mime || '')) continue
      if ((ii.width || 0) < szMin || (ii.height || 0) < szMin) continue
      const score = nameScore(queries[0] + ' ' + (queries[1] || ''), p.title || '')
      if (score >= minScore) out.push({ url: ii.thumburl || ii.url, title: p.title, score, source: 'commons' })
    }
    if (out.length) break // best query se mil gaye
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 4)
}

// 2) English Wikipedia — dish pages ke original images
export async function wikiSearch(queries, minScore) {
  const out = []
  for (const q of queries) {
    const u = 'https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search'
      + `&gsrsearch=${encodeURIComponent(q)}&gsrlimit=5&gsrnamespace=0&prop=pageimages&piprop=original&pilimit=5`
    const { status, json } = await fetchJsonTimeout(u, {}, 20000)
    if (status === 429 || status === 503) throw Object.assign(new Error('wiki ' + status), { srcDead: true })
    const pages = json?.query?.pages ? Object.values(json.query.pages) : []
    for (const p of pages) {
      if (!p.original?.source) continue
      if ((p.original.width || 0) < 400 || (p.original.height || 0) < 400) continue
      const score = nameScore(queries[0] + ' ' + (queries[1] || ''), p.title || '')
      if (score >= minScore) out.push({ url: p.original.source, title: 'WP: ' + p.title, score, source: 'wikipedia' })
    }
    if (out.length) break
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3)
}

// 3) Open Food Facts — packaged/namkeen ke liye perfect
export async function offSearch(queries, minScore) {
  const out = []
  for (const q of queries.slice(0, 2)) {
    const u = 'https://world.openfoodfacts.org/cgi/search.pl?action=process&json=1&search_simple=1&page_size=8'
      + '&fields=product_name,brands,image_front_url,image_url&search_terms=' + encodeURIComponent(q)
    let status, json
    for (let a = 0; a < 2; a++) {
      ({ status, json } = await fetchJsonTimeout(u, {}, 25000))
      if (status !== 503 && status !== 429) break
      await sleep(2000 * (a + 1))
    }
    if (status === 503 || status === 429) throw Object.assign(new Error('off ' + status), { srcDead: true })
    for (const p of json?.products || []) {
      const img = p.image_front_url || p.image_url
      if (!img) continue
      const title = `${p.product_name || ''} ${p.brands || ''}`
      const score = nameScore(queries[0] + ' ' + (queries[1] || ''), title)
      if (score >= minScore) out.push({ url: img, title: 'OFF: ' + title.trim(), score, source: 'openfoodfacts' })
    }
    if (out.length) break
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3)
}

// 4) Openverse — CC photos (anon limit kam, last resort)
export async function openverseSearch(queries, minScore) {
  const out = []
  const u = 'https://api.openverse.org/v1/images/?page_size=8&filter_dead=false&q=' + encodeURIComponent(queries[0])
  const { status, json } = await fetchJsonTimeout(u, {}, 25000)
  if (status === 429) throw Object.assign(new Error('openverse 429'), { srcDead: true })
  for (const r of json?.results || []) {
    if (!r.url) continue
    const score = nameScore(queries[0] + ' ' + (queries[1] || ''), (r.title || '') + ' ' + (r.tags ? r.tags.map((t) => t.name).join(' ') : ''))
    if (score >= minScore) out.push({ url: r.url, title: 'OV: ' + (r.title || r.foreign_landing_url), score, source: 'openverse' })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3)
}

// 5) Pexels — agar user key de (200/hr)
export async function pexelsSearch(queries, key, minScore) {
  const u = 'https://api.pexels.com/v1/search?per_page=8&query=' + encodeURIComponent(queries[0])
  const { status, json } = await fetchJsonTimeout(u, { headers: { Authorization: key } }, 25000)
  if (status === 429 || status === 401) throw Object.assign(new Error('pexels ' + status), { srcDead: true })
  const out = []
  for (const p of json?.photos || []) {
    const score = nameScore(queries[0] + ' ' + (queries[1] || ''), p.alt || '')
    if (score >= minScore) out.push({ url: p.src.large, title: 'PX: ' + (p.alt || ''), score, source: 'pexels' })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3)
}

export const OFF_FIRST = /snack|namkeen|biscuit|cookie|bakery|packaged|mixture|chocolate|wafer|noodle|ketchup|sauce|jam|pickle branded/i

// ---------------- PixelSter AI generation ----------------
export async function generateOne(prompt, tries = 3, onRetry) {
  let lastErr = 'unknown'
  for (let a = 1; a <= tries; a++) {
    try {
      const { json } = await fetchJsonTimeout(PIXELSTER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, ratio: '1:1' }),
      }, 90000)
      if (json && json.success && json.imageUrl) return json
      lastErr = (json && (json.error || json.message)) || 'no imageUrl'
    } catch (e) { lastErr = e.name === 'AbortError' ? 'timeout' : String(e.message || e) }
    if (a < tries) { onRetry && onRetry(a, lastErr); await sleep(2500 * a) }
  }
  throw new Error(lastErr)
}

// ---------------- optional CLIP verify (browser AI) ----------------
let clipPipe = null
export async function clipCheck(blob, name, log) {
  try {
    if (!clipPipe) {
      const mod = await import(/* @vite-ignore */ 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2')
      mod.env.allowLocalModels = false
      clipPipe = await mod.pipeline('zero-shot-image-classification', 'Xenova/clip-vit-base-patch32')
      log && log('🧠 CLIP verify model ready', 'info')
    }
    const url = URL.createObjectURL(blob)
    const labels = [`a photo of ${name}`, 'a photo of indian food', 'a photo of vegetables', 'a random object', 'a non-food item']
    const res = await clipPipe(url, labels)
    URL.revokeObjectURL(url)
    return res?.[0]?.label === labels[0]
  } catch (e) {
    log && log('🧠 CLIP unavailable, verify skip: ' + (e.message || e), 'warn')
    return true // fail-open
  }
}

// ---------------- Host A: imgbb ----------------
export async function uploadImgbb(blob, name, key) {
  const fd = new FormData()
  fd.append('key', key)
  fd.append('image', await blobToBase64(blob))
  fd.append('name', name)
  const { json } = await fetchJsonTimeout(IMGBB_UP, { method: 'POST', body: fd }, 60000)
  if (json && json.success && json.data) return json.data.image?.url || json.data.display_url || json.data.url
  const msg = json?.error?.message || 'imgbb upload failed'
  const err = new Error(msg)
  if (/rate limit/i.test(msg)) err.rateLimited = true
  throw err
}

// ---------------- Host B: GitHub (PERMANENT) ----------------
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

export async function ensureGhBranch({ pat, owner, repo, branch }, log) {
  const r = await gh(pat, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`)
  if (r.status === 200) return true
  const repoInfo = await gh(pat, 'GET', `/repos/${owner}/${repo}`)
  if (repoInfo.status !== 200) throw new Error('repo not found / PAT scope: ' + (repoInfo.json.message || repoInfo.status))
  const defRef = await gh(pat, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${repoInfo.json.default_branch}`)
  const c = await gh(pat, 'POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: defRef.json.object.sha })
  if (c.status === 201) { log && log(`🌿 branch '${branch}' ban gaya`, 'ok'); return true }
  if (c.status === 422) return true
  throw new Error('branch create fail: ' + (c.json.message || c.status))
}

export async function uploadGithub({ pat, owner, repo, branch, folder }, item, blob) {
  const path = `${folder}/${item.id}.jpg`.replace(/^\/+/, '')
  const body = { message: `img: ${item.id} (${item.name})`, content: await blobToBase64(blob), branch }
  let r = await gh(pat, 'PUT', `/repos/${owner}/${repo}/contents/${path}`, body)
  if (r.status === 422) {
    const g = await gh(pat, 'GET', `/repos/${owner}/${repo}/contents/${path}?ref=${branch}`)
    if (g.status === 200 && g.json.sha) r = await gh(pat, 'PUT', `/repos/${owner}/${repo}/contents/${path}`, { ...body, sha: g.json.sha })
  }
  if (r.status === 200 || r.status === 201) return jsDelivrUrl(owner, repo, branch, path)
  const msg = r.json.message || ('github ' + r.status)
  const err = new Error(msg)
  if (r.status === 403 && /rate limit/i.test(msg)) err.rateLimited = true
  throw err
}

// ---------------- export ----------------
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
  let perItem = 0, cat = 0, old = 0, missing = 0
  for (const it of out.items) {
    if (mergedMap[it.id]) { it.image = mergedMap[it.id]; perItem++ }
    else if (it.image && /^https?:/.test(it.image)) old++
    else if (catMap[it.slug]) { it.image = catMap[it.slug]; cat++ }
    else missing++
  }
  return { seed: out, stats: { perItem, cat, old, missing, total: out.items.length } }
}
