// End-to-end verification against the OFFLINE rig (scripts/offline-rig.mjs):
// the five reported bugs get deterministic checks that fail loudly, plus the
// core feed invariants. Real relays/CDNs are unreachable in sandboxes — the
// rig replays the same content over localhost (see offline-rig.mjs header).
//
//   node scripts/offline-rig.mjs            # terminal 1
//   bun run dev                              # terminal 2
//   node scripts/offline-verify.mjs         # terminal 3
import { chromium } from 'playwright'
import { request } from 'node:https'

const URL = process.env.TARGET_URL || 'http://localhost:4173/'
const MODEL = 'https://localhost:8443/models/'

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
const bad = []
page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)))
page.on('console', (m) => {
  // headless has no audio device; the mixer's device error is expected
  if (m.type() !== 'error' || /AudioContext|audio device/i.test(m.text())) return
  // The app boots with the DEFAULT public relays for a few frames before the
  // rig hook switches them to the local one; the sandbox blocks those relays
  // and Chrome logs the failed connection. Expected here, not an app error.
  if (/WebSocket connection to 'wss:\/\/(?!localhost)/.test(m.text())) return
  errors.push('[console] ' + m.text().slice(0, 160))
})
page.on('request', (r) => { if (/cdn\.babylonjs\.com|unpkg|jsdelivr/.test(r.url())) bad.push(r.url()) })

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

/** POST /__reset on the rig relay (Node-side; the page cannot pre-reset). */
function resetRig() {
  return new Promise((resolve, reject) => {
    const req = request({
      host: 'localhost', port: 8443, path: '/__reset', method: 'POST',
      rejectUnauthorized: false, timeout: 5000,
    }, (res) => { res.resume(); res.on('end', () => resolve()) })
    req.on('error', (e) => reject(new Error('rig reset failed: ' + e.message)))
    req.on('timeout', () => { req.destroy(); reject(new Error('rig reset timeout')) })
    req.end()
  })
}

// The rig relay is long-running: reset it to the seed feed BEFORE the page
// loads, so earlier publish-suite runs cannot pollute this one.
await resetRig()

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForFunction(() => window.__form0?.board, null, { timeout: 30000 })
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})

// feed ready: relay delivered everything and posters started landing
await page.waitForFunction(() => {
  const f = window.__form0
  return f.index.byId.size >= 52 && f.board.rows.length >= 48
}, null, { timeout: 30000 })

// Raise the live-preview budget through the app's own settings pipeline
// (4 slots — small enough that the feed scroll MUST recycle slots, which is
// exactly what the slot-reuse check asserts; 12 made >slots impossible).
await page.evaluate(() => window.__form0.settings.set({ livePreviews: 4 }))

// watch every live-slot acquisition from the very first one (the feed can
// fill its slots before any of our later waits)
await page.evaluate(() => {
  const pool = window.__form0.board.previewPool
  const seen = window.__liveSeen = []
  const orig = pool.onLive
  pool.onLive = (id, rtt) => { seen.push(id); orig?.(id, rtt) }
})

// ------------------------------------------------------------- helpers
const posterStats = (bytesArray) => page.evaluate(async (blobBytes) => {
  const bmp = await createImageBitmap(new Blob([new Uint8Array(blobBytes)]))
  const c = document.createElement('canvas')
  c.width = bmp.width; c.height = bmp.height
  const ctx = c.getContext('2d')
  ctx.drawImage(bmp, 0, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let red = 0, green = 0, opaque = 0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 16) continue
    opaque++
    if (d[i] > 140 && d[i + 1] < 120 && d[i + 2] < 120) red++
    if (d[i] < 120 && d[i + 1] > 140 && d[i + 2] < 150) green++
  }
  return { red: red / opaque, green: green / opaque, opaque }
}, bytesArray)

const fetchModel = (name) => page.evaluate(async (u) => {
  const r = await fetch(u)
  return [...new Uint8Array(await r.arrayBuffer())]
}, MODEL + name)

