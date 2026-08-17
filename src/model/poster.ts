import { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine'
import { Scene } from '@babylonjs/core/scene'
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera'
import type { Camera } from '@babylonjs/core/Cameras/camera'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture'
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader'
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Viewport } from '@babylonjs/core/Maths/math.viewport'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import type { AssetContainer } from '@babylonjs/core/assetContainer'
import './gltf'
import { configureDraco } from './draco'
import { dominantFacing, worldBox, frameDistance } from './facing'
import { validateGLBCached } from './limits'
import { graphics } from '../render/graphics'

// Cards display at roughly 320x200 CSS px; 448x280 keeps them sharp on
// HiDPI while costing ~24% fewer pixels per offscreen render than 512x320.
import EncodeWorker from './encode.worker?worker&inline'

export const POSTER_W = 448
export const POSTER_H = 280

export function toFile(blob: Blob, name: string): File {
  return new File([blob], name, { type: blob.type || 'application/octet-stream' })
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Where the model actually sits inside the poster frame, in normalised card
 * space (0..1, origin bottom-left). The board uses it to drop the contact
 * shadow exactly under the model instead of guessing the card's centre.
 */
export interface Footprint { cx: number; bottom: number; w: number }

export interface PosterResult {
  /** Raw RGBA straight off the GPU, BOTTOM-UP (GL order) — upload with invertY=false. */
  pixels: Uint8Array
  width: number
  height: number
  animated: boolean
  footprint: Footprint | null
  /** PNG for the IndexedDB cache; encoded lazily, off the display path. */
  toPng: () => Promise<Blob>
}

/**
 * Local thumbnail pipeline (step 4): GLB -> one frame -> 512x320 PNG.
 * A File (not a blob URL) keeps the .glb extension so the glTF plugin loads.
 * Uses the model's own camera when one exists (spec 04 §5), else auto-fit
 * facing the content.
 */
export class PosterRenderer {
  readonly scene: Scene
  private headlight: DirectionalLight
  /** reused readback buffer (0.5 MB per poster otherwise) */
  private readbackBuf = new Uint8Array(POSTER_W * POSTER_H * 4)
  private rtt: RenderTargetTexture
  // Renders share one scene (shared activeCamera + env); a promise-chain mutex
  // serializes them so concurrent calls can never stomp each other's camera.
  private chain: Promise<unknown> = Promise.resolve()
  constructor(engine: AbstractEngine) {
    configureDraco()
    this.scene = new Scene(engine)
    // Clear the render target to FULLY TRANSPARENT every frame. The old code
    // set `autoClear = false` and only configured `rtt.clearColor`, but the
    // camera.outputRenderTarget path clears through the SCENE — so the target
    // was never cleared and every poster came out on an opaque black slab.
    this.scene.autoClear = true
    this.scene.autoClearDepthAndStencil = true
    this.scene.clearColor = new Color4(0, 0, 0, 0)
    // Lights only. NO scene.environmentTexture: switching PBR materials to
    // IBL with a dark env cube rendered every model pitch black on this GL
    // driver (and the "black model" report was really a camera-framing bug).
    const hemi = new HemisphericLight('ph', new Vector3(0, 1, 0), this.scene)
    hemi.intensity = 1.0
    hemi.groundColor = new Color3(0.12, 0.12, 0.13)
    const key = new DirectionalLight('pk', new Vector3(-0.4, -0.6, 0.8), this.scene)
    key.intensity = 0.8
    const fill = new DirectionalLight('pf', new Vector3(0.5, 0.2, -0.6), this.scene)
    fill.intensity = 0.35
    // Headlight aimed along the poster camera's view direction, re-aimed per
    // model. Without it, dark models vanish completely on a transparent card.
    this.headlight = new DirectionalLight('ph2', new Vector3(0, 0, 1), this.scene)
    this.headlight.intensity = 0.55

    this.rtt = new RenderTargetTexture('poster-rtt', { width: POSTER_W, height: POSTER_H }, this.scene)
    this.rtt.renderTargetOptions.generateDepthBuffer = true
    this.rtt.renderTargetOptions.generateMipMaps = false
    this.rtt.samples = 1
    // Transparent background: posters composite over any page/board backdrop.
    this.rtt.clearColor = new Color4(0, 0, 0, 0)
  }

  render(bytes: Uint8Array, sha256: string): Promise<PosterResult> {
    const run = () => this.doRender(bytes, sha256)
    const result = this.chain.then(run, run)
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }

  private async doRender(bytes: Uint8Array, sha256: string): Promise<PosterResult> {
    let container: AssetContainer | null = null
    let ownCamera: FreeCamera | null = null
    // ONE render target for the whole session — allocating and freeing a
    // 448x280 target per poster churned GPU memory for no reason.
    const rtt = this.rtt
    try {
      // Enforce GLB limits before Babylon parses (07 §4).
      const report = validateGLBCached(bytes, sha256)
      if (!report.ok) throw new Error(report.reason)

      // Load from the shared bytes: a File source makes Babylon re-read the
      // whole model through a FileReader.
      container = await LoadAssetContainerAsync(bytes, this.scene, { pluginExtension: '.glb' })
      container.addAllToScene()
      graphics.applyToContainer(container)
      // Display-only: render both faces so thin/flat geometry (text, signs)
      // is never invisible from the auto-fit side. The source GLB is untouched.
      for (const m of container.meshes) {
        if (m.material) m.material.backFaceCulling = false
      }
      const animated = container.animationGroups.some((g) => g.targetedAnimations.length > 0)

      // Camera policy: the poster shows the model from its OWN camera when
      // the GLB ships one (the poster must match the view the author framed);
      // auto-fit is only the fallback for models without a camera.
      const { min, max, center, radius } = worldBox(container)
      let cam: Camera
      const authored = container.cameras[0]
      if (authored) {
        authored.computeWorldMatrix()
        // Display-only: authored near/far often clips tiny or offset models.
        // The GLB itself is never touched (same rule as backFaceCulling).
        const camPos = authored.getWorldMatrix().getTranslation()
        const dist = Vector3.Distance(camPos, center)
        authored.minZ = Math.max(0.0001, Math.min(authored.minZ, (dist - radius) * 0.2))
        authored.maxZ = Math.max(authored.maxZ, dist + radius * 6)
        this.headlight.direction = authored.getDirection(Vector3.Forward())
        cam = authored
      } else {
        const facing = dominantFacing(container)
        // Tight, aspect-aware framing: wide models must fill the 16:10 card.
        const fov = 0.7
        const dist = frameDistance(min, max, center, facing.scale(-1), fov, POSTER_W / POSTER_H, 0.86)
        this.headlight.direction = facing.scale(-1)
        ownCamera = new FreeCamera('poster-cam', center.add(facing.scale(dist)), this.scene)
        ownCamera.setTarget(center)
        ownCamera.fov = fov
        ownCamera.minZ = Math.max(0.001, (dist - radius) * 0.2)
        ownCamera.maxZ = dist + radius * 6
        cam = ownCamera
      }
      this.scene.activeCamera = cam
      // Render the scene into the RTT via the SAME path the detail viewer
      // uses (scene.render()): this compiles materials over frames, which the
      // manual rtt.render()/renderList path did not do reliably, leaving
      // every poster blank on this GL driver.
      cam.outputRenderTarget = rtt
      // Warm-up frames first: materials/textures compile over a few frames,
      // and readPixels is a full GPU sync — doing it once per attempt (with a
      // 100 ms sleep between attempts, 60 times) was most of the poster cost.
      let pixels: ArrayBufferView | null = null
      for (let attempt = 0; attempt < 14; attempt++) {
        this.scene.render()
        if (attempt < 2) { await sleep(0); continue }
        pixels = await this.readback()
        if (pixels && !isBlank(pixels)) break
        await sleep(attempt < 6 ? 30 : 90)
      }
      cam.outputRenderTarget = null
      if (!pixels) throw new Error('readPixels returned null')
      if (isBlank(pixels)) throw new Error('poster rendered empty')
      const footprint = projectFootprint(cam, min, max)
      // Copy out of the shared readback buffer; the caller owns these bytes.
      const src = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)
      const out = new Uint8Array(src.length)
      out.set(src)
      return {
        pixels: out,
        width: POSTER_W,
        height: POSTER_H,
        animated,
        footprint,
        toPng: () => encodePoster(out, POSTER_W, POSTER_H),
      }
    } finally {
      ownCamera?.dispose()
      if (container) { container.removeAllFromScene(); container.dispose() }
    }
  }

  /**
   * Read the render target back WITHOUT stalling the main thread.
   *
   * Babylon's `rtt.readPixels()` is a Promise-wrapped *synchronous*
   * `gl.readPixels`, i.e. a full GPU pipeline sync — it was the single
   * biggest main-thread cost of a board load (11% of wall time, ~120 ms per
   * poster in the profile). WebGL2 can read into a PIXEL_PACK_BUFFER and poll
   * a fence instead, which keeps the CPU free while the GPU drains.
   */
  private async readback(): Promise<ArrayBufferView | null> {
    const engine = this.scene.getEngine() as unknown as {
      _gl?: WebGL2RenderingContext
      _dummyFramebuffer?: WebGLFramebuffer | null
      _currentFramebuffer?: WebGLFramebuffer | null
      _readPixelsAsync?: (x: number, y: number, w: number, h: number, f: number, t: number, out: ArrayBufferView) => Promise<ArrayBufferView> | null
      webGLVersion?: number
    }
    const gl = engine._gl
    const internal = this.rtt.getInternalTexture() as unknown as {
      _hardwareTexture?: { underlyingResource?: WebGLTexture }
    } | null
    const resource = internal?._hardwareTexture?.underlyingResource
    if (!gl || !resource || (engine.webGLVersion ?? 1) < 2 || !engine._readPixelsAsync) {
      return this.rtt.readPixels(0, 0, this.readbackBuf, true)
    }
    try {
      if (!engine._dummyFramebuffer) engine._dummyFramebuffer = gl.createFramebuffer()
      const previous = engine._currentFramebuffer ?? null
      gl.bindFramebuffer(gl.FRAMEBUFFER, engine._dummyFramebuffer)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, resource, 0)
      const out = await engine._readPixelsAsync(0, 0, POSTER_W, POSTER_H, gl.RGBA, gl.UNSIGNED_BYTE, this.readbackBuf)
      gl.bindFramebuffer(gl.FRAMEBUFFER, previous)
      return out ?? this.readbackBuf
    } catch {
      return this.rtt.readPixels(0, 0, this.readbackBuf, true)
    }
  }

  dispose(): void { this.rtt.dispose(); this.scene.dispose() }
}

