/// <reference lib="webworker" />
// Signature verification off the main thread.
//
// secp256k1 verification costs ~40-60 ms of main thread PER EVENT, and a
// first run subscribes with limits totalling 600+ events. That is the single
// biggest JS cost during boot (measured with scripts/profile.mjs), and it
// lands as a burst of long tasks exactly while the board is trying to render
// its first cards.
import { verifyEvent, type Event } from 'nostr-tools'

// Guard `self`: bun/tsx load this file as a normal module (Vite's
// `?worker&inline` is the only path that wraps it in a Worker). Touching
// `self` on the main thread / in Node throws and used to make every unit
// script that imported the protocol fail.
const scope = globalThis as unknown as Worker & { document?: unknown }
if (typeof scope.postMessage === 'function' && typeof scope.document === 'undefined') {
  scope.onmessage = (msg: MessageEvent<{ id: number; event: Event }>) => {
    const { id, event } = msg.data
    let ok = false
    try {
      ok = verifyEvent(event)
    } catch {
      ok = false
    }
    scope.postMessage({ id, ok })
  }
}

// Vite's `?worker&inline` import ignores the worker entry's exports (it wraps
// the inlined blob in its own constructor class); this default exists only so
// bare bundlers (bun running the headless unit scripts) can resolve the
// module. Never construct it — worker startup goes through self.onmessage.
export default class {}
