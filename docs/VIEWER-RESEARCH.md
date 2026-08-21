# VIEWER RESEARCH — what is good, missing, wrong, and bad in the viewer
(2026-08-21, agent arena)

Research task: compare FORM/0's single-model viewer against Sketchfab's
3D/VR viewer, Babylon's official viewers (playground samples + the new
`@babylonjs/viewer` v2), Google `model-viewer`, and general 3D-web-viewer
conventions. Code reading + live verification (offline rig, headless
SwiftShader, `scripts/viewer-research.mjs`) + published feature sources.

Sources used for the comparison set:
- Sketchfab: `sketchfab.com/features` (viewer spec sheet),
  `sketchfab.com/developers/viewer/functions` (Viewer API), the interaction
  hints printed by Sketchfab embeds (orbit/pan/zoom/lighting gestures).
- Babylon: `babylonjs.medium.com` "Babylon Viewer (v2)" announcement
  (feature checklist + design principles), playground sample catalogue
  (orbit/free/universal cameras, auto-rotation, gizmos, animation player,
  screenshots, post-processing).
- Google `model-viewer` docs (camera-controls, auto-rotate, AR button,
  skybox/environment, shadow-intensity, camera-orbit clamping).

## 1. Scope — what the viewer is today

`src/viewer/viewer.ts` + `src/viewer/animator.ts` + the `#viewer-bar` HUD in
`index.html`, wired in `src/main.ts`:

- One model at a time (GLB, hash-verified, preflight-validated).
- Two camera families: an auto-fit **orbit** camera (A dot) and the model's
  **authored cameras** (numbered dots, C to cycle).
- Animation rail (only when tracks exist): track dropdown, scrubbable
  timeline, frame readout, forward/reverse, stepped playback, numeric speed,
  `,`/`.` frame stepping, A = play/pause.
- Close (Esc), prev/next (←/→), metadata drawer (M), download GLB, thread
  (T), reply, delete (own posts).
- Rendering: settings-driven (see `src/render/graphics.ts`) — MSAA/FXAA/TAA,
  SSAO/SSAO2, SSR, bloom, DoF, chromatic aberration, grain, motion blur,
  curvature view, model outline (HighlightLayer), shadows (off/contact/
  dynamic/cascaded), fog, tone mapping, unlit, anisotropy — plus a
  demand-driven engine (zero frames when idle), adaptive resolution,
  spotlight backdrop, contact shadow.

## 2. What is GOOD (several things are genuinely ahead of the references)

1. **Zero-cost idle.** `FormEngine` renders only on demand; a static model in
   the viewer draws **zero frames** (measured: idle board/viewer ≈ 0 renders/s
   in `scripts/perf.mjs`). Sketchfab's player and every Babylon playground
   sample spin a continuous RAF loop forever. On mobile this is battery and
   heat the competitors simply don't offer.
2. **Live-preview hand-off.** If the model is already animating on a board
   card, `handoffContainer` clones the parsed container into the viewer scene
   — the viewer opens **instantly with zero re-parse** (SPEC 04 §5 /
   AMENDMENT 51). Neither Sketchfab (standalone player) nor Babylon Viewer
   has this cross-view continuity; it's the single most distinctive strength.
3. **The animation rail beats the stock players.** Sketchfab's built-in
   player is play/pause/speed/loop only (everything else needs the Viewer
   API). Babylon playground needs a separate GUI animation player. FORM/0
   ships multi-track selection, scrubbing, stepped (whole-frame hold)
   playback, reverse, and arbitrary speed (0 = freeze, negative = backwards)
   out of the box, driven by a correct manual `TrackAnimator`.
4. **Honest loading UX.** Spinning ring + **real byte rate** + determinate
   progress bar (we know the size from the event), retry that actually
   retries (AMENDMENT 72), and an error sheet with code + cause + action.
   A spinner alone cannot tell "downloading 40 MiB at 300 KiB/s" from
   "hung" — the viewer does.
5. **Untrusted-content safety.** Every GLB is SHA-256-verified and preflight
   validated (size/node/texture budgets, `src/model/limits.ts`) *before*
   Babylon touches it; KHR_interactivity's script engine is stripped; zero
   CDN. As a client for third-party network content this is the right
   architecture; Sketchfab gets away without it only because it hosts.
6. **Settings are real engine features, honestly scoped.** Every graphics
   control reaches actual engine state (verified by `scripts/settings.mjs`),
   and what WebGL *cannot* do (DLSS/FSR, frame gen, HW RT, HDR swapchain) is
   listed disabled with the reason and the real equivalent — "honest about
   the platform". That is more than a Sketchfab embed (fixed rendering) and
   on par with a hand-built Babylon scene.
