import { Scene } from '@babylonjs/core/scene'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import type { AssetContainer } from '@babylonjs/core/assetContainer'

/**
 * Take an `AssetContainer` whose meshes live in `sourceScene` and produce a
 * NEW `AssetContainer` whose meshes live in `targetScene`. The new container
 * uses freshly-CLONED meshes / materials / skeletons / animationGroups
 * (so the viewer's light rig and graphics pipeline do not leak into the
 * preview's pool, and vice versa).
 *
 * Why this exists (SPEC 04 §5):
 *   The board's live preview already keeps a parsed GLB in `previewScene`
 *   (the pool's hidden stage). When the user taps the same card to open
 *   the model view, re-parsing the GLB in `viewer.scene` is the most
 *   expensive thing the viewer does — and it is pure duplication: the
 *   bytes are identical, the parser result is identical, only the scene
 *   the meshes are bound to changes. This function hands off the
 *   already-parsed structure to the viewer so it shows the model
 *   instantly with no re-parse.
 *
 * Caveats:
 *   - The source's meshes are disposed; the preview RTT now renders an
 *     empty slot, and the pool will reclaim it on the next request().
 *   - Materials are cloned, so graphics changes (FXAA, tone mapping,
 *     color grading) applied to the viewer are NOT inherited from the
 *     preview pool — `graphics.applyToContainer` on the returned container
 *     will rebind them per the viewer's settings.
 *   - AnimationGroups are cloned; their `.targetedAnimations[i].target`
 *     is re-pointed at the cloned meshes by Babylon, so playback
 *     continues on the same pose from the same frame.
 *
 * Returns a new AssetContainer (not yet added to `targetScene`).
 */
export function handoffContainer(
  source: AssetContainer,
  sourceScene: Scene,
  targetScene: Scene,
  nameHint = 'viewer',
): AssetContainer {
  // Cloning happens IN the source scene (Babylon's instantiateModelsToScene
  // always operates on container.scene). Materials are cloned so each
  // scene's graphics pipeline owns its own copy.
  const entries = source.instantiateModelsToScene(
    (n) => `${nameHint}-${n}`,
    /* cloneMaterials */ true,
  )

  // Source container no longer needs its meshes; detach before we move
  // anything so the source scene's frame doesn't briefly render a
  // half-moved mesh set.
  source.removeAllFromScene()

  // ----- meshes + transform nodes -----
  for (const node of entries.rootNodes) {
    if (node instanceof Mesh) {
      moveMesh(node, sourceScene, targetScene)
    } else if (node instanceof TransformNode) {
      moveTransformNode(node, sourceScene, targetScene)
    }
    // Children of root nodes that were added by the clone: walk them and
    // re-bind too. addAllAssetsToContainer (below) handles bookkeeping,
    // but the scene's own *_scene pointer needs reassignment explicitly.
    for (const child of [...node.getChildMeshes(false)]) {
      moveMesh(child, sourceScene, targetScene)
    }
  }

  // ----- skeletons + animationGroups (cloned by instantiateModelsToScene) -----
  for (const sk of entries.skeletons) {
    sourceScene.removeSkeleton(sk)
    ;(sk as unknown as { _scene: Scene })._scene = targetScene
    targetScene.addSkeleton(sk)
  }
  for (const ag of entries.animationGroups) {
    sourceScene.removeAnimationGroup(ag)
    ;(ag as unknown as { _scene: Scene })._scene = targetScene
    targetScene.addAnimationGroup(ag)
  }

  // The source is now empty (meshes detached, materials cloned elsewhere).
  // Disposing the container does NOT touch the cloned materials/textures —
  // Babylon's dispose walks only the arrays held by the source container.
  source.dispose()

  // Wrap the moved entries in a fresh container bound to the target scene.
  // addAllAssetsToContainer walks descendants and registers every mesh,
  // material, light, camera, skeleton, etc. the clones reference.
  const c = new AssetContainer(targetScene)
  for (const root of entries.rootNodes) c.addAllAssetsToContainer(root)
  for (const sk of entries.skeletons) {
    if (c.skeletons.indexOf(sk) === -1) c.skeletons.push(sk)
  }
  for (const ag of entries.animationGroups) {
    if (c.animationGroups.indexOf(ag) === -1) c.animationGroups.push(ag)
  }
  return c
}

function moveMesh(m: Mesh, from: Scene, to: Scene): void {
  from.removeMesh(m)
  ;(m as unknown as { _scene: Scene })._scene = to
  to.addMesh(m)
}

function moveTransformNode(n: TransformNode, from: Scene, to: Scene): void {
  from.removeTransformNode(n)
  ;(n as unknown as { _scene: Scene })._scene = to
  to.addTransformNode(n)
}
