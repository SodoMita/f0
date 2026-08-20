import type { AnimationGroup } from '@babylonjs/core/Animations/animationGroup'

/**
 * Manual playback driver for the viewer's imported AnimationGroups.
 *
 * WHY manual: Babylon's own animation clock cannot do stepped (whole-frame
 * hold) playback, reverse looping, or scrubbing without restarting the
 * group. So the active group is started once and immediately paused — that
 * materialises its Animatables — and every render tick advances a float
 * frame cursor here and writes the pose with `goToFrame`. One driver, one
 * code path for all four features: track switching, timeline scrub,
 * stepped playback, direction + speed.
 */
export class TrackAnimator {
  private groups: AnimationGroup[] = []
  private idx = -1
  private frameCursor = 0
  private playingFlag = false
  private speedVal = 1
  private forwardVal = true
  private steppedVal = false
  // Last frame actually written to the group — stepped mode holds the pose
  // on whole frames, so most ticks write nothing.
  private lastPosed = Number.NaN
  /** HUD hook: fired whenever the cursor moves (tick or seek). */
  onFrame: ((frame: number) => void) | null = null

  /** Adopt a container's groups. Stops any group that arrived mid-play
   *  (live-preview handoffs do) so this driver is the only clock. */
  setGroups(groups: AnimationGroup[], startIdx: number, autoplay: boolean): void {
    this.clear()
    this.groups = groups
    for (const g of groups) g.stop()
    if (groups.length) {
      this.setTrack(Math.max(0, Math.min(startIdx, groups.length - 1)))
      this.playingFlag = autoplay
    }
  }

  clear(): void {
    const g = this.groups[this.idx]
    if (g) { try { g.stop() } catch { /* group may already be disposed */ } }
    this.groups = []
    this.idx = -1
    this.frameCursor = 0
    this.playingFlag = false
    this.lastPosed = Number.NaN
  }

  get count(): number { return this.groups.length }
  /** GLB animation names, with a fallback for unnamed tracks. */
  get names(): string[] { return this.groups.map((g, i) => g.name?.trim() || `track ${i + 1}`) }
  get index(): number { return this.idx }
  get playing(): boolean { return this.playingFlag && this.idx >= 0 }
  get frame(): number { return this.frameCursor }
  get speed(): number { return this.speedVal }
  get forward(): boolean { return this.forwardVal }
  get stepped(): boolean { return this.steppedVal }

  setSpeed(x: number): void { this.speedVal = Math.max(0.01, Math.min(16, x)) }
  setDirection(forward: boolean): void { this.forwardVal = forward }
  setStepped(on: boolean): void { this.steppedVal = on; this.lastPosed = Number.NaN; this.pose() }

  range(): { from: number; to: number } | null {
    const g = this.groups[this.idx]
    return g ? { from: g.from, to: g.to } : null
  }

  setTrack(i: number): void {
    const g = this.groups[i]
    if (!g || i === this.idx) return
    const prev = this.groups[this.idx]
    if (prev) prev.stop()
    this.idx = i
    // Start-then-pause: creates the Animatables (so goToFrame can pose the
    // targets) without letting Babylon's clock advance the group itself.
    g.start(true, 1.0)
    g.pause()
    this.frameCursor = this.forwardVal ? g.from : g.to
    this.lastPosed = Number.NaN
    this.pose()
  }

  play(): void { if (this.idx >= 0) this.playingFlag = true }
  pause(): void { this.playingFlag = false }
  toggle(): void { this.playingFlag && this.idx >= 0 ? this.pause() : this.play() }

  seek(frame: number): void {
    const g = this.groups[this.idx]
    if (!g) return
    this.frameCursor = Math.max(g.from, Math.min(g.to, frame))
    this.lastPosed = Number.NaN
    this.pose()
  }

  /** Nudge by whole frames (the , / . shortcuts). Pauses playback. */
  step(delta: number): void {
    const g = this.groups[this.idx]
    if (!g) return
    this.playingFlag = false
    const span = g.to - g.from
    let f = Math.round(this.frameCursor) + delta
    if (span > 0) { // wrap so repeated taps loop through the clip
      while (f > g.to) f -= span
      while (f < g.from) f += span
    }
    this.seek(f)
  }

  /** Advance the cursor; called once per render (scene onBeforeRender). */
  tick(dtMs: number): void {
    const g = this.groups[this.idx]
    if (!g || !this.playingFlag) return
    const span = g.to - g.from
    if (span <= 0) return
    const fps = g.targetedAnimations[0]?.animation.framePerSecond || 60
    // Render-on-demand can leave long gaps between frames; a clamped dt
    // resumes smoothly instead of jumping ahead by the idle time.
    const dt = Math.min(dtMs, 100) / 1000
    this.frameCursor += (this.forwardVal ? 1 : -1) * this.speedVal * fps * dt
    while (this.frameCursor > g.to) this.frameCursor -= span
    while (this.frameCursor < g.from) this.frameCursor += span
    this.pose()
  }

  private pose(): void {
    const g = this.groups[this.idx]
    if (!g) return
    const f = this.steppedVal ? Math.floor(this.frameCursor) : this.frameCursor
    if (f !== this.lastPosed) { g.goToFrame(f); this.lastPosed = f }
    this.onFrame?.(this.frameCursor)
  }
}
