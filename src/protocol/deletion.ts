import type { EventTemplate } from 'nostr-tools'
import { DELETE_KIND } from '../theme'
import { hexToBytes } from '../util/hex'
import { listOwnedPosts, type OwnedPostRecord } from './storage'
import type { RelayPool } from './nostr'

/**
 * POST DELETION (kind-5 tombstones). THE deletion module — if you are
 * looking for "where is delete implemented", it is HERE plus:
 *   - UI trigger: #btn-delete / #vbtn-delete in index.html (viewer bar),
 *     wired in main.ts ("deletion (owned posts only)" section) behind a
 *     D001 confirmation sheet.
 *   - Ownership: protocol/storage.ts `ownedPosts` store — per-post signing
 *     secrets saved by protocol/publish.ts at publish time. Only owned
 *     posts can produce a kind-5 that relays will accept (pubkey match).
 *   - Local effect: thread-index.ts `tombstone()` hides the post at once;
 *     incoming kind-5 events from relays do the same for everyone else.
 *
 * Deletion HIDES, it does not destroy (spec SECURITY): relays honouring
 * NIP-09 drop the event; Blossom servers may keep the bytes.
 */
export class DeletionService {
  /** eventId -> ownership record (per-post signing secret). */
  readonly owned = new Map<string, OwnedPostRecord>()

  constructor(private pool: RelayPool) {}

  /** Load ownership records from IndexedDB (once at boot, and after publishes). */
  async refresh(): Promise<void> {
    this.owned.clear()
    for (const rec of await listOwnedPosts()) this.owned.set(rec.eventId, rec)
  }

  /** Can THIS browser delete the post (i.e. does it hold the signing secret)? */
  canDelete(eventId: string | undefined): boolean {
    return !!eventId && this.owned.has(eventId)
  }

  /**
   * Publish the kind-5 tombstone for an owned post.
   * Returns per-relay results; the caller applies the LOCAL tombstone
   * immediately (the feed must not wait for relay acks).
   */
  async delete(eventId: string): Promise<{ ok: string[]; failed: string[] }> {
    const rec = this.owned.get(eventId)
    if (!rec) throw new Error('not an owned post')
    const template: EventTemplate = {
      kind: DELETE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['e', rec.eventId]],
      content: '',
    }
    const secret = hexToBytes(rec.secretKey)
    try {
      return await this.pool.publish(template, secret)
    } finally {
      secret.fill(0)
    }
  }
}
