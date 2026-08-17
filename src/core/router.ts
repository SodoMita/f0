export type Route =
  | { name: 'board' }
  | { name: 'thread'; rootId: string; focusId?: string }
  | { name: 'viewer'; id?: string; fromThread?: string }
  | { name: 'studio'; replyTo?: { rootId: string; parentId: string } }
  | { name: 'network' }

function parse(): Route {
  const h = window.location.hash.replace(/^#\/?/, '')
  if (!h) return { name: 'board' }
  const [path, query = ''] = h.split('?')
  const parts = path.split('/').filter(Boolean)
  const params = new URLSearchParams(query)
  if (parts[0] === 'thread' && parts[1]) {
    return { name: 'thread', rootId: parts[1], focusId: parts[2] || params.get('post') || undefined }
  }
  if (parts[0] === 'viewer') {
    return { name: 'viewer', id: parts[1], fromThread: params.get('thread') || undefined }
  }
  if (parts[0] === 'studio') {
    const root = params.get('root') || undefined
    const parent = params.get('parent') || undefined
    return { name: 'studio', replyTo: root && parent ? { rootId: root, parentId: parent } : undefined }
  }
  if (parts[0] === 'network') return { name: 'network' }
  return { name: 'board' }
}

function stringify(route: Route): string {
  switch (route.name) {
    case 'board':
      return '#/'
    case 'thread': {
      const focus = route.focusId ? '/' + route.focusId : ''
      return `#/thread/${route.rootId}${focus}`
    }
    case 'viewer': {
      const q = route.fromThread ? `?thread=${encodeURIComponent(route.fromThread)}` : ''
      return `#/viewer${route.id ? '/' + route.id : ''}${q}`
    }
    case 'studio': {
      if (!route.replyTo) return '#/studio'
      return `#/studio?root=${encodeURIComponent(route.replyTo.rootId)}&parent=${encodeURIComponent(route.replyTo.parentId)}`
    }
    case 'network':
      return '#/network'
  }
}

export class Router {
  private listeners = new Set<(route: Route) => void>()
  current: Route = parse()

  constructor() {
    window.addEventListener('hashchange', () => {
      this.current = parse()
      this.listeners.forEach((l) => l(this.current))
    })
  }

  subscribe(fn: (route: Route) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  go(route: Route): void {
    const next = stringify(route)
    if (window.location.hash !== next) {
      window.location.hash = next
    } else {
      this.current = route
      this.listeners.forEach((l) => l(this.current))
    }
  }

  back(): void {
    window.history.back()
  }
}
