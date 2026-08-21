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

/** Pixel bounds of the MODEL inside a crop: saturated pixels only, so the
 *  greyscale HUD chrome (play button, reply pill, backdrop) is ignored. */
function modelBounds(width, height, data) {
  let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const r = data[i], g = data[i + 1], b = data[i + 2]
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
      if (mx > 60 && mx - mn > 30) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return x1 < 0 ? null : { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 }
}

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
  return { red: red / total, green: green / total, total, width, height, model: modelBounds(width, height, data) }
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
// The model must stay GLUED to its card while the feed scrolls: the fit and
// the crop follow the cell, they are not baked at load time.
{
  await page.mouse.move(640, 500)
  await page.mouse.wheel(0, 90)
  await page.waitForTimeout(2500)
  const moved = await page.evaluate(() => {
    const b = window.__form0.board
    const eng = b.scene.getEngine()
    const cssW = eng.getRenderWidth() * eng.getHardwareScalingLevel()
    const cssH = eng.getRenderHeight() * eng.getHardwareScalingLevel()
    // the live 3D card nearest the middle of the viewport, fully on screen
    const fits = b.cards.filter((c) => c.meta && c.mesh.isEnabled() && b.pool3d.isLive(c.meta.eventId) &&
      Math.abs(c.mesh.position.y) + c.h / 2 <= b.halfH)
    fits.sort((p, q) => Math.abs(p.mesh.position.y) - Math.abs(q.mesh.position.y))
    const c = fits[0]
    if (!c) return null
    const x = cssW / 2 + c.mesh.position.x * b.pxPerUnit
    const y = ((b.halfH - c.mesh.position.y) / (2 * b.halfH)) * cssH
    return {
      file: c.meta.filename, scrolled: +b.scrollY.toFixed(1),
      x: x - (c.w * b.pxPerUnit) / 2, y: y - (c.h * b.pxPerUnit) / 2,
      w: c.w * b.pxPerUnit, h: c.h * b.pxPerUnit,
    }
  })
  if (!moved || moved.scrolled <= 0) {
    check('the board scrolled with a live 3D card on screen', false, JSON.stringify(moved))
  } else {
    const c = await census(moved, 'board3d-card-scrolled')
    const off = c.model ? Math.max(Math.abs(c.model.cx - c.width / 2), Math.abs(c.model.cy - c.height / 2)) : Infinity
    check(`after scrolling, the model is still centred in its card (${moved.file})`,
      off < 0.04 * c.height, `offset=${Number.isFinite(off) ? off.toFixed(1) : 'no model'}px of ${c.height}px`)
    check('after scrolling, the model is still cropped to its card',
      !!c.model && c.model.w <= c.width && c.model.h <= c.height,
      c.model ? `${c.model.w}x${c.model.h} in ${c.width}x${c.height}` : 'no model')
  }
}

// preview-camera=1 (rig flavour `d`): the SECOND authored camera frames the
// green cube. Filter the board down to that flavour so a card is on screen.
if (!twoCamCards.length) {
  await page.evaluate(() => window.__form0.setSearchQuery('d.glb'))
  await page.waitForFunction(() => {
    const b = window.__form0.board
    return b.cards.some((c) => c.meta && c.meta.filename === 'd.glb' && b.pool3d.isLive(c.meta.eventId))
  }, { timeout: 60000 }).catch(() => {})
  await page.waitForTimeout(2500)
  const more = await page.evaluate(() => {
    const b = window.__form0.board
    const eng = b.scene.getEngine()
    const cssW = eng.getRenderWidth() * eng.getHardwareScalingLevel()
    const cssH = eng.getRenderHeight() * eng.getHardwareScalingLevel()
    const out = []
    for (const c of b.cards) {
      if (!c.meta || !c.mesh.isEnabled() || c.meta.filename !== 'd.glb') continue
      if (!b.pool3d.isLive(c.meta.eventId)) continue
      const x = cssW / 2 + c.mesh.position.x * b.pxPerUnit
      const y = ((b.halfH - c.mesh.position.y) / (2 * b.halfH)) * cssH
      out.push({ file: c.meta.filename, x: x - (c.w * b.pxPerUnit) / 2, y: y - (c.h * b.pxPerUnit) / 2, w: c.w * b.pxPerUnit, h: c.h * b.pxPerUnit })
    }
    return out
  })
  twoCamCards.push(...more)
}
check('a preview-camera card (d.glb) is on screen', twoCamCards.length > 0, `${twoCamCards.length}`)
if (twoCamCards.length) {
  const c = await census(twoCamCards[0], 'board3d-card-d')
  console.log(`      d.glb card: red=${(c.red * 100).toFixed(1)}%  green=${(c.green * 100).toFixed(1)}%`)
  check('3D board card honours preview-camera=1 (the GREEN camera, not cam 0)',
    c.green > 0.10 && c.red < 0.01, `red=${(c.red * 100).toFixed(1)}% green=${(c.green * 100).toFixed(1)}%`)

  // That camera is a CLOSE-UP: the model overflows the cell, so it is the
  // best test of the crop. Shoot a padded rect — nothing may bleed out of
  // the card (a poster is cut off by the card's edges; a model must be too).
  const r = twoCamCards[0]
  const pad = 40
  const clip = {
    x: Math.max(0, Math.round(r.x - pad)), y: Math.max(0, Math.round(r.y - pad)),
    width: Math.round(r.w + 2 * pad), height: Math.round(r.h + 2 * pad),
  }
  const padded = await page.screenshot({ clip })
  writeFileSync(`${OUT}/board3d-card-d-padded.png`, padded)
  const img = PNG.decode(padded)
  let gx0 = 1e9, gx1 = -1, gy0 = 1e9, gy1 = -1
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4
      const R = img.data[i], G = img.data[i + 1], B = img.data[i + 2]
      if (G > 60 && G > R * 1.5 && G > B * 1.5) {
        if (x < gx0) gx0 = x
        if (x > gx1) gx1 = x
        if (y < gy0) gy0 = y
        if (y > gy1) gy1 = y
      }
    }
  }
  const left = Math.round(r.x) - clip.x, top = Math.round(r.y) - clip.y
  const slack = 2
  check('a close-up model is CROPPED to its card (no bleed onto neighbours)',
    gx0 >= left - slack && gx1 <= left + Math.round(r.w) + slack &&
    gy0 >= top - slack && gy1 <= top + Math.round(r.h) + slack,
    `green=[${gx0},${gx1}]x[${gy0},${gy1}] card=[${left},${left + Math.round(r.w)}]x[${top},${top + Math.round(r.h)}]`)
}
await page.evaluate(() => window.__form0.setSearchQuery(''))
await page.waitForTimeout(1500)

