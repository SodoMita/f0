# ARCHITECTURE

## Module map

```
src/
  main.ts            boot + HTML HUD wiring + route/mode switching + network
  core/
    engine.ts        ONE canvas / ONE Engine / ONE context; scene swap + render loop
    router.ts        hash routes: board | thread/:id | viewer/:id | studio | network
    assets.ts        poster+model cache (IndexedDB by SHA-256), ≤3 concurrent dl,
                     serialized poster renders (promise-chain mutex)
  protocol/
    nostr.ts         RelayPool on nostr-tools `Relay` (SimplePool.subscribeMany is
                     broken in 2.24 — nests filters one level too deep)
    blossom.ts       download (replicas→SHA-256→GLB magic) + BUD-01 upload + auth
    events.ts        kind-1063 parse/validate (mime, x/ox, size, urls, v3 tags)
    thread-index.ts  ThreadIndex: roots, children, tombstones, childCount, flatten
    storage.ts       IndexedDB (+in-memory fallback): model/poster cache, settings,
                     network config
  model/
    draco.ts         local Draco decoders (data: URIs), numWorkers:0
    offline.ts       blank KTX2/MSC CDN URLs (zero-CDN guarantee)
    limits.ts        validateGLB() — pre-load GLB complexity caps (crash guard)
    facing.ts        worldBounds (union AABB) + dominantFacing (magnitude axis) +
                     fitDistance; the auto-fit math
    poster.ts        GLB → 512×320 PNG via scene.render() + camera.outputRenderTarget;
                     blank-frame retry loop
  board/
    board.ts         responsive 1–3 col grid, scroll+inertia, tap→viewer, reply badges
    cardMaterial.ts  custom unlit quad ShaderMaterial: tex.rgb*tint*alpha, per-path
                     flip vec2, rounded corners, hairline border
    previewPool.ts   bounded live-preview RTT slots; scene.render() per slot
    threadView.ts    2D reply-tree map, Fruchterman-Reingold force relaxation
  viewer/
    viewer.ts        detail viewer: orbit + authored cameras, lights, ground glow,
                     stats, setBackground
  studio/
    studio.ts        import-only stub (publish/audio TBD)
  theme.ts           colors, LIMITS, DEFAULTS (relays/blossoms), kind numbers
```

## Data flow

```
relays ──(kind 1063 + 5)──▶ RelayPool ─▶ parseModelEvent ─▶ ThreadIndex
                                                              │
                                          ordered roots       │
                                                              ▼
                    Board ◀── setMetas/setReplyCount ──── main.ts
                     │  per card:
                     ├─ AssetCache.getPoster ─▶ PosterRenderer ─▶ RawTexture (flip Y)
                     └─ PreviewPool.request ─▶ RTT (no flip) ──▶ card shader
   tap card ─▶ #/viewer/:id ─▶ Viewer.load ─▶ authored cameras + orbit
   tap badge ─▶ #/thread/:id ─▶ ThreadView.open ─▶ force-relaxed 2D map
```

## Scenes (one engine, swapped, never recreated)

| Scene | Owner | Purpose |
|---|---|---|
| board | `Board` | ortho; card planes (XY), badges, shadows |
| viewer | `Viewer` | one model; orbit + authored cameras |
| thread | `ThreadView` | ortho; 2D reply map |
| studio | `Studio` | editor scene (stub) |
| ui | `FormEngine` | fallback overlay (autoClear=false) |

`engine.setActiveScene()` attaches input (scene.attachControl()) and swaps the
render target. It must **not** reset `clearColor` — each scene owns its
background (settings).

## Texture flip matrix (empirically verified — see `test/orient2.ts`)

Babylon 8 inverts `uv.x` for ShaderMaterial quads → always sample
`1.0 - uv.x`. The Y axis depends on the texture source:

| Source | Storage | flip.y |
|---|---|---|
| Posters (`RawTexture`) | top-down | **1** |
| Live preview (`RenderTargetTexture`) | bottom-up | 0 |
| Badges / HUD (`DynamicTexture`) | upload flips rows | 0 |

Set via `setCardFlip(mat, x, y)` in `cardMaterial.ts`. Never hardcode a Y-flip.

## Engine traps (do not re-learn these)

See `AGENTS.md` rules + `docs/SPEC.md` §TRAPS + AMENDMENTS. The big ones:
offscreen renders must use `scene.render()` (not `rtt.render()`); no IBL;
posters always auto-fit; `whenReadyAsync()` hangs on a never-rendered scene;
nostr-tools `SimplePool.subscribeMany` is broken (use `Relay`).
