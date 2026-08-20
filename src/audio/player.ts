import type { SettingsValues } from '../settings/schema'
import { mixer, type PositionalMediaRoute, type SpatialAudioPose } from './mixer'

export type AudioPlaybackState = 'unavailable' | 'stopped' | 'loading' | 'playing' | 'error'

/**
 * One browser-decoded embedded-clip player shared by viewer, board and tree.
 *
 * The object URL remains the media source (no large AudioBuffer allocation),
 * but the first explicit toggle creates a dedicated
 * MediaElementAudioSourceNode → PannerNode(HRTF) → mixer route. Merely setting
 * a Blob never creates/resumes playback and never autoplays.
 */
export class EmbeddedAudioPlayer {
  private element: HTMLAudioElement | null = null
  private objectUrl: string | null = null
  private route: PositionalMediaRoute | null = null
  private operation = 0
  private currentState: AudioPlaybackState = 'unavailable'
  private currentSourceId: string | null = null
  private pose: SpatialAudioPose = {
    source: { x: 0, y: 0, z: 0 },
    listener: { x: 0, y: 0, z: -30 },
    forward: { x: 0, y: 0, z: 1 },
    up: { x: 0, y: 1, z: 0 },
  }
  private settings: SettingsValues | null = null
  private focused = true

  constructor(
    private onState: (state: AudioPlaybackState, sourceId: string | null) => void,
    private onError?: (error: unknown) => void,
  ) {
    // The mixer handles focus muting once WebAudio is available. These
    // listeners preserve the same policy for browsers where route creation
    // is unsupported and the media element plays directly.
    window.addEventListener('blur', () => { this.focused = false; this.applyElementSettings() })
    window.addEventListener('focus', () => { this.focused = true; this.applyElementSettings() })
    document.addEventListener('visibilitychange', () => {
      this.focused = !document.hidden
      this.applyElementSettings()
    })
  }

  get state(): AudioPlaybackState { return this.currentState }
  get sourceId(): string | null { return this.currentSourceId }
  get available(): boolean { return this.element !== null }
  get playing(): boolean { return this.currentState === 'playing' }

  /** Retained for the direct-media fallback; routed volume lives in mixer buses. */
  apply(settings: SettingsValues): void {
    this.settings = settings
    this.applyElementSettings()
  }

  /** Move the source/listener with the Babylon post and active camera. */
  setSpatialPose(pose: SpatialAudioPose): void {
    this.pose = pose
    this.route?.setPose(pose)
  }

  /** Replace the post clip. This always stops and releases the old graph/URL. */
  setAudio(audio: Blob | undefined, sourceId = 'viewer'): void {
    this.release()
    this.currentSourceId = audio ? sourceId : null
    if (!audio) {
      this.setState('unavailable', true)
      return
    }
    try {
      const url = URL.createObjectURL(audio)
      const element = new Audio(url)
      element.autoplay = false
      element.loop = true
      // WebAudio applies 0.72 × 0.78 at the clip gain. This initial direct
      // value is replaced by applyElementSettings according to route support.
      element.volume = 0.72 * 0.78
      element.preload = 'metadata'
      element.addEventListener('playing', this.handlePlaying)
      element.addEventListener('pause', this.handlePause)
      element.addEventListener('error', this.handleError)
      this.objectUrl = url
      this.element = element
      this.applyElementSettings()
      // Force notification because changing from one stopped post to another
      // still needs to repaint both in-scene buttons.
      this.setState('stopped', true)
    } catch (error) {
      this.release()
      this.currentSourceId = sourceId
      this.setState('error', true)
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

    // This is deliberately inside toggle(): no WebAudio graph/context resume
    // happens while a card is loading or merely because a route was opened.
    if (!this.route) {
      this.route = mixer.createPositionalMediaRoute(element, 'sfx')
      this.route?.setPose(this.pose)
      this.applyElementSettings()
    }
    mixer.resume()

    const operation = ++this.operation
    this.setState('loading')
    try {
      await Promise.resolve(element.play())
      if (operation !== this.operation || element !== this.element) return
      this.setState(element.paused ? 'stopped' : 'playing')
    } catch (error) {
      if (operation !== this.operation || element !== this.element) return
      this.setState('error')
      this.onError?.(error)
    }
  }

  clear(): void {
    this.release()
    this.currentSourceId = null
    this.setState('unavailable', true)
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
    if (this.route) {
      // Authored/UI gain, output routing and focus policy all live downstream.
      element.volume = 1
      element.muted = false
      return
    }
    const settings = this.settings
    const master = Number(settings?.volMaster ?? 100) / 100
    const effects = Number(settings?.volSfx ?? 100) / 100
    element.volume = Math.max(0, Math.min(1, 0.72 * 0.78 * master * effects))
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
    }
    this.route?.dispose()
    this.route = null
    if (element) {
      element.removeAttribute('src')
      // Tell the media stack to release its decoder before revoking the URL.
      try { element.load() } catch { /* detached media element */ }
    }
    this.element = null
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl)
    this.objectUrl = null
  }

  private setState(state: AudioPlaybackState, force = false): void {
    if (!force && state === this.currentState) return
    this.currentState = state
    this.onState(state, this.currentSourceId)
  }
}