// -------------------------------------------- 1. poster camera policy
{
  // a = camera framing ONLY the red cube (green cube is far off-axis)
  const a = await posterStats(await page.evaluate(async (bytes) => {
    const res = await window.__form0.assets.renderPosterFor(new Blob([new Uint8Array(bytes)], { type: 'model/gltf-binary' }))
    return [...new Uint8Array(await res.blob.arrayBuffer())]
  }, await fetchModel('a.glb')))
  check('poster from authored camera: red visible', a.red > 0.05, `red=${(a.red * 100).toFixed(1)}%`)
  check('poster from authored camera: green out of frame', a.green < 0.01, `green=${(a.green * 100).toFixed(2)}%`)

  // b = static, NO camera -> auto-fit must show both cubes
  const b = await posterStats(await page.evaluate(async (bytes) => {
    const res = await window.__form0.assets.renderPosterFor(new Blob([new Uint8Array(bytes)], { type: 'model/gltf-binary' }))
    return [...new Uint8Array(await res.blob.arrayBuffer())]
  }, await fetchModel('b.glb')))
  check('poster without camera auto-fits both cubes', b.red > 0.03 && b.green > 0.03,
    `red=${(b.red * 100).toFixed(1)}% green=${(b.green * 100).toFixed(1)}%`)

  // d = cam0 red view, cam1 green view, event advertises preview-camera=1:
  // poster (first camera) must be red; the LIVE preview must use cam1 (green)
  const d = await posterStats(await page.evaluate(async (bytes) => {
    const res = await window.__form0.assets.renderPosterFor(new Blob([new Uint8Array(bytes)], { type: 'model/gltf-binary' }))
    return [...new Uint8Array(await res.blob.arrayBuffer())]
  }, await fetchModel('d.glb')))
  check('two-camera model: poster uses cam0 (red)', d.red > 0.05 && d.green < 0.01,
    `red=${(d.red * 100).toFixed(1)}% green=${(d.green * 100).toFixed(2)}%`)

  // f = authored camera that frames NOTHING: the poster must fall back to
  // auto-fit (both cubes visible) instead of going blank -> placeholder.
  const f = await posterStats(await page.evaluate(async (bytes) => {
    const res = await window.__form0.assets.renderPosterFor(new Blob([new Uint8Array(bytes)], { type: 'model/gltf-binary' }))
    return [...new Uint8Array(await res.blob.arrayBuffer())]
  }, await fetchModel('f.glb')))
  check('blank authored camera falls back to auto-fit (not placeholder)',
    !Number.isNaN(f.red) && f.opaque > 1000 && f.red > 0.03 && f.green > 0.03,
    `red=${(f.red * 100).toFixed(1)}% green=${(f.green * 100).toFixed(1)}%`)

  // d advertises preview-camera=1 -> the LIVE preview must use cam1 (green),
  // NOT camera 0. Sample the live slot's render target pixels directly.
  // The THREAD pool hosts this check: the board recycles slots for its
  // visible cards (the d-card is below the fold), which made the read race
  // the slot's next occupant on the faster production build.
  await page.evaluate(async () => {
    const pool = window.__form0.threadView.previewPool
    const f = window.__form0
    const meta = [...f.index.byId.values()].find((m) => m.role === 'root' && m.filename === 'd.glb')
    if (!meta) return
    pool.retry(meta.eventId)
    // request WITH the fresh visible set: request() without it falls back to
    // the slot's stale visible flag and cannot evict -> never loads
    pool.request(meta.eventId, new Set([meta.eventId]))
    await new Promise((resolve) => {
      const t0 = performance.now()
      const poll = () => {
        const slot = pool.byPost.get(meta.eventId)
        if (slot || performance.now() - t0 > 60000) resolve()
        else setTimeout(poll, 100)
      }
      poll()
    })
    const slot = pool.byPost.get(meta.eventId)
    if (!slot) return
    // warm-up frames (the pool RTT readback races shader compilation on
    // SwiftShader — retry until content appears, like the poster warm-up)
    for (let attempt = 0; attempt < 10; attempt++) {
      pool.tick(new Set([meta.eventId]))
      await new Promise((r) => setTimeout(r, 120))
    }
    const RW = 384, RH = 240
    // sync readback: bind the RTT texture to a dummy framebuffer and read.
    // Retry until pixels appear — the GPU flush races the read on this
    // software rasterizer.
    const engine = window.__form0.engine.engine
    const gl = engine._gl
    const internal = slot.rtt.getInternalTexture()
    const resource = internal?._hardwareTexture?.underlyingResource
    const bytes = new Uint8Array(RW * RH * 4)
    if (!gl || !resource) return
    if (!engine._dummyFramebuffer) engine._dummyFramebuffer = gl.createFramebuffer()
    const prev = engine._currentFramebuffer ?? null
    let gotContent = false
    for (let attempt = 0; attempt < 8 && !gotContent; attempt++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, engine._dummyFramebuffer)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, resource, 0)
      // flush the render commands through the engine's async path first —
      // a bare sync readPixels raced the GPU on SwiftShader and read zeros
      try { await engine._readPixelsAsync(0, 0, RW, RH, gl.RGBA, gl.UNSIGNED_BYTE, bytes) } catch { /* ignore */ }
      gl.bindFramebuffer(gl.FRAMEBUFFER, engine._dummyFramebuffer)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, resource, 0)
      gl.readPixels(0, 0, RW, RH, gl.RGBA, gl.UNSIGNED_BYTE, bytes)
      for (let i = 0; i < bytes.length && !gotContent; i += 4) if (bytes[i + 3] > 0) gotContent = true
      if (!gotContent) await new Promise((r) => setTimeout(r, 100))
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, prev)
    let red = 0, green = 0, opaque = 0
    for (let i = 0; i < bytes.length; i += 4) {
      if (bytes[i + 3] < 16) continue
      opaque++
      if (bytes[i] > 140 && bytes[i + 1] < 120 && bytes[i + 2] < 120) red++
      if (bytes[i] < 120 && bytes[i + 1] > 140 && bytes[i + 2] < 150) green++
    }
    window.__livePx = { red: red / opaque, green: green / opaque, opaque }
  })
  await page.waitForFunction(() => window.__livePx, null, { timeout: 90000 }).catch(() => {})
  const livePx = await page.evaluate(() => window.__livePx ?? { red: 0, green: 0, opaque: 0 })
  check('preview-camera=1 applied: live preview is GREEN (cam1), not red',
    livePx.green > 0.05 && livePx.red < 0.02,
    `red=${(livePx.red * 100).toFixed(1)}% green=${(livePx.green * 100).toFixed(1)}%`)
  await page.screenshot({ path: 'shots/verify-posters.png' })
}

