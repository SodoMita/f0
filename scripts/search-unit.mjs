// Search + own-post restore units (AMENDMENT 70) — no browser needed.
//   bun scripts/search-unit.mjs
// Covers the filter semantics (filename / base name / content / event id),
// the persisted post snapshot -> ThreadMeta rebuild, and the tombstone guard.
import { ThreadIndex, matchesSearchQuery } from '../src/protocol/thread-index.ts'
import { markOwnedPostTombstoned, ownedToMeta, saveOwnedPost, listOwnedPosts } from '../src/protocol/storage.ts'

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

const meta = (over = {}) => ({
  eventId: 'ab'.repeat(32), pubkey: 'cd'.repeat(32), createdAt: 1700000000,
  tint: '#1b1a1a', sha256: 'ef'.repeat(32), size: 1024, native: true,
  mime: 'model/gltf-binary', urls: ['https://example.com/x.glb'],
  width: 448, height: 280, role: 'root', refs: {},
  animHint: false, cameraCount: 0, hasAudio: false, ...over,
})

// ---------------------------------------------------------------- filter
check('blank query matches everything', matchesSearchQuery(meta(), '') && matchesSearchQuery(meta(), '   '))
check('filename matches', matchesSearchQuery(meta({ filename: 'bush.glb' }), 'bush'))
check('base name matches (extension stripped)', matchesSearchQuery(meta({ filename: 'red.cube.glb' }), 'red.cube'))
check('content (name) matches', matchesSearchQuery(meta({ filename: 'n.glb', name: 'tiny round bush' }), 'ROUND'))
check('content-only post matches (no filename)', matchesSearchQuery(meta({ name: '/0 hello' }), 'hello'))
check('event id matches', matchesSearchQuery(meta(), 'ab'))
check('unrelated query stays out', !matchesSearchQuery(meta({ filename: 'bush.glb', name: 'bush' }), 'cube'))
check('case-insensitive both sides', matchesSearchQuery(meta({ filename: 'BUSH.glb' }), 'Bush'))

// --------------------------------------------- snapshot -> ThreadMeta
const rec = {
  eventId: 'ab'.repeat(32), secretKey: '00'.repeat(32), modelSha256: 'ef'.repeat(32),
  modelUrls: ['https://example.com/b.glb'], relays: [], createdAt: 1700000000,
  meta: { pubkey: 'cd'.repeat(32), mime: 'model/gltf-binary', size: 512, tint: '#ff0000', width: 448, height: 280, filename: 'bush.glb', name: 'bush' },
}
const m = ownedToMeta(rec)
check('ownedToMeta rebuilds a searchable root meta', !!m && m.eventId === rec.eventId && m.role === 'root' && m.filename === 'bush.glb' && m.name === 'bush' && matchesSearchQuery(m, 'bush'), JSON.stringify(m && { e: m.eventId, r: m.role, f: m.filename, n: m.name }))

const reply = ownedToMeta({ ...rec, eventId: '11'.repeat(32), rootId: 'ab'.repeat(32), parentId: 'ab'.repeat(32) })
check('ownedToMeta keeps replies as replies', reply?.role === 'reply' && reply.refs.parentId === 'ab'.repeat(32))

check('legacy record (no snapshot) yields null', ownedToMeta({ ...rec, meta: undefined }) === null)

// --------------------------------------------- index integration
const idx = new ThreadIndex()
idx.add(m)
const roots = [...idx.byId.values()]
  .filter((x) => x.role === 'root' && !x.tombstoned && !x.hashFailed)
  .filter((x) => matchesSearchQuery(x, 'bush'))
check('restored post lands as a searchable root', roots.length === 1 && roots[0].eventId === rec.eventId)

idx.tombstone(rec.eventId)
const after = [...idx.byId.values()].filter((x) => x.role === 'root' && !x.tombstoned && !x.hashFailed)
check('tombstoned post leaves the root list', after.length === 0)

// AMENDMENT 72: hash-failure marks are retryable — reject hides the root,
// unreject puts it back so a retry can re-attempt the download.
const m2 = ownedToMeta({ ...rec, eventId: '44'.repeat(32) })
idx.add(m2)
const rootsBefore = [...idx.byId.values()].filter((x) => x.role === 'root' && !x.tombstoned && !x.hashFailed).length
idx.rejectHash(m2.eventId)
check('rejected (hashFailed) post leaves the root list', [...idx.byId.values()].filter((x) => x.role === 'root' && !x.tombstoned && !x.hashFailed).length === rootsBefore - 1)
idx.unrejectHash(m2.eventId)
const retried = [...idx.byId.values()].filter((x) => x.role === 'root' && !x.tombstoned && !x.hashFailed)
check('unrejectHash returns the post to the root list for retry', retried.length === rootsBefore && retried.some((x) => x.eventId === m2.eventId))

// --------------------------------------------- tombstone persistence
// The owned-post record must remember a deletion, or boot restore would
// resurrect the post. saveOwnedPost runs through the same validation as the
// app; markOwnedPostTombstoned then flips the flag in place.
await saveOwnedPost({ ...rec, secretKey: 'ab'.repeat(32), tombstoned: undefined })
await markOwnedPostTombstoned(rec.eventId)
const afterDelete = await listOwnedPosts()
const del = afterDelete.find((r) => r.eventId === rec.eventId)
check('owned-post record persists the tombstone (no restore-resurrection)', del?.tombstoned === true && !!del?.meta && ownedToMeta(del)?.filename === 'bush.glb')

console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL SEARCH UNIT CHECKS PASSED')
process.exit(fails.length ? 1 : 0)
