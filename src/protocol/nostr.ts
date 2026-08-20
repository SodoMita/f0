import { Relay, finalizeEvent, generateSecretKey, type Event, type EventTemplate } from 'nostr-tools'
import { verifyFreshAsync } from './events'
import { DEFAULTS, DELETE_KIND, FORM_ZERO_TAG, MODEL_KIND } from '../theme'

export type RelayState = 'connecting' | 'online' | 'offline'

/** What the network panel needs to describe a relay beyond a coloured dot. */
export interface RelayInfo {
  state: RelayState
  /** last measured round-trip in ms (0 = never measured) */
  pingMs: number
  /** consecutive failed connection attempts (drives "retrying" copy) */
  attempts: number
  /** events this relay has delivered since boot */
  events: number
  /** epoch ms of the last state change */
  since: number
}

export class RelayPool {
  private relays = new Map<string, Relay>()
  private subs: Array<{ close: () => void }> = []
  private urls: string[] = [...DEFAULTS.relays]
  private closed = false
  private attempts = new Map<string, number>()
  private pings = new Map<string, number>()
  private events = new Map<string, number>()
  private changed = new Map<string, number>()
  private searchSub: { close: () => void } | null = null
  state = new Map<string, RelayState>()
  onEvent: ((event: Event) => void) | null = null
  onState: ((url: string, state: RelayState) => void) | null = null

  setRelays(urls: string[]): void {
    const normalized = Array.from(new Set(urls.map(normalizeRelay).filter((x): x is string => !!x)))
    this.urls = normalized.length ? normalized : [...DEFAULTS.relays]
  }
  get relayUrls(): string[] { return [...this.urls] }

  /** Everything the network panel shows for one relay row. */
  info(url: string): RelayInfo {
    return {
      state: this.state.get(url) ?? 'connecting',
      pingMs: this.pings.get(url) ?? 0,
      attempts: this.attempts.get(url) ?? 0,
      events: this.events.get(url) ?? 0,
      since: this.changed.get(url) ?? 0,
    }
  }

  /**
   * App-level ping on a LIVE connection: a REQ that can match nothing, timed
   * to its EOSE. That is the only round trip NIP-01 gives a browser (there is
   * no ping/pong frame in the WebSocket API), and it measures what actually
   * matters — how long this relay takes to answer a query.
   */
  async ping(url: string, timeoutMs = 6000): Promise<number> {
    const relay = this.relays.get(url)
    if (!relay || !relay.connected) {
      // not in the pool (or down): fall back to a fresh handshake
      const { ok, ms } = await RelayPool.probe(url, timeoutMs)
      if (ok) this.pings.set(url, ms)
      return ok ? ms : 0
    }
    const t0 = performance.now()
    const ms = await new Promise<number>((resolve) => {
      let done = false
      const finish = (v: number) => { if (!done) { done = true; resolve(v) } }
      const timer = setTimeout(() => finish(0), timeoutMs)
      try {
        // `#t` with a random tag value matches nothing, so the relay does no
        // work and sends EOSE immediately — this times the round trip, not a
        // query. limit:0 alone is not honoured by every implementation.
        const sub = relay.subscribe([{ kinds: [MODEL_KIND], '#t': ['form-zero-ping-' + Math.random().toString(36).slice(2)], limit: 1 }], {
          oneose: () => {
            clearTimeout(timer)
            try { sub.close() } catch { /* already closed */ }
            finish(Math.round(performance.now() - t0))
          },
          onclose: () => { clearTimeout(timer); finish(0) },
        })
      } catch { clearTimeout(timer); finish(0) }
    })
    if (ms > 0) { this.pings.set(url, ms); this.onState?.(url, this.state.get(url) ?? 'online') }
    return ms
  }

  /** Ping every configured relay at once (network panel refresh). */
  async pingAll(): Promise<void> {
    await Promise.allSettled(this.urls.map((u) => this.ping(u)))
  }