// ------------------------------------------------- 1b. board crossfade
{
  // Deterministic crossfade: force a settled card back to the PLATE state,
  // then re-drive it — drive() re-delivers the cached poster through the
  // real crossfade path (plate->poster) and the pool request then swaps in
  // the live RTT (poster->live). No reliance on scroll timing.
  await page.evaluate(() => {
    const b = window.__form0.board
    const f = window.__form0
    const animatable = (c) => {
      if (!c.meta) return false
      const known = f.assets.isAnimated(c.meta)
      return c.meta.animHint || known === true
    }
    let card = b.cards.find((c) => c.meta && c.mesh.isEnabled() && c.poster && animatable(c))
    if (!card) card = b.cards.find((c) => c.meta && c.mesh.isEnabled() && c.poster)
    window.__fadeTrace = { card, trace: [], done: false, blends: [], snaps: [], skip: card ? '' : 'no poster card available' }
    if (!card) return
    // back to the plate, then re-drive (the cached poster re-delivers)
    b.setOpacityNow(card, 0.14)
    card.poster = null
    card.live = null
    card.requested = false
    b.drive(card)
    const t0 = performance.now()
    const iv = setInterval(() => {
      const c = window.__fadeTrace.card
      const b2 = window.__form0.board
      window.__fadeTrace.trace.push([+(performance.now() - t0).toFixed(0), +c.opacity.toFixed(3), +c.blend.toFixed(3)])
      if (c.blend > 0.01 && c.blend < 0.99) window.__fadeTrace.blends.push(+c.blend.toFixed(2))
      // once the poster crossfade finished, force the live transition
      if (c.poster && c.opacity >= 0.999 && !c.live && performance.now() - t0 > 1200) {
        if (!b2.previewPool.isRejected(c.meta.eventId)) {
          b2.previewPool.request(c.meta.eventId, new Set([c.meta.eventId]))
        }
      }
      const now = performance.now() - t0
      if (window.__fadeTrace.snaps.length < 60 && now >= window.__fadeTrace.snaps.length * 2000) {
        window.__fadeTrace.snaps.push({
          t: +(now / 1000).toFixed(0), name: c.meta?.filename,
          requested: c.requested, poster: !!c.poster, live: !!c.live, op: +c.opacity.toFixed(2),
          queue: window.__form0.assets.queue.length, active: window.__form0.assets.active,
          rejected: c.meta ? b2.previewPool.isRejected(c.meta.eventId) : false,
        })
      }
      if (c.live && c.blend === 0 && c.opacity >= 0.999 && performance.now() - t0 > 3000) {
        window.__fadeTrace.done = true
        clearInterval(iv)
      }
      if (performance.now() - t0 > 60000) { window.__fadeTrace.done = true; clearInterval(iv) }
    }, 4)
  })
  await page.waitForFunction(() => {
    const t = window.__fadeTrace
    return !t || t.skip || t.done
  }, null, { timeout: 90000 }).catch(() => {})
  const fade = await page.evaluate(() => {
    const t = window.__fadeTrace
    if (!t || t.skip) return { rampMs: 0, final: 0, poster: false, live: false, blendMid: false, blends: [], skipped: t?.skip }
    const trace = t.trace
    // opacity ramp = from the first sample below 0.99 to the first >= 0.999
    let start = -1, end = -1
    for (const [ms, op] of trace) {
      if (start < 0 && op < 0.99) start = ms
      if (start >= 0 && op >= 0.999) { end = ms; break }
    }
    return {
      rampMs: start >= 0 && end >= 0 ? end - start : 0,
      final: t.card.opacity, poster: !!t.card.poster, live: !!t.card.live,
      blendMid: t.blends.length > 0, blends: [...new Set(t.blends)].slice(0, 8),
      maxBlend: Math.max(0, ...t.trace.map((x) => x[2])),
      snaps: t.snaps.slice(0, 8),
    }
  })
  check('board card crossfades over >=60ms (no instant swap)', fade.rampMs >= 60, JSON.stringify(fade))
  check('poster -> live is a real two-texture crossfade (blend ramps)', fade.blendMid,
    JSON.stringify(fade.blends))
}

