import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine'
import { Scene } from '@babylonjs/core/scene'
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import type { Material } from '@babylonjs/core/Materials/material'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import type { AssetContainer } from '@babylonjs/core/assetContainer'
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import '../model/gltf'
import { configureDraco } from '../model/draco'
import { frameDistance } from '../model/facing'
import { validateGLB } from '../model/limits'
import { theme } from '../theme'
import { createPaintShapeMesh } from './paint/shapes'
import type { ShapeKind } from './paint/types'
import type { LibraryItem } from './library/catalog'

const ICON_SIZE = 96
const instances = new WeakMap<AbstractEngine, RuntimeModelIcons>()

/** One renderer per app Engine: still one WebGL context and one visible canvas. */
export function runtimeModelIcons(engine: AbstractEngine): RuntimeModelIcons {
  let renderer = instances.get(engine)
  if (!renderer) {
    renderer = new RuntimeModelIcons(engine)
    instances.set(engine, renderer)
  }
  return renderer
}

/**
 * Runtime model -> icon-texture renderer.
 *
 * A single transparent RTT is created for each queued thumbnail, rendered by
 * calling iconScene.render() with camera.outputRenderTarget (the same safe
 * path as posters), read once, then disposed. DOM buttons receive the PNG
 * snapshot of that texture; no hand-authored SVG/glyph can disagree with the
 * mesh the button places. Jobs are serialized because they share one scene.
 */
export class RuntimeModelIcons {
  private readonly scene: Scene
  private readonly camera: FreeCamera
  private readonly urls = new Map<string, Promise<string>>()
  private chain: Promise<unknown> = Promise.resolve()

  constructor(engine: AbstractEngine) {
    configureDraco()
    this.scene = new Scene(engine)
    this.scene.autoClear = true
    this.scene.autoClearDepthAndStencil = true
    this.scene.clearColor = new Color4(0, 0, 0, 0)
    this.camera = new FreeCamera('model-icon-camera', new Vector3(0, 0, 3), this.scene)
    this.camera.fov = 0.62
    this.camera.minZ = 0.001
    this.camera.maxZ = 100
    this.scene.activeCamera = this.camera

    const hemi = new HemisphericLight('model-icon-hemi', new Vector3(0, 1, 0), this.scene)
    hemi.intensity = 1.05
    hemi.groundColor = new Color3(0.14, 0.14, 0.16)
    const key = new DirectionalLight('model-icon-key', new Vector3(-0.5, -0.8, -0.65), this.scene)
    key.intensity = 1.1
    const fill = new DirectionalLight('model-icon-fill', new Vector3(0.7, 0.15, 0.4), this.scene)
    fill.intensity = 0.45
  }

  paint(shape: ShapeKind): Promise<string> {
    return this.cached(`paint/${shape}`, () => this.renderPaint(shape))
  }

  library(item: LibraryItem, bytes: Uint8Array): Promise<string> {
    return this.cached(`library/${item.dim}/${item.id}`, () => this.renderLibrary(item, bytes))
  }

  private cached(key: string, make: () => Promise<string>): Promise<string> {
    const hit = this.urls.get(key)
    if (hit) return hit
    const run = () => make()
    const result = this.chain.then(run, run)
    this.chain = result.then(() => undefined, () => undefined)
    this.urls.set(key, result)
    // A transient context/load failure should be retryable the next time the
    // tab is shown; successful object URLs stay cached for the session.
    void result.catch(() => { if (this.urls.get(key) === result) this.urls.delete(key) })
    return result
  }

  private async renderPaint(shape: ShapeKind): Promise<string> {
    const mesh = createPaintShapeMesh(shape, this.scene)
    const material = new StandardMaterial(`model-icon-paint-${shape}`, this.scene)
    const color = Color3.FromHexString(theme.accent)
    material.diffuseColor = color
    material.emissiveColor = color.scale(0.24)
    material.specularColor = new Color3(0.18, 0.18, 0.18)
    material.backFaceCulling = false
    mesh.material = material
    mesh.isPickable = false
    try {
      return await this.capture([mesh], shape === 'quad' || shape === 'triangle')
    } finally {
      mesh.dispose(false, true)
    }
  }

  private async renderLibrary(item: LibraryItem, bytes: Uint8Array): Promise<string> {
    const report = validateGLB(bytes)
    if (!report.ok) throw new Error(report.reason)
    let container: AssetContainer | null = null
    try {
      container = await LoadAssetContainerAsync(bytes, this.scene, { pluginExtension: '.glb' })
      for (const light of container.lights) light.setEnabled(false)
      for (const group of container.animationGroups) group.stop()
      container.addAllToScene()
      prepareMaterials(container.meshes)
      const meshes = container.meshes.filter((mesh) => mesh.getTotalVertices() > 0)
      if (!meshes.length) throw new Error(`icon model has no mesh: ${item.id}`)
      return await this.capture(meshes, item.dim === '2d')
    } finally {
      if (container) {
        container.removeAllFromScene()
        container.dispose()
      }
    }
  }

