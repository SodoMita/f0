import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera'
import type { Camera } from '@babylonjs/core/Cameras/camera'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import type { AssetContainer } from '@babylonjs/core/assetContainer'
import type { AnimationGroup } from '@babylonjs/core/Animations/animationGroup'
import '@babylonjs/loaders/glTF'
import type { FormEngine } from '../core/engine'
import type { ThreadMeta } from '../protocol/thread-index'
import { toFile } from '../model/poster'
import { validateGLB } from '../model/limits'
import { worldBounds, fitDistance } from '../model/facing'
import { makeCardMaterial, setCardTexture, setCardWhite, setCardFlip } from '../board/cardMaterial'
import { theme } from '../theme'

/**
 * Detail viewer: exactly one interactive model. Uses the model's own cameras
 * when present (switchable), else an orbit camera auto-fit to the model.
 */
export class Viewer {
  readonly scene: Scene
  private orbit: ArcRotateCamera
  private container: AssetContainer | null = null
  private anims: AnimationGroup[] = []
  private active: AnimationGroup | null = null
  private imported: Camera[] = []
  private camIdx = -1 // -1 = orbit/auto
  private counts = { meshes: 0, vertices: 0 }
  private backdrop: Mesh
  private glow: Mesh

  constructor(engine: FormEngine) {
    this.scene = new Scene(engine.engine)
    this.scene.clearColor = Color4.FromHexString('#0b0b0cFF')
    this.orbit = new ArcRotateCamera('viewer-orbit', -Math.PI / 2, Math.PI / 2.2, 6, Vector3.Zero(), this.scene)
    this.orbit.wheelPrecision = 50
    this.orbit.lowerRadiusLimit = 0.1
    this.orbit.upperRadiusLimit = 200
    this.scene.activeCamera = this.orbit

    // Neutral light rig (lights only — the environment-texture IBL path
    // blackened PBR models on this GL driver, so it is deliberately absent).
    const hemi = new HemisphericLight('vl', new Vector3(0, 1, 0), this.scene)
    hemi.intensity = 0.95
    hemi.groundColor = new Color3(0.24, 0.24, 0.27)
    const key = new DirectionalLight('vk', new Vector3(-0.4, -0.6, 0.8), this.scene)
    key.intensity = 1.25
    const fill = new DirectionalLight('vf', new Vector3(0.5, 0.2, -0.6), this.scene)
    fill.intensity = 0.45

    // Gradient backdrop following the camera (softens the black void and
    // gives the model a lit environment to read against).
    this.backdrop = MeshBuilder.CreatePlane('viewer-backdrop', { width: 4, height: 4 }, this.scene)
    this.backdrop.isPickable = false
    this.backdrop.parent = this.orbit
    this.backdrop.position.z = -120
    const bm = makeCardMaterial(this.scene)
    bm.backFaceCulling = false
    this.backdrop.material = bm
    const bt = new DynamicTexture('viewer-bg-tex', { width: 1, height: 64 }, this.scene, false)
    {
      const ctx = bt.getContext() as CanvasRenderingContext2D
      const g = ctx.createLinearGradient(0, 0, 0, 64)
      g.addColorStop(0, '#191921')
      g.addColorStop(0.55, '#0e0e12')
      g.addColorStop(1, '#08080a')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, 1, 64)
      bt.update()
    }
    setCardTexture(bm, bt)
    setCardWhite(bm)
    setCardFlip(bm, false, false)
    this.backdrop.scaling.set(400, 400, 1)

