import type { Studio } from '../studio'
import { runtimeModelIcons } from '../runtimeModelIcons'
import { GROUPS, LIBRARY, type LibraryDim, type LibraryGroup, type LibraryItem } from './catalog'
import { libraryBytes } from './load'

/**
 * Bind the Shapes library. Every cell starts empty and receives a runtime RTT
 * capture of the actual GLB it places; SVG approximations are deliberately not
 * used. Rendering is lazy so opening Studio does not decode all library GLBs.
 */
export function bindLibraryHud(studio: Studio, onChange: () => void, onError?: (msg: string) => void, getColor?: () => string): void {
  const grid = document.getElementById('symbol-grid')
  if (!grid) return
  const icons = runtimeModelIcons(studio.scene.getEngine())
  let group: LibraryGroup | 'all' = 'all'
  let dim: LibraryDim | 'all' = 'all'

  const filters = document.createElement('div')
  filters.className = 'symbol-filters'
  const mk = (label: string, on: boolean, click: () => void): HTMLButtonElement => {
    const button = document.createElement('button')
    button.className = 'symbol-filter' + (on ? ' active' : '')
    button.textContent = label
    button.addEventListener('click', click)
    return button
  }
  const paintFilters = (): void => {
    filters.replaceChildren()
    filters.append(mk('all', group === 'all' && dim === 'all', () => { group = 'all'; dim = 'all'; render() }))
    for (const value of GROUPS) filters.append(mk(value, group === value, () => { group = value; render() }))
    filters.append(mk('2d', dim === '2d', () => { dim = dim === '2d' ? 'all' : '2d'; render() }))
    filters.append(mk('3d', dim === '3d', () => { dim = dim === '3d' ? 'all' : '3d'; render() }))
  }

  const cells = document.createElement('div')
  cells.className = 'symbol-cells'
  const pending = new Map<Element, LibraryItem>()

  const startIcon = (button: HTMLButtonElement, item: LibraryItem): void => {
    if (button.dataset.iconStarted === '1') return
    button.dataset.iconStarted = '1'
    const image = button.querySelector('img')
    if (!image) return
    void libraryBytes(item)
      .then((bytes) => icons.library(item, bytes))
      .then((url) => {
        image.src = url
        button.classList.add('icon-ready')
      })
      .catch((error) => {
        button.classList.add('icon-error')
        console.warn(`library icon failed: ${item.id}`, error)
      })
  }

  const observer = typeof IntersectionObserver === 'undefined'
    ? null
    : new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const item = pending.get(entry.target)
        if (!item) continue
        observer?.unobserve(entry.target)
        pending.delete(entry.target)
        startIcon(entry.target as HTMLButtonElement, item)
      }
    }, { rootMargin: '120px' })

  const queueIcon = (button: HTMLButtonElement, item: LibraryItem): void => {
    if (!observer) {
      startIcon(button, item)
      return
    }
    pending.set(button, item)
    observer.observe(button)
  }

  const render = (): void => {
    paintFilters()
    observer?.disconnect()
    pending.clear()
    cells.replaceChildren()
    for (const item of LIBRARY) {
      if (group !== 'all' && item.group !== group) continue
      if (dim !== 'all' && item.dim !== dim) continue
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'model-icon-button'
      button.title = `${item.id} (${item.dim})`
      button.setAttribute('aria-label', `${item.id} ${item.dim}`)
      button.dataset.symbol = item.id
      button.dataset.dim = item.dim
      const image = document.createElement('img')
      image.alt = ''
      image.setAttribute('aria-hidden', 'true')
      button.append(image)
      button.addEventListener('click', () => { void place(item) })
      cells.append(button)
      queueIcon(button, item)
    }
  }

  const place = async (item: LibraryItem): Promise<void> => {
    try {
      const bytes = await libraryBytes(item)
      // Each placement takes its own color from the picker (AMENDMENT 68
      // corrected 2026-08-21): every symbol can carry a different color.
      await studio.addLibraryItem(bytes, { faceCamera: item.dim === '2d', color: getColor?.() })
      onChange()
    } catch (err) {
      // Never fail silently (AMENDMENT 68): a blocked Draco decoder, a bad
      // fetch etc. must reach the player, not just the console.
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('library place failed', err)
      onError?.(`${item.id}: ${msg}`)
    }
  }

  grid.replaceChildren(filters, cells)
  render()
}
