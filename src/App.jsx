import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  promptFor, descFor, generateOne, fetchImageBlob,
  uploadImgbb, uploadGithub, ensureGhBranch,
  download, buildFinalSeed, sleep,
} from './factory.js'
import ITEMS from './data/items.json'
import SEEDED_MAP from './data/seeded_map.json'
import CAT_MAP from './data/cat_map.json'

const LS_SET = 'gif_settings_v1'
const LS_MAP = 'gif_map_v2'

const DEFAULT_SETTINGS = {
  provider: 'github',          // github = permanent (recommended) | imgbb
  ghPat: '',
  ghOwner: 'jackbhai',
  ghRepo: 'gharapp-image-factory',
  ghBranch: 'food-images',
  ghFolder: 'images/items',
  imgbbKey: '',
  workers: 12,
  autoRounds: 3,
}

const loadLS = (k, d) => { try { return { ...d, ...JSON.parse(localStorage.getItem(k) || '{}') } } catch { return d } }
const fmtClock = (t) => new Date(t).toLocaleTimeString('en-IN', { hour12: false })
const fmtDur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s` }

export default function App() {
  const [tab, setTab] = useState('dash')
  const [settings, setSettings] = useState(() => loadLS(LS_SET, DEFAULT_SETTINGS))
  const [, setTick] = useState(0)

  // ---- heavy mutable state in refs (tick se UI refresh) ----
  const mapRef = useRef(null)
  const failRef = useRef({})
  const logRef = useRef([])
  const wallRef = useRef([])
  const inflightRef = useRef(new Map()) // id -> stage text
  const runRef = useRef({ running: false, stopFlag: false, round: 0, startedAt: 0, cooldownUntil: 0 })
  const speedRef = useRef([]) // completion timestamps
  const ptrRef = useRef(0)
  const queueRef = useRef([])

  if (!mapRef.current) {
    // seeded (imgbb, 847 done) + is-browser ka pehle ka saved progress
    let saved = {}
    try { saved = JSON.parse(localStorage.getItem(LS_MAP) || '{}') } catch {}
    mapRef.current = { ...SEEDED_MAP, ...saved }
  }

  const log = (msg, kind = 'info') => {
    logRef.current.push({ t: Date.now(), msg, kind })
    if (logRef.current.length > 600) logRef.current.splice(0, logRef.current.length - 600)
  }

  useEffect(() => { const iv = setInterval(() => setTick((x) => x + 1), 500); return () => clearInterval(iv) }, [])
  useEffect(() => { localStorage.setItem(LS_SET, JSON.stringify(settings)) }, [settings])

  const setS = (k, v) => setSettings((s) => ({ ...s, [k]: v }))

  // ---- derived stats (har 500ms tick pe fresh compute — 2657 items cheap) ----
  const total = ITEMS.length
  let done = 0
  for (const it of ITEMS) if (mapRef.current[it.id]) done++
  const failCount = Object.keys(failRef.current).length
  const now = Date.now()
  const recent = speedRef.current.filter((t) => now - t < 60000)
  const perMin = recent.length
  const remain = Math.max(0, total - done)
  const etaMin = perMin > 0 ? remain / perMin : null
  const running = runRef.current.running
  const pct = ((done / total) * 100)

  const saveMap = () => {
    // sirf NON-seeded entries save karo (localStorage chhota rahe)
    const out = {}
    for (const [k, v] of Object.entries(mapRef.current)) if (!SEEDED_MAP[k]) out[k] = v
    localStorage.setItem(LS_MAP, JSON.stringify(out))
  }

  // ---- worker engine ----
  async function workerLoop(wid) {
    for (;;) {
      const run = runRef.current
      if (run.stopFlag) return
      if (Date.now() < run.cooldownUntil) { await sleep(2000); continue }
      const i = ptrRef.current++
      if (i >= queueRef.current.length) return
      const item = queueRef.current[i]
      if (mapRef.current[item.id]) continue
      inflightRef.current.set(item.id, 'prompt')
      try {
        const prompt = promptFor(item)
        inflightRef.current.set(item.id, '🎨 generating')
        const gen = await generateOne(prompt, 3, (a, e) => log(`⚠️ W${wid} ${item.name}: retry ${a} (${e})`, 'warn'))
        inflightRef.current.set(item.id, '☁️ uploading')
        const blob = await fetchImageBlob(gen.imageUrl)
        const finalUrl = settingsRef.current.provider === 'github'
          ? await uploadGithub(ghCfg(), item, blob)
          : await uploadImgbb(gen.imageUrl, blob, item.id, settingsRef.current.imgbbKey)
        mapRef.current[item.id] = finalUrl
        speedRef.current.push(Date.now())
        wallRef.current.unshift({ id: item.id, name: item.name, url: finalUrl, temp: gen.imageUrl, at: Date.now() })
        if (wallRef.current.length > 96) wallRef.current.length = 96
        delete failRef.current[item.id]
        log(`✅ ${item.name} → ${shortUrl(finalUrl)}`, 'ok')
        if (speedRef.current.length % 10 === 0) saveMap()
      } catch (e) {
        const msg = String(e.message || e)
        failRef.current[item.id] = msg
        log(`❌ ${item.name}: ${msg}`, 'err')
        if (e.rateLimited) {
          runRef.current.cooldownUntil = Date.now() + 60000
          log('🧊 rate-limit mila — 60s cooldown, phir auto-resume…', 'cool')
        }
      } finally {
        inflightRef.current.delete(item.id)
      }
    }
  }

  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const ghCfg = () => {
    const s = settingsRef.current
    return { pat: s.ghPat.trim(), owner: s.ghOwner.trim(), repo: s.ghRepo.trim(), branch: s.ghBranch.trim(), folder: s.ghFolder.trim().replace(/^\/+|\/+$/g, '') }
  }

  async function startRun(fromFailsOnly = false) {
    const s = settings
    if (running) return
    if (s.provider === 'github' && !s.ghPat.trim()) { log('⛔ GitHub PAT pehle paste karo (Settings me). Sirf localStorage me save hoga.', 'err'); setTab('dash'); return }
    if (s.provider === 'imgbb' && !s.imgbbKey.trim()) { log('⛔ imgbb key pehle paste karo.', 'err'); return }

    if (s.provider === 'github') {
      log(`🔐 GitHub check: ${s.ghOwner}/${s.ghRepo} @ ${s.ghBranch}…`)
      try {
        await ensureGhBranch({ ...ghCfg() }, log)
        log('✅ GitHub repo + branch ready', 'ok')
      } catch (e) {
        log('⛔ GitHub setup fail: ' + e.message, 'err'); return
      }
    }

    queueRef.current = ITEMS.filter((it) =>
      fromFailsOnly ? failRef.current[it.id] && !mapRef.current[it.id] : !mapRef.current[it.id]
    )
    ptrRef.current = 0
    runRef.current = { running: true, stopFlag: false, round: runRef.current.round + 1, startedAt: Date.now(), cooldownUntil: 0 }
    log(`🚀 Round ${runRef.current.round} start — ${queueRef.current.length} items, ${s.workers} workers, host: ${s.provider}`, 'big')
    await Promise.all(Array.from({ length: s.workers }, (_, w) => workerLoop(w + 1)))
    saveMap()

    const left = ITEMS.filter((it) => !mapRef.current[it.id]).length
    if (left > 0 && !runRef.current.stopFlag && runRef.current.round < s.autoRounds) {
      log(`🔁 ${left} baaki — 20s me auto round ${runRef.current.round + 1}…`, 'cool')
      for (let i = 0; i < 20 && !runRef.current.stopFlag; i++) await sleep(1000)
      runRef.current.running = false
      if (!runRef.current.stopFlag) return startRun(true)
    }
    runRef.current.running = false
    saveMap()
    if (left === 0) {
      log('🎉🎉 MISSION COMPLETE — saari', 'big')
      log('🎉 ALL 2,657 IMAGES DONE! Auto-export chal raha hai…', 'big')
      exportAll()
    } else {
      log(`⏹ stop — ${left} items baaki (${Object.keys(failRef.current).length} failed)`, 'warn')
    }
  }

  const stopRun = () => { runRef.current.stopFlag = true; saveMap(); log('⏸ Stop signal diya — workers apna current item khatam karke rukenge', 'cool') }

  const resetFails = () => { failRef.current = {}; log('🔄 fail list clear — ab Start dabao, sab dobara try hoga', 'info') }

  const hardReset = () => {
    if (!confirm('Saara browser-side progress delete? (seeded 847 imgbb wale bache rehte hain)')) return
    localStorage.removeItem(LS_MAP)
    mapRef.current = { ...SEEDED_MAP }
    failRef.current = {}; wallRef.current = []
    log('🧹 browser progress reset', 'warn')
  }

  // ---- export ----
  async function exportAll() {
    try {
      const seedRes = await fetch(import.meta.env.BASE_URL + 'gharapp_seed.json')
      const fullSeed = await seedRes.json()
      const { seed, stats } = buildFinalSeed(fullSeed, mapRef.current, CAT_MAP)
      download('gharapp_seed_with_images.json', JSON.stringify(seed))
      download('item_images_map_app.json', JSON.stringify(mapRef.current))
      log(`📦 export done — per-item: ${stats.perItem}/${stats.total}`, 'big')
      return stats
    } catch (e) { log('export fail: ' + e.message, 'err') }
  }

  const exportMapOnly = () => download('item_images_map_app.json', JSON.stringify(mapRef.current))

  // ================= UI =================
  return (
    <div className="app">
      <header className="hdr">
        <div className="brand">
          <span className="logo">⚡</span>
          <div>
            <h1>GharApp Image Factory</h1>
            <div className="sub">PixelSter → permanent host → seeded JSON · {total.toLocaleString('en-IN')} items</div>
          </div>
        </div>
        <div className="hdrRight">
          <span className={`pill ${running ? 'pill-run' : 'pill-idle'}`}>{running ? `● RUNNING · Round ${runRef.current.round}` : '○ IDLE'}</span>
          <span className="clock">{fmtClock(now)}</span>
        </div>
      </header>

      <nav className="tabs">
        {[['dash', '🎛 Dashboard'], ['wall', `🖼 Live Wall (${wallRef.current.length})`], ['explore', '🗂 Explorer'], ['logs', `📜 Logs (${logRef.current.length})`], ['export', '📦 Export']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'tab on' : 'tab'} onClick={() => setTab(k)}>{l}</button>
        ))}
      </nav>

      {tab === 'dash' && (
        <main>
          <div className="statGrid">
            <Stat label="TOTAL ITEMS" value={total.toLocaleString('en-IN')} icon="🍱" />
            <Stat label="IMAGES DONE" value={done.toLocaleString('en-IN')} icon="✅" accent="green" />
            <Stat label="PENDING" value={(total - done).toLocaleString('en-IN')} icon="⏳" accent="amber" />
            <Stat label="FAILED (session)" value={failCount} icon="❌" accent="red" />
            <Stat label="SPEED" value={perMin ? `${perMin}/min` : '—'} icon="🚄" accent="blue" sub={perMin ? `≈ ${(perMin / 60).toFixed(1)}/sec` : 'start karo'} />
            <Stat label="ETA" value={etaMin && running ? fmtDur(etaMin * 60000) : '—'} icon="⏱" accent="purple" sub={running ? 'approx' : ''} />
          </div>

          <div className="progressWrap">
            <div className="progressTop">
              <span>{pct.toFixed(2)}% complete</span>
              <span>{done} / {total}</span>
            </div>
            <div className="bar"><div className={`fill ${running ? 'anim' : ''}`} style={{ width: pct + '%' }} /></div>
          </div>

          <div className="liveLine">
            <span className="dot" />
            {inflightRef.current.size
              ? [...inflightRef.current.entries()].slice(0, 6).map(([id, stage]) => <span key={id} className="chipLive">{stage} · {ITEMS.find((x) => x.id === id)?.name}</span>)
              : <span className="muted">koi worker active nahi — Start dabao ▶</span>}
          </div>

          <section className="panel">
            <h2>⚙️ Settings</h2>
            <div className="providers">
              <label className={`prov ${settings.provider === 'github' ? 'on' : ''}`}>
                <input type="radio" checked={settings.provider === 'github'} onChange={() => setS('provider', 'github')} />
                <div className="provTitle">🔒 GitHub Hosting <span className="reco">RECOMMENDED · PERMANENT</span></div>
                <div className="provDesc">Images tumhare apne repo <b>{settings.ghRepo}</b> ke <b>{settings.ghBranch}</b> branch me commit hongi → jsDelivr CDN se serve. Ye kabhi vanish nahi hoti jab tak tum repo delete na karo.</div>
              </label>
              <label className={`prov ${settings.provider === 'imgbb' ? 'on' : ''}`}>
                <input type="radio" checked={settings.provider === 'imgbb'} onChange={() => setS('provider', 'imgbb')} />
                <div className="provTitle">☁️ imgbb <span className="warn2">free · per-key rate limit</span></div>
                <div className="provDesc">Teesri-party free host. Practically images rehti hain, par guarantee nahi; key pe din-ka rate cap.</div>
              </label>
            </div>

            {settings.provider === 'github' ? (
              <div className="fieldGrid">
                <Field label="GitHub PAT (fine-grained, Contents: Read+Write on repo)" type="password" value={settings.ghPat} onChange={(v) => setS('ghPat', v)} ph="github_pat_… — sirf is browser ke localStorage me rahega" />
                <Field label="Owner" value={settings.ghOwner} onChange={(v) => setS('ghOwner', v)} />
                <Field label="Repo" value={settings.ghRepo} onChange={(v) => setS('ghRepo', v)} />
                <Field label="Images branch" value={settings.ghBranch} onChange={(v) => setS('ghBranch', v)} />
                <Field label="Folder" value={settings.ghFolder} onChange={(v) => setS('ghFolder', v)} />
              </div>
            ) : (
              <div className="fieldGrid">
                <Field label="imgbb API key" type="password" value={settings.imgbbKey} onChange={(v) => setS('imgbbKey', v)} ph="imgbb key — sirf localStorage me" />
              </div>
            )}

            <div className="rowCtrls">
              <div className="sliderBox">
                <label>Workers: <b>{settings.workers}</b> <span className="muted">(2–24 · PixelSter per-IP throttle hai, 8–16 best)</span></label>
                <input type="range" min="2" max="24" value={settings.workers} onChange={(e) => setS('workers', +e.target.value)} />
              </div>
              <div className="btns">
                {!running
                  ? <button className="btn go" onClick={() => startRun(false)}>▶ START</button>
                  : <button className="btn stop" onClick={stopRun}>⏸ STOP</button>}
                <button className="btn ghost" onClick={resetFails}>🔄 Reset fails</button>
                <button className="btn ghost" onClick={hardReset}>🧹 Hard reset</button>
              </div>
            </div>
            <p className="note">💾 Progress har 10 images pe autosave (browser refresh-safe). PixeISter ki temp URL turant permanent host pe mirror hoti hai.</p>
          </section>

          <LogTail logRef={logRef} />
        </main>
      )}

      {tab === 'wall' && (
        <main>
          <h2 className="pg">🖼 Live Wall — abhi-abhi bani images</h2>
          {wallRef.current.length === 0 && <p className="muted">Abhi kuch nahi — Start dabao, yahan live images bharti jayengi 🔥</p>}
          <div className="wall">
            {wallRef.current.map((w) => (
              <figure key={w.id + w.at} className="wallCard">
                <img src={w.url} alt={w.name} loading="lazy"
                  onError={(e) => { if (e.currentTarget.src !== w.temp) e.currentTarget.src = w.temp }} />
                <figcaption>{w.name}<span>{fmtClock(w.at)}</span></figcaption>
              </figure>
            ))}
          </div>
        </main>
      )}

      {tab === 'explore' && <Explorer mapRef={mapRef} failRef={failRef} />}

      {tab === 'logs' && <LogsFull logRef={logRef} />}

      {tab === 'export' && (
        <ExportPanel
          exportAll={exportAll} exportMapOnly={exportMapOnly}
          stats={{ total, done, failCount }}
          mapRef={mapRef}
        />
      )}
    </div>
  )
}

const shortUrl = (u) => { try { const x = new URL(u); return x.host + '…' + x.pathname.slice(-22) } catch { return u } }

function Stat({ label, value, icon, accent = '', sub }) {
  return (
    <div className={`stat ${accent}`}>
      <div className="statIcon">{icon}</div>
      <div><div className="statVal">{value}</div><div className="statLbl">{label}</div>{sub && <div className="statSub">{sub}</div>}</div>
    </div>
  )
}

function Field({ label, value, onChange, type = 'text', ph }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type={type} value={value} placeholder={ph || ''} onChange={(e) => onChange(e.target.value)} autoComplete="off" />
    </label>
  )
}

function LogTail({ logRef }) {
  const logs = logRef.current.slice(-8)
  return (
    <section className="panel">
      <h2>📜 Latest logs <span className="muted">(sab dekhne ke liye Logs tab)</span></h2>
      <div className="logbox mini">
        {logs.map((l, i) => <div key={i} className={`ln ${l.kind}`}><em>{fmtClock(l.t)}</em> {l.msg}</div>)}
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
    <main>
      <div className="logHead">
        <h2 className="pg">📜 Live Logs</h2>
        <label className="muted"><input type="checkbox" checked={stick} onChange={(e) => setStick(e.target.checked)} /> auto-scroll</label>
      </div>
      <div className="logbox big" ref={boxRef}>
        {logRef.current.map((l, i) => <div key={i} className={`ln ${l.kind}`}><em>{fmtClock(l.t)}</em> {l.msg}</div>)}
      </div>
    </main>
  )
}

function Explorer({ mapRef, failRef }) {
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('')
  const [st, setSt] = useState('all')
  const [limit, setLimit] = useState(120)
  const cats = useMemo(() => [...new Set(ITEMS.map((i) => i.cat))].sort(), [])
  const statusOf = (it) => (mapRef.current[it.id] ? 'done' : failRef.current[it.id] ? 'fail' : 'pending')
  const ql = q.trim().toLowerCase()
  const rows = ITEMS.filter((it) => {
    if (cat && it.cat !== cat) return false
    if (st !== 'all' && statusOf(it) !== st) return false
    if (ql && !(it.name.toLowerCase().includes(ql) || it.id.includes(ql))) return false
    return true
  })
  return (
    <main>
      <div className="expCtrls">
        <input className="search" placeholder="🔍 search name / id…" value={q} onChange={(e) => { setQ(e.target.value); setLimit(120) }} />
        <select value={cat} onChange={(e) => { setCat(e.target.value); setLimit(120) }}>
          <option value="">All categories</option>
          {cats.map((c) => <option key={c}>{c}</option>)}
        </select>
        {['all', 'done', 'pending', 'fail'].map((s) => (
          <button key={s} className={`chipBtn ${st === s ? 'on' : ''}`} onClick={() => { setSt(s); setLimit(120) }}>{s}</button>
        ))}
        <span className="muted">{rows.length.toLocaleString('en-IN')} items</span>
      </div>
      <div className="expGrid">
        {rows.slice(0, limit).map((it) => {
          const s = statusOf(it)
          const url = mapRef.current[it.id] || (/^https?:/.test(it.img || '') ? it.img : null)
          return (
            <div key={it.id} className={`expCard ${s}`} title={promptFor(it)}>
              <div className="thumb">
                {url ? <img src={url} loading="lazy" alt={it.name} /> : <span className="emo">{it.ft === 'cooked' ? '🍲' : '🌿'}</span>}
              </div>
              <div className="expName">{it.name}</div>
              <div className="expMeta">{it.cat} · <b className={s}>{s}</b></div>
            </div>
          )
        })}
      </div>
      {rows.length > limit && <button className="btn ghost more" onClick={() => setLimit((l) => l + 240)}>⬇ aur dikhao ({rows.length - limit} baaki)</button>}
    </main>
  )
}

function ExportPanel({ exportAll, exportMapOnly, stats, mapRef }) {
  const [busy, setBusy] = useState(false)
  const [doneStats, setDoneStats] = useState(null)
  return (
    <main className="exportPg">
      <h2 className="pg">📦 Export</h2>
      <div className="expStats">
        <Stat label="TOTAL" value={stats.total.toLocaleString('en-IN')} icon="🍱" />
        <Stat label="PER-ITEM IMAGE" value={stats.done.toLocaleString('en-IN')} icon="✅" accent="green" />
        <Stat label="FAIL (session)" value={stats.failCount} icon="❌" accent="red" />
      </div>
      <div className="panel">
        <h2>Downloads</h2>
        <div className="btns col">
          <button className="btn go" disabled={busy} onClick={async () => { setBusy(true); setDoneStats(await exportAll()); setBusy(false) }}>
            {busy ? '⏳ seed bundle ban raha…' : '⬇ gharapp_seed_with_images.json + item_images_map_app.json'}
          </button>
          <button className="btn ghost" onClick={exportMapOnly}>⬇ sirf item_images_map_app.json</button>
        </div>
        {doneStats && (
          <p className="ok2">✅ Final seed: <b>{doneStats.perItem}</b> items ko per-item image mili · {doneStats.cat} category fallback · total {doneStats.total}. Ye file seed folder me daalo aur <code>apply</code> step bhi ho sakta hai sandbox me.</p>
        )}
        <p className="note">ℹ️ 100% complete hote hi ye dono files <b>automatically</b> download ho jati hain.</p>
      </div>
      <div className="panel">
        <h2>🔐 Permanence ka sach</h2>
        <table className="tbl">
          <thead><tr><th>Host</th><th>Permanent?</th><th>Kyun</th></tr></thead>
          <tbody>
            <tr><td>GitHub + jsDelivr</td><td className="g">✅ YES (tumhare control me)</td><td>Images tumhari repo ki files hain — tum delete na karo to rehti hain; jsDelivr CDN upar se cache karta hai.</td></tr>
            <tr><td>imgbb</td><td className="a">⚠️ practically haan, guarantee nahi</td><td>Free 3rd-party; inactivity/ToS pe delete ho sakti hain.</td></tr>
            <tr><td>PixelSter temp</td><td className="r">❌ ghanton/dinon me gayab</td><td>Isliye factory turant mirror karti hai.</td></tr>
          </tbody>
        </table>
      </div>
    </main>
  )
}
