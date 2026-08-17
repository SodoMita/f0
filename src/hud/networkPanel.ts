import { RelayPool, normalizeRelay, type RelayState } from '../protocol/nostr'
import { BlossomClient } from '../protocol/blossom'
import { saveNetworkConfig } from '../protocol/storage'
import { DEFAULTS } from '../theme'

// Network panel (#/network + net-dot). Add/remove/probe/reset relays and
// Blossom servers. Relay rows reuse the pool's live state; Blossom rows get
// state only from explicit probes (HTTP servers aren't persistent
// connections, so there is nothing "live" to show).

function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement
}

type ProbeState = 'unknown' | 'connecting' | 'online' | 'offline'

const X_PATH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>'

export class NetworkPanel {
  private root = $('network-panel')
  private relayList = $('relay-list')
  private blossomList = $('blossom-list')
  private blossomProbes = new Map<string, ProbeState>()
  private onClosed: (() => void) | null = null

  constructor(private pool: RelayPool, private blossoms: BlossomClient) {
    $('btn-network-close').addEventListener('click', () => this.close())
    bindAdd($('relay-add') as HTMLFormElement, (v) => this.addRelay(v))
    bindAdd($('blossom-add') as HTMLFormElement, (v) => this.addBlossom(v))
    $('btn-net-probe').addEventListener('click', () => void this.probeAll())
    $('btn-net-reset').addEventListener('click', () => this.reset())
    // live relay state -> row dots
    const prev = pool.onState
    pool.onState = (url, state) => { prev?.(url, state); this.renderRelays() }
  }

  open(onClosed?: () => void): void {
    this.onClosed = onClosed ?? null
    this.root.hidden = false
    this.render()
  }

  close(): void {
    if (this.root.hidden) return
    this.root.hidden = true
    const cb = this.onClosed
    this.onClosed = null
    cb?.()
  }

  get isOpen(): boolean { return !this.root.hidden }

  // ---------- mutations ----------

  private addRelay(value: string): boolean {
    const url = normalizeRelay(value)
    if (!url || this.pool.relayUrls.includes(url)) return false
    this.pool.applyRelays([...this.pool.relayUrls, url])
    this.persist()
    this.render()
    return true
  }

  private removeRelay(url: string): void {
    const next = this.pool.relayUrls.filter((u) => u !== url)
    // never allow an empty pool: applyRelays falls back to defaults, which
    // is what the spec wants (the app must always have a data source)
    this.pool.applyRelays(next)
    this.persist()
    this.render()
  }

  private addBlossom(value: string): boolean {
    const before = this.blossoms.servers.length
    this.blossoms.setServers([...this.blossoms.servers, value])
    if (this.blossoms.servers.length === before) return false
    this.persist()
    this.render()
    return true
  }

  private removeBlossom(url: string): void {
    const next = this.blossoms.servers.filter((u) => u !== url)
    this.blossoms.setServers(next.length ? next : [...DEFAULTS.blossoms])
    this.persist()
    this.render()
  }

  private reset(): void {
    this.pool.applyRelays([...DEFAULTS.relays])
    this.blossoms.setServers([...DEFAULTS.blossoms])
    this.blossomProbes.clear()
    this.persist()
    this.render()
  }

  private persist(): void {
    void saveNetworkConfig({ relays: this.pool.relayUrls, blossoms: [...this.blossoms.servers] })
  }

  private async probeAll(): Promise<void> {
    const relayJobs = this.pool.relayUrls.map(async (url) => {
      // relays already in the pool show live state; probe only ones offline
      if (this.pool.state.get(url) === 'online') return
      await RelayPool.probe(url)
    })
    const blossomJobs = this.blossoms.servers.map(async (url) => {
      this.blossomProbes.set(url, 'connecting')
      this.renderBlossoms()
      const ok = await BlossomClient.probe(url)
      this.blossomProbes.set(url, ok ? 'online' : 'offline')
      this.renderBlossoms()
    })
    await Promise.allSettled([...relayJobs, ...blossomJobs])
    this.render()
  }

  // ---------- rendering ----------

  private render(): void {
    this.renderRelays()
    this.renderBlossoms()
  }

  private renderRelays(): void {
    if (this.root.hidden) return
    this.relayList.replaceChildren(
      ...this.pool.relayUrls.map((url) =>
        row(url, relayStateClass(this.pool.state.get(url)), () => this.removeRelay(url))),
    )
  }

  private renderBlossoms(): void {
    if (this.root.hidden) return
    this.blossomList.replaceChildren(
      ...this.blossoms.servers.map((url) =>
        row(url, this.blossomProbes.get(url) ?? 'unknown', () => this.removeBlossom(url))),
    )
  }
}

function relayStateClass(s: RelayState | undefined): ProbeState {
  if (s === 'online') return 'online'
  if (s === 'connecting') return 'connecting'
  if (s === 'offline') return 'offline'
  return 'unknown'
}

function row(url: string, state: ProbeState, onRemove: () => void): HTMLLIElement {
  const li = document.createElement('li')
  li.className = 'net-item'
  const dot = document.createElement('span')
  dot.className = 'net-state' + (state === 'unknown' ? '' : ' ' + state)
  dot.title = state
  const span = document.createElement('span')
  span.className = 'url'
  span.textContent = url.replace(/^wss:\/\/|^https:\/\//, '')
  span.title = url
  const btn = document.createElement('button')
  btn.className = 'net-remove'
  btn.title = 'remove'
  btn.setAttribute('aria-label', 'remove ' + url)
  btn.innerHTML = X_PATH
  btn.addEventListener('click', onRemove)
  li.append(dot, span, btn)
  return li
}

function bindAdd(form: HTMLFormElement, add: (value: string) => boolean): void {
  const input = form.querySelector('input') as HTMLInputElement
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const ok = add(input.value)
    input.classList.toggle('bad', !ok && input.value.trim() !== '')
    if (ok) input.value = ''
  })
  input.addEventListener('input', () => input.classList.remove('bad'))
}