// --------------------------------------- 2. feed animation + slot reuse
{
  // wait until the top of the feed has settled (posters + previews in)
  await page.waitForFunction(() => window.__form0.board.previewPool.activeCount > 0, null, { timeout: 60000 })
  await page.waitForTimeout(2500)

  // scroll through the whole feed in bursts, then wait until the BOTTOM rows
  // have their posters and their preview request resolved (live or rejected)
  // before asserting feed-wide slot behaviour
  const scrollTo = async (y) => {
    let at = await page.evaluate(() => window.__form0.board.scrollY)
    const dir = Math.sign(y - at)
    while (Math.sign(y - at) === dir && dir !== 0) {
      await page.mouse.move(640, 400)
      await page.mouse.wheel(0, dir * 420)
      await page.waitForTimeout(200)
      at = await page.evaluate(() => window.__form0.board.scrollY)
    }
  }
  const bottomRowId = await page.evaluate(() => {
    const b = window.__form0.board
    return b.rows[b.rows.length - 1].meta.eventId
  })
  await page.waitForFunction((id) => {
    const a = window.__form0.assets
    return a.queue.length === 0 && a.active === 0
  }, null, { timeout: 120000 }).catch(() => {})
  await scrollTo(await page.evaluate(() => window.__form0.board.maxScroll))
  // bottom row: the poster pipeline must reach the END of the feed. (Live
  // slots are a small viewport-gated budget — the bottom card may be
  // poster-only by design; slot reuse is asserted above.)
  await page.waitForFunction((id) => {
    const f = window.__form0
    const a = f.assets
    return !!a.peekPoster(f.index.byId.get(id)) && a.queue.length === 0 && a.active === 0
  }, bottomRowId, { timeout: 240000 })
  await page.waitForTimeout(2500)
  await page.screenshot({ path: 'shots/verify-feed-bottom.png' })

  const live = await page.evaluate(() => {
    const pool = window.__form0.board.previewPool
    return {
      seen: [...new Set(window.__liveSeen)],
      slots: pool.slots.length,
      maxSlots: pool.opts.maxSlots,
      active: pool.activeCount,
    }
  })
  check('feed animates more distinct posts than slots (slot reuse)', live.seen.length > live.maxSlots,
    `distinct live=${live.seen.length} maxSlots=${live.maxSlots}`)
  check('slot array never grows past the budget', live.slots <= live.maxSlots, `slots=${live.slots}/${live.maxSlots}`)
  check('live cards never exceed the budget', live.active <= live.maxSlots, `active=${live.active}/${live.maxSlots}`)

  // static model (b) must never get a live slot; camera-without-animation (e)
  // carries the cameras hint, so the pool must preflight it and STATIC-reject
  const byName = await page.evaluate(() => {
    const f = window.__form0
    const out = {}
    for (const m of f.index.byId.values()) {
      if (m.role === 'root') out[m.filename ?? ''] = m.eventId
    }
    return out
  })
  const eIds = await page.evaluate(() => {
    const f = window.__form0
    return [...f.index.byId.values()].filter((m) => m.role === 'root' && m.filename === 'e.glb').map((m) => m.eventId)
  })
  // Wait for the BOTTOM-MOST e-card's poster. (Top rows' poster textures
  // are legitimately evicted by the 32-texture RAM budget while we scroll;
  // the bottom e-card is on screen and stays resident.)
  await page.waitForFunction((id) => {
    const f = window.__form0
    return !!f.assets.peekPoster(f.index.byId.get(id))
  }, eIds[eIds.length - 1], { timeout: 240000 })
  const live2 = await page.evaluate(() => {
    const pool = window.__form0.board.previewPool
    return {
      seen: [...new Set(window.__liveSeen)],
      byPost: [...pool.byPost.keys()],
      rejected: [...pool.rejected.entries()].map(([id, why]) => [id, why]),
    }
  })
  const neverLive = (id) => id && !live2.seen.includes(id) && !live2.byPost.includes(id)
  check('static model never animates', neverLive(byName['b.glb'] ?? ''), byName['b.glb']?.slice(0, 8))
  check('camera-only static model never animates', eIds.every(neverLive), `${eIds.length}/${eIds.length} e-cards poster-only`)
  await page.screenshot({ path: 'shots/verify-feed.png' })
}

