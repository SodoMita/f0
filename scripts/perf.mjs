// Performance harness. Measures boot timings, steady-state frame cost per
// view, GPU/CPU work per frame and memory — with optional CPU throttling so
// the numbers mean something for phones.
//
//   node scripts/perf.mjs                 # dev server, 1x CPU
//   CPU=4 node scripts/perf.mjs           # 4x CPU slowdown
//   TARGET_URL=file:///…standalone.html node scripts/perf.mjs
import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'node:fs'

const URL = process.env.TARGET_URL || 'http://localhost:5173/'
const CPU = Number(process.env.CPU || 1)
const SETTLE = Number(process.env.SETTLE_MS || 26000)
const SAMPLE = Number(process.env.SAMPLE_MS || 5000)
const OUT = process.env.PERF_OUT || 'shots/perf.json'
mkdirSync('shots', { recursive: true })

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const cdp = await page.context().newCDPSession(page)
if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU })

const t0 = Date.now()
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForFunction(() => window.__form0?.board, null, { timeout: 30000 }).catch(() => {})
const tBoot = Date.now() - t0
// first-run legend is modal by design (and its full-screen backdrop-filter
// dominates every measurement); dismiss it like a user would
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
await page.waitForFunction(() => window.__form0?.board?.rows?.length > 0, null, { timeout: 30000 }).catch(() => {})
const tFirstCard = Date.now() - t0
// "posters ready" = the poster pipeline has gone quiet, not a fixed count:
// on a live feed some downloads legitimately fail and would never arrive.
await page.waitForFunction(() => {
  const f = window.__form0
  const busy = f.assets.queue.length > 0 || f.assets.active > 0
  return f.assets.posterTex.size > 0 && !busy
}, null, { timeout: 60000 }).catch(() => {})
const tAllPosters = Date.now() - t0

/** Sample real frame pacing from inside the page (rAF deltas). */
async function sampleFrames(ms) {
  return page.evaluate(async (dur) => {
    const eng = window.__form0.engine.engine
    const start = performance.now()
    const deltas = []
    let last = performance.now()
    await new Promise((done) => {
      const tick = () => {
        const now = performance.now()
        deltas.push(now - last)
        last = now
        if (now - start < dur) requestAnimationFrame(tick)
        else done()
      }
      requestAnimationFrame(tick)
    })
    deltas.sort((a, b) => a - b)
    const p = (q) => +deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * q))].toFixed(2)
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length
    const scene = window.__form0.engine.activeScene
    return {
      frames: deltas.length,
      fps: +(1000 / mean).toFixed(1),
      frameMs: { p50: p(0.5), p95: p(0.95), max: p(0.999) },
      drawCalls: eng._drawCalls?.current ?? -1,
      activeMeshes: scene.getActiveMeshes?.().length ?? -1,
      totalMeshes: scene.meshes.length,
      totalMaterials: scene.materials.length,
      totalTextures: scene.textures.length,
    }
  }, ms)
}

const heap = () => page.evaluate(() => (performance.memory
  ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : -1))

await page.waitForTimeout(SETTLE)
const board = await sampleFrames(SAMPLE)
const boardHeap = await heap()

// scrolling board (worst case: layout + texture churn)
const scrolling = await page.evaluate(async (dur) => {
  const b = window.__form0.board
  const start = performance.now()
  const deltas = []
  let last = performance.now()
  await new Promise((done) => {
    const tick = () => {
      const now = performance.now()
      deltas.push(now - last)
      last = now
      b.setScroll((b.scrollY + 0.35) % Math.max(0.1, b.maxScroll || 1))
      if (now - start < dur) requestAnimationFrame(tick)
      else done()
    }
    requestAnimationFrame(tick)
  })
  const mean = deltas.reduce((a, x) => a + x, 0) / deltas.length
  deltas.sort((a, x) => a - x)
  return { fps: +(1000 / mean).toFixed(1), p95: +deltas[Math.floor(deltas.length * 0.95)].toFixed(2) }
}, 3000)

