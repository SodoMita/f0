# RESEARCH — how simple 3D viewers & editors are done

Online research notes for the **Studio editor** and **viewer** work ahead. Each
section: the technique, the canonical reference, and how it maps to FORM/0.
Sources at the bottom.

---

## 1. Viewers — fit-to-bounds and orbit

### 1.1 Fit-to-bounds (the correct math)

The robust, widely-copied formula (three.js STL-viewer style) computes camera
distance from **per-axis bounding-box extents**, not a bounding sphere:

```
fovV  = camera.fov (vertical, radians)
fovH  = 2 * atan( tan(fovV/2) * aspect )   // horizontal fov
distX = size.z/2 + | size.x/2 / tan(fovH/2) |
distY = size.z/2 + | size.y/2 / tan(fovV/2) |
distance = max(distX, distY)
```

Then set far plane ~3× and orbit maxDistance ~2× the needed distance.

**Why it matters for us:** our current `fitDistance(radius, fov)` uses the
bounding-*sphere* radius, which over-zooms flat/wide models (text, signs, the
"SSD" text plate). Switch `model/facing.ts` to the per-axis box formula —
`worldBounds` already returns the union AABB, so this is a small change.

### 1.2 Orbit camera styles

- **Basic orbit** = spherical coords (phi/theta); drag adds delta to each.
- **Turntable (Blender-like)** = same but no phi clamp; crossing the pole
  inverts the camera + phi and rotates theta by π, so you can spin continuously
  without gimbal lock. (<model-viewer> and OpenSCAD use this.)
- **model-viewer** (Google, `<model-viewer>` web component) is the gold
  reference for product viewers: `camera-target`, `camera-orbit`, min/max
  orbit + fov, click-to-focus-on-surface (orbit around the clicked point, not
  a fixed center), and interpolated camera transitions between orbits.

**Map to FORM/0:** viewer already auto-fits; adopt the per-axis fit + add
"focus on clicked point" (tap the model → orbit target moves to that surface
point) and clamped orbit/fov limits. Keep authored-camera support (spec).

---

## 2. Transform gizmos — use Babylon's built-ins, don't hand-roll

**Babylon.js ships a complete gizmo system** (`GizmoManager` +
`PositionGizmo`/`RotationGizmo`/`ScaleGizmo`/`BoundingBoxGizmo`):

```ts
const gm = new GizmoManager(scene)
gm.usePointerToAttachGizmos = false     // manual attach
gm.attachToMesh(mesh)
gm.positionGizmoEnabled = true
gm.gizmos.positionGizmo.updateGizmoRotationToMatchAttachedMesh = true // local vs world
// snapping: distance/angle with a callback
gm.boundingBoxGizmoEnabled = true       // translate+rotate+scale in one widget
```

Key facts (from the Babylon gizmo docs/issue tracker):
- Gizmos render on their **own layer**, isolated from `scene.meshes` — they
  don't pollute the scene graph.
- Supports plane dragging (XY/YZ/XZ), view-axis dragging, uniform scale,
  snapping (distance + angle), local/world mode, hotkeys, pointer + 6-DOF.
- `BoundingBoxGizmo` gives draggable face/edge/corner handles = the spec's
  "AABB handles" (05 §7) for free.

**three.js `TransformControls`** is the same pattern hand-written: a `gizmo`
object + a `helper` object per mode (translate/rotate/scale), toggled by mode;
rotation applied as `quaternion = axisAngle(rotationAxis, angle) * quaternionStart`.

**Map to FORM/0:** use `GizmoManager` + `BoundingBoxGizmo` in the Studio
instead of writing custom gizmos. Only customize appearance (accent colors,
sizing). This covers spec 05 §7 (translate/rotate/scale, axis constraints,
AABB handles, snapping) with ~1 file instead of 5.

---

## 3. Brush painting in 3D (Paint 3D-style)

> **Terminology:** this is a **paint editor**, not a voxel editor. The metaphor
> (spec 05 Part B) is a *raster brush whose canvas is 3D space* — free strokes
> of shapes (cube/sphere/cylinder/tetra/quad) that freely overlap and
> interpenetrate, with a fine placement grid only for snapping. There is no
> filled-cell grid, no cell identity, no "voxel" data model. (Think Microsoft
> Paint 3D / its 3D doodle + shapes, not MagicaVoxel/Minecraft.)

The paint-editor pattern (Minecraft-like placer + spec 05 Part B):