// -------------------------------------------- 3. thread tree animation
{
  const rootId = await page.evaluate(() => {
    const f = window.__form0
    const roots = [...f.index.byId.values()].filter((m) => m.role === 'root' && !m.tombstoned)
    return roots.find((m) => f.index.childCount(m.eventId) > 0)?.eventId
  })
  check('found a root with replies', !!rootId)
  if (rootId) {
    await page.evaluate((id) => { location.hash = '#/thread/' + id }, rootId)
    await page.waitForFunction(() => window.__form0.engine.activeScene === window.__form0.threadView.scene, null, { timeout: 10000 })
    await page.waitForFunction(() => window.__form0.threadView.nodes.size >= 5, null, { timeout: 20000 })
    // crossfade: a freshly bound node must ramp its opacity (no hard swap).
    // Watch from the moment a poster lands (fadeStart>0) through to opacity 1.
    const fade = await page.evaluate(async () => {
      const tv = window.__form0.threadView
      const n = [...tv.nodes.values()].find((x) => x.poster) ?? [...tv.nodes.values()][0]
      if (!n) return { observed: [], skipped: 'no node' }
      // deterministic: run a real crossfadeTo() and time it via fadeStart
      const V = n.mat.constructor
      tv.crossfadeTo(n, tv.replyTex, '#FFFFFF', 'raw')
      const start = performance.now()
      while (n.fadeStart && performance.now() - start < 5000) {
        await new Promise((r) => setTimeout(r, 10))
      }
      const rampMs = performance.now() - start
      return { rampMs: +rampMs.toFixed(0), final: +n.opacity.toFixed(2), poster: !!n.poster }
    })
    check('thread node crossfades over >=90ms (no instant swap)', fade.rampMs >= 90, JSON.stringify(fade))

    // nodes get posters first, then animated ones go live
    await page.waitForFunction(() => window.__form0.threadView.previewPool.activeCount > 0, null, { timeout: 90000 })
    const t = await page.evaluate(() => {
      const tv = window.__form0.threadView
      const liveNodes = [...tv.nodes.values()].filter((n) => n.live).length
      return {
        nodes: tv.nodes.size,
        edges: tv.lineMeshes.length,
        live: tv.previewPool.activeCount,
        slots: tv.previewPool.slots.length,
        liveNodes,
      }
    })
    check('thread map animates nodes (live previews)', t.live > 0 && t.liveNodes > 0,
      `live=${t.live} nodesWithLive=${t.liveNodes}`)
    check('thread pool respects its budget', t.slots <= 3, `slots=${t.slots}`)
    await page.screenshot({ path: 'shots/verify-thread.png' })
    await page.evaluate(() => { location.hash = '#/' })
    await page.waitForTimeout(600)
  }
}

