export type ThreadRole = 'root' | 'reply' | 'malformed'
export type ThreadIssue =
  | 'missing-root-marker'
  | 'missing-reply-marker'
  | 'duplicate-root-marker'
  | 'duplicate-reply-marker'
  | 'malformed-root-id'
  | 'malformed-parent-id'
  | 'self-reference'
  | 'cross-thread-parent'

export type ThreadRefs = { rootId?: string; parentId?: string }

export type ThreadMeta = {
  eventId: string
  pubkey: string
  createdAt: number
  tint: string
  sha256: string
  size: number
  thumbSha256?: string
  thumbSize?: number
  thumbUrl?: string
  urls: string[]
  servers: string[]
  role: ThreadRole
  refs: ThreadRefs
  animHint: boolean
  cameraCount: number
  hasAudio: boolean
  filename?: string
  sourceFormat?: string
  sourceFilename?: string
  previewCamera?: number
  previewAnimation?: number
  issues?: ThreadIssue[]
  tombstoned?: boolean
}

const HEX64 = /^[0-9a-f]{64}$/i

function markers(tags: ReadonlyArray<ReadonlyArray<string>>, marker: 'root' | 'reply'): string[] {
  const out: string[] = []
  for (const t of tags) {
    if (t[0] === 'e' && (t[3] || '').toLowerCase() === marker && typeof t[1] === 'string') out.push(t[1])
  }
  return out
}

export function parseThreadRefs(tags: ReadonlyArray<ReadonlyArray<string>>): {
  role: ThreadRole
  refs: ThreadRefs
  issues: ThreadIssue[]
} {
  const roots = markers(tags, 'root')
  const replies = markers(tags, 'reply')
  const issues: ThreadIssue[] = []
  if (roots.length === 0 && replies.length === 0) return { role: 'root', refs: {}, issues }
  if (roots.length === 0) issues.push('missing-root-marker')
  if (roots.length > 1) issues.push('duplicate-root-marker')
  if (replies.length === 0) issues.push('missing-reply-marker')
  if (replies.length > 1) issues.push('duplicate-reply-marker')
  const rootId = roots[0] ?? ''
  const parentId = replies[0] ?? ''
  if (rootId && !HEX64.test(rootId)) issues.push('malformed-root-id')
  if (parentId && !HEX64.test(parentId)) issues.push('malformed-parent-id')
  if (issues.length) return { role: 'malformed', refs: { rootId, parentId }, issues }
  return { role: 'reply', refs: { rootId: rootId.toLowerCase(), parentId: parentId.toLowerCase() }, issues }
}

export class ThreadIndex {
  readonly byId = new Map<string, ThreadMeta>()
  readonly children = new Map<string, Set<string>>()
  readonly roots = new Set<string>()
  readonly malformed = new Map<string, ThreadIssue[]>()
  readonly pending = new Map<string, Set<string>>()

  add(meta: ThreadMeta): boolean {
    if (meta.role === 'malformed') {
      this.malformed.set(meta.eventId, meta.issues ?? [])
      this.byId.set(meta.eventId, meta)
      return false
    }
    this.malformed.delete(meta.eventId)
    this.byId.set(meta.eventId, meta)

    if (meta.refs.parentId && meta.refs.parentId === meta.eventId) {
      this.malformed.set(meta.eventId, ['self-reference'])
      return false
    }

    if (meta.role === 'root' || !meta.refs.parentId) {
      this.roots.add(meta.eventId)
      this.promote(meta.eventId)
      return true
    }

    const parent = this.byId.get(meta.refs.parentId)
    if (!parent) {
      let set = this.pending.get(meta.refs.parentId)
      if (!set) {
        set = new Set()
        this.pending.set(meta.refs.parentId, set)
      }
      set.add(meta.eventId)
      return true
    }
    if (!this.validate(meta, parent, meta.refs.rootId)) return false
    this.attach(meta.refs.parentId, meta.eventId)
    this.promote(meta.eventId)
    return true
  }

  private validate(child: ThreadMeta, parent: ThreadMeta, declaredRoot: string | undefined): boolean {
    const root = this.rootOf(parent)
    if (root !== undefined && root !== declaredRoot) {
      this.malformed.set(child.eventId, ['cross-thread-parent'])
      this.byId.delete(child.eventId)
      return false
    }
    return true
  }

  rootOf(meta: ThreadMeta): string | undefined {
    if (meta.role === 'root' || !meta.refs.parentId) return meta.eventId
    const declared = meta.refs.rootId
    const seen = new Set<string>([meta.eventId])
    let cur: ThreadMeta | undefined = meta
    while (cur) {
      const pid = cur.refs.parentId
      if (!pid) return cur.eventId
      if (seen.has(pid)) return undefined
      seen.add(pid)
      const next = this.byId.get(pid)
      if (!next) return declared
      if (declared && next.refs.rootId && next.refs.rootId !== declared) return undefined
      cur = next
    }
    return declared
  }

  private attach(parentId: string, childId: string): void {
    let list = this.children.get(parentId)
    if (!list) {
      list = new Set()
      this.children.set(parentId, list)
    }
    list.add(childId)
    this.roots.delete(childId)
  }

  private promote(parentId: string): void {
    const pend = this.pending.get(parentId)
    if (!pend) return
    this.pending.delete(parentId)
    const parent = this.byId.get(parentId)
    if (!parent) return
    for (const childId of pend) {
      const child = this.byId.get(childId)
      if (!child) continue
      if (!this.validate(child, parent, child.refs.rootId)) continue
      this.attach(parentId, childId)
      this.promote(childId)
    }
  }

  tombstone(eventId: string): void {
    const m = this.byId.get(eventId)
    if (m) m.tombstoned = true
  }

  flatten(rootId: string): ThreadMeta[] {
    const root = this.byId.get(rootId)
    if (!root) return []
    const out: ThreadMeta[] = []
    const stack = [rootId]
    const seen = new Set<string>()
    while (stack.length) {
      const id = stack.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      const m = this.byId.get(id)
      if (m) out.push(m)
      const kids = this.children.get(id)
      if (kids) for (const k of kids) stack.push(k)
    }
    out.sort((a, b) => a.createdAt - b.createdAt || a.eventId.localeCompare(b.eventId))
    return out
  }

  childCount(id: string): number {
    return this.children.get(id)?.size ?? 0
  }
}
