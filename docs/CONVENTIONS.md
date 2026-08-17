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

Rules of thumb learned the hard way:

* Never calibrate geometry at runtime. If something is mirrored, the camera or
  the winding is wrong — find it and write the invariant down.
* Never trust a symbol glyph to exist in the user's font. Draw icons.
* Anything that integrates pointer deltas must integrate them **per event**.
* Look at the light theme and a phone viewport before calling a design done.