    // Soft ground glow under the model — a spatial reference point.
    this.glow = MeshBuilder.CreatePlane('viewer-glow', { width: 4, height: 4 }, this.scene)
    this.glow.isPickable = false
    this.glow.rotation.x = -Math.PI / 2
    this.glow.setEnabled(false)
    const gm = makeCardMaterial(this.scene)
    gm.backFaceCulling = false
    gm.needAlphaBlending()
    this.glow.material = gm
    const gt = new DynamicTexture('viewer-glow-tex', { width: 128, height: 128 }, this.scene, false)
    {
      const ctx = gt.getContext() as CanvasRenderingContext2D
      ctx.clearRect(0, 0, 128, 128)
      const rg = ctx.createRadialGradient(64, 64, 2, 64, 64, 62)
      rg.addColorStop(0, 'rgba(255,255,255,0.38)')
      rg.addColorStop(0.55, 'rgba(255,255,255,0.14)')
      rg.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = rg
      ctx.fillRect(0, 0, 128, 128)
      gt.update()
    }
    setCardTexture(gm, gt)
    setCardWhite(gm)
    setCardFlip(gm, false, false)
    this.scene.onBeforeRenderObservable.add(() => {
      // keep the backdrop glued to whichever camera is active
      const cam = this.scene.activeCamera
      if (cam && this.backdrop.parent !== cam) {
        this.backdrop.parent = cam
        this.backdrop.position.set(0, 0, -120)
      }
      if (cam) this.backdrop.lookAt(cam.position)
    })
  }

  setBackground(hex: string): void {
    this.scene.clearColor = Color4.FromHexString(hex + 'FF')
  }

  get cameraCount(): number { return this.imported.length }
  get camIndex(): number { return this.camIdx }

  attach(): void {
    if (this.scene.activeCamera === this.orbit) this.orbit.attachControl(true)
  }
  detach(): void { this.orbit.detachControl() }

  async load(blob: Blob, meta: ThreadMeta): Promise<void> {
    this.clear()
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const report = validateGLB(bytes)
      if (!report.ok) throw new Error(report.reason)
      const container = await LoadAssetContainerAsync(toFile(blob, 'model.glb'), this.scene)
      container.addAllToScene()
      for (const m of container.meshes) {
        if (m.material) m.material.backFaceCulling = false
      }
      this.container = container
      this.imported = container.cameras.slice()
      this.anims = container.animationGroups

      let verts = 0
      for (const m of container.meshes) verts += m.getTotalVertices() || 0
      this.counts = { meshes: container.meshes.length, vertices: verts }

      // Camera policy (04 §5): preview-camera index -> first imported -> orbit.
      let idx = -1
      if (meta.previewCamera !== undefined && meta.previewCamera >= 0 && meta.previewCamera < this.imported.length) idx = meta.previewCamera
      else if (this.imported.length > 0) idx = 0
      this.applyCamera(idx)

      if (this.anims.length) {
        const a = meta.previewAnimation ?? 0
        this.active = this.anims[Math.min(a, this.anims.length - 1)]
        this.active.start(true)
      }
    } catch {
      this.clear()
      throw new Error('model failed to load')
    }
  }

  applyCamera(idx: number): void {
    this.camIdx = idx
    if (idx >= 0 && this.imported[idx]) {
      this.orbit.detachControl()
      const cam = this.imported[idx]
      if (cam instanceof FreeCamera) { cam.minZ = 0.001; cam.maxZ = 100000 }
      this.scene.activeCamera = cam
    } else {
      this.camIdx = -1
      this.fitOrbit()
      this.scene.activeCamera = this.orbit
      this.orbit.attachControl(true)
    }
  }

  cycleCamera(): void {
    const n = this.imported.length
    const next = this.camIdx + 1
    this.applyCamera(next >= n ? -1 : next)
  }

  private fitOrbit(): void {
    if (!this.container) return
    const { center, radius } = worldBounds(this.container)
    const dist = fitDistance(radius, this.orbit.fov || 0.8)
    this.orbit.setTarget(center)
    this.orbit.radius = Math.max(0.6, dist)
    this.orbit.lowerRadiusLimit = radius * 0.1
    this.orbit.upperRadiusLimit = radius * 12
    this.orbit.minZ = Math.max(0.001, radius * 0.01)
    this.orbit.maxZ = dist * 8 + radius
    // ground glow under the model
    this.glow.setEnabled(true)
    this.glow.position.set(center.x, center.y - radius * 0.98, center.z)
    this.glow.scaling.set(radius * 2.3, radius * 2.3, 1)
  }

  isPlaying(): boolean { return !!this.active?.isPlaying }

  toggleAnimation(): void {
    if (!this.active && this.anims[0]) this.active = this.anims[0]
    if (!this.active) return
    if (this.active.isPlaying) this.active.pause()
    else this.active.play(true)
  }

  stats(): { meshes: number; vertices: number; animations: number; cameras: number } {
    return { ...this.counts, animations: this.anims.length, cameras: this.imported.length }
  }

  clear(): void {
    this.glow?.setEnabled(false)
    this.active?.stop()
    this.active = null
    this.anims = []
    this.imported = []
    this.camIdx = -1
    if (this.container) { this.container.removeAllFromScene(); this.container.dispose() }
    this.container = null
    this.scene.activeCamera = this.orbit
  }

  dispose(): void { this.clear(); this.scene.dispose() }
}
