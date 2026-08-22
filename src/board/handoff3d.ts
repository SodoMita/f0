import type { Scene } from '@babylonjs/core/scene'
import type { Sound } from '@babylonjs/core/Audio/sound'
import { handoffContainer } from '../core/sceneTransfer'
import type { PreviewPool } from './previewPool'
import type { Direct3DPool, Place3D } from './modelCard3d'

/** Move live 2D preview parses into the visible 3D pool (no re-download). */
export function adoptPreviewInto3d(
  preview: PreviewPool,
  pool3d: Direct3DPool,
  target: Scene,
  cells: Map<string, { place: Place3D; cameraIndex?: number }>,
): void {
  for (const [id, cell] of cells) {
    const live = preview.acquire(id)
    if (!live) continue
    let moved: Sound[] = []
    try {
      const { container, sounds } = handoffContainer(live.container, preview.scene, target, live.offset, 'd3')
      moved = sounds
      if (!pool3d.adopt(id, container, cell.place, cell.cameraIndex, sounds)) container.dispose()
      live.commit(new Set(moved))
    } catch { live.rollback(new Set(moved)) }
  }
}
