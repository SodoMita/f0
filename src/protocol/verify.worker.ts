/// <reference lib="webworker" />
// Signature verification off the main thread.
//
// secp256k1 verification costs ~40-60 ms of main thread PER EVENT, and a
// first run subscribes with limits totalling 600+ events. That is the single
// biggest JS cost during boot (measured with scripts/profile.mjs), and it
// lands as a burst of long tasks exactly while the board is trying to render
// its first cards.
import { verifyEvent, type Event } from 'nostr-tools'

self.onmessage = (msg: MessageEvent<{ id: number; event: Event }>) => {
  const { id, event } = msg.data
  let ok = false
  try {
    ok = verifyEvent(event)
  } catch {
    ok = false
  }
  ;(self as unknown as Worker).postMessage({ id, ok })
}
