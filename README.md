# FORM/0

A wordless multiplayer game of 3D shapes — sculpt, share, explore. Browser-only
client, direct to Nostr relays + Blossom servers, one `<canvas>` drawn entirely
by Babylon.js. Player creations are animated GLB models with their own cameras
and optional embedded audio.

## Layout & interaction
- **Board**: responsive 1–3 column grid of 16:10 model cards. Cards are fully
  transparent — the models float on the backdrop over a soft contact shadow,
  separated by full-bleed hairlines. Wheel-down / drag-down scrolls toward
  later cards; PageUp/PageDown/Home/End; **scroll inertia** (configurable).
  Tap a card → viewer; the **reply badge (↩ N)** at the card's bottom-right is
  the reply button → thread.
- **Thread**: a 2D map of the reply tree — framed node cards + elbow connectors
  in a tidy top-down tree, accent-outlined root. Drag pans, **pinch zooms**,
  wheel zooms about the cursor, `0` re-fits, tapping a node opens it.
- **Viewer**: one interactive model; orbit camera (A) or the model's own
  cameras via dots / C; play/pause (A); metadata drawer (M); download; thread
  (T); prev/next.

## HUD is HTML
Settings, navigation, toolbars, metadata, toasts are plain HTML overlays.
Only the models, the board, the reply badges and the thread map are Babylon.
Settings: **background color** (viewer/thread/studio) + **scroll inertia**.

## Settings (2026-08-17, round 7)

A full graphics/audio settings system — `src/settings/schema.ts` is the single
source of truth that drives persistence, the panel, the presets and the
availability copy.

- **Display & resolution** — auto / scale factor (with power-of-two snapping) /
  exact pixel size with manual numeric entry, aspect-locked height, fullscreen,
  brightness, contrast, tone mapping (Standard/ACES) and a calibration pattern.
- **Framerate & sync** — uncapped or a numeric cap, adaptive resolution,
  "stop drawing when idle".
- **Anti-aliasing & upscaling** — MSAA 2/4/8, FXAA, temporal AA with a sample
  count, a spatial upscaler (render scale + contrast-adaptive sharpen) with
  Quality→Ultra-performance modes and a sharpness slider.
- **Textures & materials** — PBR on/off (unlit), specular, reflections,
  anisotropic filtering, mipmaps, card/preview resolution, and a load-time
  texture guard.
- **Lighting & shadows** — off / contact / dynamic self-shadowing with map
  resolution and softness, SSAO or SSAO2 with strength and samples,
  screen-space reflections, light-rig intensity.
- **Post-processing** — bloom (strength, kernel quality, threshold), vignette,
  film grain.
- **Camera** — FOV, near/far clip, inertia, invert Y.
- **Memory & cache** — model RAM budget, resident card textures, live preview
  slots, preload distance, keep-offscreen, clear caches.
- **Audio** — output device (`setSinkId`), input device, Master/Music/SFX/
  Voice/UI mixers, mono/stereo/HRTF/surround, play-when-unfocused.
- **Interface** — background, scroll inertia, reduce motion, performance overlay.
- **Presets** Low / Medium / High / Ultra, switching to Custom on any edit,
  plus search and per-row "why is this unavailable" copy.

**Honest about the platform.** DLSS, FSR, XeSS, frame generation, hardware ray
tracing, an HDR swapchain, a V-Sync toggle and VRAM reservation do not exist in
WebGL — each is listed, disabled, with the reason and the real equivalent right
next to it (render scale + sharpen, SSR, exposure/tone mapping, frame cap, our
own memory budgets). Runtime failures are reported the same way.

## Key fixes this round (2026-08-17, round 6 — duplicated work)

Profiled with `scripts/profile.mjs` (V8 sampling profile of a board load) and
`scripts/shaders.mjs` (GL program compiles per model open):

| | before | after |
|---|---|---|
| shader compiles when re-opening the SAME model | 1–2 every time, 0 cache hits | **0** |
| compiled programs still cached after a load | 2 of 14 | **13 of 13** |
| `readPixels` (synchronous GPU stall) | 2985 ms · 11.4% of wall | **gone** (async PBO) |
| signature verification on the main thread | ~700 ms, run 2–3× per event | **gone** (inline worker, once) |
| poster PNG encode on the main thread | ~1000 ms · 4% | **gone** (OffscreenCanvas worker) |
| GLB bytes copied + validated per post | 3× | **1×** |
| main thread idle during a load | 71% | **82%** |

