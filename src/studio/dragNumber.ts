/**
 * Blender-like draggable numbers.
 * Drag left/right on a number input to change its value.
 * Shift = precision (0.1x), Ctrl/Cmd = snap to step, Alt = faster (5x).
 * Supports pointer capture, wheel, and keyboard typing remains functional.
 */

export interface DragNumberOptions {
  step?: number
  min?: number
  max?: number
  /** sensitivity in value units per pixel */
  sensitivity?: number
  onChange?: (value: number) => void
  onCommit?: (value: number) => void
}

const DEFAULT_STEP = 0.1

function parseVal(input: HTMLInputElement): number {
  const v = parseFloat(input.value)
  return Number.isFinite(v) ? v : 0
}

function clamp(v: number, min?: number, max?: number): number {
  if (min !== undefined) v = Math.max(min, v)
  if (max !== undefined) v = Math.min(max, v)
  return v
}

function snapToStep(v: number, step: number): number {
  if (!step || !Number.isFinite(step)) return v
  // avoid floating errors
  const inv = 1 / step
  return Math.round(v * inv) / inv
}

export function attachDragNumber(input: HTMLInputElement, opts: DragNumberOptions = {}): () => void {
  const step = opts.step ?? (input.step ? parseFloat(input.step) : DEFAULT_STEP) ?? DEFAULT_STEP
  const min = opts.min ?? (input.min !== '' ? parseFloat(input.min) : undefined)
  const max = opts.max ?? (input.max !== '' ? parseFloat(input.max) : undefined)
  const baseSensitivity = opts.sensitivity ?? (step !== 0 ? step : 0.01)

  let startX = 0
  let startVal = 0
  let dragging = false
  let pointerId: number | null = null
  const threshold = 2

  // wrap input in a div.drag-num if not already
  let wrapper = input.parentElement as HTMLElement | null
  if (!wrapper || !wrapper.classList.contains('drag-num')) {
    wrapper = document.createElement('div')
    wrapper.className = 'drag-num'
    input.parentElement?.insertBefore(wrapper, input)
    wrapper.appendChild(input)
  }

  const onPointerDown = (e: PointerEvent) => {
    // only left button, and not when input is focused via double click? Allow drag anyway.
    if (e.button !== 0) return
    // if user is selecting text with shift, ignore? We still allow drag.
    startX = e.clientX
    startVal = parseVal(input)
    pointerId = e.pointerId
    dragging = false
    // don't capture yet, wait for threshold
    wrapper?.addEventListener('pointermove', onPointerMove)
    wrapper?.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    // prevent text selection while dragging later
  }

  const onPointerMove = (e: PointerEvent) => {
    if (pointerId !== null && e.pointerId !== pointerId && e.pointerId !== undefined) {
      // ignore other pointers but still track window moves
    }
    const dx = e.clientX - startX
    if (!dragging && Math.abs(dx) < threshold) return
    if (!dragging) {
      dragging = true
      wrapper?.classList.add('dragging')
      try { (wrapper as HTMLElement).setPointerCapture?.(pointerId ?? e.pointerId) } catch {}
      // avoid selecting text
      e.preventDefault()
      document.body.style.cursor = 'ew-resize'
    }
    let factor = baseSensitivity
    if (e.shiftKey) factor *= 0.1
    if (e.altKey) factor *= 5

    let newVal = startVal + dx * factor

    if (e.ctrlKey || e.metaKey) {
      newVal = snapToStep(newVal, step)
    }

    if (min !== undefined || max !== undefined) {
      // when min/max defined, clamp
      newVal = clamp(newVal, min, max)
    }

    // For integer steps, keep integer display
    const isIntStep = Math.abs(step - Math.round(step)) < 1e-9
    if (isIntStep) {
      // but allow float during drag if shift?
      if (!e.shiftKey) newVal = Math.round(newVal)
    }

    // reduce floating noise for display
    const display = Math.abs(newVal) < 1e-9 ? 0 : newVal
    const fixed = step < 1 ? Math.max(0, Math.ceil(-Math.log10(step))) : 0
    const rounded = fixed > 0 ? parseFloat(display.toFixed(fixed + 1)) : display

    input.value = String(rounded)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    opts.onChange?.(rounded)
  }

  const onPointerUp = (e: PointerEvent) => {
    if (dragging) {
      wrapper?.classList.remove('dragging')
      document.body.style.cursor = ''
      const finalVal = parseVal(input)
      opts.onCommit?.(finalVal)
      input.dispatchEvent(new Event('change', { bubbles: true }))
      // prevent the click from focusing weirdly
      e.preventDefault()
    }
    dragging = false
    pointerId = null
    wrapper?.removeEventListener('pointermove', onPointerMove)
    wrapper?.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
  }

  const onWheel = (e: WheelEvent) => {
    // Only when focused
    if (document.activeElement !== input) return
    // avoid page scroll
    e.preventDefault()
    const delta = -e.deltaY * 0.01 // wheel up = increase
    let factor = baseSensitivity * 10
    if (e.shiftKey) factor *= 0.1
    if (e.altKey) factor *= 5
    let newVal = parseVal(input) + delta * factor
    if (e.ctrlKey || e.metaKey) newVal = snapToStep(newVal, step)
    newVal = clamp(newVal, min, max)
    input.value = String(newVal)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    opts.onChange?.(newVal)
  }

  wrapper.addEventListener('pointerdown', onPointerDown)
  input.addEventListener('wheel', onWheel, { passive: false })

  // return detach
  return () => {
    wrapper?.removeEventListener('pointerdown', onPointerDown)
    input.removeEventListener('wheel', onWheel)
  }
}

/** Attach to all number inputs inside a root that have data-drag attribute or .draggable */
export function attachAllDragNumbers(root: ParentNode = document, filter?: (el: HTMLInputElement) => boolean): void {
  const inputs = root.querySelectorAll<HTMLInputElement>('input[type=number]')
  inputs.forEach((inp) => {
    if (filter && !filter(inp)) return
    // avoid double attach
    if ((inp as any)._dragAttached) return
    ;(inp as any)._dragAttached = true
    const stepAttr = inp.getAttribute('step')
    const step = stepAttr ? parseFloat(stepAttr) : undefined
    attachDragNumber(inp, { step })
  })
}
