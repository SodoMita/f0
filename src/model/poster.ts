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
import '@babylonjs/loaders/glTF'
import { configureDraco } from './draco'
import { dominantFacing, worldBounds, fitDistance } from './facing'
import { validateGLB } from './limits'

export const POSTER_W = 512
export const POSTER_H = 320

export function toFile(blob: Blob, name: string): File {
  return new File([blob], name, { type: blob.type || 'application/octet-stream' })
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface PosterResult { blob: Blob; animated: boolean }

/**
 * Local thumbnail pipeline (step 4): GLB -> one frame -> 512x320 PNG.
 * A File (not a blob URL) keeps the .glb extension so the glTF plugin loads.
 * Uses the model's own camera when one exists (spec 04 §5), else auto-fit
 * facing the content.
 */
export class PosterRenderer {
  private scene: Scene
  // Renders share one scene (shared activeCamera + env); a promise-chain mutex
  // serializes them so concurrent calls can never stomp each other's camera.
  private chain: Promise<unknown> = Promise.resolve()
  constructor(engine: AbstractEngine) {
    configureDraco()
    this.scene = new Scene(engine)
    this.scene.autoClear = false
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
  }

  render(blob: Blob): Promise<PosterResult> {
    const run = () => this.doRender(blob)
    const result = this.chain.then(run, run)
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }

  private async doRender(blob: Blob): Promise<PosterResult> {
    let container: AssetContainer | null = null
    let ownCamera: FreeCamera | null = null
    const rtt = new RenderTargetTexture('poster-rtt', { width: POSTER_W, height: POSTER_H }, this.scene)
    rtt.renderTargetOptions.generateDepthBuffer = true
    rtt.renderTargetOptions.generateMipMaps = false
    // Transparent background: posters composite over any page/board backdrop.
    rtt.clearColor = new Color4(0.043, 0.043, 0.047, 0)
    try {
      // Enforce GLB limits before Babylon parses (07 §4).
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const report = validateGLB(bytes)
      if (!report.ok) throw new Error(report.reason)

      container = await LoadAssetContainerAsync(toFile(blob, 'model.glb'), this.scene)
      container.addAllToScene()
      // Display-only: render both faces so thin/flat geometry (text, signs)
      // is never invisible from the auto-fit side. The source GLB is untouched.
      for (const m of container.meshes) {
        if (m.material) m.material.backFaceCulling = false
      }
      const animated = container.animationGroups.some((g) => g.targetedAnimations.length > 0)

      // Camera policy: ALWAYS auto-fit for the poster thumbnail. The model's
      // own camera may point anywhere (it is an authored view, not a framing
      // hint), which produced blank posters. The model's cameras belong in
      // the detail viewer (camera dots), not the thumbnail.
      const { center, radius } = worldBounds(container)
      const facing = dominantFacing(container)
      ownCamera = new FreeCamera('poster-cam', center.add(facing.scale(fitDistance(radius, 0.7))), this.scene)
      ownCamera.setTarget(center)
      ownCamera.fov = 0.7
      ownCamera.minZ = Math.max(0.001, radius * 0.01)
      ownCamera.maxZ = fitDistance(radius, 0.7) * 8 + radius
      const cam: Camera = ownCamera
      this.scene.activeCamera = cam
      // Render the scene into the RTT via the SAME path the detail viewer
      // uses (scene.render()): this compiles materials over frames, which the
      // manual rtt.render()/renderList path did not do reliably, leaving
      // every poster blank on this GL driver.
      cam.outputRenderTarget = rtt
      let pixels: ArrayBufferView | null = null
      for (let attempt = 0; attempt < 60; attempt++) {
        this.scene.render()
        pixels = await rtt.readPixels(0, 0, undefined, true)
        if (pixels && !isBlank(pixels, rtt.clearColor)) break
        await sleep(100)
      }
      cam.outputRenderTarget = null
      if (!pixels) throw new Error('readPixels returned null')
      return { blob: await encodePng(pixels, POSTER_W, POSTER_H), animated }
    } finally {
      rtt.dispose()
      ownCamera?.dispose()
      if (container) { container.removeAllFromScene(); container.dispose() }
    }
  }

  dispose(): void { this.scene.dispose() }
}

function isBlank(view: ArrayBufferView, clear: Color4): boolean {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  const r = Math.round(clear.r * 255), g = Math.round(clear.g * 255), b = Math.round(clear.b * 255)
  for (let i = 0; i < bytes.length; i += 4 * 997) {
    if (bytes[i] !== r || bytes[i + 1] !== g || bytes[i + 2] !== b) return false
  }
  return true
}

function encodePng(view: ArrayBufferView, w: number, h: number): Promise<Blob> {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  const canvas = document.createElement('canvas')
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
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png'))
}