  private async capture(meshes: AbstractMesh[], flat: boolean): Promise<string> {
    const bounds = meshBounds(meshes)
    const cameraSide = flat
      ? new Vector3(0, 0, 1)
      : new Vector3(1, 0.78, 1).normalize()
    const viewDirection = cameraSide.scale(-1)
    const distance = frameDistance(
      bounds.min, bounds.max, bounds.center, viewDirection,
      this.camera.fov, 1, flat ? 0.72 : 0.68,
    )
    this.camera.position.copyFrom(bounds.center.add(cameraSide.scale(Math.max(0.01, distance))))
    this.camera.setTarget(bounds.center)
    this.camera.minZ = Math.max(0.0001, (distance - bounds.radius) * 0.1)
    this.camera.maxZ = Math.max(10, distance + bounds.radius * 8)

    // Compile before the one-shot RTT starts. Otherwise the first icon in a
    // fresh session is just the clear colour: the shader becomes ready only
    // after that one-shot target has already consumed its refresh.
    await Promise.all(meshes.map((mesh) => mesh.material?.forceCompilationAsync(mesh)))

    const rtt = new RenderTargetTexture('model-icon-rtt', { width: ICON_SIZE, height: ICON_SIZE }, this.scene)
    rtt.renderTargetOptions.generateDepthBuffer = true
    rtt.renderTargetOptions.generateMipMaps = false
    rtt.samples = 1
    rtt.wrapU = Texture.CLAMP_ADDRESSMODE
    rtt.wrapV = Texture.CLAMP_ADDRESSMODE
    rtt.hasAlpha = true
    rtt.clearColor = new Color4(0, 0, 0, 0)
    rtt.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE
    this.camera.outputRenderTarget = rtt
    try {
      // The first draw starts shader compilation. Yielding a task between
      // draws matters on real WebGL drivers: two synchronous render() calls
      // left the very first (cube) thumbnail transparent while its material
      // was still compiling.
      this.scene.render()
      await sleepFrame()
      this.scene.render()
      await sleepFrame()
      this.scene.render()
      const view = await rtt.readPixels(0, 0, undefined, true)
      if (!view) throw new Error('model icon texture readback failed')
      const pixels = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
      return await pixelsToObjectUrl(pixels, ICON_SIZE, ICON_SIZE)
    } finally {
      this.camera.outputRenderTarget = null
      const i = this.scene.customRenderTargets.indexOf(rtt)
      if (i >= 0) this.scene.customRenderTargets.splice(i, 1)
      rtt.dispose()
    }
  }
}

function meshBounds(meshes: AbstractMesh[]): { min: Vector3; max: Vector3; center: Vector3; radius: number } {
  const min = new Vector3(Infinity, Infinity, Infinity)
  const max = new Vector3(-Infinity, -Infinity, -Infinity)
  for (const mesh of meshes) {
    mesh.computeWorldMatrix(true)
    const box = mesh.getBoundingInfo().boundingBox
    min.minimizeInPlace(box.minimumWorld)
    max.maximizeInPlace(box.maximumWorld)
  }
  const center = min.add(max).scaleInPlace(0.5)
  return { min, max, center, radius: Math.max(0.001, Vector3.Distance(min, max) * 0.5) }
}

function prepareMaterials(meshes: AbstractMesh[]): void {
  const seen = new Set<Material>()
  const prep = (material: Material): void => {
    if (seen.has(material)) return
    seen.add(material)
    material.backFaceCulling = false
    if (material instanceof PBRMaterial) {
      material.metallic = 0
      material.roughness = 0.72
    }
  }
  for (const mesh of meshes) {
    mesh.useVertexColors = true
    mesh.hasVertexAlpha = false
    const material = mesh.material
    if (!material) continue
    const subs = (material as Material & { subMaterials?: Array<Material | null> }).subMaterials
    if (subs) for (const sub of subs) { if (sub) prep(sub) }
    else prep(material)
  }
}

function sleepFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function pixelsToObjectUrl(pixels: Uint8Array, width: number, height: number): Promise<string> {
  const rgba = new Uint8ClampedArray(pixels.length)
  const row = width * 4
  for (let y = 0; y < height; y++) {
    rgba.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row)
  }

  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('model icon canvas unavailable')
    context.putImageData(new ImageData(rgba, width, height), 0, 0)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return URL.createObjectURL(blob)
  }

  // Safari fallback. This canvas is never attached and owns no WebGL context;
  // the visible icon still comes from Babylon's RTT above.
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('model icon canvas unavailable')
  context.putImageData(new ImageData(rgba, width, height), 0, 0)
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error('model icon encode failed')), 'image/png')
  })
  return URL.createObjectURL(blob)
}
