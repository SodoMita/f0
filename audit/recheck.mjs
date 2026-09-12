// Re-check harness for the 2026-09-11 agent-browser audit (tracking issue #83).
//
//   node audit/recheck.mjs                 # every check
//   CHECKS="75 76 82" node audit/recheck.mjs   # only those issue numbers
//
// Each check re-measures ONE numbered finding from audit/BUGS.md against the
// running app (offline rig) and prints PASS/FAIL with the measured evidence.
// It exists so a fix can be claimed only with a measurement attached, and so
// the next agent can see at a glance which findings regressed.
//
// Needs: `bun run dev` (5173) + `node scripts/offline-rig.mjs` (4173/8443).
import { launch, open, URL_BASE, sleep } from './harness.mjs'

const ONLY = (process.env.CHECKS || '').split(/[\s,]+/).filter(Boolean)
const results = []
let current = null

function check(id, title) {
  if (ONLY.length && !ONLY.includes(String(id))) return null
  current = { id, title, notes: [] }
  results.push(current)
  console.log(`\n── #${id} ${title}`)
  return current
}
const note = (text) => { if (current) { current.notes.push(text); console.log(`   · ${text}`) } }
function verdict(ok, detail) {
  if (!current) return
  current.ok = !!ok
  current.detail = detail
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${detail}`)
}

const browser = await launch()

// ---------------------------------------------------------------- helpers
const DESKTOP = { width: 1280, height: 800 }

async function newPage(opts = {}) {
  const page = await browser.newPage({ viewport: DESKTOP, hasTouch: true, ...opts })
  page.on('pageerror', (e) => console.log(`   [PAGEERROR] ${String(e.message).split('\n')[0].slice(0, 160)}`))
  return page
}

/** Boot the app on the rig, dismiss the legend, wait for the board. */
async function boot(opts = {}) {
  const page = await newPage(opts)
  const consoleErrors = []
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(m.text().slice(0, 240))
  })
  await open(page, URL_BASE, { waitMs: 9000 })
  await page.evaluate(() => document.querySelector('#btn-legend-ok')?.click())
  await sleep(2500)
  page.__consoleErrors = consoleErrors
  return page
}

/** Root post ids in feed order, plus a flavour map (the rig cycles a,b,c,d,e,f,x). */
async function rigPosts(page) {
  return page.evaluate(() => {
    const roots = [...window.__form0.index.byId.values()].filter((m) => m.role === 'root' && !m.tombstoned)
    const byFlavour = {}
    for (const m of roots) {
      const f = (m.filename || (m.urls[0] || '').split('/').pop() || '?').replace(/\.glb$/, '')
      if (!byFlavour[f]) byFlavour[f] = m.eventId
    }
    return { ids: roots.map((m) => m.eventId), byFlavour, meta: Object.fromEntries(roots.map((m) => [m.eventId, {
      hasAudio: m.hasAudio, cameraCount: m.cameraCount, animHint: m.animHint, filename: m.filename, replyCount: m.childCount ?? null,
    }])) }
  })
}

async function openViewer(page, id, waitMs = 6000) {
  await page.evaluate((v) => { location.hash = '#/viewer/' + v }, id)
  await sleep(waitMs)
}

/**
 * Read the visible canvas back into a compact signature. WebGL's default
 * framebuffer is not preserved after compositing, so this renders a frame and
 * reads in the same task (the pattern scripts/offline-verify.mjs uses).
 * Returns { w, h, px } where px is a downsampled 64x40 RGBA grid, plus a
 * `diff` helper comparison against another grab.
 */
async function grab(page) {
  return page.evaluate(() => {
    const f0 = window.__form0
    const engine = f0.engine.engine
    const scene = f0.engine.activeScene ?? f0.viewer.scene
    scene.render()
    const gl = engine._gl
    const W = engine.getRenderWidth(), H = engine.getRenderHeight()
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    const full = new Uint8Array(W * H * 4)
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, full)
    const GW = 64, GH = 40
    const px = new Array(GW * GH * 3)
    for (let gy = 0; gy < GH; gy++) {
      for (let gx = 0; gx < GW; gx++) {
        // WebGL reads bottom-up; flip so row 0 is the top of the screen
        const sy = H - 1 - Math.min(H - 1, Math.floor(((gy + 0.5) / GH) * H))
        const sx = Math.min(W - 1, Math.floor(((gx + 0.5) / GW) * W))
        const i = (sy * W + sx) * 4
        const o = (gy * GW + gx) * 3
        px[o] = full[i]; px[o + 1] = full[i + 1]; px[o + 2] = full[i + 2]
      }
    }
    return { w: W, h: H, gw: GW, gh: GH, px }
  })
}

/** Fraction of sampled pixels that differ by more than `tol` per channel. */
function diffFrac(a, b, tol = 12) {
  if (!a || !b || a.px.length !== b.px.length) return 1
  let n = 0
  for (let i = 0; i < a.px.length; i += 3) {
    if (Math.abs(a.px[i] - b.px[i]) > tol || Math.abs(a.px[i + 1] - b.px[i + 1]) > tol || Math.abs(a.px[i + 2] - b.px[i + 2]) > tol) n++
  }
  return n / (a.px.length / 3)
}

/** Mean luminance of a sampled grab. */
function meanLum(g) {
  let s = 0
  for (let i = 0; i < g.px.length; i += 3) s += 0.2126 * g.px[i] + 0.7152 * g.px[i + 1] + 0.0722 * g.px[i + 2]
  return s / (g.px.length / 3)
}

/**
 * Isolate the viewer's floor-glow contribution and look for a hard edge.
 * Screenshots (not gl.readPixels): the default framebuffer is not preserved
 * after compositing, so a sync read can return a half-drawn frame.
 */
async function measureSeam(page) {
  await page.evaluate(() => {
    window.__form0.settings.set({ adaptiveResolution: false, resolutionMode: 'manual', resolutionWidth: 1280, resolutionHeight: 800, aspectLock: false })
  })
  await sleep(1200)
  await page.addStyleTag({ content: '.hud, #topbar { display: none !important }' })
  await page.evaluate(() => {
    const c = window.__form0.viewer['container']
    if (c) for (const m of c.meshes) m.setEnabled(false)
  })
  await sleep(700)
  const shot = async () => {
    await page.evaluate(() => { for (let i = 0; i < 4; i++) window.__form0.engine.activeScene.render() })
    await sleep(400)
    return page.screenshot()
  }
  await page.evaluate(() => window.__form0.viewer.setContactShadows(0.45))
  await sleep(600)
  const onBuf = await shot()
  await page.evaluate(() => window.__form0.viewer.setContactShadows(0))
  await sleep(600)
  const offBuf = await shot()
  await page.evaluate(() => {
    window.__form0.viewer.setContactShadows(0.45)
    const c = window.__form0.viewer['container']
    if (c) for (const m of c.meshes) m.setEnabled(true)
  })
  const { decode, rowProfile, seamRows } = await import('./png.mjs')
  const on = rowProfile(decode(onBuf), 384, 896)
  const off = rowProfile(decode(offBuf), 384, 896)
  const H = on.length
  const deltas = on.map((v, y) => off[y] - v)
  let firstRow = -1, lastRow = -1, peakDelta = 0, peakY = -1
  for (let y = 0; y < H; y++) {
    if (deltas[y] > 0.4) { if (firstRow < 0) firstRow = y; lastRow = y }
    if (deltas[y] > peakDelta) { peakDelta = deltas[y]; peakY = y }
  }
  const worst = seamRows(on, 0.5)[0] ?? { y: -1, step: 0 }
  const bw = seamRows(off, 0.5)[0] ?? { y: -1, step: 0 }
  // how many rows does the glow take to reach half its peak? (a soft ramp is
  // many rows; the seam was a 4-row spike straight to full opacity)
  let rampRows = 0
  if (peakY >= 0) for (let y = peakY; y < H && deltas[y] > peakDelta * 0.5; y++) rampRows++
  return {
    H, firstRow, lastRow, peakY,
    firstPct: firstRow < 0 ? 0 : Math.round((100 * firstRow) / H),
    lastPct: lastRow < 0 ? 0 : Math.round((100 * lastRow) / H),
    worstStep: +Math.abs(worst.step).toFixed(2), worstY: worst.y, worstPct: worst.y < 0 ? 0 : Math.round((100 * worst.y) / H),
    peakDelta: +peakDelta.toFixed(2), rampRows,
    backdropWorst: +Math.abs(bw.step).toFixed(2), backdropSmooth: Math.abs(bw.step) < 1.5,
  }
}

// ══════════════════════════════════════════════════════════ A. features
{
  // ---- #53 board 3D mode renders models
  const page = await boot()
  const posts = await rigPosts(page)
  const c = check(53, '[board] 3D mode renders real models')
  if (c) {
    const before = await grab(page)
    await page.click('#btn-3d')
    await sleep(14000)
    const after = await grab(page)
    const d = diffFrac(before, after)
    // count pixels that are NOT backdrop-like: the spotlight backdrop is a
    // smooth grey ramp, models bring saturated red/green cubes
    const saturated = after.px.reduce((n, _, i, arr) => {
      if (i % 3) return n
      const r = arr[i], g = arr[i + 1], b = arr[i + 2]
      return n + (Math.max(r, g, b) - Math.min(r, g, b) > 40 ? 1 : 0)
    }, 0) / (after.px.length / 3)
    note(`changed=${(d * 100).toFixed(1)}%  saturated=${(saturated * 100).toFixed(1)}%`)
    verdict(d > 0.05 && saturated > 0.01, `3D board paints model pixels (changed ${(d * 100).toFixed(1)}%, saturated ${(saturated * 100).toFixed(1)}%)`)
  }

  // ---- #68 scroll snapping (same page, back to 2D)
  const c68 = check(68, '[board] feed snaps to a row band')
  if (c68) {
    await page.click('#btn-3d') // back to 2D
    await sleep(1500)
    await page.mouse.move(640, 500)
    await page.mouse.wheel(0, 430)
    await sleep(2600)
    const snap = await page.evaluate(() => {
      const b = window.__form0.board
      const y = b.scrollY ?? b['scrollY']
      const pitch = b.bandPitch?.() ?? null
      return { y, pitch }
    })
    note(`scrollY=${snap.y} pitch=${snap.pitch}`)
    // Without a public pitch, measure the settle: a second wheel of the same
    // size must land on a different band, and resting y must be near a multiple
    // of the row pitch derived from the card layout.
    const geom = await page.evaluate(() => {
      const b = window.__form0.board
      const rows = b['rows'] || []
      const tops = [...new Set(rows.map((r) => r.top))].sort((x, y) => x - y)
      const pitch = tops.length > 1 ? tops[1] - tops[0] : null
      return { y: b['scrollY'], pitch, bands: tops.length }
    })
    const rest = geom.pitch ? Math.abs(((geom.y % geom.pitch) + geom.pitch) % geom.pitch) : null
    const off = rest === null ? null : Math.min(rest, geom.pitch - rest)
    note(`y=${geom.y?.toFixed?.(1)} pitch=${geom.pitch?.toFixed?.(1)} offsetFromBand=${off?.toFixed?.(1)}`)
    verdict(off !== null && off < geom.pitch * 0.12, `feed rests ${(off ?? -1).toFixed(1)}px from a band edge (pitch ${geom.pitch?.toFixed?.(1)})`)
  }

  // ---- #69 wheel over the top HUD must not scroll the feed
  const c69 = check(69, '[ui] wheel over the topbar does not scroll the scene')
  if (c69) {
    const y0 = await page.evaluate(() => window.__form0.board['scrollY'])
    const box = await page.evaluate(() => {
      const r = document.getElementById('topbar').getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    await page.mouse.move(box.x, box.y)
    await page.mouse.wheel(0, 300)
    await sleep(1800)
    const y1 = await page.evaluate(() => window.__form0.board['scrollY'])
    note(`scrollY ${y0?.toFixed?.(1)} -> ${y1?.toFixed?.(1)} over the topbar`)
    verdict(Math.abs(y1 - y0) < 1, `topbar wheel shielded (Δ=${Math.abs(y1 - y0).toFixed(2)})`)
  }

  // ---- #70 Babylon's stock unmute icon
  const c70 = check(70, '[ui] no Babylon unmute icon over the brand')
  if (c70) {
    const icon = await page.evaluate(() => {
      const el = document.getElementById('babylonUnmuteIconBtn') || document.querySelector('.babylonUnmuteIcon')
      if (!el) return { present: false }
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return { present: true, visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0, rect: { w: r.width, h: r.height, x: r.left, y: r.top } }
    })
    note(JSON.stringify(icon))
    verdict(!icon.present || !icon.visible, icon.present ? 'icon present but hidden by CSS' : 'icon never created')
  }

  // ---- #71 reply badge sits inside its own card
  const c71 = check(71, '[board] reply badge is inside its card, not the row above')
  if (c71) {
    const badge = await page.evaluate(() => {
      const b = window.__form0.board
      const out = []
      for (const slot of b['cards']) {
        if (!slot.meta || slot.replyCount <= 0 || !slot.badge.isEnabled()) continue
        const card = { x: slot.mesh.position.x, y: slot.mesh.position.y, w: slot.w, h: slot.h }
        out.push({ card, badge: { x: slot.badge.position.x, y: slot.badge.position.y } })
      }
      return out.slice(0, 6)
    })
    note(`${badge.length} badge(s) measured`)
    let worst = 0
    for (const s of badge) {
      const dy = s.badge.y - s.card.y // board units, +y is up
      const inside = Math.abs(dy) <= s.card.h / 2 && Math.abs(s.badge.x - s.card.x) <= s.card.w / 2
      worst = Math.max(worst, Math.abs(dy) / (s.card.h / 2))
      note(`card(${s.card.x.toFixed(1)},${s.card.y.toFixed(1)} ${s.card.w.toFixed(1)}x${s.card.h.toFixed(1)}) badge(${s.badge.x.toFixed(1)},${s.badge.y.toFixed(1)}) dy=${dy.toFixed(2)} inside=${inside}`)
      if (!inside) { verdict(false, 'badge outside its card box'); break }
    }
    if (!current.detail) verdict(worst <= 1, `every badge inside its card (worst |dy| = ${(worst * 100).toFixed(0)}% of half-height)`)
  }

  // ---- #62 board keyboard navigation
  const c62 = check(62, '[board] arrows/Enter keyboard navigation')
  if (c62) {
    await page.evaluate(() => document.getElementById('engine')?.focus?.())
    await page.keyboard.press('ArrowDown')
    await sleep(400)
    await page.keyboard.press('ArrowRight')
    await sleep(400)
    const sel = await page.evaluate(() => {
      const b = window.__form0.board
      const m = b.selectionMeta?.()
      return { has: !!m, id: m?.eventId?.slice(0, 8) ?? null, ring: !!b['selRing']?.isEnabled?.() }
    })
    note(`after Down+Right: ${JSON.stringify(sel)}`)
    await page.keyboard.press('Enter')
    await sleep(4000)
    const mode = await page.evaluate(() => window.__form0.__mode())
    note(`Enter -> mode=${mode}`)
    verdict(!!sel.has && mode === 'viewer', `arrows select (${sel.id}) and Enter opens the viewer`)
  }
  await page.close()
}

// ══════════════════════════════════════════════════════ viewer cluster
{
  const page = await boot()
  const posts = await rigPosts(page)

  // ---- #55 authored-camera switch changes the view
  const c55 = check(55, '[viewer] authored-camera switch (C / dots) changes the view')
  if (c55) {
    const dId = posts.byFlavour.d
    await openViewer(page, dId, 9000)
    const dots = await page.evaluate(() => document.getElementById('cam-dots')?.children.length ?? 0)
    note(`flavour d opened, camera dots = ${dots}`)
    const a = await grab(page)
    await page.keyboard.press('c')
    await sleep(2500)
    const b = await grab(page)
    const d = diffFrac(a, b)
    note(`pixel change after C = ${(d * 100).toFixed(1)}%`)
    const activeDot = await page.evaluate(() => {
      const dots = [...(document.getElementById('cam-dots')?.children ?? [])]
      return dots.map((x) => x.className).join('|')
    })
    note(`dot classes: ${activeDot}`)
    verdict(dots >= 2 && d > 0.05, `C switches the rendered view (${(d * 100).toFixed(1)}% of pixels change)`)
  }

  // ---- #72 animation rail hidden for static models + #82 sound button
  const c72 = check(72, '[viewer] animation rail hidden for models with no animations')
  if (c72) {
    await openViewer(page, posts.byFlavour.e, 9000)
    const rail = await page.evaluate(() => {
      const r = document.getElementById('anim-rail')
      return { hidden: r?.hidden ?? null, display: r ? getComputedStyle(r).display : null, tracks: window.__form0.viewer.animator?.trackCount?.() ?? null }
    })
    note(`flavour e (camera, static): ${JSON.stringify(rail)}`)
    verdict(rail.hidden === true || rail.display === 'none', 'anim rail hidden for a static model')
  }

  const c82 = check(82, '[audio] SOUND control reflects the model\'s real audio')
  if (c82) {
    const state = await page.evaluate(() => {
      const v = window.__form0.viewer
      const btn = document.getElementById('btn-sound')
      return { soundCount: v.soundCount, hidden: btn?.hidden ?? null, metaHasAudio: v.meta?.hasAudio ?? null }
    })
    note(`flavour e (no audio in the GLB): ${JSON.stringify(state)}`)
    const okSilent = state.soundCount === 0 && state.hidden === true
    // now the audio-bearing flavour
    await openViewer(page, posts.byFlavour.a, 9000)
    const s2 = await page.evaluate(() => {
      const v = window.__form0.viewer
      const btn = document.getElementById('btn-sound')
      return { soundCount: v.soundCount, hidden: btn?.hidden ?? null, metaHasAudio: v.meta?.hasAudio ?? null }
    })
    note(`flavour a (embeds a 440 Hz beep): ${JSON.stringify(s2)}`)
    let plays = null
    if (s2.soundCount > 0) {
      await page.click('#btn-sound')
      await sleep(1800)
      plays = await page.evaluate(() => {
        const v = window.__form0.viewer
        return { soundOn: v.soundOn, classOn: document.getElementById('btn-sound')?.classList.contains('on') ?? null }
      })
      note(`after clicking SOUND: ${JSON.stringify(plays)}`)
    }
    // The button must be hidden for a silent model and, when shown, actually play.
    verdict(okSilent && (s2.soundCount === 0 || (plays && plays.soundOn === true)),
      `silent model hides the control (${JSON.stringify(state)}), audio model plays (${JSON.stringify(plays)})`)
  }

  // ---- #79 loading indicator + rail hidden until the model draws
  const c79 = check(79, '[viewer] no playing HUD over an empty canvas')
  if (c79) {
    await page.evaluate(() => { location.hash = '#/board' })
    await sleep(1200)
    await page.evaluate((id) => { location.hash = '#/viewer/' + id }, posts.byFlavour.b)
    await sleep(350)
    const early = await page.evaluate(() => {
      const rail = document.getElementById('anim-rail')
      const loading = document.getElementById('loading')
      return {
        railVisible: rail ? (!rail.hidden && getComputedStyle(rail).display !== 'none') : false,
        loadingVisible: loading ? getComputedStyle(loading).display !== 'none' && !loading.hidden : false,
        frame: document.getElementById('anim-frame')?.textContent ?? null,
      }
    })
    note(`350 ms into the open: ${JSON.stringify(early)}`)
    await sleep(9000)
    const late = await page.evaluate(() => {
      const rail = document.getElementById('anim-rail')
      return { railVisible: rail ? (!rail.hidden && getComputedStyle(rail).display !== 'none') : false }
    })
    note(`settled: ${JSON.stringify(late)}`)
    verdict(!early.railVisible || early.loadingVisible, 'the rail waits for the model (or the loading ring covers the gap)')
  }

  // ---- #60 Escape with the metadata drawer open closes the drawer only
  const c60 = check(60, '[viewer] Escape closes the metadata drawer first')
  if (c60) {
    await openViewer(page, posts.byFlavour.a, 8000)
    await page.keyboard.press('m')
    await sleep(900)
    const openState = await page.evaluate(() => ({
      drawer: getComputedStyle(document.getElementById('meta-drawer')).display,
      mode: window.__form0.__mode(),
    }))
    await page.keyboard.press('Escape')
    await sleep(900)
    const after = await page.evaluate(() => ({
      drawer: getComputedStyle(document.getElementById('meta-drawer')).display,
      mode: window.__form0.__mode(),
    }))
    note(`M -> ${JSON.stringify(openState)}; Escape -> ${JSON.stringify(after)}`)
    verdict(openState.mode === 'viewer' && after.mode === 'viewer' && after.drawer !== openState.drawer && after.drawer === 'none',
      'first Escape closes the drawer and stays in the viewer')
  }

  // ---- #75 viewer backdrop seam
  const c75 = check(75, '[viewer] backdrop has no hard horizontal seam')
  if (c75) {
    // Compositor-accurate: two screenshots (floor glow on / off) with the
    // model hidden and the framebuffer PINNED (adaptive resolution changes
    // the render size between frames and that alone fakes row-level steps).
    // The difference isolates the glow plane's contribution; a seam shows up
    // as one or two rows darkened far more than their neighbours.
    const seam = await measureSeam(page)
    note(`glow contributes from row ${seam.firstRow} (${seam.firstPct}%) to ${seam.lastRow} (${seam.lastPct}%)`)
    note(`worst single-row step ${seam.worstStep} at y=${seam.worstY} (${seam.worstPct}%); peak darkening ${seam.peakDelta} at y=${seam.peakY}`)
    note(`backdrop-only profile is ${seam.backdropSmooth ? 'smooth' : 'NOT smooth'} (worst step ${seam.backdropWorst})`)
    verdict(seam.worstStep < 3 && seam.backdropSmooth,
      `no hard seam: worst 1-row step ${seam.worstStep} (peak glow Δ${seam.peakDelta} spread over ${seam.rampRows} rows)`)
  }

  // ---- #77 portrait auto-fit (phone viewport)
  await page.close()
}

// ══════════════════════════════════════════════════════ mobile cluster
{
  const c76 = check(76, '[mobile] viewer bar buttons reachable at 390px')
  const c77 = check(77, '[mobile] auto-fit respects portrait aspect')
  if (c76 || c77) {
    const page = await boot({ viewport: { width: 390, height: 780 }, isMobile: true, deviceScaleFactor: 2 })
    const posts = await rigPosts(page)
    await openViewer(page, posts.byFlavour.b, 10000)
    if (c76) {
      const bar = await page.evaluate(() => {
        const b = document.getElementById('viewer-bar')
        const rail = b?.querySelector('.rail:not(.anim-rail)')
        const btns = [...(rail?.querySelectorAll('button') ?? [])].filter((x) => x.offsetWidth || x.offsetHeight)
        return {
          vw: window.innerWidth,
          railRect: rail ? { l: +rail.getBoundingClientRect().left.toFixed(0), r: +rail.getBoundingClientRect().right.toFixed(0), w: +rail.getBoundingClientRect().width.toFixed(0) } : null,
          scrollable: rail ? rail.scrollWidth > rail.clientWidth + 1 : null,
          buttons: btns.map((x) => ({ id: x.id, l: +x.getBoundingClientRect().left.toFixed(0), r: +x.getBoundingClientRect().right.toFixed(0), vis: x.getBoundingClientRect().right <= window.innerWidth + 1 && x.getBoundingClientRect().left >= -1 })),
        }
      })
      note(`viewport ${bar.vw}px rail ${JSON.stringify(bar.railRect)} scrollable=${bar.scrollable}`)
      note(`buttons: ${bar.buttons.map((b) => `${b.id}[${b.l}-${b.r}]${b.vis ? '' : 'OFF'}`).join(' ')}`)
      const off = bar.buttons.filter((b) => !b.vis)
      verdict(off.length === 0, off.length ? `${off.length} button(s) off-screen: ${off.map((b) => b.id).join(', ')}` : 'every viewer-bar button is on-screen')
    }
    if (c77) {
      const fit = await page.evaluate(() => {
        const f0 = window.__form0
        const engine = f0.engine.engine
        const scene = f0.engine.activeScene ?? f0.viewer.scene
        scene.render()
        const gl = engine._gl
        const W = engine.getRenderWidth(), H = engine.getRenderHeight()
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        const buf = new Uint8Array(W * H * 4)
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
        // the rig's flavour-b model is two saturated cubes on a grey backdrop:
        // bbox of "not backdrop" pixels tells us whether the model is cropped
        let minX = W, maxX = -1, minY = H, maxY = -1, n = 0
        for (let y = 0; y < H; y += 2) {
          for (let x = 0; x < W; x += 2) {
            const i = (y * W + x) * 4
            const r = buf[i], g = buf[i + 1], b = buf[i + 2]
            if (Math.max(r, g, b) - Math.min(r, g, b) > 40) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
          }
        }
        return { W, H, n, box: n ? { minX, maxX, minY, maxY } : null }
      })
      const cropped = fit.box ? (fit.box.minX <= 1 || fit.box.maxX >= fit.W - 2 || fit.box.minY <= 1 || fit.box.maxY >= fit.H - 2) : true
      note(`model pixels=${fit.n} box=${JSON.stringify(fit.box)} canvas=${fit.W}x${fit.H}`)
      verdict(!!fit.box && fit.n > 500 && !cropped, cropped ? 'model touches/exceeds the viewport edge (cropped)' : `model fits with margin (box ${JSON.stringify(fit.box)})`)
    }
    await page.close()
  }
}

// ══════════════════════════════════════════════════════ thread cluster
{
  const page = await boot()
  const posts = await rigPosts(page)
  const rootWithReplies = await page.evaluate(() => {
    const idx = window.__form0.index
    for (const [parentId, kids] of idx.children.entries()) {
      if (kids.size > 0 && idx.roots.has(parentId)) return parentId
    }
    for (const [parentId, kids] of idx.children.entries()) if (kids.size > 0) return parentId
    return null
  })
  console.log(`\n   (thread root with replies: ${String(rootWithReplies).slice(0, 8)})`)

  // ---- #63 thread zoom direction
  const c63 = check(63, '[thread] +/− zoom the expected way')
  if (c63) {
    await page.evaluate((id) => { location.hash = '#/thread/' + id }, rootWithReplies)
    await sleep(9000)
    const z0 = await page.evaluate(() => window.__form0.threadView['zoom'] ?? window.__form0.threadView.zoom?.())
    await page.click('#btn-tzoom-in')
    await sleep(700)
    const z1 = await page.evaluate(() => window.__form0.threadView['zoom'] ?? window.__form0.threadView.zoom?.())
    await page.click('#btn-tzoom-out')
    await sleep(700)
    const z2 = await page.evaluate(() => window.__form0.threadView['zoom'] ?? window.__form0.threadView.zoom?.())
    note(`zoom (ortho half-height): ${z0} -> in -> ${z1} -> out -> ${z2}`)
    verdict(z1 < z0 && z2 > z1, `+ shrinks the half-height (${z0}→${z1}), − grows it (→${z2})`)
  }

  // ---- #74 node poster clipping
  const c74 = check(74, '[thread] node posters stay inside their frames')
  if (c74) {
    const geo = await page.evaluate(() => {
      const tv = window.__form0.threadView
      const nodes = [...(tv['nodes'] ?? new Map()).values()]
      const size = (m) => {
        const bi = m.getBoundingInfo()
        return { w: +(bi.boundingBox.extendSize.x * 2).toFixed(3), h: +(bi.boundingBox.extendSize.y * 2).toFixed(3) }
      }
      return nodes.slice(0, 10).map((n) => ({
        id: String(n.meta?.eventId ?? '?').slice(0, 8),
        declared: { w: +n.w.toFixed(3), h: +n.h.toFixed(3) },
        quad: n.mesh ? size(n.mesh) : null,
        frame: n.frame ? size(n.frame) : null,
        dim: n.meta ? `${n.meta.width}x${n.meta.height}` : null,
        clip: !!(n.mesh && (n.mesh.clipPlane1 || n.mesh.material?.clipPlane1)),
      }))
    })
    for (const g of geo) {
      const over = g.quad && g.frame && (g.quad.w > g.frame.w * 1.02 || g.quad.h > g.frame.h * 1.02)
      note(`${g.id} dim=${g.dim} quad=${g.quad?.w}x${g.quad?.h} frame=${g.frame?.w}x${g.frame?.h} clip=${g.clip}${over ? '  OVERFLOW' : ''}`)
    }
    const bad = geo.filter((g) => g.quad && g.frame && (g.quad.w > g.frame.w * 1.02 || g.quad.h > g.frame.h * 1.02))
    verdict(geo.length > 0 && bad.length === 0, bad.length ? `${bad.length} poster quad(s) exceed their frame` : `${geo.length} node poster(s) all inside their frames`)
  }

  // ---- #58 unknown thread id
  const c58 = check(58, '[thread] unknown thread id shows a not-found notice')
  if (c58) {
    await page.evaluate(() => { location.hash = '#/thread/' + 'e'.repeat(64) })
    await sleep(13000)
    const notice = await page.evaluate(() => {
      const tv = window.__form0.threadView
      const mesh = tv['noticeMesh'] ?? null
      return { notice: mesh ? mesh.isEnabled() && mesh.isVisible : false, nodeCount: (tv['nodes'] ?? []).length }
    })
    note(JSON.stringify(notice))
    verdict(notice.notice === true, 'unknown thread shows the notice card')
  }
  await page.close()
}

// ══════════════════════════════════════════════════ routing + overlays
{
  const page = await boot()
  const posts = await rigPosts(page)

  // ---- #56 deep link survives a reload
  const c56 = check(56, '[routing] #/viewer/<id> survives a reload')
  if (c56) {
    await openViewer(page, posts.byFlavour.a, 8000)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__form0?.board, null, { timeout: 25000 }).catch(() => {})
    await sleep(14000)
    const st = await page.evaluate(() => ({ hash: location.hash.slice(0, 24), mode: window.__form0.__mode() }))
    note(JSON.stringify(st))
    verdict(st.mode === 'viewer', `after reload: mode=${st.mode} hash=${st.hash}`)
  }

  // ---- #57 unknown post id
  const c57 = check(57, '[routing] unknown post id shows an error sheet')
  if (c57) {
    await page.evaluate(() => { location.hash = '#/viewer/' + 'f'.repeat(64) })
    await sleep(14000)
    const sheet = await page.evaluate(() => {
      const el = document.getElementById('error-sheet')
      return { shown: el ? getComputedStyle(el).display !== 'none' && !el.hidden : false, code: document.getElementById('error-code')?.textContent ?? null, cause: (document.getElementById('error-cause')?.textContent ?? '').slice(0, 60) }
    })
    note(JSON.stringify(sheet))
    verdict(sheet.shown, `sheet=${sheet.code} ${sheet.cause}`)
    await page.evaluate(() => document.getElementById('btn-error-close')?.click())
    await sleep(600)
  }

  // ---- #59 settings Escape
  const c59 = check(59, '[settings] panel closes on Escape')
  if (c59) {
    await page.evaluate(() => { location.hash = '#/board' })
    await sleep(800)
    await page.click('#btn-settings')
    await sleep(900)
    const before = await page.evaluate(() => getComputedStyle(document.getElementById('settings-panel')).display)
    await page.keyboard.press('Escape')
    await sleep(900)
    const after = await page.evaluate(() => getComputedStyle(document.getElementById('settings-panel')).display)
    note(`display ${before} -> ${after}`)
    verdict(before !== 'none' && after === 'none', 'Escape closes the settings panel')
  }

  // ---- #64 preset dropdown applies
  const c64 = check(64, '[settings] Preset dropdown applies the preset')
  if (c64) {
    await page.click('#btn-settings')
    await sleep(900)
    const before = await page.evaluate(() => {
      const msaa = document.getElementById('set-msaa')
      if (msaa) { msaa.value = '4'; msaa.dispatchEvent(new Event('change', { bubbles: true })) }
      return { msaa: msaa?.value ?? null, store: window.__form0.settings.num('msaa') }
    })
    await sleep(400)
    const after = await page.evaluate(() => {
      const sel = document.getElementById('set-preset') || document.querySelector('[id$="preset"]')
      if (!sel) return { error: 'no preset control found' }
      sel.value = 'low'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return { id: sel.id, value: sel.value }
    })
    await sleep(900)
    const settled = await page.evaluate(() => {
      const s = window.__form0.settings
      return { msaaStore: s.num('msaa'), preset: s.str('preset'), msaaCtl: document.getElementById('set-msaa')?.value ?? null }
    })
    note(`preset ${JSON.stringify(after)}; msaa ${before.store} -> ${settled.msaaStore} (control ${settled.msaaCtl}, preset=${settled.preset})`)
    verdict(settled.msaaStore !== null && Number(settled.msaaStore) < 4, `choosing Low drove msaa to ${settled.msaaStore}`)
    await page.keyboard.press('Escape')
    await sleep(500)
  }

  // ---- #65 handoff fast-path
  const c65 = check(65, '[perf] viewer handoff fast-path works (no fallback log)')
  if (c65) {
    const errs = page.__consoleErrors || []
    const handoff = errs.filter((t) => /handoff failed|UniversalCamera needs to be imported/i.test(t))
    note(`console messages matching the handoff failure: ${handoff.length}`)
    if (handoff.length) note(handoff[0])
    await openViewer(page, posts.byFlavour.c, 7000)
    const errs2 = (page.__consoleErrors || []).filter((t) => /handoff failed|UniversalCamera needs to be imported/i.test(t))
    verdict(errs2.length === 0, `${errs2.length} handoff-failure console message(s) after two viewer opens`)
  }

  // ---- #80 / #81 a11y
  const c80 = check(80, '[a11y] toasts are announced')
  if (c80) {
    const t = await page.evaluate(() => {
      const el = document.getElementById('toast')
      return { role: el?.getAttribute('role'), live: el?.getAttribute('aria-live') }
    })
    note(JSON.stringify(t))
    verdict(!!t.live && !!t.role, `#toast role=${t.role} aria-live=${t.live}`)
  }
  const c81 = check(81, '[a11y] #a11y-bridge is populated')
  if (c81) {
    const b = await page.evaluate(() => {
      const el = document.getElementById('a11y-bridge')
      return { len: (el?.textContent || '').trim().length, sample: (el?.textContent || '').trim().slice(0, 90) }
    })
    note(JSON.stringify(b))
    verdict(b.len > 10, `bridge has ${b.len} chars: "${b.sample}"`)
  }

  // ---- #73 legend glyph
  const c73 = check(73, '[legend] no U+23F8 tofu in the legend')
  if (c73) {
    const g = await page.evaluate(() => {
      const el = document.getElementById('legend')
      const text = el?.textContent || ''
      return { has23F8: text.includes('\u23F8'), svgCount: el?.querySelectorAll('svg').length ?? 0 }
    })
    note(JSON.stringify(g))
    verdict(!g.has23F8, g.has23F8 ? 'U+23F8 still in the legend copy' : `legend uses ${g.svgCount} inline SVG glyphs, no U+23F8`)
  }
  await page.close()
}

