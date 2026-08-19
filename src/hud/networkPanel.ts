import { RelayPool, normalizeRelay, type RelayState } from '../protocol/nostr'
import { BlossomClient } from '../protocol/blossom'
import { saveNetworkConfig } from '../protocol/storage'
import { DEFAULTS } from '../theme'
import { transfers, formatBytes, formatRate, type HostStats } from '../core/transfer'

// Network panel (#/network + net-dot). Add/remove/probe/reset relays and
// Blossom servers.
//
// A row is not just a coloured dot any more: it says what the connection is
// actually doing (connected / connecting / offline+retrying / probing /
// unreachable), how far away the server is (round-trip ping) and what it is
// moving right now (per-server download+upload rate, session totals, or —
// for relays, which move JSON we do not meter — how many events it has
// delivered). Relay rows track the pool's live state; Blossom rows have no
// persistent connection, so their state comes from probes (automatic when
// the panel opens, or the explicit "probe all" button).

function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement
}

type ProbeState = 'unknown' | 'connecting' | 'online' | 'offline'

const X_PATH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>'

/** The panel repaints once a second while open (event counts, statuses)… */
const TICK_MS = 1000
/** …and re-measures every server every Nth tick. */
const PING_EVERY_TICKS = 8

interface Row {
  li: HTMLLIElement
  dot: HTMLElement
  status: HTMLElement
  ping: HTMLElement
  flow: HTMLElement
}

export class NetworkPanel {
  private root = $('network-panel')
  private relayList = $('relay-list')
  private blossomList = $('blossom-list')
  private blossomProbes = new Map<string, ProbeState>()
  private blossomPing = new Map<string, number>()
  private relayRows = new Map<string, Row>()
  private blossomRows = new Map<string, Row>()
  private onClosed: (() => void) | null = null
  private tickTimer = 0
  private ticks = 0

  constructor(private pool: RelayPool, private blossoms: BlossomClient) {
    $('btn-network-close').addEventListener('click', () => this.close())
    bindAdd($('relay-add') as HTMLFormElement, (v) => this.addRelay(v))
    bindAdd($('blossom-add') as HTMLFormElement, (v) => this.addBlossom(v))
    $('btn-net-probe').addEventListener('click', () => void this.probeAll())
    $('btn-net-reset').addEventListener('click', () => this.reset())
    // live relay state -> row dots + status copy
    const prev = pool.onState
    pool.onState = (url, state) => { prev?.(url, state); this.render() }
    // live per-server byte rates: the meter already ticks at 200ms while
    // anything is in flight, so the rows follow without a timer of their own
    transfers.subscribe(() => { if (!this.root.hidden) this.paintFlow() })
  }

  open(onClosed?: () => void): void {
    this.onClosed = onClosed ?? null
    this.root.hidden = false
    this.render()
    // Opening the panel is the moment the player wants to know the state of
    // the network — measure it instead of showing a stale "not probed".
    void this.refresh()
    clearInterval(this.tickTimer)
    this.ticks = 0
    this.tickTimer = window.setInterval(() => {
      if (this.root.hidden) return
      // cheap: the rows are reused and only their text changes
      this.render()
      if (++this.ticks % PING_EVERY_TICKS === 0) void this.refresh()
    }, TICK_MS)
  }

  close(): void {
    if (this.root.hidden) return
    this.root.hidden = true
    clearInterval(this.tickTimer)
    this.tickTimer = 0
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
    void this.probeBlossoms()
    return true
  }

  private removeBlossom(url: string): void {
    const next = this.blossoms.servers.filter((u) => u !== url)
    this.blossoms.setServers(next.length ? next : [...DEFAULTS.blossoms])
    this.blossomProbes.delete(url)
    this.blossomPing.delete(url)
    this.persist()
    this.render()
  }

  private reset(): void {
    this.pool.applyRelays([...DEFAULTS.relays])
    this.blossoms.setServers([...DEFAULTS.blossoms])
    this.blossomProbes.clear()
    this.blossomPing.clear()
    this.persist()
    this.render()
    void this.refresh()
  }

  private persist(): void {
    void saveNetworkConfig({ relays: this.pool.relayUrls, blossoms: [...this.blossoms.servers] })
  }

  /** Measure everything: relay round-trips + Blossom reachability. */
  private async refresh(): Promise<void> {
    await Promise.allSettled([
      this.pool.pingAll().then(() => this.render()),
      this.probeBlossoms(),
    ])
  }

  private async probeBlossoms(): Promise<void> {
    await Promise.allSettled(this.blossoms.servers.map(async (url) => {
      if (this.blossomProbes.get(url) !== 'online') {
        this.blossomProbes.set(url, 'connecting')
        this.renderBlossoms()
      }
      const { ok, ms } = await BlossomClient.probe(url)
      this.blossomProbes.set(url, ok ? 'online' : 'offline')
      if (ok) this.blossomPing.set(url, ms)
      else this.blossomPing.delete(url)
      this.renderBlossoms()
    }))
  }

  private async probeAll(): Promise<void> {
    await this.refresh()
  }

  // ---------- rendering ----------

  private render(): void {
    this.renderRelays()
    this.renderBlossoms()
  }

