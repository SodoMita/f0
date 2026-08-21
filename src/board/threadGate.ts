/**
 * True when a thread node is large enough on screen to bother fetching a
 * poster or a 3D model. `ThreadView.fit()` frames the WHOLE tree, so every
 * node is "in view" on open — without this gate a large thread still parsed
 * every GLB (the 2D-open freeze). Viewport height in world units is
 * `40 * zoom` (ortho half-height 20·zoom).
 */
export function nodeWorthTexture(nodeH: number, zoom: number, cssH: number, minPx = 48): boolean {
  const worldH = 40 * Math.max(1e-6, zoom)
  return (nodeH / worldH) * Math.max(1, cssH) >= minPx
}
