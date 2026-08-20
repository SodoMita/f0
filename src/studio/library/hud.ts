import type { Studio } from '../studio'
import { GROUPS, LIBRARY, type LibraryDim, type LibraryGroup } from './catalog'
import { libraryBytes } from './load'

const ICONS: Record<string, string> = {
  smile: 'M7 13c1.4 2 3 3 5 3s3.6-1 5-3M9 10h.01M15 10h.01M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z',
  grin: 'M7.5 13.5h9v1.5c0 2-2 3.5-4.5 3.5s-4.5-1.5-4.5-3.5zM9 10h.01M15 10h.01M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z',
  sad: 'M7 16c1.4-2 3-3 5-3s3.6 1 5 3M9 10h.01M15 10h.01M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z',
  angry: 'M7 16c1.4-1 3-1.5 5-1.5s3.6.5 5 1.5M8 8.5l3 1.5M16 8.5l-3 1.5M9 11h.01M15 11h.01M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z',
  wow: 'M12 16.2a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2M9 10h.01M15 10h.01M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z',
  wink: 'M7 13c1.4 2 3 3 5 3s3.6-1 5-3M9 10h.01M14 10h2.4M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z',
  meh: 'M8 15h8M9 10h.01M15 10h.01M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z',
  love: 'M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15zM8.6 10.2c0-1 .7-1.6 1.5-1.6.5 0 1 .3 1.2.8.2-.5.7-.8 1.2-.8.8 0 1.5.6 1.5 1.6 0 1.6-2.7 2.8-2.7 2.8S8.6 11.8 8.6 10.2z',
  dead: 'M8 9l2 2m0-2-2 2M14 9l2 2m0-2-2 2M8 15h8M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z',
  cool: 'M6.5 10.5h11M7.5 10.5v2.2h3V10.5M13.5 10.5v2.2h3V10.5M8 15h8M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z',
  heart: 'M12 19S5 14.2 5 9.6C5 7.2 6.8 5.5 9 5.5c1.3 0 2.4.6 3 1.6.6-1 1.7-1.6 3-1.6 2.2 0 4 1.7 4 4.1C19 14.2 12 19 12 19z',
  star: 'M12 4.5l1.8 4.4 4.7.4-3.6 3.1 1.1 4.6L12 14.8 7.9 17l1.1-4.6-3.6-3.1 4.7-.4z',
  plus: 'M12 6v12M6 12h12',
  minus: 'M6 12h12',
  check: 'M6 12.5l4 4 8-9',
  xmark: 'M7 7l10 10M17 7 7 17',
  question: 'M9 9a3 3 0 1 1 4.2 2.7c-.8.4-1.2 1-1.2 1.8V14.5M12 17.5h.01',
  bang: 'M12 5v9M12 18.2h.01',
  thumbup: 'M8 11v8H6v-8h2zm2 8h6.2c.8 0 1.5-.6 1.7-1.4l1.1-4.4c.2-.9-.5-1.7-1.4-1.7h-3.1l.6-2.8c.2-1-.8-1.8-1.7-1.4L8.8 10',
  thumbdown: 'M8 5v8H6V5h2zm2-0.2h6.2c.8 0 1.5.6 1.7 1.4l1.1 4.4c.2.9-.5 1.7-1.4 1.7h-3.1l.6 2.8c.2 1-.8 1.8-1.7 1.4L8.8 14',
  spark: 'M12 4v16M4 12h16M7 7l10 10M17 7 7 17',
  fire: 'M12 20c3.2 0 5-2.1 5-5.2 0-2.6-1.7-4.2-3.2-5.6.1 1.6-.5 2.6-1.4 3.2.0-3.2-1.3-5.4-3.6-6.9 0 2.4-.4 4.4-1.8 5.8C6.2 12.8 6 14.4 6 15.6 6 18.2 8.2 20 12 20z',
  arrow: 'M12 19V6m0 0l-4 4m4-4 4 4',
  ok: 'M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z',
  wait: 'M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z',
  off: 'M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z',
  lock: 'M8 11V8.5A4 4 0 0 1 16 8.5V11M7 11h10v8H7z',
  unlock: 'M8 11V8.5A4 4 0 0 1 16.5 9M7 11h10v8H7z',
  pin: 'M12 21s6-5.2 6-10a6 6 0 1 0-12 0c0 4.8 6 10 6 10z',
  flag: 'M6 4v16M6 5h11l-2 3.5L17 12H6',
  eye: 'M3.5 12S7 6.5 12 6.5 20.5 12 20.5 12 17 17.5 12 17.5 3.5 12 3.5 12zM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  bell: 'M6.5 16.5h11c-.4-1.2-.8-2.4-.8-4.2 0-2.8-1.8-5-4.7-5.3V6a1 1 0 1 0-2 0v1c-2.9.3-4.7 2.5-4.7 5.3 0 1.8-.4 3-.8 4.2zM10 18a2 2 0 0 0 4 0',
  cube: 'M5 8.2 12 5l7 3.2v7.6L12 19l-7-3.2zM5 8.2l7 3.3 7-3.3M12 11.5V19',
  sphere: 'M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM5.2 12h13.6M12 5c2.4 2.2 3.6 4.6 3.6 7S14.4 16.8 12 19C9.6 16.8 8.4 14.4 8.4 12S9.6 7.2 12 5z',
  cylinder: 'M6 7c0-1.7 2.7-3 6-3s6 1.3 6 3v10c0 1.7-2.7 3-6 3s-6-1.3-6-3zM6 7c0 1.7 2.7 3 6 3s6-1.3 6-3',
  cone: 'M12 4 5 19h14z',
  tetra: 'M12 4 5 18h14zM12 4v14',
  pyramid: 'M12 4 4 19h16zM12 4v15M4 19l8-5 8 5',
  torus: 'M12 6.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  capsule: 'M9 6.5h6a3.5 3.5 0 0 1 0 7H9a3.5 3.5 0 0 1 0-7zM9 10.5h6a3.5 3.5 0 0 1 0 7H9a3.5 3.5 0 0 1 0-7z',
  hexprism: 'M7.5 6.5 12 4l4.5 2.5v7L12 16.5 7.5 14z',
  wedge: 'M5 18V8l14 4v6z',
  octa: 'M12 3.5 20 12l-8 8.5L4 12z',
  plane: 'M5 7h14v10H5z',
  house: 'M4 12 12 5l8 7M7 11.5V19h10v-7.5',
  tree: 'M12 20V13M7 16l5-9 5 9zM8.5 12.5 12 7l3.5 5.5',
  person: 'M12 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM7 20v-2.2A4.2 4.2 0 0 1 11.2 13.5h1.6A4.2 4.2 0 0 1 17 17.8V20',
  crate: 'M5 8h14v11H5zM5 12h14M12 8v11',
  coin: 'M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM9.5 12h5',
  key: 'M8 14.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm2.4-2H20v2h-2v2h-2v-2h-1.6',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18',
  moon: 'M15.5 5.2A7.2 7.2 0 1 0 19 14.8 5.6 5.6 0 0 1 15.5 5.2z',
  speech: 'M5 6.5h14v9H9l-4 3.2z',
  arrow3d: 'M12 20V6m0 0 4 4M12 6 8 10',
}