  private renderRelays(): void {
    if (this.root.hidden) return
    const urls = this.pool.relayUrls
    syncRows(this.relayList, this.relayRows, urls, (url) => this.removeRelay(url))
    for (const url of urls) {
      const row = this.relayRows.get(url)
      if (!row) continue
      const info = this.pool.info(url)
      const state = relayStateClass(info.state)
      setDot(row.dot, state)
      row.status.textContent = relayStatusText(info.state, info.attempts)
      row.status.className = 'net-status ' + state
      setPing(row.ping, info.pingMs, state)
      // Relays speak JSON over a socket we do not byte-meter; what matters
      // for a relay is how much of the feed it is actually carrying. A
      // connected relay that has delivered nothing is a real diagnostic, so
      // say "no events" rather than leaving the column blank.
      row.flow.textContent = info.events > 0
        ? `${info.events} event${info.events === 1 ? '' : 's'}`
        : state === 'online' ? 'no events' : ''
    }
  }

  private renderBlossoms(): void {
    if (this.root.hidden) return
    const urls = [...this.blossoms.servers]
    syncRows(this.blossomList, this.blossomRows, urls, (url) => this.removeBlossom(url))
    for (const url of urls) {
      const row = this.blossomRows.get(url)
      if (!row) continue
      const state = this.blossomProbes.get(url) ?? 'unknown'
      setDot(row.dot, state)
      row.status.textContent = blossomStatusText(state)
      row.status.className = 'net-status ' + state
      setPing(row.ping, this.blossomPing.get(url) ?? 0, state)
    }
    this.paintFlow()
  }

  /** Per-server byte rates — repainted on every meter tick (200ms). */
  private paintFlow(): void {
    for (const [url, row] of this.blossomRows) {
      const h = transfers.hostStats(url)
      row.flow.textContent = flowText(h)
      row.flow.classList.toggle('live', h.active)
    }
  }
}

// ---------- copy ----------

function relayStateClass(s: RelayState | undefined): ProbeState {
  if (s === 'online') return 'online'
  if (s === 'connecting') return 'connecting'
  if (s === 'offline') return 'offline'
  return 'unknown'
}

function relayStatusText(state: RelayState, attempts: number): string {
  if (state === 'online') return 'connected'
  if (state === 'connecting') return 'connecting…'
  return attempts > 0 ? `offline · retry ${attempts}` : 'offline'
}

function blossomStatusText(state: ProbeState): string {
  if (state === 'online') return 'reachable'
  if (state === 'connecting') return 'probing…'
  if (state === 'offline') return 'unreachable'
  return 'not probed'
}

/**
 * `↓ 1.4 MiB/s ↑ 90 KiB/s` while transferring, otherwise what this server
 * has served this session. Empty when it has never been used.
 */
function flowText(h: HostStats): string {
  if (h.active) {
    const parts: string[] = []
    if (h.down.active) parts.push(`↓ ${formatRate(h.down.bps)}`)
    if (h.up.active) parts.push(`↑ ${formatRate(h.up.bps)}`)
    return parts.join('  ')
  }
  const parts: string[] = []
  if (h.session.down > 0) parts.push(`↓ ${formatBytes(h.session.down)}`)
  if (h.session.up > 0) parts.push(`↑ ${formatBytes(h.session.up)}`)
  return parts.join('  ')
}

/** Ping buckets keep the number honest: 2400ms should not read as "fine". */
function setPing(el: HTMLElement, ms: number, state: ProbeState): void {
  if (state === 'offline' || state === 'unknown' || ms <= 0) {
    el.textContent = state === 'connecting' ? '…' : '—'
    el.className = 'net-ping'
    return
  }
  el.textContent = `${ms} ms`
  el.className = 'net-ping ' + (ms < 150 ? 'good' : ms < 400 ? 'fair' : 'slow')
}

function setDot(dot: HTMLElement, state: ProbeState): void {
  dot.className = 'net-state' + (state === 'unknown' ? '' : ' ' + state)
  dot.title = state
}

// ---------- DOM ----------

/**
 * Rebuild the list only when the URL set changes; otherwise reuse the rows
 * and mutate their text. The rates repaint 5x a second — replaceChildren()
 * on every tick would churn the DOM and fight the remove buttons.
 */
function syncRows(
  list: HTMLElement,
  rows: Map<string, Row>,
  urls: string[],
  onRemove: (url: string) => void,
): void {
  const same = rows.size === urls.length && urls.every((u, i) => list.children[i] === rows.get(u)?.li)
  if (same) return
  for (const url of [...rows.keys()]) if (!urls.includes(url)) rows.delete(url)
  const items = urls.map((url) => {
    let row = rows.get(url)
    if (!row) { row = makeRow(url, () => onRemove(url)); rows.set(url, row) }
    return row.li
  })
  list.replaceChildren(...items)
}

function makeRow(url: string, onRemove: () => void): Row {
  const li = document.createElement('li')
  li.className = 'net-item'

  const dot = document.createElement('span')
  dot.className = 'net-state'

  const body = document.createElement('div')
  body.className = 'net-body'

  const name = document.createElement('span')
  name.className = 'url'
  name.textContent = url.replace(/^wss:\/\/|^https:\/\//, '')
  name.title = url

  const meta = document.createElement('span')
  meta.className = 'net-meta'
  const status = document.createElement('span')
  status.className = 'net-status'
  const ping = document.createElement('span')
  ping.className = 'net-ping'
  const flow = document.createElement('span')
  flow.className = 'net-flow'
  meta.append(status, ping, flow)
  body.append(name, meta)

  const btn = document.createElement('button')
  btn.className = 'net-remove'
  btn.title = 'remove'
  btn.setAttribute('aria-label', 'remove ' + url)
  btn.innerHTML = X_PATH
  btn.addEventListener('click', onRemove)

  li.append(dot, body, btn)
  return { li, dot, status, ping, flow }
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
