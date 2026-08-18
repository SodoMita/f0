// Live transfer meter — the single source of truth for "how fast are bytes
// moving right now". Every Blossom download (models + posters) and every
// Blossom upload registers here, so the loading ring, the studio publish
// status and the network panel can all show real download/upload speeds
// instead of an opaque spinner.
//
// Speed is measured over a short sliding window (not a running average over
// the whole transfer): a stalled replica must visibly drop to 0, and a fast
// tail must show up immediately. Samples are cumulative byte counts, so
// transfers that start/finish mid-window never make the rate jump.

export type TransferDir = 'down' | 'up'

/** Per-direction snapshot. `total` is 0 when no active transfer knows its size. */
export interface DirStats {
  /** in-flight transfers */
  active: number
  /** bytes moved so far by the in-flight transfers */
  bytes: number
  /** expected bytes for the in-flight transfers (0 = unknown) */
  total: number
  /** smoothed bytes per second over the sample window */
  bps: number
}

export interface TransferStats {
  down: DirStats
  up: DirStats
  /** true while anything is in flight in either direction */
  active: boolean
  /** bytes moved since the app booted, per direction (never reset) */
  session: { down: number; up: number }
}

export interface TransferHandle {
  /** report newly moved bytes (a delta, not a cumulative count) */
  advance(bytes: number): void
  /** late-bound expected size (e.g. from a Content-Length) */
  setTotal(total: number): void
  /** finish (success or failure) — always call, ideally from a `finally` */
  end(): void
}

const WINDOW_MS = 2000
const TICK_MS = 200

interface Sample { t: number; bytes: number }

interface Live { total: number; bytes: number }

class DirMeter {
  /** monotonic byte counter, never reset — samples diff against it */
  private cumulative = 0

  /** total bytes moved since boot (the session counter) */
  get moved(): number { return this.cumulative }
  private samples: Sample[] = [{ t: performance.now(), bytes: 0 }]
  private live = new Set<Live>()

  start(total: number): Live {
    const t: Live = { total: Math.max(0, total | 0), bytes: 0 }
    this.live.add(t)
    return t
  }

  end(t: Live): void {
    this.live.delete(t)
    if (!this.live.size) {
      // Idle: collapse the window so a later transfer doesn't inherit the
      // old slope (and so the reported rate falls to 0 right away).
      this.samples = [{ t: performance.now(), bytes: this.cumulative }]
    }
  }

  advance(t: Live, bytes: number): void {
    if (!(bytes > 0)) return
    t.bytes += bytes
    this.cumulative += bytes
  }

  sample(now: number): void {
    this.samples.push({ t: now, bytes: this.cumulative })
    // keep one sample older than the window so short windows still have a base
    let drop = 0
    while (drop + 1 < this.samples.length && now - this.samples[drop + 1].t > WINDOW_MS) drop++
    if (drop) this.samples.splice(0, drop)
  }

  stats(now: number): DirStats {
    let bytes = 0
    let total = 0
    let sized = true
    for (const t of this.live) {
      bytes += t.bytes
      if (t.total > 0) total += t.total
      else sized = false
    }
    const first = this.samples[0]
    const dt = (now - first.t) / 1000
    const moved = this.cumulative - first.bytes
    const bps = this.live.size && dt > 0.05 ? Math.max(0, moved / dt) : 0
    return { active: this.live.size, bytes, total: sized ? total : 0, bps }
  }
}

export class TransferMeter {
  private down = new DirMeter()
  private up = new DirMeter()
  private listeners = new Set<(s: TransferStats) => void>()
  private timer = 0

  /**
   * Register a transfer. The returned handle is cheap; call `end()` exactly
   * once (a leaked handle would pin the meter "active" forever).
   */
  track(dir: TransferDir, total = 0): TransferHandle {
    const meter = dir === 'up' ? this.up : this.down
    const live = meter.start(total)
    let ended = false
    this.ensureTimer()
    // Emit right away so the HUD shows "0 B/s · 0/18 MiB" the instant a
    // transfer begins instead of waiting up to a tick for the first sample.
    this.emit()
    return {
      advance: (bytes: number) => { if (!ended) meter.advance(live, bytes) },
      setTotal: (t: number) => { if (!ended && t > 0) live.total = t | 0 },
      end: () => { if (ended) return; ended = true; meter.end(live); this.emit() },
    }
  }

  subscribe(fn: (s: TransferStats) => void): () => void {
    this.listeners.add(fn)
    fn(this.stats())
    return () => { this.listeners.delete(fn) }
  }

  stats(): TransferStats {
    const now = performance.now()
    const down = this.down.stats(now)
    const up = this.up.stats(now)
    return {
      down, up,
      active: down.active > 0 || up.active > 0,
      session: { down: this.down.moved, up: this.up.moved },
    }
  }

  /** A ticking clock only exists while something is in flight. */
  private ensureTimer(): void {
    if (this.timer) return
    this.timer = (globalThis.setInterval as typeof setInterval)(() => {
      const now = performance.now()
      this.down.sample(now)
      this.up.sample(now)
      const s = this.stats()
      this.fire(s)
      if (!s.active) {
        clearInterval(this.timer)
        this.timer = 0
      }
    }, TICK_MS) as unknown as number
  }

  private emit(): void {
    this.fire(this.stats())
  }

  private fire(s: TransferStats): void {
    for (const fn of this.listeners) {
      try { fn(s) } catch { /* a broken listener must not stall transfers */ }
    }
  }
}

/** App-wide meter. Protocol code reports into it; the HUD reads it. */
export const transfers = new TransferMeter()

const MIB = 1048576

/** "820 KiB" / "12.4 MiB" — matches the MiB units used elsewhere in the UI. */
export function formatBytes(n: number): string {
  if (!(n > 0)) return '0 B'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < MIB) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KiB`
  return `${(n / MIB).toFixed(n < 10 * MIB ? 1 : 0)} MiB`
}

/** "1.4 MiB/s" */
export function formatRate(bps: number): string {
  return `${formatBytes(bps)}/s`
}

/**
 * One compact line for a direction, e.g.
 *   `↓ 1.4 MiB/s · 3.2/18 MiB · 18%`   (size known)
 *   `↑ 640 KiB/s · 2.1 MiB`            (size unknown)
 * `arrow` may be '' when the surface already shows the direction.
 */
export function formatDirStats(arrow: string, d: DirStats): string {
  const head = `${arrow} ${formatRate(d.bps)}`.trim()
  if (d.total > 0) {
    const pct = Math.min(100, Math.round((d.bytes / d.total) * 100))
    return `${head} · ${formatProgress(d.bytes, d.total)} · ${pct}%`
  }
  return `${head} · ${formatBytes(d.bytes)}`
}

/** "3.0/10 MiB" — the unit is printed once when both sides agree. */
export function formatProgress(done: number, total: number): string {
  const a = formatBytes(done)
  const b = formatBytes(total)
  const unit = b.slice(b.indexOf(' ') + 1)
  if (a.endsWith(' ' + unit)) return `${a.slice(0, a.length - unit.length - 1)}/${b}`
  return `${a}/${b}`
}
