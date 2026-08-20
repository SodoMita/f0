import type { SettingsValues } from '../settings/schema'

export type Bus = 'master' | 'music' | 'sfx' | 'voice' | 'ui'

interface DeviceInfo { id: string; label: string }

export interface AudioPoint3 {
  x: number
  y: number
  z: number
}

/** Absolute scene-space pose for one positional source and the active camera. */
export interface SpatialAudioPose {
  source: AudioPoint3
  listener: AudioPoint3
  forward?: AudioPoint3
  up?: AudioPoint3
}

/** App-owned WebAudio graph for one media element. */
export interface PositionalMediaRoute {
  readonly source: MediaElementAudioSourceNode
  readonly panner: PannerNode
  readonly gain: GainNode
  setPose(pose: SpatialAudioPose): void
  dispose(): void
}

/**
 * Audio mixer: one AudioContext and one gain node per bus.
 *
 * Embedded post audio keeps browser media decoding, but each active element is
 * routed as MediaElementAudioSourceNode → PannerNode(HRTF) → clip gain → SFX
 * bus. The app owns every node so changing posts can disconnect the complete
 * graph deterministically. No context or media source starts playback by
 * itself; EmbeddedAudioPlayer creates/resumes it only from toggle().
 */
export class AudioMixer {
  private ctx: AudioContext | null = null
  private gains = new Map<Bus, GainNode>()
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

  /** Created lazily. A suspended context is still silent until a gesture resumes it. */
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

  /** Plain bus input for non-positional application sounds. */
  busInput(bus: Exclude<Bus, 'master'>): AudioNode | null {
    return this.ensure() ? (this.gains.get(bus) ?? null) : null
  }

  /**
   * Create a dedicated HRTF route for one HTMLMediaElement.
   *
   * 0.72 is the model's glTF gain and 0.78 is the UI base volume. Master and
   * effects settings remain downstream on the shared mixer buses.
   */
  createPositionalMediaRoute(
    element: HTMLMediaElement,
    bus: Exclude<Bus, 'master'> = 'sfx',
  ): PositionalMediaRoute | null {
    const ctx = this.ensure()
    const busGain = this.gains.get(bus)
    if (!ctx || !busGain) return null

    let source: MediaElementAudioSourceNode | null = null
    let panner: PannerNode | null = null
    let clipGain: GainNode | null = null
    try {
      source = ctx.createMediaElementSource(element)
      panner = ctx.createPanner()
      clipGain = ctx.createGain()

      panner.panningModel = 'HRTF'
      panner.distanceModel = 'inverse'
      // Flat board/tree cameras sit 30 world units in front of their cards.
      // Keep that front-on source at full authored loudness while preserving
      // lateral and depth cues as the camera pans or the feed scrolls.
      panner.refDistance = 30
      panner.maxDistance = 240
      panner.rolloffFactor = 0.35
      panner.coneInnerAngle = 360
      panner.coneOuterAngle = 360
      clipGain.gain.value = 0.72 * 0.78

      source.connect(panner)
      panner.connect(clipGain)
      clipGain.connect(busGain)

      let disposed = false
      const setPose = (pose: SpatialAudioPose): void => {
        if (disposed || !panner) return
        const now = ctx.currentTime
        setPannerPosition(panner, pose.source, now)
        setListenerPose(
          ctx.listener,
          pose.listener,
          pose.forward ?? { x: 0, y: 0, z: 1 },
          pose.up ?? { x: 0, y: 1, z: 0 },
          now,
        )
      }
      return {
        source,
        panner,
        gain: clipGain,
        setPose,
        dispose: () => {
          if (disposed) return
          disposed = true
          try { source?.disconnect() } catch { /* already disconnected */ }
          try { panner?.disconnect() } catch { /* already disconnected */ }
          try { clipGain?.disconnect() } catch { /* already disconnected */ }
        },
      }
    } catch {
      try { source?.disconnect() } catch { /* partial graph */ }
      try { panner?.disconnect() } catch { /* partial graph */ }
      try { clipGain?.disconnect() } catch { /* partial graph */ }
      return null
    }
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
    // Channel layout for non-positional surround passthrough. HRTF itself is
    // binaural and therefore asks for two destination channels.
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

  /** Resume after an explicit playback gesture (browsers require it). */
  resume(): void {
    const ctx = this.ensure()
    if (ctx && ctx.state === 'suspended') void ctx.resume()
  }
}

function setPannerPosition(node: PannerNode, p: AudioPoint3, now: number): void {
  if (node.positionX) {
    node.positionX.setValueAtTime(p.x, now)
    node.positionY.setValueAtTime(p.y, now)
    node.positionZ.setValueAtTime(p.z, now)
  } else {
    node.setPosition(p.x, p.y, p.z)
  }
}

function setListenerPose(
  listener: AudioListener,
  p: AudioPoint3,
  forward: AudioPoint3,
  up: AudioPoint3,
  now: number,
): void {
  if (listener.positionX) {
    listener.positionX.setValueAtTime(p.x, now)
    listener.positionY.setValueAtTime(p.y, now)
    listener.positionZ.setValueAtTime(p.z, now)
  } else {
    listener.setPosition(p.x, p.y, p.z)
  }
  if (listener.forwardX) {
    listener.forwardX.setValueAtTime(forward.x, now)
    listener.forwardY.setValueAtTime(forward.y, now)
    listener.forwardZ.setValueAtTime(forward.z, now)
    listener.upX.setValueAtTime(up.x, now)
    listener.upY.setValueAtTime(up.y, now)
    listener.upZ.setValueAtTime(up.z, now)
  } else {
    listener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z)
  }
}

export const mixer = new AudioMixer()