/** Normalised screen-space box of the model's AABB as the poster camera sees it. */
function projectFootprint(cam: Camera, min: Vector3, max: Vector3): Footprint | null {
  const m = cam.getTransformationMatrix()
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity
  const p = new Vector3()
  for (let i = 0; i < 8; i++) {
    p.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z)
    const q = Vector3.TransformCoordinates(p, m)
    if (!isFinite(q.x) || !isFinite(q.y)) return null
    const u = (q.x + 1) / 2
    const v = (q.y + 1) / 2
    uMin = Math.min(uMin, u); uMax = Math.max(uMax, u); vMin = Math.min(vMin, v)
  }
  if (!isFinite(uMin) || !isFinite(vMin)) return null
  return {
    cx: Math.max(0, Math.min(1, (uMin + uMax) / 2)),
    bottom: Math.max(0, Math.min(1, vMin)),
    w: Math.max(0.05, Math.min(1.2, uMax - uMin)),
  }
}

/** Blank = nothing was drawn: every sampled pixel is still fully transparent. */
function isBlank(view: ArrayBufferView): boolean {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  for (let i = 0; i < bytes.length; i += 4 * 397) {
    if (bytes[i + 3] > 4) return false
  }
  return true
}

// --------------------------------------------------------------- encoding

let encodeWorker: Worker | null = null
let encodeBroken = false
let encodeJob = 1
const encodeJobs = new Map<number, { resolve: (b: Blob) => void; reject: (e: Error) => void }>()

