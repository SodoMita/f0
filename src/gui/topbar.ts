import * as GUI from '@babylonjs/gui'
import { Color3 } from '@babylonjs/core'
import { makeIconButton } from './icons'
import { theme } from '../theme'

export interface TopbarCallbacks {
  onAdd: () => void
  onShuffle: () => void
  onNetwork: () => void
  onHome: () => void
}

export class Topbar {
  readonly root: GUI.Grid
  private sphere: GUI.Ellipse
  private dot: GUI.Ellipse

  constructor(ui: GUI.AdvancedDynamicTexture, cb: TopbarCallbacks) {
    const grid = new GUI.Grid('topbar')
    grid.width = 1
    grid.height = '64px'
    grid.verticalAlignment = GUI.Control.VERTICAL_ALIGNMENT_TOP
    grid.paddingTop = '12px'
    grid.paddingLeft = '16px'
    grid.paddingRight = '16px'
    grid.addColumnDefinition(0.5)
    grid.addColumnDefinition(0.5, true)
    ui.addControl(grid)
    this.root = grid

    const left = new GUI.StackPanel('top-left')
    left.isVertical = false
    left.height = '40px'
    left.horizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_LEFT
    grid.addControl(left, 0, 0)

    const brand = new GUI.Rectangle('brand')
    brand.width = '40px'
    brand.height = '40px'
    brand.thickness = 0
    brand.background = 'transparent'
    const brandMark = new GUI.Rectangle('mark')
    brandMark.width = '18px'
    brandMark.height = '18px'
    brandMark.color = theme.paper
    brandMark.thickness = 2
    brandMark.background = 'transparent'
    brand.addControl(brandMark)
    brand.onPointerClickObservable.add(cb.onHome)
    left.addControl(brand)

    const right = new GUI.StackPanel('top-right')
    right.isVertical = false
    right.height = '40px'
    right.spacing = 8
    right.horizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_RIGHT
    grid.addControl(right, 0, 1)

    this.sphere = new GUI.Ellipse('relay-sphere')
    this.sphere.width = '20px'
    this.sphere.height = '20px'
    this.sphere.color = theme.muted
    this.sphere.thickness = 2
    this.sphere.background = 'transparent'
    this.dot = new GUI.Ellipse('relay-dot')
    this.dot.width = '8px'
    this.dot.height = '8px'
    this.dot.color = 'transparent'
    this.dot.thickness = 0
    this.dot.background = theme.muted
    this.sphere.addControl(this.dot)
    this.sphere.onPointerClickObservable.add(cb.onNetwork)
    right.addControl(this.sphere)

    const shuffle = makeIconButton('shuffle', 40)
    shuffle.onPointerClickObservable.add(cb.onShuffle)
    right.addControl(shuffle)

    const add = makeIconButton('plus', 40, theme.ink, theme.accent)
    add.onPointerClickObservable.add(cb.onAdd)
    right.addControl(add)
  }

  setNetworkState(state: 'none' | 'connecting' | 'partial' | 'online'): void {
    const map = {
      none: theme.muted,
      connecting: theme.warning,
      partial: theme.warning,
      online: theme.success,
    } as const
    this.dot.background = map[state]
    this.sphere.color = state === 'none' ? theme.muted : map[state]
  }

  setVisible(v: boolean): void {
    this.root.isVisible = v
  }
}

export function textLabel(text: string, color = theme.ink, size = 12): GUI.TextBlock {
  const t = new GUI.TextBlock('label', text)
  t.color = color
  t.fontSize = size
  t.fontFamily = 'monospace'
  t.resizeToFit = true
  return t
}
