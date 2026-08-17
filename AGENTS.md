# AGENTS.md — how to work on this repo

This file is for AI coding agents (and humans) working on **FORM/0**. Read it
before touching anything. It is short on purpose; the details live in the
linked docs.

## What this is

FORM/0 is an anonymous, wordless 3D imageboard. A browser-only client that
speaks directly to Nostr relays + Blossom servers; **one `<canvas>`**, every
pixel drawn by Babylon.js. Posts are animated GLB models with their own
cameras, optional embedded audio.

Two hard product goals:
1. Real content from real public relays on first run (no seeding/config).
2. `bun run build:standalone` emits **ONE `.html`** that opens from `file://`
   and fetches nothing but user content.

The **build spec** is `docs/SPEC.md` — read it fully before writing code. Its
trailing AMENDMENTS section overrides earlier wording where they conflict.

## First steps for any agent

```bash
bun install            # Bun, NOT npm (bun.lock is the lockfile)
bun run dev            # http://localhost:5173
bun run build          # typecheck (tsc --noEmit) + vite build → release/
bun run build:standalone  # ONE self-contained form-zero-standalone.html
```

## Required reading

| Doc | Contents |
|---|---|
| `docs/SPEC.md` | The build spec + live [MEASURED] facts + AMENDMENTS (authoritative) |
| `docs/ARCHITECTURE.md` | Module map, data flow, scene layout, texture-flip matrix |
| `docs/STATUS.md` | Task board — what's done, in progress, next. **Claim a task there before working.** |
| `docs/CONVENTIONS.md` | Code style, engine traps, verification rules |
| `docs/RESEARCH-EDITORS.md` | How simple 3D viewers/editors are done (gizmos, picking, brushes, instancing, undo) — read before Studio/editor work |

## Non-negotiable rules (each one previously cost real debugging)

1. **Deep imports only.** `import { Scene } from '@babylonjs/core/scene'`, never
   the `@babylonjs/core` barrel — the barrel is 6 MB and untree-shakable.
2. **One engine, one context.** Scenes swap via `engine.setActiveScene()`; never
   create a second canvas or Engine. The engine must NOT touch
   `scene.clearColor` on swap (the settings panel owns the background).
3. **Validate GLBs before Babylon loads them** — `src/model/limits.ts`
   (`validateGLB`). This is the "Aw, Snap!" / crash prevention.
4. **Offscreen renders go through `scene.render()`** with
   `camera.outputRenderTarget = rtt`, NOT `RenderTargetTexture.render()` +
   renderList (that path never compiles materials on some drivers → blank
   posters/previews). See `poster.ts` / `previewPool.ts`.
5. **No `scene.environmentTexture` (IBL)** — it rendered every PBR model black.
   Lights-only rig (hemispheric + directional + fill).
6. **Posters always auto-fit** (`worldBounds` + `dominantFacing` +
   `fitDistance` in `model/facing.ts`). The model's authored cameras belong in
   the **viewer** (camera dots), never the thumbnail.
7. **Display rendering is double-sided** (`backFaceCulling = false`) so flat
   text/models are never invisible; never modify the source GLB.
8. **Side-effect imports** are required for `scene.pick` (`@babylonjs/core/Culling/ray`)
   and screenshots (`@babylonjs/core/Misc/screenshotTools`); loaders:
   `@babylonjs/loaders/glTF`.
9. **Flat scenes get their camera from `core/gfx.flatCamera()`** (ortho, at
   **-Z**, `alpha = -PI/2`). Babylon is left-handed: a camera at +Z sees every
   `CreatePlane` quad from BEHIND — mirrored textures and mirrored column
   order. With the -Z camera **no texture kind needs a flip** (raw/dyn/rtt all
   sample `(0,0)`); there is no per-GPU calibration any more. Never "fix" an
   orientation by eye — run `node scripts/orient.mjs` (probe quads through all
   three kinds) and `node scripts/capture.mjs` + `visual_critique.py`.
9b. **Alpha blending is a ShaderMaterial OPTION** (`needAlphaBlending: true`),
   not the `mat.needAlphaBlending()` getter, and offscreen scenes must set
   `autoClear = true` + `clearColor = (0,0,0,0)` — on the
   `camera.outputRenderTarget` path the SCENE owns the clear, so `rtt.clearColor`
   alone leaves models sitting on black.
