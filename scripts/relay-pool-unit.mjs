// RelayPool reconnect must not stack sockets (idle OOM, AMENDMENT 73).
//   npx tsx scripts/relay-pool-unit.mjs
// WebSocket is captured by nostr-tools at module load, so FakeWS must be
// installed on globalThis BEFORE RelayPool is imported.

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!ok) fails.push(name)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class FakeWS {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances = []
  static failNext = 0
  static autoOpen = true
  readyState = 0
  url = ''
  onopen = null
  onerror = null
  onclose = null
  onmessage = null
  constructor(url) {
    this.url = url
    FakeWS.instances.push(this)
    if (FakeWS.failNext > 0) {
      FakeWS.failNext--
      queueMicrotask(() => this.fail())
    } else if (FakeWS.autoOpen) {
      queueMicrotask(() => this.accept())
    }
  }
  accept() {
    if (this.readyState !== 0) return
    this.readyState = 1
    this.onopen?.()
  }
  fail() {
    this.readyState = 3
    this.onerror?.()
    this.onclose?.({ message: 'fail' })
  }
  /** Remote drop — handlers still attached (unlike Relay.close()). */
  drop() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({ message: 'dropped' })
  }
  send() {}
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({ message: 'closed' })
  }
  static live() {
    return FakeWS.instances.filter((w) => w.readyState === 0 || w.readyState === 1)
  }
  static reset() {
    for (const w of FakeWS.instances) {
      w.onopen = w.onerror = w.onclose = w.onmessage = null
      w.readyState = 3
    }
    FakeWS.instances = []
    FakeWS.failNext = 0
    FakeWS.autoOpen = true
  }
}

globalThis.WebSocket = FakeWS
const { useWebSocketImplementation } = await import('nostr-tools/relay')
useWebSocketImplementation(FakeWS)
const { RelayPool } = await import('../src/protocol/nostr.ts')
const URL = 'wss://relay.test'

function pool() {
  const p = new RelayPool()
  p.retryDelayOverride = 15
  p.setRelays([URL])
  return p
}

{
  FakeWS.reset()
  const p = pool()
  p.connect()
  await sleep(40)
  check('first connect opens exactly one socket', FakeWS.live().length === 1, `live=${FakeWS.live().length} total=${FakeWS.instances.length}`)
  const c = p.debugCounts()
  check('first connect keeps one relay + one sub', c.relays === 1 && c.subs === 1 && c.opening === 0, JSON.stringify(c))
  p.close()
}

{
  FakeWS.reset()
  FakeWS.failNext = 1
  const p = pool()
  p.connect()
  await sleep(80)
  check('a failed handshake (onerror+onclose+reject) retries ONCE, not twice', FakeWS.live().length === 1, `live=${FakeWS.live().length} total=${FakeWS.instances.length}`)
  const c = p.debugCounts()
  check('failed handshake does not stack relays', c.relays <= 1 && c.opening <= 1 && c.retries <= 1, JSON.stringify(c))
  p.close()
}

{
  FakeWS.reset()
  const p = pool()
  p.connect()
  await sleep(40)
  for (let i = 0; i < 8; i++) {
    const live = FakeWS.live()
    if (!live.length) break
    live[0].drop()
    await sleep(50)
  }
  check('eight remote drops never leave more than one live socket', FakeWS.live().length === 1, `live=${FakeWS.live().length} total=${FakeWS.instances.length}`)
  const c = p.debugCounts()
  check('eight remote drops keep relays/subs/opening bounded to 1', c.relays <= 1 && c.subs <= 1 && c.opening <= 1 && c.retries <= 1, JSON.stringify(c))
  p.close()
}

{
  FakeWS.reset()
  const p = pool()
  p.connect()
  await sleep(40)
  p.close()
  const after = FakeWS.live().length
  FakeWS.live()[0]?.drop()
  await sleep(60)
  check('close() tears the socket down', after === 0, `liveAfterClose=${after}`)
  check('close() stops the retry loop', FakeWS.live().length === 0, `live=${FakeWS.live().length}`)
}

{
  FakeWS.reset()
  const p = pool()
  p.connect()
  p.applyRelays([URL])
  await sleep(50)
  check('applyRelays mid-connect does not stack sockets', FakeWS.live().length === 1, `live=${FakeWS.live().length} total=${FakeWS.instances.length}`)
  const c = p.debugCounts()
  check('applyRelays mid-connect keeps one relay', c.relays <= 1 && c.opening <= 1, JSON.stringify(c))
  p.close()
}

{
  FakeWS.reset()
  const p = pool()
  p.connect()
  await sleep(40)
  p.connect()
  p.connect()
  await sleep(40)
  check('connect() is idempotent while already online', FakeWS.live().length === 1, `live=${FakeWS.live().length}`)
  p.close()
}

console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL RELAY POOL UNIT CHECKS PASSED')
process.exit(fails.length ? 1 : 0)
