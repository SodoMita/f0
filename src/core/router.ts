export type Route =
  | { name: 'board' }
  | { name: 'thread'; rootId: string; focusId?: string }
  | { name: 'viewer'; id?: string }
  | { name: 'studio' }
  | { name: 'network' }

function parse(): Route {
  const h = window.location.hash.replace(/^#\/?/, '')
  if (!h) return { name: 'board' }
  const [path, query = ''] = h.split('?')
  const parts = path.split('/').filter(Boolean)
  const params = new URLSearchParams(query)
  if (parts[0] === 'thread' && parts[1]) return { name: 'thread', rootId: parts[1], focusId: parts[2] || params.get('post') || undefined }
  if (parts[0] === 'viewer') return { name: 'viewer', id: parts[1] }
  if (parts[0] === 'studio') return { name: 'studio' }
  if (parts[0] === 'network') return { name: 'network' }
  return { name: 'board' }
}

function stringify(route: Route): string {
  switch (route.name) {
    case 'board': return '#/'
    case 'thread': return `#/thread/${route.rootId}${route.focusId ? '/' + route.focusId : ''}`
    case 'viewer': return `#/viewer${route.id ? '/' + route.id : ''}`
    case 'studio': return '#/studio'
    case 'network': return '#/network'
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
    if (window.location.hash !== next) window.location.hash = next
    else { this.current = route; this.listeners.forEach((l) => l(route)) }
  }
}