function svgFor(id: string): string {
  const d = ICONS[id] ?? 'M7 7h10v10H7z'
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`
}

export function bindLibraryHud(studio: Studio, onChange: () => void): void {
  const grid = document.getElementById('symbol-grid')
  if (!grid) return
  let group: LibraryGroup | 'all' = 'all'
  let dim: LibraryDim | 'all' = 'all'

  const filters = document.createElement('div')
  filters.className = 'symbol-filters'
  const mk = (label: string, on: boolean, click: () => void): HTMLButtonElement => {
    const b = document.createElement('button')
    b.className = 'symbol-filter' + (on ? ' active' : '')
    b.textContent = label
    b.addEventListener('click', click)
    return b
  }
  const paintFilters = (): void => {
    filters.replaceChildren()
    filters.append(mk('all', group === 'all' && dim === 'all', () => { group = 'all'; dim = 'all'; render() }))
    for (const g of GROUPS) filters.append(mk(g, group === g, () => { group = g; render() }))
    filters.append(mk('2d', dim === '2d', () => { dim = dim === '2d' ? 'all' : '2d'; render() }))
    filters.append(mk('3d', dim === '3d', () => { dim = dim === '3d' ? 'all' : '3d'; render() }))
  }

  const cells = document.createElement('div')
  cells.className = 'symbol-cells'

  const render = (): void => {
    paintFilters()
    cells.replaceChildren()
    for (const item of LIBRARY) {
      if (group !== 'all' && item.group !== group) continue
      if (dim !== 'all' && item.dim !== dim) continue
      const b = document.createElement('button')
      b.type = 'button'
      b.title = item.id
      b.setAttribute('aria-label', item.id)
      b.dataset.symbol = item.id
      b.innerHTML = svgFor(item.id)
      b.addEventListener('click', () => { void place(item.id) })
      cells.append(b)
    }
  }

  const place = async (id: string): Promise<void> => {
    try {
      const bytes = await libraryBytes(id)
      const item = LIBRARY.find((entry) => entry.id === id)
      await studio.addLibraryItem(bytes, id + '.glb', { faceCamera: item?.dim === '2d' })
      onChange()
    } catch (err) {
      console.warn('library place failed', err)
    }
  }

  grid.replaceChildren(filters, cells)
  render()
}