  /**
   * NIP-50 text search — the way to reach UNLOADED remote models (older than
   * the live feed's 14-day / limit window, or never streamed at all).
   *
   * Relays implement `{ search }` on an opt-in basis; `wss://relay.nostr.band`
   * (already a configured relay) is the one we target. Results are fed back
   * through the normal `onEvent` pipeline, so matches land in the ThreadIndex
   * and the board just renders them. Replaces any in-flight search REQ.
   *
   * Caveat: NIP-50 matches relay-defined text indexes (nostr.band indexes
   * event content and several tags). Since AMENDMENT 66 the model name rides
   * in the event `content`, so relay text search finds posts by name; older
   * posts carry the name only in the `filename` tag. Fresh posts can lag the
   * relay's index, and your OWN posts never depend on this — they are
   * indexed locally at publish and restored from storage at boot
   * (AMENDMENT 70). This is best-effort enrichment on top of the always-on
   * local filter, never a guarantee.
   */
  search(query: string, timeoutMs = 8000): void {
    this.cancelSearch()
    const q = query.trim()
    // nostr.band rejects / ignores very short queries; don't spam it.
    if (q.length < 3) return
    const url = 'wss://relay.nostr.band'
    const relay = this.relays.get(url)
    if (!relay || !relay.connected) return
    let timer = 0
    const close = () => {
      if (timer) { clearTimeout(timer); timer = 0 }
      if (this.searchSub === sub) this.searchSub = null
      try { sub.close() } catch { /* already closed */ }
    }
    const sub = relay.subscribe(
      [{ kinds: [MODEL_KIND], '#t': [FORM_ZERO_TAG], search: q, limit: 50 }],
      {
        onevent: (event) => {
          if (event.kind !== MODEL_KIND) return
          void verifyFreshAsync(event).then((ok) => {
            if (!ok) return
            this.events.set(url, (this.events.get(url) ?? 0) + 1)
            this.onEvent?.(event)
          })
        },
        oneose: () => {
          if (this.searchSub === sub) this.searchSub = null
          try { sub.close() } catch { /* already closed */ }
        },
        onclose: () => { if (timer) { clearTimeout(timer); timer = 0 } },
      },
    )
    this.searchSub = sub
    // Safety net: if a relay never sends EOSE, don't leave the REQ open.
    timer = window.setTimeout(close, timeoutMs)
  }

  /** Abort any in-flight NIP-50 search REQ (query cleared / superseded). */
  cancelSearch(): void {
    if (this.searchSub) {
      try { this.searchSub.close() } catch { /* already closed */ }
      this.searchSub = null
    }
  }

  connect(): void {
    for (const url of this.urls) { this.setState(url, 'connecting'); void this.open(url) }
  }

  /**
   * Live re-configuration (network panel): tear down every connection and
   * subscription, then reconnect with the new list. Stale URLs must not
   * resurrect via the retry loop — open()/scheduleRetry() check membership.
   */
  applyRelays(urls: string[]): void {
    this.setRelays(urls)
    for (const s of this.subs) s.close()
    this.subs = []
    // Detach onclose BEFORE closing: the deliberate teardown must not report
    // 'offline' for every relay (websocket close events fire async, so a
    // temporal flag would race) — that false-triggered the E201 error sheet.
    for (const r of this.relays.values()) { r.onclose = null; try { r.close() } catch { /* already closed */ } }
    this.relays.clear()
    this.attempts.clear()
    for (const url of [...this.state.keys()]) {
      if (this.urls.includes(url)) continue
      this.state.delete(url)
      this.pings.delete(url)
      this.events.delete(url)
      this.changed.delete(url)
      this.onState?.(url, 'offline')
    }
    this.connect()
  }

  /**
   * One-shot reachability probe (network panel). Does not join the pool.
   * Returns the WebSocket handshake time so an unconnected relay can still
   * show a ping.
   */
  static probe(url: string, timeoutMs = 5000): Promise<{ ok: boolean; ms: number }> {
    return new Promise((resolve) => {
      const normalized = normalizeRelay(url)
      if (!normalized) { resolve({ ok: false, ms: 0 }); return }
      const t0 = performance.now()
      let settled = false
      const done = (ok: boolean) => {
        if (settled) return
        settled = true
        try { ws.close() } catch { /* noop */ }
        resolve({ ok, ms: Math.round(performance.now() - t0) })
      }
      let ws: WebSocket
      try { ws = new WebSocket(normalized) } catch { resolve({ ok: false, ms: 0 }); return }
      const timer = setTimeout(() => done(false), timeoutMs)
      ws.onopen = () => { clearTimeout(timer); done(true) }
      ws.onerror = () => { clearTimeout(timer); done(false) }
    })
  }

