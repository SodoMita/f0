import { Scene } from '@babylonjs/core/scene'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import type { Node } from '@babylonjs/core/node'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import type { Camera } from '@babylonjs/core/Cameras/camera'
import type { Sound } from '@babylonjs/core/Audio/sound'
import { AssetContainer } from '@babylonjs/core/assetContainer'

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
 * The `worldOffset` is subtracted from every rootNode's local position so
 * the model ends up at the target scene's origin instead of wherever the
 * source pool staged it (the preview pool stages each slot 800 units along
 * +X so the slots' frustums don't overlap).
 *
 * Returns `{ container, sounds }`: a new AssetContainer (not yet added to
 * `targetScene`) plus the model's MSFT_audio_emitter sounds, which are
 * re-attached to the cloned nodes and re-registered on `targetScene`'s
 * mainSoundTrack (AMENDMENT 84 — without this the hand-off path dropped a
 * model's audio, since commit() disposes the stage scene's sounds).
 */
export function handoffContainer(
  source: AssetContainer,
  sourceScene: Scene,
  targetScene: Scene,
  worldOffset: Vector3 = new Vector3(0, 0, 0),
  nameHint = 'viewer',
): { container: AssetContainer; sounds: Sound[] } {
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

  // The clones inherit the slot's staging offset in their local position
  // (setParent(null) inside acquire() preserved the world matrix into
  // local). Subtract the offset so the model lands at the origin in
  // viewer.scene, where the orbit camera expects it.
  if (worldOffset.x !== 0 || worldOffset.y !== 0 || worldOffset.z !== 0) {
    for (const root of entries.rootNodes) {
      if ('position' in root && (root as TransformNode).position) {
        (root as TransformNode).position.subtractInPlace(worldOffset)
      }
    }
  }

  // ----- meshes + transform nodes -----
  // Move the FULL clone tree: instantiateModelsToScene clones every root
  // node (transform nodes AND meshes) with their whole descendant chain.
  // Each clone is registered in sourceScene (the clone constructors call
  // scene.addMesh/addTransformNode), so we must move every level — roots,
  // intermediate transform nodes and meshes — or the scene bookkeeping
  // ends up inconsistent (a mesh's parent in one scene, the mesh in
  // another). A Set guards against a node being reachable from two roots.
  const movedNodes = new Set<object>()
  for (const root of entries.rootNodes) {
    if (root instanceof Mesh) moveMesh(root, sourceScene, targetScene, movedNodes)
    else if (root instanceof TransformNode) moveTransformNode(root, sourceScene, targetScene, movedNodes)
    for (const child of root.getDescendants(false)) {
      if (child instanceof Mesh) moveMesh(child, sourceScene, targetScene, movedNodes)
      else if (child instanceof TransformNode) moveTransformNode(child, sourceScene, targetScene, movedNodes)
    }
  }

  // ----- authored cameras -----
  // instantiateModelsToScene clones meshes / materials / skeletons /
  // animationGroups but NOT cameras — the GLB's authored cameras must be
  // recreated for the viewer (camera dots + authored framing, SPEC 04 §5).
  // Camera.clone() materialises in the source scene; move it over like any
  // other node.
  const cameraClones: Camera[] = []
  for (const cam of source.cameras) {
    const clone = cam.clone(`${nameHint}-cam-${cam.name}`)
    if (!clone) continue
    sourceScene.removeCamera(clone)
    ;(clone as unknown as { _scene: Scene })._scene = targetScene
    targetScene.addCamera(clone)
    cameraClones.push(clone)
  }
  // Lights: instantiateModelsToScene does not clone lights either; the
  // byte-loading path (LoadAssetContainerAsync -> addAllToScene) keeps
  // them, so hand off clones for the same result.
  const lightClones: import('@babylonjs/core/Lights/light').Light[] = []
  for (const l of source.lights) {
    const clone = l.clone(`${nameHint}-light-${l.name}`)
    if (!clone) continue
    sourceScene.removeLight(clone)
    ;(clone as unknown as { _scene: Scene })._scene = targetScene
    targetScene.addLight(clone)
    lightClones.push(clone)
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

  // ----- sounds (MSFT_audio_emitter) -----
  // instantiateModelsToScene does not clone sounds, and a Sound is not a
  // Node — it follows its `_connectedTransformNode` for positioning. Without
  // re-attaching, the hand-off would leave the viewer silent (commit()
  // disposes the stage scene's sounds). Pairing is by name: the clone tree
  // mirrors the source tree in order, and clone names are
  // `${nameHint}-<source name>`, so a per-name FIFO lines up i-th with i-th.
  const srcByName = new Map<string, Node[]>()
  const collectSrc = (n: Node): void => {
    const arr = srcByName.get(n.name)
    if (arr) arr.push(n)
    else srcByName.set(n.name, [n])
  }
  for (const r of source.rootNodes) {
    collectSrc(r)
    for (const c of r.getDescendants(false)) collectSrc(c)
  }
  const cloneOfSrc = new Map<Node, Node>()
  const pairClone = (c: Node): void => {
    const srcName = c.name.startsWith(nameHint + '-') ? c.name.slice(nameHint.length + 1) : c.name
    const arr = srcByName.get(srcName)
    const s = arr ? arr.shift() : undefined
    if (s) cloneOfSrc.set(s, c)
  }
  for (const root of entries.rootNodes) {
    pairClone(root)
    for (const child of root.getDescendants(false)) pairClone(child)
  }
  const transferred: Sound[] = []
  for (const s of [...sourceScene.mainSoundTrack.soundCollection]) {
    const node = (s as unknown as { _connectedTransformNode?: Node })._connectedTransformNode ?? null
    const clone = node ? cloneOfSrc.get(node) : undefined
    if (!clone) continue
    ;(s as unknown as { _connectedTransformNode?: Node })._connectedTransformNode = clone
    ;(s as unknown as { _scene?: Scene })._scene = targetScene
    sourceScene.mainSoundTrack.removeSound(s)
    targetScene.mainSoundTrack.addSound(s)
    transferred.push(s)
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
  for (const cam of cameraClones) {
    if (c.cameras.indexOf(cam) === -1) c.cameras.push(cam)
  }
  for (const l of lightClones) {
    if (c.lights.indexOf(l) === -1) c.lights.push(l)
  }
  for (const sk of entries.skeletons) {
    if (c.skeletons.indexOf(sk) === -1) c.skeletons.push(sk)
  }
  for (const ag of entries.animationGroups) {
    if (c.animationGroups.indexOf(ag) === -1) c.animationGroups.push(ag)
  }
  return { container: c, sounds: transferred }
}

function moveMesh(m: Mesh, from: Scene, to: Scene, seen: Set<object>): void {
  if (seen.has(m)) return
  seen.add(m)
  from.removeMesh(m)
  ;(m as unknown as { _scene: Scene })._scene = to
  to.addMesh(m)
}

function moveTransformNode(n: TransformNode, from: Scene, to: Scene, seen: Set<object>): void {
  if (seen.has(n)) return
  seen.add(n)
  from.removeTransformNode(n)
  ;(n as unknown as { _scene: Scene })._scene = to
  to.addTransformNode(n)
}
