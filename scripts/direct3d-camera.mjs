// 3D-MODE MAIN-CAMERA FRAMING — pixel check against the offline rig.
//
//   node scripts/offline-rig.mjs      # terminal 1  (needs bun run dev on 5173)
//   node scripts/direct3d-camera.mjs  # terminal 2
//
// SPEC AMENDMENT 43 / 75: with "Show posts as 3D models" ON, a board card and
// a thread node must show the post's REAL model THROUGH ITS MAIN CAMERA —
// same view the author framed, not a shrunken auto-fit of the whole scene.
//
// The rig's flavour `a` model is built exactly for this: a small RED cube at
// the origin plus a BIG GREEN cube 14 units away, and an authored camera that
// frames ONLY the red cube. So:
//   through the main camera -> the card is RED and the model fills the card
//   auto-fit / whole-scene   -> the card is mostly GREEN with a tiny red dot
// Flavour `d` carries preview-camera=1 (the GREEN view) — its card must be
// green, proving the index is honoured and not blindly camera 0.
import { launchFormBrowser } from './browser.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { PNG } from './png.mjs'

const URL = process.env.TARGET_URL || 'http://localhost:4173/'
const OUT = process.env.OUT_DIR || 'shots'
mkdirSync(OUT, { recursive: true })

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

const browser = await launchFormBrowser()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)))

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForFunction(() => window.__form0?.board, { timeout: 30000 })
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
await page.waitForFunction(() => window.__form0.index.byId.size > 10, { timeout: 30000 })
await page.waitForTimeout(3000)

// ---------------------------------------------------------------- board 3D
// Autoplay OFF: the rig's models animate OUT of their authored frame on
// purpose (the poster is frame 0), so a pixel census needs the rest pose.
await page.evaluate(() => window.__form0.settings.set({ autoplayAnimations: false, direct3D: true }))
// give the pool time to download + parse the visible models
await page.waitForFunction(() => {
  const b = window.__form0.board
  return b.cards.filter((c) => c.meta && b.pool3d.isLive(c.meta.eventId)).length >= 3
}, { timeout: 60000 }).catch(() => {})
await page.waitForTimeout(2500)

await page.screenshot({ path: `${OUT}/board3d.png` })

/** CSS rect of every live 3D card, tagged with the rig flavour (filename). */
const rects = await page.evaluate(() => {
  const b = window.__form0.board
  const eng = b.scene.getEngine()
  const cssW = eng.getRenderWidth() * eng.getHardwareScalingLevel()
  const cssH = eng.getRenderHeight() * eng.getHardwareScalingLevel()
  const out = []
  for (const c of b.cards) {
    if (!c.meta || !c.mesh.isEnabled()) continue
    if (!b.pool3d.isLive(c.meta.eventId)) continue
    const wx = c.mesh.position.x
    const wy = c.mesh.position.y
    const x = cssW / 2 + wx * b.pxPerUnit
    const y = ((b.halfH - wy) / (2 * b.halfH)) * cssH
    out.push({
      id: c.meta.eventId.slice(0, 8),
      file: c.meta.filename || '',
      x: x - (c.w * b.pxPerUnit) / 2, y: y - (c.h * b.pxPerUnit) / 2,
      w: c.w * b.pxPerUnit, h: c.h * b.pxPerUnit,
    })
  }
  return out
})
check('board has live 3D cards', rects.length > 0, `${rects.length} cards`)

/** Colour census of a screen rect: fraction of red / green model pixels. */
async function census(rect, name) {
  const clip = {
    x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)),
    width: Math.max(4, Math.round(rect.w)), height: Math.max(4, Math.round(rect.h)),
  }
  const buf = await page.screenshot({ clip })
  writeFileSync(`${OUT}/${name}.png`, buf)
  const { width, height, data } = PNG.decode(buf)
  let red = 0, green = 0, total = width * height
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    if (r > 70 && r > g * 1.6 && r > b * 1.6) red++
    else if (g > 60 && g > r * 1.5 && g > b * 1.5) green++
  }
  return { red: red / total, green: green / total, total }
}

