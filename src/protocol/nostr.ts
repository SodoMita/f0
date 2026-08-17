import { SimplePool, finalizeEvent, generateSecretKey, type Event, type EventTemplate } from 'nostr-tools'
import { verifyFresh } from './events'
import { DEFAULTS, DELETE_KIND, FORM_ZERO_TAG, MODEL_KIND } from '../theme'

export type RelayState = 'connecting' | 'online' | 'offline'

export class RelayPool {
  private pool = new SimplePool()
  private sub: { close: () => void } | null = null
  private relays: string[] = [...DEFAULTS.relays]
  state = new Map<string, RelayState>()
  onEvent: ((event: Event) => void) | null = null
  onState: ((url: string, state: RelayState) => void) | null = null

  setRelays(urls: string[]): void {
    const normalized = Array.from(new Set(urls.map(normalizeRelay).filter(Boolean) as string[]))
    this.relays = normalized.length ? normalized : [...DEFAULTS.relays]
  }

  get relayUrls(): string[] {
    return [...this.relays]
  }

  connect(): void {
    this.sub?.close()
    for (const r of this.relays) {
      this.state.set(r, 'connecting')
      this.onState?.(r, 'connecting')
    }
    // We don't subscribe until subscribeBoard() is called; this just primes.
  }

  subscribeBoard(since = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 14): void {
    this.sub?.close()
    this.sub = this.pool.subscribeMany(
      this.relays,
      [
        { kinds: [MODEL_KIND], '#t': [FORM_ZERO_TAG], limit: 200, since },
        { kinds: [DELETE_KIND], '#t': [FORM_ZERO_TAG], since },
      ] as any,
      {
        onevent: (event) => {
          if (verifyFresh(event)) this.onEvent?.(event)
        },
        oneose: () => {
          for (const r of this.relays) {
            this.state.set(r, 'online')
            this.onState?.(r, 'online')
          }
        },
        onclose: (reasons) => {
          for (const r of reasons) {
            this.state.set(r.url, 'offline')
            this.onState?.(r.url, 'offline')
          }
        },
      },
    )
  }

  subscribeThread(rootId: string): () => void {
    const sub = this.pool.subscribeMany(
      this.relays,
      [
        { kinds: [MODEL_KIND], '#e': [rootId], since: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 90 },
        { kinds: [MODEL_KIND, DELETE_KIND], ids: [rootId] },
      ] as any,
      {
        onevent: (event) => {
          if (verifyFresh(event)) this.onEvent?.(event)
        },
      },
    )
    return () => sub.close()
  }

  async publish(template: EventTemplate, secret: Uint8Array): Promise<string[]> {
    const event = finalizeEvent(template, secret)
    return Promise.all(this.pool.publish(this.relays, event))
  }

  close(): void {
    this.sub?.close()
    this.pool.close(this.relays)
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
  } catch {
    return null
  }
}

export { generateSecretKey }