// ---- stress: a full board (48 cards) built by cloning the live metas ----
// Relays only serve a handful of posts, which hides layout/scroll cost.
await page.evaluate(() => {
  const f = window.__form0
  f.pool.onEvent = () => {}   // freeze the feed so it can't overwrite the stress list
  const roots = [...f.index.byId.values()].filter((m) => m.role === 'root' && !m.tombstoned)
  if (!roots.length) return
  const big = []
  for (let i = 0; big.length < 48; i++) {
    const src = roots[i % roots.length]
    big.push({ ...src, eventId: src.eventId.slice(0, 56) + String(i).padStart(8, '0') })
  }
  f.board.setMetas(big)
})
await page.waitForTimeout(6000)
// let the poster queue drain first so the scroll number measures rendering,
// not a GLB parse that happened to land in the sample
await page.waitForFunction(() => {
  const a = window.__form0.assets
  return a.queue.length === 0 && a.active === 0
}, null, { timeout: 40000 }).catch(() => {})
const stressStatic = await sampleFrames(2500)
const stressScroll = await page.evaluate(async (dur) => {
  const b = window.__form0.board
  const start = performance.now()
  const deltas = []
  let last = performance.now()
  await new Promise((done) => {
    const tick = () => {
      const now = performance.now()
      deltas.push(now - last)
      last = now
      b.setScroll((b.scrollY + b.maxScroll / 90) % Math.max(0.1, b.maxScroll || 1))
      if (now - start < dur) requestAnimationFrame(tick)
      else done()
    }
    requestAnimationFrame(tick)
  })
  const mean = deltas.reduce((a, x) => a + x, 0) / deltas.length
  deltas.sort((a, x) => a - x)
  return {
    fps: +(1000 / mean).toFixed(1),
    p95: +deltas[Math.floor(deltas.length * 0.95)].toFixed(2),
    maxScroll: +b.maxScroll.toFixed(1),
    rows: b.rows.length,
    boundSlots: b.cards.filter((c) => c.meta).length,
    postersRequested: b.cards.filter((c) => c.requested).length,
    postersReady: window.__form0.assets.posterTex.size,
  }
}, 4000)
// same fling with ALL content work disabled: isolates raster cost from
// download/parse/render work so the number is comparable run to run
const stressScrollPure = await page.evaluate(async (dur) => {
  const f = window.__form0
  const b = f.board
  f.assets.setPaused(true)
  b.previewPool.releaseAll()
  const start = performance.now()
  const deltas = []
  let last = performance.now()
  await new Promise((done) => {
    const tick = () => {
      const now = performance.now()
      deltas.push(now - last)
      last = now
      b.setScroll((b.scrollY + b.maxScroll / 90) % Math.max(0.1, b.maxScroll || 1))
      if (now - start < dur) requestAnimationFrame(tick)
      else done()
    }
    requestAnimationFrame(tick)
  })
  f.assets.setPaused(false)
  const mean = deltas.reduce((a, x) => a + x, 0) / deltas.length
  deltas.sort((a, x) => a - x)
  return { fps: +(1000 / mean).toFixed(1), p95: +deltas[Math.floor(deltas.length * 0.95)].toFixed(2) }
}, 3000)
const stressHeap = await heap()
const stressSpinners = await page.evaluate(() => window.__form0.board.cards.filter((c) => c.spinner.isEnabled()).length)