const camCards = rects.filter((r) => r.file === 'a.glb')
const twoCamCards = rects.filter((r) => r.file === 'd.glb')
check('a camera-framed card (a.glb) is on screen', camCards.length > 0, `${camCards.length}`)

if (camCards.length) {
  const c = await census(camCards[0], 'board3d-card-a')
  console.log(`      a.glb card: red=${(c.red * 100).toFixed(1)}%  green=${(c.green * 100).toFixed(1)}%`)
  check('3D board card shows the MAIN-CAMERA view (red cube, no green)',
    c.red > 0.10 && c.green < 0.01, `red=${(c.red * 100).toFixed(1)}% green=${(c.green * 100).toFixed(1)}%`)
  check('3D board card is FILLED by the model (not a postage stamp)',
    c.red > 0.18, `red=${(c.red * 100).toFixed(1)}%`)
}
if (twoCamCards.length) {
  const c = await census(twoCamCards[0], 'board3d-card-d')
  console.log(`      d.glb card: red=${(c.red * 100).toFixed(1)}%  green=${(c.green * 100).toFixed(1)}%`)
  check('3D board card honours preview-camera=1 (green view)',
    c.green > 0.10 && c.red < 0.01, `red=${(c.red * 100).toFixed(1)}% green=${(c.green * 100).toFixed(1)}%`)
}

// --------------------------------------------------------------- thread 3D
// Root #1 of the rig owns the reply tree; its replies cycle c/b/a/x, so the
// tree contains a camera-framed (a.glb) node.
const rootId = await page.evaluate(() => {
  const idx = window.__form0.index
  for (const [id, m] of idx.byId) {
    if ((m.role === 'root') && idx.childCount?.(id) > 0) return id
  }
  // fall back: any post that other posts reply to
  const parents = new Set()
  for (const [, m] of idx.byId) if (m.refs?.rootId) parents.add(m.refs.rootId)
  return [...parents][0] || null
})
if (rootId) {
  await page.evaluate((id) => { window.location.hash = `#/thread/${id}` }, rootId)
  await page.waitForTimeout(8000)
  await page.screenshot({ path: `${OUT}/thread3d.png` })
  const nodes = await page.evaluate(() => {
    const t = window.__form0.threadView
    const eng = t.scene.getEngine()
    const cssW = eng.getRenderWidth() * eng.getHardwareScalingLevel()
    const cssH = eng.getRenderHeight() * eng.getHardwareScalingLevel()
    const halfH = 20 * t.zoom
    const halfW = halfH * t.aspect
    const out = []
    for (const [id, n] of t.nodes) {
      if (!t.pool3d.isLive(id)) continue
      const sx = ((n.x - t.panX + halfW) / (2 * halfW)) * cssW
      const sy = ((halfH - (n.y - t.panY)) / (2 * halfH)) * cssH
      const pw = (n.w / (2 * halfW)) * cssW
      const ph = (n.h / (2 * halfH)) * cssH
      out.push({ id: id.slice(0, 8), file: n.meta.filename || '', x: sx - pw / 2, y: sy - ph / 2, w: pw, h: ph })
    }
    return out
  })
  check('thread has live 3D nodes', nodes.length > 0, `${nodes.length} nodes`)
  const camNode = nodes.find((n) => n.file === 'a.glb')
  if (camNode) {
    const c = await census(camNode, 'thread3d-node-a')
    console.log(`      a.glb node: red=${(c.red * 100).toFixed(1)}%  green=${(c.green * 100).toFixed(1)}%`)
    check('3D thread node shows the MAIN-CAMERA view (red cube, no green)',
      c.red > 0.10 && c.green < 0.01, `red=${(c.red * 100).toFixed(1)}% green=${(c.green * 100).toFixed(1)}%`)
  } else {
    check('a camera-framed node (a.glb) is on screen', false, nodes.map((n) => n.file).join(','))
  }
}

check('no page errors', errors.length === 0, errors.join(' | '))
await browser.close()
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nall checks passed')
process.exit(fails.length ? 1 : 0)
