import type { SettingsValues } from '../settings/schema'

export type AudioPlaybackState = 'unavailable' | 'stopped' | 'loading' | 'playing' | 'error'

/**
 * One embedded-clip player for the detail viewer.
 *
 * This intentionally stays an HTMLAudioElement/object-URL path: the browser
 * owns decode, seek and codec support. There is no AudioBuffer allocation and
 * no positional PannerNode. Playback begins only from toggle(), which is
 * called by a button/key gesture; setting a source never autoplays it.
 */
export class EmbeddedAudioPlayer {
  private element: HTMLAudioElement | null = null
  private objectUrl: string | null = null
  private operation = 0
  private currentState: AudioPlaybackState = 'unavailable'
  private settings: SettingsValues | null = null
  private focused = true

  constructor(
    private onState: (state: AudioPlaybackState) => void,
    private onError?: (error: unknown) => void,
  ) {
    // Keep using the plain media element while still honouring the app's
    // master/effects/background controls. Muting (rather than pausing) on
    // blur lets playback resume in sync when focus returns.
    window.addEventListener('blur', () => { this.focused = false; this.applyElementSettings() })
    window.addEventListener('focus', () => { this.focused = true; this.applyElementSettings() })
    document.addEventListener('visibilitychange', () => {
      this.focused = !document.hidden
      this.applyElementSettings()
    })
  }

  get state(): AudioPlaybackState { return this.currentState }
  get available(): boolean { return this.element !== null }
  get playing(): boolean { return this.currentState === 'playing' }

  /** Settings stay on the HTMLAudioElement; no WebAudio source is created. */
  apply(settings: SettingsValues): void {
    this.settings = settings
    this.applyElementSettings()
  }

  /** Replace the model's clip. This always stops and releases the old one. */
  setAudio(audio: Blob | undefined): void {
    this.release()
    if (!audio) {
      this.setState('unavailable')
      return
    }
    try {
      const url = URL.createObjectURL(audio)
      const element = new Audio(url)
      element.autoplay = false
      element.loop = true
      element.volume = 0.78
      element.preload = 'metadata'
      element.addEventListener('playing', this.handlePlaying)
      element.addEventListener('pause', this.handlePause)
      element.addEventListener('error', this.handleError)
      this.objectUrl = url
      this.element = element
      this.applyElementSettings()
      this.setState('stopped')
    } catch (error) {
      this.release()
      this.setState('error')
      this.onError?.(error)
    }
  }

  /** User-gesture entry point. Concurrent presses share one pending play. */
  async toggle(): Promise<void> {
    const element = this.element
    if (!element || this.currentState === 'loading') return
    if (!element.paused) {
      this.operation++
      element.pause()
      this.setState('stopped')
      return
    }

    const operation = ++this.operation
    this.setState('loading')
    try {
      await Promise.resolve(element.play())
      if (operation !== this.operation || element !== this.element) return
      this.setState(element.paused ? 'stopped' : 'playing')
    } catch (error) {
      if (operation !== this.operation || element !== this.element) return
      this.setState('stopped')
      this.onError?.(error)
    }
  }

  clear(): void {
    this.release()
    this.setState('unavailable')
  }

  dispose(): void { this.clear() }

  private handlePlaying = (): void => {
    if (this.element) this.setState('playing')
  }

  private handlePause = (): void => {
    if (this.element && this.currentState !== 'loading') this.setState('stopped')
  }

  private handleError = (): void => {
    if (!this.element) return
    this.setState('error')
    this.onError?.(this.element.error ?? new Error('audio playback failed'))
  }

  private applyElementSettings(): void {
    const element = this.element
    if (!element) return
    const settings = this.settings
    const master = Number(settings?.volMaster ?? 100) / 100
    const effects = Number(settings?.volSfx ?? 100) / 100
    element.volume = Math.max(0, Math.min(1, 0.78 * master * effects))
    element.muted = !this.focused && !(settings?.audioBackground ?? false)
    const sink = String(settings?.audioOutput ?? 'default')
    const routed = element as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
    if (routed.setSinkId) void routed.setSinkId(sink === 'default' ? '' : sink).catch(() => {})
  }

  private release(): void {
    this.operation++
    const element = this.element
    if (element) {
      element.removeEventListener('playing', this.handlePlaying)
      element.removeEventListener('pause', this.handlePause)
      element.removeEventListener('error', this.handleError)
      element.pause()
      element.removeAttribute('src')
      // Tell the media stack to release its decoder before revoking the URL.
      try { element.load() } catch { /* detached media element */ }
    }
    this.element = null
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl)
    this.objectUrl = null
  }

  private setState(state: AudioPlaybackState): void {
    if (state === this.currentState) return
    this.currentState = state
    this.onState(state)
  }
}
