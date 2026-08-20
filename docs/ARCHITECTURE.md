# ARCHITECTURE

## Module map

```
src/
  main.ts            boot + HTML HUD wiring + route/mode switching + network
  core/
    engine.ts        ONE canvas / ONE Engine / ONE context; scene swap + render loop
    router.ts        hash routes: board | thread/:id | viewer/:id | studio | network
    assets.ts        local-render poster + model cache (IndexedDB by SHA-256
                     + `dim` size), ≤3 concurrent downloads, serialized
                     poster renders (promise-chain mutex)
    transfer.ts      app-wide download/upload meter: per-transfer handles,
                     2s sliding-window byte rate, 200ms tick that stops when
                     idle, sliced BY SERVER ORIGIN as well as globally; feeds
                     the loading overlay, the topbar readout, the studio
                     publish status and the network panel's per-server rows
  protocol/
    nostr.ts         RelayPool on nostr-tools `Relay` (SimplePool.subscribeMany is
                     broken in 2.24 — nests filters one level too deep);
                     per-relay info() = state + ping + retry count + events
                     delivered; ping() times a REQ->EOSE round trip
    blossom.ts       download (replicas→SHA-256→GLB magic) + BUD-01 upload (XHR,
                     for upload.onprogress) + auth; both report into core/transfer
    events.ts        kind-1063 parse/validate (mime, x/ox, size, urls, dim, v4 tags)
    thread-index.ts  ThreadIndex: roots, children, tombstones, childCount, flatten
    storage.ts       IndexedDB (+in-memory fallback): model/poster cache, validated
                     settings/network config, AES-GCM owned-post envelopes + keyring
    ownedSecrets.ts  AES-256-GCM envelope codec (random IV, event-id AAD)
  model/
    importSidecar.ts bounded/local-only GLB + glTF sidecar + OBJ import/repack
    draco.ts         local Draco decoders (data: URIs), numWorkers:0
    offline.ts       blank KTX2/MSC CDN URLs (zero-CDN guarantee)
    limits.ts        validateGLB() — pre-load GLB complexity caps (crash guard)
    facing.ts        worldBox (union AABB) + dominantFacing (thin-axis / authored
                     normals) + frameDistance (aspect-aware tight fit); auto-fit math
    poster.ts        GLB → dedicated transparent RTT via scene.render() +
                     camera.outputRenderTarget, rendered at the post's `dim`
                     (default 448×280); format v4: never fetched, never a PNG
  board/
    board.ts         responsive 1–3 col grid, scroll+inertia, tap→viewer, reply badges
    cardMaterial.ts  unlit quad ShaderMaterial (tex.rgb*tint, tex.a*opacity),
                     needAlphaBlending OPTION, deterministic zero flips
    previewPool.ts   bounded live-preview RTT slots (REUSED, evicted when
                     offscreen); scene.render() per slot; authored-camera aware
    threadView.ts    2D reply-tree map: tidy tree + elbow edges, native-pointer
                     pan / pinch / wheel-zoom-about-cursor, fit-to-content;
                     live previews for animated nodes
  viewer/
    viewer.ts        detail viewer: orbit + authored cameras, lights, camera-
                     parented spotlight backdrop, contact shadow, stats
  studio/
    studio.ts        import → edit → publish: gizmos, free-fly camera, stored
                     cameras, text tool; camera stays where the user composed
                     it (explicit look-at-origin / look-at-center / fit-selected
                     buttons instead of auto-framing on import)
  core/gfx.ts        flatCamera (THE orientation contract), backdrop/spotlight/
                     contact-shadow textures, colour helpers (shade/luminance)
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
                     ├─ AssetCache.getPoster ─▶ PosterRenderer ─▶ transparent RTT (no flip)
                     └─ PreviewPool.request ─▶ RTT (no flip) ─────▶ card shader
   tap card ─▶ #/viewer/:id ─▶ Viewer.load ─▶ authored cameras + orbit
   tap badge ─▶ #/thread/:id ─▶ ThreadView.open ─▶ tidy-tree 2D map
```

