import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { PointerEventTypes, PointerInfo } from '@babylonjs/core/Events/pointerEvents'
import { KeyboardEventTypes } from '@babylonjs/core/Events/keyboardEvents'
// Side-effect import: scene.pick uses createPickingRay, which throws
// _WarnImport("Ray") unless the Ray module is loaded (spec 00 §3.7).
import '@babylonjs/core/Culling/ray'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import type { FormEngine } from '../core/engine'
import type { ThreadMeta } from '../protocol/thread-index'
import type { AssetCache } from '../core/assets'
import { PreviewPool } from './previewPool'
import { makeCardMaterial, setCardTexture, setCardTint, setCardWhite, setCardFlip } from './cardMaterial'
import type { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial'
import { theme, LIMITS } from '../theme'

export interface BoardCallbacks {
  onOpenModel: (meta: ThreadMeta) => void
  onOpenThread: (meta: ThreadMeta) => void
}

interface CardSlot {
  meta?: ThreadMeta
  mesh: Mesh
  mat: ShaderMaterial
  poster: Texture | null
  live: RenderTargetTexture | null
  // reply badge (Babylon — same space as the cards): "↩ N" pill that opens the thread
  badge: Mesh
  badgeMat: ShaderMaterial
  badgeTex: DynamicTexture
  replyCount: number
}

interface Row {
  meta: ThreadMeta
  slot: CardSlot
  top: number
  col: number
}

// All cards share the poster aspect (512x320 = 16:10) so nothing is stretched.
const CARD_W = 16
const CARD_H = 10
const GAP = 2.4
const MARGIN = 2
const BADGE_W = 3.2
const BADGE_H = 1.1

// Board background: subtle vertical gradient (keeps the scene readable
// without the pitch-black void the first VLM critique flagged).
const BG_TOP = '#22222c'
const BG_BOTTOM = '#141419'

export class Board {
  readonly scene: Scene
  private camera: ArcRotateCamera
  private cards: CardSlot[] = []
  private pool = 24
  private cb: BoardCallbacks
  private rows: Row[] = []
  private previewPool: PreviewPool
  private assets: AssetCache | null = null
  private halfH = 20
  private aspect = 1.6
  private cols = 1
  private pxPerUnit = 20
  private scrollY = 0
  private maxScroll = 0
  private backdrop: Mesh
  private seps: Mesh[] = []
  private sepTops: number[] = []
  // tap vs drag + inertia
  private dragging = false
  private downPointerY = 0
  private downScrollY = 0
  private moved = 0
  private velocity = 0
  private inertia = 0.7

  constructor(engine: FormEngine, cb: BoardCallbacks) {
    const ua = navigator.userAgent
    const isMobile = /Mobi|Android/i.test(ua)

    this.scene = new Scene(engine.engine)
    this.scene.clearColor = Color3.FromHexString(BG_BOTTOM).toColor4(1)
    this.scene.skipPointerMovePicking = true

    // Ortho camera on +Z; card planes lie in the XY plane (front-on).
    this.camera = new ArcRotateCamera('board-cam', Math.PI / 2, Math.PI / 2, 30, Vector3.Zero(), this.scene)
    this.camera.mode = ArcRotateCamera.ORTHOGRAPHIC_CAMERA
    this.camera.inputs.clear()
    this.camera.detachControl()
    this.scene.activeCamera = this.camera
    new HemisphericLight('l', new Vector3(0, 1, 0), this.scene)

    // Gradient backdrop behind the cards.
    this.backdrop = MeshBuilder.CreatePlane('board-bg', { width: 4, height: 4 }, this.scene)
    this.backdrop.isPickable = false
    this.backdrop.position.z = -1
    const bgMat = makeCardMaterial(this.scene)
    bgMat.backFaceCulling = false
    this.backdrop.material = bgMat
    const bgTex = new DynamicTexture('board-bg-tex', { width: 1, height: 64 }, this.scene, false)
    {
      const ctx = bgTex.getContext() as CanvasRenderingContext2D
      const g = ctx.createLinearGradient(0, 0, 0, 64)
      g.addColorStop(0, BG_TOP)
      g.addColorStop(1, BG_BOTTOM)
      ctx.fillStyle = g
      ctx.fillRect(0, 0, 1, 64)
      bgTex.update()
    }
    setCardTexture(bgMat, bgTex)
    setCardWhite(bgMat)
    setCardFlip(bgMat, 'dyn')


    this.cb = cb
    this.previewPool = new PreviewPool(
      engine.engine,
      (postId) => this.assets?.getModelBlobByPostId(postId) ?? Promise.resolve(undefined),
      { maxSlots: isMobile ? 2 : 6, rttWidth: 512, rttHeight: 320, slotsPerFrame: 2 },
    )
    this.previewPool.onLive = (postId, rtt) => {
      const slot = this.cards.find((c) => c.meta?.eventId === postId)
      if (!slot) return
      slot.live = rtt
      setCardTexture(slot.mat, rtt)
      setCardWhite(slot.mat)
      setCardFlip(slot.mat, 'rtt')
    }
    this.scene.onBeforeRenderObservable.add(() => this.tick())

    this.buildPool()
    this.resize()
    this.bindInput()
  }

  setAssets(assets: AssetCache): void {
    this.assets = assets
    for (const slot of this.cards) if (slot.meta) this.drive(slot)
  }

  setMetas(metas: ThreadMeta[]): void {
    this.rows = metas.slice(0, LIMITS.boardRoots).map((meta, i) => ({
      meta,
      slot: this.cards[i],
      top: 0,
      col: 0,
    }))
    this.layout()
  }

  setReplyCount(eventId: string, count: number): void {
    const slot = this.cards.find((c) => c.meta?.eventId === eventId)
    if (!slot) return
    slot.replyCount = count
    this.drawBadge(slot)
  }

  setInertia(v: number): void {
    this.inertia = Math.max(0, Math.min(1, v))
  }

  shuffle(items: ThreadMeta[]): void {
    const arr = [...items]
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
    this.setMetas(arr)
  }

  /** Screen position of row i (CSS px) — used by tests. */
  screenPosOf(i: number): { x: number; y: number } | null {
    const row = this.rows[i]
    if (!row) return null
    const eng = this.scene.getEngine()
    const cssW = eng.getRenderWidth() * eng.getHardwareScalingLevel()
    const cssH = eng.getRenderHeight() * eng.getHardwareScalingLevel()
    const wy = this.worldY(row)
    return { x: cssW / 2 + this.colX(row.col) * this.pxPerUnit, y: ((this.halfH - wy) / (2 * this.halfH)) * cssH }
  }

  private worldY(row: Row): number {
    return this.halfH - MARGIN - (row.top + CARD_H / 2) + this.scrollY
  }

  private colX(col: number): number {
    return (col - (this.cols - 1) / 2) * (CARD_W + GAP)
  }

  private buildPool(): void {
    for (let i = 0; i < this.pool; i++) {
      const mesh = MeshBuilder.CreatePlane(`card-${i}`, { width: 4, height: 4 }, this.scene)
      mesh.setEnabled(false)
      mesh.isPickable = false
      const mat = makeCardMaterial(this.scene)
      mesh.material = mat

      const badge = MeshBuilder.CreatePlane(`badge-${i}`, { width: 4, height: 4 }, this.scene)
      badge.setEnabled(false)
      badge.isPickable = false
      badge.position.z = 0.05
      const badgeMat = makeCardMaterial(this.scene)
      badge.material = badgeMat
      const badgeTex = new DynamicTexture(`badge-tex-${i}`, { width: 128, height: 44 }, this.scene, false)
      badgeTex.hasAlpha = true // pill shape comes from canvas alpha
      setCardTexture(badgeMat, badgeTex)
      setCardWhite(badgeMat)
      setCardFlip(badgeMat, 'dyn')

      const slot: CardSlot = { mesh, mat, poster: null, live: null, badge, badgeMat, badgeTex, replyCount: 0 }
      this.cards.push(slot)
      mesh.metadata = { card: slot }
      badge.metadata = { card: slot, badge: true }
    }
  }

  private drawBadge(slot: CardSlot): void {
    const w = slot.badgeTex.getSize().width
    const h = slot.badgeTex.getSize().height
    const ctx = slot.badgeTex.getContext() as CanvasRenderingContext2D
    ctx.clearRect(0, 0, w, h)
    if (slot.replyCount <= 0) {
      slot.badgeTex.update()
      slot.badge.setEnabled(false)
      return
    }
    // pill
    const r = h / 2 - 1
    ctx.fillStyle = 'rgba(16,16,18,0.55)'
    ctx.strokeStyle = 'rgba(255,255,255,0.42)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(2 + r, 2)
    ctx.lineTo(w - 2 - r, 2)
    ctx.arcTo(w - 2, 2, w - 2, 2 + r, r)
    ctx.lineTo(w - 2, h - 2 - r)
    ctx.arcTo(w - 2, h - 2, w - 2 - r, h - 2, r)
    ctx.lineTo(2 + r, h - 2)
    ctx.arcTo(2, h - 2, 2, h - 2 - r, r)
    ctx.lineTo(2, 2 + r)
    ctx.arcTo(2, 2, 2 + r, 2, r)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = theme.ink
    ctx.font = `bold ${Math.floor(h * 0.52)}px ui-monospace, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(`\u21A9 ${slot.replyCount}`, w / 2, h / 2 + 1)
    slot.badgeTex.update()
    slot.badge.setEnabled(true)
  }

  private layout(): void {
    // Responsive columns: 1 on phones, up to 3 on wide screens. This fills
    // the horizontal dead space the single-column layout left unused.
    const viewW = 2 * this.halfH * this.aspect
    this.cols = Math.max(1, Math.min(3, Math.floor((viewW - MARGIN * 2) / (CARD_W + GAP))))
    let top = 0
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i]
      row.top = top
      row.col = i % this.cols
      if (i % this.cols === this.cols - 1) top += CARD_H + GAP
    }
    if (this.rows.length % this.cols !== 0) top += CARD_H + GAP
    const contentBottom = top - GAP
    const viewportH = 2 * this.halfH - 2 * MARGIN
    this.maxScroll = Math.max(0, contentBottom - viewportH + GAP)
    if (this.scrollY > this.maxScroll) this.scrollY = this.maxScroll

    for (let i = 0; i < this.cards.length; i++) {
      const slot = this.cards[i]
      const row = this.rows[i]
      if (!row) {
        this.release(slot)
        slot.meta = undefined
        slot.mesh.setEnabled(false)
        slot.badge.setEnabled(false)
        slot.mesh.isPickable = false
        continue
      }
      const changed = slot.meta?.eventId !== row.meta.eventId
      if (changed) {
        this.release(slot)
        slot.meta = row.meta
        slot.poster = null
        slot.live = null
        slot.replyCount = 0
        setCardTexture(slot.mat, null)
        setCardTint(slot.mat, row.meta.tint || theme.panel)
        setCardFlip(slot.mat, 'raw')
        this.drawBadge(slot)
      }
      slot.mesh.setEnabled(true)
      slot.mesh.isPickable = true
      slot.mesh.scaling.set(CARD_W / 4, CARD_H / 4, 1)
      slot.mesh.position.set(this.colX(row.col), this.worldY(row), 0)
      this.positionBadge(slot)
      if (changed) this.drive(slot)
    }
    this.buildSeparators()
  }

  private positionBadge(slot: CardSlot): void {
    slot.badge.scaling.set(BADGE_W / 4, BADGE_H / 4, 1)
    slot.badge.position.x = slot.mesh.position.x + CARD_W / 2 - BADGE_W / 2 - 0.4
    slot.badge.position.y = slot.mesh.position.y - CARD_H / 2 + BADGE_H / 2 + 0.4
    slot.badge.position.z = 0.05
    slot.badge.setEnabled(slot.replyCount > 0 && slot.mesh.isEnabled())
  }


  private applyScroll(): void {
    for (let i = 0; i < this.rows.length; i++) {
      const slot = this.rows[i].slot
      slot.mesh.position.x = this.colX(this.rows[i].col)
      slot.mesh.position.y = this.worldY(this.rows[i])
      this.positionBadge(slot)
    }
    for (let i = 0; i < this.seps.length; i++) {
      this.seps[i].position.y = this.halfH - MARGIN - (this.sepTops[i] - GAP / 2) + this.scrollY
    }
  }

  /** Thin horizontal separator lines between rows (no card frames). */
  private buildSeparators(): void {
    for (const l of this.seps) l.dispose()
    this.seps = []
    this.sepTops = []
    const tops = [...new Set(this.rows.map((r) => r.top))].filter((t) => t > 0)
    const gridW = this.cols * CARD_W + (this.cols - 1) * GAP
    for (const top of tops) {
      const line = MeshBuilder.CreateLines(`sep-${top}`, {
        points: [new Vector3(0, 0, -0.02), new Vector3(gridW, 0, -0.02)],
      }, this.scene)
      line.color = Color3.FromHexString('#3d3d4a')
      line.position.x = -gridW / 2
      line.position.y = this.halfH - MARGIN - (top - GAP / 2) + this.scrollY
      this.seps.push(line)
      this.sepTops.push(top)
    }
  }

  private bindInput(): void {
    this.scene.onPointerObservable.add((info: PointerInfo) => {
      switch (info.type) {
        case PointerEventTypes.POINTERDOWN: {
          if ((info.event as PointerEvent).button !== 0) return
          this.dragging = true
          this.downPointerY = this.scene.pointerY
          this.downScrollY = this.scrollY
          this.moved = 0
          this.velocity = 0
          break
        }
        case PointerEventTypes.POINTERMOVE: {
          if (!this.dragging) return
          const dy = this.scene.pointerY - this.downPointerY
          this.moved = Math.max(this.moved, Math.abs(dy))
          this.setScroll(this.downScrollY - dy / this.pxPerUnit)
          this.velocity = -dy / this.pxPerUnit
          break
        }
        case PointerEventTypes.POINTERUP: {
          if (!this.dragging) return
          this.dragging = false
          if (this.inertia === 0) this.velocity = 0
          if (this.moved < 8) this.tapAt(this.scene.pointerX, this.scene.pointerY)
          break
        }
        case PointerEventTypes.POINTERWHEEL: {
          const delta = (info.event as WheelEvent).deltaY || 0
          this.velocity += (delta / this.pxPerUnit) * 0.35
          this.setScroll(this.scrollY + delta / this.pxPerUnit)
          break
        }
      }
    })

    this.scene.onKeyboardObservable.add((kb) => {
      if (kb.type !== KeyboardEventTypes.KEYDOWN) return
      const step = this.halfH * 1.6
      switch (kb.event.key) {
        case 'PageDown': this.setScroll(this.scrollY + step); break
        case 'PageUp': this.setScroll(this.scrollY - step); break
        case 'Home': this.setScroll(0); break
        case 'End': this.setScroll(this.maxScroll); break
      }
    })
  }

  private tick(): void {
    this.previewPool.tick()
    // scroll inertia: momentum decays between inputs
    if (!this.dragging && this.inertia > 0 && Math.abs(this.velocity) > 0.0005) {
      this.setScroll(this.scrollY + this.velocity)
      this.velocity *= 0.96 - 0.10 * this.inertia
      if (Math.abs(this.velocity) < 0.001) this.velocity = 0
    } else if (this.inertia === 0) {
      this.velocity = 0
    }
  }

  private setScroll(v: number): void {
    const next = Math.max(0, Math.min(this.maxScroll, v))
    if (next === this.scrollY) return
    this.scrollY = next
    this.applyScroll()
  }

  private tapAt(x: number, y: number): void {
    const pick = this.scene.pick(x, y, (m) => Boolean(m.metadata?.card))
    if (!pick?.hit || !pick.pickedMesh?.metadata?.card) return
    const meta = pick.pickedMesh.metadata.card
    const slot = meta as CardSlot
    if (!slot.meta) return
    // badge = reply button (opens the thread); card body opens the viewer
    if (pick.pickedMesh.metadata.badge) this.cb.onOpenThread(slot.meta)
    else this.cb.onOpenModel(slot.meta)
  }

  private drive(slot: CardSlot): void {
    const meta = slot.meta
    const assets = this.assets
    if (!meta || !assets) return
    void assets.getPoster(meta).then((tex) => {
      if (slot.meta?.eventId !== meta.eventId || !tex || slot.live) return
      slot.poster = tex
      setCardTexture(slot.mat, tex)
      setCardWhite(slot.mat)
      setCardFlip(slot.mat, 'raw')
      const animated = assets.isAnimated(meta)
      if (animated ?? (meta.animHint || meta.cameraCount > 0)) this.previewPool.request(meta.eventId)
    })
  }

  private release(slot: CardSlot): void {
    if (slot.meta) this.previewPool.release(slot.meta.eventId)
    if (slot.live) {
      slot.live = null
      if (slot.poster) { setCardTexture(slot.mat, slot.poster); setCardWhite(slot.mat); setCardFlip(slot.mat, 'raw') }
      else { setCardTexture(slot.mat, null); setCardTint(slot.mat, slot.meta?.tint || theme.panel); setCardFlip(slot.mat, 'raw') }
    }
  }

  resize(): void {
    const eng = this.scene.getEngine()
    const w = eng.getRenderWidth()
    const h = eng.getRenderHeight()
    this.aspect = w / Math.max(1, h)
    this.halfH = 20
    const cssH = h * eng.getHardwareScalingLevel()
    this.pxPerUnit = cssH / (2 * this.halfH)
    this.camera.orthoTop = this.halfH
    this.camera.orthoBottom = -this.halfH
    this.camera.orthoLeft = -this.halfH * this.aspect
    this.camera.orthoRight = this.halfH * this.aspect
    this.backdrop.scaling.set((this.halfH * this.aspect * 2 + 1) / 4, (this.halfH * 2 + 1) / 4, 1)
    this.backdrop.position.set(0, 0, -1)
    this.layout()
  }

  dispose(): void {
    for (const c of this.cards) this.release(c)
    for (const l of this.seps) l.dispose()
    this.seps = []
    this.previewPool.dispose()
    this.scene.dispose()
  }
}
