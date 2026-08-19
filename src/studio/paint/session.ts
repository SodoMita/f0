import type { Scene } from '@babylonjs/core/scene'
import type { Camera } from '@babylonjs/core/Cameras/camera'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Ray } from '@babylonjs/core/Culling/ray'
import '@babylonjs/core/Culling/ray'
import { StampStore } from './store'
import { SpatialHash } from './hash'
import { History, type Command } from './history'
import { PaintInstances } from './instances'
import { PaintPlane } from './plane'
import { bakeStamps } from './bake'
import { walkGrid, rayPlane } from './dda'
import {
  defaultPaintOpts, snapToGrid, stampRadius, GRID,
  type PaintOpts, type PaintToolKind, type Stamp,
} from './types'
import {
  alphaFromPressure, effectivePressure, smoothPath, speedTaper,
  stampAlong, tangentAt, widthFromPressure, type InkPoint,
} from './stroke'
import { IDENTITY_QUAT, quatAlign, quatCylinder, quatFacing, type Quat, type Vec3 } from './math'

export class PaintSession {
  readonly store = new StampStore()
  readonly hash = new SpatialHash()
  readonly history = new History()
  readonly opts: PaintOpts = defaultPaintOpts()
  readonly instances: PaintInstances
  readonly plane: PaintPlane
  onChange: (() => void) | null = null

  private active = false
  private stroking = false
  private raw: InkPoint[] = []
  private carry = 0
  private strokeAdded: Stamp[] = []
  private strokeRemoved: Stamp[] = []
  private planePoint: Vec3 = [0, 0, 0]
  private planeNormal: Vec3 = [0, 0, 1]
  private locked = false
  private pointerId = -1
  private selectedId = -1
  private canvas: HTMLCanvasElement | null = null
  private readonly boundDown: (e: PointerEvent) => void
  private readonly boundMove: (e: PointerEvent) => void
  private readonly boundUp: (e: PointerEvent) => void

  constructor(
    private readonly scene: Scene,
    private readonly kick: (ms?: number) => void,
    private readonly getCamera: () => Camera,
  ) {
    this.instances = new PaintInstances(scene)
    this.plane = new PaintPlane(scene)
    this.boundDown = (e) => this.onDown(e)
    this.boundMove = (e) => this.onMove(e)
    this.boundUp = (e) => this.onUp(e)
    scene.onBeforeRenderObservable.add(() => this.instances.flush(this.store))
  }

  get count(): number { return this.store.count }
  get isActive(): boolean { return this.active }
  isStroking(): boolean { return this.stroking }
  isPaintMesh(m: AbstractMesh | null): boolean { return this.instances.isSource(m) }
  sourceMeshes(): Mesh[] { return this.instances.sourceMeshes() }
  get selected(): number { return this.selectedId }

  setActive(on: boolean): void {
    this.active = on
    this.plane.setVisible(on && !this.opts.surface)
    if (!on) this.endStroke()
    this.kick(200)
  }

  attach(canvas: HTMLCanvasElement): void {
    if (this.canvas === canvas) return
    this.detach()
    this.canvas = canvas
    canvas.addEventListener('pointerdown', this.boundDown)
    canvas.addEventListener('pointermove', this.boundMove)
    canvas.addEventListener('pointerup', this.boundUp)
    canvas.addEventListener('pointercancel', this.boundUp)
  }

  detach(): void {
    if (!this.canvas) return
    this.canvas.removeEventListener('pointerdown', this.boundDown)
    this.canvas.removeEventListener('pointermove', this.boundMove)
    this.canvas.removeEventListener('pointerup', this.boundUp)
    this.canvas.removeEventListener('pointercancel', this.boundUp)
    this.canvas = null
    this.endStroke()
  }

  setOpts(patch: Partial<PaintOpts>): void {
    Object.assign(this.opts, patch)
    if (patch.surface !== undefined || patch.tool !== undefined) {
      this.plane.setVisible(this.active && !this.opts.surface)
    }
    this.kick(120)
  }

