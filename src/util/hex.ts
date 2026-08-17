export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0')
  return out
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1)
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
