# CONVENTIONS

## Terminology

- The Studio editor is a **paint editor** (Paint 3D-style), never a "voxel
  editor". Free strokes of shapes (cube/sphere/cylinder/tetra/quad) that
  overlap and interpenetrate; the fine grid is for *snapping only*, not a
  filled-cell data model. Never use "voxel" to describe the product or the
  editor module.

## Toolchain

- **Bun**, not npm. Lockfile is `bun.lock`. CI uses `oven-sh/setup-bun` +
  `bun install --frozen-lockfile`.
- TypeScript `strict: true`, no `any` in exported signatures.
- Vite (two configs: `vite.config.ts` normal, `vite.standalone.config.ts`
  single-file). Babylon (`core`/`gui`/`loaders`/`serializers`), `nostr-tools`.
  No React/Vue/Three, no CSS framework, no CDN at runtime.

## Code

- **No source file over ~400 lines.** One clear job per module; if it needs a
  table of contents, split it.
- Comment **why**, not what. Every engine-bug workaround must carry a comment
  naming the bug (so a later "cleanup" doesn't reintroduce it). See
  `cardMaterial.ts`, `poster.ts`, `previewPool.ts` for the style.
- Babylon imports are **deep paths** (`@babylonjs/core/scene`), never the
  barrel.
- Types for Nostr/thread data live in `protocol/thread-index.ts`
  (`ThreadMeta`). Extend there, then update `parseModelEvent`.

## Rendering

- Card imagery: real meshes in an ortho scene (1 world unit = 1 logical px),
  not Babylon GUI. GUI/HTML draws chrome and hit zones on top.
- Unlit card shader (`cardMaterial.ts`) for all 2D quads — StandardMaterial
  emissive/diffuse is unreliable on strict GL drivers.
- Transparent previews: RTTs clear with alpha 0; the shader passes texture
  alpha (alpha-blended) so cards composite over any background.

## Verification (mandatory)

Run in order before claiming done:

```bash
bun run build
bun scripts/smoke.mjs
bun scripts/features.mjs
bun scripts/capture.mjs && python3 scripts/visual_critique.py
```

- Visual claims require screenshots **and** the critique output (agents have no
  vision; pixel/OCR checks are the eyes).
- Assert zero-CDN: built bundle must make no `cdn.babylonjs.com` request.
- Live-network tests hit real relays; `relay.nostr.band` and `damus.io`
  intermittently fail — the app must degrade gracefully (per-relay state).

## Git

- Branch: `main` (shared). `git fetch && git rebase origin/main` before
  pushing; small atomic commits.
- Message: `area: what changed (and why if non-obvious)`.
- Never commit: `node_modules/`, `release/`, `form-zero-standalone.html`,
  `shots/`, secrets, `*.tsbuildinfo` (`.gitignore` covers these).
- Deploy is automatic on push (GitHub Actions → Pages). Don't hand-edit the
  published artifact.

## Discovered a bug?

Fix it in code, then record it twice so other agents don't reintroduce it:
1. `docs/SPEC.md` → AMENDMENTS (one terse numbered entry), and
2. `docs/STATUS.md` → Known gaps/debt if still open.


## Verification (2026-08-17, round 3)

Vision is the only way these bugs get caught. Before claiming a visual or
input change works:

| Command | Guards |
|---|---|
| `node scripts/orient.mjs` | mirrored / upside-down cards, badges, live previews |
| `node scripts/interact.mjs` | thread pan drift, pinch zoom, wheel-about-cursor, taps |
| `node scripts/smoke.mjs` | boot, feed, posters, live slots, scroll, click |
| `node scripts/features.mjs` | reply badges, thread view, settings |
| `node scripts/capture.mjs` | screenshots incl. light theme + phone viewport |
| `node scripts/facing.mjs <url>` | which side of a model is the readable one |
| `node scripts/offline-verify.mjs` | deterministic pixel/state checks of the poster camera policy, live-slot reuse, thread animation, card crossfades and studio view tools (runs against `scripts/offline-rig.mjs`, no real relays needed) |

When relays/CDNs are unreachable (sandboxes), see `docs/SANDBOX-VERIFY.md`:
how to obtain a headless Chromium from the npm registry alone (NSS libs from
the `@sparticuz/chromium` bundle + `LD_LIBRARY_PATH` + a Playwright path
shim), and how the offline rig (`scripts/offline-rig.mjs`: local wss relay +
https model server + CSP-safe relay injection via a proxy on :4173) feeds
the whole suite. All suites then run unmodified with
`TARGET_URL=http://localhost:4173/`.

Rules of thumb learned the hard way:

* Never calibrate geometry at runtime. If something is mirrored, the camera or
  the winding is wrong — find it and write the invariant down.
* Never trust a symbol glyph to exist in the user's font. Draw icons.
* Anything that integrates pointer deltas must integrate them **per event**.
* Look at the light theme and a phone viewport before calling a design done.


## Performance budget (round 5)

`node scripts/perf.mjs` writes `shots/perf.json`. Keep these in range on the
headless SwiftShader baseline (1280x800); they are ratios, not absolutes, so
they hold on real GPUs too:

| Metric | Budget |
|---|---|
| `idleBoard.rendersPerSec` (static board) | 0 (the loop is demand-driven) |
| `board.frameMs.p95` | < 25 ms |
| `stress.scrolling.p95` (48 cards, continuous fling) | < 120 ms |
| `boot.firstCardMs` (production build) | < 1.5 s |
| `counts.modelBytesInMemory` | < 48 MiB |
| JS bundle | < 1.5 MB raw / 400 kB gzip |

If a number regresses, look for: a latched activity probe, a texture upload in
a per-frame path, work queued for offscreen cards, or a new barrel import.

**Dismiss the first-run legend in any harness** (`window.__form0?.legend?.close()`).
It is a full-screen `backdrop-filter: blur()` overlay; leaving it up makes every
frame measurement meaningless (it turned a 65 ms p95 into 4600 ms here) and
swallows clicks.


## Profiling tools (round 6)

| Command | What it answers |
|---|---|
| `node scripts/shaders.mjs` | Are shaders recompiled for models we already drew? (prints GL program compiles + cache hits per model open; repeat opens must be `+0`) |
| `PHASE=load node scripts/profile.mjs` | Where does the main thread actually go during a board load? (V8 sampling profile aggregated by self time) |
| `PHASE=viewer/scroll node scripts/profile.mjs` | Same, for viewer navigation and flinging |

Both write artefacts to `shots/`. Read the profile before optimising anything:
the four biggest wins of round 6 (`readPixels`, `verifyEvent`, `toBlob`,
duplicate GLB parses) were all invisible until they were measured, and two of
them were duplicate work rather than slow code.


## Settings (round 7)

`node scripts/settings.mjs` must pass: it asserts that controls reach real
engine state (drawing-buffer size, frame cap, created pipelines, unlit
materials, camera FOV, preview slots, contact shadows), that presets move many
keys at once, that any edit flips the preset to Custom, and that everything
survives a reload.

When adding a setting: schema entry → `apply.ts` wiring → a check in
`scripts/settings.mjs`. If it cannot be honoured, give it an `unavailable()`
reason instead of a dead control.
