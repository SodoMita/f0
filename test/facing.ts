// Facing probe: for every ?u=<glb url> render the model from +facing and
// -facing plus the raw ±Z axes, so a human/VLM can judge which side is the
// readable one and the heuristic in model/facing.ts can be checked.
import { Engine } from '@babylonjs/core/Engines/engine'
import { Scene } from '@babylonjs/core/scene'
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture'
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import '@babylonjs/loaders/glTF'
import { configureDraco } from '../src/model/draco'
import { dominantFacing, worldBox, frameDistance, lastFacingDebug } from '../src/model/facing'
import { toFile } from '../src/model/poster'

const W = 384, H = 240
const out = document.getElementById('out') as HTMLDivElement
const canvas = document.getElementById('c') as HTMLCanvasElement
configureDraco()
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true })
const scene = new Scene(engine)
scene.autoClear = true
scene.clearColor = new Color4(0.07, 0.07, 0.08, 1)
const hemi = new HemisphericLight('h', new Vector3(0, 1, 0), scene)
hemi.intensity = 1
hemi.groundColor = new Color3(0.12, 0.12, 0.13)
const key = new DirectionalLight('k', new Vector3(-0.4, -0.6, 0.8), scene)
key.intensity = 0.8
const head = new DirectionalLight('hd', new Vector3(0, 0, 1), scene)
head.intensity = 0.55

const urls = new URLSearchParams(location.search).getAll('u')

async function shot(dir: Vector3, min: Vector3, max: Vector3, center: Vector3): Promise<string> {
  head.direction = dir.scale(-1)
  const rtt = new RenderTargetTexture('rtt', { width: W, height: H }, scene)
  const dist = frameDistance(min, max, center, dir.scale(-1), 0.7, W / H, 0.86)
  const cam = new FreeCamera('c', center.add(dir.scale(dist)), scene)
  cam.setTarget(center)
  cam.fov = 0.7
  cam.minZ = Math.max(0.001, dist * 0.01)
  cam.maxZ = dist * 8
  scene.activeCamera = cam
  cam.outputRenderTarget = rtt
  for (let i = 0; i < 12; i++) { scene.render(); await new Promise((r) => setTimeout(r, 40)) }
  const px = await rtt.readPixels(0, 0, undefined, true)
  cam.outputRenderTarget = null
  cam.dispose()
  const bytes = new Uint8Array(px!.buffer, px!.byteOffset, px!.byteLength)
  const cv = document.createElement('canvas')
  cv.width = W; cv.height = H
  const ctx = cv.getContext('2d')!
  const img = ctx.createImageData(W, H)
  for (let y = 0; y < H; y++) {
    const s = (H - 1 - y) * W * 4, d = y * W * 4
    for (let x = 0; x < W * 4; x++) img.data[d + x] = bytes[s + x]
  }
  ctx.putImageData(img, 0, 0)
  rtt.dispose()
  return cv.toDataURL('image/png')
}

async function run(): Promise<void> {
  for (const url of urls) {
    const row = document.createElement('div')
    out.appendChild(row)
    try {
      const blob = await (await fetch(url)).blob()
      const container = await LoadAssetContainerAsync(toFile(blob, 'model.glb'), scene)
      container.addAllToScene()
      for (const m of container.meshes) if (m.material) m.material.backFaceCulling = false
      const { min, max, center } = worldBox(container)
      const facing = dominantFacing(container)
      const label = document.createElement('div')
      const dbg = lastFacingDebug
      const f3 = (n: number) => n.toFixed(3)
      label.textContent = `${url.slice(-14)}  facing=(${facing.x},${facing.y},${facing.z})` +
        (dbg ? `  sum=(${f3(dbg.sum.x)},${f3(dbg.sum.y)},${f3(dbg.sum.z)}) mag=(${f3(dbg.mag.x)},${f3(dbg.mag.y)},${f3(dbg.mag.z)}) tris=${dbg.triangles}` : '')
      row.appendChild(label)
      const variants: [string, Vector3][] = [
        ['facing', facing],
        ['-facing', facing.scale(-1)],
      ]
      for (const [name, dir] of variants) {
        const src = await shot(dir, min, max, center)
        const fig = document.createElement('figure')
        const im = new Image()
        im.src = src
        fig.appendChild(im)
        const cap = document.createElement('figcaption')
        cap.textContent = name
        fig.appendChild(cap)
        row.appendChild(fig)
      }
      container.removeAllFromScene()
      container.dispose()
    } catch (e) {
      row.textContent = `${url}: ${(e as Error).message}`
    }
  }
  ;(window as unknown as { __facingDone: boolean }).__facingDone = true
}
void run()
