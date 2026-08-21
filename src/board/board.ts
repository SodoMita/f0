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
import '@babylonjs/core/Culling/ray'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import type { LinesMesh } from '@babylonjs/core/Meshes/linesMesh'
import type { FormEngine } from '../core/engine'
import type { ThreadMeta } from '../protocol/thread-index'
import type { AssetCache } from '../core/assets'
import type { PreviewPool } from './previewPool'
import { type Direct3DPool, type Place3D } from './modelCard3d'
import { LivePool } from './livePool'
import {
  makeCardMaterial, setCardTexture, setCardTexture2, setCardTint, setCardTint2, setCardWhite, setCardFlip, setCardOpacity, type CardTextureKind,
} from './cardMaterial'
import type { Texture as TextureT } from '@babylonjs/core/Materials/Textures/texture'
import type { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial'
import {
  flatCamera, makeBackdropTexture, paintBackdrop, makeContactShadow, makeSpinnerTexture,
  paintPlayButtons, luminance, shade,
} from '../core/gfx'
import { theme, LIMITS } from '../theme'
import { type CardFade, fadeInit, finishFade, setOpacityNow, crossfadeTo, fadeOpacityTo, tickFade, showPoster } from './cardFade'
import { PlayIntent, playVisible } from './playIntent'
import { OVERLAY_GROUP, disableOverlayAutoClear, makeQuad, bindDyn, makePlayTextures, paintGlassPill, strokeReplyArrow, inkFor } from './overlays'

export interface BoardCallbacks {
  onOpenModel: (meta: ThreadMeta) => void
  onOpenThread: (meta: ThreadMeta) => void
}

interface CardSlot extends CardFade {
  meta?: ThreadMeta
  mesh: Mesh
  mat: ShaderMaterial
  w: number
  h: number
  poster: Texture | null
  live: RenderTargetTexture | null
  requested: boolean
  row: Row | null
  failed: boolean
  spinSince: number
  shadow: Mesh
  shadowMat: ShaderMaterial
  footprint: { cx: number; bottom: number; w: number } | null
  spinner: Mesh
  spinnerMat: ShaderMaterial
  badge: Mesh
  badgeMat: ShaderMaterial
  badgeTex: DynamicTexture
  replyCount: number
  badgeDrawn: number
  play: Mesh
  playMat: ShaderMaterial
}

interface Row {
  meta: ThreadMeta
  top: number
  col: number
  visible: boolean
}

// Card size follows the post's declared poster size (`dim`, format v4):
// width is fixed at 16 world units, height follows the post's aspect
// (16:10 -> 10, exactly the old fixed quad). The texture is rendered at the
// declared size, so nothing is ever stretched.
const CARD_W = 16
// Reference card height (16:10) for scroll-sync thresholds and prefetch
// windows — per-card heights vary with each post's aspect.
const CARD_H_REF = 10

/** Card quad size in world units for a post's declared poster aspect. */
function cardSize(meta: ThreadMeta): { w: number; h: number } {
  return { w: CARD_W, h: CARD_W * (meta.height / meta.width) }
}

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
// play button (world units) — same visual language as the reply badge,
// pinned to the card's bottom-LEFT corner so the two never overlap.
const BTN_W = 2.6
const BTN_H = 2.6
// Pixels of pointer travel before a press becomes a scroll. Below this we
// treat the gesture as a tap on the card that was under the POINTERDOWN.
const TAP_SLOP = 8

export class Board {
  readonly scene: Scene
  private camera: ArcRotateCamera
  private cards: CardSlot[] = []
  private pool = 24
  private cb: BoardCallbacks
  private rows: Row[] = []
  readonly live: LivePool
  get previewPool(): PreviewPool { return this.live.preview }
  /** Direct-3D models rendered in the visible scene (no render-to-texture). */
  readonly pool3d: Direct3DPool
  private threeD = false
  /** Bumped on every 2D↔3D switch; async poster jobs capture it so a poster
   *  that resolves AFTER the toggle cannot paint over a direct 3D model
   *  (the "duplicated static poster over the animated model" regression). */
  private modeGen = 0
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
  // two shared button textures (▶ when paused / ⏸ while playing); every
  // card's playMat samples one of these, so toggling is a texture swap, not
  // a canvas repaint per card
  private playTexOff: DynamicTexture
  private playTexOn: DynamicTexture
  private seps: LinesMesh[] = []
  private sepTops: number[] = []
  private background: string = theme.background
  private isDark = true
  // tap vs drag + inertia
  private dragging = false
  private downPointerX = 0
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
  private prefetchScreens = 1
  private contactStrength = 0.55
  /** False while another view owns the canvas — cards must not steal taps. */
  private interactive = true
  private intent = new PlayIntent()
  get autoplay(): boolean { return this.intent.autoplay }

  constructor(engine: FormEngine, cb: BoardCallbacks) {
    const isMobile = /Mobi|Android/i.test(navigator.userAgent)

    this.form = engine
    this.scene = new Scene(engine.engine)
    this.scene.clearColor = Color3.FromHexString(this.background).toColor4(1)
    this.scene.skipPointerMovePicking = true
    this.scene.blockMaterialDirtyMechanism = true
    disableOverlayAutoClear(this.scene)

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
    const playTex = makePlayTextures(this.scene, 'card-play', this.isDark)
    this.playTexOff = playTex.off
    this.playTexOn = playTex.on

    this.cb = cb
    this.live = new LivePool(
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
    this.live.preview.watch({
      onLive: (postId, rtt) => {
        const slot = this.cards.find((c) => c.meta?.eventId === postId)
        if (!slot) return
        // Same RTT already bound (view hop / duplicate request) — skip the
        // 120 ms fade that would flash the card.
        if (slot.live === rtt) { this.positionExtras(slot); return }
        slot.live = rtt
        slot.spinner.setEnabled(false)
        this.invalidate()
        this.crossfadeTo(slot, rtt, '#FFFFFF', 'rtt')
        this.positionExtras(slot)
      },
      onRelease: (postId) => {
        const slot = this.cards.find((c) => c.meta?.eventId === postId)
        if (!slot || !slot.live) return
        slot.live = null
        this.showPoster(slot)
        this.invalidate()
        this.positionExtras(slot)
      },
      onResize: (postId, newRtt) => {
        const slot = this.cards.find((c) => c.meta?.eventId === postId)
        if (!slot || !slot.live) return
        slot.live = newRtt
        if (slot.fadeStart) this.finishFade(slot)
        setCardTexture(slot.mat, newRtt)
        setCardWhite(slot.mat)
        setCardTexture2(slot.mat, null)
        setCardTint2(slot.mat, '#FFFFFF')
        setCardFlip(slot.mat, 'rtt')
        this.invalidate(2)
      },
      // Shared pool: a thread load finishing must not refill BOARD slots.
      onLoadDone: () => { if (this.live.view === 'board') this.refreshVisibility() },
    })

    this.pool3d = this.live.attach3d('board', this.scene, isMobile ? 6 : 10)
    this.pool3d.onPlaced = (postId) => {
      const slot = this.cards.find((c) => c.meta?.eventId === postId)
      if (!slot) return
      slot.spinner.setEnabled(false)
      // A real model stands on the card: a default contact shadow (the poster
      // footprint is 2D-only and never computed in 3D mode).
      slot.footprint = { cx: 0.5, bottom: 0.1, w: 0.66 }
      slot.shadow.setEnabled(this.contactStrength > 0)
      this.positionExtras(slot)
      this.invalidate(2)
    }
    this.pool3d.onFailed = (postId) => {
      const slot = this.cards.find((c) => c.meta?.eventId === postId)
      if (!slot || slot.meta?.eventId !== postId) return
      // Direct 3D failed (over-cap model / bad bytes): fall back to the
      // poster pipeline so the card still shows something.
      slot.spinner.setEnabled(false)
      slot.failed = true
      this.drive2D(slot)
    }
    this.pool3d.onReleased = (postId) => {
      const slot = this.cards.find((c) => c.meta?.eventId === postId)
      if (!slot) return
      slot.footprint = null
      slot.shadow.setEnabled(false)
    }
    this.pool3d.onLoadDone = () => { if (this.live.view === 'board') this.refreshVisibility() }

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
    // A card crossfade is 120ms of continuous opacity change.
    if (this.cards.some((s) => s.fadeStart > 0 && s.mesh.isEnabled())) return true
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
    if (this.threeD && this.pool3d.hasWork(this.visiblePosts)) return true
    return this.previewPool.hasWork(this.visiblePosts)
  }

  private invalidate(_frames = 2): void { this.form.kick() }

  /** Background colour follows the settings panel (viewer/thread/board). */
  setBackground(hex: string): void {
    this.background = hex
    this.isDark = luminance(hex) < 0.5
    this.scene.clearColor = Color4.FromHexString(hex + 'FF')
    paintBackdrop(this.backdropTex, hex)
    // the shared button textures carry the theme's pill colours — repaint
    // them, then every card picks up the new look on its next position pass
    paintPlayButtons(this.playTexOff, this.playTexOn, this.isDark, theme.ink)
    for (const slot of this.cards) {
      setCardTint(slot.shadowMat, this.isDark ? '#000000' : '#1b1b22')
      setCardOpacity(slot.shadowMat, this.contactStrength * (this.isDark ? 1 : 0.4))
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
    // Drop play-intent bookkeeping for posts that left the feed (a slot
    // recycle never clears it — the user's choice should survive scrolling).
    this.intent.prune(new Set(this.rows.map((r) => r.meta.eventId)))
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

  /** The hidden stage where live previews render (graphics settings apply). */
  get previewScene(): Scene { return this.previewPool.scene }

  /** Returning to the board: re-request live slots after another view used the shared pool. */
  resumeLive(): void {
    this.lastSyncScroll = Number.NEGATIVE_INFINITY
    this.refreshVisibility()
  }

  /** Preload window as a fraction of a screen height (settings → Memory). */
  setPrefetch(screens: number): void {
    this.prefetchScreens = Math.max(0, screens)
    this.lastSyncScroll = Number.NEGATIVE_INFINITY
    this.syncSlots(true)
  }

  /** Contact shadow opacity (settings → Lighting). 0 hides them. */
  setContactShadows(strength: number): void {
    this.contactStrength = Math.max(0, Math.min(1, strength))
    for (const slot of this.cards) {
      setCardOpacity(slot.shadowMat, this.contactStrength * (this.isDark ? 1 : 0.45))
      if (slot.shadow.isEnabled() && this.contactStrength === 0) slot.shadow.setEnabled(false)
      else if (slot.footprint && this.contactStrength > 0) slot.shadow.setEnabled(true)
    }
    this.invalidate(2)
  }

  /** Number of animated preview slots (settings → Memory). */
  setLivePreviewSlots(n: number): void {
    this.live.setMaxSlots(n)
    this.lastSyncScroll = Number.NEGATIVE_INFINITY
    this.syncSlots(true)
  }

  /** Settings → Textures: card / preview width. Height follows the 16:10
   *  reference aspect; the live-preview RTT is shared by all slots, so it
   *  keeps the reference aspect even for posts that declare another. */
  setPreviewSize(width: number): void {
    const w = Math.max(16, Math.round(width))
    const h = Math.max(16, Math.round(w * (10 / 16))) // 16:10 reference
    this.live.setPreviewSize(w, h)
  }

  setInertia(v: number): void {
    this.inertia = Math.max(0, Math.min(1, v))
  }

  /**
   * The board shares the one canvas. While studio/viewer/thread is up the
   * cards must not remain pickable (a live feed event would re-bind them
   * isPickable=true) and a leftover drag must not keep scrolling.
   */
  setInteractive(on: boolean): void {
    this.interactive = on
    if (!on) {
      this.dragging = false
      this.velocity = 0
      this.activePointers.clear()
    }
    for (const slot of this.cards) {
      slot.mesh.isPickable = on && !!slot.meta && slot.mesh.isEnabled()
      slot.play.isPickable = on && slot.play.isEnabled()
    }
  }

  /**
   * Settings → Interface → "Autoplay animations". Turning autoplay OFF pauses
   * every auto-started (non-manual) live slot in place — the feed freezes on
   * its current frame, matching "everything opens paused". User-started plays
   * keep running; the user's explicit pause choice is always respected.
   */
  setAutoplay(on: boolean): void {
    const ids = this.cards.map((s) => s.meta?.eventId).filter((id): id is string => !!id)
    const changed = this.threeD
      ? this.intent.setAutoplay(on, ids.filter((id) => this.pool3d.isLive(id) && this.pool3d.hasAnims(id)),
        (id) => this.pool3d.isPlaying(id), (id) => this.pool3d.play(id), (id) => this.pool3d.pause(id))
      : this.intent.setAutoplay(on, ids.filter((id) => this.cards.some((s) => s.meta?.eventId === id && s.live)),
        (id) => this.previewPool.isPlaying(id), (id) => this.previewPool.resume(id), (id) => this.previewPool.pause(id))
    if (!changed) return
    for (const slot of this.cards) if (slot.meta) this.positionExtras(slot)
    this.invalidate(2)
  }

  /**
   * Toggle "3D models" (the topbar button / settings → Interface). ON swaps
   * the board from poster + offscreen preview RTTs to real GLB meshes
   * rendered directly in the board scene; OFF restores the poster pipeline.
   */
  setDirect3D(on: boolean): void {
    if (this.threeD === on) return
    const was = this.threeD
    this.threeD = on
    this.modeGen++ // invalidate any in-flight poster jobs from the old mode
    // Free the pipeline we are leaving (never both resident at once).
    if (was) this.pool3d.releaseAll()
    else if (this.live.ownsPreview('board')) this.previewPool.releaseAll()
    for (const slot of this.cards) {
      if (!slot.meta || !slot.row) continue
      if (was) { slot.poster = null; slot.live = null }
      this.bind(slot, slot.row) // bind() is 3D-aware
      slot.requested = false
      slot.failed = false
      slot.spinSince = 0
    }
    this.lastSyncScroll = Number.NEGATIVE_INFINITY
    this.refreshVisibility()
    this.invalidate(3)
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
    return this.halfH - MARGIN - (row.top + cardSize(row.meta).h / 2) + this.scrollY
  }

  private colX(col: number): number {
    return (col - (this.cols - 1) / 2) * (CARD_W + GAP_X)
  }

  private buildPool(): void {
    for (let i = 0; i < this.pool; i++) {
      const { mesh: shadow, mat: shadowMat } = makeQuad(this.scene, `shadow-${i}`, { z: 0.5 })
      bindDyn(shadowMat, this.shadowTex, '#000000', this.contactStrength)
      const { mesh, mat } = makeQuad(this.scene, `card-${i}`, { z: 0 })
      const { mesh: spinner, mat: spinnerMat } = makeQuad(this.scene, `spinner-${i}`, { z: -0.02, group: OVERLAY_GROUP })
      bindDyn(spinnerMat, this.spinnerTex, theme.ink, 0.75)
      const { mesh: badge, mat: badgeMat } = makeQuad(this.scene, `badge-${i}`, { z: -0.05, group: OVERLAY_GROUP })
      const badgeTex = new DynamicTexture(`badge-tex-${i}`, { width: 320, height: 118 }, this.scene, false, Texture.BILINEAR_SAMPLINGMODE)
      badgeTex.hasAlpha = true
      bindDyn(badgeMat, badgeTex)
      const { mesh: play, mat: playMat } = makeQuad(this.scene, `play-${i}`, { z: -0.06, group: OVERLAY_GROUP, pickable: true })
      bindDyn(playMat, this.playTexOff)
      const slot: CardSlot = {
        mesh, mat, w: CARD_W, h: CARD_H_REF, poster: null, live: null, requested: false, row: null, failed: false, spinSince: 0,
        shadow, shadowMat, spinner, spinnerMat,
        badge, badgeMat, badgeTex, replyCount: 0, badgeDrawn: -1, footprint: null,
        play, playMat, ...fadeInit(),
      }
      this.cards.push(slot)
      mesh.metadata = { card: slot }
      badge.metadata = { card: slot, badge: true }
      play.metadata = { card: slot, play: true }
    }
  }

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
    const pad = Math.round(h * 0.07)
    paintGlassPill(ctx, pad, pad, w - pad * 2, h - pad * 2, this.isDark)
    const ink = inkFor(this.isDark)
    const cy = h / 2, ax = pad + (h - pad * 2) * 0.52, s = (h - pad * 2) * 0.30
    ctx.strokeStyle = ink
    ctx.lineWidth = Math.max(2.5, h * 0.045)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    strokeReplyArrow(ctx, ax, cy, s)
    ctx.fillStyle = ink
    ctx.font = `600 ${Math.round(h * 0.42)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(slot.replyCount), ax + s * 1.7, cy + h * 0.015)
    slot.badgeTex.update()
    slot.badge.setEnabled(true)
    this.invalidate()
  }

  /** Point a card's button at the right shared texture (▶ or ⏸). */
  private setPlayState(slot: CardSlot, playing: boolean): void {
    setCardTexture(slot.playMat, playing ? this.playTexOn : this.playTexOff)
  }

  private layout(): void {
    // Responsive columns: 1 on phones, up to 3 on wide screens.
    const viewW = 2 * this.halfH * this.aspect
    this.cols = Math.max(1, Math.min(3, Math.floor((viewW - MARGIN * 2) / (CARD_W + GAP_X))))
    let top = 0
    // Posts fill the grid band by band (one band = one row of `cols` cards).
    // Card heights vary with each post's `dim` aspect, so a band is as tall
    // as its tallest card and shorter cards centre inside it — mixed-aspect
    // posts never collide and never stretch.
    for (let i = 0; i < this.rows.length; i += this.cols) {
      const band = this.rows.slice(i, i + this.cols)
      const bandH = Math.max(...band.map((r) => cardSize(r.meta).h))
      band.forEach((row, j) => {
        row.col = j
        row.top = top + (bandH - cardSize(row.meta).h) / 2
      })
      top += bandH + GAP_Y
    }
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
    if (!force && Math.abs(this.scrollY - this.lastSyncScroll) < CARD_H_REF * 0.34) {
      this.positionBoundSlots()
      return
    }
    this.lastSyncScroll = this.scrollY

    // rows worth keeping resident, nearest to the viewport first
    const keepWindow = this.halfH + CARD_H_REF * 2.2
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
    slot.play.setEnabled(false)
    this.setPlayState(slot, false) // every recycled card starts as ▶
    // the ring is switched on by refreshVisibility, and ONLY for slots inside
    // the prefetch window — a resident-but-offscreen card that keeps spinning
    // also keeps the whole board rendering
    slot.spinner.setEnabled(false)
    slot.mesh.setEnabled(true)
    slot.mesh.isPickable = this.interactive
    const size = cardSize(row.meta)
    slot.w = size.w
    slot.h = size.h
    slot.mesh.scaling.set(size.w / 4, size.h / 4, 1)

    if (this.threeD) {
      // Direct-3D mode: the card quad is an invisible tap target; the real
      // model is loaded into the scene by drive3D() once the feed settles.
      slot.poster = null
      slot.live = null
      slot.footprint = null
      setCardTexture(slot.mat, null)
      setCardTint(slot.mat, row.meta.tint || theme.panel)
      this.setOpacityNow(slot, 0)
      setCardFlip(slot.mat, 'raw')
      slot.shadow.setEnabled(false)
      this.drawBadge(slot)
      return
    }

    // Fast path: poster texture still on the GPU -> rebind synchronously.
    const cached = this.assets?.peekPoster(row.meta)
    if (cached) {
      slot.poster = cached
      slot.requested = true // nothing to download; skip the drive() round trip
      setCardTexture(slot.mat, cached)
      setCardWhite(slot.mat)
      this.setOpacityNow(slot, 1)
      setCardFlip(slot.mat, 'rtt')
      slot.footprint = this.assets?.getFootprint(row.meta) ?? null
      slot.shadow.setEnabled(!!slot.footprint && this.contactStrength > 0)
    } else {
      slot.poster = null
      slot.footprint = null
      // Placeholder: a barely-there plate, not an opaque slab.
      setCardTexture(slot.mat, null)
      setCardTint(slot.mat, row.meta.tint || theme.panel)
      this.setOpacityNow(slot, 0.14)
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
      if (this.threeD) this.pool3d.place(slot.meta.eventId, this.placeFor(slot))
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
    const near = this.halfH + CARD_H_REF * 1.6 * Math.max(0.1, this.prefetchScreens)
    // Don't start downloads/renders for cards that are flying past: a fling
    // through 48 posts would otherwise queue ~40 GLB parses and offscreen
    // renders, and each one blocks a frame. Loads start once scrolling rests.
    const now = performance.now()
    const settled = this.isSettled(now)
    // NB both directions: leaving this latched at true kept isAnimating()
    // true forever, i.e. the board never stopped drawing after a scroll.
    this.pendingSettle = !settled
    // stop chewing on GLBs while the feed is moving. Only while THIS view
    // owns the canvas — otherwise a live event would unpause the queue
    // behind the studio / thread.
    if (this.interactive) this.assets?.setPaused(!settled)
    for (const slot of this.cards) {
      const row = slot.row
      if (!slot.meta || !row) continue
      const y = this.worldY(row)
      const onScreen = Math.abs(y) < this.halfH + Math.max(slot.h, CARD_H_REF) * 0.6
      row.visible = onScreen
      if (onScreen) this.visiblePosts.add(row.meta.eventId)

      // loading ring: only inside the prefetch window, only while there is
      // genuinely something to wait for, and never for longer than SPIN_MAX_MS
      const inRange = Math.abs(y) < near
      const id = row.meta.eventId
      const in3D = this.threeD
      const modelLive = in3D && this.pool3d.isLive(id)
      let ring = in3D
        ? inRange && !slot.failed && !modelLive
        : inRange && !slot.poster && !slot.live && !slot.failed
      if (ring) {
        if (!slot.spinner.isEnabled() && slot.spinSince === 0) slot.spinSince = now
        if (slot.spinSince && now - slot.spinSince > SPIN_MAX_MS) ring = false
      } else {
        slot.spinSince = 0
      }
      if (slot.spinner.isEnabled() !== ring) { slot.spinner.setEnabled(ring); this.invalidate(2) }

      // Shared pool: only the active view may request or release RTTs / 3D
      // models. A resize or onLoadDone while the thread is up used to steal
      // slots (and could release a thread node that shares this post id).
      const liveHere = this.live.view === 'board' && this.interactive
      if (settled && inRange && liveHere) {
        if (in3D) {
          // Keep asking: a full pool used to mark the card `failed` on the
          // first refusal and never retry, so only the first N cards ever
          // went 3D. Capacity misses are transient — retry until live.
          if (!modelLive && !this.pool3d.isLoading(id) && !this.pool3d.isRejected(id)) {
            this.drive3D(slot)
          }
          // Autoplay / play gating for the direct model — same semantics as
          // the RTT live previews: silent auto-start as cards arrive, a
          // user-started post keeps its sound, a user-paused post stays
          // paused until ▶ is pressed again.
          if (modelLive && this.pool3d.hasAnims(id)) {
            const want = this.intent.wantsPlay(id)
            if (want && !this.pool3d.isPlaying(id)) this.pool3d.play(id, this.intent.isManual(id))
            else if (!want && this.pool3d.isPlaying(id)) this.pool3d.pause(id)
          }
        } else if (!slot.requested) {
          slot.requested = true
          this.drive2D(slot)
        } else if (slot.poster && !slot.live && this.visiblePosts.has(id)) {
          // Live slots are for what the user can SEE. Requesting for every
          // prefetched (offscreen) card made the pool evict one offscreen slot
          // for another in an endless loop — the evicted card re-requested on
          // the next pass and evicted its evictor (thousands of churned GLB
          // loads per scroll). Offscreen cards keep their posters; the moment
          // they scroll into view the request below fires.
          // same gate as drive() — hints or poster-render knowledge
          const animated = this.assets?.isAnimated(row.meta)
          if ((animated ?? (row.meta.animHint || row.meta.cameraCount > 0)) && !this.previewPool.isRejected(id)) {
            // AMENDMENT 69: autoplay starts slots silently as cards arrive
            // (the historical behaviour); a post the user started with the ▶
            // button keeps playing with its sound, and a post the user
            // paused stays paused until they press ▶ again.
            if (this.intent.wantsPlay(id)) this.previewPool.request(id, this.visiblePosts, this.intent.isManual(id))
          }
        }
      } else if (liveHere && Math.abs(y) >= near) {
        if (in3D) {
          if (modelLive) this.pool3d.release(id)
        } else if (slot.live) {
          this.previewPool.release(id)
          slot.live = null
          this.showPoster(slot)
        }
      }
    }
  }


  /**
   * Should this card's ▶/⏸ button be visible? Only for posts that can
   * animate, once that is known: the poster render records isAnimated (v4),
   * v3 posts fall back to their anim/camera tags, and the pool's own verdict
   * (STATIC/FAILED) always wins. Hidden when livePreviews=0 — a button that
   * can never start a slot is a dead control.
   */
  private playButtonVisible(slot: CardSlot): boolean {
    const meta = slot.meta
    if (!meta) return false
    return playVisible(
      this.threeD, this.pool3d.isLive(meta.eventId), this.pool3d.hasAnims(meta.eventId),
      !!slot.poster, this.previewPool.isRejected(meta.eventId), this.previewPool.opts.maxSlots,
      this.assets?.isAnimated(meta), !!(meta.animHint || meta.cameraCount > 0),
    )
  }

  private positionExtras(slot: CardSlot): void {
    slot.badge.scaling.set(BADGE_W / 4, BADGE_H / 4, 1)
    slot.badge.position.x = slot.mesh.position.x + slot.w / 2 - BADGE_W / 2 - 0.5
    slot.badge.position.y = slot.mesh.position.y - slot.h / 2 + BADGE_H / 2 + 0.5
    slot.badge.position.z = -0.05
    slot.badge.setEnabled(slot.replyCount > 0 && slot.mesh.isEnabled())

    const showPlay = this.playButtonVisible(slot)
    slot.play.scaling.set(BTN_W / 4, BTN_H / 4, 1)
    slot.play.position.x = slot.mesh.position.x - slot.w / 2 + BTN_W / 2 + 0.5
    slot.play.position.y = slot.mesh.position.y + slot.h / 2 - BTN_H / 2 - 0.5
    slot.play.position.z = -0.06
    slot.play.setEnabled(showPlay && slot.mesh.isEnabled())
    if (slot.meta) {
      const playing = this.threeD
        ? this.pool3d.isPlaying(slot.meta.eventId)
        : !!slot.live && this.previewPool.isPlaying(slot.meta.eventId)
      this.setPlayState(slot, playing)
    }

    const ring = Math.min(slot.h * 0.38, slot.w * 0.18)
    slot.spinner.scaling.set(ring / 4, ring / 4, 1)
    slot.spinner.position.set(slot.mesh.position.x, slot.mesh.position.y, -0.02)

    const fp = slot.footprint
    if (fp) {
      const w = Math.max(slot.w * 0.18, Math.min(slot.w * 1.05, fp.w * slot.w * 1.35))
      const h = Math.min(slot.h * 0.34, w * 0.34)
      slot.shadow.scaling.set(w / 4, h / 4, 1)
      slot.shadow.position.x = slot.mesh.position.x + (fp.cx - 0.5) * slot.w
      slot.shadow.position.y = slot.mesh.position.y + (fp.bottom - 0.5) * slot.h - h * 0.18
      // 3D mode: the model has real depth (z ∈ [-d/2, +d/2]), so the contact
      // shadow must sit BEHIND it — just in front of the backdrop (z=2).
      slot.shadow.position.z = this.threeD ? 1.9 : 0.5
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
          if (!this.interactive) return
          if (ev.button !== 0) return
          this.activePointers.add(ev.pointerId)
          if (this.activePointers.size > 1) { this.dragging = false; return }
          this.dragging = true
          this.downPointerX = this.scene.pointerX
          this.downPointerY = this.scene.pointerY
          this.downScrollY = this.scrollY
          this.moved = 0
          this.velocity = 0
          break
        }
        case PointerEventTypes.POINTERMOVE: {
          if (!this.dragging || this.activePointers.size > 1) return
          const dx = this.scene.pointerX - this.downPointerX
          const dy = this.scene.pointerY - this.downPointerY
          this.moved = Math.max(this.moved, Math.abs(dx), Math.abs(dy))
          // Do not shift the feed until this is a real drag. A tap's natural
          // jitter used to scroll the row above under the pointer, so the
          // POINTERUP pick opened the wrong model.
          if (this.moved < TAP_SLOP) return
          const prev = this.scrollY
          this.setScroll(this.downScrollY - dy / this.pxPerUnit)
          this.velocity = this.scrollY - prev
          break
        }
        case PointerEventTypes.POINTERUP: {
          this.activePointers.delete(ev.pointerId)
          if (!this.dragging) return
          this.dragging = false
          if (this.moved < TAP_SLOP) {
            this.velocity = 0
            this.tapAt(this.downPointerX, this.downPointerY)
            break
          }
          if (this.inertia === 0) this.velocity = 0
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
    this.pool3d.tick(this.visiblePosts)
    const now = performance.now()
    for (const slot of this.cards) tickFade(slot, slot.mat, now)
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
    if (!this.interactive) return
    // Hit-test in the same CSS→world space as screenPosOf. scene.pick can
    // disagree with the ortho layout (hardware scale, jittered scroll),
    // which opened the post one row above the one that was pressed.
    const eng = this.scene.getEngine()
    const cssW = eng.getRenderWidth() * eng.getHardwareScalingLevel()
    const cssH = eng.getRenderHeight() * eng.getHardwareScalingLevel()
    if (cssW <= 0 || cssH <= 0 || this.pxPerUnit <= 0) return
    const wx = (x - cssW / 2) / this.pxPerUnit
    const wy = this.halfH - (y / cssH) * (2 * this.halfH)

    let best: { slot: CardSlot; d: number; action: 'thread' | 'play' | 'open' } | null = null
    for (const slot of this.cards) {
      const row = slot.row
      if (!slot.meta || !row || !slot.mesh.isEnabled()) continue
      const cx = this.colX(row.col)
      const cy = this.worldY(row)
      if (slot.replyCount > 0 && slot.badge.isEnabled()) {
        const bx = slot.badge.position.x
        const by = slot.badge.position.y
        if (Math.abs(wx - bx) <= BADGE_W / 2 && Math.abs(wy - by) <= BADGE_H / 2) {
          const d = (wx - bx) ** 2 + (wy - by) ** 2
          if (!best || d < best.d) best = { slot, d, action: 'thread' }
          continue
        }
      }
      if (slot.play.isEnabled()) {
        const px = slot.play.position.x
        const py = slot.play.position.y
        if (Math.abs(wx - px) <= BTN_W / 2 && Math.abs(wy - py) <= BTN_H / 2) {
          const d = (wx - px) ** 2 + (wy - py) ** 2
          if (!best || d < best.d) best = { slot, d, action: 'play' }
          continue
        }
      }
      if (Math.abs(wx - cx) <= slot.w / 2 && Math.abs(wy - cy) <= slot.h / 2) {
        const d = (wx - cx) ** 2 + (wy - cy) ** 2
        if (!best || d < best.d) best = { slot, d, action: 'open' }
      }
    }
    if (!best?.slot.meta) return
    if (best.action === 'thread') this.cb.onOpenThread(best.slot.meta)
    else if (best.action === 'play') this.togglePlay(best.slot)
    else this.cb.onOpenModel(best.slot.meta)
  }

  private togglePlay(slot: CardSlot): void {
    const id = slot.meta?.eventId
    if (!id) return
    const playing = this.threeD ? this.pool3d.isPlaying(id) : !!(slot.live && this.previewPool.isPlaying(id))
    const start = this.intent.toggle(id, playing)
    if (this.threeD) {
      if (start) this.pool3d.play(id, true)
      else this.pool3d.pause(id)
    } else if (start) {
      if (slot.live) this.previewPool.resume(id, true)
      else this.previewPool.request(id, this.visiblePosts, true)
    } else {
      this.previewPool.pause(id)
    }
    this.positionExtras(slot)
    this.invalidate(2)
  }

  private drive(slot: CardSlot): void {
    if (this.threeD) { this.drive3D(slot); return }
    this.drive2D(slot)
  }

  /** The card cell for a slot's model, in board-scene world units.
   *  z = 0 is the card plane; the model is centred there and its depth is
   *  capped so it never pokes behind the backdrop (z=2) or through the
   *  contact shadow (z≈1.9 in 3D mode). Overlays stay on top via group 1. */
  private placeFor(slot: CardSlot): Place3D {
    const row = slot.row
    return {
      x: this.colX(row?.col ?? 0),
      y: row ? this.worldY(row) : 0,
      z: 0,
      w: slot.w,
      h: slot.h,
      depth: Math.min(slot.w, slot.h) * 0.4,
    }
  }

  /** 3D mode: load the REAL model into the board scene (no poster, no RTT). */
  private drive3D(slot: CardSlot): void {
    const meta = slot.meta
    const assets = this.assets
    if (!meta || !assets) return
    if (meta.hashFailed || assets.isHashFailed(meta.eventId)) return
    // Hide the placeholder plate; the model renders in its place.
    this.setOpacityNow(slot, 0)
    const ok = this.pool3d.request(meta.eventId, this.placeFor(slot), this.visiblePosts)
    if (!ok) {
      // Rejected (bad bytes / over-cap): fall back to the poster. A capacity
      // miss is NOT a rejection — request() returns false and we retry next
      // visibility pass. Don't latch `failed` or the card is stuck on 2D.
      if (this.pool3d.isRejected(meta.eventId)) {
        slot.failed = true
        this.drive2D(slot)
      }
    }
  }

  /** 2D mode: the existing poster + live-preview pipeline. */
  private drive2D(slot: CardSlot): void {
    const meta = slot.meta
    const assets = this.assets
    if (!meta || !assets) return
    if (meta.hashFailed || assets.isHashFailed(meta.eventId)) return
    const gen = this.modeGen
    void assets.getPoster(meta).then((tex) => {
      if (slot.meta?.eventId !== meta.eventId) return
      // The mode flipped while the poster rendered: a direct 3D model now
      // owns this card, so the poster must not appear over/under it.
      if (gen !== this.modeGen) return
      if (meta.hashFailed || assets.isHashFailed(meta.eventId)) {
        slot.failed = true
        slot.spinner.setEnabled(false)
        this.fadeOpacityTo(slot, 0.09)
        this.invalidate(2)
        return
      }
      if (!tex) {
        // No poster (too big / render failed / offline): stop the ring and
        // leave a quiet plate. A ring that spins forever also means the board
        // can never stop rendering.
        slot.failed = true
        slot.spinner.setEnabled(false)
        this.fadeOpacityTo(slot, 0.09)
        this.invalidate(2)
        return
      }
      if (slot.live) return
      slot.poster = tex
      this.crossfadeTo(slot, tex, '#FFFFFF', 'rtt')
      slot.footprint = assets.getFootprint(meta) ?? null
      slot.spinSince = 0
      slot.spinner.setEnabled(false)
      slot.shadow.setEnabled(!!slot.footprint && this.contactStrength > 0)
      this.positionExtras(slot)
      this.invalidate(2)
      // Animated? v3 hints else preflight (SPEC FEED). Locally rendered
      // posters already parsed the GLB, so isAnimated is known; thumb-tagged
      // posts carry anim/cameras hints. The pool itself rejects STATIC.
      // (Skipped in 3D mode — a poster shown as a 3D fallback must not also
      // spin up an offscreen live preview.)
      const animated = assets.isAnimated(meta)
      if (this.live.view === 'board' && this.interactive && !this.threeD && (animated ?? (meta.animHint || meta.cameraCount > 0)) && !this.previewPool.isRejected(meta.eventId) && this.visiblePosts.has(meta.eventId)) {
        // autoplay gate (AMENDMENT 69): silent auto-start, or a user-started
        // post with its sound; never re-start a post the user paused.
        if (this.intent.wantsPlay(meta.eventId)) this.previewPool.request(meta.eventId, this.visiblePosts, this.intent.isManual(meta.eventId))
      }
    })
  }

  private finishFade(slot: CardSlot): void { finishFade(slot, slot.mat) }
  private setOpacityNow(slot: CardSlot, v: number): void { setOpacityNow(slot, slot.mat, v) }
  private crossfadeTo(slot: CardSlot, tex2: TextureT | null, tint: string, flip: CardTextureKind, to = 1): void {
    crossfadeTo(slot, slot.mat, tex2, tint, flip, to); this.invalidate()
  }
  private fadeOpacityTo(slot: CardSlot, v: number): void { fadeOpacityTo(slot, slot.mat, v); this.invalidate() }
  private showPoster(slot: CardSlot): void {
    showPoster(slot, slot.mat, slot.poster, slot.meta?.tint || theme.panel, this.threeD)
    this.invalidate()
  }

  private release(slot: CardSlot): void {
    if (slot.meta) {
      // Recycle must not touch the shared pool while another view owns it
      // (board.resize still runs on a window resize behind the thread).
      if (this.live.view === 'board') {
        if (this.threeD) this.pool3d.release(slot.meta.eventId)
        else {
          this.previewPool.release(slot.meta.eventId)
          if (!slot.poster) this.assets?.cancelPoster(slot.meta.eventId)
        }
      }
    }
    if (slot.live) {
      slot.live = null
      this.showPoster(slot)
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
    this.live.dispose()
    this.scene.dispose()
  }
}