9c. **HUD icons are inline SVG**, never font glyphs (⤨ ⏃ ⤓ … fall back to a
   blurry substitute face), and the engine renders at `devicePixelRatio`.
9e. **Async loads take a token.** `Viewer.load()` awaits a GLB parse after
   clearing; without `++this.loadToken` (and the `viewerNav` ticket in
   `main.ts`) a superseded load lands in the scene and you get two models
   stacked in the single-model view. Anything that awaits then mutates a scene
   must re-check its token first.
9g. **The engine renders on demand.** Do not assume `onBeforeRenderObservable`
   runs every frame — it runs when something asked for a frame. Any visual
   change made outside a render must call `engine.invalidate()`, and any view
   that animates must say so through its activity probe. Never latch a probe
   flag true; a stuck flag quietly restores full-rate rendering (check
   `scripts/perf.mjs` -> `idleBoard.rendersPerSec`, which must stay ~2-3).
9h. **Work follows the viewport.** Posters/live previews are requested only
   for cards near the viewport and only after scrolling settles; the poster
   queue is paused while the feed moves. Card slots are recycled — never bind
   a slot to a row by index.
9f. **Show the ring.** Any wait longer than a frame gets the spinning-ring
   indicator: `setLoading(reason, on, label)` for the HUD, or the in-canvas
   ring for cards/nodes. It is reference-counted per reason.
9d. **The thread map binds native pointer events** — Babylon drops the second
   finger via `navigator.maxTouchPoints` slots. Pan integrates the delta since
   the previous move event (anchor-based deltas drift forever).
10. **Zero CDN.** Draco decoders are local (`model/draco.ts`); KTX2/MSC
    transcoder CDN URLs are blanked (`model/offline.ts`). Assert
    `grep -c cdn.babylonjs.com` on the built bundle is 0 (except the inert
    comparison strings inside Babylon itself).
11. **Never commit** `node_modules/`, `release/`, `form-zero-standalone.html`,
    `shots/`, `*.tsbuildinfo` (already in `.gitignore`).

## Verification — required before claiming any change works

Agents have no vision; **pixel/OCR checks are the eyes**. Always run:

```bash
bun run build                       # must be clean
bun scripts/orient.mjs              # ORIENTATION GUARD: raw/dyn/rtt probes, exits 1 on a mirror
bun scripts/interact.mjs            # thread pan (no drift) + pinch + wheel-about-cursor + taps
bun scripts/smoke.mjs               # boot + feed + posters + live slots + scroll + click
bun scripts/features.mjs            # reply badges + thread view + settings
bun scripts/capture.mjs             # board/viewer/thread/light/phone screenshots to shots/
bun scripts/perf.mjs                # PERF: boot, per-view frame cost, 48-card stress, idle, heap
CPU=4 bun scripts/perf.mjs          #   …the same, throttled to emulate a phone
python3 scripts/visual_critique.py  # orientation + composition on those shots
```

Extra tools when touching the auto-fit/facing math:

```bash
bun scripts/collect-urls.mjs                 # list the GLB urls the live feed is serving
bun scripts/facing.mjs <glb-url> [<url>…]    # renders each model from +facing and -facing
                                             # -> shots/facing.png (judge the readable side)
```

`npm` works too if Bun is unavailable (`npx vite`, `node scripts/…`).

Screenshots in `shots/` are scratch (gitignored). If a visual change is
claimed, include the critique output.

## Working with other agents (this is a shared repo)

- **One agent per area.** Check `docs/STATUS.md`, mark your task "in progress",
  push, then mark "done". Do not silently redo a task another agent finished.
- **Sync before pushing:** `git fetch && git rebase origin/main`, then push.
- **Atomic commits**, message like `area: what and why`. Never commit secrets
  or the build artifacts.
- **Fix forward.** If you discover a bug, fix it in code and note it in
  `docs/SPEC.md` AMENDMENTS + `docs/STATUS.md`, so the next agent doesn't
  reintroduce it.
- **Deploy is automatic.** `.github/workflows/deploy-pages.yml` builds the
  standalone and publishes to GitHub Pages on every push to `main`. Do not
  hand-edit `docs/index.html` (that path was removed).
