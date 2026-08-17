import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { PointerEventTypes, PointerInfo } from '@babylonjs/core/Events/pointerEvents'
// Side-effect import for scene.pick (00 §3.7).
import '@babylonjs/core/Culling/ray'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import type { FormEngine } from '../core/engine'
import type { AssetCache } from '../core/assets'
import type { ThreadIndex, ThreadMeta } from '../protocol/thread-index'
import { makeCardMaterial, setCardTexture, setCardTint, setCardWhite, setCardFlip } from './cardMaterial'
import type { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial'
import { theme } from '../theme'

interface TNode {
  meta: ThreadMeta
  mesh: Mesh
  mat: ShaderMaterial
  x: number
  y: number
  fixed: boolean
}

interface TEdge { parent: string; child: string }

const ROOT_SIZE = 6.5
const NODE_W = 4.4
const NODE_H = 2.75 // 16:10

/**
 * Thread view: a 2D map of the reply tree. Nodes are card planes (poster or
 * tint), edges are lines parent->child, laid out by a Fruchterman-Reingold
 * force relaxation (repulsion between nodes, spring along edges) so branches
 * spread like a tree. Pan = drag, zoom = wheel, tap = open viewer.
 */
export class ThreadView {
  readonly scene: Scene
  private camera: ArcRotateCamera
  private nodes = new Map<string, TNode>()
  private edges: TEdge[] = []
  private lineMeshes: Mesh[] = []
  private assets: AssetCache | null = null
  private index: ThreadIndex | null = null
  private onOpenModel: ((m: ThreadMeta) => void) | null = null
  private panX = 0
  private panY = 0
  private zoom = 1
  private dragging = false
  private moved = 0
  private downX = 0
  private downY = 0

  constructor(engine: FormEngine) {
    this.scene = new Scene(engine.engine)
    this.scene.clearColor = Color4.FromHexString(theme.background + 'FF')
    this.camera = new ArcRotateCamera('thread-cam', Math.PI / 2, Math.PI / 2, 30, Vector3.Zero(), this.scene)
    this.camera.mode = ArcRotateCamera.ORTHOGRAPHIC_CAMERA
    this.camera.inputs.clear()
    this.camera.detachControl()
    this.scene.activeCamera = this.camera
    this.bindInput()
    this.applyZoom()
  }

  setBackground(hex: string): void {
    this.scene.clearColor = Color4.FromHexString(hex + 'FF')
  }

  setup(assets: AssetCache, index: ThreadIndex, onOpenModel: (m: ThreadMeta) => void): void {
    this.assets = assets
    this.index = index
    this.onOpenModel = onOpenModel
  }

  async open(rootId: string): Promise<void> {
    this.clear()
    if (!this.assets || !this.index) return
    const metas = this.index.flatten(rootId)
    if (metas.length === 0) return

    // Build node planes.
    for (const meta of metas) {
      const mesh = MeshBuilder.CreatePlane(`tnode-${meta.eventId.slice(0, 8)}`, { width: 4, height: 4 }, this.scene)
      const mat = makeCardMaterial(this.scene)
      mesh.material = mat
      setCardFlip(mat, 'raw')
      const root = meta.eventId === rootId
      const size = root ? ROOT_SIZE : NODE_W
      mesh.scaling.set(size / 4, (root ? ROOT_SIZE : NODE_H) / 4, 1)
      mesh.position.z = 0
      mesh.isPickable = true
      mesh.metadata = { tnode: meta }
      this.nodes.set(meta.eventId, { meta, mesh, mat, x: 0, y: 0, fixed: meta.eventId === rootId })

      // Poster if available, else tinted plate.
      setCardTint(mat, meta.tint || theme.panel)
      void this.assets.getPoster(meta).then((tex) => {
        if (!tex) return
        setCardTexture(mat, tex)
        setCardWhite(mat)
      })
    }

    // Edges.
    for (const meta of metas) {
      const parentId = meta.refs.parentId
      if (parentId && this.nodes.has(parentId)) this.edges.push({ parent: parentId, child: meta.eventId })
    }

    // Force-relaxed layout, then apply.
    const pos = this.relax(metas, rootId)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const meta of metas) {
      const p = pos.get(meta.eventId)!
      const node = this.nodes.get(meta.eventId)!
      node.x = p.x
      node.y = p.y
      node.mesh.position.set(p.x, p.y, 0)
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
    }
    this.buildLines()
    // Fit the whole map in view (with margin) instead of a fixed zoom.
    const spanX = Math.max(8, maxX - minX + NODE_W)
    const spanY = Math.max(8, maxY - minY + NODE_H)
    const aspect = this.scene.getEngine().getRenderWidth() / Math.max(1, this.scene.getEngine().getRenderHeight())
    const zx = spanX / (2 * 20 * aspect)
    const zy = spanY / (2 * 20)
    this.zoom = Math.max(0.4, Math.min(4, Math.max(zx, zy) * 1.25))
    this.panX = 0
    this.panY = 0
    this.applyZoom()
  }

  /** Fruchterman-Reingold force relaxation over the tree. */
  private relax(metas: ThreadMeta[], rootId: string): Map<string, { x: number; y: number }> {
    const n = metas.length
    const pos = new Map<string, { x: number; y: number }>()

    // Initial placement: root at center, children fanned out below parent by
    // subtree width (simple DFS with leaf counting).
    const kids = new Map<string, string[]>()
    for (const m of metas) {
      const pid = m.refs.parentId
      if (pid) {
        if (!kids.has(pid)) kids.set(pid, [])
        kids.get(pid)!.push(m.eventId)
      }
    }
    const parentOf = new Map<string, string>()
    for (const m of metas) {
      const pid = m.refs.parentId
      if (pid && kids.has(pid)) parentOf.set(m.eventId, pid)
    }
    const leafCount = new Map<string, number>()
    const countLeaves = (id: string): number => {
      const ch = kids.get(id) ?? []
      if (ch.length === 0) { leafCount.set(id, 1); return 1 }
      let s = 0
      for (const c of ch) s += countLeaves(c)
      leafCount.set(id, s)
      return s
    }
    countLeaves(rootId)

    // Tree cone: the whole reply tree must fan out within an aperture of
    // < 90° (≈ ±42° from the vertical) so it reads as a tree, not a hedge.
    // The DFS fan width is capped by depth: per level a child may sit at most
    // tan(42°)*LEVEL_GAP to the side of its parent, and the relaxation pass
    // re-clamps every node to that cone (see below).
    const LEVEL_GAP = 4.2
    const depthOf = (id: string, d = 0): number => {
      const ch = kids.get(id) ?? []
      if (ch.length === 0) return d
      return Math.max(...ch.map((c) => depthOf(c, d + 1)))
    }
    const maxDepth = Math.max(1, depthOf(rootId))
    const coneLimit = 0.92 * LEVEL_GAP // ≈ tan(42.6°) * gap
    const level = new Map<string, number>()
    const place = (id: string, cx: number, cy: number, width: number, lvl: number): void => {
      pos.set(id, { x: cx, y: cy })
      level.set(id, lvl)
      const ch = kids.get(id) ?? []
      if (ch.length === 0) return
      const total = leafCount.get(id) ?? 1
      let x = cx - width / 2
      for (const c of ch) {
        const w = ((leafCount.get(c) ?? 1) / total) * width
        place(c, x + w / 2, cy - LEVEL_GAP, w, lvl + 1)
        x += w
      }
    }
    place(rootId, 0, 0, Math.min(n * 5, 2 * coneLimit * maxDepth), 0)

    // Force relaxation.
    const area = n * 46
    const k = Math.sqrt(area / n)
    let temp = k * 1.5
    for (let iter = 0; iter < 300; iter++) {
      // repulsion (all pairs)
      const disp = new Map<string, { dx: number; dy: number }>()
      for (const id of pos.keys()) disp.set(id, { dx: 0, dy: 0 })
      const ids = [...pos.keys()]
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = pos.get(ids[i])!
          const b = pos.get(ids[j])!
          let dx = a.x - b.x
          let dy = a.y - b.y
          let d = Math.sqrt(dx * dx + dy * dy)
          if (d < 0.01) { dx = (Math.random() - 0.5) * 0.1; dy = (Math.random() - 0.5) * 0.1; d = 0.01 }
          const f = (k * k) / d
          const fx = (dx / d) * f
          const fy = (dy / d) * f
          disp.get(ids[i])!.dx += fx
          disp.get(ids[i])!.dy += fy
          disp.get(ids[j])!.dx -= fx
          disp.get(ids[j])!.dy -= fy
        }
      }
      // attraction along edges
      for (const e of this.edges) {
        const a = pos.get(e.parent)
        const b = pos.get(e.child)
        if (!a || !b) continue
        const dx = a.x - b.x
        const dy = a.y - b.y
        const d = Math.max(0.01, Math.sqrt(dx * dx + dy * dy))
        const f = (d * d) / k
        const fx = (dx / d) * f
        const fy = (dy / d) * f
        disp.get(e.parent)!.dx -= fx
        disp.get(e.parent)!.dy -= fy
        disp.get(e.child)!.dx += fx
        disp.get(e.child)!.dy += fy
      }
      // apply with temperature cap; root stays fixed; keep the cone AND
      // keep every node below its parent so the map reads as a tree
      for (const id of ids) {
        if (id === rootId) continue
        const d = disp.get(id)!
        const len = Math.sqrt(d.dx * d.dx + d.dy * d.dy)
        if (len < 1e-6) continue
        const step = Math.min(len, temp)
        const p = pos.get(id)!
        p.x += (d.dx / len) * step
        p.y += (d.dy / len) * step
        const lim = coneLimit * (level.get(id) ?? 0)
        p.x = Math.max(-lim, Math.min(lim, p.x))
        const pid = parentOf.get(id)
        if (pid) {
          const pp = pos.get(pid)!
          p.y = Math.min(p.y, pp.y - 4.3) // strictly below the parent, matching the cone slope
        }
      }
      temp *= 0.94
    }

    // Center the map on the root and clamp its spread.
    const root = pos.get(rootId)!
    for (const id of pos.keys()) {
      pos.get(id)!.x -= root.x
      pos.get(id)!.y -= root.y
    }
    return pos
  }

  private buildLines(): void {
    for (const e of this.edges) {
      const a = this.nodes.get(e.parent)
      const b = this.nodes.get(e.child)
      if (!a || !b) continue
      const line = MeshBuilder.CreateLines(`edge-${e.child.slice(0, 8)}`, {
        points: [
          new Vector3(a.x, a.y, -0.01),
          new Vector3(b.x, b.y, -0.01),
        ],
      }, this.scene)
      line.color = Color3.FromHexString('#6b6b7c')
      this.lineMeshes.push(line)
    }
  }

  private applyZoom(): void {
    const z = this.zoom
    this.camera.orthoTop = 20 * z
    this.camera.orthoBottom = -20 * z
    const aspect = this.scene.getEngine().getRenderWidth() / Math.max(1, this.scene.getEngine().getRenderHeight())
    this.camera.orthoLeft = -20 * z * aspect
    this.camera.orthoRight = 20 * z * aspect
    this.camera.target.set(this.panX, this.panY, 0)
    this.camera.position.set(this.panX, this.panY, 30)
  }

  private bindInput(): void {
    this.scene.onPointerObservable.add((info: PointerInfo) => {
      switch (info.type) {
        case PointerEventTypes.POINTERDOWN: {
          if ((info.event as PointerEvent).button !== 0) return
          this.dragging = true
          this.moved = 0
          this.downX = this.scene.pointerX
          this.downY = this.scene.pointerY
          break
        }
        case PointerEventTypes.POINTERMOVE: {
          if (!this.dragging) return
          const dx = this.scene.pointerX - this.downX
          const dy = this.scene.pointerY - this.downY
          this.moved = Math.max(this.moved, Math.abs(dx) + Math.abs(dy))
          const cssH = this.scene.getEngine().getRenderHeight() * this.scene.getEngine().getHardwareScalingLevel()
          const px = cssH / (2 * 20 * this.zoom)
          this.panX -= dx / px
          this.panY += dy / px
          this.applyZoom()
          break
        }
        case PointerEventTypes.POINTERUP: {
          if (!this.dragging) return
          this.dragging = false
          if (this.moved < 8) this.tapAt(this.scene.pointerX, this.scene.pointerY)
          break
        }
        case PointerEventTypes.POINTERWHEEL: {
          const delta = (info.event as WheelEvent).deltaY || 0
          this.zoom = Math.max(0.4, Math.min(4, this.zoom * (1 - delta * 0.0012)))
          this.applyZoom()
          break
        }
      }
    })
  }

  private tapAt(x: number, y: number): void {
    const pick = this.scene.pick(x, y, (m) => Boolean(m.metadata?.tnode))
    if (!pick?.hit || !pick.pickedMesh?.metadata?.tnode) return
    const meta = pick.pickedMesh.metadata.tnode as ThreadMeta
    this.onOpenModel?.(meta)
  }

  clear(): void {
    for (const n of this.nodes.values()) { n.mesh.dispose(); n.mat.dispose() }
    this.nodes.clear()
    for (const l of this.lineMeshes) l.dispose()
    this.lineMeshes = []
    this.edges = []
    this.panX = 0
    this.panY = 0
    this.zoom = 1
    this.applyZoom()
  }

  dispose(): void {
    this.clear()
    this.scene.dispose()
  }
}