  setTool(tool: PaintToolKind): void { this.setOpts({ tool }) }

  clear(): void {
    this.endStroke()
    this.store.clear()
    this.hash.clear()
    this.history.clear()
    this.selectedId = -1
    this.instances.markDirty()
    this.kick(200)
    this.onChange?.()
  }

  undo(): boolean {
    const ok = this.history.undo()
    if (ok) { this.instances.markDirty(); this.kick(200); this.onChange?.() }
    return ok
  }

  redo(): boolean {
    const ok = this.history.redo()
    if (ok) { this.instances.markDirty(); this.kick(200); this.onChange?.() }
    return ok
  }

  deleteSelection(): boolean {
    if (this.selectedId < 0) return false
    const s = this.store.removeId(this.selectedId)
    this.selectedId = -1
    if (!s) return false
    this.hash.remove(s.id)
    this.pushInverse([s], [])
    this.instances.markDirty()
    this.kick(200)
    this.onChange?.()
    return true
  }

  /** Headless / test path: world-space stroke, same machinery as the pen. */
  drawStroke(points: InkPoint[]): number {
    if (!points.length) return 0
    this.beginStroke()
    this.planePoint = [points[0].x, points[0].y, points[0].z]
    this.planeNormal = [0, 0, 1]
    this.locked = true
    this.feed(points[0], true)
    for (let i = 1; i < points.length; i++) this.feed(points[i], false)
    const n = this.strokeAdded.length
    this.endStroke()
    return n
  }

  eraseAt(x: number, y: number, z: number, radius: number): number {
    const ids = this.collectErase(x, y, z, radius)
    const removed = this.store.removeIds(ids)
    for (const s of removed) this.hash.remove(s.id)
    if (removed.length) {
      this.pushInverse(removed, [])
      this.instances.markDirty()
      this.kick(200)
      this.onChange?.()
    }
    return removed.length
  }

  bake(): Mesh[] {
    this.instances.flush(this.store)
    return bakeStamps(this.scene, this.store, this.instances.meshes)
  }

  dispose(): void {
    this.detach()
    this.clear()
    this.instances.dispose()
    this.plane.dispose()
  }

  pickColorAt(clientX: number, clientY: number): Stamp | null {
    const hit = this.pickStamp(clientX, clientY)
    if (!hit) return null
    this.opts.color = [hit.r, hit.g, hit.b, hit.a]
    this.opts.shape = hit.shape
    return hit
  }

  selectAt(clientX: number, clientY: number): number {
    const hit = this.pickStamp(clientX, clientY)
    this.selectedId = hit?.id ?? -1
    this.kick(120)
    return this.selectedId
  }

  private onDown(e: PointerEvent): void {
    if (!this.active || e.button !== 0) return
    if (this.opts.tool === 'select') { this.selectAt(e.clientX, e.clientY); return }
    if (this.opts.tool === 'picker') { this.pickColorAt(e.clientX, e.clientY); this.onChange?.(); return }
    e.preventDefault()
    try { this.canvas?.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    this.pointerId = e.pointerId
    this.beginStroke()
    const pt = this.hitFromEvent(e)
    if (pt) this.feed(pt, true)
  }

  private onMove(e: PointerEvent): void {
    if (!this.stroking || e.pointerId !== this.pointerId) return
    const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e]
    for (const ev of evs) {
      const pt = this.hitFromEvent(ev)
      if (pt) this.feed(pt, false)
    }
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerId !== this.pointerId && this.pointerId !== -1) return
    try { this.canvas?.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
    this.endStroke()
  }

  private beginStroke(): void {
    this.stroking = true
    this.raw = []
    this.carry = 0
    this.strokeAdded = []
    this.strokeRemoved = []
    this.locked = false
  }

  private endStroke(): void {
    if (!this.stroking) return
    this.stroking = false
    this.pointerId = -1
    if (this.strokeAdded.length || this.strokeRemoved.length) {
      this.pushInverse(this.strokeRemoved.slice(), this.strokeAdded.slice())
      this.onChange?.()
    }
    this.strokeAdded = []
    this.strokeRemoved = []
    this.raw = []
  }