// viewer — restore the real (indexed) metas; the stress clones are not in
// the index, so clicking one is a no-op by design. Sort a post that actually
// has a poster to the top so the click lands on loadable content.
await page.evaluate(() => {
  const f = window.__form0
  f.board.setScroll(0)
  const roots = [...f.index.byId.values()].filter((m) => m.role === 'root' && !m.tombstoned)
  roots.sort((a, b) => Number(f.assets.posterTex.has(b.eventId)) - Number(f.assets.posterTex.has(a.eventId)))
  f.board.setMetas(roots)
})
await page.waitForTimeout(2500)
const pos = await page.evaluate(() => window.__form0.board.screenPosOf(0))
let viewer = null
let viewerOpenMs = -1
if (pos) {
  const tv = Date.now()
  await page.mouse.click(pos.x, pos.y)
  await page.waitForFunction(() => window.__form0.viewer.stats().meshes > 0, null, { timeout: 40000 }).catch(() => {})
  viewerOpenMs = Date.now() - tv
  await page.waitForTimeout(1500)
  viewer = await sampleFrames(SAMPLE)
}

// thread
await page.evaluate(() => { location.hash = '#/' })
await page.waitForTimeout(800)
const rootId = await page.evaluate(() => {
  const f = window.__form0
  const roots = [...f.index.byId.values()].filter((m) => m.role === 'root' && !m.tombstoned)
  return roots.find((m) => f.index.childCount(m.eventId) > 0)?.eventId ?? null
})
let thread = null
if (rootId) {
  await page.evaluate((id) => { location.hash = '#/thread/' + id }, rootId)
  await page.waitForTimeout(2500)
  thread = await sampleFrames(SAMPLE)
}

// idle board with NO live previews (nothing moving at all — should cost ~0)
await page.evaluate(() => { location.hash = '#/' })
await page.waitForTimeout(3000)
const idleWithLive = await page.evaluate(async (dur) => {
  const scene = window.__form0.board.scene
  let renders = 0
  const obs = scene.onAfterRenderObservable.add(() => renders++)
  const t = performance.now()
  await new Promise((r) => setTimeout(r, dur))
  scene.onAfterRenderObservable.remove(obs)
  return { rendersPerSec: +(renders / ((performance.now() - t) / 1000)).toFixed(1) }
}, 3000)
await page.evaluate(() => {
  // stop live previews AND stop them being re-requested, so this really is
  // a static board
  const pool = window.__form0.board.previewPool
  pool.request = () => false
  pool.releaseAll()
})
await page.waitForTimeout(600)
const idle = await page.evaluate(async (dur) => {
  const eng = window.__form0.engine.engine
  let renders = 0
  const scene = window.__form0.board.scene
  const obs = scene.onAfterRenderObservable.add(() => renders++)
  const t = performance.now()
  await new Promise((r) => setTimeout(r, dur))
  scene.onAfterRenderObservable.remove(obs)
  return { rendersPerSec: +(renders / ((performance.now() - t) / 1000)).toFixed(1), fpsMeter: +eng.getFps().toFixed(1) }
}, 3000)

const result = {
  url: URL,
  cpuThrottle: CPU,
  boot: { engineReadyMs: tBoot, firstCardMs: tFirstCard, allPostersMs: tAllPosters, viewerOpenMs },
  board, scrolling, stress: { static: stressStatic, scrolling: stressScroll, scrollingPureRender: stressScrollPure, heapMB: stressHeap, spinnersLeft: stressSpinners }, viewer, thread, idleBoardWithLivePreview: idleWithLive, idleBoard: idle,
  heapMB: { board: boardHeap, end: await heap() },
  counts: await page.evaluate(() => ({
    events: window.__form0.index.byId.size,
    posters: window.__form0.assets.posterTex.size,
    modelBlobsInMemory: window.__form0.assets.modelBlobs.size,
    modelBytesInMemory: [...window.__form0.assets.modelBlobs.values()].reduce((a, b) => a + b.size, 0),
    liveSlots: window.__form0.board.previewPool.activeCount,
    ...window.__form0.engine.perfStats(),   // renders / lastMs / emaMs / ratio
  })),
}
console.log(JSON.stringify(result, null, 1))
writeFileSync(OUT, JSON.stringify(result, null, 1))
await browser.close()
