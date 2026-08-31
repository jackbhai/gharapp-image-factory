import React, { useEffect, useRef, useState } from 'react'
import {
  promptFor, generateOne, fetchImageBlob, loadImageDims, dimsOk,
  commonsSearch, wikiSearch, mealdbSearch, offSearch, openverseSearch, pexelsSearch, pixabaySearch, bbSearch,
  buildQueries, OFF_FIRST,
  uploadImgbb, uploadGithub, uploadR2, r2Test, ensureGhBranch,
  download, buildFinalSeed, sleep,
} from './factory.js'
import ITEMS from './data/items.json'
import CAT_MAP from './data/cat_map.json'

const LS_SET = 'gif3_settings_v1'
const LS_MAP = 'gif3_map_v1'

const DEFAULT_SETTINGS = {
  provider: 'github',           // github (proven) | r2 (fast CDN) | imgbb (backup)
  ghPat: '', ghOwner: 'jackbhai', ghRepo: 'gharapp-image-factory',
  ghBranch: 'food-images', ghFolder: 'images/items',
  r2AccountId: '', r2KeyId: '', r2Secret: '', r2Bucket: 'gharapp-images', r2Pub: '',
  imgbbKey: '',
  workers: 12, autoRounds: 3,
  onlineOn: true, aiOnly: false, minScore: 0.5, minDim: 380,
  srcBB: true, bbWorker: '',
  srcCommons: true, srcWiki: true, srcMeal: true, srcOpenverse: true, srcOff: false,
  srcPexels: false, pexelsKey: '',
  srcPixabay: false, pixabayKey: '',
}