  private feed(pt: InkPoint, first: boolean): void {
    this.raw.push(pt)
    const smooth = smoothPath(this.raw, 3)
    if (this.opts.tool === 'eraser') {
      this.eraseAlong(smooth, first)
      return
    }
    if (first) {
      this.place(pt, [1, 0, 0])
      this.carry = 0
      return
    }
    const width = widthFromPressure(pt.pressure, this.opts.size)
    const spacing = Math.max(0.01, width * this.opts.spacing)
    // Only the newest segment — re-walking the whole polyline would
    // restamp already-emitted ink (carry is leftover on THIS stroke).
    const tail = smooth.slice(-2)
    const { emitted, carry } = stampAlong(tail, spacing, this.carry)
    this.carry = carry
    for (const p of emitted) {
      const prev = this.raw[this.raw.length - 2] ?? p
      this.place(p, tangentAt(prev, p))
    }
  }

  private place(pt: InkPoint, tangent: Vec3): void {
    if (this.store.count >= 50_000) return
    let x = pt.x, y = pt.y, z = pt.z
    if (this.opts.snap) {
      x = snapToGrid(x); y = snapToGrid(y); z = snapToGrid(z)
    }
    if (this.opts.jitter > 0) {
      const j = this.opts.jitter * this.opts.size
      x += (Math.random() * 2 - 1) * j
      y += (Math.random() * 2 - 1) * j
    }
    const w = widthFromPressure(pt.pressure, this.opts.size) * (0.55 + 0.45 * speedTaper(0.02, 8))
    const a = alphaFromPressure(pt.pressure, this.opts.color[3])
    const [qx, qy, qz, qw] = this.orient(tangent)
    const flat = this.opts.flatten
    const s: Omit<Stamp, 'id'> = {
      shape: this.opts.shape,
      px: x, py: y, pz: z,
      qx, qy, qz, qw,
      sx: w, sy: w * flat, sz: w,
      r: this.opts.color[0], g: this.opts.color[1], b: this.opts.color[2], a,
    }
    if (this.opts.shape === 'sphere') { s.sy = w; s.qx = 0; s.qy = 0; s.qz = 0; s.qw = 1 }
    if (this.opts.shape === 'quad') { s.sy = w; s.sz = 0.02 }
    const added = this.store.add(s)
    this.hash.insert(added)
    this.strokeAdded.push(added)
    this.instances.markDirty()
    this.kick(80)
  }

