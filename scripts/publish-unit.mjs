// Headless checks for publish hash snapshots + abort helpers.
//   bun scripts/publish-unit.mjs
import { blobMatchesHash, copyBytes, freezeBlob, isAbortError, sha256Hex, throwIfAborted } from '../src/protocol/hash.ts'

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

const hex = (n) => 'ab'.repeat(n)

{
  const src = new Uint8Array([1, 2, 3, 4, 5])
  const copy = copyBytes(src)
  src[0] = 9
  check('copyBytes is detached from the source', copy[0] === 1 && src[0] === 9)
}

{
  const a = new Uint8Array([10, 20, 30, 40])
  const h1 = await sha256Hex(a)
  a[0] = 99
  const h2 = await sha256Hex(new Uint8Array([10, 20, 30, 40]))
  check('sha256Hex does not depend on later mutation of the input', h1 === h2)
  check('sha256Hex is 64 hex chars', /^[0-9a-f]{64}$/.test(h1), h1)
}

{
  const live = new Uint8Array([7, 7, 7, 7])
  const blob = new Blob([live])
  const frozen = await freezeBlob(blob)
  live[0] = 1
  live[1] = 2
  const again = await sha256Hex(frozen.bytes)
  check('freezeBlob hash survives mutating the source buffer', again === frozen.sha256)
  check('frozen blob still matches its own hash', await blobMatchesHash(frozen.blob, frozen.sha256))
  const other = new Blob([new Uint8Array([1, 2, 3])])
  check('blobMatchesHash rejects a different body', !(await blobMatchesHash(other, frozen.sha256)))
  check('blobMatchesHash rejects a garbage hash', !(await blobMatchesHash(frozen.blob, hex(32))))
}

{
  let threw = false
  try { throwIfAborted(AbortSignal.abort()) } catch (e) { threw = isAbortError(e) }
  check('throwIfAborted raises AbortError', threw)
  const ctrl = new AbortController()
  let late = false
  try { throwIfAborted(ctrl.signal) } catch { late = true }
  check('throwIfAborted is quiet while live', !late)
}

console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL PUBLISH UNIT CHECKS PASSED')
process.exit(fails.length ? 1 : 0)
