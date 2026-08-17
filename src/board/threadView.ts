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
import type { FormEngine } from '../core/engine'
import type { AssetCache } from '../core/assets'
import type { ThreadIndex, ThreadMeta } from '../protocol/thread-index'
import {
  makeCardMaterial, setCardTexture, setCardTint, setCardWhite, setCardFlip, setCardOpacity,
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
  x: number
  y: number
  w: number
  h: number
  depth: number
}

interface TEdge { parent: string; child: string }

const NODE_W = 6.4
const NODE_H = 4.0 // 16:10
const ROOT_SCALE = 1.28
const GAP_X = 2.2
const GAP_Y = 4.6
const ZOOM_MIN = 0.12
const ZOOM_MAX = 6

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
  private form: FormEngine
  private rootFrameTex: DynamicTexture
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

  constructor(engine: FormEngine) {
    this.form = engine
    this.scene = new Scene(engine.engine)
    this.scene.clearColor = Color4.FromHexString(this.background + 'FF')
    this.scene.skipPointerMovePicking = true

    // PERF: thread map animates only while node spinners are visible;
    // pan/zoom redraws come from input kicks.
    engine.addAnimationSource(() =>
      engine.activeScene === this.scene &&
      [...this.nodes.values()].some((n) => n.spinner.isEnabled()))
    this.camera = flatCamera(this.scene, 'thread-cam', 30)

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

    this.applyCamera()
  }

  setBackground(hex: string): void {
    this.form?.kick()
    this.background = hex
    this.isDark = luminance(hex) < 0.5
    this.scene.clearColor = Color4.FromHexString(hex + 'FF')
    paintBackdrop(this.backdropTex, hex)
    for (const n of this.nodes.values()) setCardTint(n.spinnerMat, this.isDark ? theme.ink : '#3a3a44')
    this.paintFrame(this.frameTex, false)
    this.paintFrame(this.rootFrameTex, true)
    const edge = Color3.FromHexString(shade(hex, this.isDark ? 0.3 : -0.3))
    for (const l of this.lineMeshes) l.color = edge
  }

  setup(assets: AssetCache, index: ThreadIndex, onOpenModel: (m: ThreadMeta) => void): void {
    this.assets = assets
    this.index = index
    this.onOpenModel = onOpenModel
  }

  private makeFrameTexture(name: string, root: boolean): DynamicTexture {
    const tex = new DynamicTexture(name, { width: 512, height: 320 }, this.scene, true)
    tex.hasAlpha = true
    this.paintFrame(tex, root)
    return tex
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
    this.form.kick(1000)
    this.clear()
    this.generation++
    if (!this.spinObserver) {
      // stepped rotation of every visible loading ring
      this.scene.onBeforeRenderObservable.add(() => {
        const phase = Math.floor(performance.now() / 85) * ((Math.PI * 2) / 12)
        for (const n of this.nodes.values()) if (n.spinner.isEnabled()) n.spinner.rotation.z = -phase
      })
      this.spinObserver = true
    }
    if (!this.assets || !this.index) return
    const metas = this.index.flatten(rootId)
    if (metas.length === 0) return

    const pos = this.layout(metas, rootId)

    for (const meta of metas) {
      const p = pos.get(meta.eventId)
      if (!p) continue
      const root = meta.eventId === rootId
      const w = root ? NODE_W * ROOT_SCALE : NODE_W
      const h = root ? NODE_H * ROOT_SCALE : NODE_H

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

      setCardTint(mat, meta.tint || theme.panel)
      setCardOpacity(mat, 0.16)
      const gen = this.generation
      void this.assets.getPoster(meta).then((tex) => {
        // the map may have been cleared/reopened while the poster rendered
        if (!tex || gen !== this.generation || mesh.isDisposed()) return
        setCardTexture(mat, tex)
        setCardWhite(mat)
        setCardOpacity(mat, 1)
        spinner.setEnabled(false)
        this.form.kick() // poster arrived; redraw the (possibly static) map
      })

      this.nodes.set(meta.eventId, { meta, mesh, mat, frame, frameMat, spinner, spinnerMat, x: p.x, y: p.y, w, h, depth: p.depth })
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
      out.set(id, { x, y: -depth * (NODE_H + GAP_Y), depth })
      return x
    }
    walk(rootId, 0, new Set())
    // anything orphaned by a missing parent: park it on a trailing row
    for (const m of metas) {
      if (out.has(m.eventId)) continue
      out.set(m.eventId, { x: cursor, y: -(NODE_H + GAP_Y), depth: 1 })
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
  }

  /** Frame the whole map with a margin. */
  fit(): void {
    this.form?.kick()
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
    const pick = this.scene.pick(x, y, (m) => Boolean(m.metadata?.tnode))
    if (!pick?.hit || !pick.pickedMesh?.metadata?.tnode) return
    const meta = pick.pickedMesh.metadata.tnode as ThreadMeta
    this.onOpenModel?.(meta)
  }

  resize(): void {
    this.applyCamera()
  }

  clear(): void {
    this.generation++
    for (const n of this.nodes.values()) {
      n.mesh.dispose(); n.mat.dispose(); n.frame.dispose(); n.frameMat.dispose()
      n.spinner.dispose(); n.spinnerMat.dispose()
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
    this.scene.dispose()
  }
}