## Scenes (one engine, swapped, never recreated)

| Scene | Owner | Purpose |
|---|---|---|
| board | `Board` | ortho; card planes (XY), badges, shadows |
| viewer | `Viewer` | one model; orbit + authored cameras |
| thread | `ThreadView` | ortho; 2D reply map (future: 3D models mode) |
| studio | `Studio` | editor scene (stub) |
| ui | `FormEngine` | fallback overlay (autoClear=false) |

`engine.setActiveScene()` attaches input (scene.attachControl()) and swaps the
render target. It must **not** reset `clearColor` — each scene owns its
background (settings).

## Orientation contract (proved by `test/orient2.ts` + `scripts/orient.mjs`)

**Every flat/ortho scene builds its camera with `core/gfx.flatCamera()`.**
It parks an orthographic `ArcRotateCamera` at **-Z looking toward +Z**
(`alpha = -PI/2`). This is the whole mirroring story:

* Babylon is LEFT-handed. A camera at **+Z** looking back at the origin has
  screen-right = world **-X**, so quads are seen from behind: posters and
  reply badges render mirrored AND the board's column order reverses.
  (That was the "x flipped posts with their buttons" bug; the previous
  per-GPU boot calibration was papering over it and got `dyn`/`rtt` wrong.)
* `CreatePlane` = XY quad, normal (0,0,-1), uv (0,0) at the bottom-left.
  Seen from -Z it is front-facing with u→right and v→up.

With that camera **no texture kind needs any flip**:

| Source | Storage | flip |
|---|---|---|
| Posters (`RenderTargetTexture`, or cached `RawTexture` invertY=false) | GL bottom-up | (0,0) |
| Badges / backdrops (`DynamicTexture`, `invertY` default true) | rows flipped at upload | (0,0) |
| Live preview (`RenderTargetTexture`) | GL bottom-up | (0,0) |

Depth convention in flat scenes (camera at -Z, smaller z = nearer):
backdrop `z=+2` · contact shadow `z=+0.5` · card `z=0` · badge `z=-0.05`.

Run `node scripts/orient.mjs` after ANY change to cameras, planes, UVs or the
card shader. It fails if a probe corner lands in the wrong place.

## Transparency contract

* `makeCardMaterial(scene, blend = true)` passes **`needAlphaBlending` as a
  ShaderMaterial OPTION**. `mat.needAlphaBlending()` is a getter — calling it
  does nothing, and that is why transparent posters used to sit in black
  rectangles. Backdrops pass `blend = false` so they draw in the opaque pass.
* Offscreen scenes (`PosterRenderer`, `PreviewPool`) must set
  `scene.autoClear = true` + `scene.clearColor = Color4(0,0,0,0)`. When
  rendering through `camera.outputRenderTarget` the **scene** owns the clear;
  `rtt.clearColor` alone never runs.

## Camera-policy contract

Posters and live previews render from the model's OWN camera when the GLB
ships one (first imported camera, or the v3 `preview-camera` index for live
previews) — the card must show the view the author framed. Auto-fit is the
fallback for models without a camera.

`frameDistance(min, max, center, forward, fovY, aspect, fill)` projects all 8
AABB corners into the camera basis and solves both frustum planes, so a wide
model fills a 16:10 card. `fitDistance` (sphere fit) is legacy — it framed a
wide sign as a postage stamp. `dominantFacing` picks the thin axis for flat
models, signs it with authored normals, and falls back to **+axis** for closed
shapes (measured with `test/facing.ts`: the negative side renders wordmarks
mirrored).

## Engine traps (do not re-learn these)

See `AGENTS.md` rules + `docs/SPEC.md` §TRAPS + AMENDMENTS. The big ones:
offscreen renders must use `scene.render()` (not `rtt.render()`); no IBL;
posters always auto-fit; `whenReadyAsync()` hangs on a never-rendered scene;
nostr-tools `SimplePool.subscribeMany` is broken (use `Relay`).