  private eraseAlong(pts: InkPoint[], first: boolean): void {
    const r = this.opts.size * 0.7
    const run = first ? pts.slice(0, 1) : pts.slice(-2)
    for (const p of run) {
      for (const id of this.collectErase(p.x, p.y, p.z, r)) {
        if (this.strokeRemoved.some((s) => s.id === id)) continue
        const rem = this.store.removeId(id)
        if (!rem) continue
        this.hash.remove(id)
        this.strokeRemoved.push(rem)
      }
    }
    if (run.length >= 2) {
      const a = run[0], b = run[run.length - 1]
      walkGrid([a.x, a.y, a.z], [b.x - a.x, b.y - a.y, b.z - a.z], GRID, Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) + r, (ix, iy, iz) => {
        for (const id of this.hash.idsInCell(ix, iy, iz)) {
          if (this.strokeRemoved.some((s) => s.id === id)) continue
          const st = this.store.get(id)
          if (!st) continue
          const d = Math.hypot(st.px - b.x, st.py - b.y, st.pz - b.z)
          if (d > r + stampRadius(st)) continue
          const rem = this.store.removeId(id)
          if (!rem) continue
          this.hash.remove(id)
          this.strokeRemoved.push(rem)
        }
        return true
      })
    }
    this.instances.markDirty()
    this.kick(80)
  }

  private collectErase(x: number, y: number, z: number, radius: number): number[] {
    const ids: number[] = []
    for (const id of this.hash.query(x, y, z, radius + this.opts.size)) {
      const s = this.store.get(id)
      if (!s) continue
      if (Math.hypot(s.px - x, s.py - y, s.pz - z) <= radius + stampRadius(s)) ids.push(id)
    }
    return ids
  }

  private orient(tangent: Vec3): Quat {
    if (!this.opts.align) return IDENTITY_QUAT
    const n = this.planeNormal
    switch (this.opts.shape) {
      case 'cylinder': return quatCylinder(tangent)
      case 'quad': return quatFacing(n, tangent)
      case 'sphere': return IDENTITY_QUAT
      default: return quatAlign(tangent, n)
    }
  }

  private hitFromEvent(e: PointerEvent): InkPoint | null {
    const hit = this.worldHit(e.clientX, e.clientY)
    if (!hit) return null
    return {
      x: hit[0], y: hit[1], z: hit[2],
      pressure: effectivePressure(e.pressure, e.pointerType),
      t: e.timeStamp || performance.now(),
    }
  }

  private worldHit(clientX: number, clientY: number): Vec3 | null {
    const ray = this.screenRay(clientX, clientY)
    if (!ray) return null
    const origin: Vec3 = [ray.origin.x, ray.origin.y, ray.origin.z]
    const dir: Vec3 = [ray.direction.x, ray.direction.y, ray.direction.z]
    if (this.locked && this.opts.depthLock) {
      return rayPlane(origin, dir, this.planePoint, this.planeNormal)
    }
    if (this.opts.surface) {
      const pred = (m: AbstractMesh) => !this.plane.mesh || m !== this.plane.mesh
      const pick = this.scene.pickWithRay(ray, pred)
      if (pick?.hit && pick.pickedPoint) {
        const n = pick.getNormal(true) ?? new Vector3(0, 0, 1)
        const p: Vec3 = [pick.pickedPoint.x, pick.pickedPoint.y, pick.pickedPoint.z]
        const nn: Vec3 = [n.x, n.y, n.z]
        this.planePoint = p
        this.planeNormal = nn
        this.locked = true
        const half = this.opts.size * 0.5
        return [p[0] + nn[0] * half, p[1] + nn[1] * half, p[2] + nn[2] * half]
      }
    }
    const p = rayPlane(origin, dir, [0, 0, 0], [0, 0, 1])
    if (!p) return null
    this.planePoint = p
    this.planeNormal = [0, 0, 1]
    this.locked = true
    return p
  }

  private screenRay(clientX: number, clientY: number): Ray | null {
    const canvas = this.canvas ?? this.scene.getEngine().getRenderingCanvas()
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    return this.scene.createPickingRay(x, y, Matrix.Identity(), this.getCamera())
  }

  private pickStamp(clientX: number, clientY: number): Stamp | null {
    const canvas = this.canvas ?? this.scene.getEngine().getRenderingCanvas()
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    const pick = this.scene.pick(x, y, (m) => this.instances.isSource(m))
    if (!pick?.hit || pick.thinInstanceIndex === undefined || pick.thinInstanceIndex < 0) return null
    const mesh = pick.pickedMesh
    if (!mesh) return null
    const shape = mesh.name.replace('studio-paint-', '') as Stamp['shape']
    let seen = 0
    for (let i = 0; i < this.store.count; i++) {
      const s = this.store.at(i)
      if (s.shape !== shape) continue
      if (seen === pick.thinInstanceIndex) return s
      seen++
    }
    return null
  }

  private pushInverse(removed: Stamp[], added: Stamp[]): void {
    const store = this.store
    const hash = this.hash
    const cmd: Command = {
      label: added.length && removed.length ? 'stroke' : removed.length ? 'erase' : 'paint',
      undo: () => {
        for (const s of added) { store.removeId(s.id); hash.remove(s.id) }
        for (const s of removed) { const n = store.add(s); hash.insert(n) }
      },
      redo: () => {
        for (const s of removed) { store.removeId(s.id); hash.remove(s.id) }
        for (const s of added) { const n = store.add(s); hash.insert(n) }
      },
    }
    this.history.push(cmd)
  }
}