// ══════════════════════════════════════════════════════ studio cluster
{
  const page = await boot()
  const posts = await rigPosts(page)

  // ---- #61 Escape with the export review open
  const c61 = check(61, '[studio] Escape closes the export review, keeps the studio')
  if (c61) {
    await page.evaluate(() => { location.hash = '#/studio' })
    await sleep(2500)
    // import the rig's animated GLB through the real file chooser path
    const imported = await page.evaluate(async () => {
      const url = 'https://localhost:8443/models/a.glb'
      const res = await fetch(url)
      const buf = new Uint8Array(await res.arrayBuffer())
      const file = new File([buf], 'a.glb', { type: 'model/gltf-binary' })
      const dt = new DataTransfer()
      dt.items.add(file)
      const input = document.getElementById('file-input')
      input.files = dt.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return buf.length
    })
    note(`imported ${imported} bytes into the studio`)
    await sleep(6000)
    await page.evaluate(() => document.getElementById('btn-studio-publish')?.click())
    await sleep(6000)
    const openState = await page.evaluate(() => ({
      review: getComputedStyle(document.getElementById('export-review')).display,
      mode: window.__form0.__mode(),
    }))
    note(`publish -> ${JSON.stringify(openState)}`)
    await page.keyboard.press('Escape')
    await sleep(1500)
    const after = await page.evaluate(() => ({
      review: getComputedStyle(document.getElementById('export-review')).display,
      mode: window.__form0.__mode(),
    }))
    note(`Escape -> ${JSON.stringify(after)}`)
    verdict(openState.review !== 'none' && after.review === 'none' && after.mode === 'studio',
      'the review closes and the studio survives')
  }

  // ---- #67 text triangle budget
  const c67 = check(67, '[studio/text] triangle budget is not stuck at 0')
  if (c67) {
    await page.evaluate(() => document.getElementById('btn-export-close')?.click())
    await sleep(1200)
    const budget = await page.evaluate(async () => {
      const tab = [...document.querySelectorAll('#studio .tab, #studio [data-tab]')].find((b) => /text/i.test(b.textContent || ''))
      tab?.click()
      const input = document.getElementById('studio-text')
      if (input) { input.value = 'HELLO'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })) }
      return { tabFound: !!tab, typed: !!input }
    })
    note(JSON.stringify(budget))
    await sleep(7000)
    const readout = await page.evaluate(() => ({
      text: document.getElementById('text-budget')?.textContent ?? null,
      stats: window.__form0.studio.textStats ?? null,
    }))
    note(JSON.stringify(readout))
    const tris = Number((readout.text || '').match(/([\d.]+)\s*tris/i)?.[1] ?? NaN)
    verdict(Number.isFinite(tris) && tris > 0, `readout "${readout.text}" -> ${tris} tris`)
  }
  await page.close()
}

// ══════════════════════════════════════════════════════ summary
console.log('\n════════════════════ RECHECK SUMMARY ════════════════════')
let fails = 0
for (const r of results) {
  if (r.ok === undefined) { console.log(`  #${String(r.id).padEnd(3)} SKIP  ${r.title}`); continue }
  if (!r.ok) fails++
  console.log(`  #${String(r.id).padEnd(3)} ${r.ok ? 'PASS' : 'FAIL'}  ${r.title}\n        ${r.detail}`)
}
console.log(`\n${results.filter((r) => r.ok).length} pass · ${fails} fail · ${results.filter((r) => r.ok === undefined).length} skipped`)
await browser.close()
process.exit(fails ? 1 : 0)
