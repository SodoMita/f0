import { Scene } from '@babylonjs/core/scene'
import type { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { PointerEventTypes, PointerInfo } from '@babylonjs/core/Events/pointerEvents'
import { KeyboardEventTypes } from '@babylonjs/core/Events/keyboardEvents'
// Side-effect import: scene.pick uses createPickingRay, which throws
// _WarnImport("Ray") unless the Ray module is loaded (spec 00 §3.7).
import '@babylonjs/core/Culling/ray'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import type { LinesMesh } from '@babylonjs/core/Meshes/linesMesh'
import type { FormEngine } from '../core/engine'
import type { ThreadMeta } from '../protocol/thread-index'
import type { AssetCache } from '../core/assets'
import { PreviewPool } from './previewPool'
import {
  makeCardMaterial, setCardTexture, setCardTint, setCardWhite, setCardFlip, setCardOpacity,
} from './cardMaterial'
import type { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial'
import {
  flatCamera, makeBackdropTexture, paintBackdrop, makeContactShadow, makeSpinnerTexture,
  roundRect, luminance, shade,
} from '../core/gfx'
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
  /** poster already requested for the CURRENT meta (avoids re-queueing) */
  requested: boolean
  /** the row this recycled slot currently shows */
  row: Row | null
  /** poster unavailable (too big / render failed) — no ring, quiet plate */
  failed: boolean
  /** when the loading ring started (rings are not allowed to spin forever) */
  spinSince: number
  // soft elliptical contact shadow under the model (models float on the
  // backdrop now that cards are transparent — the shadow gives them ground).
  // Placed from the poster's measured footprint, not guessed.
  shadow: Mesh
  shadowMat: ShaderMaterial
  footprint: { cx: number; bottom: number; w: number } | null
  // spinning ring shown until the poster (or live preview) arrives
  spinner: Mesh
  spinnerMat: ShaderMaterial
  // reply badge (Babylon — same space as the cards): "↩ N" pill -> thread
  badge: Mesh
  badgeMat: ShaderMaterial
  badgeTex: DynamicTexture
  replyCount: number
  /** last count painted into badgeTex (avoids needless canvas + upload) */
  badgeDrawn: number
}

interface Row {
  meta: ThreadMeta
  top: number
  col: number
  visible: boolean
}

// All cards share the poster aspect (512x320 = 16:10) so nothing is stretched.
const CARD_W = 16
const CARD_H = 10
const GAP_X = 3.0
const GAP_Y = 3.4
const MARGIN = 2.4
const SPIN_STEP_MS = 85
// How long the board must sit still before it starts fetching/rendering
// posters for what is now on screen.
const SCROLL_SETTLE_MS = 150
// A ring that never stops also means the board can never stop drawing.
const SPIN_MAX_MS = 25_000
const BADGE_W = 3.4
const BADGE_H = 1.25

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
  private backdropTex: DynamicTexture
  private shadowTex: DynamicTexture
  private spinnerTex: DynamicTexture
  private seps: LinesMesh[] = []
  private sepTops: number[] = []
  private background: string = theme.background
  private isDark = true
  // tap vs drag + inertia
  private dragging = false
  private downPointerY = 0
  private downScrollY = 0
  private moved = 0
  private velocity = 0
  private inertia = 0.7
  private activePointers = new Set<number>()
  private form: FormEngine
  private visiblePosts = new Set<string>()
  private lastSyncScroll = Number.NEGATIVE_INFINITY
  private lastScrollAt = 0
  private pendingSettle = false
  /** reply counts survive slot recycling */
  private replyCounts = new Map<string, number>()
  private spinStep = -1
  private rowIds = ''

  constructor(engine: FormEngine, cb: BoardCallbacks) {
    const isMobile = /Mobi|Android/i.test(navigator.userAgent)

    this.form = engine
    this.scene = new Scene(engine.engine)
    this.scene.clearColor = Color3.FromHexString(this.background).toColor4(1)
    this.scene.skipPointerMovePicking = true
    // nothing here casts shadows / needs collision or offline caching
    this.scene.blockMaterialDirtyMechanism = true

    // Ortho camera parked at -Z (see core/gfx.flatCamera): world +X is screen
    // right and card planes are seen from the front, so nothing is mirrored.
    this.camera = flatCamera(this.scene, 'board-cam', 30)
    new HemisphericLight('l', new Vector3(0, 1, 0), this.scene)

    // Gradient backdrop behind the cards (opaque -> renders in the opaque
    // pass, so the alpha-blended cards always composite on top of it).
    this.backdrop = MeshBuilder.CreatePlane('board-bg', { width: 4, height: 4 }, this.scene)
    this.backdrop.isPickable = false
    this.backdrop.position.z = 2
    const bgMat = makeCardMaterial(this.scene, false)
    this.backdrop.material = bgMat
    this.backdropTex = makeBackdropTexture(this.scene, 'board-bg-tex', this.background)
    setCardTexture(bgMat, this.backdropTex)
    setCardWhite(bgMat)
    setCardFlip(bgMat, 'dyn')

    this.shadowTex = makeContactShadow(this.scene, 'card-shadow-tex')
    this.spinnerTex = makeSpinnerTexture(this.scene, 'card-spinner-tex')

    this.cb = cb
    this.previewPool = new PreviewPool(
      engine.engine,
      (postId) => this.assets?.getModelBytesByPostId(postId) ?? Promise.resolve(undefined),
      {
        maxSlots: isMobile ? 2 : 5,
        rttWidth: isMobile ? 384 : 448,
        rttHeight: isMobile ? 240 : 280,
        slotsPerFrame: isMobile ? 1 : 2,
        targetFps: isMobile ? 12 : 15,
      },
    )
    this.previewPool.onLive = (postId, rtt) => {
      const slot = this.cards.find((c) => c.meta?.eventId === postId)
      if (!slot) return
      slot.live = rtt
      slot.spinner.setEnabled(false)
      this.invalidate()
      setCardTexture(slot.mat, rtt)
      setCardWhite(slot.mat)
      setCardOpacity(slot.mat, 1)
      setCardFlip(slot.mat, 'rtt')
    }
    this.scene.onBeforeRenderObservable.add(() => this.tick())

    this.buildPool()
    this.resize()
    this.bindInput()

    // PERF (merged with kestrel/perf): the engine renders on demand, so the
    // board must declare when it is genuinely animating. This probe is
    // deliberately narrower than "has a live slot or a spinner": it reports
    // motion only while a ring step or a preview refresh is actually DUE,
    // which keeps a board with one 20 fps live card off the 30 fps path.
    engine.addAnimationSource(() => engine.activeScene === this.scene && this.isAnimating())
  }

  /**
   * Does the board still need frames? (render-on-demand — see core/engine.ts)
   * True while it is being dragged, while momentum runs, while any loading
   * ring spins, or while a live preview is animating on a VISIBLE card.
   */
  isAnimating(): boolean {
    if (this.dragging || Math.abs(this.velocity) > 0.0005) return true
    if (this.pendingSettle) return true   // waiting to start deferred loads
    // Loading rings advance in 12 discrete steps; only ask for a frame when
    // the next step is actually due (a spinning ring is not a reason to draw
    // the whole board 60x a second).
    const step = Math.floor(performance.now() / SPIN_STEP_MS)
    if (step !== this.spinStep) {
      for (const slot of this.cards) {
        if (slot.spinner.isEnabled() && slot.mesh.isEnabled()) { this.spinStep = step; return true }
      }
    }
    // A live card only needs a board redraw when its render target is due for
    // a refresh — otherwise the whole board redrew 60x/s to show a 20 fps
    // preview.
    return this.previewPool.hasWork(this.visiblePosts)
  }

  private invalidate(_frames = 2): void { this.form.kick() }

  /** Background colour follows the settings panel (viewer/thread/board). */
  setBackground(hex: string): void {
    this.background = hex
    this.isDark = luminance(hex) < 0.5
    this.scene.clearColor = Color4.FromHexString(hex + 'FF')
    paintBackdrop(this.backdropTex, hex)
    for (const slot of this.cards) {
      setCardTint(slot.shadowMat, this.isDark ? '#000000' : '#1b1b22')
      setCardOpacity(slot.shadowMat, this.isDark ? 0.55 : 0.22)
      setCardTint(slot.spinnerMat, this.isDark ? theme.ink : '#3a3a44')
      setCardOpacity(slot.spinnerMat, this.isDark ? 0.75 : 0.8)
      this.drawBadge(slot)
    }
    const sepColor = Color3.FromHexString(shade(hex, this.isDark ? 0.16 : -0.16))
    for (const s of this.seps) s.color = sepColor
    this.invalidate(3)
  }

  setAssets(assets: AssetCache): void {
    this.assets = assets
    for (const slot of this.cards) if (slot.meta) this.drive(slot)
  }

  setMetas(metas: ThreadMeta[]): void {
    // Live relays stream replies constantly; a reply does not change the root
    // list, and re-laying out the whole board per event was pure churn.
    const ids = metas.slice(0, LIMITS.boardRoots).map((m) => m.eventId).join(',')
    if (ids === this.rowIds) return
    this.rowIds = ids
    this.rows = metas.slice(0, LIMITS.boardRoots).map((meta) => ({
      meta,
      top: 0,
      col: 0,
      visible: false,
    }))
    this.layout()
  }

  setReplyCount(eventId: string, count: number): void {
    this.replyCounts.set(eventId, count)
    const slot = this.cards.find((c) => c.meta?.eventId === eventId)
    // Redrawing a badge means a canvas repaint + a texture upload; skip it
    // when nothing changed (this used to run for every root on every event).
    if (!slot || slot.replyCount === count) return
    slot.replyCount = count
    this.drawBadge(slot)
    this.invalidate()
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
    return (col - (this.cols - 1) / 2) * (CARD_W + GAP_X)
  }

  private buildPool(): void {
    for (let i = 0; i < this.pool; i++) {
      // contact shadow (behind the card plane, still visible through it)
      const shadow = MeshBuilder.CreatePlane(`shadow-${i}`, { width: 4, height: 4 }, this.scene)
      shadow.setEnabled(false)
      shadow.isPickable = false
      shadow.position.z = 0.5
      const shadowMat = makeCardMaterial(this.scene)
      shadow.material = shadowMat
      setCardTexture(shadowMat, this.shadowTex)
      setCardTint(shadowMat, '#000000')
      setCardOpacity(shadowMat, 0.55)
      setCardFlip(shadowMat, 'dyn')

      const mesh = MeshBuilder.CreatePlane(`card-${i}`, { width: 4, height: 4 }, this.scene)
      mesh.setEnabled(false)
      mesh.isPickable = false
      mesh.position.z = 0
      const mat = makeCardMaterial(this.scene)
      mesh.material = mat

      const spinner = MeshBuilder.CreatePlane(`spinner-${i}`, { width: 4, height: 4 }, this.scene)
      spinner.setEnabled(false)
      spinner.isPickable = false
      spinner.position.z = -0.02
      const spinnerMat = makeCardMaterial(this.scene)
      spinner.material = spinnerMat
      setCardTexture(spinnerMat, this.spinnerTex)
      setCardTint(spinnerMat, theme.ink)
      setCardOpacity(spinnerMat, 0.75)
      setCardFlip(spinnerMat, 'dyn')

      const badge = MeshBuilder.CreatePlane(`badge-${i}`, { width: 4, height: 4 }, this.scene)
      badge.setEnabled(false)
      badge.isPickable = false
      badge.position.z = -0.05
      const badgeMat = makeCardMaterial(this.scene)
      badge.material = badgeMat
      // No mipmaps: a badge is drawn at ~1:1 and every repaint would
      // otherwise re-upload AND regenerate the whole mip chain.
      const badgeTex = new DynamicTexture(`badge-tex-${i}`, { width: 320, height: 118 }, this.scene, false, Texture.BILINEAR_SAMPLINGMODE)
      badgeTex.hasAlpha = true // pill shape comes from canvas alpha
      setCardTexture(badgeMat, badgeTex)
      setCardWhite(badgeMat)
      setCardFlip(badgeMat, 'dyn')

      const slot: CardSlot = {
        mesh, mat, poster: null, live: null, requested: false, row: null, failed: false, spinSince: 0,
        shadow, shadowMat, spinner, spinnerMat,
        badge, badgeMat, badgeTex, replyCount: 0, badgeDrawn: -1, footprint: null,
      }
      this.cards.push(slot)
      mesh.metadata = { card: slot }
      badge.metadata = { card: slot, badge: true }
    }
  }

  /**
   * Reply badge. The arrow is drawn as vector strokes, never a font glyph:
   * "↩" is missing from most default UI fonts, so the old badge fell back to
   * a blurry substitute glyph (or a tofu box) at a different baseline.
   */
  private drawBadge(slot: CardSlot): void {
    if (slot.badgeDrawn === slot.replyCount) return
    slot.badgeDrawn = slot.replyCount
    const { width: w, height: h } = slot.badgeTex.getSize()
    const ctx = slot.badgeTex.getContext() as CanvasRenderingContext2D
    ctx.clearRect(0, 0, w, h)
    if (slot.replyCount <= 0) {
      slot.badgeTex.update()
      slot.badge.setEnabled(false)
      return
    }
    const dark = this.isDark
    const pad = Math.round(h * 0.07)
    const bw = w - pad * 2
    const bh = h - pad * 2
    ctx.fillStyle = dark ? 'rgba(12,12,14,0.62)' : 'rgba(250,250,252,0.72)'
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.30)' : 'rgba(0,0,0,0.28)'
    ctx.lineWidth = Math.max(2, h * 0.028)
    roundRect(ctx, pad, pad, bw, bh, bh / 2)
    ctx.fill()
    ctx.stroke()

    const ink = dark ? theme.ink : '#101014'
    // ↩ arrow, vector-drawn
    const cy = h / 2
    const ax = pad + bh * 0.52
    const s = bh * 0.30
    ctx.strokeStyle = ink
    ctx.lineWidth = Math.max(2.5, h * 0.045)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(ax + s, cy - s * 0.85)
    ctx.lineTo(ax + s * 0.15, cy - s * 0.85)
    ctx.quadraticCurveTo(ax - s * 0.75, cy - s * 0.85, ax - s * 0.75, cy + s * 0.05)
    ctx.lineTo(ax - s * 0.75, cy + s * 0.5)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(ax - s * 0.75 - s * 0.5, cy + s * 0.05)
    ctx.lineTo(ax - s * 0.75, cy + s * 0.6)
    ctx.lineTo(ax - s * 0.75 + s * 0.5, cy + s * 0.05)
    ctx.stroke()

    ctx.fillStyle = ink
    ctx.font = `600 ${Math.round(h * 0.42)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(slot.replyCount), ax + s * 1.7, cy + h * 0.015)
    slot.badgeTex.update()
    slot.badge.setEnabled(true)
    this.invalidate()
  }

  private layout(): void {
    // Responsive columns: 1 on phones, up to 3 on wide screens.
    const viewW = 2 * this.halfH * this.aspect
    this.cols = Math.max(1, Math.min(3, Math.floor((viewW - MARGIN * 2) / (CARD_W + GAP_X))))
    let top = 0
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i]
      row.top = top
      row.col = i % this.cols
      if (i % this.cols === this.cols - 1) top += CARD_H + GAP_Y
    }
    if (this.rows.length % this.cols !== 0) top += CARD_H + GAP_Y
    const contentBottom = top - GAP_Y
    const viewportH = 2 * this.halfH - 2 * MARGIN
    this.maxScroll = Math.max(0, contentBottom - viewportH + GAP_Y)
    if (this.scrollY > this.maxScroll) this.scrollY = this.maxScroll

    this.buildSeparators()
    this.syncSlots(true)
    this.invalidate(3)
  }

  /**
   * VIRTUALISED CARDS. The feed holds up to `LIMITS.boardRoots` posts, but the
   * scene only ever owns `pool` card slots, recycled to whichever rows are
   * nearest the viewport.
   *
   * This was also a correctness bug: slots were bound by index
   * (`rows[i] -> cards[i]`), so with more roots than slots every row past the
   * 24th was never drawn — you scrolled into empty space.
   */
  private syncSlots(force = false): void {
    if (!force && Math.abs(this.scrollY - this.lastSyncScroll) < CARD_H * 0.34) {
      this.positionBoundSlots()
      return
    }
    this.lastSyncScroll = this.scrollY

    // rows worth keeping resident, nearest to the viewport first
    const keepWindow = this.halfH + CARD_H * 2.2
    const wanted = new Map<string, Row>()
    const candidates: { row: Row; d: number }[] = []
    for (const row of this.rows) {
      const d = Math.abs(this.worldY(row))
      if (d < keepWindow) candidates.push({ row, d })
    }
    candidates.sort((a, b) => a.d - b.d)
    for (const c of candidates.slice(0, this.cards.length)) wanted.set(c.row.meta.eventId, c.row)

    // 1. free slots whose row left the window
    for (const slot of this.cards) {
      const id = slot.meta?.eventId
      if (id && wanted.has(id)) { slot.row = wanted.get(id)!; continue }
      if (slot.meta) this.release(slot)
      slot.meta = undefined
      slot.row = null
      slot.mesh.setEnabled(false)
      slot.mesh.isPickable = false
      slot.badge.setEnabled(false)
      slot.shadow.setEnabled(false)
      slot.spinner.setEnabled(false)
    }
    // 2. bind free slots to rows that still need one
    const bound = new Set<string>()
    for (const slot of this.cards) if (slot.meta) bound.add(slot.meta.eventId)
    let cursor = 0
    for (const row of wanted.values()) {
      if (bound.has(row.meta.eventId)) continue
      while (cursor < this.cards.length && this.cards[cursor].meta) cursor++
      if (cursor >= this.cards.length) break
      this.bind(this.cards[cursor++], row)
    }
    this.positionBoundSlots()
    this.refreshVisibility()
  }

  /** Attach a recycled slot to a row. INSTANT when the poster is still in
   * RAM: a scrolled-back card re-shows its texture in the same frame
   * (enable/disable semantics, like any game engine) instead of resetting to
   * a placeholder and re-queueing an async poster job — that reset was the
   * "posts take half a second to reappear" bug. */
  private bind(slot: CardSlot, row: Row): void {
    slot.meta = row.meta
    slot.row = row
    slot.live = null
    slot.requested = false
    // the badge texture only encodes a number, so a recycled slot can keep
    // whatever is already painted if the count matches
    slot.replyCount = this.replyCounts.get(row.meta.eventId) ?? 0
    slot.failed = false
    slot.spinSince = 0
    // the ring is switched on by refreshVisibility, and ONLY for slots inside
    // the prefetch window — a resident-but-offscreen card that keeps spinning
    // also keeps the whole board rendering
    slot.spinner.setEnabled(false)
    slot.mesh.setEnabled(true)
    slot.mesh.isPickable = true
    slot.mesh.scaling.set(CARD_W / 4, CARD_H / 4, 1)

    // Fast path: poster texture still on the GPU -> rebind synchronously.
    const cached = this.assets?.peekPoster(row.meta)
    if (cached) {
      slot.poster = cached
      slot.requested = true // nothing to download; skip the drive() round trip
      setCardTexture(slot.mat, cached)
      setCardWhite(slot.mat)
      setCardOpacity(slot.mat, 1)
      setCardFlip(slot.mat, 'raw')
      slot.footprint = this.assets?.getFootprint(row.meta) ?? null
      slot.shadow.setEnabled(!!slot.footprint)
    } else {
      slot.poster = null
      slot.footprint = null
      // Placeholder: a barely-there plate, not an opaque slab.
      setCardTexture(slot.mat, null)
      setCardTint(slot.mat, row.meta.tint || theme.panel)
      setCardOpacity(slot.mat, 0.14)
      setCardFlip(slot.mat, 'raw')
      slot.shadow.setEnabled(false)
    }
    this.drawBadge(slot)
  }

  private positionBoundSlots(): void {
    for (const slot of this.cards) {
      const row = slot.row
      if (!slot.meta || !row) continue
      slot.mesh.position.set(this.colX(row.col), this.worldY(row), 0)
      this.positionExtras(slot)
    }
  }

  /**
   * Work only on what the user can see: posters are rendered (and live
   * previews requested) for rows inside a one-screen prefetch window, and
   * previews for rows that scrolled away are released. A 48-post board used
   * to queue 48 downloads + 48 offscreen renders at boot and animate them all
   * forever.
   */
  private refreshVisibility(): void {
    this.visiblePosts.clear()
    const near = this.halfH + CARD_H * 1.6
    // Don't start downloads/renders for cards that are flying past: a fling
    // through 48 posts would otherwise queue ~40 GLB parses and offscreen
    // renders, and each one blocks a frame. Loads start once scrolling rests.
    const now = performance.now()
    const settled = this.isSettled(now)
    // NB both directions: leaving this latched at true kept isAnimating()
    // true forever, i.e. the board never stopped drawing after a scroll.
    this.pendingSettle = !settled
    // stop chewing on GLBs while the feed is moving
    this.assets?.setPaused(!settled)
    for (const slot of this.cards) {
      const row = slot.row
      if (!slot.meta || !row) continue
      const y = this.worldY(row)
      const onScreen = Math.abs(y) < this.halfH + CARD_H * 0.6
      row.visible = onScreen
      if (onScreen) this.visiblePosts.add(row.meta.eventId)

      // loading ring: only inside the prefetch window, only while there is
      // genuinely something to wait for, and never for longer than SPIN_MAX_MS
      const inRange = Math.abs(y) < near
      let ring = inRange && !slot.poster && !slot.live && !slot.failed
      if (ring) {
        if (!slot.spinner.isEnabled() && slot.spinSince === 0) slot.spinSince = now
        if (slot.spinSince && now - slot.spinSince > SPIN_MAX_MS) ring = false
      } else {
        slot.spinSince = 0
      }
      if (slot.spinner.isEnabled() !== ring) { slot.spinner.setEnabled(ring); this.invalidate(2) }

      if (settled && inRange) {
        if (!slot.requested) { slot.requested = true; this.drive(slot) }
        if (slot.poster && !slot.live) {
          const animated = this.assets?.isAnimated(row.meta)
          if (animated ?? (row.meta.animHint || row.meta.cameraCount > 0)) {
            this.previewPool.request(row.meta.eventId)
          }
        }
      } else if (slot.live && Math.abs(y) >= near) {
        this.previewPool.release(row.meta.eventId)
        slot.live = null
        if (slot.poster) {
          setCardTexture(slot.mat, slot.poster); setCardWhite(slot.mat)
          setCardOpacity(slot.mat, 1); setCardFlip(slot.mat, 'raw')
        }
      }
    }
  }


  private positionExtras(slot: CardSlot): void {
    slot.badge.scaling.set(BADGE_W / 4, BADGE_H / 4, 1)
    slot.badge.position.x = slot.mesh.position.x + CARD_W / 2 - BADGE_W / 2 - 0.5
    slot.badge.position.y = slot.mesh.position.y - CARD_H / 2 + BADGE_H / 2 + 0.5
    slot.badge.position.z = -0.05
    slot.badge.setEnabled(slot.replyCount > 0 && slot.mesh.isEnabled())

    const ring = Math.min(CARD_H * 0.38, CARD_W * 0.18)
    slot.spinner.scaling.set(ring / 4, ring / 4, 1)
    slot.spinner.position.set(slot.mesh.position.x, slot.mesh.position.y, -0.02)

    const fp = slot.footprint
    if (fp) {
      const w = Math.max(CARD_W * 0.18, Math.min(CARD_W * 1.05, fp.w * CARD_W * 1.35))
      const h = Math.min(CARD_H * 0.34, w * 0.34)
      slot.shadow.scaling.set(w / 4, h / 4, 1)
      slot.shadow.position.x = slot.mesh.position.x + (fp.cx - 0.5) * CARD_W
      slot.shadow.position.y = slot.mesh.position.y + (fp.bottom - 0.5) * CARD_H - h * 0.18
      slot.shadow.position.z = 0.5
    }
  }

  private applyScroll(): void {
    this.positionBoundSlots()
    this.applySeparatorScroll()
    this.syncSlots()
  }

  private applySeparatorScroll(): void {
    for (let i = 0; i < this.seps.length; i++) {
      this.seps[i].position.y = this.halfH - MARGIN - (this.sepTops[i] - GAP_Y / 2) + this.scrollY
    }
  }

  /** Full-bleed hairline between rows (no card frames — models float). */
  private buildSeparators(): void {
    const tops = [...new Set(this.rows.map((r) => r.top))].filter((t) => t > 0)
    // disposing + recreating LinesMeshes on every layout was pure GC churn
    if (tops.length === this.sepTops.length && tops.every((t, i) => t === this.sepTops[i])) {
      this.applySeparatorScroll()
      return
    }
    for (const l of this.seps) l.dispose()
    this.seps = []
    this.sepTops = []
    const halfW = this.halfH * this.aspect
    for (const top of tops) {
      const line = MeshBuilder.CreateLines(`sep-${top}`, {
        points: [new Vector3(-halfW, 0, 0.2), new Vector3(halfW, 0, 0.2)],
      }, this.scene)
      line.color = Color3.FromHexString(shade(this.background, this.isDark ? 0.16 : -0.16))
      line.isPickable = false
      line.position.y = this.halfH - MARGIN - (top - GAP_Y / 2) + this.scrollY
      this.seps.push(line)
      this.sepTops.push(top)
    }
  }

  private bindInput(): void {
    this.scene.onPointerObservable.add((info: PointerInfo) => {
      const ev = info.event as PointerEvent
      switch (info.type) {
        case PointerEventTypes.POINTERDOWN: {
          if (ev.button !== 0) return
          this.activePointers.add(ev.pointerId)
          if (this.activePointers.size > 1) { this.dragging = false; return }
          this.dragging = true
          this.downPointerY = this.scene.pointerY
          this.downScrollY = this.scrollY
          this.moved = 0
          this.velocity = 0
          break
        }
        case PointerEventTypes.POINTERMOVE: {
          if (!this.dragging || this.activePointers.size > 1) return
          const dy = this.scene.pointerY - this.downPointerY
          this.moved = Math.max(this.moved, Math.abs(dy))
          const prev = this.scrollY
          this.setScroll(this.downScrollY - dy / this.pxPerUnit)
          this.velocity = this.scrollY - prev
          break
        }
        case PointerEventTypes.POINTERUP: {
          this.activePointers.delete(ev.pointerId)
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
    if (this.pendingSettle && this.isSettled(performance.now())) {
      this.refreshVisibility()
      this.invalidate(2)
    }
    this.previewPool.tick(this.visiblePosts)
    // spin the loading rings (stepped, like the HTML one)
    const step = (Math.PI * 2) / 12
    const phase = Math.floor(performance.now() / SPIN_STEP_MS) * step
    for (const slot of this.cards) {
      if (slot.spinner.isEnabled()) slot.spinner.rotation.z = -phase
    }
    // scroll inertia: momentum decays between inputs
    if (!this.dragging && this.inertia > 0 && Math.abs(this.velocity) > 0.0005) {
      this.setScroll(this.scrollY + this.velocity)
      this.velocity *= 0.96 - 0.10 * this.inertia
      if (Math.abs(this.velocity) < 0.001) this.velocity = 0
    } else if (this.inertia === 0) {
      this.velocity = 0
    }
  }

  /**
   * "Settled" gates deferred loads. Two ways to settle: the scroll stopped
   * for SCROLL_SETTLE_MS, OR the inertia glide is already slow — the tail of
   * a glide lasts ~1s and kept lastScrollAt fresh the whole time, so loads
   * (and therefore posters/previews) were needlessly held back that long.
   */
  private isSettled(now: number): boolean {
    if (this.dragging) return false
    if (Math.abs(this.velocity) < 0.15) return true
    return now - this.lastScrollAt > SCROLL_SETTLE_MS
  }

  private setScroll(v: number): void {
    const next = Math.max(0, Math.min(this.maxScroll, v))
    if (next === this.scrollY) return
    this.scrollY = next
    this.lastScrollAt = performance.now()
    this.applyScroll()
    this.invalidate()
  }

  private tapAt(x: number, y: number): void {
    const pick = this.scene.pick(x, y, (m) => Boolean(m.metadata?.card))
    if (!pick?.hit || !pick.pickedMesh?.metadata?.card) return
    const slot = pick.pickedMesh.metadata.card as CardSlot
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
      if (slot.meta?.eventId !== meta.eventId) return
      if (!tex) {
        // No poster (too big / render failed / offline): stop the ring and
        // leave a quiet plate. A ring that spins forever also means the board
        // can never stop rendering.
        slot.failed = true
        slot.spinner.setEnabled(false)
        setCardOpacity(slot.mat, 0.09)
        this.invalidate(2)
        return
      }
      if (slot.live) return
      slot.poster = tex
      setCardTexture(slot.mat, tex)
      setCardWhite(slot.mat)
      setCardOpacity(slot.mat, 1)
      setCardFlip(slot.mat, 'raw')
      slot.footprint = assets.getFootprint(meta) ?? null
      slot.spinSince = 0
      slot.spinner.setEnabled(false)
      slot.shadow.setEnabled(!!slot.footprint)
      this.positionExtras(slot)
      this.invalidate(2)
      const animated = assets.isAnimated(meta)
      if ((animated ?? (meta.animHint || meta.cameraCount > 0)) && this.visiblePosts.has(meta.eventId)) {
        this.previewPool.request(meta.eventId)
      }
    })
  }

  private release(slot: CardSlot): void {
    if (slot.meta) {
      this.previewPool.release(slot.meta.eventId)
      // if its poster never started, drop it from the queue
      if (!slot.poster) this.assets?.cancelPoster(slot.meta.eventId)
    }
    if (slot.live) {
      slot.live = null
      if (slot.poster) {
        setCardTexture(slot.mat, slot.poster); setCardWhite(slot.mat); setCardOpacity(slot.mat, 1); setCardFlip(slot.mat, 'raw')
      } else {
        setCardTexture(slot.mat, null); setCardTint(slot.mat, slot.meta?.tint || theme.panel); setCardOpacity(slot.mat, 0.14); setCardFlip(slot.mat, 'raw')
      }
    }
  }

  resize(): void {
    this.lastSyncScroll = Number.NEGATIVE_INFINITY
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
    this.backdrop.position.set(0, 0, 2)
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
