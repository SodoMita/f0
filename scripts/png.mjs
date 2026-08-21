// Minimal PNG decoder for the pixel checks (Chromium screenshots: 8-bit,
// non-interlaced, colour type 2/6). No npm dependency — the sandbox has no
// image library and the render suites only need raw RGBA.
import zlib from 'node:zlib'

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

export const PNG = {
  /** @returns {{width:number,height:number,data:Uint8Array}} RGBA rows. */
  decode(buf) {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
    if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
    let off = 8
    let width = 0, height = 0, bitDepth = 8, colorType = 6, interlace = 0
    const idat = []
    while (off < b.length) {
      const len = b.readUInt32BE(off)
      const type = b.toString('ascii', off + 4, off + 8)
      const data = b.subarray(off + 8, off + 8 + len)
      if (type === 'IHDR') {
        width = data.readUInt32BE(0)
        height = data.readUInt32BE(4)
        bitDepth = data[8]
        colorType = data[9]
        interlace = data[12]
      } else if (type === 'IDAT') idat.push(data)
      else if (type === 'IEND') break
      off += 12 + len
    }
    if (bitDepth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (depth ${bitDepth}, interlace ${interlace})`)
    const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 4 ? 2 : 0
    if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`)
    const raw = zlib.inflateSync(Buffer.concat(idat))
    const stride = width * channels
    const out = new Uint8Array(width * height * 4)
    const line = new Uint8Array(stride)
    const prev = new Uint8Array(stride)
    let p = 0
    for (let y = 0; y < height; y++) {
      const filter = raw[p++]
      for (let x = 0; x < stride; x++) {
        const rawByte = raw[p + x]
        const a = x >= channels ? line[x - channels] : 0
        const up = prev[x]
        const c = x >= channels ? prev[x - channels] : 0
        let v
        switch (filter) {
          case 0: v = rawByte; break
          case 1: v = rawByte + a; break
          case 2: v = rawByte + up; break
          case 3: v = rawByte + ((a + up) >> 1); break
          case 4: v = rawByte + paeth(a, up, c); break
          default: throw new Error(`bad PNG filter ${filter}`)
        }
        line[x] = v & 0xff
      }
      p += stride
      for (let x = 0; x < width; x++) {
        const s = x * channels
        const d = (y * width + x) * 4
        if (channels >= 3) {
          out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]
          out[d + 3] = channels === 4 ? line[s + 3] : 255
        } else {
          out[d] = out[d + 1] = out[d + 2] = line[s]
          out[d + 3] = channels === 2 ? line[s + 1] : 255
        }
      }
      prev.set(line)
    }
    return { width, height, data: out }
  },
}