7. **One engine, no context churn.** Scenes swap on one canvas/context
   (`setActiveScene`), shader programs are kept persistent
   (`Effect.PersistentMode`), so re-opening a model compiles **0** programs
   (measured, `scripts/shaders.mjs`). Navigating never loses a context.
8. **Race-free loads.** Load tokens + navigation tickets mean fast prev/next
   can never stack two models or leak containers
   (`scripts/interact.mjs` hammers it). This bug class is common in
   viewer-style code; it is engineered out and guarded.
9. **Authoring-camera policy that is measured, not guessed.** Poster and
   viewer use the author's camera when present, else auto-fit via
   `worldBox` + area-weighted `dominantFacing` + `fitDistance` — with a
   probe suite (`scripts/orient.mjs`, `scripts/facing.mjs`) that fails on
   mirror regressions. model-viewer and Babylon Viewer normalize/fit but do
   not honour authored framing this rigorously, and none has the
   orientation-guard test harness.
10. **Keyboard-first + first-run legend + a11y labels.** Full hotkeys
    (←/→ C A M T `,` `.`), a re-openable legend, 42px touch targets,
    aria-labels on every control.
11. **Offline / standalone.** The whole app (viewer included) builds to one
    `file://` HTML with IndexedDB model cache — Sketchfab and Babylon Viewer
    are network-only.
12. **Bounded memory.** Model blobs are LRU (6/48 MiB) on top of the
    IndexedDB cache; adaptive resolution steps down on slow frames and back
    up on fast ones; a pixel budget caps the drawing buffer.

## 3. What is MISSING (feature gaps vs the references)

Tiered by how central the feature is to "being a model viewer".

### 3.1 Interaction gaps

| Feature | Sketchfab | Babylon (viewer v2 / playground) | model-viewer | FORM/0 |
|---|---|---|---|---|
| Orbit / pan / zoom | ✅ | ✅ | ✅ | ✅ **only on orbit camera** (see §4.1) |
| **Authored camera still navigable** | ✅ (cameras are waypoints, orbit persists) | ✅ (POIs, pose change keeps controls) | n/a | ❌ **frozen static frame** |
| Camera pose **interpolation** on switch | ✅ (2 s default `setCameraLookAt`) | ✅ (explicit design principle) | ✅ | ❌ instant snap |
| **Reset / re-frame view** | ✅ (double-click background = zoom out; home) | ✅ | n/a | ❌ only by re-clicking the A dot, and only if authored cams exist |
| **Zoom-to-point** (double-click object) | ✅ | playground trackball/map samples | n/a | ❌ |
| First-person / fly mode (WASD) | ✅ | ✅ (FreeCamera/Universal samples) | ❌ | ❌ |
| Auto-rotate / turntable | ✅ | ✅ (`useAutoRotationBehavior`) | ✅ | ❌ (one-liner available, unused) |
| **VR (WebXR)** | ✅ (WebXR + Cardboard) | ✅ (WebXR + QuickLook) | ✅ (VR button) | ❌ **planned, not built (AMENDMENT 41)** |
| **AR** | ✅ (app-free AR, QR on desktop) | ✅ (QuickLook) | ✅ (AR button) | ❌ |
| Fullscreen (viewer HUD) | ✅ | playground sample | n/a | ⚠️ settings only (Display → mode) |
| **Screenshot capture** | ✅ (`getScreenShot`) | playground sample (`screenshotTools`) | ❌ | ❌ (not imported, no UI) |
| **Share / copy link / embed** | ✅ | n/a | n/a | ⚠️ URL exists (`#/viewer/<id>`), no copy/share affordance |
| Lighting rotation (3-finger / Alt-drag) | ✅ | env-rotation samples | n/a | ❌ fixed rig |
| Pick / hover / click-to-inspect | ✅ (annotations) | ✅ (gizmos/picking samples) | ✅ (hotspots) | ❌ no picking at all |
| Measurement tool | ✅ (labs) | ❌ | ❌ | ❌ |
| Interaction hints | ✅ | ✅ (explicit design principle) | ✅ (gesture hint) | ⚠️ first-run legend only — and its viewer line is wrong in the default state (see §4.1) |

### 3.2 Presentation / rendering gaps