- **Shaders recompiled for identical models.** Babylon caches compiled programs
  per engine, but `Effect.dispose()` deletes the cache entry when the last
  material using it goes away — and we dispose a container after every poster
  render, preview swap and viewer navigation. `Effect.PersistentMode = true`
  keeps them; the cache is bounded by distinct define sets, not by models.
- **Nothing waits on the GPU any more.** `rtt.readPixels()` is a
  Promise-wrapped *synchronous* `gl.readPixels`; posters now read back through
  a PIXEL_PACK_BUFFER + fence.
- **Event verification was happening three times** — inside nostr-tools' relay,
  at our ingress, and again in the parser — all on the main thread at ~46 ms
  each. Now: once, in an inline worker (with a sync fallback), remembered per
  event object.
- **One decode per model.** `getModelBytes()` shares a single `Uint8Array`
  between poster, preview and viewer, `validateGLBCached()` memoises the limit
  report by hash, and Babylon loads from those bytes instead of a `File`
  (which re-reads through a FileReader).

## Key fixes this round (2026-08-17, round 5 — performance)

Measured with the new `scripts/perf.mjs` harness (headless SwiftShader,
1280x800; boot numbers from the production build, median of 3):

| | before | after |
|---|---|---|
| idle board | 13.7 renders/sec | **0** (demand-driven loop) |
| board p95 frame | 82 ms | **17 ms** |
| viewer / thread | 7.6 / 21.9 fps | **60 / 57 fps** |
| 48-card fling | 5.6 fps, p95 858 ms | **25.8 fps, p95 65 ms** |
| all posters ready | ~15 s | **~8–11 s** |
| first card (built) | 2.08 s | **1.22 s** |
| JS bundle / standalone | 1617 kB / 3.52 MB | **1411 kB / 3.17 MB** |

- **Render on demand** (merged with agent-kestrel's parallel work on the same
  task). The engine draws only when `kick()`ed (input, content arrival, route
  change — a 300 ms uncapped window) or while a registered animation source
  reports motion (capped at 30 fps). The sources are deliberately precise:
  motion only while a ring STEP or a live-preview refresh is actually due, a
  camera really moved, or drag/momentum is running. A static board renders
  **zero** frames.
- **Adaptive resolution now actually engages.** It was measuring the duration
  of the `render()` call (~0.9 ms — that only submits work) instead of the
  time between frames, so it could never trigger; it now feeds real frame
  gaps into the EMA and steps the scale down on slow devices (measured: EMA
  80 ms → 0.7× scale during a 48-card fling). The target ratio is
  devicePixelRatio clamped by a 2.6 Mpx buffer budget.
- **Virtualised board.** Card slots are recycled to the rows nearest the
  viewport — which also fixed a real bug: slots were bound by index, so with
  more roots than slots every row past the 24th was never drawn.
- **Work follows the viewport.** Posters and live previews are requested only
  within a one-screen prefetch window and only after scrolling settles; the
  poster queue is paused while the feed moves, so a GLB parse can't stall a
  fling. Live previews are capped at 15 fps per slot and skipped offscreen.
- **Cheaper posters.** Straight from the GPU readback to a texture (the PNG
  for the cache is encoded off the critical path), one reusable render target
  and readback buffer at 448×280, and 3 warm-up frames + one readback instead
  of up to 60 readbacks with 100 ms sleeps.
- **Budgets.** Hardware scaling honours devicePixelRatio *and* a 2.6 Mpx
  drawing-buffer budget; model blobs in RAM are an LRU (6 / 48 MiB) on top of
  the IndexedDB cache; `dominantFacing` strides a 12k-triangle sample.
- **Curated glTF loader** (`src/model/gltf.ts`) — drops glTF 1.0 and
  KHR_interactivity's FlowGraph engine.

## Key fixes this round (2026-08-17, round 4, see git history)

### Loading is visible everywhere
A 12-dot **spinning ring** is now the single loading idiom: an SVG ring in the
HUD (labelled *connecting* / *loading model* / *building thread*, reference
counted per reason) and an in-canvas ring on every board card and thread node
that has no poster yet — drawn once into a texture and spun by `rotation.z`,
so it stays crisp at any DPR/zoom.