function getEncodeWorker(): Worker | null {
  if (encodeBroken || typeof OffscreenCanvas === 'undefined') return null
  if (encodeWorker) return encodeWorker
  try {
    encodeWorker = new EncodeWorker()
    encodeWorker.onmessage = (m: MessageEvent<{ id: number; blob?: Blob; error?: string }>) => {
      const job = encodeJobs.get(m.data.id)
      if (!job) return
      encodeJobs.delete(m.data.id)
      if (m.data.blob) job.resolve(m.data.blob)
      else job.reject(new Error(m.data.error || 'encode failed'))
    }
    encodeWorker.onerror = () => {
      encodeBroken = true
      for (const j of encodeJobs.values()) j.reject(new Error('encode worker died'))
      encodeJobs.clear()
      encodeWorker = null
    }
  } catch {
    encodeBroken = true
    encodeWorker = null
  }
  return encodeWorker
}

/** PNG for the poster cache, encoded on a worker when possible. */
async function encodePoster(view: Uint8Array, w: number, h: number): Promise<Blob> {
  const worker = getEncodeWorker()
  if (worker) {
    const id = encodeJob++
    const copy = view.slice(0)  // transferred to the worker
    try {
      return await new Promise<Blob>((resolve, reject) => {
        encodeJobs.set(id, { resolve, reject })
        worker.postMessage({ id, pixels: copy.buffer, width: w, height: h }, [copy.buffer])
      })
    } catch {
      // fall through to the main-thread encoder
    }
  }
  return encodePng(view, w, h)
}

let pngCanvas: HTMLCanvasElement | null = null

/** GL bottom-up RGBA -> top-down PNG (main-thread fallback). */
function encodePng(view: ArrayBufferView, w: number, h: number): Promise<Blob> {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  const canvas = pngCanvas ?? (pngCanvas = document.createElement('canvas'))
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(w, h)
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4
    const dst = y * w * 4
    for (let x = 0; x < w; x++) {
      img.data[dst + x * 4] = bytes[src + x * 4]
      img.data[dst + x * 4 + 1] = bytes[src + x * 4 + 1]
      img.data[dst + x * 4 + 2] = bytes[src + x * 4 + 2]
      img.data[dst + x * 4 + 3] = bytes[src + x * 4 + 3] // keep transparency
    }
  }
  ctx.putImageData(img, 0, 0)
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('poster encode failed'))), 'image/png'))
}
