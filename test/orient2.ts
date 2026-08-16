// Definitive flip matrix per texture kind: ?kind=raw|dyn|rtt
// Four quads at fixed positions with flips (0,1),(0,0),(1,1),(1,0).
// Pattern: RED top half, GREEN bottom half, BLUE left column.
// CORRECT = RED top, GREEN bottom, BLUE left.
import { Engine } from '@babylonjs/core/Engines/engine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color4 } from '@babylonjs/core/Maths/math.color'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture'
import { makeCardMaterial, setCardFlip } from '../src/board/cardMaterial'

const canvas = document.getElementById('c') as HTMLCanvasElement
const out = document.getElementById('out') as HTMLDivElement
const log = (...a: unknown[]) => { out.textContent += a.join(' ') + '\n' }
const kind = new URLSearchParams(location.search).get('kind') || 'raw'

const engine = new Engine(canvas, true, { preserveDrawingBuffer: true })
const scene = new Scene(engine)
scene.clearColor = new Color4(0, 0, 0, 1)
const cam = new ArcRotateCamera('cam', Math.PI / 2, Math.PI / 2, 10, Vector3.Zero(), scene)
cam.mode = ArcRotateCamera.ORTHOGRAPHIC_CAMERA
cam.orthoTop = 4.5; cam.orthoBottom = -4.5; cam.orthoLeft = -10; cam.orthoRight = 10
scene.activeCamera = cam

function patternCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = w; c.height = h
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#00ff00'; ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, w, h / 2)
  ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, w / 4, h)
  return c
}

let texture: any
if (kind === 'raw') {
  texture = new RawTexture(patternCanvas(64, 64).getContext('2d')!.getImageData(0, 0, 64, 64).data, 64, 64, 5, scene, false, false)
} else if (kind === 'dyn') {
  texture = new DynamicTexture('dtc', { width: 64, height: 64 }, scene, false)
  texture.getContext()!.drawImage(patternCanvas(64, 64), 0, 0)
  texture.update()
} else {
  const stage = new Scene(engine)
  const sc = new ArcRotateCamera('sc', Math.PI / 2, Math.PI / 2, 10, Vector3.Zero(), stage)
  sc.mode = ArcRotateCamera.ORTHOGRAPHIC_CAMERA
  sc.orthoTop = 1.5; sc.orthoBottom = -1.5; sc.orthoLeft = -1.5; sc.orthoRight = 1.5
  stage.activeCamera = sc
  const splane = MeshBuilder.CreatePlane('sp', { width: 3, height: 4 }, stage)
  const smat = makeCardMaterial(stage)
  const dt = new DynamicTexture('dt', patternCanvas(64, 64), stage, false)
  dt.update()
  smat.setTexture('tex', dt)
  setCardFlip(smat, false, false)
  splane.material = smat
  const rtt = new RenderTargetTexture('rtt', { width: 64, height: 64 }, stage)
  rtt.clearColor = new Color4(0, 0, 0, 0)
  sc.outputRenderTarget = rtt
  for (let i = 0; i < 5; i++) stage.render()
  sc.outputRenderTarget = null
  texture = rtt
}

const flips: [number, number][] = [[0, 1], [0, 0], [1, 1], [1, 0]]
const cxs = [-6.5, -2.5, 1.5, 5.5]
const quads: any[] = []
for (let i = 0; i < 4; i++) {
  const mesh = MeshBuilder.CreatePlane('q' + i, { width: 3, height: 4 }, scene)
  mesh.position.x = cxs[i]
  const mat = makeCardMaterial(scene)
  mat.setTexture('tex', texture)
  setCardFlip(mat, flips[i][0] === 1, flips[i][1] === 1)
  mesh.material = mat
  quads.push({ mesh, mat, flip: flips[i] })
}

for (let i = 0; i < 8; i++) scene.render()
await new Promise((r) => setTimeout(r, 300))
const view = await engine.readPixels(0, 0, canvas.width, canvas.height, true)
const px = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)

const isRed = (v: number[]) => v[0] > 180 && v[1] < 90 && v[2] < 90
const isGreen = (v: number[]) => v[1] > 180 && v[0] < 90 && v[2] < 90
const isBlue = (v: number[]) => v[2] > 180 && v[0] < 90 && v[1] < 90
const name = (v: number[]) => isRed(v) ? 'RED' : isGreen(v) ? 'GREEN' : isBlue(v) ? 'BLUE' : `(${v.join(',')})`

log('kind:', kind)
for (const q of quads) {
  const cx = q.mesh.position.x
  const at = (dx: number, dy: number) => {
    const sx = Math.round(canvas.width / 2 + (cx + dx) * 45)
    const sy = Math.round(200 - dy * 44.4)
    const i = (sy * canvas.width + sx) * 4
    return [px[i], px[i + 1], px[i + 2]]
  }
  const top = at(0.5, 1.3), bot = at(0.5, -1.3), left = at(-1, 1.3), right = at(1, 1.3)
  log(`flip(${q.flip[0]},${q.flip[1]})  top=${name(top)} bot=${name(bot)} left=${name(left)} right=${name(right)}`)
}
// 2D grid
const L = (x: number, y: number) => {
  const i = (y * canvas.width + x) * 4
  const v = [px[i], px[i + 1], px[i + 2]]
  return isRed(v) ? 'R' : isGreen(v) ? 'G' : isBlue(v) ? 'B' : v[0] + v[1] + v[2] > 60 ? '?' : '.'
}
for (let y = 30; y < 400; y += 25) {
  let row = ''
  for (let x = 30; x < 900; x += 10) row += L(x, y)
  log(row)
}
engine.dispose()
