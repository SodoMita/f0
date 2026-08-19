export type ThreadRole = 'root' | 'reply' | 'malformed'

export type ThreadMeta = {
  eventId: string
  pubkey: string
  createdAt: number
  tint: string
  sha256: string
  size: number
  native: boolean
  mime: string
  urls: string[]
  /** Poster image size (px) from the `dim` tag; always locally rendered. */
  width: number
  height: number
  role: ThreadRole
  refs: { rootId?: string; parentId?: string }
  animHint: boolean
  cameraCount: number
  hasAudio: boolean
  filename?: string
  sourceFormat?: string
  previewCamera?: number
  previewAnimation?: number
  tombstoned?: boolean
  /** Downloaded bytes did not match `sha256` — hide from the board. */
  hashFailed?: boolean
}

const HEX64 = /^[0-9a-f]{64}$/i

function markers(tags: string[][], marker: 'root' | 'reply'): string[] {
  const out: string[] = []
  for (const t of tags) {
    if (t[0] === 'e' && (t[3] || '').toLowerCase() === marker && typeof t[1] === 'string') out.push(t[1])
  }
  return out
}

export function parseThreadRefs(tags: string[][]): { role: ThreadRole; refs: { rootId?: string; parentId?: string } } {
  const roots = markers(tags, 'root')
  const replies = markers(tags, 'reply')
  if (roots.length === 0 && replies.length === 0) return { role: 'root', refs: {} }
  if (roots.length !== 1 || replies.length !== 1) return { role: 'malformed', refs: {} }
  const rootId = roots[0].toLowerCase()
  const parentId = replies[0].toLowerCase()
  if (!HEX64.test(rootId) || !HEX64.test(parentId)) return { role: 'malformed', refs: {} }
  return { role: 'reply', refs: { rootId, parentId } }
}

export class ThreadIndex {
  readonly byId = new Map<string, ThreadMeta>()
  readonly children = new Map<string, Set<string>>()
  readonly roots = new Set<string>()

  add(meta: ThreadMeta): boolean {
    if (meta.role === 'malformed') return false
    this.byId.set(meta.eventId, meta)
    if (meta.role === 'root' || !meta.refs.parentId) {
      this.roots.add(meta.eventId)
      return true
    }
    if (meta.refs.parentId === meta.eventId) return false
    let set = this.children.get(meta.refs.parentId)
    if (!set) { set = new Set(); this.children.set(meta.refs.parentId, set) }
    set.add(meta.eventId)
    this.roots.delete(meta.eventId)
    return true
  }

  tombstone(eventId: string): void {
    const m = this.byId.get(eventId)
    if (m) m.tombstoned = true
  }

  rejectHash(eventId: string): void {
    const m = this.byId.get(eventId)
    if (m) m.hashFailed = true
  }

  flatten(rootId: string): ThreadMeta[] {
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
    out.sort((a, b) => a.createdAt - b.createdAt)
    return out
  }

  childCount(id: string): number { return this.children.get(id)?.size ?? 0 }
}