const loadLS = (k, d) => { try { return { ...d, ...JSON.parse(localStorage.getItem(k) || '{}') } } catch { return d } }
const fmtClock = (t) => new Date(t).toLocaleTimeString('en-IN', { hour12: false })
const fmtDur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s` }
const SRC_ICON = { bigbasket: '🛒', commons: '🌐', wikipedia: '📖', mealdb: '🍛', openfoodfacts: '🥫', openverse: '🖼', pexels: '📷', pixabay: '📸', ai: '🎨' }

export default function App() {
  const [tab, setTab] = useState('dash')
  const [settings, setSettings] = useState(() => loadLS(LS_SET, DEFAULT_SETTINGS))
  const [completedAt, setCompletedAt] = useState(null)
  const [r2Testing, setR2Testing] = useState(false)
  const [, setTick] = useState(0)

  const mapRef = useRef(loadLS(LS_MAP, {}))
  const metaRef = useRef({})
  const failRef = useRef({})
  const rejectRef = useRef({})
  const logRef = useRef([])
  const wallRef = useRef([])
  const inflightRef = useRef(new Map())
  const srcCountRef = useRef({})
  const qualityRef = useRef({ dimReject: 0, fetchFail: 0, candidates: 0 })
  const speedRef = useRef([])
  const histRef = useRef([])
  const deadRef = useRef({})
  const runRef = useRef({ running: false, stopFlag: false, round: 0, startedAt: 0, cooldownUntil: 0 })
  const ptrRef = useRef(0)
  const queueRef = useRef([])
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const log = (msg, kind = 'info') => {
    logRef.current.push({ t: Date.now(), msg, kind })
    if (logRef.current.length > 800) logRef.current.splice(0, logRef.current.length - 800)
  }
  useEffect(() => { const iv = setInterval(() => setTick((x) => x + 1), 500); return () => clearInterval(iv) }, [])
  useEffect(() => { localStorage.setItem(LS_SET, JSON.stringify(settings)) }, [settings])
  const setS = (k, v) => setSettings((s) => ({ ...s, [k]: v }))

  const total = ITEMS.length
  let done = 0
  for (const it of ITEMS) if (mapRef.current[it.id]) done++
  const failCount = Object.keys(failRef.current).length
  const rejectCount = Object.keys(rejectRef.current).length
  const srcCounts = srcCountRef.current
  const onlineFound = Object.entries(srcCounts).filter(([k]) => k !== 'ai').reduce((a, [, v]) => a + v, 0)
  const aiGen = srcCounts.ai || 0
  const now = Date.now()
  const perMin = speedRef.current.filter((t) => now - t < 60000).length
  const remain = total - done
  const etaMin = perMin > 0 ? remain / perMin : null
  const running = runRef.current.running
  const pct = (done / total) * 100

  const saveMap = () => { localStorage.setItem(LS_MAP, JSON.stringify(mapRef.current)) }
  const alive = (src) => (deadRef.current[src] || 0) < Date.now()
  const markDead = (src, why) => { deadRef.current[src] = Date.now() + 120000; log(`🚧 ${src} throttled (${why}) — 2 min timeout`, 'cool') }

  // ---------------- per-item pipeline ----------------
  async function processOne(item, wid) {
    const s = settingsRef.current
    const st = (stage) => inflightRef.current.set(item.id, { stage, name: item.name, wid })

    if (s.onlineOn && !s.aiOnly && !rejectRef.current[item.id]) {
      st('🔎 search')
      const qs = buildQueries(item)
      const thr = s.minScore
      const cand = []
      const trySrc = async (src, fn) => {
        if (!alive(src)) return
        try { cand.push(...(await fn)) } catch (e) { if (e.srcDead) markDead(src, e.message); else log(`⚠️ ${src}: ${e.message}`, 'warn') }
      }
      const offFirst = OFF_FIRST.test(item.cat || '') || OFF_FIRST.test(item.name)
      // 🛒 BigBasket (via worker) — sabse pehle: exact name match + studio shots
      if (s.srcBB && s.bbWorker.trim()) await trySrc('bigbasket', bbSearch(s.bbWorker.trim(), qs, thr))
      if (offFirst && s.srcOff) await trySrc('openfoodfacts', offSearch(qs, thr))
      if (item.ft === 'cooked' && s.srcMeal) await trySrc('mealdb', mealdbSearch(qs, thr))
      if (s.srcCommons) await trySrc('commons', commonsSearch(qs, thr))
      if (s.srcWiki) await trySrc('wikipedia', wikiSearch(qs, thr))
      if (!cand.length && s.srcOpenverse) await trySrc('openverse', openverseSearch(qs, thr))
      if (!cand.length && !offFirst && s.srcOff) await trySrc('openfoodfacts', offSearch(qs, thr))
      if (!cand.length && s.srcPexels && s.pexelsKey) await trySrc('pexels', pexelsSearch(qs, s.pexelsKey, thr))
      if (!cand.length && s.srcPixabay && s.pixabayKey) await trySrc('pixabay', pixabaySearch(qs, s.pixabayKey, thr))

      const seen = new Set()
      const uniq = cand.filter((c) => !seen.has(c.url) && seen.add(c.url)).sort((a, b) => b.score - a.score).slice(0, 5)
      for (const c of uniq) {
        st('📏 quality')
        qualityRef.current.candidates++
        const d = await loadImageDims(c.url)
        if (!dimsOk(d, s.minDim)) {
          qualityRef.current.dimReject++
          log(`📏 ${item.name}: "${String(c.title).slice(0, 36)}" reject (${d ? d.w + 'x' + d.h + ' — chhoti/stretched' : 'load fail'})`, 'warn')
          continue
        }
        st('🪞 fetch')
        const blob = await fetchImageBlob(c.url)
        if (blob) return { blob, src: c.source, via: c.title }
        qualityRef.current.fetchFail++
      }
      if (uniq.length) log(`🔎 ${item.name}: quality gate ke baad kuch nahi bacha — AI banayega`, 'warn')
    }

    // ===== AI fallback (enhanced prompt) =====
    st('🎨 AI gen')
    const prompt = promptFor(item)
    const gen = await generateOne(prompt, 3, (a, e) => log(`⚠️ W${wid} ${item.name}: retry ${a} (${e})`, 'warn'))
    st('🪞 fetch')
    const blob = await fetchImageBlob(gen.imageUrl, true)
    if (!blob) throw new Error('generated image download fail')
    return { blob, src: 'ai', via: 'pixelster flux' }
  }

  async function workerLoop(wid) {
    for (;;) {
      const run = runRef.current
      if (run.stopFlag) return
      if (Date.now() < run.cooldownUntil) { await sleep(2000); continue }
      const i = ptrRef.current++
      if (i >= queueRef.current.length) return
      const item = queueRef.current[i]
      if (mapRef.current[item.id]) continue
      inflightRef.current.set(item.id, { stage: '⏳ queue', name: item.name, wid })
      try {
        const r = await processOne(item, wid)
        inflightRef.current.set(item.id, { stage: '☁️ upload', name: item.name, wid })
        const pv = settingsRef.current.provider
        const finalUrl = pv === 'github' ? await uploadGithub(ghCfg(), item, r.blob)
          : pv === 'r2' ? await uploadR2(r2Cfg(), item, r.blob)
          : await uploadImgbb(r.blob, item.id, settingsRef.current.imgbbKey)
        mapRef.current[item.id] = finalUrl
        metaRef.current[item.id] = { src: r.src }
        srcCountRef.current[r.src] = (srcCountRef.current[r.src] || 0) + 1
        speedRef.current.push(Date.now())
        wallRef.current.unshift({ id: item.id, name: item.name, url: finalUrl, src: r.src, at: Date.now() })
        if (wallRef.current.length > 120) wallRef.current.length = 120
        delete failRef.current[item.id]
        log(`${SRC_ICON[r.src] || '✅'} ${item.name} ← ${r.src} (${String(r.via).slice(0, 48)})`, 'ok')
        if (speedRef.current.length % 10 === 0) saveMap()
      } catch (e) {
        const msg = String(e.message || e)
        failRef.current[item.id] = msg
        log(`❌ ${item.name}: ${msg}`, 'err')
        if (e.rateLimited) {
          runRef.current.cooldownUntil = Date.now() + 60000
          log('🧊 rate-limit — 60s cooldown, auto-resume…', 'cool')
        }
      } finally { inflightRef.current.delete(item.id) }
    }
  }

  const ghCfg = () => {
    const s = settingsRef.current
    return { pat: s.ghPat.trim(), owner: s.ghOwner.trim(), repo: s.ghRepo.trim(), branch: s.ghBranch.trim(), folder: s.ghFolder.trim().replace(/^\/+|\/+$/g, '') }
  }
  const r2Cfg = () => {
    const s = settingsRef.current
    return { accountId: s.r2AccountId.trim(), keyId: s.r2KeyId.trim(), secret: s.r2Secret.trim(), bucket: s.r2Bucket.trim(), pub: s.r2Pub.trim() }
  }

  async function testR2() {
    const c = r2Cfg()
    if (!c.accountId || !c.keyId || !c.secret || !c.bucket || !c.pub) { log('⛔ R2 ke saare 5 fields bharo (Account ID, Key ID, Secret, Bucket, Public URL)', 'err'); return }
    setR2Testing(true)
    log('🧪 R2 connection test…', 'info')
    try { await r2Test(c); log('✅ R2 PERFECT — upload + public URL dono chal rahe hain! 🚀', 'big') }
    catch (e) { log('❌ R2 test: ' + e.message, 'err') }
    setR2Testing(false)
  }

  async function startRun() {
    const s = settings
    if (running) return
    if (s.provider === 'github' && !s.ghPat.trim()) { log('⛔ GitHub PAT paste karo', 'err'); return }
    if (s.provider === 'r2' && (!s.r2KeyId.trim() || !s.r2Secret.trim() || !s.r2Pub.trim())) { log('⛔ R2 fields + pehle "Test R2" dabao', 'err'); return }
    if (s.provider === 'imgbb' && !s.imgbbKey.trim()) { log('⛔ imgbb key paste karo', 'err'); return }
    if (s.provider === 'github') {
      log(`🔐 GitHub: ${s.ghOwner}/${s.ghRepo} @ ${s.ghBranch}…`)
      try { await ensureGhBranch({ ...ghCfg() }, log); log('✅ GitHub ready', 'ok') }
      catch (e) { log('⛔ GitHub fail: ' + e.message, 'err'); return }
    }
    queueRef.current = ITEMS.filter((it) => !mapRef.current[it.id])
    ptrRef.current = 0
    for (const k of Object.keys(failRef.current)) if (mapRef.current[k]) delete failRef.current[k]
    runRef.current = { running: true, stopFlag: false, round: runRef.current.round + 1, startedAt: Date.now(), cooldownUntil: 0 }
    log(`🚀 Round ${runRef.current.round} — ${queueRef.current.length} items · ${s.workers} workers · host: ${s.provider} · quality gate: ≥${s.minDim}px`, 'big')
    await Promise.all(Array.from({ length: s.workers }, (_, w) => workerLoop(w + 1)))
    saveMap()
    const left = ITEMS.filter((it) => !mapRef.current[it.id]).length
    if (left > 0 && !runRef.current.stopFlag && runRef.current.round < s.autoRounds) {
      log(`🔁 ${left} baaki — 20s me round ${runRef.current.round + 1}…`, 'cool')
      for (let i = 0; i < 20 && !runRef.current.stopFlag; i++) await sleep(1000)
      runRef.current.running = false
      if (!runRef.current.stopFlag) return startRun()
    }
    runRef.current.running = false
    saveMap()
    if (left === 0) { log('🎉🎉 ALL IMAGES COMPLETE! Auto-export…', 'big'); setCompletedAt(Date.now()); exportAll() }
    else log(`⏹ stop — ${left} baaki (${failCount} failed)`, 'warn')
  }

  const stopRun = () => { runRef.current.stopFlag = true; saveMap(); log('⏸ Stop signal…', 'cool') }
  const resetFails = () => { failRef.current = {}; log('🔄 fails clear', 'info') }
  const hardReset = () => {
    if (!confirm('Browser-side progress delete? (jo upload ho chuka wo safe hai)')) return
    localStorage.removeItem(LS_MAP); mapRef.current = {}; metaRef.current = {}; failRef.current = {}; rejectRef.current = {}; wallRef.current = []; srcCountRef.current = {}
    log('🧹 full reset', 'warn')
  }
  const rejectImage = (id) => {
    const it = ITEMS.find((x) => x.id === id)
    delete mapRef.current[id]; rejectRef.current[id] = true; saveMap()
    log(`👎 ${it?.name || id} reject — next run pe dobara banegi`, 'warn')
  }
  const unreject = (id) => { delete rejectRef.current[id]; log(`👍 un-reject`, 'info') }

  async function exportAll() {
    try {
      const r = await fetch(import.meta.env.BASE_URL + 'gharapp_seed.json')
      const fullSeed = await r.json()
      const { seed, stats } = buildFinalSeed(fullSeed, mapRef.current, CAT_MAP)
      download('gharapp_seed_with_images.json', JSON.stringify(seed))
      download('item_images_map_app.json', JSON.stringify(mapRef.current))
      log(`📦 export ok — per-item: ${stats.perItem}/${stats.total}`, 'big')
      return stats
    } catch (e) { log('export fail: ' + e.message, 'err') }
  }
  const exportMapOnly = () => download('item_images_map_app.json', JSON.stringify(mapRef.current))

  // ============ UI ============
  return (
    <div className="app">
      <div className="orb o1" /><div className="orb o2" /><div className="orb o3" />
      <header className="hdr fadeUp">
        <div className="brand">
          <span className="logo">⚡</span>
          <div>
            <h1>GharApp Image Factory <span className="vtag">v3</span></h1>
            <div className="sub">🌐 quality-checked real photos (≥{settings.minDim}px) + 🎨 AI fallback → {settings.provider === 'r2' ? '⚡ Cloudflare R2 CDN' : settings.provider === 'github' ? 'GitHub + jsDelivr CDN' : 'imgbb'} · {total.toLocaleString('en-IN')} items</div>
          </div>
        </div>
        <div className="hdrRight">
          <span className={`pill ${running ? 'pill-run' : done === total && total ? 'pill-done' : 'pill-idle'}`}>
            {running ? `● RUNNING · R${runRef.current.round}` : done === total ? '✔ COMPLETE' : '○ IDLE'}
          </span>
          <span className="clock">{fmtClock(now)}</span>
        </div>
      </header>

      <nav className="tabs fadeUp" style={{ animationDelay: '.05s' }}>
        {[['dash', '🎛 Mission Control'], ['wall', `🖼 Live Wall (${wallRef.current.length})`], ['explore', '🗂 Explorer'], ['logs', `📜 Logs (${logRef.current.length})`], ['export', '📦 Export']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'tab on' : 'tab'} onClick={() => setTab(k)}>{l}</button>
        ))}
      </nav>

      {tab === 'dash' && (
        <main>
          <div className="statGrid">
            <Stat label="TOTAL ITEMS" value={total} icon="🍱" />
            <Stat label="DONE" value={done} icon="✅" accent="green" />
            <Stat label="🌐 ONLINE PHOTOS" value={onlineFound} icon="🌐" accent="blue" sub="quality-checked real" />
            <Stat label="🎨 AI GENERATED" value={aiGen} icon="🎨" accent="purple" />
            <Stat label="PENDING" value={remain} icon="⏳" accent="amber" />
            <Stat label="SPEED" value={0} icon="🚄" accent="blue" text={perMin ? `${perMin}/min` : '—'} sub={running && etaMin ? `ETA ~${fmtDur(etaMin * 60000)}` : ''} />
            <Stat label="QUALITY REJECTS" value={qualityRef.current.dimReject} icon="📏" accent="red" sub={`bekar/chhoti roki · fetch-fail ${qualityRef.current.fetchFail}`} />
          </div>

          <div className="progressWrap fadeUp" style={{ animationDelay: '.1s' }}>
            <div className="progressTop">
              <span><b>{pct.toFixed(2)}%</b> complete</span>
              <span>{done} / {total} · online 🌐 {onlineFound} · AI 🎨 {aiGen}</span>
            </div>
            <div className="bar"><div className={`fill ${running ? 'anim' : ''}`} style={{ width: pct + '%' }} /></div>
          </div>

          <div className="midGrid fadeUp" style={{ animationDelay: '.15s' }}>
            <section className="panel">
              <h2>👷 Workers <span className="liveN">{inflightRef.current.size} active</span></h2>
              <div className="wgrid">
                {[...inflightRef.current.entries()].slice(0, 16).map(([id, w]) => (
                  <div key={id} className="wtile"><span className="wstage">{w.stage}</span><span className="wname">{w.name}</span><span className="wid">W{w.wid}</span></div>
                ))}
                {inflightRef.current.size === 0 && <p className="muted">Start dabao — yahan har worker live dikhega 🔥</p>}
              </div>
            </section>
            <section className="panel">
              <h2>📈 Speed <span className="muted">(img/min)</span></h2>
              <Sparkline histRef={histRef} perMin={perMin} running={running} />
              <div className="srcBreak">
                {Object.entries(srcCounts).map(([k, v]) => <span key={k} className="chipLive">{SRC_ICON[k] || '•'} {k}: <b>{v}</b></span>)}
                {Object.keys(srcCounts).length === 0 && <span className="muted">source breakdown yahan aayega</span>}
              </div>
            </section>
          </div>

          <section className="panel fadeUp" style={{ animationDelay: '.2s' }}>
            <h2>⚙️ Controls</h2>
            <div className="ctrlCols">
              <div>
                <h3>🔒 Permanent host</h3>
                <div className="providers">
                  <label className={`prov ${settings.provider === 'github' ? 'on' : ''}`}>
                    <input type="radio" checked={settings.provider === 'github'} onChange={() => setS('provider', 'github')} />
                    <div className="provTitle">🐙 GitHub + jsDelivr <span className="reco">PROVEN · PERMANENT</span></div>
                    <div className="provDesc">Tumhare repo <b>{settings.ghRepo}@{settings.ghBranch}</b> me commit → CDN. 5000 req/h — safe ✅</div>
                  </label>
                  <label className={`prov ${settings.provider === 'r2' ? 'on' : ''}`}>
                    <input type="radio" checked={settings.provider === 'r2'} onChange={() => setS('provider', 'r2')} />
                    <div className="provTitle">⚡ Cloudflare R2 <span className="reco2">FASTEST CDN · beta</span></div>
                    <div className="provDesc">Tumhara Cloudflare bucket — zero rate limits, instant URLs, world-class speed. Pehle <b>Test R2</b> zaroor dabao.</div>
                  </label>
                  <label className={`prov ${settings.provider === 'imgbb' ? 'on' : ''}`}>
                    <input type="radio" checked={settings.provider === 'imgbb'} onChange={() => setS('provider', 'imgbb')} />
                    <div className="provTitle">☁️ imgbb <span className="warn2">per-key rate cap</span></div>
                    <div className="provDesc">Backup only.</div>
                  </label>
                </div>
                {settings.provider === 'github' && (
                  <div className="fieldGrid">
                    <Field label="GitHub PAT (repo scope)" type="password" value={settings.ghPat} onChange={(v) => setS('ghPat', v)} ph="ghp_… localStorage only" />
                    <Field label="Owner" value={settings.ghOwner} onChange={(v) => setS('ghOwner', v)} />
                    <Field label="Repo" value={settings.ghRepo} onChange={(v) => setS('ghRepo', v)} />
                    <Field label="Branch" value={settings.ghBranch} onChange={(v) => setS('ghBranch', v)} />
                    <Field label="Folder" value={settings.ghFolder} onChange={(v) => setS('ghFolder', v)} />
                  </div>
                )}
                {settings.provider === 'r2' && (
                  <div className="r2Box">
                    <div className="fieldGrid">
                      <Field label="Account ID" value={settings.r2AccountId} onChange={(v) => setS('r2AccountId', v)} ph="c15af85b…" />
                      <Field label="Access Key ID" type="password" value={settings.r2KeyId} onChange={(v) => setS('r2KeyId', v)} />
                      <Field label="Secret Access Key" type="password" value={settings.r2Secret} onChange={(v) => setS('r2Secret', v)} />
                      <Field label="Bucket name" value={settings.r2Bucket} onChange={(v) => setS('r2Bucket', v)} ph="gharapp-images" />
                      <Field label="Public URL (pub-****.r2.dev)" value={settings.r2Pub} onChange={(v) => setS('r2Pub', v)} ph="https://pub-xxxxxxxx.r2.dev" />
                    </div>
                    <button className="btn ghost" disabled={r2Testing} onClick={testR2}>{r2Testing ? '⏳ testing…' : '🧪 Test R2 connection'}</button>
                    <p className="note">ℹ️ Bucket pehli baar: Cloudflare dashboard → R2 → <b>Create bucket</b> (gharapp-images) → Settings → Public access <b>allow</b> (r2.dev) → jo pub-***.r2.dev mile wo upar paste karo.</p>
                  </div>
                )}
                {settings.provider === 'imgbb' && (
                  <div className="fieldGrid"><Field label="imgbb key" type="password" value={settings.imgbbKey} onChange={(v) => setS('imgbbKey', v)} /></div>
                )}
              </div>
              <div>
                <h3>🧠 Pipeline — QUALITY first</h3>
                <label className="switch"><input type="checkbox" checked={settings.onlineOn} onChange={(e) => setS('onlineOn', e.target.checked)} /><span>🌐 Online real-photo search (dimension-gate ke saath)</span></label>
                <div className="srcToggles">
                  <label className="switch sm bb"><input type="checkbox" checked={settings.srcBB} onChange={(e) => setS('srcBB', e.target.checked)} /><span><b>🛒 BigBasket</b> (scraped — clean studio shots, exact match!)</span></label>
                  {settings.srcBB && <Field label="BigBasket worker URL" value={settings.bbWorker} onChange={(v) => setS('bbWorker', v)} ph="https://bbimg.<subdomain>.workers.dev — deploy 2 min (README)" />}
                  <label className="switch sm"><input type="checkbox" checked={settings.srcCommons} onChange={(e) => setS('srcCommons', e.target.checked)} /><span>Wikimedia Commons</span></label>
                  <label className="switch sm"><input type="checkbox" checked={settings.srcWiki} onChange={(e) => setS('srcWiki', e.target.checked)} /><span>Wikipedia</span></label>
                  <label className="switch sm"><input type="checkbox" checked={settings.srcMeal} onChange={(e) => setS('srcMeal', e.target.checked)} /><span>TheMealDB (cooked dishes)</span></label>
                  <label className="switch sm"><input type="checkbox" checked={settings.srcOpenverse} onChange={(e) => setS('srcOpenverse', e.target.checked)} /><span>Openverse (backup)</span></label>
                  <label className="switch sm"><input type="checkbox" checked={settings.srcOff} onChange={(e) => setS('srcOff', e.target.checked)} /><span>OpenFoodFacts (bekar quality isliye default OFF)</span></label>
                  <label className="switch sm"><input type="checkbox" checked={settings.srcPexels} onChange={(e) => setS('srcPexels', e.target.checked)} /><span>Pexels (free key)</span></label>
                  <label className="switch sm"><input type="checkbox" checked={settings.srcPixabay} onChange={(e) => setS('srcPixabay', e.target.checked)} /><span>Pixabay (free key, 100 req/min)</span></label>
                </div>
                {settings.srcPexels && <Field label="Pexels API key" type="password" value={settings.pexelsKey} onChange={(v) => setS('pexelsKey', v)} ph="pexels.com/api — free" />}
                {settings.srcPixabay && <Field label="Pixabay API key" type="password" value={settings.pixabayKey} onChange={(v) => setS('pixabayKey', v)} ph="pixabay.com/api/docs — free" />}
                <div className="sliderBox">
                  <label>Name-match strictness: <b>{Math.round(settings.minScore * 100)}%</b></label>
                  <input type="range" min="0.4" max="0.8" step="0.05" value={settings.minScore} onChange={(e) => setS('minScore', +e.target.value)} />
                </div>
                <div className="sliderBox">
                  <label>📏 Min image size: <b>{settings.minDim}px</b> <span className="muted">(chhoti=auto reject)</span></label>
                  <input type="range" min="300" max="600" step="20" value={settings.minDim} onChange={(e) => setS('minDim', +e.target.value)} />
                </div>
                <label className="switch"><input type="checkbox" checked={settings.aiOnly} onChange={(e) => setS('aiOnly', e.target.checked)} /><span>🎨 Sirf AI generation (online search skip)</span></label>
                <p className="note">🛒 <b>BigBasket scraping</b> Cloudflare Worker se chalti hai (browser direct nahi, worker se session banake). Worker code: <code>worker/bbimg.js</code> repo me — 2 min deploy (README steps), URL upar paste karo. Free 1 lakh req/day.</p>
              </div>
            </div>
            <div className="rowCtrls">
              <div className="sliderBox">
                <label>Workers: <b>{settings.workers}</b></label>
                <input type="range" min="2" max="24" value={settings.workers} onChange={(e) => setS('workers', +e.target.value)} />
              </div>
              <div className="btns">
                {!running ? <button className="btn go" onClick={startRun}>▶ START {done > 0 ? 'RESUME' : ''}</button> : <button className="btn stop" onClick={stopRun}>⏸ STOP</button>}
                <button className="btn ghost" onClick={resetFails}>🔄 Reset fails</button>
                <button className="btn ghost" onClick={hardReset}>🧹 Hard reset</button>
              </div>
            </div>
            <p className="note">💾 har 10 images pe autosave · 👎 Explorer reject → regen · 100% pe auto-export</p>
          </section>

          <LogTail logRef={logRef} />
        </main>
      )}

      {tab === 'wall' && (
        <main className="fadeUp">
          <h2 className="pg">🖼 Live Wall</h2>
          {wallRef.current.length === 0 && <p className="muted">Abhi kuch nahi — Start dabao 🔥</p>}
          <div className="wall">
            {wallRef.current.map((w) => (
              <figure key={w.id + w.at} className="wallCard pop">
                <img src={w.url} alt={w.name} loading="lazy" />
                <figcaption><span className="wsrc">{SRC_ICON[w.src] || '✅'}</span>{w.name}<span>{fmtClock(w.at)} · {w.src}</span></figcaption>
              </figure>
            ))}
          </div>
        </main>
      )}

      {tab === 'explore' && <Explorer mapRef={mapRef} metaRef={metaRef} rejectRef={rejectRef} onReject={rejectImage} onUnreject={unreject} />}
      {tab === 'logs' && <LogsFull logRef={logRef} />}
      {tab === 'export' && <ExportPanel exportAll={exportAll} exportMapOnly={exportMapOnly} stats={{ total, done, onlineFound, aiGen }} />}
      {completedAt && <Confetti onClose={() => setCompletedAt(null)} />}
    </div>
  )
}

/* ---------- animated bits ---------- */
function CountUp({ value }) {
  const [disp, setDisp] = useState(0)
  const prev = useRef(0)
  useEffect(() => {
    const from = prev.current, to = value, t0 = performance.now()
    let raf
    const step = (t) => {
      const p = Math.min(1, (t - t0) / 500)
      const v = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3)))
      setDisp(v); prev.current = v
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value])
  return <>{disp.toLocaleString('en-IN')}</>
}

function Sparkline({ histRef, perMin, running }) {
  const cvRef = useRef(null)
  useEffect(() => {
    if (running) {
      const h = histRef.current
      if (!h.length || Date.now() - h[h.length - 1].t > 1900) h.push({ t: Date.now(), v: perMin })
      if (h.length > 120) h.splice(0, h.length - 120)
    }
    const cv = cvRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    const W = cv.width, H = cv.height
    ctx.clearRect(0, 0, W, H)
    const h = histRef.current
    if (h.length < 2) { ctx.fillStyle = '#8a94ad'; ctx.font = '11px sans-serif'; ctx.fillText('graph running me banega…', 10, H / 2); return }
    const max = Math.max(4, ...h.map((x) => x.v))
    const grad = ctx.createLinearGradient(0, 0, 0, H)
    grad.addColorStop(0, 'rgba(110,231,255,.45)'); grad.addColorStop(1, 'rgba(110,231,255,0)')
    ctx.beginPath()
    h.forEach((x, i) => { const px = (i / (h.length - 1)) * W, py = H - (x.v / max) * (H - 6) - 3; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py) })
    ctx.strokeStyle = '#6ee7ff'; ctx.lineWidth = 2; ctx.stroke()
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fillStyle = grad; ctx.fill()
  })
  return <canvas ref={cvRef} width={340} height={90} className="spark" />
}

function Confetti({ onClose }) {
  const bits = Array.from({ length: 42 }, (_, i) => ({
    l: Math.random() * 100, d: Math.random() * 2.2, dur: 2.6 + Math.random() * 2.4,
    e: ['🎉', '✨', '🍲', '🥘', '🌶', '💛', '🎊'][i % 7], s: 16 + Math.random() * 22,
  }))
  return (
    <div className="confettiWrap" onClick={onClose}>
      <div className="confettiCard">
        <div className="bigC">🎉 MISSION COMPLETE 🎉</div>
        <p>Final JSON auto-download ho raha hai</p>
        <button className="btn go">OK ✨</button>
      </div>
      {bits.map((b, i) => <span key={i} className="cbit" style={{ left: b.l + 'vw', animationDelay: b.d + 's', animationDuration: b.dur + 's', fontSize: b.s }}>{b.e}</span>)}
    </div>
  )
}

function Stat({ label, value, icon, accent = '', sub, text }) {
  return (
    <div className={`stat ${accent}`}>
      <div className="statIcon">{icon}</div>
      <div><div className="statVal">{text || <CountUp value={value} />}</div><div className="statLbl">{label}</div>{sub && <div className="statSub">{sub}</div>}</div>
    </div>
  )
}
function Field({ label, value, onChange, type = 'text', ph }) {
  return (
    <label className="field"><span>{label}</span>
      <input type={type} value={value} placeholder={ph || ''} onChange={(e) => onChange(e.target.value)} autoComplete="off" /></label>
  )
}
function LogTail({ logRef }) {
  const logs = logRef.current.slice(-7)
  return (
    <section className="panel fadeUp" style={{ animationDelay: '.25s' }}>
      <h2>📜 Latest logs</h2>
      <div className="logbox mini">
        {logs.map((l, i) => <div key={logRef.current.length + i} className={`ln ${l.kind} slide`}><em>{fmtClock(l.t)}</em> {l.msg}</div>)}
        {logs.length === 0 && <div className="muted">logs yahan aayenge…</div>}
      </div>
    </section>
  )
}
function LogsFull({ logRef }) {
  const boxRef = useRef(null)
  const [stick, setStick] = useState(true)
  useEffect(() => { if (stick && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight })
  return (
    <main className="fadeUp">
      <div className="logHead"><h2 className="pg">📜 Live Logs</h2>
        <label className="muted"><input type="checkbox" checked={stick} onChange={(e) => setStick(e.target.checked)} /> auto-scroll</label></div>
      <div className="logbox big" ref={boxRef}>
        {logRef.current.map((l, i) => <div key={i} className={`ln ${l.kind}`}><em>{fmtClock(l.t)}</em> {l.msg}</div>)}
      </div>
    </main>
  )
}
function Explorer({ mapRef, metaRef, rejectRef, onReject, onUnreject }) {
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('')
  const [st, setSt] = useState('all')
  const [limit, setLimit] = useState(120)
  const cats = [...new Set(ITEMS.map((i) => i.cat))].sort()
  const statusOf = (it) => (mapRef.current[it.id] ? 'done' : rejectRef.current[it.id] ? 'rejected' : 'pending')
  const ql = q.trim().toLowerCase()
  const rows = ITEMS.filter((it) => {
    if (cat && it.cat !== cat) return false
    if (st !== 'all' && statusOf(it) !== st) return false
    if (ql && !(it.name.toLowerCase().includes(ql) || it.id.includes(ql))) return false
    return true
  })
  return (
    <main className="fadeUp">
      <div className="expCtrls">
        <input className="search" placeholder="🔍 search name / id…" value={q} onChange={(e) => { setQ(e.target.value); setLimit(120) }} />
        <select value={cat} onChange={(e) => { setCat(e.target.value); setLimit(120) }}>
          <option value="">All categories</option>
          {cats.map((c) => <option key={c}>{c}</option>)}
        </select>
        {['all', 'done', 'pending', 'rejected'].map((s) => (
          <button key={s} className={`chipBtn ${st === s ? 'on' : ''}`} onClick={() => { setSt(s); setLimit(120) }}>{s}</button>
        ))}
        <span className="muted">{rows.length.toLocaleString('en-IN')} items</span>
      </div>
      <div className="expGrid">
        {rows.slice(0, limit).map((it) => {
          const s = statusOf(it)
          const url = mapRef.current[it.id]
          const src = metaRef.current[it.id]?.src
          return (
            <div key={it.id} className={`expCard ${s}`} title={promptFor(it)}>
              <div className="thumb">
                {url ? <img src={url} loading="lazy" alt={it.name} /> : <span className="emo pulse">{it.ft === 'cooked' ? '🍲' : '🌿'}</span>}
                {s === 'done' && (
                  <div className="thumbOps">
                    <button className="opBtn bad" title="Reject — dobara banao" onClick={() => onReject(it.id)}>👎</button>
                    <span className="srcTag">{SRC_ICON[src] || '✅'}</span>
                  </div>
                )}
                {s === 'rejected' && <button className="opBtn ok rejUndo" onClick={() => onUnreject(it.id)}>↩️ undo</button>}
              </div>
              <div className="expName">{it.name}</div>
              <div className="expMeta">{it.cat} · <b className={s}>{s === 'rejected' ? '👎 rejected' : s}</b></div>
            </div>
          )
        })}
      </div>
      {rows.length > limit && <button className="btn ghost more" onClick={() => setLimit((l) => l + 240)}>⬇ aur dikhao ({rows.length - limit})</button>}
    </main>
  )
}
function ExportPanel({ exportAll, exportMapOnly, stats }) {
  const [busy, setBusy] = useState(false)
  const [doneStats, setDoneStats] = useState(null)
  return (
    <main className="exportPg fadeUp">
      <h2 className="pg">📦 Export</h2>
      <div className="expStats">
        <Stat label="TOTAL" value={stats.total} icon="🍱" />
        <Stat label="DONE" value={stats.done} icon="✅" accent="green" />
        <Stat label="🌐 ONLINE" value={stats.onlineFound} icon="🌐" accent="blue" />
        <Stat label="🎨 AI" value={stats.aiGen} icon="🎨" accent="purple" />
      </div>
      <div className="panel">
        <h2>Downloads</h2>
        <div className="btns col">
          <button className="btn go" disabled={busy} onClick={async () => { setBusy(true); setDoneStats(await exportAll()); setBusy(false) }}>
            {busy ? '⏳ bundle ban raha…' : '⬇ gharapp_seed_with_images.json + item_images_map_app.json'}
          </button>
          <button className="btn ghost" onClick={exportMapOnly}>⬇ sirf map JSON</button>
        </div>
        {doneStats && <p className="ok2">✅ per-item image: <b>{doneStats.perItem}</b>/{doneStats.total}</p>}
        <p className="note">ℹ️ 100% complete pe auto-download hota hai.</p>
      </div>
    </main>
  )
}
