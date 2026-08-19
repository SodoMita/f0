import type { Studio } from './studio'
import type { PaintToolKind, ShapeKind } from './paint/types'
import { hexToRgba, rgbaToHex, SHAPES } from './paint/types'

/**
 * Bind the paint inspector. Kept out of main.ts so the boot file does not
 * grow further (CONVENTIONS: one job per module).
 */
export function bindPaintHud(studio: Studio, onChange: () => void): { refresh(): void } {
  const budget = document.getElementById('paint-budget')
  const sizeEl = document.getElementById('paint-size') as HTMLInputElement | null
  const gapEl = document.getElementById('paint-spacing') as HTMLInputElement | null
  const colorEl = document.getElementById('paint-color') as HTMLInputElement | null
  const snapBtn = document.getElementById('paint-snap')
  const lockBtn = document.getElementById('paint-lock')
  const surfBtn = document.getElementById('paint-surf')

  const refresh = (): void => {
    const o = studio.paint.opts
    if (sizeEl) sizeEl.value = String(o.size)
    if (gapEl) gapEl.value = String(o.spacing)
    if (colorEl) colorEl.value = rgbaToHex(o.color[0], o.color[1], o.color[2])
    snapBtn?.classList.toggle('active', o.snap)
    lockBtn?.classList.toggle('active', o.depthLock)
    surfBtn?.classList.toggle('active', o.surface)
    document.querySelectorAll<HTMLButtonElement>('[data-paint]').forEach((b) => {
      b.classList.toggle('active', b.dataset.paint === o.tool)
    })
    document.querySelectorAll<HTMLButtonElement>('[data-shape]').forEach((b) => {
      b.classList.toggle('active', b.dataset.shape === o.shape)
    })
    if (budget) {
      budget.textContent = `${studio.paint.count} stamps · ${o.tool} · drag to write`
    }
    onChange()
  }

  studio.paint.onChange = refresh

  document.querySelectorAll<HTMLButtonElement>('[data-paint]').forEach((b) => {
    b.addEventListener('click', () => {
      studio.paint.setTool(b.dataset.paint as PaintToolKind)
      refresh()
    })
  })
  document.querySelectorAll<HTMLButtonElement>('[data-shape]').forEach((b) => {
    b.addEventListener('click', () => {
      const shape = b.dataset.shape as ShapeKind
      if (SHAPES.includes(shape)) studio.paint.setOpts({ shape })
      refresh()
    })
  })

  const num = (el: HTMLInputElement): number => {
    const v = parseFloat(el.value)
    return Number.isFinite(v) ? v : 0
  }
  sizeEl?.addEventListener('input', () => { studio.paint.setOpts({ size: Math.max(0.02, num(sizeEl)) }); refresh() })
  gapEl?.addEventListener('input', () => { studio.paint.setOpts({ spacing: Math.max(0.08, num(gapEl)) }); refresh() })
  colorEl?.addEventListener('input', () => { studio.paint.setOpts({ color: hexToRgba(colorEl.value) }); refresh() })

  snapBtn?.addEventListener('click', () => { studio.paint.setOpts({ snap: !studio.paint.opts.snap }); refresh() })
  lockBtn?.addEventListener('click', () => { studio.paint.setOpts({ depthLock: !studio.paint.opts.depthLock }); refresh() })
  surfBtn?.addEventListener('click', () => { studio.paint.setOpts({ surface: !studio.paint.opts.surface }); refresh() })
  document.getElementById('paint-undo')?.addEventListener('click', () => { studio.paint.undo(); refresh() })
  document.getElementById('paint-redo')?.addEventListener('click', () => { studio.paint.redo(); refresh() })

  return { refresh }
}
