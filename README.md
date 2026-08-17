# FORM/0

Anonymous, wordless 3D imageboard — browser-only client, direct to Nostr
relays + Blossom servers, one `<canvas>` drawn entirely by Babylon.js.
Posts are animated GLB models with their own cameras, optional embedded audio.

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
