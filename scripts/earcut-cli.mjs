// stdin: JSON { data: number[] /* xy xy … */, holes?: number[] }
// stdout: JSON number[] triangle indices
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'

async function loadEarcut() {
  try { return (await import('earcut')).default }
  catch { /* not in the app tree */ }
  const req = createRequire(import.meta.url)
  try { return req('earcut') }
  catch { /* try a throwaway install dir */ }
  try { return req('/tmp/f0-earcut/node_modules/earcut') }
  catch { /* install once */ }
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync('npm', ['install', '--prefix', '/tmp/f0-earcut', '--no-save', 'earcut@2.2.4'], {
    encoding: 'utf8', timeout: 120000,
  })
  if (r.status !== 0) return null
  return req('/tmp/f0-earcut/node_modules/earcut')
}

const earcut = await loadEarcut()
if (!earcut) {
  console.error('earcut module missing')
  process.exit(2)
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
const chunks = []
for await (const line of rl) chunks.push(line)
const input = JSON.parse(chunks.join('\n') || '{}')
const data = input.data
const holes = input.holes ?? []
if (!Array.isArray(data) || data.length < 6) {
  console.log('[]')
  process.exit(0)
}
const idx = earcut(data, holes.length ? holes : undefined, 2)
console.log(JSON.stringify(idx))