// Demand-driven rendering must survive 3D mode: a settled board with paused
// models draws ZERO frames, and an animating one draws again. The warm-up
// loop that fixed blank cards must not latch (AMENDMENT 77 had exactly that
// bug in the other direction: isAnimating latched -> 30 fps forever).
{
  const renders = () => page.evaluate(() => window.__form0.engine.perfStats().renders)
  await page.waitForTimeout(2000)
  const idle0 = await renders()
  await page.waitForTimeout(2500)
  const idle1 = await renders()
  check('3D mode goes idle when nothing moves (no runaway render loop)',
    idle1 - idle0 <= 5, `${idle1 - idle0} frames in 2.5s`)

  await page.evaluate(() => window.__form0.settings.set({ autoplayAnimations: true }))
  await page.waitForTimeout(1500)
  const play0 = await renders()
  await page.waitForTimeout(2000)
  const play1 = await renders()
  check('3D models still animate (frames keep coming with autoplay on)',
    play1 - play0 >= 15, `${play1 - play0} frames in 2s`)

  await page.evaluate(() => window.__form0.settings.set({ autoplayAnimations: false }))
  await page.waitForTimeout(2500)
  const paused0 = await renders()
  await page.waitForTimeout(2500)
  const paused1 = await renders()
  check('turning autoplay back off stops the render loop again',
    paused1 - paused0 <= 5, `${paused1 - paused0} frames in 2.5s`)
}

// Toggling back to 2D must remove every direct model from the scene (no
// orphan meshes floating over the posters), and toggling on must bring them
// back — the mode generation counter guards the async poster/3D race.
{
  await page.evaluate(() => window.__form0.settings.set({ direct3D: false }))
  await page.waitForTimeout(3000)
  const off = await page.evaluate(() => ({
    d3Nodes: window.__form0.board.scene.transformNodes.filter((n) => n.name.startsWith('d3-')).length,
    live: window.__form0.board.cards.filter((c) => c.meta && window.__form0.board.pool3d.isLive(c.meta.eventId)).length,
    posters: window.__form0.board.cards.filter((c) => c.meta && c.poster).length,
  }))
  check('2D again: no direct-3D models left in the scene', off.d3Nodes === 0 && off.live === 0, JSON.stringify(off))
  check('2D again: cards fall back to posters', off.posters > 0, `${off.posters} posters`)

  await page.evaluate(() => window.__form0.settings.set({ direct3D: true }))
  await page.waitForFunction(() => {
    const b = window.__form0.board
    return b.cards.filter((c) => c.meta && b.pool3d.isLive(c.meta.eventId)).length >= 3
  }, { timeout: 60000 }).catch(() => {})
  await page.waitForTimeout(2500)
  const back = await page.evaluate(() => {
    const b = window.__form0.board
    const c = b.cards.find((c) => c.meta && c.meta.filename === 'a.glb' && b.pool3d.isLive(c.meta.eventId))
    const eng = b.scene.getEngine()
    const cssW = eng.getRenderWidth() * eng.getHardwareScalingLevel()
    const cssH = eng.getRenderHeight() * eng.getHardwareScalingLevel()
    if (!c) return null
    const x = cssW / 2 + c.mesh.position.x * b.pxPerUnit
    const y = ((b.halfH - c.mesh.position.y) / (2 * b.halfH)) * cssH
    return { id: c.meta.eventId, x: x - (c.w * b.pxPerUnit) / 2, y: y - (c.h * b.pxPerUnit) / 2, w: c.w * b.pxPerUnit, h: c.h * b.pxPerUnit, cx: x, cy: y }
  })
  check('3D again: models come back', !!back)
  if (back) {
    const c = await census(back, 'board3d-card-a-retoggled')
    check('3D again: still the main-camera view', c.red > 0.10 && c.green < 0.01,
      `red=${(c.red * 100).toFixed(1)}% green=${(c.green * 100).toFixed(1)}%`)
    // A 3D model must not swallow taps: the card quad below it opens the post.
    await page.mouse.click(Math.round(back.cx), Math.round(back.cy))
    await page.waitForTimeout(1500)
    const hash = await page.evaluate(() => window.location.hash)
    check('tapping a 3D card opens the viewer', hash.startsWith('#/viewer/'), hash)
    await page.evaluate(() => { window.location.hash = '#/' })
    await page.waitForTimeout(2500)
  }
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