1. **Raycast** from pointer into the scene → hit point + hit normal.
2. **Place** the new cube at `hitPoint + normal * halfCube`, then **snap** to
   the grid: `floor(pos / cell) * cell`.
3. **Brush strokes** = emit a stamp every *N* grid cells of travel, and
   **interpolate** between pointer events so fast drags leave no gaps (spec
   05 §2.1). This is identical to a 2D raster brush's stamp spacing.
4. **Eraser / grid hit tests** use the **Amanatides–Woo grid DDA** algorithm
   (ray traversal through grid cells, a.k.a. voxel-space raycast — the
   *technique* is grid traversal; it does not make the product a voxel editor):
   step a ray through grid cells by tMaxX/tMaxY/tMaxZ increments — O(cells
   crossed), no per-cube raycast. Ideal for our spatial-hash hit tests
   (spec 05 §8).
5. Tools like Avoyd show the standard constraint set: snap-to-grid with
   spacing + offset, which matches our "cell ≠ cube size, snap to fine grid"
   rule.

**Map to FORM/0:** the spec's brush editor is already well-specified; the
missing implementation pieces are (a) Amanatides–Woo for brush/eraser/line
hit tests, and (b) pointer-path interpolation for stroke stamps.

---

## 4. Picking & selection

Two families:

**CPU raycasting** — `scene.pick(x, y, predicate)` / `multiPickWithRay`, with
`fastCheck`, a mesh predicate (skip non-selectable), and a triangle predicate
(front/back face test). Good for sparse scenes, single clicks, x-ray mode.

**GPU picking (ID buffer)** — render each mesh with a unique solid color into
an offscreen target, read the pixel under the cursor, decode RGB → id.
Rules that matter: **nearest filtering, no mipmaps** (else colors blend),
24-bit RGB = 16.7M ids. This is exactly what **Blender** does for *solid*
(occlusion-aware) selection, and it falls back to CPU raycasting for *x-ray* —
which is verbatim spec 05 §6.1 (Solid = depth/ID prepass, X-ray = all in
region). Reddit/three.js consensus: GPU picking is only worth it when you need
occlusion awareness or have many objects; CPU raycast is more flexible.

**Babylon already ships `GPUPicker`** (`pickAsync`, `multiPickAsync`,
`setPickingList`) — no need to hand-roll the ID pass. `multiPickAsync` even
returns per-coordinate mesh + `thinInstanceIndex`.

**Map to FORM/0:** single click → `scene.pick` with a predicate; box/lasso →
`GPUPicker.multiPickAsync` over the selection rectangle for solid mode, spatial
hash + CPU tests for x-ray (per spec). This is a config choice, not a rewrite.

---

## 5. Rendering thousands of instances (the paint-program data path)

- **Thin instances** (`mesh.thinInstanceAdd(matrix)`, or
  `thinInstanceSetBuffer` + `thinInstanceCount`): instances packed as
  matrices in one buffer, **one draw call**. Babylon demo: **343,000 cube thin
  instances @ 70 fps**. All-or-nothing draw, and add/remove is costly → batch
  rebuilds.
- **Instances** (`mesh.createInstance()`): separate objects (own transforms,
  pickable), still one draw call; better for frequent add/remove.
- **Deletion trick** for thin instances: copy the last matrix over the deleted
  slot and decrement the count — this is the same **swap-with-last + shrink**
  the spec mandates (05 §8). Identical trick works on our packed array.
- **One draw call per (shape, material) pair** is the standard; different
  shapes → different base meshes.

**Map to FORM/0:** the spec's "flat typed store + thin instances + swap-last
delete + spatial hash" is the right architecture and matches community
practice exactly. Implementation order: (1) packed `Float32Array` transforms +
material ids, (2) `thinInstanceSetBuffer` per shape, (3) coalesce edits to one
buffer rebuild per frame.

---

## 6. Undo/redo — Command + Memento

The universal editor pattern:
- **Command** = an operation + its **inverse** (or a pre-state snapshot).
- **Memento** = an immutable snapshot of editor state taken *before* the
  command runs; undo restores it.
- History = a bounded stack (pointer for redo); executing a new command after
  undo clears the redo tail.
- For a **packed instance store**, a memento is just a copy of the typed array
  (cheap, but memory-bound → cap history, e.g. the spec's ≥100 steps, and
  prefer inverse-commands for large paint strokes so you don't snapshot the
  whole buffer per stamp).

