/// <reference lib="webworker" />
// Poster encoding off the main thread.
//
// `canvas.toBlob` was ~4% of wall time during a board load (≈50 ms per
// poster) even though it already ran in an idle callback — it still competes
// with rendering and input on the main thread. OffscreenCanvas lets the whole
// flip + encode happen on a worker.
interface Job { id: number; pixels: ArrayBuffer; width: number; height: number }

self.onmessage = async (msg: MessageEvent<Job>) => {
  const { id, pixels, width, height } = msg.data
  try {
    const src = new Uint8Array(pixels)
    // GL readback is bottom-up; images are top-down.
    const out = new Uint8ClampedArray(src.length)
    const stride = width * 4
    for (let y = 0; y < height; y++) {
      out.set(src.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride)
    }
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.putImageData(new ImageData(out, width, height), 0, 0)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    ;(self as unknown as Worker).postMessage({ id, blob })
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ id, error: String(err) })
  }
}