  private setState(url: string, state: RelayState): void {
    if (this.state.get(url) === state) return
    this.state.set(url, state)
    this.changed.set(url, Date.now())
    this.onState?.(url, state)
  }

  private async open(url: string): Promise<void> {
    if (!this.urls.includes(url)) return // removed via applyRelays; don't resurrect
    // nostr-tools verifies every matching event ITSELF, synchronously, on the
    // main thread — on top of our own check. We verify in a worker before
    // dispatching (see events.verifyFreshAsync), so the relay's duplicate
    // check is disabled rather than paid for twice. (`verifyEvent` is private
    // in the .d.ts but settable at runtime; AbstractRelay reads it per event.)
    const relay = new Relay(url)
    ;(relay as unknown as { verifyEvent: (e: Event, url: string) => boolean }).verifyEvent = () => true
    this.relays.set(url, relay)
    relay.onclose = () => {
      if (this.closed) return
      this.setState(url, 'offline')
      this.scheduleRetry(url)
    }
    try {
      const t0 = performance.now()
      await relay.connect()
      // The handshake IS a round trip — seed the ping from it so a row shows
      // a latency immediately instead of waiting for the first explicit ping.
      this.pings.set(url, Math.round(performance.now() - t0))
      this.attempts.set(url, 0)
      this.setState(url, 'online')
      this.subscribe(url, relay)
    } catch {
      // Spec 00 §2.5: one slow relay must never gate first paint.
      this.setState(url, 'offline')
      this.scheduleRetry(url)
    }
  }

  private scheduleRetry(url: string): void {
    if (this.closed) return
    const n = (this.attempts.get(url) ?? 0) + 1
    this.attempts.set(url, n)
    const base = Math.min(30000, 1000 * 2 ** Math.min(n, 5))
    const delay = base / 2 + Math.random() * base
    setTimeout(() => { if (!this.closed) void this.open(url) }, delay)
  }

  private subscribe(url: string, relay: Relay): void {
    const since = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 14
    const s = relay.subscribe(
      [
        { kinds: [MODEL_KIND], '#t': [FORM_ZERO_TAG], limit: 200, since },
        { kinds: [MODEL_KIND], '#m': ['model/gltf-binary', 'model/gltf+json'], limit: 300, since },
        { kinds: [DELETE_KIND], limit: 120, since },
      ],
      {
        // cheap structural filter BEFORE the expensive signature check, so a
        // chatty relay cannot burn the main thread on events we would drop
        onevent: (event) => {
          if (event.kind !== MODEL_KIND && event.kind !== DELETE_KIND) return
          void verifyFreshAsync(event).then((ok) => {
            if (!ok) return
            // per-relay delivery count: the panel says which relay is
            // actually carrying the feed, not just which ones are green
            this.events.set(url, (this.events.get(url) ?? 0) + 1)
            this.onEvent?.(event)
          })
        },
        oneose: () => this.setState(url, 'online'),
      },
    )
    this.subs.push({ close: () => s.close() })
  }

  async publish(template: EventTemplate, secret: Uint8Array): Promise<{ ok: string[]; failed: string[] }> {
    const event = finalizeEvent(template, secret)
    const urls = [...this.relays.keys()]
    const results = await Promise.allSettled(urls.map((u) => this.relays.get(u)!.publish(event)))
    const ok: string[] = [], failed: string[] = []
    results.forEach((r, i) => (r.status === 'fulfilled' ? ok : failed).push(urls[i]))
    return { ok, failed }
  }

  close(): void {
    this.closed = true
    for (const s of this.subs) s.close()
    this.subs = []
    for (const r of this.relays.values()) r.close()
    this.relays.clear()
  }
}

export function normalizeRelay(value: string): string | null {
  try {
    const u = new URL(value.trim())
    if (u.protocol !== 'wss:') return null
    u.username = ''
    u.password = ''
    u.hash = ''
    u.search = ''
    if (u.pathname === '/') u.pathname = ''
    return u.toString().replace(/\/$/, '').toLowerCase()
  } catch { return null }
}

export { generateSecretKey }