**Map to FORM/0:** implement `history.ts` as a command stack over the packed
store: paint/erase = inverse (add/remove instances), transform = pre/post
matrices, color = old/new values. Cap the stack and clear redo-on-new-edit.

---

## 7. Summary of concrete recommendations for the next agent

1. **Fix fit-to-bounds** to per-axis box extents (section 1.1) — small change
   in `model/facing.ts`, big visual win for flat models.
2. **Studio gizmos**: use Babylon `GizmoManager` + `BoundingBoxGizmo`
   (section 2). Do NOT write custom gizmos.
3. **Brush hit tests**: implement Amanatides–Woo DDA over the spatial hash
   (section 3) for brush/eraser/line.
4. **Selection**: `scene.pick` for clicks; `GPUPicker.multiPickAsync` for
   solid-mode box/lasso; CPU spatial-hash for x-ray (section 4).
5. **Instance store**: packed Float32Array + `thinInstanceSetBuffer`, one draw
   call per (shape, material), swap-last delete (section 5).
6. **Undo**: command+inverse over the packed store, bounded stack (section 6).
7. **Hand-writing ink input** (section 8) is the paint editor's primary use
   case — pressure, coalesced events, smoothing come first.
8. **Phone-pose camera + audio recording** (section 9) for the recording
   feature — DeviceOrientation rotation is the safe base, WebXR for position.

---

## 8. Hand-writing / freehand ink input (the paint editor's primary job)

The editor's #1 use case is **writing text by hand** — freehand strokes that
form letterforms, Paint 3D ink style (spec AMENDMENT 10). The input pipeline
that makes strokes feel like a pen:

1. **`PointerEvent.pressure`** (0..1) → stamp size and/or alpha. Pen/touch
   report real pressure; mouse reports 0.5 or a button-press constant — so
   always provide a fallback size.
2. **`touch-action: none`** on the canvas + `setPointerCapture` on pointerdown,
   or the browser treats the pen as a clicker and you get `pointercancel`
   mid-stroke (a classic bug).
3. **`getCoalescedEvents()`** — browsers coalesce pointermove to the frame
   rate; this returns the raw sub-frame points, which is what makes fast
   handwriting smooth instead of polygonal. (Optional `getPredictedEvents()`
   for low-latency ink.)
4. **Also available:** `tiltX/tiltY` (pen angle → calligraphic stroke shape),
   `tangentialPressure`, `twist`, `width/height` (contact geometry).
5. **Path smoothing:** resample the polyline (moving average or Catmull-Rom /
   quadratic Bézier) before stamping — stamp spacing along the smoothed path
   (spec 05 §2.1), never stamp raw event positions.
6. **Taper:** stroke width can scale with speed (fast = thinner) and/or
   pressure; this is what separates "ink" from "a chain of discs".
7. **Eraser** = the same stroke machinery with remove-instead-of-add.

This is the same machinery as spec 05 §2 (spacing/interpolation/pressure/
jitter); the new part is making it *feel* like writing: coalesced events +
smoothing + pressure-driven width, then optionally **extrude** the flattened
stroke into 3D (which is how the existing "form-zero-extruded-text" posts are
made — hand-drawn letters extruded to depth).

## 9. Phone-pose camera + audio recording

Feature (spec AMENDMENT 12): while recording audio, drive the camera animation
from the phone's sensors, so the user "walks the camera" as they talk. Device
API facts that constrain the design:

- **DeviceOrientation** (`deviceorientation` / `deviceorientationabsolute`):
  `alpha` (yaw/heading), `beta` (front-back tilt), `gamma` (left-right tilt).
  This is *rotation only*, but it's exactly what a camera orbit needs, and it
  works broadly. Requirements: **secure context (HTTPS)**, and on **iOS 13+
  `DeviceOrientationEvent.requestPermission()` must be called from a user
  gesture** (a tap on "start recording") or the events never fire.
- **DeviceMotion** (`devicemotion`): `accelerationIncludingGravity`,
  `rotationRate` (deg/s), `interval`. **Double-integrating acceleration for
  position drifts unboundedly — never use it for camera translation.**
  `rotationRate` is fine for smoothing the orientation feed.
- **WebXR** (`navigator.xr`, ARCore/ARKit-backed) is the only reliable source
  of **6-DOF position**. Requires HTTPS, a supported device, and a user
  gesture; treat as an optional enhancement. Rotation-only is the fallback.
