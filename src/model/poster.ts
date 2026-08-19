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
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import type { AssetContainer } from '@babylonjs/core/assetContainer'
import './gltf'
import { configureDraco } from './draco'
import { dominantFacing, worldBox, frameDistance } from './facing'
import { validateGLBCached } from './limits'
import { graphics } from '../render/graphics'

import { POSTER_W as DEFAULT_W, POSTER_H as DEFAULT_H } from '../theme'

// Default render size (cards display at roughly 320x200 CSS px; 448x280
// keeps them sharp on HiDPI). A post may declare its own size via the `dim`
// tag — see render(bytes, sha256, width, height).
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
  /** Dedicated transparent RTT — sample this on the card, do not encode a PNG. */
  texture: RenderTargetTexture
  /** Raw RGBA off the GPU, BOTTOM-UP (GL order). Studio / tests / IDB cache. */
  pixels: Uint8Array
  width: number
  height: number
  animated: boolean
  footprint: Footprint | null
  /** True only when both authored and auto-fit cameras drew nothing. */
  blank: boolean
}

/**
 * Local poster pipeline: GLB -> one transparent RTT, rendered by EVERY
 * client from the model (format v4 — no thumb is ever fetched). Renders at
 * the post's declared `dim` size, defaulting to POSTER_W x POSTER_H.
 * A unique RTT per poster is the card texture: no PNG round-trip, so models
 * whose materials take a few frames to compile (or write RGB without alpha)
 * still appear. Uses the model's own camera when one exists and it actually
 * frames the AABB; auto-fit is the fallback.
 */
export class PosterRenderer {
  readonly scene: Scene
  private headlight: DirectionalLight
  /** reused readback buffer (sized up on demand; one alloc per size) */
  private readbackBuf = new Uint8Array(POSTER_W * POSTER_H * 4)
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
    // Transparent background: posters composite over any page/board backdrop.
    rtt.clearColor = new Color4(0, 0, 0, 0)
    // The RTT is the CARD texture. scene.render() for the NEXT poster would
    // otherwise refresh every customRenderTarget in this scene and wipe
    // earlier posters (those models "never appeared" after a later card
    // finished). Render-once + detach after capture keeps the GPU image.
    rtt.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE
    if (this.readbackBuf.byteLength < width * height * 4) {
      this.readbackBuf = new Uint8Array(width * height * 4)
    }
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
      // Display-only: both faces + opaque materials MUST write alpha=1 into
      // a transparent target. Some glTFs leave alpha at 0 on otherwise-opaque
      // unlit/emissive materials — those models vanished because the card
      // shader multiplies by tex.a, and the old isBlank only looked at alpha
      // so they also failed the empty-poster check and never got a texture.
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
      const tryRender = async (cam: Camera): Promise<ArrayBufferView | null> => {
        this.scene.activeCamera = cam
        cam.outputRenderTarget = rtt
        let out: ArrayBufferView | null = null
        for (let attempt = 0; attempt < 14; attempt++) {
          this.scene.render()
          if (attempt < 2) { await sleep(0); continue }
          out = await this.readback(rtt, width, height)
          if (out && !isBlank(out)) break
          await sleep(attempt < 6 ? 30 : 90)
        }
        cam.outputRenderTarget = null
        return out
      }
      // Skip an authored camera that does not even overlap the AABB — that
      // used to burn the whole retry budget on empty frames, then throw
      // "poster rendered empty" so the card stayed a quiet plate forever.
      let useAuthored = loaded.cameras.length > 0
      if (useAuthored) {
        const probe = setupCamera(true)
        if (!cameraFramesBox(probe, min, max)) useAuthored = false
      }
      let cam = setupCamera(useAuthored)
      let pixels = await tryRender(cam)
      if ((!pixels || isBlank(pixels)) && useAuthored) {
        cam = setupCamera(false)
        pixels = await tryRender(cam)
      }
      detachRtt(this.scene, rtt)
      const src = pixels
        ? new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)
        : new Uint8Array(width * height * 4)
      repairAlpha(src)
      const out = new Uint8Array(src.length)
      out.set(src)
      handedOff = true
      return {
        texture: rtt,
        pixels: out,
        width,
        height,
        animated,
        footprint: projectFootprint(cam, min, max),
        blank: isBlank(out),
      }
    } finally {
      ownCamera?.dispose()
      if (container) { container.removeAllFromScene(); container.dispose() }
      if (!handedOff) rtt.dispose()
    }
  }

  /**
   * Read the render target back WITHOUT stalling the main thread.
   *
   * Babylon's `rtt.readPixels()` is a Promise-wrapped *synchronous*
   * `gl.readPixels`, i.e. a full GPU pipeline sync — it was the single
   * biggest main-thread cost of a board load. WebGL2 can read into a
   * PIXEL_PACK_BUFFER and poll a fence instead.
   */
  private async readback(rtt: RenderTargetTexture, width: number, height: number): Promise<ArrayBufferView | null> {
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
    if (!gl || !resource || (engine.webGLVersion ?? 1) < 2 || !engine._readPixelsAsync) {
      return rtt.readPixels(0, 0, this.readbackBuf, true)
    }
    try {
      if (!engine._dummyFramebuffer) engine._dummyFramebuffer = gl.createFramebuffer()
      const previous = engine._currentFramebuffer ?? null
      gl.bindFramebuffer(gl.FRAMEBUFFER, engine._dummyFramebuffer)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, resource, 0)
      const out = await engine._readPixelsAsync(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, this.readbackBuf)
      gl.bindFramebuffer(gl.FRAMEBUFFER, previous)
      return out ?? this.readbackBuf
    } catch {
      return rtt.readPixels(0, 0, this.readbackBuf, true)
    }
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