// ---------------------------------------------- 5. studio camera + gizmos
{
  await page.evaluate(() => { location.hash = '#/studio' })
  await page.waitForFunction(() => window.__form0.engine.activeScene === window.__form0.studio.scene, null, { timeout: 10000 })
  await page.waitForTimeout(600)

  // elementFromPoint above the W/E/R toolbar must hit the CANVAS, not the
  // stage overlay (that overlay used to swallow every pointer event)
  const hit = await page.evaluate(() => {
    const el = document.elementFromPoint(504, 300)
    return { id: el?.id ?? '', tag: el?.tagName ?? '' }
  })
  check('stage does not intercept pointers (canvas hit above toolbar)',
    hit.id === 'engine' || hit.tag === 'CANVAS', JSON.stringify(hit))

  // import model `e` (camera, NOT animated -> deterministic positions).
  // NOTE: Babylon's glTF loader converts right-handed glTF to left-handed
  // via a root rotation/scale, so authored +X becomes WORLD -X: the green
  // cube authored at x=+5 sits at world x=-5. All expectations below are
  // in Babylon world space.
  const camBefore = await page.evaluate(() => window.__form0.studio.getCameraState())
  await page.evaluate(() => document.querySelector('#btn-studio-import').click())
  await page.waitForTimeout(300)
  const eBytes = await page.evaluate(async () => {
    const r = await fetch('https://localhost:8443/models/e.glb')
    return [...new Uint8Array(await r.arrayBuffer())]
  })
  await page.setInputFiles('#file-input', { name: 'e.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(eBytes) })
  await page.waitForFunction(() => window.__form0.studio.currentModel !== null, null, { timeout: 30000 })
  await page.waitForTimeout(400)
  const camAfter = await page.evaluate(() => window.__form0.studio.getCameraState())
  const sameCam = JSON.stringify(camBefore.target) === JSON.stringify(camAfter.target)
    && Math.abs(camBefore.radius - camAfter.radius) < 1e-6
    && JSON.stringify(camBefore.rotationDeg) === JSON.stringify(camAfter.rotationDeg)
  check('import keeps the composed camera (no auto-look)', sameCam,
    `before=${camBefore.radius.toFixed(2)} after=${camAfter.radius.toFixed(2)}`)

  // import auto-selects the first mesh (red cube). Fit the SELECTION so the
  // red cube sits at screen centre and the big green cube is out of frame.
  const rBefore = await page.evaluate(() => window.__form0.studio.getCameraState().radius)
  await page.evaluate(() => document.querySelector('[data-cam="fit-sel"]').click())
  await page.waitForTimeout(300)
  const fit = await page.evaluate(() => window.__form0.studio.getCameraState())
  check('fit-selected zooms to the selection', fit.radius < rBefore && fit.radius > 0.2,
    `radius ${rBefore.toFixed(2)} -> ${fit.radius.toFixed(2)}`)

  // click empty space in the stage -> deselect (proves taps reach the scene)
  // the card-preview HUD occupies the stage's top-left corner (format v4):
  // click it away first — the empty-stage tap below lands on the canvas as
  // it did before, and the hide/reveal pair gets covered as a side effect.
  await page.evaluate(() => document.getElementById('studio-preview-canvas')?.click())
  await page.waitForTimeout(120)
  await page.mouse.click(150, 250)
  await page.waitForTimeout(300)
  const desel = await page.evaluate(() => window.__form0.studio.selected === null)
  check('tap on empty stage deselects (scene receives taps)', desel)

  // whole-model view buttons (nothing selected):
  //   red world (0,0,0) + green world (-5,0,0)
  await page.evaluate(() => document.querySelector('[data-cam="origin"]').click())
  await page.waitForTimeout(300)
  const o = await page.evaluate(() => window.__form0.studio.getCameraState().target)
  check('look-at average origin (whole model)', Math.abs(o[0] + 2.5) < 0.05 && Math.abs(o[1]) < 0.05 && Math.abs(o[2]) < 0.05,
    JSON.stringify(o.map((n) => +n.toFixed(2))))

  await page.evaluate(() => document.querySelector('[data-cam="center"]').click())
  await page.waitForTimeout(300)
  const c = await page.evaluate(() => window.__form0.studio.getCameraState().target)
  // union bbox: red [-0.5,0.5], green (scale 4 at x=-5) [-7,-3] -> center -3.25
  check('look-at bounding-box center (whole model)', Math.abs(c[0] + 3.25) < 0.05 && Math.abs(c[1]) < 0.05,
    JSON.stringify(c.map((n) => +n.toFixed(2))))

  // click the model -> select (pointer events reach picking through the stage)
  await page.mouse.click(640, 400)
  await page.waitForTimeout(300)
  const sel = await page.evaluate(() => window.__form0.studio.selected?.name ?? null)
  check('click on model selects it through the stage', sel !== null && sel !== '__root__', String(sel))

  // deselect (tap empty stage) so the fly look-ats use the whole-model
  // fallback and the expected targets match the earlier orbit checks
  await page.mouse.click(150, 250)
  await page.waitForTimeout(300)
  const desel2 = await page.evaluate(() => window.__form0.studio.selected === null)
  check('fly-cam precondition: nothing selected', desel2)

  // fly camera: the view buttons must drive the ACTIVE camera (they used to
  // write only the orbit camera — dead in fly mode). setTarget on a
  // TargetCamera ROTATES the camera; assert the look direction.
  const flyDir = () => page.evaluate(() => {
    const s = window.__form0.studio
    const cam = s.scene.activeCamera
    const pos = cam.position.asArray()
    // Camera.getDirection needs a local axis vector; construct one from the
    // camera's own position class (no module import available in-page).
    const V3 = cam.position.constructor
    const f = cam.getDirection(new V3(0, 0, 1))
    return { proj: s.getCameraState().projection, pos, fwd: [f.x, f.y, f.z] }
  })
  const dotOk = (fwd, pos, at) => {
    let dx = at[0] - pos[0], dy = at[1] - pos[1], dz = at[2] - pos[2]
    const l = Math.hypot(dx, dy, dz) || 1
    dx /= l; dy /= l; dz /= l
    return Math.abs(fwd[0] * dx + fwd[1] * dy + fwd[2] * dz - 1) < 0.02
  }
  await page.evaluate(() => window.__form0.studio.setCameraState({ projection: 'free' }))
  await page.waitForTimeout(300)
  await page.evaluate(() => document.querySelector('[data-cam="origin"]').click())
  await page.waitForTimeout(300)
  const flyOrigin = await flyDir()
  check('fly cam: look-at origin drives the active camera',
    flyOrigin.proj === 'free' && dotOk(flyOrigin.fwd, flyOrigin.pos, [-2.5, 0, 0]),
    JSON.stringify(flyOrigin.fwd.map((n) => +n.toFixed(3))))
  await page.evaluate(() => document.querySelector('[data-cam="center"]').click())
  await page.waitForTimeout(300)
  const flyCenter = await flyDir()
  check('fly cam: look-at bbox center drives the active camera',
    dotOk(flyCenter.fwd, flyCenter.pos, [-3.25, 0, 0]),
    JSON.stringify(flyCenter.fwd.map((n) => +n.toFixed(3))))
  const flyDistBefore = await page.evaluate(() => {
    const s = window.__form0.studio
    const cam = s.scene.activeCamera
    const pos = cam.position.asArray()
    return Math.hypot(pos[0] + 3.25, pos[1], pos[2])
  })
  await page.evaluate(() => document.querySelector('[data-cam="fit-sel"]').click())
  await page.waitForTimeout(300)
  const flyFit = await flyDir()
  const flyDistAfter = Math.hypot(flyFit.pos[0] + 3.25, flyFit.pos[1], flyFit.pos[2])
  check('fly cam: fit-selected repositions the active camera',
    dotOk(flyFit.fwd, flyFit.pos, [-3.25, 0, 0]) && Math.abs(flyDistAfter - flyDistBefore) > 0.3,
    `dist ${flyDistBefore.toFixed(2)} -> ${flyDistAfter.toFixed(2)}`)
  await page.evaluate(() => window.__form0.studio.setCameraState({ projection: 'perspective' }))
  await page.waitForTimeout(200)
  await page.screenshot({ path: 'shots/verify-studio.png' })

  // restore the card preview for the remaining checks
  await page.evaluate(() => document.getElementById('btn-preview-reveal')?.click())

  // back to board
  await page.evaluate(() => { location.hash = '#/' })
  await page.waitForTimeout(600)
}

// ------------------------------------------------------ 6. viewer path
{
  // scroll back to the top and tap the first VISIBLE card whose model is
  // flavour `a` (one authored camera)
  await page.evaluate(() => window.__form0.board.setScroll(0))
  // wait out any residual scroll inertia so the rows really sit at the top
  await page.waitForFunction(() => {
    const b = window.__form0.board
    return Math.abs(b.velocity) < 0.01 && !b.pendingSettle && Math.abs(b.scrollY) < 0.01
  }, null, { timeout: 15000 })
  await page.waitForTimeout(400)
  const target = await page.evaluate(() => {
    const b = window.__form0.board
    const row = b.rows.findIndex((r) => r.meta.filename === 'a.glb' && Math.abs(b.screenPosOf(b.rows.indexOf(r))?.y ?? 1e9) < 400)
    if (row < 0) return null
    const idx = b.rows.findIndex((r) => r.meta.filename === 'a.glb')
    return b.screenPosOf(idx)
  })
  if (target) {
    await page.mouse.move(target.x, target.y)
    await page.mouse.down(); await page.waitForTimeout(80); await page.mouse.up()
    await page.waitForFunction(() => location.hash.startsWith('#/viewer/'), null, { timeout: 10000 })
    await page.waitForFunction(() => window.__form0.viewer.cameraCount > 0, null, { timeout: 30000 })
    const v = await page.evaluate(() => ({
      cameras: window.__form0.viewer.cameraCount,
      camIndex: window.__form0.viewer.camIndex,
      meshes: window.__form0.viewer.sceneModelMeshCount(),
      dots: document.querySelectorAll('.cam-dot').length,
    }))
    check('card tap opens viewer with authored camera', v.cameras === 1 && v.camIndex === 0 && v.dots === 2,
      JSON.stringify(v))
    check('viewer shows the model', v.meshes >= 2, `meshes=${v.meshes}`)
    await page.screenshot({ path: 'shots/verify-viewer.png' })
  } else {
    check('card tap opens viewer with authored camera', false, 'no visible a-card')
  }
}

// ------------------------------------------------- 7. studio regressions
{
  // open studio: must land on the UPLOAD tab with a visible import button
  // (it used to open on TYPE, hiding the import flow behind a tab switch)
  await page.evaluate(() => { location.hash = '#/studio' })
  await page.waitForFunction(() => window.__form0.engine.activeScene === window.__form0.studio.scene, null, { timeout: 10000 })
  await page.waitForTimeout(400)
  const tabs = await page.evaluate(() => {
    const active = document.querySelector('.rail-btn.active')?.dataset.tab
    const importBtn = document.getElementById('btn-studio-import')
    const rect = importBtn?.getBoundingClientRect()
    return {
      active,
      importVisible: !!rect && rect.width > 0 && rect.height > 0,
      paintDisabled: document.querySelector('[data-tab="paint"]')?.disabled === true,
      paintPresent: !!document.querySelector('[data-tab="paint"]'),
      symbolsDisabled: document.querySelector('[data-tab="symbols"]')?.disabled === true,
      camCollapsed: document.querySelector('.cam-advanced')?.open === false,
    }
  })
  check('studio opens on the upload tab with a visible import button',
    tabs.active === 'upload' && tabs.importVisible, JSON.stringify(tabs))
  check('paint tab is enabled (hand-writing editor)',
    tabs.paintPresent && !tabs.paintDisabled)
  check('symbols tab stays disabled (later milestone)', tabs.symbolsDisabled)
  check('camera details collapse by default (publish stays reachable)', tabs.camCollapsed)

  // close affordance: the rail X leaves the studio
  await page.evaluate(() => document.querySelector('#btn-studio-close').click())
  await page.waitForFunction(() => window.__form0.engine.activeScene === window.__form0.board.scene, null, { timeout: 10000 })
  check('studio has a working close button', true)
  await page.evaluate(() => { location.hash = '#/studio' })
  await page.waitForFunction(() => window.__form0.engine.activeScene === window.__form0.studio.scene, null, { timeout: 10000 })
  await page.waitForTimeout(300)

  // phone viewport: the publish button and transform tools must stay on
  // screen (the inspector was up to 38vh tall and pushed publish off-screen)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(600)
  const phone = await page.evaluate(() => {
    const pub = document.getElementById('btn-studio-publish')?.getBoundingClientRect()
    const tools = document.querySelector('.studio-tools')?.getBoundingClientRect()
    const vh = window.innerHeight
    const inside = (r) => r && r.top >= 0 && r.bottom <= vh && r.width > 0
    return { publishInside: inside(pub), toolsInside: inside(tools), pubBottom: pub?.bottom ?? -1 }
  })
  check('portrait phone: publish + transform tools stay on screen',
    phone.publishInside && phone.toolsInside, JSON.stringify(phone))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.waitForTimeout(400)
  await page.evaluate(() => { location.hash = '#/' })
  await page.waitForTimeout(400)
}

// ------------------------------------------------- 8. paint editor
{
  await page.evaluate(() => { location.hash = '#/studio' })
  await page.waitForFunction(() => window.__form0.engine.activeScene === window.__form0.studio.scene, null, { timeout: 10000 })
  await page.evaluate(() => document.querySelector('[data-tab="paint"]').click())
  await page.waitForTimeout(200)
  const painted = await page.evaluate(() => {
    const s = window.__form0.studio
    const n = s.paint.drawStroke([
      { x: -0.6, y: 0.2, z: 0, pressure: 0.85, t: 0 },
      { x: -0.2, y: 0.35, z: 0, pressure: 0.7, t: 16 },
      { x: 0.2, y: 0.1, z: 0, pressure: 0.65, t: 32 },
      { x: 0.6, y: -0.15, z: 0, pressure: 0.5, t: 48 },
    ])
    return { n, count: s.paint.count, has: s.hasContent(), tool: s.paint.opts.tool }
  })
  check('paint stroke stamps along a path', painted.n >= 3 && painted.count === painted.n,
    JSON.stringify(painted))
  check('paint stroke is publishable content', painted.has)

  const undone = await page.evaluate(() => {
    const s = window.__form0.studio
    s.paint.undo()
    return { count: s.paint.count, has: s.hasContent(), canRedo: s.paint.history.canRedo }
  })
  check('paint undo removes the stroke (inverse command)', undone.count === 0 && !undone.has && undone.canRedo)

  const pub = await page.evaluate(async () => {
    const s = window.__form0.studio
    s.paint.redo()
    const c = await s.getContentForPublish()
    return { name: c.filename, size: c.blob.size, format: c.sourceFormat, stamps: s.paint.count }
  })
  check('paint export is a generated GLB', pub.format === 'generated' && pub.size > 200 && pub.stamps > 0,
    JSON.stringify(pub))
  await page.screenshot({ path: 'shots/verify-paint.png' })
  await page.evaluate(() => { location.hash = '#/' })
  await page.waitForTimeout(300)
}

// ------------------------------------------------------------- legend
{
  // seen-flag: a reload must NOT show the legend again; '?' reopens it.
  // Seed the seen-flag through the app's own legend (works on the dev AND
  // the production build — a /src/ import only exists on the dev server).
  // open()+close() always writes the flag, even if it was already hidden.
  await page.evaluate(() => { window.__form0.legend.open(); window.__form0.legend.close() })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__form0?.board, null, { timeout: 30000 })
  await page.waitForTimeout(1500)
  const afterReload = await page.evaluate(() => document.getElementById('legend').hidden)
  check('legend does not reappear after reload (seen-flag)', afterReload)
  await page.keyboard.press('?')
  await page.waitForTimeout(300)
  const reopened = await page.evaluate(() => !document.getElementById('legend').hidden)
  check("'?' reopens the legend", reopened)
  await page.evaluate(() => window.__form0?.legend?.close())
}

// ----------------------------------------------------------- summary
check('no CDN requests', bad.length === 0, bad.join(','))
console.log('--- page errors ---')
for (const e of errors.slice(0, 12)) console.log('  ' + e)
check('no page errors', errors.length === 0)
await browser.close()
console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL CHECKS PASSED')
process.exit(fails.length ? 1 : 0)
