// Error sheet (spec PRODUCT: "Errors: sheet, never '!' alone" — each error
// surfaces a CODE + CAUSE + one concrete ACTION). Codes are stable strings
// so users can report them; causes are short human sentences.

function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement
}

export interface SheetError {
  code: string
  cause: string
  action: string
  onAction: () => void
}

/** Copy text to clipboard using the Async Clipboard API with execCommand fallback. */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Permission denied / unsecure context — fall back to execCommand below
    }
  }
  if (typeof document === 'undefined') return false
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    ta.style.left = '-9999px'
    ta.style.opacity = '0'
    ta.setAttribute('readonly', '')
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    ta.setSelectionRange(0, text.length)
    const success = document.execCommand('copy')
    document.body.removeChild(ta)
    return success
  } catch {
    return false
  }
}

/** Known error catalogue — one place, so codes stay consistent. */
export const ERRORS = {
  MODEL_DOWNLOAD: (retry: () => void): SheetError => ({
    code: 'E101',
    cause: 'No Blossom server returned a verified copy of this model (hash or size mismatch, or all replicas unreachable).',
    action: 'retry',
    onAction: retry,
  }),
  MODEL_PARSE: (skip: () => void): SheetError => ({
    code: 'E102',
    cause: 'The model bytes were fetched and verified but the GLB failed validation or crashed the loader.',
    action: 'back to board',
    onAction: skip,
  }),
  RELAYS_OFFLINE: (openNetwork: () => void): SheetError => ({
    code: 'E201',
    cause: 'No relay connection. The feed cannot load or update until at least one relay is online.',
    action: 'open network panel',
    onAction: openNetwork,
  }),
  IMPORT_INVALID: (): SheetError => ({
    code: 'E301',
    cause: 'The selected file is not a valid GLB within limits (20 MiB, magic bytes, sane JSON chunk).',
    action: 'dismiss',
    onAction: () => { /* dismiss only */ },
  }),
} as const

export class ErrorSheet {
  private root = $('error-sheet')
  private codeEl = $('error-code')
  private causeEl = $('error-cause')
  private actionBtn = $('btn-error-action') as HTMLButtonElement
  private copyBtn = $('btn-error-copy') as HTMLButtonElement | null
  private current: SheetError | null = null
  private hideTimer = 0
  private copyResetTimer = 0

  constructor() {
    $('btn-error-close')?.addEventListener('click', () => this.hide())
    this.actionBtn?.addEventListener('click', () => {
      const e = this.current
      this.hide()
      e?.onAction()
    })
    this.copyBtn?.addEventListener('click', () => {
      void this.copy()
    })
  }

  /** Copies current error formatted as "CODE: CAUSE" to the clipboard with visual feedback. */
  async copy(): Promise<boolean> {
    const code = this.current?.code ?? this.codeEl?.textContent?.trim() ?? ''
    const cause = this.current?.cause ?? this.causeEl?.textContent?.trim() ?? ''
    const text = code && cause ? `${code}: ${cause}` : (cause || code)
    if (!text) return false
    const ok = await copyToClipboard(text)
    if (this.copyBtn) {
      this.copyBtn.classList.add('copied')
      this.copyBtn.title = 'copied!'
      this.copyBtn.setAttribute('aria-label', 'copied!')
      clearTimeout(this.copyResetTimer)
      this.copyResetTimer = window.setTimeout(() => {
        if (this.copyBtn) {
          this.copyBtn.classList.remove('copied')
          this.copyBtn.title = 'copy error'
          this.copyBtn.setAttribute('aria-label', 'copy error')
        }
      }, 1800)
    }
    return ok
  }

  show(err: SheetError): void {
    this.current = err
    this.codeEl.textContent = err.code
    this.causeEl.textContent = err.cause
    this.actionBtn.textContent = err.action
    if (this.copyBtn) {
      this.copyBtn.classList.remove('copied')
      this.copyBtn.title = 'copy error'
      this.copyBtn.setAttribute('aria-label', 'copy error')
    }
    clearTimeout(this.copyResetTimer)
    this.root.hidden = false
    clearTimeout(this.hideTimer)
    // errors with a real action stay until dismissed; pure-dismiss errors
    // auto-hide so they don't outstay a toast
    if (err.action === 'dismiss') this.hideTimer = window.setTimeout(() => this.hide(), 8000)
  }

  hide(): void {
    this.root.hidden = true
    this.current = null
    clearTimeout(this.hideTimer)
    clearTimeout(this.copyResetTimer)
    if (this.copyBtn) {
      this.copyBtn.classList.remove('copied')
      this.copyBtn.title = 'copy error'
      this.copyBtn.setAttribute('aria-label', 'copy error')
    }
  }

  get isOpen(): boolean { return !this.root.hidden }
}