- **Audio recording:** `navigator.mediaDevices.getUserMedia({ audio: true })`
  (secure context + mic permission) → `MediaRecorder` → `dataavailable`
  chunks → one Blob. Note the container/codec varies (Chrome `audio/webm;opus`,
  Safari `audio/mp4;aac`) — normalize to the GLB's embedded format
  (KHR_audio uses MP3, MSFT_audio_emitter uses WAV, per spec).
- **Sync:** sample the pose at a fixed rate with timestamps on the same clock
  as the recording (`AudioContext.currentTime` or performance.now offset), so
  the camera track and audio start/stop together. Export the sampled pose as a
  real glTF camera animation (quaternion keys + sign-flip guard, spec 05b
  §2.4); embed the audio; the result plays in feed preview slots like any
  other authored camera animation.

---

## Sources

- Fit-to-bounds formula (three.js): https://wejn.org/2020/12/cracking-the-threejs-object-fitting-nut/
- Turntable orbit / model viewer improvements: https://mitxela.com/projects/model-viewer
- `<model-viewer>` staging & camera control: https://modelviewer.dev/examples/stagingandcameras/
- Babylon gizmos (docs + history): https://www.html5gamedevs.com/topic/37860-sample-code-for-features-in-babyloneditor/ ; Babylon.js issue #4141 https://github.com/BabylonJS/Babylon.js/issues/4141 ; bounding-box gizmo vs three.js https://github.com/mrdoob/three.js/issues/25619
- BabylonJS-EditControl (3rd-party gizmo): https://github.com/ssatguru/BabylonJS-EditControl
- three.js TransformControls internals: https://github.com/mrdoob/three.js/issues/18503 ; drei PivotControls API: http://drei.docs.pmnd.rs/gizmos/pivot-controls
- Amanatides–Woo grid DDA / voxel-space raycast: https://github.com/fenomas/fast-voxel-raycast ; Unity voxel-space raycast: https://gist.github.com/dogfuntom/cc881c8fc86ad43d55d8
- Brush stamp placement (raycast + hit normal + snap-to-grid): https://devforum.roblox.com/t/help-with-voxel-grid-based-building-system/2156325 ; Avoyd editor docs (referenced for snap/offset constraint UX, not naming): https://www.avoyd.com/avoyd-voxel-editor-documentation.html
- GPU picking (ID buffer, nearest filter, Blender solid/x-ray): https://riptutorial.com/three-js/example/17089/object-picking---gpu ; https://www.reddit.com/r/threejs/comments/hbmm6q/understanding_gpu_picking_and_hybrid_picking/ ; https://medium.com/@emttechh/o-1-country-selection-on-a-3d-globe-with-gpu-picking-and-hemisphere-detection-de4eab198fa3
- Babylon GPU picking + scene.pick/multiPick: https://doc.babylonjs.com/features/featuresDeepDive/mesh/interactions/picking_collisions
- Babylon thin instances: https://doc.babylonjs.com/features/featuresDeepDive/mesh/copies/thinInstances ; thousands of entities: https://babylonjs.medium.com/creating-thousands-of-animated-entities-in-babylon-js-ce3c439bdacf ; thin-vs-regular + swap-last delete: https://forum.babylonjs.com/t/questions-of-thin-instances-v-s-regular-instances/59420
- Undo/redo Command + Memento: https://refactoring.guru/design-patterns/memento ; https://gist.github.com/vxhviet/7751379bf3357e5d5e3eb72949957d88
- Pointer events (pressure/tilt/coalesced/predicted, touch-action: none): https://www.w3.org/TR/pointerevents/ ; coalesced-events drawing example: https://stackoverflow.com/questions/57711515/javascript-eventlistener-pointermove-points-per-second ; pointercancel + touch-action fix: https://stackoverflow.com/questions/59010779/pointer-event-issue-pointercancel-with-pressure-input-pen
- Device orientation/motion (alpha/beta/gamma, requestPermission, HTTPS, gotchas): https://github.com/osteele/p5-orientation-and-motion-example ; MDN detecting device orientation: https://udn.realityripple.com/docs/Web/API/Detecting_device_orientation ; PWA demo: https://progressier.com/pwa-capabilities/device-orientation-event
- Audio recording (getUserMedia + MediaRecorder, chunks → Blob, MIME caveats): https://github.com/remarkablemark/remarkablemark.github.io/blob/master/_posts/2021/2021-01-02-record-microphone-audio-on-webpage.md ; Web Audio + MediaRecorder pipeline: https://blog.openreplay.com/record-audio-browser-web-audio-api/
