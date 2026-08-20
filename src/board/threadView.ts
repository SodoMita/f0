import { Scene } from '@babylonjs/core/scene'
import type { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
// Side-effect import for scene.pick (00 §3.7).
import '@babylonjs/core/Culling/ray'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import type { LinesMesh } from '@babylonjs/core/Meshes/linesMesh'
import type { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture'
import type { Texture as TextureT } from '@babylonjs/core/Materials/Textures/texture'
import type { FormEngine } from '../core/engine'
import type { AssetCache } from '../core/assets'
import type { ThreadIndex, ThreadMeta } from '../protocol/thread-index'
import { PreviewPool } from './previewPool'
import { Direct3DPool, type Place3D } from './modelCard3d'
import {
  makeCardMaterial, setCardTexture, setCardTexture2, setCardTint, setCardTint2, setCardWhite,
  setCardFlip, setCardOpacity, setCardBlend, type CardTextureKind,
} from './cardMaterial'
import type { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial'
import { flatCamera, makeBackdropTexture, paintBackdrop, makeSpinnerTexture, roundRect, luminance, shade } from '../core/gfx'
import { theme } from '../theme'

interface TNode {
  meta: ThreadMeta
  mesh: Mesh
  mat: ShaderMaterial
  frame: Mesh
  frameMat: ShaderMaterial
  spinner: Mesh
  spinnerMat: ShaderMaterial
  // reply button (bottom-right pill): tap -> studio compose for THIS node
  reply: Mesh
  replyMat: ShaderMaterial
  // ▶/⏸ play button (bottom-left pill): toggles this node's live preview
  // animation AND its embedded sound (AMENDMENT 69)
  play: Mesh
  playMat: ShaderMaterial
  // poster texture (reapplied when the live preview is released)
  poster: TextureT | null
  // live animated preview (same pipeline as the board's cards)
  live: RenderTargetTexture | null
  x: number
  y: number
  w: number
  h: number
  depth: number
  // 120ms two-texture crossfade plate -> poster -> live (SPEC CARD
  // "Crossfade 120ms"): the shader mixes tex/tex2 by `blend`, so node
  // transitions are real crossfades — hard swaps were the black-flicker
  // regression while the map built.
  opacity: number
  fadeFrom: number
  fadeTo: number
  fadeStart: number
  blend: number
  fadeFromBlend: number
  fadeToBlend: number
  fadeTex2: TextureT | null
  fadeTint2Hex: string
  fadeFlip: CardTextureKind
}

interface TEdge { parent: string; child: string }

const NODE_W = 6.4
// Reference node height (16:10). Node quads follow each post's declared
// poster aspect (`dim`, format v4); the reference only spaces tree rows.
const NODE_H_REF = 4.0
const ROOT_SCALE = 1.28

/** Node quad size in world units for a post's declared poster aspect. */
function nodeSize(meta: ThreadMeta, root: boolean): { w: number; h: number } {
  const w = root ? NODE_W * ROOT_SCALE : NODE_W
  return { w, h: w * (meta.height / meta.width) }
}

const GAP_X = 2.2
const GAP_Y = 4.6
const ZOOM_MIN = 0.12
const ZOOM_MAX = 6
// reply pill (world units) — same visual language as the board badge
const REPLY_W = 2.3
const REPLY_H = 1.15
// play button (world units) — bottom-left, mirroring the reply pill
const PLAY_W = 2.2
const PLAY_H = 2.2

/**
 * Thread view: a 2D map of the reply tree.
 *
 * Layout is a tidy tree (Reingold–Tilford style: leaves take consecutive
 * slots, every parent is centred over its children) — deterministic, always
 * reads top-down, and replaces the old force relaxation that could tangle
 * branches or drift them out of the cone.
 *
 * Input (all three were broken/missing before):
 *   * drag  = pan, integrated from the delta since the LAST move event.
 *     The old code measured from the pointer-down anchor every move and
 *     *added* it to the pan each time, so holding the pointer still made the
 *     map accelerate away forever.
 *   * pinch = zoom about the midpoint of the two fingers (+ two-finger pan).
 *   * wheel = zoom about the cursor, so the point under the pointer stays put.
 */
export class ThreadView {
  readonly scene: Scene
  private camera: ArcRotateCamera
  private nodes = new Map<string, TNode>()
  private edges: TEdge[] = []
  private lineMeshes: LinesMesh[] = []
  private assets: AssetCache | null = null
  private index: ThreadIndex | null = null
  private onOpenModel: ((m: ThreadMeta) => void) | null = null
  private backdrop: Mesh
  private backdropTex: DynamicTexture
  private frameTex: DynamicTexture
  private spinnerTex: DynamicTexture
  private rootFrameTex: DynamicTexture
  private replyTex!: DynamicTexture
  // shared ▶/⏸ button textures (every node samples one of these)
  private playTexOff: DynamicTexture
  private playTexOn: DynamicTexture
  private onReply: ((m: ThreadMeta) => void) | null = null
  private background: string = theme.background
  private isDark = true
  private panX = 0
  private panY = 0
  private zoom = 1
  private bounds = { minX: -10, maxX: 10, minY: -10, maxY: 10 }
  // pointer bookkeeping (multi-touch aware)
  private pointers = new Map<number, { x: number; y: number }>()
  private moved = 0
  private pinchDist = 0
  private generation = 0
  private spinObserver = false
  private canvas: HTMLCanvasElement | null = null
  private attached = false
  private form: FormEngine
  readonly previewPool: PreviewPool
  /** Direct-3D models rendered in the visible thread scene (no RTT). */
  readonly pool3d: Direct3DPool
  private threeD = false
  /** Bumped on every 2D↔3D switch; async poster jobs capture it so a poster
   *  that resolves after the toggle cannot paint over a direct 3D model. */
  private modeGen = 0
  /** Autoplay (settings → Interface): see Board.setAutoplay. */
  autoplay = true
  /** posts the user started with ▶ (kept playing even with autoplay off) */
  private manualPlay = new Set<string>()
  /** posts the user paused (autoplay must not re-start them) */
  private pausedByUser = new Set<string>()

  constructor(engine: FormEngine) {
    this.form = engine
    this.scene = new Scene(engine.engine)
    this.scene.clearColor = Color4.FromHexString(this.background + 'FF')
    this.scene.skipPointerMovePicking = true
    this.camera = flatCamera(this.scene, 'thread-cam', 30)

    // Animated nodes get live previews, same bounded pool as the board.
    // (Before, the thread map only ever showed static posters — animated
    // models were frozen in the tree.)
    this.previewPool = new PreviewPool(
      engine.engine,
      (postId) => this.assets?.getModelBytesByPostId(postId) ?? Promise.resolve(undefined),
      { maxSlots: 3, rttWidth: 384, rttHeight: 240, slotsPerFrame: 1, targetFps: 15 },
    )
    this.previewPool.onLive = (postId, rtt) => {
      const n = this.nodes.get(postId)
      if (!n || n.mesh.isDisposed()) return
      n.live = rtt
      n.spinner.setEnabled(false)
      this.crossfadeTo(n, rtt, '#FFFFFF', 'rtt')
      this.positionPlayButton(n) // ▶ flips to ⏸
      this.form.kick()
    }
    this.previewPool.onRelease = (postId) => {
      const n = this.nodes.get(postId)
      if (!n || !n.live) return
      n.live = null
      this.showNodePoster(n)
      this.positionPlayButton(n) // ⏸ flips back to ▶
      this.form.kick()
    }
    // Pool rebuilt its RTTs (settings → Textures → "Card / preview width"):
    // swap the node material's texture handle in place, no fade.
    this.previewPool.onResize = (postId, newRtt) => {
      const n = this.nodes.get(postId)
      if (!n || !n.live || n.mesh.isDisposed()) return
      n.live = newRtt
      if (n.fadeStart) this.finishNodeFade(n)
      setCardTexture(n.mat, newRtt)
      setCardWhite(n.mat)
      setCardTexture2(n.mat, null)
      setCardTint2(n.mat, '#FFFFFF')
      setCardFlip(n.mat, 'rtt')
      this.form.kick()
    }
    this.previewPool.onLoadDone = () => {
      this.syncPreviews()
      this.form.kick()
    }

    // Direct-3D pool for the thread map: real meshes in the visible scene
    // (no poster, no render-to-texture), active while the 3D toggle is on.
    this.pool3d = new Direct3DPool(
      this.scene,
      (postId) => this.assets?.getModelBytesByPostId(postId) ?? Promise.resolve(undefined),
      { maxSlots: 6 },
    )
    this.pool3d.onPlaced = (postId) => {
      const n = this.nodes.get(postId)
      if (!n || n.mesh.isDisposed()) return
      n.spinner.setEnabled(false)
      this.positionPlayButton(n)
      this.form.kick()
    }
    this.pool3d.onFailed = (postId) => {
      const n = this.nodes.get(postId)
      if (!n || n.mesh.isDisposed()) return
      n.spinner.setEnabled(false)
      // Direct 3D failed: fall back to the poster pipeline.
      this.drivePoster2D(n)
    }
    this.pool3d.onLoadDone = () => {
      this.sync3D()
      this.form.kick()
    }

    this.backdrop = MeshBuilder.CreatePlane('thread-bg', { width: 4, height: 4 }, this.scene)
    this.backdrop.isPickable = false
    const bgMat = makeCardMaterial(this.scene, false)
    this.backdrop.material = bgMat
    this.backdropTex = makeBackdropTexture(this.scene, 'thread-bg-tex', this.background)
    setCardTexture(bgMat, this.backdropTex)
    setCardWhite(bgMat)
    setCardFlip(bgMat, 'dyn')

    this.spinnerTex = makeSpinnerTexture(this.scene, 'thread-spinner-tex')
    this.frameTex = this.makeFrameTexture('thread-frame', false)
    this.rootFrameTex = this.makeFrameTexture('thread-frame-root', true)
    this.replyTex = new DynamicTexture('thread-reply-tex', { width: 256, height: 128 }, this.scene, true)
    this.replyTex.hasAlpha = true
    this.paintReplyTexture()
    this.playTexOff = new DynamicTexture('thread-play-off', { width: 128, height: 128 }, this.scene, true)
    this.playTexOn = new DynamicTexture('thread-play-on', { width: 128, height: 128 }, this.scene, true)
    this.paintPlayTextures()

    this.applyCamera()

    // PERF: pan/zoom redraws arrive as input kicks; this source only covers
    // continuous motion (node loading rings).
    engine.addAnimationSource(() => engine.activeScene === this.scene && this.isAnimating())
  }

  /** The hidden stage where live node previews render (graphics settings apply). */
  get previewScene(): Scene { return this.previewPool.scene }

  /** Settings → Memory: how many thread nodes may animate at once. */
  setLivePreviewSlots(n: number): void {
    this.previewPool.setMaxSlots(n)
    this.syncPreviews()
  }

  /** Settings → Textures: card / preview width. Height follows the 16:10
   *  reference aspect; the live-preview RTT is shared by all slots, so it
   *  keeps the reference aspect even for posts that declare another.
   *  The width is the BASE at 1:1 zoom; the live RTT scales with the map's
   *  camera zoom (applyPreviewScale) so zooming in stays sharp and zooming
   *  out spends fewer GPU pixels. */
  setPreviewSize(width: number): void {
    this.basePreviewWidth = Math.max(32, Math.round(width))
    this.applyPreviewScale()
  }

  /** RTT widths (px) — never below 64 or above 2048 regardless of zoom. */
  private static readonly RTT_MIN_W = 64
  private static readonly RTT_MAX_W = 2048
  private basePreviewWidth = 384
  /** Last width applied to the pool (avoids rebuild churn on every wheel notch). */
  private appliedRttWidth = -1

  /**
   * Live preview resolution follows the map camera: `this.zoom` is the
   * ortho half-height (20·zoom) — a SMALL zoom shows few world units on
   * screen, i.e. the user is zoomed IN and every node is large, so the RTT
   * must be larger to stay sharp; a LARGE zoom is zoomed out, nodes are
   * tiny and a smaller RTT is plenty (and cheaper). Width snaps to 32 px
   * steps so a wheel gesture rebuilds the RTT a handful of times, not per
   * notch.
   */
  private applyPreviewScale(): void {
    const raw = this.basePreviewWidth / Math.max(0.05, this.zoom)
    const w = Math.min(ThreadView.RTT_MAX_W, Math.max(ThreadView.RTT_MIN_W, Math.round(raw)))
    const snapped = Math.round(w / 32) * 32
    if (snapped === this.appliedRttWidth) return
    this.appliedRttWidth = snapped
    const h = Math.max(16, Math.round(snapped * (10 / 16)))
    this.previewPool.setRttSize(snapped, h)
  }

  /** Zoom the map by a factor about the viewport centre (HUD buttons / + − keys). */
  zoomBy(factor: number): void {
    const canvas = this.scene.getEngine().getRenderingCanvas()
    const rect = canvas?.getBoundingClientRect()
    const cx = (rect?.left ?? 0) + (rect?.width ?? window.innerWidth) / 2
    const cy = (rect?.top ?? 0) + (rect?.height ?? window.innerHeight) / 2
    this.zoomAbout(cx, cy, factor)
    this.form.kick()
  }

  /** Render-on-demand probe: pointers down, a crossfade, a spinner, or a live node. */
  isAnimating(): boolean {
    if (this.pointers.size > 0) return true
    for (const n of this.nodes.values()) {
      if (n.spinner.isEnabled() || n.fadeStart > 0) return true
    }
    if (this.threeD && this.pool3d.hasWork(this.visibleNodeIds())) return true
    return this.previewPool.hasWork(this.visibleNodeIds())
  }

  /** Node ids whose card rect intersects the current viewport. */
  private visibleNodeIds(): Set<string> {
    const halfH = 20 * this.zoom
    const halfW = halfH * this.aspect
    const out = new Set<string>()
    for (const n of this.nodes.values()) {
      if (n.x + n.w / 2 < this.panX - halfW || n.x - n.w / 2 > this.panX + halfW) continue
      if (n.y + n.h / 2 < this.panY - halfH || n.y - n.h / 2 > this.panY + halfH) continue
      out.add(n.meta.eventId)
    }
    return out
  }

  /**
   * Live previews follow the viewport: visible nodes with a poster and an
   * (possibly) animated model request a slot; nodes panned out of view are
   * released. Same preflight gate as the board — the pool rejects STATIC
   * models itself and remembers them.
   */
  private syncPreviews(): void {
    if (!this.assets) return
    // In 3D mode the direct-model pool (sync3D) owns node rendering; a node
    // that fell back to its poster stays a static poster, never a live RTT.
    if (this.threeD) return
    const visible = this.visibleNodeIds()
    for (const n of this.nodes.values()) {
      const id = n.meta.eventId
      if (n.live && !visible.has(id)) {
        this.previewPool.release(id)
        n.live = null
        this.showNodePoster(n)
        this.positionPlayButton(n)
        continue
      }
      if (n.live || !n.poster) continue
      if (!visible.has(id) || this.previewPool.isRejected(id)) continue
      // same gate as the board: poster-render knowledge or v3 hints
      const animated = this.assets.isAnimated(n.meta)
      if (!(animated ?? (n.meta.animHint || n.meta.cameraCount > 0))) continue
      // AMENDMENT 69: autoplay starts nodes silently; user-started nodes keep
      // their sound; a user-paused node stays paused until ▶ is pressed.
      const manual = this.manualPlay.has(id)
      const auto = this.autoplay && !this.pausedByUser.has(id)
      if (auto || manual) this.previewPool.request(id, visible, manual)
    }
  }

  /** Snap the node to its current crossfade target (mid-fade interrupt). */
  private finishNodeFade(n: TNode): void {
    n.fadeStart = 0
    n.opacity = n.fadeTo
    setCardOpacity(n.mat, n.opacity)
    n.blend = 0
    // reset the material uniform too (same all-white regression as the board)
    setCardBlend(n.mat, 0)
    if (n.fadeTex2) {
      setCardTexture(n.mat, n.fadeTex2)
      setCardTint(n.mat, n.fadeTint2Hex)
      setCardTexture2(n.mat, null)
      setCardTint2(n.mat, '#FFFFFF')
      setCardFlip(n.mat, n.fadeFlip)
      n.fadeTex2 = null
    }
  }

  /** Set node card state right now, dropping any in-flight crossfade. */
  private setNodeOpacityNow(n: TNode, v: number): void {
    n.opacity = v
    n.fadeStart = 0
    n.blend = 0
    setCardBlend(n.mat, 0)
    if (n.fadeTex2) {
      setCardTexture2(n.mat, null)
      setCardTint2(n.mat, '#FFFFFF')
      n.fadeTex2 = null
    }
    setCardOpacity(n.mat, v)
  }

  /** Crossfade the node to a NEW texture over 120ms (SPEC CARD crossfade). */
  private crossfadeTo(n: TNode, tex2: TextureT | null, tint2Hex: string, flip: CardTextureKind, toOpacity = 1): void {
    if (n.fadeStart) this.finishNodeFade(n)
    setCardTexture2(n.mat, tex2)
    setCardTint2(n.mat, tint2Hex)
    n.fadeTex2 = tex2
    n.fadeTint2Hex = tint2Hex
    n.fadeFlip = flip
    n.fadeFrom = n.opacity
    n.fadeTo = toOpacity
    n.fadeFromBlend = 0
    n.fadeToBlend = 1
    n.fadeStart = performance.now()
    this.form.kick()
  }

  /** Show the node's poster texture (fallback after its live preview is released). */
  private showNodePoster(n: TNode): void {
    // In 3D mode the direct model owns the node; a stale preview release must
    // not re-show a poster over it.
    if (this.threeD) { this.setNodeOpacityNow(n, 0); return }
    if (n.poster) {
      this.crossfadeTo(n, n.poster, '#FFFFFF', 'rtt')
    } else {
      setCardTexture(n.mat, null)
      setCardTint(n.mat, n.meta.tint || theme.panel)
      setCardFlip(n.mat, 'raw')
      n.fadeFrom = n.opacity
      n.fadeTo = 0.16
      n.fadeFromBlend = 0
      n.fadeToBlend = 0
      n.fadeStart = performance.now()
      this.form.kick()
    }
  }

  setBackground(hex: string): void {
    this.form.kick()
    this.background = hex
    this.isDark = luminance(hex) < 0.5
    this.scene.clearColor = Color4.FromHexString(hex + 'FF')
    paintBackdrop(this.backdropTex, hex)
    for (const n of this.nodes.values()) setCardTint(n.spinnerMat, this.isDark ? theme.ink : '#3a3a44')
    this.paintFrame(this.frameTex, false)
    this.paintFrame(this.rootFrameTex, true)
    this.paintReplyTexture()
    this.paintPlayTextures()
    const edge = Color3.FromHexString(shade(hex, this.isDark ? 0.3 : -0.3))
    for (const l of this.lineMeshes) l.color = edge
  }

  setup(
    assets: AssetCache,
    index: ThreadIndex,
    onOpenModel: (m: ThreadMeta) => void,
    onReply?: (m: ThreadMeta) => void,
  ): void {
    this.assets = assets
    this.index = index
    this.onOpenModel = onOpenModel
    this.onReply = onReply ?? null
  }

  private makeFrameTexture(name: string, root: boolean): DynamicTexture {
    const tex = new DynamicTexture(name, { width: 512, height: 320 }, this.scene, true)
    tex.hasAlpha = true
    this.paintFrame(tex, root)
    return tex
  }

  /**
   * Shared reply-pill texture: rounded pill + vector ↩ arrow and a tiny "+".
   * Same visual language as the board's reply badge (drawBadge in board.ts)
   * so "pill with arrow" reads as one concept: replies live here.
   */
  private paintReplyTexture(): void {
    const tex = this.replyTex
    const { width: w, height: h } = tex.getSize()
    const ctx = tex.getContext() as CanvasRenderingContext2D
    ctx.clearRect(0, 0, w, h)
    const dark = this.isDark
    const pad = Math.round(h * 0.08)
    const bw = w - pad * 2
    const bh = h - pad * 2
    ctx.fillStyle = dark ? 'rgba(12,12,14,0.62)' : 'rgba(250,250,252,0.72)'
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.30)' : 'rgba(0,0,0,0.28)'
    ctx.lineWidth = Math.max(2, h * 0.03)
    roundRect(ctx, pad, pad, bw, bh, bh / 2)
    ctx.fill()
    ctx.stroke()

    const ink = dark ? theme.ink : '#101014'
    const cy = h / 2
    // ↩ arrow (vector, same construction as the board badge)
    const ax = w * 0.40
    const s = bh * 0.30
    ctx.strokeStyle = ink
    ctx.lineWidth = Math.max(2.5, h * 0.05)
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
    // "+" — compose, not navigate (distinguishes it from the count badge)
    const px = w * 0.66
    const ps = bh * 0.22
    ctx.beginPath()
    ctx.moveTo(px - ps, cy); ctx.lineTo(px + ps, cy)
    ctx.moveTo(px, cy - ps); ctx.lineTo(px, cy + ps)
    ctx.stroke()
    tex.update()
  }

  /** Shared ▶/⏸ button textures (vector strokes, never font glyphs). */
  private paintPlayTextures(): void {
    const paint = (tex: DynamicTexture, playing: boolean): void => {
      const { width: w, height: h } = tex.getSize()
      const ctx = tex.getContext() as CanvasRenderingContext2D
      ctx.clearRect(0, 0, w, h)
      const dark = this.isDark
      const pad = Math.round(h * 0.07)
      const bw = w - pad * 2
      const bh = h - pad * 2
      ctx.fillStyle = dark ? 'rgba(12,12,14,0.62)' : 'rgba(250,250,252,0.72)'
      ctx.strokeStyle = dark ? 'rgba(255,255,255,0.30)' : 'rgba(0,0,0,0.28)'
      ctx.lineWidth = Math.max(2, h * 0.03)
      roundRect(ctx, pad, pad, bw, bh, bh * 0.28)
      ctx.fill()
      ctx.stroke()
      const ink = dark ? theme.ink : '#101014'
      const cx = w / 2
      const cy = h / 2
      const s = h * 0.24
      if (playing) {
        const barW = s * 0.34
        const gap = s * 0.24
        ctx.fillStyle = ink
        roundRect(ctx, cx - gap / 2 - barW, cy - s, barW, s * 2, barW * 0.45)
        ctx.fill()
        roundRect(ctx, cx + gap / 2, cy - s, barW, s * 2, barW * 0.45)
        ctx.fill()
      } else {
        ctx.fillStyle = ink
        ctx.beginPath()
        ctx.moveTo(cx - s * 0.5, cy - s)
        ctx.lineTo(cx - s * 0.5, cy + s)
        ctx.lineTo(cx + s * 0.92, cy)
        ctx.closePath()
        ctx.fill()
      }
      tex.update()
    }
    paint(this.playTexOff, false)
    paint(this.playTexOn, true)
  }

  /** Point a node's button at the right shared texture (▶ or ⏸). */
  private setPlayState(n: TNode, playing: boolean): void {
    setCardTexture(n.playMat, playing ? this.playTexOn : this.playTexOff)
  }

  /**
   * Should this node's ▶ button be visible? Only for posts that can animate
   * (poster-render knowledge or v3 hints), never for pool-rejected/static
   * posts, and never when livePreviews = 0 (a dead control).
   */
  private playButtonVisible(n: TNode): boolean {
    if (this.threeD) {
      return this.pool3d.isLive(n.meta.eventId) && this.pool3d.hasAnims(n.meta.eventId)
    }
    if (!n.poster) return false
    if (this.previewPool.isRejected(n.meta.eventId)) return false
    if (this.previewPool.opts.maxSlots <= 0) return false
    const animated = this.assets?.isAnimated(n.meta)
    return animated === true || (animated === undefined && (n.meta.animHint || n.meta.cameraCount > 0))
  }

  /**
   * Settings → Interface → "Autoplay animations" (same semantics as the
   * board): OFF freezes auto-started nodes, ON resumes them; user-started
   * plays and explicit pauses are always respected.
   */
  setAutoplay(on: boolean): void {
    if (this.autoplay === on) return
    this.autoplay = on
    if (this.threeD) {
      for (const n of this.nodes.values()) {
        const id = n.meta.eventId
        if (!this.pool3d.isLive(id) || !this.pool3d.hasAnims(id)) continue
        if (on && !this.pausedByUser.has(id) && !this.pool3d.isPlaying(id)) this.pool3d.play(id)
        else if (!on && !this.manualPlay.has(id) && this.pool3d.isPlaying(id)) this.pool3d.pause(id)
      }
      for (const n of this.nodes.values()) this.positionPlayButton(n)
      this.form.kick()
      return
    }
    for (const n of this.nodes.values()) {
      const id = n.meta.eventId
      if (!n.live) continue
      if (on && !this.pausedByUser.has(id) && !this.previewPool.isPlaying(id)) {
        this.previewPool.resume(id) // silent: autoplay never starts sound
      } else if (!on && !this.manualPlay.has(id) && this.previewPool.isPlaying(id)) {
        this.previewPool.pause(id)
      }
    }
    for (const n of this.nodes.values()) this.positionPlayButton(n)
    this.form.kick()
  }

  /**
   * Toggle "3D models" for the thread map (topbar button / settings →
   * Interface). ON replaces poster nodes with real GLB meshes rendered
   * directly in the map; OFF restores the poster pipeline.
   */
  setDirect3D(on: boolean): void {
    if (this.threeD === on) return
    const was = this.threeD
    this.threeD = on
    this.modeGen++ // invalidate in-flight poster jobs from the old mode
    // Free the pipeline we are leaving (never both resident at once).
    if (was) this.pool3d.releaseAll()
    else this.previewPool.releaseAll()
    for (const n of this.nodes.values()) {
      n.poster = null
      n.live = null
      if (on) {
        this.setNodeOpacityNow(n, 0)
        n.spinner.setEnabled(true)
        this.request3D(n)
      } else {
        this.setNodeOpacityNow(n, 0.16)
        this.drivePoster2D(n)
      }
      this.positionPlayButton(n)
    }
    this.form.kick()
  }

  /** 2D mode: render this node's poster (then its live preview, below). */
  private drivePoster2D(n: TNode): void {
    if (!this.assets) return
    const { meta, mesh, spinner } = n
    const gen = this.generation
    const modeGen = this.modeGen
    void this.assets.getPoster(meta).then((tex) => {
      // the map may have been cleared/reopened while the poster rendered
      if (!tex || gen !== this.generation || mesh.isDisposed()) return
      // the mode flipped while the poster rendered: a direct 3D model now
      // owns this node — the poster must not stack over/under it
      if (modeGen !== this.modeGen) return
      n.poster = tex
      this.crossfadeTo(n, tex, '#FFFFFF', 'rtt')
      spinner.setEnabled(false)
      this.positionPlayButton(n) // animatable posts reveal their ▶ now
      this.syncPreviews()
      this.form.kick()
    })
  }

  /** 3D mode: load this node's real model into the thread scene. */
  private request3D(n: TNode): void {
    if (!this.assets) return
    const meta = n.meta
    if (meta.hashFailed || this.assets.isHashFailed(meta.eventId)) return
    n.spinner.setEnabled(true)
    const ok = this.pool3d.request(meta.eventId, this.placeFor(n))
    if (!ok) {
      // Pool refused (rejected / over capacity): fall back to the poster.
      n.spinner.setEnabled(false)
      this.drivePoster2D(n)
    }
  }

  /** The node cell for a model, in thread-scene world units. z = 0 is the
   *  node plane; depth is capped so models stay clear of the frame plane. */
  private placeFor(n: TNode): Place3D {
    return {
      x: n.x, y: n.y, z: 0,
      w: n.w, h: n.h,
      depth: Math.min(n.w, n.h) * 0.4,
    }
  }

  /** True when a node's rect intersects the viewport, padded by `pad` screens. */
  private nodeInView(n: TNode, pad: number): boolean {
    const halfH = 20 * this.zoom * pad
    const halfW = halfH * this.aspect
    if (n.x + n.w / 2 < this.panX - halfW || n.x - n.w / 2 > this.panX + halfW) return false
    if (n.y + n.h / 2 < this.panY - halfH || n.y - n.h / 2 > this.panY + halfH) return false
    return true
  }

  /**
   * 3D-mode counterpart of syncPreviews(): load models only near the
   * viewport (AMENDMENT 43), release them once panned away, and apply the
   * autoplay / ▶ gating to the direct models.
   */
  private sync3D(): void {
    if (!this.assets) return
    const idle = this.pointers.size === 0
    for (const n of this.nodes.values()) {
      const id = n.meta.eventId
      const inView = this.nodeInView(n, 1.0)
      const near = this.nodeInView(n, 1.8)
      if (!near && this.pool3d.isLive(id)) {
        this.pool3d.release(id)
        continue
      }
      if (inView && idle && !this.pool3d.isLive(id) && !this.pool3d.isLoading(id) && !this.pool3d.isRejected(id)) {
        this.request3D(n)
        continue
      }
      if (this.pool3d.isLive(id) && this.pool3d.hasAnims(id)) {
        const manual = this.manualPlay.has(id)
        const auto = this.autoplay && !this.pausedByUser.has(id)
        if ((auto || manual) && !this.pool3d.isPlaying(id)) this.pool3d.play(id, manual)
        else if (!(auto || manual) && this.pool3d.isPlaying(id)) this.pool3d.pause(id)
      }
    }
  }

  /** Position + visibility + icon of a node's play button. */
  private positionPlayButton(n: TNode): void {
    const show = this.playButtonVisible(n) && !n.mesh.isDisposed()
    n.play.scaling.set(PLAY_W / 4, PLAY_H / 4, 1)
    n.play.position.set(n.x - n.w / 2 + PLAY_W / 2 + 0.35, n.y + n.h / 2 - PLAY_H / 2 - 0.28, -0.12)
    n.play.setEnabled(show)
    if (this.threeD) this.setPlayState(n, this.pool3d.isPlaying(n.meta.eventId))
    else if (n.live) this.setPlayState(n, this.previewPool.isPlaying(n.meta.eventId))
    else this.setPlayState(n, false)
  }

  private paintFrame(tex: DynamicTexture, root: boolean): void {
    const { width: w, height: h } = tex.getSize()
    const ctx = tex.getContext() as CanvasRenderingContext2D
    ctx.clearRect(0, 0, w, h)
    const dark = this.isDark
    const inset = 6
    roundRect(ctx, inset, inset, w - inset * 2, h - inset * 2, 22)
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.045)'
    ctx.fill()
    ctx.lineWidth = root ? 6 : 3
    ctx.strokeStyle = root ? theme.accent : (dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.22)')
    ctx.stroke()
    tex.update()
  }

  async open(rootId: string): Promise<void> {
    this.clear()
    this.generation++
    if (!this.spinObserver) {
      // stepped rotation of every visible loading ring + per-frame upkeep of
      // live node previews and the 120ms crossfades (see SPEC CARD).
      this.scene.onBeforeRenderObservable.add(() => {
        const now = performance.now()
        const phase = Math.floor(now / 85) * ((Math.PI * 2) / 12)
        for (const n of this.nodes.values()) {
          if (n.spinner.isEnabled()) n.spinner.rotation.z = -phase
          if (n.fadeStart) {
            const t = Math.min(1, (now - n.fadeStart) / 120)
            n.opacity = n.fadeFrom + (n.fadeTo - n.fadeFrom) * t
            setCardOpacity(n.mat, n.opacity)
            n.blend = n.fadeFromBlend + (n.fadeToBlend - n.fadeFromBlend) * t
            setCardBlend(n.mat, n.blend)
            if (t >= 1) this.finishNodeFade(n)
          }
        }
        this.syncPreviews()
        this.previewPool.tick(this.visibleNodeIds())
        this.sync3D()
        this.pool3d.tick(this.visibleNodeIds())
      })
      this.spinObserver = true
    }
    if (!this.assets || !this.index) return
    const metas = this.index.flatten(rootId).filter((m) => !m.hashFailed && !m.tombstoned)
    if (metas.length === 0) return
    // play-intent bookkeeping belongs to this tree: drop entries for posts
    // that are no longer part of it (the map rebuilt)
    const inTree = new Set(metas.map((m) => m.eventId))
    for (const id of [...this.manualPlay]) if (!inTree.has(id)) this.manualPlay.delete(id)
    for (const id of [...this.pausedByUser]) if (!inTree.has(id)) this.pausedByUser.delete(id)

    const pos = this.layout(metas, rootId)

    for (const meta of metas) {
      if (meta.hashFailed || meta.tombstoned) continue
      if (this.assets.isHashFailed(meta.eventId)) continue
      const p = pos.get(meta.eventId)
      if (!p) continue
      const root = meta.eventId === rootId
      const { w, h } = nodeSize(meta, root)

      const frame = MeshBuilder.CreatePlane(`tframe-${meta.eventId.slice(0, 8)}`, { width: 4, height: 4 }, this.scene)
      const frameMat = makeCardMaterial(this.scene)
      frame.material = frameMat
      setCardTexture(frameMat, root ? this.rootFrameTex : this.frameTex)
      setCardWhite(frameMat)
      setCardFlip(frameMat, 'dyn')
      frame.scaling.set((w + 0.5) / 4, (h + 0.5) / 4, 1)
      frame.position.set(p.x, p.y, 0.1)
      frame.isPickable = false

      const mesh = MeshBuilder.CreatePlane(`tnode-${meta.eventId.slice(0, 8)}`, { width: 4, height: 4 }, this.scene)
      const mat = makeCardMaterial(this.scene)
      mesh.material = mat
      setCardFlip(mat, 'raw')
      mesh.scaling.set(w / 4, h / 4, 1)
      mesh.position.set(p.x, p.y, 0)
      mesh.isPickable = true
      mesh.metadata = { tnode: meta }

      const spinner = MeshBuilder.CreatePlane(`tspin-${meta.eventId.slice(0, 8)}`, { width: 4, height: 4 }, this.scene)
      const spinnerMat = makeCardMaterial(this.scene)
      spinner.material = spinnerMat
      setCardTexture(spinnerMat, this.spinnerTex)
      setCardTint(spinnerMat, this.isDark ? theme.ink : '#3a3a44')
      setCardOpacity(spinnerMat, 0.75)
      setCardFlip(spinnerMat, 'dyn')
      const ring = Math.min(h * 0.34, w * 0.2)
      spinner.scaling.set(ring / 4, ring / 4, 1)
      spinner.position.set(p.x, p.y, -0.05)
      spinner.isPickable = false

      // reply pill, bottom-right, floating half out of the card like the
      // board badge; pickable and routed to the studio compose flow
      const reply = MeshBuilder.CreatePlane(`treply-${meta.eventId.slice(0, 8)}`, { width: 4, height: 4 }, this.scene)
      const replyMat = makeCardMaterial(this.scene)
      reply.material = replyMat
      setCardTexture(replyMat, this.replyTex)
      setCardWhite(replyMat)
      setCardFlip(replyMat, 'dyn')
      reply.scaling.set(REPLY_W / 4, REPLY_H / 4, 1)
      reply.position.set(p.x + w / 2 - REPLY_W / 2 + 0.35, p.y - h / 2 + REPLY_H * 0.28, -0.1)
      reply.isPickable = true
      reply.metadata = { treply: meta }
      // Corner overlays (reply pill + play button) must render above the node
      // they belong to: transparent meshes sort by bounding-sphere center
      // distance, so a corner-mounted pill can sort behind its own node and
      // be painted over by the node's opaque poster/live pixels. Group 1
      // renders after group 0 (nodes/backdrop) — always on top.
      reply.renderingGroupId = 1

      // ▶/⏸ play button, bottom-left (mirrors the reply pill); toggles this
      // node's animation + embedded sound. Picked in tapAt before the node.
      const play = MeshBuilder.CreatePlane(`tplay-${meta.eventId.slice(0, 8)}`, { width: 4, height: 4 }, this.scene)
      const playMat = makeCardMaterial(this.scene)
      play.material = playMat
      setCardTexture(playMat, this.playTexOff)
      setCardWhite(playMat)
      setCardFlip(playMat, 'dyn')
      play.isPickable = true
      play.metadata = { tplay: meta }
      play.renderingGroupId = 1 // same overlay pass as the reply pill

      setCardTint(mat, meta.tint || theme.panel)
      const node: TNode = {
        meta, mesh, mat, frame, frameMat, spinner, spinnerMat, reply, replyMat,
        play, playMat,
        poster: null, live: null, x: p.x, y: p.y, w, h, depth: p.depth,
        opacity: 0.16, fadeFrom: 0.16, fadeTo: 0.16, fadeStart: 0,
        blend: 0, fadeFromBlend: 0, fadeToBlend: 1, fadeTex2: null, fadeTint2Hex: '#FFFFFF', fadeFlip: 'raw',
      }
      this.setNodeOpacityNow(node, this.threeD ? 0 : 0.16)
      this.positionPlayButton(node)
      if (this.threeD) {
        node.spinner.setEnabled(true)
        this.request3D(node)
      } else {
        this.drivePoster2D(node)
      }

      this.nodes.set(meta.eventId, node)
    }

    for (const meta of metas) {
      const parentId = meta.refs.parentId
      if (parentId && this.nodes.has(parentId) && this.nodes.has(meta.eventId)) {
        this.edges.push({ parent: parentId, child: meta.eventId })
      }
    }
    this.buildEdges()
    this.fit()
  }

  /**
   * Tidy tree: x from consecutive leaf slots (parents centred over their
   * children), y from depth. No overlaps, no randomness, reads as a tree.
   */
  private layout(metas: ThreadMeta[], rootId: string): Map<string, { x: number; y: number; depth: number }> {
    const kids = new Map<string, string[]>()
    const known = new Set(metas.map((m) => m.eventId))
    for (const m of metas) {
      const pid = m.refs.parentId
      if (pid && known.has(pid) && pid !== m.eventId) {
        if (!kids.has(pid)) kids.set(pid, [])
        kids.get(pid)!.push(m.eventId)
      }
    }
    // stable order: oldest reply left
    const order = new Map(metas.map((m) => [m.eventId, m.createdAt]))
    for (const list of kids.values()) list.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))

    const out = new Map<string, { x: number; y: number; depth: number }>()
    let cursor = 0
    const step = NODE_W + GAP_X
    const walk = (id: string, depth: number, seen: Set<string>): number => {
      if (seen.has(id)) return cursor
      seen.add(id)
      const ch = kids.get(id) ?? []
      let x: number
      if (ch.length === 0) {
        x = cursor
        cursor += step
      } else {
        const xs = ch.map((c) => walk(c, depth + 1, seen))
        x = (xs[0] + xs[xs.length - 1]) / 2
      }
      out.set(id, { x, y: -depth * (NODE_H_REF + GAP_Y), depth })
      return x
    }
    walk(rootId, 0, new Set())
    // anything orphaned by a missing parent: park it on a trailing row
    for (const m of metas) {
      if (out.has(m.eventId)) continue
      out.set(m.eventId, { x: cursor, y: -(NODE_H_REF + GAP_Y), depth: 1 })
      cursor += step
    }
    // centre horizontally on the root
    const rx = out.get(rootId)?.x ?? 0
    for (const p of out.values()) p.x -= rx
    return out
  }

  /** Elbow connectors: down out of the parent, across, down into the child. */
  private buildEdges(): void {
    const color = Color3.FromHexString(shade(this.background, this.isDark ? 0.3 : -0.3))
    for (const e of this.edges) {
      const a = this.nodes.get(e.parent)
      const b = this.nodes.get(e.child)
      if (!a || !b) continue
      const y0 = a.y - a.h / 2
      const y1 = b.y + b.h / 2
      const mid = (y0 + y1) / 2
      const pts = Math.abs(a.x - b.x) < 0.01
        ? [new Vector3(a.x, y0, 0.15), new Vector3(b.x, y1, 0.15)]
        : [
            new Vector3(a.x, y0, 0.15),
            new Vector3(a.x, mid, 0.15),
            new Vector3(b.x, mid, 0.15),
            new Vector3(b.x, y1, 0.15),
          ]
      const line = MeshBuilder.CreateLines(`edge-${e.child.slice(0, 8)}`, { points: pts }, this.scene)
      line.color = color
      line.isPickable = false
      this.lineMeshes.push(line)
    }
  }

  // ------------------------------------------------------------- camera

  private get aspect(): number {
    const eng = this.scene.getEngine()
    return eng.getRenderWidth() / Math.max(1, eng.getRenderHeight())
  }

  private applyCamera(): void {
    this.form.kick()
    const z = this.zoom
    this.camera.orthoTop = 20 * z
    this.camera.orthoBottom = -20 * z
    this.camera.orthoLeft = -20 * z * this.aspect
    this.camera.orthoRight = 20 * z * this.aspect
    this.camera.target.set(this.panX, this.panY, 0)
    this.camera.position.set(this.panX, this.panY, -30)
    const halfW = 20 * z * this.aspect
    this.backdrop.scaling.set((halfW * 2 + 2) / 4, (20 * z * 2 + 2) / 4, 1)
    this.backdrop.position.set(this.panX, this.panY, 4)
    // zoom changed -> the sharpness a node needs changed -> rescale the RTTs
    this.applyPreviewScale()
    // viewport changed -> live previews must follow what is now on screen
    this.syncPreviews()
  }

  /** Frame the whole map with a margin. */
  fit(): void {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const n of this.nodes.values()) {
      minX = Math.min(minX, n.x - n.w / 2); maxX = Math.max(maxX, n.x + n.w / 2)
      minY = Math.min(minY, n.y - n.h / 2); maxY = Math.max(maxY, n.y + n.h / 2)
    }
    if (!isFinite(minX)) { minX = -10; maxX = 10; minY = -10; maxY = 10 }
    this.bounds = { minX, maxX, minY, maxY }
    const spanX = Math.max(8, maxX - minX) * 1.14
    const spanY = Math.max(8, maxY - minY) * 1.16
    const zx = spanX / (2 * 20 * this.aspect)
    const zy = spanY / (2 * 20)
    // never zoom a tiny thread in past 1:1-ish — two nodes should not fill
    // the screen like billboards
    this.zoom = Math.max(0.6, Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.max(zx, zy))))
    this.panX = (minX + maxX) / 2
    this.panY = (minY + maxY) / 2
    this.applyCamera()
  }

  /** Client px -> world units. */
  private worldAt(clientX: number, clientY: number): { x: number; y: number } {
    const canvas = this.scene.getEngine().getRenderingCanvas()
    const rect = canvas?.getBoundingClientRect()
    const w = rect?.width || 1
    const h = rect?.height || 1
    const fx = ((clientX - (rect?.left ?? 0)) / w) * 2 - 1
    const fy = 1 - ((clientY - (rect?.top ?? 0)) / h) * 2
    return { x: this.panX + fx * 20 * this.zoom * this.aspect, y: this.panY + fy * 20 * this.zoom }
  }

  /** World units per CSS pixel (vertical). */
  private unitsPerPx(): number {
    const canvas = this.scene.getEngine().getRenderingCanvas()
    const h = canvas?.getBoundingClientRect().height || 1
    return (2 * 20 * this.zoom) / h
  }

  private zoomAbout(clientX: number, clientY: number, factor: number): void {
    const before = this.worldAt(clientX, clientY)
    this.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoom * factor))
    this.applyCamera()
    const after = this.worldAt(clientX, clientY)
    this.panX += before.x - after.x
    this.panY += before.y - after.y
    this.clampPan()
    this.applyCamera()
  }

  /** Keep the map reachable: the content bbox may not leave the viewport. */
  private clampPan(): void {
    const halfH = 20 * this.zoom
    const halfW = halfH * this.aspect
    const b = this.bounds
    const padX = halfW * 0.7
    const padY = halfH * 0.7
    this.panX = Math.max(b.minX - padX, Math.min(b.maxX + padX, this.panX))
    this.panY = Math.max(b.minY - padY, Math.min(b.maxY + padY, this.panY))
  }

  /**
   * Input is bound to the CANVAS with native pointer events, not to
   * `scene.onPointerObservable`: Babylon's InputManager funnels touches
   * through `navigator.maxTouchPoints` device slots and silently drops the
   * second finger when the browser reports a low limit, which is why pinch
   * "wasn't supported". Native listeners see every pointer id.
   */
  attach(): void {
    if (this.attached) return
    const canvas = this.scene.getEngine().getRenderingCanvas()
    if (!canvas) return
    this.canvas = canvas
    canvas.addEventListener('pointerdown', this.onDown)
    canvas.addEventListener('pointermove', this.onMove)
    canvas.addEventListener('pointerup', this.onUp)
    canvas.addEventListener('pointercancel', this.onUp)
    canvas.addEventListener('pointerleave', this.onUp)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.attached = true
  }

  detach(): void {
    // Leaving the thread route: stop the live node previews AND dispose
    // their idle RTTs (the pool is capped by the shared livePreviews
    // budget; its slots are re-created lazily when the map reopens).
    this.previewPool.releaseAll()
    this.previewPool.prune()
    this.pool3d.releaseAll()
    const canvas = this.canvas
    if (!canvas) { this.attached = false; return }
    canvas.removeEventListener('pointerdown', this.onDown)
    canvas.removeEventListener('pointermove', this.onMove)
    canvas.removeEventListener('pointerup', this.onUp)
    canvas.removeEventListener('pointercancel', this.onUp)
    canvas.removeEventListener('pointerleave', this.onUp)
    canvas.removeEventListener('wheel', this.onWheel)
    this.pointers.clear()
    this.pinchDist = 0
    this.attached = false
  }

  private onDown = (ev: PointerEvent): void => {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY })
    if (this.pointers.size === 1) this.moved = 0
    if (this.pointers.size === 2) this.pinchDist = this.currentPinchDistance()
    try { this.canvas?.setPointerCapture(ev.pointerId) } catch { /* not capturable */ }
  }

  private onMove = (ev: PointerEvent): void => {
    const prev = this.pointers.get(ev.pointerId)
    if (!prev) return
    ev.preventDefault()
    const upx = this.unitsPerPx()
    if (this.pointers.size === 1) {
      // PAN: integrate the delta since the PREVIOUS move event. (The old code
      // measured from the pointer-down anchor on every move and added it to
      // the pan, so the map slid away on its own for as long as you held the
      // pointer down.)
      const dx = ev.clientX - prev.x
      const dy = ev.clientY - prev.y
      this.moved += Math.abs(dx) + Math.abs(dy)
      this.panX -= dx * upx
      this.panY += dy * upx
      this.clampPan()
      this.applyCamera()
      prev.x = ev.clientX
      prev.y = ev.clientY
      return
    }
    if (this.pointers.size >= 2) {
      const midBefore = this.pinchMid()
      const distBefore = this.currentPinchDistance()
      prev.x = ev.clientX
      prev.y = ev.clientY
      const midAfter = this.pinchMid()
      const distAfter = this.currentPinchDistance()
      this.moved += Math.abs(midAfter.x - midBefore.x) + Math.abs(midAfter.y - midBefore.y) + Math.abs(distAfter - distBefore)
      // two-finger drag pans
      this.panX -= (midAfter.x - midBefore.x) * upx
      this.panY += (midAfter.y - midBefore.y) * upx
      this.applyCamera()
      // spreading the fingers zooms in (smaller ortho extent)
      if (distBefore > 4 && distAfter > 4) this.zoomAbout(midAfter.x, midAfter.y, distBefore / distAfter)
      this.pinchDist = distAfter
    }
  }

  private onUp = (ev: PointerEvent): void => {
    const had = this.pointers.delete(ev.pointerId)
    if (this.pointers.size < 2) this.pinchDist = 0
    try { this.canvas?.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
    if (!had || this.pointers.size !== 0 || this.moved >= 8) return
    const rect = this.canvas?.getBoundingClientRect()
    this.tapAt(ev.clientX - (rect?.left ?? 0), ev.clientY - (rect?.top ?? 0))
  }

  private onWheel = (ev: WheelEvent): void => {
    ev.preventDefault()
    const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1
    this.zoomAbout(ev.clientX, ev.clientY, Math.exp((ev.deltaY || 0) * unit * 0.0016))
  }

  private currentPinchDistance(): number {
    const [a, b] = [...this.pointers.values()]
    if (!a || !b) return 0
    return Math.hypot(a.x - b.x, a.y - b.y)
  }

  private pinchMid(): { x: number; y: number } {
    const [a, b] = [...this.pointers.values()]
    if (!a || !b) return { x: 0, y: 0 }
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  }

  private tapAt(x: number, y: number): void {
    // reply pill first — it overlaps the card corner and must win the tap
    const reply = this.scene.pick(x, y, (m) => Boolean(m.metadata?.treply))
    if (reply?.hit && reply.pickedMesh?.metadata?.treply) {
      this.onReply?.(reply.pickedMesh.metadata.treply as ThreadMeta)
      return
    }
    // play button second — bottom-left corner, inside the node quad
    const play = this.scene.pick(x, y, (m) => Boolean(m.metadata?.tplay))
    if (play?.hit && play.pickedMesh?.metadata?.tplay) {
      this.togglePlay(play.pickedMesh.metadata.tplay as ThreadMeta)
      return
    }
    const pick = this.scene.pick(x, y, (m) => Boolean(m.metadata?.tnode))
    if (!pick?.hit || !pick.pickedMesh?.metadata?.tnode) return
    const meta = pick.pickedMesh.metadata.tnode as ThreadMeta
    this.onOpenModel?.(meta)
  }

  /**
   * The ▶/⏸ button on a node: toggle its live preview — animation AND the
   * model's embedded sound (a user gesture, so audio may start). Intent is
   * remembered per post so panning away and back keeps the choice.
   */
  private togglePlay(meta: ThreadMeta): void {
    const n = this.nodes.get(meta.eventId)
    if (!n) return
    const id = meta.eventId
    if (this.threeD) {
      if (this.pool3d.isPlaying(id)) {
        this.pool3d.pause(id)
        this.pausedByUser.add(id)
        this.manualPlay.delete(id)
      } else {
        this.pausedByUser.delete(id)
        this.manualPlay.add(id)
        this.pool3d.play(id, true)
      }
      this.positionPlayButton(n)
      this.form.kick()
      return
    }
    if (n.live && this.previewPool.isPlaying(id)) {
      this.previewPool.pause(id)
      this.pausedByUser.add(id)
      this.manualPlay.delete(id)
    } else {
      this.pausedByUser.delete(id)
      this.manualPlay.add(id)
      if (n.live) this.previewPool.resume(id, true)
      else this.previewPool.request(id, this.visibleNodeIds(), true)
    }
    this.positionPlayButton(n)
    this.form.kick()
  }

  resize(): void {
    this.applyCamera()
  }

  /** True when the open map currently has a node for this post. */
  hasNode(eventId: string): boolean { return this.nodes.has(eventId) }

  /**
   * Tear down one node (confirmed hash mismatch). Disposes the plate /
   * poster / live slot and rebuilds connectors. Does not bump `generation`
   * so in-flight posters for OTHER nodes can still land.
   */
  dropNode(eventId: string): void {
    const n = this.nodes.get(eventId)
    if (!n) return
    this.previewPool.release(eventId)
    this.pool3d.release(eventId)
    n.mesh.dispose(); n.mat.dispose(); n.frame.dispose(); n.frameMat.dispose()
    n.spinner.dispose(); n.spinnerMat.dispose()
    n.reply.dispose(); n.replyMat.dispose()
    n.play.dispose(); n.playMat.dispose()
    this.nodes.delete(eventId)
    this.edges = this.edges.filter((e) => e.parent !== eventId && e.child !== eventId)
    for (const l of this.lineMeshes) l.dispose()
    this.lineMeshes = []
    this.buildEdges()
    this.form.kick()
  }

  clear(): void {
    this.generation++
    this.previewPool.releaseAll()
    this.pool3d.releaseAll()
    for (const n of this.nodes.values()) {
      n.mesh.dispose(); n.mat.dispose(); n.frame.dispose(); n.frameMat.dispose()
      n.spinner.dispose(); n.spinnerMat.dispose()
      n.reply.dispose(); n.replyMat.dispose()
      n.play.dispose(); n.playMat.dispose()
    }
    this.nodes.clear()
    for (const l of this.lineMeshes) l.dispose()
    this.lineMeshes = []
    this.edges = []
    this.pointers.clear()
    this.panX = 0
    this.panY = 0
    this.zoom = 1
    this.applyCamera()
  }

  dispose(): void {
    this.detach()
    this.clear()
    this.previewPool.dispose()
    this.pool3d.dispose()
    this.scene.dispose()
  }
}
