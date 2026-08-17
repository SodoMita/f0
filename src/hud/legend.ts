import { get, put } from '../protocol/storage'

// First-run legend (spec 02 §1.1). Mandatory on first launch, reopenable
// (net-dot long-press is not discoverable — we reopen via Shift+/ and the
// settings panel hook the caller wires), seen-flag persisted in IndexedDB
// so it survives reloads but respects a cleared profile.
const SEEN_KEY = 'legend-seen'

function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement
}

export class Legend {
  private root = $('legend')
  private lastFocus: Element | null = null

  constructor() {
    $('btn-legend-close').addEventListener('click', () => this.close())
    $('btn-legend-ok').addEventListener('click', () => this.close())
    this.root.addEventListener('click', (e) => { if (e.target === this.root) this.close() })
    window.addEventListener('keydown', (e) => {
      if (!this.root.hidden && e.key === 'Escape') { e.stopPropagation(); this.close() }
      // '?' reopens the legend from anywhere (single non-modal key, spec:
      // legend must be reopenable)
      if (this.root.hidden && e.key === '?' && !isTyping()) this.open()
    }, true) // capture: beat the viewer/thread Escape handlers
  }

  /** Show on first run only (seen-flag in IDB). */
  async maybeShowFirstRun(): Promise<void> {
    const seen = await get<boolean>('settings', SEEN_KEY)
    if (!seen) this.open()
  }

  open(): void {
    this.lastFocus = document.activeElement
    this.root.hidden = false
    ;($('btn-legend-ok') as HTMLButtonElement).focus()
  }

  close(): void {
    if (this.root.hidden) return
    this.root.hidden = true
    void put('settings', SEEN_KEY, true)
    ;(this.lastFocus as HTMLElement | null)?.focus?.()
  }

  get isOpen(): boolean { return !this.root.hidden }
}

function isTyping(): boolean {
  const el = document.activeElement
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
}
