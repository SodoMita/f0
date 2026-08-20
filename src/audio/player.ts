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

  constructor(
    private onState: (state: AudioPlaybackState) => void,
    private onError?: (error: unknown) => void,
  ) {}

  get state(): AudioPlaybackState { return this.currentState }
  get available(): boolean { return this.element !== null }
  get playing(): boolean { return this.currentState === 'playing' }

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
