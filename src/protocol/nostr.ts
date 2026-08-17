import { Relay, finalizeEvent, generateSecretKey, type Event, type EventTemplate } from 'nostr-tools'
import { verifyFreshAsync } from './events'
import { DEFAULTS, DELETE_KIND, FORM_ZERO_TAG, MODEL_KIND } from '../theme'

export type RelayState = 'connecting' | 'online' | 'offline'

export class RelayPool {
  private relays = new Map<string, Relay>()
  private subs: Array<{ close: () => void }> = []
  private urls: string[] = [...DEFAULTS.relays]
  private closed = false
  private attempts = new Map<string, number>()
  state = new Map<string, RelayState>()
  onEvent: ((event: Event) => void) | null = null
  onState: ((url: string, state: RelayState) => void) | null = null

  setRelays(urls: string[]): void {
    const normalized = Array.from(new Set(urls.map(normalizeRelay).filter((x): x is string => !!x)))
    this.urls = normalized.length ? normalized : [...DEFAULTS.relays]
  }
  get relayUrls(): string[] { return [...this.urls] }

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
      if (!this.urls.includes(url)) { this.state.delete(url); this.onState?.(url, 'offline') }
    }
    this.connect()
  }

  /** One-shot reachability probe (network panel). Does not join the pool. */
  static probe(url: string, timeoutMs = 5000): Promise<boolean> {
    return new Promise((resolve) => {
      const normalized = normalizeRelay(url)
      if (!normalized) { resolve(false); return }
      let settled = false
      const done = (ok: boolean) => { if (!settled) { settled = true; try { ws.close() } catch { /* noop */ } resolve(ok) } }
      let ws: WebSocket
      try { ws = new WebSocket(normalized) } catch { resolve(false); return }
      const timer = setTimeout(() => done(false), timeoutMs)
      ws.onopen = () => { clearTimeout(timer); done(true) }
      ws.onerror = () => { clearTimeout(timer); done(false) }
    })
  }

  private setState(url: string, state: RelayState): void {
    if (this.state.get(url) === state) return
    this.state.set(url, state)
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
      await relay.connect()
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
          void verifyFreshAsync(event).then((ok) => { if (ok) this.onEvent?.(event) })
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
