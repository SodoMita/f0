import * as GUI from '@babylonjs/gui'

/**
 * Local symbol dictionary. Drawn as vector paths via a canvas data URL; no
 * icon fonts or external SVGs are used.
 */
export type IconDrawer = (size: number, color: string) => GUI.Control

const cache = new Map<string, string>()

function rasterizePath(d: string, size: number, color: string, fill = false): string {
  const key = `${d}|${size}|${color}|${fill}`
  const cached = cache.get(key)
  if (cached) return cached
  const canvas = document.createElement('canvas')
  canvas.width = size * 2
  canvas.height = size * 2
  const ctx = canvas.getContext('2d')!
  ctx.scale(2, 2)
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = Math.max(1.4, size / 14)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const path = new Path2D(d)
  if (fill) ctx.fill(path)
  ctx.stroke(path)
  const url = canvas.toDataURL('image/png')
  cache.set(key, url)
  return url
}

function pathIcon(d: string, size: number, color: string, fill = false): GUI.Control {
  const rect = new GUI.Rectangle('icon-bg')
  rect.width = `${size}px`
  rect.height = `${size}px`
  rect.thickness = 0
  rect.background = 'transparent'
  const img = new GUI.Image('icon', rasterizePath(d, size, color, fill))
  img.width = 1
  img.height = 1
  img.stretch = GUI.Image.STRETCH_UNIFORM
  rect.addControl(img)
  return rect
}

export const ICONS = {
  close: (s: number, c: string) => pathIcon('M4 4 L20 20 M20 4 L4 20', s, c),
  plus: (s: number, c: string) => pathIcon('M12 3 V21 M3 12 H21', s, c),
  relay: (s: number, c: string) => pathIcon('M12 12 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0 M4 12 a8 8 0 0 1 16 0 M1 12 a11 11 0 0 1 22 0', s, c),
  blossom: (s: number, c: string) => pathIcon('M12 3 C7 3 4 7 4 12 C4 17 8 21 12 21 C16 21 20 17 20 12 C20 7 17 3 12 3 Z M12 8 V16 M8 12 H16', s, c),
  thread: (s: number, c: string) => pathIcon('M7 4 V20 M7 9 H17 V20 M12 9 V14', s, c),
  open: (s: number, c: string) => pathIcon('M14 4 H20 V10 M20 4 L11 13 M18 14 V20 H4 V6 H10', s, c),
  download: (s: number, c: string) => pathIcon('M12 3 V15 M7 11 L12 16 L17 11 M4 19 H20', s, c),
  delete: (s: number, c: string) => pathIcon('M5 8 H19 M9 8 V5 H15 V8 M7 8 L8 21 H16 L17 8 M10 12 V17 M14 12 V17', s, c),
  audio: (s: number, c: string) => pathIcon('M4 10 V14 H8 L13 18 V6 L8 10 H4 Z M16 9 a4 4 0 0 1 0 6 M18 7 a7 7 0 0 1 0 10', s, c),
  camera: (s: number, c: string) => pathIcon('M3 8 H7 L9 5 H15 L17 8 H21 V19 H3 Z M12 11 a3 3 0 1 0 0 6 a3 3 0 1 0 0 -6 Z', s, c),
  shuffle: (s: number, c: string) => pathIcon('M16 4 L20 8 L16 12 M20 8 H7 a3 3 0 0 0 -3 3 M8 20 L4 16 L8 12 M4 16 H17 a3 3 0 0 0 3 -3', s, c),
  error: (s: number, c: string) => pathIcon('M12 3 L22 20 H2 Z M12 10 V15 M12 18 V18.1', s, c),
  orbit: (s: number, c: string) => pathIcon('M12 5 a8 4 0 1 0 0.1 0 M12 5 V3 M12 21 V19', s, c),
  reply: (s: number, c: string) => pathIcon('M4 11 a8 8 0 0 1 16 0 M12 15 L7 11 L12 7', s, c),
  metadata: (s: number, c: string) => pathIcon('M5 4 H19 V20 H5 Z M8 8 H16 M8 12 H16 M8 16 H13', s, c),
  import: (s: number, c: string) => pathIcon('M4 16 V20 H20 V16 M12 3 V15 M7 10 L12 15 L17 10', s, c),
  text: (s: number, c: string) => pathIcon('M5 5 H19 M12 5 V19 M9 19 H15', s, c),
  voxel: (s: number, c: string) => pathIcon('M12 3 L21 7 V17 L12 21 L3 17 V7 Z M3 7 L12 11 L21 7 M12 11 V21', s, c),
  symbol: (s: number, c: string) => pathIcon('M12 2 L22 12 L12 22 L2 12 Z', s, c),
}

export function makeIconButton(
  icon: keyof typeof ICONS,
  size = 40,
  color = '#F2EEE8',
  bg = '#121213cc',
): GUI.Button {
  const btn = GUI.Button.CreateSimpleButton('btn-' + icon, '')
  btn.width = `${size}px`
  btn.height = `${size}px`
  btn.thickness = 1
  btn.color = 'transparent'
  btn.background = bg
  btn.cornerRadius = size / 4
  btn.paddingTop = `${size * 0.18}px`
  btn.paddingBottom = `${size * 0.18}px`
  btn.paddingLeft = `${size * 0.18}px`
  btn.paddingRight = `${size * 0.18}px`
  btn.onPointerEnterObservable.add(() => { btn.background = '#1d1c1d' })
  btn.onPointerOutObservable.add(() => { btn.background = bg })
  const inner = ICONS[icon](size * 0.66, color)
  btn.addControl(inner)
  return btn
}
