# AGENTS.md — how to work on this repo

This file is for AI coding agents (and humans) working on **FORM/0**. Read it
before touching anything. It is short on purpose; the details live in the
linked docs.

## What this is

> NAMING RULE (2026-08-17): describe FORM/0 as **a game** ("a wordless
> multiplayer game of 3D shapes"), never with board-culture terms. The old
> self-description got the deployed site flagged by at least one ISP's
> content filter. Keep ALL project text (docs, meta tags, commit messages,
> code comments) in game vocabulary: players, creations, gallery, world.

FORM/0 is a wordless multiplayer game of 3D shapes. A browser-only client that
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

> **SESSION SAFETY: commit and push as you go.** Sandbox sessions can be
> reset at any moment (2026-08-18: the whole workspace was replaced by a
> fresh clone mid-task). Only **pushed** commits are guaranteed to survive;
> uncommitted edits survive only as a working-tree snapshot, and local-only
> commits live in a `.git` that the reset discards. Commit small,
> self-contained changes at least every ~60 seconds of active work and
> `git push` immediately after each commit. After a reset: `git fetch`,
> find the remote tip, `git diff <tip>` to see what survived as working-tree
> delta, reapply it on top of the tip, commit, push. (Full playbook:
> `docs/SANDBOX-VERIFY.md` § Sandbox resets.)

1. **Deep imports only.** `import { Scene } from '@babylonjs/core/scene'`, never
   the `@babylonjs/core` barrel — the barrel is 6 MB and untree-shakable.
2. **One engine, one context.** Scenes swap via `engine.setActiveScene()`; never
   create a second canvas or Engine. The engine must NOT touch
   `scene.clearColor` on swap (the settings panel owns the background).
3. **Validate GLBs before Babylon loads them** — `src/model/limits.ts`
   (`validateGLB`). This is the "Aw, Snap!" / crash prevention. Studio
   `.gltf`/OBJ imports must pass the bounded, local-only preflight in
   `model/importSidecar.ts`; never let sidecar URIs fall through to a URL.
4. **Offscreen renders go through `scene.render()`** with
   `camera.outputRenderTarget = rtt`, NOT `RenderTargetTexture.render()` +
   renderList (that path never compiles materials on some drivers → blank
   posters/previews). See `poster.ts` / `previewPool.ts`.
5. **No `scene.environmentTexture` (IBL)** — it rendered every PBR model black.
   Lights-only rig (hemispheric + directional + fill).
6. **Posters use the model's authored camera when it has one** (the poster
   must show the view the author framed); auto-fit (`worldBounds` +
   `dominantFacing` + `fitDistance` in `model/facing.ts`) is the fallback for
   models without a camera. Live previews follow the same policy
   (`preview-camera` index → first imported camera → auto-fit).
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
9j. **Settings live in one schema.** Add to `src/settings/schema.ts` (type,
   default, group, preset value, availability probe) and wire it in
   `src/settings/apply.ts`. Never ship a control that does nothing: if the
   platform cannot do it, give `unavailable()` a reason and offer the real
   equivalent. Turning a renderer feature on by default is a perf decision —
   measure it (enabling image processing globally cost ~7x on posters).
9i. **Don't pay twice.** Before optimising, run `scripts/profile.mjs`. The
   expensive things in this app are duplicated work, not slow algorithms:
   shaders recompiled because a container was disposed, events verified by
   nostr-tools AND by us AND again in the parser, the same GLB copied and
   validated three times, a synchronous `readPixels` per poster.
9h. **Work follows the viewport.** Posters/live previews are requested only
   for cards near the viewport and only after scrolling settles; the poster
   queue is paused while the feed moves. Card slots are recycled — never bind
   a slot to a row by index.
