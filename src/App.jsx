import React, { useEffect, useRef, useState } from 'react'
import {
  promptFor, generateOne, fetchImageBlob,
  uploadImgbb, uploadGithub, uploadR2, r2Test, ensureGhBranch,
  download, buildFinalSeed, sleep,
} from './factory.js'
import ITEMS from './data/items.json'
import CAT_MAP from './data/cat_map.json'

const LS_SET = 'gif4_settings_v1'
const LS_MAP = 'gif4_map_v1'

const DEFAULT_SETTINGS = {
  provider: 'github',
  ghPat: '', ghOwner: 'jackbhai', ghRepo: 'gharapp-image-factory',
  ghBranch: 'food-images', ghFolder: 'images/items',
  r2AccountId: '', r2KeyId: '', r2Secret: '', r2Bucket: 'gharapp-images', r2Pub: '',
  imgbbKey: '',
  workers: 10, autoRounds: 3,
}
const WORKFLOWS = [
  { file: 'bb-scrape.yml', name: 'BigBasket', emoji: '🛒' },
  { file: 'qc-scrape.yml', name: 'Blinkit', emoji: '⚡' },
]

const loadLS = (k, d) => { try { return { ...d, ...JSON.parse(localStorage.getItem(k) || '{}') } } catch { return d } }
const fmtClock = (t) => new Date(t).toLocaleTimeString('en-IN', { hour12: false })
const fmtDur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s` }

export default function App() {
  const [tab, setTab] = useState('dash')
  const [settings, setSettings] = useState(() => loadLS(LS_SET, DEFAULT_SETTINGS))
  const [completedAt, setCompletedAt] = useState(null)
  const [r2Testing, setR2Testing] = useState(false)
  const [, setTick] = useState(0)

  const mapRef = useRef(loadLS(LS_MAP, {}))
  const failRef = useRef({})
  const rejectRef = useRef({})
  const logRef = useRef([])
  const wallRef = useRef([])
  const inflightRef = useRef(new Map())
  const srcCountRef = useRef({})          // ai / server counts
  const serverCountRef = useRef(0)
  const runsRef = useRef([])              // gh actions runs
  const speedRef = useRef([])
  const histRef = useRef([])
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
  const aiGen = srcCountRef.current.ai || 0
  const now = Date.now()
  const perMin = speedRef.current.filter((t) => now - t < 60000).length
  const remain = total - done
  const etaMin = perMin > 0 ? remain / perMin : null
  const running = runRef.current.running
  const pct = (done / total) * 100

  const saveMap = () => { localStorage.setItem(LS_MAP, JSON.stringify(mapRef.current)) }

  const ghCfg = () => {
    const s = settingsRef.current
    return { pat: s.ghPat.trim(), owner: s.ghOwner.trim(), repo: s.ghRepo.trim(), branch: s.ghBranch.trim(), folder: s.ghFolder.trim().replace(/^\/+|\/+$/g, '') }
  }
  const r2Cfg = () => {
    const s = settingsRef.current
    return { accountId: s.r2AccountId.trim(), keyId: s.r2KeyId.trim(), secret: s.r2Secret.trim(), bucket: s.r2Bucket.trim(), pub: s.r2Pub.trim() }
  }

  // ============ SERVER SCRAPER SYNC + TRIGGERS ============
  async function ghApi(pat, method, url, body) {
    const r = await fetch('https://api.github.com' + url, {
      method,
      headers: { Authorization: 'Bearer ' + pat, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    return r
  }

  async function seedFromServer(manual) {
    const s = settingsRef.current
    const pat = s.ghPat.trim()
    if (!pat) { if (manual) log('⛔ PAT pehle paste karo — server se sync ke liye', 'err'); return }
    try {
      const c = ghCfg()
      const r = await ghApi(pat, 'GET', `/repos/${c.owner}/${c.repo}/git/trees/${encodeURIComponent(c.branch)}?recursive=1`)
      if (!r.ok) return
      const j = await r.json()
      const pre = c.folder + '/'
      let added = 0, found = 0
      for (const t of j.tree || []) {
        const p = t.path || ''
        if (p.startsWith(pre) && p.endsWith('.jpg')) {
          found++
          const id = p.slice(pre.length, -4)
          if (!mapRef.current[id]) {
            mapRef.current[id] = `https://cdn.jsdelivr.net/gh/${c.owner}/${c.repo}@${c.branch}/${p}`
            added++
          }
        }
      }
      serverCountRef.current = found
      if (added) saveMap()
      if (manual || added) log(`🖥 server scrapers sync: branch me {found} images, +${added} nayi mil gayi`.replace('{found}', found), 'ok')
    } catch (e) { if (manual) log('sync fail: ' + e.message, 'err') }
    pollRuns()
  }

  async function pollRuns() {
    const pat = settingsRef.current.ghPat.trim()
    if (!pat) return
    try {
      const c = ghCfg()
      const r = await ghApi(pat, 'GET', `/repos/${c.owner}/${c.repo}/actions/runs?per_page=6`)
      const j = await r.json()
      runsRef.current = (j.workflow_runs || []).map((x) => ({
        id: x.id, name: x.name, status: x.status, conclusion: x.conclusion,
        created: x.created_at, url: x.html_url,
      }))
    } catch {}
  }

  async function triggerWorkflow(wf) {
    const pat = settingsRef.current.ghPat.trim()
    if (!pat) { log('⛔ PAT paste karo — scraper trigger ke liye', 'err'); return }
    const c = ghCfg()
    log(`🚀 ${wf.emoji} ${wf.name} scraper trigger ho raha (GitHub Actions)…`, 'big')
    const r = await ghApi(pat, 'POST', `/repos/${c.owner}/${c.repo}/actions/workflows/${wf.file}/dispatches`, { ref: 'main' })
    if (r.status === 204) { log(`✅ ${wf.name} scraper chal pada! Fresh server IP pe — ${total} items scan honge`, 'ok'); setTimeout(() => pollRuns(), 4000); setTimeout(() => seedFromServer(false), 45000) }
    else log('❌ trigger fail: HTTP ' + r.status, 'err')
  }

  // auto-sync every 30s (scraper ke images live milte rahenge)
  useEffect(() => {
    const iv = setInterval(() => { seedFromServer(false) }, 30000)
    seedFromServer(false)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.ghPat])

  // ============ AI fallback pipeline ============
  async function processOne(item, wid) {
    inflightRef.current.set(item.id, { stage: '🎨 AI gen', name: item.name, wid })
    const prompt = promptFor(item)
    const gen = await generateOne(prompt, 3, (a, e) => log(`⚠️ W${wid} ${item.name}: retry ${a} (${e})`, 'warn'))
    inflightRef.current.set(item.id, { stage: '🪞 fetch', name: item.name, wid })
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
        srcCountRef.current[r.src] = (srcCountRef.current[r.src] || 0) + 1
        speedRef.current.push(Date.now())
        wallRef.current.unshift({ id: item.id, name: item.name, url: finalUrl, src: r.src, at: Date.now() })
        if (wallRef.current.length > 120) wallRef.current.length = 120
        delete failRef.current[item.id]
        log(`🎨 ${item.name} ← AI banayi`, 'ok')
        if (speedRef.current.length % 10 === 0) saveMap()
      } catch (e) {
        const msg = String(e.message || e)
        failRef.current[item.id] = msg
        log(`❌ ${item.name}: ${msg}`, 'err')
        if (e.rateLimited) { runRef.current.cooldownUntil = Date.now() + 60000; log('🧊 rate-limit — 60s cooldown…', 'cool') }
      } finally { inflightRef.current.delete(item.id) }
    }
  }

  async function startRun() {
    const s = settings
    if (running) return
    if (s.provider === 'github' && !s.ghPat.trim()) { log('⛔ GitHub PAT paste karo', 'err'); return }
    if (s.provider === 'r2' && (!s.r2KeyId.trim() || !s.r2Pub.trim())) { log('⛔ R2 fields bharo', 'err'); return }
    if (s.provider === 'imgbb' && !s.imgbbKey.trim()) { log('⛔ imgbb key paste karo', 'err'); return }
    if (s.provider === 'github') {
      try { await ensureGhBranch({ ...ghCfg() }, log) } catch (e) { log('⛔ GitHub: ' + e.message, 'err'); return }
    }
    await seedFromServer(false)
    queueRef.current = ITEMS.filter((it) => !mapRef.current[it.id])
    ptrRef.current = 0
    for (const k of Object.keys(failRef.current)) if (mapRef.current[k]) delete failRef.current[k]
    runRef.current = { running: true, stopFlag: false, round: runRef.current.round + 1, startedAt: Date.now(), cooldownUntil: 0 }
    log(`🚀 Round ${runRef.current.round} — ${queueRef.current.length} pending (scraper ke baad) · ${s.workers} AI workers`, 'big')
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
    if (left === 0) { log('🎉🎉 ALL IMAGES COMPLETE!', 'big'); setCompletedAt(Date.now()); exportAll() }
    else log(`⏹ stop — ${left} baaki`, 'warn')
  }

  const stopRun = () => { runRef.current.stopFlag = true; saveMap(); log('⏸ Stop signal…', 'cool') }
  const resetFails = () => { failRef.current = {}; log('🔄 fails clear', 'info') }
  const hardReset = () => {
    if (!confirm('Browser map delete? (server/branch ki images safe rahengi, sync se wapas aa jayengi)')) return
    localStorage.removeItem(LS_MAP); mapRef.current = {}; failRef.current = {}; rejectRef.current = {}; wallRef.current = []; srcCountRef.current = {}
    log('🧹 reset', 'warn')
  }
  const rejectImage = async (id) => {
    const it = ITEMS.find((x) => x.id === id)
    delete mapRef.current[id]; rejectRef.current[id] = true; saveMap()
    // NOTE: branch wali image skip ke liye reject list jaisi rakhte hain — sync re-fill na kare
    log(`👎 ${it?.name || id} reject — next AI run pe dobara banegi`, 'warn')
  }
  const unreject = (id) => { delete rejectRef.current[id]; log('👍 un-reject', 'info') }

  async function testR2() {
    const c = r2Cfg()
    if (!c.accountId || !c.keyId || !c.secret || !c.bucket || !c.pub) { log('⛔ R2 ke 5 fields bharo', 'err'); return }
    setR2Testing(true); log('🧪 R2 test…', 'info')
    try { await r2Test(c); log('✅ R2 PERFECT! 🚀', 'big') } catch (e) { log('❌ R2: ' + e.message, 'err') }
    setR2Testing(false)
  }

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
            <h1>GharApp Image Factory <span className="vtag">v4</span></h1>
            <div className="sub">🛒 quick-commerce SCRAPERS (GitHub Actions) + 🎨 AI fallback → permanent CDN · {total.toLocaleString('en-IN')} items</div>
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
            <Stat label="🛒 SCRAPER SE" value={serverCountRef.current} icon="🛒" accent="blue" sub="server (GitHub Actions)" />
            <Stat label="🎨 AI SE" value={aiGen} icon="🎨" accent="purple" sub="is app me" />
            <Stat label="PENDING" value={remain} icon="⏳" accent="amber" />
            <Stat label="SPEED" value={0} icon="🚄" accent="blue" text={perMin ? `${perMin}/min` : '—'} sub={running && etaMin ? `ETA ~${fmtDur(etaMin * 60000)}` : ''} />
            <Stat label="FAILED" value={failCount} icon="❌" accent="red" sub={rejectCount ? `👎 ${rejectCount} rejected` : ''} />
          </div>

          <div className="progressWrap fadeUp" style={{ animationDelay: '.1s' }}>
            <div className="progressTop">
              <span><b>{pct.toFixed(2)}%</b> complete</span>
              <span>{done} / {total} · scraper 🛒 {serverCountRef.current} · AI 🎨 {aiGen}</span>
            </div>
            <div className="bar"><div className={`fill ${running ? 'anim' : ''}`} style={{ width: pct + '%' }} /></div>
          </div>

          <section className="panel fadeUp" style={{ animationDelay: '.12s' }}>
            <h2>🖥 Server Scrapers <span className="muted">(GitHub Actions pe chalte hain — sabse fast, IP-safe)</span>
              <button className="btn ghost smbtn" onClick={() => seedFromServer(true)}>🔄 Sync now</button>
            </h2>
            <div className="wfGrid">
              {WORKFLOWS.map((wf) => {
                const last = runsRef.current.find((r) => (r.name || '').toLowerCase().includes(wf.name.toLowerCase()))
                const st = last ? (last.status === 'completed' ? (last.conclusion || 'done') : last.status.replace('_', ' ')) : 'idle'
                return (
                  <div key={wf.file} className="wfCard">
                    <div className="wfTitle">{wf.emoji} {wf.name} scraper</div>
                    <div className={`wfStatus st-${st.split(' ')[0]}`}>{st}</div>
                    <button className="btn go smbtn" onClick={() => triggerWorkflow(wf)}>▶ Trigger</button>
                  </div>
                )
              })}
            </div>
            {runsRef.current.length > 0 && (
              <div className="runsList">
                {runsRef.current.slice(0, 5).map((r) => (
                  <a key={r.id} href={r.url} target="_blank" rel="noreferrer" className={`runRow st-${r.status}`}>
                    <span>{r.name}</span><span>{r.status}{r.conclusion ? ` · ${r.conclusion}` : ''}</span><em>{r.created?.slice(11, 19)}</em>
                  </a>
                ))}
              </div>
            )}
            <p className="note">💡 Trigger dabane se GitHub Actions pe full scrape chalti hai — images seedha {settings.ghBranch} branch me aati hain, app har 30s me auto-sync karti hai. Uske baad jo bache, wo ⬇ AI banayega.</p>
          </section>

          <div className="midGrid fadeUp" style={{ animationDelay: '.15s' }}>
            <section className="panel">
              <h2>👷 AI Workers <span className="liveN">{inflightRef.current.size} active</span></h2>
              <div className="wgrid">
                {[...inflightRef.current.entries()].slice(0, 16).map(([id, w]) => (
                  <div key={id} className="wtile"><span className="wstage">{w.stage}</span><span className="wname">{w.name}</span><span className="wid">W{w.wid}</span></div>
                ))}
                {inflightRef.current.size === 0 && <p className="muted">Scraper trigger karo ya AI START dabao 🔥</p>}
              </div>
            </section>
            <section className="panel">
              <h2>📈 Speed <span className="muted">(img/min)</span></h2>
              <Sparkline histRef={histRef} perMin={perMin} running={running} />
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
                    <div className="provDesc">{settings.ghRepo}@{settings.ghBranch} — scrapers bhi yahi bhar rahe hain ✅</div>
                  </label>
                  <label className={`prov ${settings.provider === 'r2' ? 'on' : ''}`}>
                    <input type="radio" checked={settings.provider === 'r2'} onChange={() => setS('provider', 'r2')} />
                    <div className="provTitle">⚡ Cloudflare R2 <span className="reco2">beta</span></div>
                    <div className="provDesc">Optional fast CDN.</div>
                  </label>
                  <label className={`prov ${settings.provider === 'imgbb' ? 'on' : ''}`}>
                    <input type="radio" checked={settings.provider === 'imgbb'} onChange={() => setS('provider', 'imgbb')} />
                    <div className="provTitle">☁️ imgbb <span className="warn2">backup</span></div>
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
                      <Field label="Account ID" value={settings.r2AccountId} onChange={(v) => setS('r2AccountId', v)} />
                      <Field label="Access Key ID" type="password" value={settings.r2KeyId} onChange={(v) => setS('r2KeyId', v)} />
                      <Field label="Secret Access Key" type="password" value={settings.r2Secret} onChange={(v) => setS('r2Secret', v)} />
                      <Field label="Bucket name" value={settings.r2Bucket} onChange={(v) => setS('r2Bucket', v)} />
                      <Field label="Public URL (pub-****.r2.dev)" value={settings.r2Pub} onChange={(v) => setS('r2Pub', v)} />
                    </div>
                    <button className="btn ghost" disabled={r2Testing} onClick={testR2}>{r2Testing ? '⏳ testing…' : '🧪 Test R2'}</button>
                  </div>
                )}
                {settings.provider === 'imgbb' && (
                  <div className="fieldGrid"><Field label="imgbb key" type="password" value={settings.imgbbKey} onChange={(v) => setS('imgbbKey', v)} /></div>
                )}
              </div>
              <div>
                <h3>🧠 Pipeline (simplified)</h3>
                <p className="pipeLegend">
                  1️⃣ <b>🛒 Server scrapers</b> — BigBasket + Blinkit (GitHub Actions, fresh IPs): real store photos, exact match<br />
                  2️⃣ <b>🎨 AI fallback</b> — jo scrapers pe na mile, enhanced descriptor prompts se yahin browser me ban jayega<br />
                  3️⃣ <b>Sab permanent ↔ CDN</b> — export pe final seed JSON
                </p>
                <div className="rowCtrls" style={{ marginTop: 8 }}>
                  <div className="sliderBox">
                    <label>AI Workers: <b>{settings.workers}</b></label>
                    <input type="range" min="2" max="24" value={settings.workers} onChange={(e) => setS('workers', +e.target.value)} />
                  </div>
                  <div className="btns">
                    {!running ? <button className="btn go" onClick={startRun}>▶ AI START {done > 0 ? 'RESUME' : ''}</button> : <button className="btn stop" onClick={stopRun}>⏸ STOP</button>}
                    <button className="btn ghost" onClick={resetFails}>🔄 Reset fails</button>
                    <button className="btn ghost" onClick={hardReset}>🧹 Reset</button>
                  </div>
                </div>
                <p className="note">💾 autosave har 10 images · 👎 Explorer reject → regen · 100% pe auto-export</p>
              </div>
            </div>
          </section>

          <LogTail logRef={logRef} />
        </main>
      )}

      {tab === 'wall' && (
        <main className="fadeUp">
          <h2 className="pg">🖼 Live Wall</h2>
          {wallRef.current.length === 0 && <p className="muted">Abhi kuch nahi</p>}
          <div className="wall">
            {wallRef.current.map((w) => (
              <figure key={w.id + w.at} className="wallCard pop">
                <img src={w.url} alt={w.name} loading="lazy" />
                <figcaption>{w.name}<span>{fmtClock(w.at)}</span></figcaption>
              </figure>
            ))}
          </div>
        </main>
      )}

      {tab === 'explore' && <Explorer mapRef={mapRef} rejectRef={rejectRef} onReject={rejectImage} onUnreject={unreject} />}
      {tab === 'logs' && <LogsFull logRef={logRef} />}
      {tab === 'export' && <ExportPanel exportAll={exportAll} exportMapOnly={exportMapOnly} stats={{ total, done, server: serverCountRef.current, aiGen }} />}
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
      <div className="confettiCard"><div className="bigC">🎉 MISSION COMPLETE 🎉</div><p>Final JSON auto-download ho raha hai</p><button className="btn go">OK ✨</button></div>
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
function Explorer({ mapRef, rejectRef, onReject, onUnreject }) {
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
          return (
            <div key={it.id} className={`expCard ${s}`} title={promptFor(it)}>
              <div className="thumb">
                {url ? <img src={url} loading="lazy" alt={it.name} /> : <span className="emo pulse">{it.ft === 'cooked' ? '🍲' : '🌿'}</span>}
                {s === 'done' && <div className="thumbOps"><button className="opBtn bad" onClick={() => onReject(it.id)}>👎</button></div>}
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
        <Stat label="🛒 SCRAPER" value={stats.server} icon="🛒" accent="blue" />
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
      </div>
    </main>
  )
}