### One model in the single-model view
`Viewer.load()` cleared the scene and *then* awaited the GLB parse, so racing
navigations (fast prev/next, or bouncing back to the board) added several
containers to the same scene and never disposed the earlier ones — models drew
on top of each other. Loads now take a token: a parse that returns stale
disposes its own container; `clear()` cancels in-flight loads and sweeps any
non-helper mesh/transform/camera; `main.ts` holds a matching navigation
ticket. `scripts/interact.mjs` hammers next/prev and asserts the scene holds
exactly the current container's meshes.

## Key fixes this round (2026-08-17, round 3, see git history)

### Mirroring: root-caused in the camera, calibration deleted
Flat scenes were viewed from **+Z**. Babylon is left-handed, so screen-right
was world **-X** and every `CreatePlane` card was seen from BEHIND: posters
mirrored, reply badges mirrored, and even the board's column order reversed.
All flat scenes now build their camera with `core/gfx.flatCamera()` (ortho at
**-Z**), and with that **no texture kind needs any flip** — the per-GPU,
per-kind boot calibration from round 2 is gone. `test/orient2.ts` +
`node scripts/orient.mjs` render raw/dyn/rtt probe quads and fail if any
corner lands in the wrong place.

Flat *models* were also framed from the wrong side: `dominantFacing()` now
picks the thin AABB axis, signs it with area-weighted **authored normals**
(left-handed winding, verified against Babylon's own `CreatePlane`) and falls
back to `+axis` for closed shapes. Measured on live feed content with
`test/facing.ts` — wordmarks that used to read backwards now read forwards.

### Transparent previews for real
Two bugs, both fixed: `makeCardMaterial` **called** `mat.needAlphaBlending()`
(a getter) instead of passing `needAlphaBlending: true` as a ShaderMaterial
option, so cards drew opaque; and the poster/preview scenes had
`autoClear = false`, so `rtt.clearColor` never ran (the scene owns the clear on
the `camera.outputRenderTarget` path). Models now float on the backdrop, with a
soft contact shadow placed from the poster's **measured footprint** (the model's
projected AABB), not guessed.

### Crisp HUD
Every icon is inline stroked SVG (the old ⤨ ⏃ ⤓ glyphs are missing from default
UI fonts and fell back to a blurry substitute face); the reply badge draws its
arrow with canvas vector strokes; the engine renders at `devicePixelRatio`
(capped at 2) instead of a pinned 1.0/1.25. Toolbar is a glass rail with
labels, and the whole HUD flips to dark ink on light backgrounds.

### Thread map: real pan, real pinch
Pan measured the delta from the pointer-down anchor on *every* move and added
it to the pan, so the map accelerated away while you held the pointer. It now
integrates the delta since the previous event. Input is bound to the canvas
with **native pointer events** (Babylon funnels touches through
`navigator.maxTouchPoints` slots and drops the second finger), giving pinch
zoom + two-finger pan; the wheel zooms about the cursor; `0` re-fits. Layout is
a tidy tree (leaf slots, parents centred) with elbow connectors, node frames
and an accent-outlined root.

### Framing
`frameDistance()` fits the 8 AABB corners against both frustum planes, so a
wide model fills a 16:10 card instead of being sphere-fitted into a stamp.

## Key fixes this round (2026-08-17, round 2, see git history)

### Mirroring fixed for real: per-kind, per-GPU boot calibration
The horizontal flip of the card pipeline differs per GL driver AND per texture
kind. At boot the app now renders red/blue probe quads for each kind (poster
RawTexture, badge DynamicTexture, live-preview RTT) through the REAL board
camera and reads the default framebuffer back atomically (no flush), then
applies the measured flip per kind. Both X and Y are calibrated — nothing is
hardcoded. Verified end-to-end: synthetic GLB -> PosterRenderer -> PNG ->
RawTexture -> card -> framebuffer reads correctly on both axes.

### Mockup-driven design pass
- Cards are frameless and fully transparent (no rounded rects, borders,
  shadows) — models float on the backdrop, "air styled".
- Thin separator lines between rows instead of card frames.
- Reply tree fans within a <90 degree cone (measured ~84 degrees) and every
  node stays below its parent — it reads as a tree.
- Ghost reply badges, glassy translucent HUD, brighter backdrop gradient.

## Key fixes this round (2026-08-17, round 1, see git history)

### "Flipped posts" bugs (root-caused empirically, see `test/orient2.ts`)
Card textures are sampled by a custom unlit shader whose Y-flip was hardcoded.
Empirically (per-texture readback + raw-WebGL control):
- **Posters (RawTexture)** are stored top-down -> need Y flip: `flip(0,1)`.
- **Live previews (RTT)** and **badges (DynamicTexture)** are stored bottom-up
  -> must NOT be Y-flipped. The old shader flipped them, so animated card
  previews and reply badges ("↩ N") rendered **upside down**.
