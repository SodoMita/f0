// End-to-end verification against the OFFLINE rig (scripts/offline-rig.mjs):
// the five reported bugs get deterministic checks that fail loudly, plus the
// core feed invariants. Real relays/CDNs are unreachable in sandboxes — the
// rig replays the same content over localhost (see offline-rig.mjs header).
//
//   node scripts/offline-rig.mjs            # terminal 1
//   bun run dev                              # terminal 2
//   node scripts/offline-verify.mjs         # terminal 3
import { chromium } from 'playwright'

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

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForFunction(() => window.__form0?.board, null, { timeout: 30000 })
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})

// feed ready: relay delivered everything and posters started landing
await page.waitForFunction(() => {
  const f = window.__form0
  return f.index.byId.size >= 52 && f.board.rows.length >= 48
}, null, { timeout: 30000 })

// Raise the live-preview budget through the app's own settings pipeline
// (12 slots): the rig's default preset caps it at 3, which would leave
// legitimate overflow cards poster-only and break the bottom-row waits.
await page.evaluate(() => window.__form0.settings.set({ livePreviews: 12 }))

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
  await page.screenshot({ path: 'shots/verify-posters.png' })
}

// ------------------------------------------------- 1b. board crossfade
{
  // One wheel step moves the rows at the prefetch edge into range, so a
  // freshly driven card exists to observe. (Cards beyond `near` are
  // intentionally NOT driven until the user scrolls.)
  await page.mouse.move(640, 400)
  await page.mouse.wheel(0, 420)
  await page.waitForTimeout(1200)
  const fade = await page.evaluate(async () => {
    const b = window.__form0.board
    const near = b.halfH + 10 * 1.6 * Math.max(0.1, b.prefetchScreens)
    const card = b.cards.find((c) => c.meta && c.mesh.isEnabled() && !c.poster && !c.live
      && Math.abs(b.worldY(c.row)) < near - 2)
    if (!card) return { observed: [], skipped: 'no pending card in range' }
    // The fade ramps opacity by wall-clock over 120ms; a hard swap would
    // finish within a single frame. Measure how long the ramp takes from
    // the moment the poster texture is bound.
    let t0 = 0
    const start = performance.now()
    while (performance.now() - start < 90000) {
      if (card.poster && !t0 && card.opacity < 0.9) t0 = performance.now()
      if (card.opacity >= 0.999) break
      await new Promise((r) => setTimeout(r, 8))
    }
    const rampMs = t0 ? performance.now() - t0 : 0
    const final = card.opacity
    return { rampMs: +rampMs.toFixed(0), final: +final.toFixed(2), poster: !!card.poster }
  })
  check('board card crossfades over >=90ms (no instant swap)', fade.rampMs >= 90, JSON.stringify(fade))
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
  // bottom rows: poster ready + preview request resolved
  await page.waitForFunction((id) => {
    const f = window.__form0
    const a = f.assets
    const pool = f.board.previewPool
    return !!a.peekPoster(f.index.byId.get(id)) && (pool.byPost.has(id) || pool.rejected.has(id))
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
      const n = [...tv.nodes.values()].find((x) => x.opacity < 0.99)
      if (!n) return { observed: [], skipped: 'no fresh node' }
      let t0 = 0
      const start = performance.now()
      while (performance.now() - start < 30000) {
        if (n.poster && !t0 && n.opacity < 0.9) t0 = performance.now()
        if (n.opacity >= 0.999) break
        await new Promise((r) => setTimeout(r, 8))
      }
      return { rampMs: +(t0 ? performance.now() - t0 : 0).toFixed(0), final: +n.opacity.toFixed(2), poster: !!n.poster }
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
  await page.screenshot({ path: 'shots/verify-studio.png' })

  // back to board
  await page.evaluate(() => { location.hash = '#/' })
  await page.waitForTimeout(600)
}

// ------------------------------------------------------ 6. viewer path
{
  // scroll back to the top and tap the first VISIBLE card whose model is
  // flavour `a` (one authored camera)
  await page.evaluate(() => window.__form0.board.setScroll(0))
  await page.waitForTimeout(900)
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

// ----------------------------------------------------------- summary
check('no CDN requests', bad.length === 0, bad.join(','))
console.log('--- page errors ---')
for (const e of errors.slice(0, 12)) console.log('  ' + e)
check('no page errors', errors.length === 0)
await browser.close()
console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL CHECKS PASSED')
process.exit(fails.length ? 1 : 0)
