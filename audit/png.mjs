// Tiny PNG reader for the audit harness — no PIL/numpy in the agent sandbox,
// and Playwright screenshots are the only compositor-accurate pixels we get
// (`gl.readPixels` on the default framebuffer can return a half-drawn frame
// because it is not preserved after compositing).
//
// Handles the 8-bit non-interlaced colours types a browser ever emits
// (grey / RGB / RGBA, filters 0-4). Deliberately small: it exists so a visual
// claim can be checked with numbers instead of eyes.
//
//   import { decode, rowProfile, seamRows } from './png.mjs'
//   const img = decode(await page.screenshot())      // Buffer or a file path
import { inflateSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

export function decode(src) {
  const buf = typeof src === 'string' ? readFileSync(src) : Buffer.isBuffer(src) ? src : Buffer.from(src)
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let off = 8
  let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0
  const idat = []
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4)
      bitDepth = data[8]; colorType = data[9]; interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (bit depth ${bitDepth}, interlace ${interlace})`)
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : null
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`)
  const stride = w * channels
  const raw = inflateSync(Buffer.concat(idat))
  const data = Buffer.alloc(h * stride)
  let p = 0
  const paeth = (a, b, c) => {
    const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < h; y++) {
    const filter = raw[p++]
    const line = raw.subarray(p, p + stride)
    p += stride
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null
    const cur = data.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= channels ? prev[x - channels] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) v += paeth(a, b, c)
      cur[x] = v & 0xff
    }
  }
  return { w, h, channels, data }
}

/** Rec.709 luminance of one pixel. */
export function lum(img, x, y) {
  const i = (y * img.w + x) * img.channels
  if (img.channels === 1) return img.data[i]
  return 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]
}

/** Mean luminance of each row across [x0,x1) — a horizontal scanline profile. */
export function rowProfile(img, x0 = 0, x1 = img.w, step = 2) {
  const rows = []
  const from = Math.max(0, x0 | 0)
  const to = Math.min(img.w, x1 | 0)
  for (let y = 0; y < img.h; y++) {
    let s = 0, n = 0
    for (let x = from; x < to; x += step) { s += lum(img, x, y); n++ }
    rows.push(n ? s / n : 0)
  }
  return rows
}

/** Mean luminance of each column across [y0,y1) — the vertical counterpart. */
export function colProfile(img, y0 = 0, y1 = img.h, step = 2) {
  const cols = []
  const from = Math.max(0, y0 | 0)
  const to = Math.min(img.h, y1 | 0)
  for (let x = 0; x < img.w; x++) {
    let s = 0, n = 0
    for (let y = from; y < to; y += step) { s += lum(img, x, y); n++ }
    cols.push(n ? s / n : 0)
  }
  return cols
}

/**
 * Rows that jump against their neighbours — the numeric form of "there is a
 * hard line across the image". `minStep` is in 0-255 luminance; 8-bit ramps
 * band by ~1, so anything >= 2 on a smooth gradient is a real edge.
 */
export function seamRows(rows, minStep = 2) {
  const out = []
  for (let y = 2; y < rows.length - 2; y++) {
    const ctx = (rows[y - 2] + rows[y - 1] + rows[y + 1] + rows[y + 2]) / 4
    const step = rows[y] - ctx
    if (Math.abs(step) >= minStep) out.push({ y, step: +step.toFixed(2), lum: +rows[y].toFixed(2) })
  }
  return out.sort((a, b) => Math.abs(b.step) - Math.abs(a.step))
}
