import type { SettingsValues } from '../settings/schema'

export type Bus = 'master' | 'music' | 'sfx' | 'voice' | 'ui'

interface DeviceInfo { id: string; label: string }

/**
 * Audio mixer: one AudioContext, one gain node per bus, plus device routing.
 *
 * Everything the web platform actually provides is here — per-bus volume,
 * output device selection (`AudioContext.setSinkId`, Chromium 110+), input
 * device enumeration for recording, HRTF spatialisation, channel count for
 * surround passthrough, and mute-on-blur. Object-based formats (Atmos, Windows
 * Sonic) are applied by the OS on the chosen output device; the browser only
 * hands it channels.
 *
 * Models can carry audio (spec AMENDMENT 11); playback routes through
 * `connect()` so it lands on the right bus and obeys the mixer.
 */
export class AudioMixer {
  private ctx: AudioContext | null = null
  private gains = new Map<Bus, GainNode>()
  private panner: PannerNode | null = null
  private values: SettingsValues | null = null
  private focused = true
  outputs: DeviceInfo[] = []
  inputs: DeviceInfo[] = []
  onDevices: (() => void) | null = null

  constructor() {
    if (typeof window === 'undefined') return
    window.addEventListener('blur', () => { this.focused = false; this.updateGains() })
    window.addEventListener('focus', () => { this.focused = true; this.updateGains() })
    document.addEventListener('visibilitychange', () => {
      this.focused = !document.hidden
      this.updateGains()
    })
  }

  /** Created lazily: an AudioContext before a user gesture starts suspended. */
  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx
    try {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return null
      this.ctx = new Ctor()
      const master = this.ctx.createGain()
      master.connect(this.ctx.destination)
      this.gains.set('master', master)
      for (const bus of ['music', 'sfx', 'voice', 'ui'] as Bus[]) {
        const g = this.ctx.createGain()
        g.connect(master)
        this.gains.set(bus, g)
      }
      if (this.values) this.apply(this.values)
    } catch {
      this.ctx = null
    }
    return this.ctx
  }

  get context(): AudioContext | null { return this.ctx }

  /** Create the AudioContext if it does not exist yet (still lazy: an
   *  AudioContext before a user gesture starts suspended). */
  ensureContext(): AudioContext | null { return this.ensure() }

  /**
   * The master bus gain node. External sound stacks (Babylon's Sound engine
   * for MSFT_audio_emitter post audio) connect HERE so they obey master
   * volume and mute-on-blur like everything else.
   */
  masterOutput(): GainNode | null {
    return this.ensure() ? (this.gains.get('master') ?? null) : null
  }

  /** Node to feed a source into, e.g. `source.connect(mixer.busInput('sfx'))`. */
  busInput(bus: Exclude<Bus, 'master'>): AudioNode | null {
    const ctx = this.ensure()
    if (!ctx) return null
    if (this.values?.spatialAudio === 'hrtf') {
      if (!this.panner) {
        this.panner = ctx.createPanner()
        this.panner.panningModel = 'HRTF'
        this.panner.distanceModel = 'inverse'
      }
      this.panner.connect(this.gains.get(bus)!)
      return this.panner
    }
    return this.gains.get(bus) ?? null
  }

  async refreshDevices(): Promise<void> {
    try {
      const devices = await navigator.mediaDevices?.enumerateDevices()
      if (!devices) return
      this.outputs = devices.filter((d) => d.kind === 'audiooutput')
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Output ${i + 1}` }))
      this.inputs = devices.filter((d) => d.kind === 'audioinput')
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }))
      this.onDevices?.()
    } catch { /* permission not granted yet: labels stay empty */ }
  }

  apply(values: SettingsValues): void {
    this.values = values
    if (!this.ctx) return
    this.updateGains()
    void this.applySink(String(values.audioOutput ?? 'default'))
    // channel layout for surround passthrough
    try {
      const dest = this.ctx.destination
      const wanted = values.spatialAudio === 'surround' ? dest.maxChannelCount : 2
      if (dest.maxChannelCount >= wanted) {
        dest.channelCount = Math.max(1, values.spatialAudio === 'mono' ? 1 : wanted)
        dest.channelInterpretation = 'speakers'
      }
    } catch { /* some browsers pin the channel count */ }
  }

  private updateGains(): void {
    const v = this.values
    if (!v || !this.ctx) return
    const silent = !this.focused && !v.audioBackground
    const master = Number(v.volMaster ?? 100) / 100
    const set = (bus: Bus, level: number) => {
      const g = this.gains.get(bus)
      if (!g) return
      const target = silent ? 0 : level
      g.gain.setTargetAtTime(target, this.ctx!.currentTime, 0.02)
    }
    set('master', master)
    set('music', Number(v.volMusic ?? 80) / 100)
    set('sfx', Number(v.volSfx ?? 100) / 100)
    set('voice', Number(v.volVoice ?? 100) / 100)
    set('ui', Number(v.volUi ?? 60) / 100)
  }

  private async applySink(deviceId: string): Promise<void> {
    const ctx = this.ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null
    if (!ctx?.setSinkId) return
    try { await ctx.setSinkId(deviceId === 'default' ? '' : deviceId) } catch { /* device vanished */ }
  }

  /** Resume after the first user gesture (browsers require it). */
  resume(): void {
    const ctx = this.ensure()
    if (ctx && ctx.state === 'suspended') void ctx.resume()
  }
}

export const mixer = new AudioMixer()