- **No environment lighting / IBL / skybox.** Sketchfab offers HDRi
  backgrounds, model-viewer offers `skybox-image` + lighting environments,
  Babylon Viewer v2 sets "skybox + environment lighting when possible".
  FORM/0 is lights-only by design (AMENDMENT 8: IBL blacked PBR on a driver
  bug). Consequence: **metallic PBR models look flat/dark** next to every
  competitor's presentation. This is the biggest *visual-quality* gap.
- **No inspection modes:** wireframe, matcaps, texture/UV/topology view
  (all Sketchfab), none here. (Settings expose curvature + outline, but no
  viewer-level wireframe toggle.)
- **No material-variant or morph-target UI** — the loader can carry both;
  Babylon Viewer v2 lists variant switching, model-viewer has variants +
  morphs.
- **No camera fly-through playback** — authored cameras are static dots; a
  glTF camera animation is not surfaced as a playable track (it would just
  move the inactive imported camera while the orbit is active).
- **Loop control** — Sketchfab has cycle (loop) control; `TrackAnimator`
  always wraps. No "play once".
- **No 360°/panorama fallback** for non-WebGL browsers (Sketchfab degrades
  to a 360° video fallback; FORM/0 shows a fatal box).
- **Parse progress** — download progress is great, but the GLB *parse*
  phase is an opaque spinner (Babylon Viewer shows overall load progress).

### 3.3 Content/social gaps

- **No title or author on screen.** Sketchfab's info bar shows title,
  author, stats, description. FORM/0 is wordless by brand, but the only
  identity surface is a hidden drawer of raw text (see §4.8).
- **No annotations/hotspots** — the protocol carries none (a protocol
  decision, but it caps what the viewer can do with author intent).
- **No "position in feed"** (e.g. 3 of 11) next to prev/next; wrap-around
  navigation + no title makes it easy to lose where you are.

### 3.4 Platform gaps

- **WebGPU** — Babylon Viewer v2 supports WebGPUEngine; FORM/0 is WebGL2
  only (Babylon 8 has it in-tree; a later, not urgent, upgrade).
- **Audio in the viewer** — see §4.4 (spec'd, missing, and the hand-off
  path drops sounds entirely).
- **Reduced motion** — the setting only kills CSS transitions; it does not
  stop the viewer's autoplay (or, as the spec's "reduced motion: 0 slots"
  line intends, the board's preview slots — nothing reads the flag today).

## 4. What is WRONG (bugs; live-verified unless noted)

### 4.1 The default view is a frozen frame — and the legend lies about it
`Viewer.adopt()` policy is *preview-camera → first imported camera → orbit*,
so **any model with an authored camera opens on it** — and
`applyCamera()` detaches the orbit and attaches **no control** to the
imported `FreeCamera`. Live check (rig model `a`, headless): after opening,
`activeCamera = FreeCamera "cam-red"`, `orbitAttached = false`; a 400-notch
wheel zoom + a 200px drag moved the camera **0.000** units. The user sees a
static frame with no orbit, no zoom, no pan — until they discover the small
"A" dot or the C key. Meanwhile the legend's viewer line reads *"orbit with
the pointer"* — false in the default state. Sketchfab keeps orbit available
around any authored camera; Babylon Viewer v2 keeps controls across camera
pose changes. **This is the single biggest interaction defect.**

### 4.2 Near-plane slice: the UI allows zooming closer than the near plane
`fitOrbit()` sets `orbit.minZ = max(near, min(near·100, (dist−radius)·0.2))`
— a value derived from the **whole model's** framing — while
`lowerRadiusLimit = max(0.05, radius·0.1)` can be **smaller than minZ**.
Live measurement on rig model `a` (red unit cube at origin + big green cube
14 units away): `minZ = 1.0`, `lowerRadiusLimit = 0.872`. So once you pan
the target onto the small red cube and wheel-zoom to the bottom, the camera
is closer to it than the near plane: the cube is sliced/bitten (or gone)
exactly when you're trying to inspect it. Sketchfab-style viewers use an
adaptive near plane. Fix: clamp `lowerRadiusLimit ≥ minZ + partRadius` or
re-derive minZ from the current target distance.

### 4.3 Speed 0 is unreachable from the HUD
`main.ts`: `viewer.animator.setSpeed(parseFloat(animSpeed.value) || 1)` —
typing `0` yields `1`. Live check: field shows `0`, `animator.speed` stays
`1`. The animator's documented "0 freezes the pose" is therefore dead in
the UI (and clearing the field also snaps to 1).

