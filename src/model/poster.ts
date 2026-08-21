import { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine'
import { Scene } from '@babylonjs/core/scene'
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera'
import type { Camera } from '@babylonjs/core/Cameras/camera'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { Material } from '@babylonjs/core/Materials/material'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Frustum } from '@babylonjs/core/Maths/math.frustum'
import { BoundingBox } from '@babylonjs/core/Culling/boundingBox'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import type { AssetContainer } from '@babylonjs/core/assetContainer'
import './gltf'
import { configureDraco } from './draco'
import { dominantFacing, worldBox, frameDistance } from './facing'
import { validateGLBCached } from './limits'
import { graphics } from '../render/graphics'

import { POSTER_W as DEFAULT_W, POSTER_H as DEFAULT_H } from '../theme'

export const POSTER_W = DEFAULT_W
export const POSTER_H = DEFAULT_H

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
  /** Dedicated transparent RTT — the card samples this. Never a PNG. */
  texture: RenderTargetTexture
  width: number
  height: number
  animated: boolean
  footprint: Footprint | null
}

/**
 * Local poster pipeline: GLB -> one transparent RTT. The RTT stays on the
 * GPU and is the card texture — no readPixels, no blank-check retry loop
 * (existing posts are visible in the viewer anyway; the pixel probe just
 * burned frames). Camera: authored if it overlaps the AABB, else auto-fit.
 */
export class PosterRenderer {
  readonly scene: Scene
  private headlight: DirectionalLight
  /** reused only by snapshot() (studio / tests) — never the card path */
  private readbackBuf = new Uint8Array(POSTER_W * POSTER_H * 4)
  // Renders share one scene; a promise-chain mutex serializes them so
  // concurrent calls can never stomp each other's camera.
  private chain: Promise<unknown> = Promise.resolve()
  constructor(engine: AbstractEngine) {
    configureDraco()
    this.scene = new Scene(engine)
    // camera.outputRenderTarget clears through the SCENE, so rtt.clearColor
    // alone left every poster on an opaque black slab.
    this.scene.autoClear = true
    this.scene.autoClearDepthAndStencil = true
    this.scene.clearColor = new Color4(0, 0, 0, 0)
    const hemi = new HemisphericLight('ph', new Vector3(0, 1, 0), this.scene)
    hemi.intensity = 1.0
    hemi.groundColor = new Color3(0.12, 0.12, 0.13)
    const key = new DirectionalLight('pk', new Vector3(-0.4, -0.6, 0.8), this.scene)
    key.intensity = 0.8
    const fill = new DirectionalLight('pf', new Vector3(0.5, 0.2, -0.6), this.scene)
    fill.intensity = 0.35
    this.headlight = new DirectionalLight('ph2', new Vector3(0, 0, 1), this.scene)
    this.headlight.intensity = 0.55
  }

  render(bytes: Uint8Array, sha256: string, width = POSTER_W, height = POSTER_H): Promise<PosterResult> {
    const run = () => this.doRender(bytes, sha256, width, height)
    const result = this.chain.then(run, run)
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }

  private makeRtt(width: number, height: number): RenderTargetTexture {
    const rtt = new RenderTargetTexture('poster-rtt', { width, height }, this.scene)
    rtt.renderTargetOptions.generateDepthBuffer = true
    rtt.renderTargetOptions.generateMipMaps = false
    rtt.samples = 1
    rtt.wrapU = Texture.CLAMP_ADDRESSMODE
    rtt.wrapV = Texture.CLAMP_ADDRESSMODE
    rtt.hasAlpha = true
    rtt.clearColor = new Color4(0, 0, 0, 0)
    // Detach after capture: the next poster.scene.render() would otherwise
    // refresh every customRenderTarget and wipe earlier cards.
    rtt.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE
    return rtt
  }

  private async doRender(bytes: Uint8Array, sha256: string, width: number, height: number): Promise<PosterResult> {
    let container: AssetContainer | null = null
    let ownCamera: FreeCamera | null = null
    const rtt = this.makeRtt(width, height)
    let handedOff = false
    try {
      const report = validateGLBCached(bytes, sha256)
      if (!report.ok) throw new Error(report.reason)

      container = await LoadAssetContainerAsync(bytes, this.scene, { pluginExtension: '.glb' })
      container.addAllToScene()
      graphics.applyToContainer(container)
      preparePosterMaterials(container)
      const animated = container.animationGroups.some((g) => g.targetedAnimations.length > 0)

      const { min, max, center, radius } = worldBox(container)
      const loaded: AssetContainer = container
      ownCamera = new FreeCamera('poster-cam', Vector3.Zero(), this.scene)
      const setupCamera = (useAuthored: boolean): Camera => {
        const authored = useAuthored ? loaded.cameras[0] : null
        if (authored) {
          authored.computeWorldMatrix()
          const camPos = authored.getWorldMatrix().getTranslation()
          const dist = Vector3.Distance(camPos, center)
          authored.minZ = Math.max(0.0001, Math.min(authored.minZ, (dist - radius) * 0.2))
          authored.maxZ = Math.max(authored.maxZ, dist + radius * 6)
          this.headlight.direction = authored.getDirection(Vector3.Forward())
          return authored
        }
        const facing = dominantFacing(loaded)
        const fov = 0.7
        const dist = frameDistance(min, max, center, facing.scale(-1), fov, width / height, 0.86)
        this.headlight.direction = facing.scale(-1)
        const fallback = ownCamera as FreeCamera
        fallback.position = center.add(facing.scale(dist))
        fallback.setTarget(center)
        fallback.fov = fov
        fallback.minZ = Math.max(0.001, (dist - radius) * 0.2)
        fallback.maxZ = dist + radius * 6
        return fallback
      }
      // CPU frustum vs AABB — not a pixel blank-check. An authored camera
      // that misses the model falls back to auto-fit; we do not read the
      // framebuffer to decide, and we do not retry.
      let useAuthored = loaded.cameras.length > 0
      if (useAuthored) {
        const probe = setupCamera(true)
        if (!cameraFramesBox(probe, min, max)) useAuthored = false
      }
      const cam = setupCamera(useAuthored)
      this.scene.activeCamera = cam
      cam.outputRenderTarget = rtt
      // Textures decode asynchronously (blob URL -> image decode -> GPU
      // upload); three microtask yields were not enough, so the FIRST poster
      // of a texture-bearing post rendered with an unbaked material (blank
      // card) and only a second render of the same bytes worked. One bounded
      // readiness wait — not a readback, not a blank-check retry loop.
      await this.scene.whenReadyAsync()
      this.scene.render()
      await sleep(0)
      this.scene.render()
      await sleep(0)
      this.scene.render()
      cam.outputRenderTarget = null
      detachRtt(this.scene, rtt)
      handedOff = true
      return {
        texture: rtt,
        width,
        height,
        animated,
        footprint: projectFootprint(cam, min, max),
      }
    } finally {
      ownCamera?.dispose()
      if (container) { container.removeAllFromScene(); container.dispose() }
      if (!handedOff) rtt.dispose()
    }
  }

