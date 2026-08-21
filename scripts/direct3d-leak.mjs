// 3D-mode resource discipline — the toggle must be free to flip:
//   node scripts/direct3d-leak.mjs      (needs the offline rig + dev server)
//
// Direct-3D loads real GLBs into the LIVE board scene: meshes, materials,
// textures, animation groups, MSFT_audio_emitter sounds and a transform
// chain per model. Everything has to come back out again when the toggle
// goes off or a card scrolls away — a browser-only imageboard is a
// long-running tab, and AMENDMENT 79 already found one leak here
// (`dispose(true)` = do NOT recurse left the orient/fit nodes behind).
//
// Four on/off cycles must return the scene to its exact baseline.
import { launchFormBrowser } from './browser.mjs'

const URL = process.env.TARGET_URL || 'http://localhost:4173/'
const CYCLES = Number(process.env.CYCLES || 4)

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

const browser = await launchFormBrowser()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)))
const cdp = await page.context().newCDPSession(page)

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForFunction(() => window.__form0?.board, { timeout: 30000 })
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
await page.waitForFunction(() => window.__form0.index.byId.size > 10, { timeout: 30000 })
await page.evaluate(() => window.__form0.settings.set({ autoplayAnimations: false }))
await page.waitForTimeout(4000)

/** Scene census after a forced GC. */
async function snap() {
  await cdp.send('HeapProfiler.collectGarbage').catch(() => {})
  await page.waitForTimeout(600)
  return page.evaluate(() => {
    const b = window.__form0.board
    const sc = b.scene
    return {
      meshes: sc.meshes.length,
      materials: sc.materials.length,
      textures: sc.textures.length,
      transformNodes: sc.transformNodes.length,
      d3Nodes: sc.transformNodes.filter((n) => n.name.startsWith('d3-')).length,
      anims: sc.animationGroups.length,
      sounds: sc.mainSoundTrack?.soundCollection.length ?? 0,
      live: b.pool3d.slots.filter((s) => s.postId).length,
      heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1,
    }
  })
}

const base = await snap()
console.log('      baseline', JSON.stringify(base))
check('board starts in 2D with no direct models', base.d3Nodes === 0 && base.live === 0)

let peakLive = 0
let last = base
for (let i = 1; i <= CYCLES; i++) {
  await page.evaluate(() => window.__form0.settings.set({ direct3D: true }))
  await page.waitForFunction(() => {
    const b = window.__form0.board
    return b.cards.filter((c) => c.meta && b.pool3d.isLive(c.meta.eventId)).length >= 4
  }, { timeout: 60000 }).catch(() => {})
  await page.waitForTimeout(2500)
  const on = await snap()
  peakLive = Math.max(peakLive, on.live)
  check(`cycle ${i}: models are actually resident`, on.live >= 4 && on.d3Nodes >= on.live * 3,
    `live=${on.live} nodes=${on.d3Nodes}`)
  check(`cycle ${i}: one transform chain per model (root+orient+fit)`,
    on.d3Nodes === on.live * 3, `${on.d3Nodes} nodes for ${on.live} models`)

  await page.evaluate(() => window.__form0.settings.set({ direct3D: false }))
  await page.waitForTimeout(3000)
  const off = await snap()
  check(`cycle ${i}: every model is gone again`, off.d3Nodes === 0 && off.live === 0,
    `nodes=${off.d3Nodes} live=${off.live}`)
  check(`cycle ${i}: scene back to baseline (meshes/materials/textures)`,
    off.meshes === base.meshes && off.materials === base.materials && off.textures <= base.textures + 1,
    `${off.meshes}/${off.materials}/${off.textures} vs ${base.meshes}/${base.materials}/${base.textures}`)
  check(`cycle ${i}: no animation groups or sounds left behind`,
    off.anims === base.anims && off.sounds === base.sounds,
    `anims=${off.anims}/${base.anims} sounds=${off.sounds}/${base.sounds}`)
  last = off
}

check('heap does not grow across the cycles',
  last.heapMB < 0 || last.heapMB <= Math.max(base.heapMB * 1.5, base.heapMB + 40),
  `${base.heapMB}MB → ${last.heapMB}MB`)
check('the toggle really loaded models (test is meaningful)', peakLive >= 4, `peak=${peakLive}`)
check('no page errors', errors.length === 0, errors.join(' | '))

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nall checks passed')
process.exit(fails.length ? 1 : 0)
