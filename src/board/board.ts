import {
  Scene,
  ArcRotateCamera,
  Vector3,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Texture,
  DynamicTexture,
  Mesh,
  HemisphericLight,
  PointerEventTypes,
} from '@babylonjs/core'
import type { FormEngine } from '../core/engine'
import type { ThreadMeta } from '../protocol/thread-index'
import { theme } from '../theme'

export type CardShape = 'square' | 'wide' | 'tall'

export interface BoardCallbacks {
  onOpenModel: (meta: ThreadMeta) => void
  onOpenThread: (meta: ThreadMeta) => void
  onReply: (meta: ThreadMeta) => void
}

interface CardSlot {
  meta?: ThreadMeta
  mesh: Mesh
  mat: StandardMaterial
  shape: CardShape
  poster: Texture | null
}

/**
 * Card planes. A single shared procedural placeholder texture is used for all
 * unloaded cards (one GPU texture instead of one DynamicTexture per card).
 */
export class Board {
  readonly scene: Scene
  private camera: ArcRotateCamera
  private cards: CardSlot[] = []
  private pool = 24
  private columns = 4
  private cb: BoardCallbacks
  private shuffled: ThreadMeta[] = []
  private placeholder: DynamicTexture

  constructor(engine: FormEngine, cb: BoardCallbacks) {
    this.scene = new Scene(engine.engine)
    this.scene.clearColor = Color3.FromHexString(theme.background).toColor4(1)
    this.scene.skipPointerMovePicking = true
    this.scene.constantlyUpdateMeshUnderPointer = false
    this.camera = new ArcRotateCamera('board-cam', 0, 0, 30, Vector3.Zero(), this.scene)
    this.camera.mode = ArcRotateCamera.ORTHOGRAPHIC_CAMERA
    this.camera.inputs.clear()
    this.scene.activeCamera = this.camera
    new HemisphericLight('l', new Vector3(0, 1, 0), this.scene)

    this.cb = cb
    this.placeholder = this.buildPlaceholder()
    this.resize()
    this.buildPool()
    this.scene.onPointerObservable.add((evt) => {
      if (evt.type !== PointerEventTypes.POINTERTAP) return
      const pick = this.scene.pick(this.scene.pointerX, this.scene.pointerY, (m) => Boolean(m.metadata?.card))
      if (pick?.hit && pick.pickedMesh?.metadata?.card) {
        const slot = pick.pickedMesh.metadata.card as CardSlot
        if (!slot.meta) return
        const localY = pick.getTextureCoordinates()?.y ?? 0.5
        if (localY < 0.18) this.cb.onOpenThread(slot.meta)
        else this.cb.onOpenModel(slot.meta)
      }
    })
  }

  attach(): void {
    this.camera.attachControl(true)
  }

  setMetas(metas: ThreadMeta[]): void {
    this.shuffled = metas
    this.layout()
  }

  shuffle(items: ThreadMeta[]): void {
    const arr = [...items]
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
    this.shuffled = arr
    this.layout()
  }

  private buildPlaceholder(): DynamicTexture {
    const tex = new DynamicTexture('ph', { width: 128, height: 128 }, this.scene, false)
    tex.hasAlpha = false
    tex.wrapU = Texture.CLAMP_ADDRESSMODE
    tex.wrapV = Texture.CLAMP_ADDRESSMODE
    const ctx = tex.getContext() as CanvasRenderingContext2D
    ctx.fillStyle = theme.panel
    ctx.fillRect(0, 0, 128, 128)
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'
    ctx.lineWidth = 1
    for (let x = 0; x <= 128; x += 32) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 128); ctx.stroke()
    }
    for (let y = 0; y <= 128; y += 32) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(128, y); ctx.stroke()
    }
    ctx.fillStyle = theme.accent
    ctx.beginPath()
    ctx.moveTo(64, 48); ctx.lineTo(80, 64); ctx.lineTo(64, 80); ctx.lineTo(48, 64); ctx.closePath()
    ctx.fill()
    tex.update()
    return tex
  }

  private buildPool(): void {
    for (let i = 0; i < this.pool; i += 1) {
      const plane = MeshBuilder.CreatePlane(`card-${i}`, { width: 4, height: 4 }, this.scene)
      plane.setEnabled(false)
      plane.isPickable = false
      const mat = new StandardMaterial(`card-mat-${i}`, this.scene)
      mat.emissiveColor = Color3.FromHexString(theme.panel)
      mat.diffuseColor = Color3.Black()
      mat.specularColor = Color3.Black()
      mat.backFaceCulling = false
      mat.emissiveTexture = this.placeholder
      plane.material = mat
      this.cards.push({ mesh: plane, mat, shape: 'square', poster: null })
      plane.metadata = { card: this.cards[i] }
    }
  }

  setPoster(eventId: string, tex: Texture): void {
    const slot = this.cards.find((c) => c.meta?.eventId === eventId)
    if (!slot) return
    slot.poster?.dispose()
    slot.poster = tex
    slot.mat.emissiveTexture = tex
  }

  private layout(): void {
    const colWidth = 4.4
    const rowHeight = 4.4
    const n = Math.min(this.shuffled.length, this.pool)
    for (let i = 0; i < this.cards.length; i += 1) {
      const slot = this.cards[i]
      if (i >= n) {
        slot.mesh.setEnabled(false)
        slot.mesh.isPickable = false
        continue
      }
      const meta = this.shuffled[i]
      slot.meta = meta
      slot.mesh.setEnabled(true)
      slot.mesh.isPickable = true
      const shape: CardShape = (i + 1) % 9 === 0 ? 'tall' : (i + 1) % 5 === 0 ? 'wide' : 'square'
      slot.shape = shape
      const w = shape === 'wide' ? 8.8 : 4
      const h = shape === 'tall' ? 8.8 : 4
      slot.mesh.scaling.set(w / 4, h / 4, 1)
      const col = i % this.columns
      const row = Math.floor(i / this.columns)
      const x = (col - (this.columns - 1) / 2) * colWidth
      const y = -row * rowHeight
      slot.mesh.position.set(x, y, 0)
      slot.mat.emissiveColor = Color3.FromHexString(meta.tint || theme.panel)
      // Tint the placeholder without a per-card texture.
      if (!slot.poster) slot.mat.emissiveTexture = this.placeholder
    }
  }

  resize(): void {
    const w = this.scene.getEngine().getRenderWidth()
    const aspect = w / this.scene.getEngine().getRenderHeight()
    const halfHeight = 20
    this.camera.orthoTop = halfHeight
    this.camera.orthoBottom = -halfHeight
    this.camera.orthoLeft = -halfHeight * aspect
    this.camera.orthoRight = halfHeight * aspect
    const cols = w < 700 ? 2 : w < 1100 ? 3 : 4
    if (cols !== this.columns) {
      this.columns = cols
      this.layout()
    }
  }

  dispose(): void {
    for (const c of this.cards) c.poster?.dispose()
    this.placeholder.dispose()
    this.scene.dispose()
  }
}