  /**
   * ONE readback, for studio preview / verification probes only. The board
   * never calls this — cards sample the RTT in place.
   */
  async snapshot(rtt: RenderTargetTexture, width: number, height: number): Promise<Uint8Array> {
    if (this.readbackBuf.byteLength < width * height * 4) {
      this.readbackBuf = new Uint8Array(width * height * 4)
    }
    const engine = this.scene.getEngine() as unknown as {
      _gl?: WebGL2RenderingContext
      _dummyFramebuffer?: WebGLFramebuffer | null
      _currentFramebuffer?: WebGLFramebuffer | null
      _readPixelsAsync?: (x: number, y: number, w: number, h: number, f: number, t: number, out: ArrayBufferView) => Promise<ArrayBufferView> | null
      webGLVersion?: number
    }
    const gl = engine._gl
    const internal = rtt.getInternalTexture() as unknown as {
      _hardwareTexture?: { underlyingResource?: WebGLTexture }
    } | null
    const resource = internal?._hardwareTexture?.underlyingResource
    let view: ArrayBufferView | null = null
    if (!gl || !resource || (engine.webGLVersion ?? 1) < 2 || !engine._readPixelsAsync) {
      view = await rtt.readPixels(0, 0, this.readbackBuf, true)
    } else {
      try {
        if (!engine._dummyFramebuffer) engine._dummyFramebuffer = gl.createFramebuffer()
        const previous = engine._currentFramebuffer ?? null
        gl.bindFramebuffer(gl.FRAMEBUFFER, engine._dummyFramebuffer)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, resource, 0)
        view = await engine._readPixelsAsync(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, this.readbackBuf)
        gl.bindFramebuffer(gl.FRAMEBUFFER, previous)
      } catch {
        view = await rtt.readPixels(0, 0, this.readbackBuf, true)
      }
    }
    const src = view
      ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
      : this.readbackBuf.subarray(0, width * height * 4)
    const out = new Uint8Array(src.length)
    out.set(src)
    return out
  }

  dispose(): void { this.scene.dispose() }
}

/** Paint GL bottom-up RGBA into a 2D canvas (top-down), keeping alpha. */
export function drawPosterPixels(
  canvas: HTMLCanvasElement, pixels: Uint8Array, width: number, height: number,
): void {
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const img = ctx.createImageData(width, height)
  const stride = width * 4
  for (let y = 0; y < height; y++) {
    img.data.set(pixels.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride)
  }
  ctx.putImageData(img, 0, 0)
}

function detachRtt(scene: Scene, rtt: RenderTargetTexture): void {
  rtt.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE
  const list = scene.customRenderTargets
  const i = list.indexOf(rtt)
  if (i >= 0) list.splice(i, 1)
}

function preparePosterMaterials(container: AssetContainer): void {
  const prep = (mat: Material): void => {
    mat.backFaceCulling = false
    const mode = mat.transparencyMode
    if (mode != null && mode !== Material.MATERIAL_OPAQUE) return
    mat.alpha = 1
    if (mat instanceof PBRMaterial || mat instanceof StandardMaterial) {
      mat.transparencyMode = Material.MATERIAL_OPAQUE
    }
  }
  for (const m of container.meshes) {
    const mat = m.material
    if (!mat) continue
    const subs = (mat as { subMaterials?: Array<Material | null> }).subMaterials
    if (subs) for (const s of subs) { if (s) prep(s) }
    else prep(mat)
  }
}

/** True when the authored camera's frustum overlaps the model's AABB. */
function cameraFramesBox(cam: Camera, min: Vector3, max: Vector3): boolean {
  cam.computeWorldMatrix()
  // getTransformationMatrix() just multiplies the CACHED view and projection
  // matrices, which are still identity for a freshly-loaded glTF camera that
  // has never rendered. Build the view-projection fresh, then use the
  // standard AABB-vs-frustum test. (A hand-rolled NDC projection flips
  // points that sit behind the camera and would misclassify a camera that
  // frames nothing — model 'f' — as framing the model.)
  const m = cam.getViewMatrix().multiply(cam.getProjectionMatrix())
  return new BoundingBox(min, max).isInFrustum(Frustum.GetPlanes(m))
}

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