9f. **Show the ring, and show the bytes.** Any wait longer than a frame gets
   the spinning-ring indicator: `setLoading(reason, on, label)` for the HUD,
   or the in-canvas ring for cards/nodes. It is reference-counted per reason.
   Anything that moves bytes over the network must register with
   `src/core/transfer.ts` (`transfers.track('down'|'up', totalBytes)` ->
   `advance(delta)` -> `end()` in a `finally`) so the HUD can show a real
   speed instead of an opaque spinner. Upload progress needs XHR — `fetch`
   reports nothing about request-body progress.
9m. **Every CSS custom property must exist in the DEFAULT theme.** `--danger`
   was declared only under `body[data-theme="light"]`, so for months every
   `var(--danger)` in the dark theme resolved to nothing — the offline
   relay/server dot was invisible, `.net-remove:hover`, `.studio-status.err`
   and `.hbtn.danger` were unstyled. A missing custom property fails SILENTLY
   (the declaration is dropped at computed-value time); it never shows up as
   an error. Add new colours to `:root` first, then override per theme, and
   keep them in sync with `src/theme.ts` (canvas code reads that copy).
9l. **Overlays must not be pages.** A HUD surface that sits ON TOP of a view
   (network panel, settings, legend, error sheet) must leave the view behind
   it mounted and return to it on close. `#/network` used to call
   `setMode('board')`, so opening it from the viewer/thread/studio destroyed
   that view and closing dumped the player on the board. `main.ts` keeps the
   last non-overlay route in `networkReturn` and rewrites the hash on close
   WITHOUT re-applying it (`skipNextApply`) — re-applying `studio` clears the
   imported model, and `viewer`/`thread` would reload from scratch.
9k. **Touch targets are >= 42px.** HUD controls are 42x42 (`.hbtn`) with a
   10px gap; a small *visual* (a status dot, a badge) must still sit inside a
   full-size button, never be the button. The network dot shipped as a
   literal 8x8 button for months and was near-unhittable on touch.
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
bun scripts/shaders.mjs             # shader recompiles (repeat model opens must compile 0 programs)
bun scripts/settings.mjs            # every setting must reach real engine state (20 checks)
bun scripts/transfer.mjs            # network button hit target + global AND per-server speed/ping/status readouts (needs the rig)
bun scripts/network-panel.mjs       # network panel is an overlay: opens over / returns to the current page (needs the rig)
PHASE=load bun scripts/profile.mjs  # CPU profile of a board load, aggregated by self time
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
- **NEVER force-push `main`.** It is now branch-protected (force pushes and
  deletion blocked) after an incident on 2026-08-17 where a rewrite
  force-pushed 3 unrelated root commits over 20 commits of shared history.
  `main` was restored from the last green CI SHA; the rewrite is preserved on
  `salvage/dev-rewrite`. If you want to restructure the app, do it as commits
  ON TOP of main (or a branch + merge), never by replacing history.
- **Atomic commits**, message like `area: what and why`. Never commit secrets
  or the build artifacts.
- **Fix forward.** If you discover a bug, fix it in code and note it in
  `docs/SPEC.md` AMENDMENTS + `docs/STATUS.md`, so the next agent doesn't
  reintroduce it.
- **Deploy is automatic.** `.github/workflows/deploy-pages.yml` builds the
  standalone and publishes to GitHub Pages on every push to `main`. Do not
  hand-edit `docs/index.html` (that path was removed).
- **Pages source MUST stay "GitHub Actions"** (Settings → Pages → Source).
  On 2026-08-17 it was flipped to "Deploy from a branch /", which serves the
  RAW repo root: the dev `index.html` that loads `/src/main.ts` — a TypeScript
  module no browser can run, so https://sodomita.github.io/f0/ went blank
  ("network changed"/timeout in practice). The repo root is SOURCE, not a
  site; only the workflow artifact (form-zero-standalone.html → index.html)
  is deployable. If the site ever serves ~13 KB of HTML instead of ~3.7 MB,
  this setting is the first thing to check
  (`GET /repos/SodoMita/f0/pages` → `build_type` must be `workflow`).