- No X flip anywhere; the horizontal axis was already correct.
The card shader now takes a per-path `flip` vec2 (`setCardFlip(mat, x, y)`).
- Feed order: roots are now sorted newest-first (was relay arrival order).

### Transparent 3D previews
Poster and live-preview render targets now clear with alpha 0 and the card
shader passes texture alpha through (alpha-blended). Cards composite over the
board backdrop instead of sitting in opaque #0B0B0C rectangles that would
mismatch any page background.

### Visual pass (VLM screenshot critique + programmatic pixel analysis)
- Board: responsive 1-3 column grid (was a single narrow column with dead
  side margins), gradient backdrop, soft card shadows, rounded corners +
  hairline borders, reply badges are true pills (canvas alpha).
- Viewer: gradient backdrop that follows the camera, ground glow under the
  model (spatial reference), slightly stronger light rig.
- Thread: bigger nodes, brighter edges, auto-fit zoom on open.
- HUD: FORM/0 wordmark, larger glassy buttons, labeled viewer controls.

## Verified live (2026-08-16, headless Chromium)
- 13 events / 7 roots → 7 posters + 1 live animated card; posters bright
  (capsule max≈148, numbers max≈115).
- Reply badges: roots with 1 and 2 replies show "↩ 1" / "↩ 2".
- Thread map opens with nodes + edges; tap → viewer; background setting
  applies to viewer AND thread.
- Standalone `file://` build boots with only user-content requests, zero CDN.

## Key fixes this round (see spec AMENDMENTS)
- **Black posters**: two causes — (a) `RenderTargetTexture.render()`/renderList
  never compiled materials on this driver → render via `camera.outputRenderTarget`
  + `scene.render()`; (b) `whenReadyAsync()` on a never-rendered scene hangs →
  removed; (c) environment-texture IBL blackened PBR → removed, lights-only.
- Poster thumbnails always auto-fit (authored cameras belong in the viewer).

## Run (Bun)
```bash
bun install
bun run dev              # http://localhost:5173
bun run build            # typecheck + normal build → release/
bun run build:standalone # ONE .html → form-zero-standalone.html
bun scripts/perf.mjs     # perf harness: boot, frame cost per view, 48-card stress, idle, heap
bun scripts/orient.mjs   # orientation guard (raw/dyn/rtt probes) — exits 1 on a mirror
bun scripts/interact.mjs # thread pan/pinch/zoom + tap targets
bun scripts/smoke.mjs    # headless boot + layout/poster/live/click/scroll
bun scripts/features.mjs # badges + thread view + settings assertions
```

## Structure
```
src/
  core/      engine (1 canvas/1 context), router, assets (poster/model cache)
  protocol/  nostr (Relay pool + backoff), blossom (SHA-256 verified), events, storage
  model/     draco (local), limits (pre-load GLB validation), facing, poster
  core/gfx   flatCamera (orientation contract), backdrops, contact shadows
  board/     board (responsive grid + badges + inertia), threadView (tidy tree map,
             native pan/pinch), cardMaterial (unlit quad shader), previewPool (RTT slots)
  viewer/    detail viewer (one model, own cameras + orbit)
  studio/    import foundation
```

## Next (spec order)
Network panel / error sheets → studio publish (BUD-01) + audio embed →
brush editor (05-B) + low-poly text + animation editor (05b) →
Vitest + Playwright suite with screenshots.

## Docs for agents

Multiple agents work on this repo. Start with **`AGENTS.md`** (root), then:
- `docs/SPEC.md` — build spec + live measured facts + AMENDMENTS (authoritative)
- `docs/ARCHITECTURE.md` — module map, data flow, texture-flip matrix
- `docs/STATUS.md` — task board (claim a task before working)
- `docs/CONVENTIONS.md` — toolchain, code, verification, git rules

## Deploy to GitHub Pages

Automatic: `.github/workflows/deploy-pages.yml` builds the standalone with Bun
and publishes it to GitHub Pages on every push to `main`
(Settings → Pages → Source → **"GitHub Actions"**). No manual steps.

The site is ONE self-contained HTML file; at runtime it fetches only user
content (Nostr relays over `wss://`, Blossom blobs over `https://`).