/** Stop this RTT from being refreshed by later poster.scene.render() calls. */
function detachRtt(scene: Scene, rtt: RenderTargetTexture): void {
  rtt.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE
  const list = scene.customRenderTargets
  const i = list.indexOf(rtt)
  if (i >= 0) list.splice(i, 1)
}

/**
 * Opaque materials must stamp alpha=1 into a transparent target. Some glTFs
 * leave alpha at 0 on otherwise-opaque unlit/emissive materials.
 */
function preparePosterMaterials(container: AssetContainer): void {
  const prep = (mat: Material): void => {
    mat.backFaceCulling = false
    const mode = mat.transparencyMode
    if (mode != null && mode !== Material.MATERIAL_OPAQUE) return
    mat.alpha = 1
    if (mat instanceof PBRMaterial) {
      mat.transparencyMode = Material.MATERIAL_OPAQUE
    } else if (mat instanceof StandardMaterial) {
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

/** True when the camera's NDC box overlaps the screen AND something is in front. */
function cameraFramesBox(cam: Camera, min: Vector3, max: Vector3): boolean {
  cam.computeWorldMatrix()
  const m = cam.getTransformationMatrix()
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity
  let anyInFront = false
  const p = new Vector3()
  for (let i = 0; i < 8; i++) {
    p.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z)
    const q = Vector3.TransformCoordinates(p, m)
    if (!isFinite(q.x) || !isFinite(q.y) || !isFinite(q.z)) continue
    if (q.z >= -0.15 && q.z <= 1.15) anyInFront = true
    uMin = Math.min(uMin, q.x); uMax = Math.max(uMax, q.x)
    vMin = Math.min(vMin, q.y); vMax = Math.max(vMax, q.y)
  }
  if (!anyInFront || !isFinite(uMin)) return false
  return uMax > -1 && uMin < 1 && vMax > -1 && vMin < 1
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

/** Opaque-but-no-alpha writes: stamp 255 where RGB landed and alpha did not. */
function repairAlpha(bytes: Uint8Array): void {
  for (let i = 0; i < bytes.length; i += 4) {
    if (bytes[i + 3] > 4) continue
    if (bytes[i] > 4 || bytes[i + 1] > 4 || bytes[i + 2] > 4) bytes[i + 3] = 255
  }
}

/**
 * Blank = nothing was drawn. Sample densely (every 16th pixel) so thin
 * text/wordmarks are not missed, and treat RGB-only writes as coverage —
 * the old stride-397 alpha-only check declared those posters empty.
 */
export function isBlank(view: ArrayBufferView): boolean {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  if (bytes.length < 4) return true
  const step = 4 * 16
  for (let i = 0; i < bytes.length; i += step) {
    if (bytes[i + 3] > 4) return false
    if (bytes[i] > 4 || bytes[i + 1] > 4 || bytes[i + 2] > 4) return false
  }
  const last = bytes.length - 4
  return !(bytes[last + 3] > 4 || bytes[last] > 4 || bytes[last + 1] > 4 || bytes[last + 2] > 4)
}
