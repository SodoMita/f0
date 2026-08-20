// ORIENTATION PROOF for the card pipeline (open /test/orient2.html).
//
// Renders the SAME asymmetric probe through all three texture kinds the app
// uses — RawTexture (posters), DynamicTexture (badges/backdrops) and
// RenderTargetTexture (live previews) — through the production flat camera
// (core/gfx.flatCamera) and the production card material, then reads the
// framebuffer back at the four corners of each quad.
//
// Probe quadrants:   top-left RED   top-right GREEN
//                    bottom-left BLUE   bottom-right WHITE
//
// A mirrored quad swaps left/right, an upside-down one swaps top/bottom.
// Results are printed and exposed on `window.__orient` for scripts/orient.mjs.
import { Engine } from '@babylonjs/core/Engines/engine'
import { Scene } from '@babylonjs/core/scene'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color4 } from '@babylonjs/core/Maths/math.color'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { makeCardMaterial, setCardTexture, setCardFlip, type CardTextureKind } from '../src/board/cardMaterial'
import { flatCamera } from '../src/core/gfx'

const canvas = document.getElementById('c') as HTMLCanvasElement
const out = document.getElementById('out') as HTMLPreElement
const log = (...a: unknown[]) => { out.textContent += a.join(' ') + '\n' }

const S = 64
const KINDS: CardTextureKind[] = ['raw', 'dyn', 'rtt']
const QUAD = 5 // world size of each probe quad
const GAP = 1.6

const engine = new Engine(canvas, true, { preserveDrawingBuffer: true })
const scene = new Scene(engine)
scene.clearColor = new Color4(0, 0, 0, 1)
const cam = flatCamera(scene, 'orient-cam', 30)
cam.orthoTop = 4; cam.orthoBottom = -4
cam.orthoLeft = -(canvas.width / canvas.height) * 4
cam.orthoRight = (canvas.width / canvas.height) * 4

/** top-left RED, top-right GREEN, bottom-left BLUE, bottom-right WHITE */
function paint(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, S / 2, S / 2)
  ctx.fillStyle = '#00ff00'; ctx.fillRect(S / 2, 0, S / 2, S / 2)
  ctx.fillStyle = '#0000ff'; ctx.fillRect(0, S / 2, S / 2, S / 2)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(S / 2, S / 2, S / 2, S / 2)
}

function rawProbe(): RawTexture {
  // top-down RGBA rows (invertY=true). Cached posters now upload GL
  // bottom-up with invertY=false (same as an RTT); this probe still
  // covers the invertY=true RawTexture kind.
  const data = new Uint8Array(S * S * 4)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4
      const top = y < S / 2
      const left = x < S / 2
      const c = top ? (left ? [255, 0, 0] : [0, 255, 0]) : (left ? [0, 0, 255] : [255, 255, 255])
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255
    }
  }
  return RawTexture.CreateRGBATexture(data, S, S, scene, false, true, Texture.NEAREST_SAMPLINGMODE)
}

function dynProbe(): DynamicTexture {
  const t = new DynamicTexture('dyn-probe', { width: S, height: S }, scene, false, Texture.NEAREST_SAMPLINGMODE)
  paint(t.getContext() as CanvasRenderingContext2D)
  t.update()
  return t
}

function rttProbe(): RenderTargetTexture {
  // stage a dyn probe quad and render it through a flat camera into an RTT,
  // i.e. the exact live-preview path
  const stage = new Scene(engine)
  stage.autoClear = true
  stage.clearColor = new Color4(0, 0, 0, 0)
  const sc = flatCamera(stage, 'stage-cam', 10)
  sc.orthoTop = 1; sc.orthoBottom = -1; sc.orthoLeft = -1; sc.orthoRight = 1
  const plane = MeshBuilder.CreatePlane('stage-quad', { width: 2, height: 2 }, stage)
  const mat = makeCardMaterial(stage)
  const t = new DynamicTexture('stage-probe', { width: S, height: S }, stage, false, Texture.NEAREST_SAMPLINGMODE)
  paint(t.getContext() as CanvasRenderingContext2D)
  t.update()
  setCardTexture(mat, t)
  setCardFlip(mat, 'dyn')
  plane.material = mat
  const rtt = new RenderTargetTexture('rtt-probe', { width: S, height: S }, stage)
  rtt.samples = 1
  sc.outputRenderTarget = rtt
  stage.render()
  stage.render()
  sc.outputRenderTarget = null
  return rtt
}

const probes: Record<CardTextureKind, Texture> = {
  raw: rawProbe(),
  dyn: dynProbe(),
  rtt: rttProbe() as unknown as Texture,
}

KINDS.forEach((kind, i) => {
  const mesh = MeshBuilder.CreatePlane(`quad-${kind}`, { width: QUAD, height: QUAD }, scene)
  const mat = makeCardMaterial(scene)
  setCardTexture(mat, probes[kind])
  setCardFlip(mat, kind)
  mesh.material = mat
  mesh.position.x = (i - 1) * (QUAD + GAP)
})

const name = (p: number[]): string => {
  const [r, g, b] = p
  if (r > 150 && g < 100 && b < 100) return 'RED'
  if (g > 150 && r < 100 && b < 100) return 'GREEN'
  if (b > 150 && r < 100 && g < 100) return 'BLUE'
  if (r > 150 && g > 150 && b > 150) return 'WHITE'
  return `(${r},${g},${b})`
}

async function run(): Promise<void> {
  for (let i = 0; i < 8; i++) { scene.render(); await new Promise((r) => setTimeout(r, 50)) }
  scene.render()

  const w = engine.getRenderWidth()
  const h = engine.getRenderHeight()
  const toPx = (wx: number, wy: number): [number, number] => [
    Math.round(((wx - cam.orthoLeft!) / (cam.orthoRight! - cam.orthoLeft!)) * w),
    // engine.readPixels' origin is the BOTTOM-left of the framebuffer
    Math.round(((wy - cam.orthoBottom!) / (cam.orthoTop! - cam.orthoBottom!)) * h),
  ]
  const read = async (wx: number, wy: number): Promise<number[]> => {
    const [px, py] = toPx(wx, wy)
    const v = await engine.readPixels(px, py, 1, 1, true, false)
    const b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
    return [b[0], b[1], b[2]]
  }

  const results: Record<string, { tl: string; tr: string; bl: string; br: string; ok: boolean }> = {}
  for (let i = 0; i < KINDS.length; i++) {
    const kind = KINDS[i]
    const cx = (i - 1) * (QUAD + GAP)
    const q = QUAD / 4
    const tl = name(await read(cx - q, q))
    const tr = name(await read(cx + q, q))
    const bl = name(await read(cx - q, -q))
    const br = name(await read(cx + q, -q))
    const ok = tl === 'RED' && tr === 'GREEN' && bl === 'BLUE' && br === 'WHITE'
    results[kind] = { tl, tr, bl, br, ok }
    log(`${ok ? 'PASS' : 'FAIL'}  ${kind}: TL=${tl} TR=${tr} BL=${bl} BR=${br}` +
      (ok ? '' : '   (expected TL=RED TR=GREEN BL=BLUE BR=WHITE)'))
  }
  const allOk = KINDS.every((k) => results[k].ok)
  log(allOk ? '\nALL KINDS ORIENTED CORRECTLY' : '\nORIENTATION BROKEN')
  ;(window as unknown as { __orient: unknown }).__orient = { results, ok: allOk }
}

void run()
