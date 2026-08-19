// Headless checks for load-path hash / size policy.
//   bun scripts/hash-unit.mjs
import {
  blobMatchesHash, blobToBytes, bytesToBlob, copyBytes, freezeBlob,
  HashMismatchError, isHashMismatch, isOversize, OversizeError, sha256Hex,
} from '../src/protocol/hash.ts'
import { BlossomClient } from '../src/protocol/blossom.ts'
import { ThreadIndex } from '../src/protocol/thread-index.ts'
import { validateGLBCached } from '../src/model/limits.ts'

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

const HEX = (n) => 'ab'.repeat(n)

// ------------------------------------------------------------------ helpers
function glbStub(extra = 0) {
  const b = new Uint8Array(20 + extra)
  b[0] = 0x67; b[1] = 0x6c; b[2] = 0x54; b[3] = 0x46 // 'glTF'
  return b
}

function mockFetch(bodies) {
  const orig = globalThis.fetch
  let i = 0
  globalThis.fetch = async () => {
    const body = bodies[Math.min(i, bodies.length - 1)]
    i++
    if (body === null) return { ok: false, status: 404, body: null, headers: { get: () => null } }
    let sent = false
    return {
      ok: true,
      status: 200,
      headers: { get: (n) => n.toLowerCase() === 'content-length' ? String(body.length) : null },
      body: {
        getReader() {
          return {
            async read() {
              if (sent) return { done: true, value: undefined }
              sent = true
              return { done: false, value: body }
            },
          }
        },
      },
    }
  }
  return () => { globalThis.fetch = orig }
}

function meta(over = {}) {
  return {
    eventId: HEX(32),
    pubkey: HEX(32),
    createdAt: 1,
    tint: '#111111',
    sha256: HEX(32),
    size: 16,
    native: true,
    mime: 'model/gltf-binary',
    urls: ['https://example.com/m.glb'],
    role: 'root',
    refs: {},
    animHint: false,
    cameraCount: 0,
    hasAudio: false,
    ...over,
  }
}

// ------------------------------------------------ sha256 of a view / slice
{
  const backing = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 9, 9, 9, 9])
  const view = backing.subarray(2, 6) // [2,3,4,5]
  const hView = await sha256Hex(view)
  const hExact = await sha256Hex(new Uint8Array([2, 3, 4, 5]))
  const hWhole = await sha256Hex(backing)
  check('sha256Hex hashes the view, not the backing store', hView === hExact && hView !== hWhole)
}

{
  const slice = new Uint8Array([9, 8, 7, 6, 5])
  const blob = bytesToBlob(slice)
  const out = await blobToBytes(blob)
  check('bytesToBlob / blobToBytes is exact-length', out.length === 5 && out[0] === 9 && out[4] === 5)
  slice[0] = 1
  check('bytesToBlob copied (slice mutation does not leak)', (await blobToBytes(blob))[0] === 9)
}

{
  const live = new Uint8Array([7, 7, 7, 7])
  const frozen = await freezeBlob(new Blob([live]))
  live[0] = 1
  check('freezeBlob still matches after source mutation', await blobMatchesHash(frozen.blob, frozen.sha256))
}

// ------------------------------------ blossom.download: hash wins over size
{
  const bytes = glbStub(40)
  const hash = await sha256Hex(bytes)
  const client = new BlossomClient()
  const restore = mockFetch([bytes])
  let got
  let err = null
  try { got = await client.download(['https://example.com/a.glb'], hash, 7) } catch (e) { err = e }
  restore()
  const back = got ? await blobToBytes(got) : null
  check('correct x + wrong size + matching bytes is ACCEPTED',
    !err && !!got && back?.length === bytes.length && await blobMatchesHash(got, hash),
    err ? String(err.message) : `size=${back?.length}`)
}

{
  const bytes = glbStub(16)
  const client = new BlossomClient()
  const restore = mockFetch([bytes])
  let err = null
  try { await client.download(['https://example.com/a.glb'], HEX(32), bytes.length) } catch (e) { err = e }
  restore()
  check('wrong x throws HashMismatchError (not a generic miss)',
    isHashMismatch(err) && err instanceof HashMismatchError)
}

{
  const bytes = glbStub(80)
  const hash = await sha256Hex(bytes)
  const client = new BlossomClient()
  const restore = mockFetch([bytes])
  let err = null
  try { await client.download(['https://example.com/a.glb'], hash, 0, 10) } catch (e) { err = e }
  restore()
  check('oversize is OversizeError, not a hash mismatch',
    isOversize(err) && err instanceof OversizeError && !isHashMismatch(err),
    err ? err.name + ': ' + err.message : 'no error')
}

{
  const bytes = glbStub(8)
  const client = new BlossomClient()
  const restore = mockFetch([bytes])
  let err = null
  try { await client.download(['https://example.com/a.glb'], '', bytes.length) } catch (e) { err = e }
  restore()
  check('empty hash is refused for GLB (not accepted unverified)',
    !!err && !isHashMismatch(err),
    err ? err.message : 'accepted')
}

{
  const bytes = glbStub(12)
  const hash = await sha256Hex(bytes)
  const client = new BlossomClient()
  const restore = mockFetch([null, bytes])
  let got
  try { got = await client.download(['https://a.example/x', 'https://b.example/x'], hash, 9999) } catch {}
  restore()
  check('second replica is hashed even when the size tag is wrong',
    !!got && await blobMatchesHash(got, hash))
}

// ------------------------------------ validateGLBCached is not keyed by claimed sha
{
  const sha = HEX(32)
  const a = new Uint8Array(32).fill(1)
  const b = new Uint8Array(32).fill(2)
  const r1 = validateGLBCached(a, sha)
  const r2 = validateGLBCached(b, sha)
  check('validateGLBCached does not reuse a verdict across different bodies', r1 !== r2)
  const r1b = validateGLBCached(a, sha)
  check('validateGLBCached still hits for the same Uint8Array', r1b === r1)
}

// ------------------------------------ thread flatten skips hashFailed / tombstone
{
  const idx = new ThreadIndex()
  const root = meta({ eventId: 'aa'.repeat(32), role: 'root', refs: {}, hashFailed: true })
  const kid = meta({
    eventId: 'bb'.repeat(32), role: 'reply',
    refs: { rootId: root.eventId, parentId: root.eventId },
  })
  const dead = meta({
    eventId: 'cc'.repeat(32), role: 'reply',
    refs: { rootId: root.eventId, parentId: root.eventId },
    tombstoned: true,
  })
  idx.add(root)
  idx.add(kid)
  idx.add(dead)
  // tombstone after add (add does not copy the flag into a new object)
  idx.tombstone(dead.eventId)
  idx.rejectHash(root.eventId)
  const flat = idx.flatten(root.eventId)
  check('flatten does not build a node for hashFailed meta', !flat.some((m) => m.eventId === root.eventId))
  check('flatten does not build a node for a tombstone', !flat.some((m) => m.eventId === dead.eventId))
  check('flatten still walks children of a hidden parent', flat.some((m) => m.eventId === kid.eventId),
    `n=${flat.length}`)
}

console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL HASH UNIT CHECKS PASSED')
process.exit(fails.length ? 1 : 0)