### 4.4 Model audio never plays in the viewer (and the hand-off path drops it)
`MSFT_audio_emitter` sounds are claimed/played in the **board** 3D cards and
the preview pool (`modelCard3d.ts`, `previewPool.ts`) — `viewer.ts` never
references sounds. Consequences:
- byte-load path: sounds are created inside the scene but nothing calls
  `play()` — the model is silent in the viewer;
- hand-off path: `handoffContainer` clones meshes/materials/skeletons/
  animationGroups/cameras/lights — **not sounds** — so a model that was
  *audible on its card goes silent* the moment you open the viewer.
- the spec's A11Y line allocates the viewer "…/M/R/T/S sound" keys; `S` (and
  `R`) are not implemented, and there is no HUD audio control.

### 4.5 Viewer autoplay ignores the `autoplayAnimations` setting
`adopt()` hard-codes `animator.setGroups(groups, idx, true)`. The setting's
own copy says "Off = everything opens paused" — true for cards and thread
nodes (`board.setAutoplay`), false for the viewer, which always autoplays
(the preview animation or track 0).

### 4.6 `loadFromContainer` documents a fallback that does not exist
Its comment says it "Falls back to the byte-loading path silently if
anything looks off: a stale loadToken, a disposed container, or a stage that
is no longer the active scene". The code instead **returns silently**
(`container.scene !== this.scene` → bump token, return, no throw).
`main.ts` only falls back on *exception*, so that branch would commit the
preview slot and leave a **blank viewer with no loading ring**. Unreachable
today (the hand-off always returns a container bound to `viewer.scene`), but
it is a latent blank-screen path and the comment is wrong.

### 4.7 No camera transition between views
Switching dots (orbit ↔ authored ↔ authored) is an instant teleport of the
camera. Babylon Viewer v2's first design principle is "always interpolating
changes to the camera pose so a user is not disoriented"; Sketchfab animates
`setCameraLookAt` (2 s default). On a large model the snap is jarring.

### 4.8 The metadata drawer is raw text with no affordances
`<pre>` of nostr fields: no author identity (bare hex pubkey, no profile/
explorer link), no event links (blockcast/nostr.pub), no per-field copy
button (the only copy button copies a toast), and no rendering stats that
the app already knows (triangles, materials, textures, audio count, decoded
pixels — all available in `limits.ts` stats but not shown).

### 4.9 Small code-level issues
- `frameBackdrop()` reads `(cam as ArcRotateCamera).fov || 0.8` — an
  **orthographic** authored camera (glTF ortho is legal) has no `fov`, so
  the spotlight backdrop would be sized with the 0.8 fallback (wrong
  size). Edge case, but the cast is a type lie.
- No view reset for **camera-less** models at all: once you've orbited far
  away there is no re-frame (A dot exists only because authored cameras
  exist); you must leave and re-enter the model.
- `applyCamera`'s `FreeCamera` branch sets `maxZ = 100000` — with a small
  near (0.001) the depth precision on a tight close-up is worse than it
  needs to be (the authored camera's own zNear/zFar, or a bounded value,
  would be better).
- The prev/next buttons wrap around silently (modulo), with no "N of M"
  indicator (see §3.3).
- `scripts/AGENTS.md` rule 8 still says `screenshotTools` is imported for
  screenshots — it is not imported anywhere in `src/` (stale rule / missing
  feature).

## 5. What is BAD / questionable (design critique, not bugs)

1. **Lights-only rendering as a permanent ceiling.** The IBL disable
   (AMENDMENT 8) was the right call for that driver bug, but it has become
   the presentation ceiling: metals and clear-coats look matte and dim
   compared to Sketchfab's HDRi rooms or model-viewer's environments. At
   minimum the settings panel should offer an *environment* option (a
   generated/neutral PMREM is cheap and would not re-trigger the old bug if
   it's applied as `reflectionTexture` per material rather than
   `scene.environmentTexture`).
2. **Zero on-screen identity.** Wordless is the brand, but a viewer that
   never says what the model is or who made it feels anonymous and makes
   search/credit impossible without hunting in the drawer. One line (name +
   short author) would cost the brand nothing.
3. **No camera transition + frozen authored camera** (§4.1/§4.7) combine to
   make camera-carrying models feel like slideshows of stills with a
   hidden orbit button.
4. **The A dot is the only "reset" and only half exists** (§4.9).
5. **8px uppercase micro-labels** under the viewer buttons are at the edge
   of legibility (and hidden on narrow screens, where the rail just scrolls
   — no scroll affordance is visible).
6. **Instant board→viewer scene swap** with no crossfade, while cards
   crossfade 120ms elsewhere — the transition language is inconsistent.
