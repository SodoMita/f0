/**
 * Per-post ▶/⏸ intent (AMENDMENT 69). Autoplay starts animation silently;
 * sound only starts from a user tap. Explicit pause always wins.
 */
export class PlayIntent {
  autoplay = true
  private manual = new Set<string>()
  private paused = new Set<string>()

  isManual(id: string): boolean { return this.manual.has(id) }
  isPaused(id: string): boolean { return this.paused.has(id) }

  /** Auto-start or a user-started play, never a user-paused post. */
  wantsPlay(id: string): boolean {
    return this.manual.has(id) || (this.autoplay && !this.paused.has(id))
  }

  prune(live: ReadonlySet<string>): void {
    for (const id of [...this.manual]) if (!live.has(id)) this.manual.delete(id)
    for (const id of [...this.paused]) if (!live.has(id)) this.paused.delete(id)
  }

  /** Record a ▶/⏸ tap. Returns whether the post should now play (with sound). */
  toggle(id: string, playing: boolean): boolean {
    if (playing) {
      this.paused.add(id)
      this.manual.delete(id)
      return false
    }
    this.paused.delete(id)
    this.manual.add(id)
    return true
  }

  /**
   * Apply a new autoplay preference to currently-live posts.
   * `play(id)` is silent (no sound); `pause(id)` freezes in place.
   */
  setAutoplay(
    on: boolean,
    ids: Iterable<string>,
    isPlaying: (id: string) => boolean,
    play: (id: string) => void,
    pause: (id: string) => void,
  ): boolean {
    if (this.autoplay === on) return false
    this.autoplay = on
    for (const id of ids) {
      if (on && !this.paused.has(id) && !isPlaying(id)) play(id)
      else if (!on && !this.manual.has(id) && isPlaying(id)) pause(id)
    }
    return true
  }
}

export function playVisible(
  threeD: boolean, live3d: boolean, hasAnims: boolean,
  poster: boolean, rejected: boolean, maxSlots: number,
  animated: boolean | undefined, hint: boolean,
): boolean {
  if (threeD) return live3d && hasAnims
  if (!poster || rejected || maxSlots <= 0) return false
  return animated === true || (animated === undefined && hint)
}