7. **No download cancel** — a 20 MiB model on a slow link commits you to
   the ring (the publish side has cancel; the fetch side does not).
8. **`preserveDrawingBuffer: false`** is correct for perf, but any future
   screenshot feature must render-then-read in the same frame — worth
   noting before someone "just calls toDataURL" and ships a blank PNG.
9. **No idle turntable** — `useAutoRotationBehavior` is a one-liner that
   would let the viewer show a model off like every product viewer does;
   its absence is an unforced choice.

## 6. Prioritized recommendations

**P0 — interaction correctness**
1. Make the authored camera navigable: attach the orbit camera seeded from
   the authored pose (position + direction + fov), or attach controls that
   orbit around the authored target; keep the dot as "snap back to authored
   framing". Update the legend line to match.
2. Interpolate camera switches (α/β/radius/position tween, ~0.4 s, skippable
   by input).
3. Fix the near plane: `lowerRadiusLimit = max(0.05, radius·0.1, minZ + 0.1·
   partRadius)` (or recompute minZ per target distance) so close-ups never
   slice.
4. Add a reset/re-frame control (F key + dot) that works for camera-less
   models; "N of M" next to prev/next.
5. `setSpeed(parseFloat(v) || 1)` → handle 0 and empty explicitly.

**P1 — parity with the reference viewers**
6. Screenshot button (render frame → PBO readback, same async pattern as
   posters; `screenshotTools` or manual readPixels in the same RAF).
7. Auto-rotate/turntable toggle (orbit behaviour + animation source, so
   render-on-demand keeps working; respect reduced motion).
8. Viewer model audio: claim sounds in `adopt()` (and clone them in
   `handoffContainer`), start on the same user gesture that opened the
   viewer, add the spec'd `S` mute/unmute + a HUD sound dot.
9. Title + author line (from `meta.name` / `meta.pubkey` — even a shortened
   pubkey with an explorer link).
10. Share/copy-link button (URL already carries the model).
11. Respect `autoplayAnimations` (and reduced motion) in viewer autoplay.
12. Fix `loadFromContainer`'s silent-return (throw, or actually fall back).

**P2 — presentation**
13. Environment-lighting option (neutral/studio/dark PMREM presets via
    per-material `reflectionTexture`), fixing the black-PBR driver issue
    properly; optional skybox.
14. Inspection toggles: wireframe, matcap/flat, (later) measurement.
15. Loop control (loop / play-once) on the animation rail.
16. Drawer upgrades: links, per-field copy, triangles/materials/textures/
    audio stats.
17. Camera fly-through: surface glTF camera animations as tracks; when the
    active camera is an authored one, allow playback of camera-animation
    groups on it.

**P3 — XR (the planned big ticket)**
18. VR (AMENDMENT 41): `WebXRExperienceHelper` on the existing engine/canvas,
    enter-VR action hidden when unsupported, error sheet on failed entry.
19. AR: `immersive-ar` session (or Quick Look on iOS) at 1:1 scale.
20. First-person / fly mode (WASD + look), as Sketchfab offers.

## 7. Evidence appendix

- Live probe: `scripts/viewer-research.mjs` (offline rig + headless
  SwiftShader; prints camera states, wheel/drag response, speed-0 attempt,
  HUD button census). Screenshots: `/tmp/vr-1-viewer-orbit.png` (authored
  cam, frozen), `/tmp/vr-3-viewer-zoomed-in.png` (near-plane void at forced
  radius), `/tmp/vr-deep.png` (camera parent/pose dump).
- Measurements: authored `FreeCamera` parented to `cam0` at
  `[-1.5, 0.5, 2.5]`, `orbitAttached=false`, camera unmoved after wheel +
  drag; orbit `minZ=1.0` vs `lowerRadiusLimit=0.872`; speed field `0` →
  `animator.speed=1`; no `btn-fullscreen/share/screenshot/ar/rotate/fit/
  sound` elements in the viewer bar; `sounds=0` in the viewer scene for an
  audio-bearing container type.
- Code: `src/viewer/viewer.ts` (`applyCamera`, `fitOrbit`, `adopt`,
  `frameBackdrop`, `loadFromContainer`), `src/main.ts` (viewer wiring,
  keymap, `openViewer` hand-off, speed handler), `src/core/sceneTransfer.ts`
  (hand-off clone set), `src/board/modelSounds.ts` (audio owners: board/pool
  only), `src/settings/apply.ts` (reduceMotion → CSS class only).
