# STATUS — task board for agents

Claim a task by moving it to **In progress** with your name/date, push, then
move it to **Done** with a commit reference. One agent per area.

## Done
- [x] **Merge pass + image-as-plane feature** (agent arena, 2026-08-24,
      SPEC AMENDMENTS 90–92): surveyed all 60 unmerged agent branches;
      most were already absorbed into main. Merged the four still-valuable
      ones — (a) preview-pool RTT hasAlpha+samples fix (01a0266f-f0), (b)
      3D board/thread cell clip planes + 2D→3D toggle settle-gate fix
      (01a02667-f0), (c) dead-code cleanup (01a023bb-f0: `dpr()`, legacy
      settings loaders, card-flip escape hatch, paint math/store helpers,
      re-exports — ~250 lines), (d) positional post audio (01a01d04-f0:
      the branch's 1500-line HTMLMediaElement player was superseded by
      main's Babylon-Sound stack, so the FEATURE was ported as a ~250-line
      `src/audio/spatial.ts` — HRTF panners anchored at the real card
      positions, node-attached in 3D/viewer, listener bound to the active
      camera, hand-off pairing preserved). Did NOT merge: design mockup
      branches, the site build, and the old dev-rewrite (size/obsolete).
      New feature: **studio image tab** — upload PNG/JPG/WebP → flat
      double-sided unlit textured plane (2048 px long-side cap), select/
      transform/delete like any studio object, exports a textured GLB
      (KHR_materials_unlit exporter registration added). Guards:
      `check:spatial-unit`, `check:image-unit`, `image-plane` e2e suite
      (upload → GLB structure → delete). Full gate green: check:static
      (standalone 5.16 MB), check:unit (15 files), check:e2e (5 suites).
- [x] **Hostile-rig security hardening** (agent arena, 2026-08-22, SPEC
      AMENDMENT 89): a local MALICIOUS relay + Blossom + model server
      (`scripts/hostile-rig.mjs`) driven by a real-browser harness
      (`scripts/hostile-audit.mjs`, 22 attacks) found and the following were
      fixed: binary WS frame → uncaught TypeError in nostr-tools (guarded at
      the socket boundary, socket closed); 45 MiB WS frame → main-thread
      JSON.parse freeze (frames > 512 KiB dropped + socket closed); event
      flood → verify-worker backlog spilled secp256k1 onto the main thread
      (8.3 s measured) → verify now fails closed on timeout/queue overflow
      + per-relay token bucket; unbounded ThreadIndex → 20k cap with O(1)
      FIFO eviction; 200k-tag event → maxEventTags 1000; 400 slow replica
      URLs → replicasPerPost 3; gzip bomb → streaming inflate with a hard
      cap; OOB INDICES bufferView → validateGLB range-checks every view +
      accessor; 1e308 node transforms → finite/≤1e6 check; malicious
      MSFT_audio_emitter (4 GB header over 1 KiB buffer → unhandled decode
      pageerror; 15 MiB silent decode bomb) → audio validated up front,
      8 MiB budget; hostile Blossom upload response (20 MiB JSON / 2 MiB url
      into the published event) → 16 KiB body + 2048-char url caps; 5000-reply
      thread open (5 meshes + poster per reply) → thread renders root +
      newest ≤ 120 nodes + a "+N more" card; corrupt DRACO → 4 MiB
      compressed-payload cap. Not exploitable: DOM XSS (all sinks are
      textContent + locked CSP), deep JSON (contained by nostr-tools),
      reconnect flood (designed backoff, no socket leak). Final hostile
      re-run: all 22 attacks benign (hostile relays lose their sockets,
      floods index ~300/3000–5000 with no freeze, URL storm tries 3 of 400
      replicas, bomb inflates ≤ 20 MiB then hash-rejected, hostile GLBs
      refused pre-Babylon). Canonical gate (static + unit + e2e) green;
      all 66 library GLBs still pass the hardened validateGLB.
- [x] **Library palette texture + low-poly ball faces + voxel art** (agent
- [x] **Board 3D toggle reuses 2D loads** (agent arena, 2026-08-21, SPEC
      AMENDMENT 88): live previews hand off into Direct3DPool.adopt; posters
      stay as placeholders. Guard: `bun scripts/direct3d-unit.mjs`.
- [x] **Library palette texture + low-poly ball faces + voxel art** (agent)
      arena, 2026-08-21, SPEC AMENDMENT 86): colour left the vertices. All 61
      generated library pieces now sample ONE embedded 32x32 palette PNG
      (`scripts/palette.py`, 64 curated swatches, 4x4 px each, NEAREST) through
      a per-vertex UV — no COLOR_0, same bytes, one art direction, and a real
      textured PBR material the tint/poster/export paths already handle.
      Colours are authored as palette names; a stray literal snaps and the
      build fails past 0.12. The smileys are gone: faces are low-poly BALLS
      (subdivided icosahedra + flat palette patches laid on the surface), and a
      new **voxel** group ships greedy-meshed cube art — invader, ghost, creep,
      grassblock, snake, sword, pixheart. Manifest gained `front` (authored
      facing +Z) so the studio stops guessing from `dim`.
      Two real bugs fell out: `byteStride` was on the ACCESSOR (glTF has no
      such field) so every loader read the padded NORMAL/TEXCOORD streams
      tightly packed — shifted normals for the whole library and UVs that tiled
      the palette into stripes; and the symbols picker leaked the studio accent
      into an untinted selection, silently tinting the next piece placed (it
      defaults to white now: palette as authored, tint still one click away).
      Guards: `node scripts/library-unit.mjs` (palette embedded/NEAREST/bound/
      tiny, faces 3d, voxel group, `front` flags), `npm run check:symbols`
      (green in headless Chromium, palette texture bound), new
      `node scripts/library-shot.mjs` (places pieces in the real studio and
      screenshots), `python3 scripts/preview-library.py` contact sheet. Full
      gate green: check:static + check:unit (13 files) + check:e2e (4 suites).
      Library 142 KiB after Draco; standalone 5.11 → 5.15 MB.
- [x] **Viewer: essential fixes vs Sketchfab/Babylon** (agent arena, 2026-08-21,
      SPEC AMENDMENT 87): authored cameras now SEED the orbit (author's
      position + fov, pivot on the authored forward ray) instead of a frozen
      control-less frame — fully navigable, dot = snap back, A = auto-fit.
      Near plane adapts per frame (10% of camera→AABB distance) so close-ups
      of small parts no longer slice (minZ could exceed lowerRadiusLimit).
      F/fit-button re-frames the current mode AND kills residual orbit
      inertia (a frozen glide used to drag the re-framed pose off). Speed 0
      (freeze) reachable in the HUD. Model audio: claimed on adopt, S key /
      sound button toggle (paused by default), hand-off TRANSFERS the sounds
      to the viewer scene (commit() spares moved sounds; failed hand-off
      disposes leftovers + rollback excludes them). Viewer obeys
      autoplayAnimations/reduceMotion (was hard-coded play).
      loadFromContainer throws on a mis-bound container (used to silently
      commit the slot → blank viewer). "N / M" feed position next to
      prev/next. Rig flavour 'a' carries a WAV beep (MSFT_audio_emitter) so
      the audio path is testable offline. Out of scope by decision:
      metadata/labels, camera tweens, auto-rotate, share, screenshot.
      Guard: scripts/viewer.mjs (24 checks, all green) + full `bun run check`
      gate. Research: docs/VIEWER-RESEARCH.md.
- [x] **Export codec lossy preview + fine settings** (agent arena, 2026-08-21,
      SPEC AMENDMENT 85): the review renders the exact compressed bytes
      through the card pipeline beside the raw export with a pixel-difference
      readout, and exposes `geometry bits` presets (14/12/10) + a `texture
      quality` slider (50–100%). Derives queue instead of swallowing clicks.
      Guards extended: check:codec (37 units) + check:codec-browser.
- [x] **Studio GLB export review, download, and compression** (agents arena,
      2026-08-21, SPEC AMENDMENT 84): the review is a frozen, validated
      snapshot — exact bytes for download AND publish, invalidated by any
      studio edit. Codec encoders are now real: geometry `draco`
      (KHR_draco_mesh_compression via Babylon's bundled encoder wasm, probe-
      gated control) and textures `webp` (EXT_texture_webp via canvas). A
      choice re-derives from the same pristine export and must re-pass
      validateGLB before it becomes the reviewed bytes; gainless passes keep
      the original (never grows). Text export compresses ~13× (46 KiB →
      3.5 KiB observed); the compressed post publishes, re-downloads
      SHA-verified, and renders in the viewer/posters. Also fixed in review:
      mid-upload cancel was dead (review handler swallowed the button), and
      the first poster of a texture-bearing post rendered blank (texture not
      yet decoded — one whenReadyAsync before the render loop). Guards:
      `bun scripts/codec-unit.mjs`, `node scripts/codec-browser.mjs`
      (rig), `scripts/verify-publish.mjs` repaired to the AMENDMENT-66/69
      studio + review flow (fully green after main's poster frustum fix).
      Standalone +570 KB (encoder inlined).
- [x] **3D view bugs from arena/01a02366-f0, kept short** (agent arena, 2026-08-21,
      SPEC AMENDMENT 81): empty `__root__` meshes no longer stretch every fit
      to the origin (specks); overlay materials ignore depth so 3D models
      cannot cover ▶/↩; Direct3DPool `hasWork` keeps drawing while shaders
      compile (blank cards on a settled board); clip planes crop close-ups
      to the card; scale lives on the root (off-origin drift); `dispose()`
      recurses (orient/fit leaked); loader-started anims are stopped so the
      pool owns play/pause; contact shadow follows the real footprint.
      Did NOT take the 357-line per-mesh frustum rewrite.

- [x] **One preview/3D pool across board + thread** (agent arena, 2026-08-21,
      SPEC AMENDMENT 80): `LivePool` owns the single PreviewPool stage (one
      scene, one RTT set) and the per-scene Direct3D pools. `activate(view)`
      keeps preview RTTs across board↔thread hops (request() rebinds via
      onLive; the incoming view evicts what it cannot see) and for viewer
      acquire() hand-off; studio drops everything. Inactive views must not
      request or release the shared pool (a resize/onLoadDone used to steal
      slots). Graphics registers the stage once. tsc clean.

- [x] **Shorter board/thread + audit** (agent arena, 2026-08-21): extracted shared
      `cardFade` / `playIntent` / `overlays` so board and thread no longer each
      own a copy of the 120 ms crossfade, ▶/⏸ intent, and glass-pill drawing
      (the class of bug that produced the all-white-card regression in one
      viewport). PreviewPool now un-cancels an in-flight load on scroll-back
      (parity with Direct3DPool). Audit: `docs/AUDIT.md`. tsc clean.

- [x] **Page zoom stretched / softened 3D content** (agent arena, 2026-08-21,
      SPEC AMENDMENT 79): zooming the page left the drawing buffer at the
      device pixel ratio sampled at boot — `FormEngine.resize()` re-read the
      CSS box but kept `hardwareScalingLevel` — so the browser upscaled a
      stale frame over the new box (soft, and stretched wherever a view held
      a cached frustum). A reload appeared to fix it, so it looked
      intermittent. `resize()` now re-runs the whole resolution policy,
      devicePixelRatio is watched with a re-armed `(resolution: Xdppx)` media
      query (a second-monitor DPI change fires no resize event), and views
      re-measure through the new `engine.onViewportChange` instead of one
      hand-written handler that had never included the studio. Also fixed:
      `Studio.resize()` recomputes the ortho frustum (Babylon caches
      `orthoLeft/Right/Top/Bottom`, so studio ortho was frozen at its
      authored 1.6 aspect; the four duplicated copies of that math are now
      one `applyOrtho()`, which `syncCameraNode` had been skipping), and
      manual resolution with `aspectLock` off now LETTERBOXES the canvas
      instead of stretching a mismatched buffer to fill the window.
      Guard: `node scripts/zoom.mjs`.

- [x] **Studio left the board clickable** (agent arena, 2026-08-21, SPEC
      AMENDMENT 78): opening the studio left board-only topbar controls
      (search / shuffle / 3D / create) clickable over the editor, a live
      feed event re-bound cards pickable, and the studio camera attached
      at construction so it stole canvas pointers on the board. Now
      `body[data-mode=studio]` hides those controls, `Board.setInteractive`
      drops picking/drag while another view owns the canvas, and the
      studio camera attaches only in attach()/detach(). Guard:
      `node scripts/studio-open.mjs`.

- [x] **2D thread-open freeze** (agent arena, 2026-08-21, SPEC AMENDMENT 77):
      opening a reply tree with the cube toggle OFF hitch-froze after
      Direct-3D. `sync3D` no longer runs in 2D; `fit()` still puts the whole
      tree "in view", so posters now skip postage-stamp nodes (`nodeWorthTexture`),
      bind `peekPoster` instantly, trickle two getPoster jobs per pass, and
      cancel offscreen/tiny queued posters. Headless: 5-node tree opens in
      <1s with Direct3DPool empty and no >1.5s main-thread stall. Guards:
      `bun scripts/thread-open-unit.mjs` + `node scripts/thread-open.mjs`.

- [x] **Cards/nodes can't paint over their own buttons** (agent arena,
      2026-08-20, SPEC AMENDMENT 76): a board card's reply badge / play
      button (and a thread node's reply pill / play button) could be drawn
      over by the post itself. Babylon sorts transparent meshes by their
      bounding-sphere center's distance to the camera, so a corner-mounted
      button on a screen-centered card sorted BEHIND its own card and was
      painted over wherever the post's opaque pixels reached the corner.
      Overlays now render in renderingGroupId 1 (after group 0 =
      cards/nodes/backdrop), so they are always on top. Guard:
      `scripts/overlay-order.mjs`.


- [x] **Direct-3D cards bugfix** (agent arena, 2026-08-21, SPEC AMENDMENT 77,
      absorbs PR #38): the AMENDMENT 75 toggle rendered real GLBs but shipped
      several bugs. `release()` of a still-loading post now cancels (same as
      PreviewPool) instead of dropping the id from `loading` — a parse can no
      longer land on a recycled card; scroll-back un-cancels. A full pool is
      not a failure: capacity misses retry every visibility pass instead of
      latching `slot.failed` onto the poster forever. Eviction uses the
      caller's fresh visible set (board now ticks the pool). Thread 3D loads
      only near the viewport. Imported GLB lights/cameras are disabled and
      the leftover board dummy hemi is too (no double-lit PBR, no neighbour
      lighting). Models sit on the card plane (z=0, depth 0.4·min) with the
      contact shadow at z=1.9 in 3D so they do not clip the backdrop; overlays
      render in group 1; transparent cards disable depth write. A 2D poster
      requested before the 3D toggle is dropped via a mode-generation counter
      (no frozen poster over the live model). No-camera auto-fit uses the
      inverse of the poster's LookAt camera (no arbitrary 180° flip). In-flight
      loads land at the latest cell, not the request-time cell. FormEngine
      calls `beginFrame()`/`endFrame()` so `getDeltaTime()` is real and
      AnimationGroup.start() on 3D cards actually advances. Guard:
      `bun scripts/direct3d-unit.mjs`; tsc + vite clean.

- [x] **Viewer: multi-track animation rail** (agent arena, 2026-08-20):
      models with animations get a second rail above the toolbar — a track
      dropdown listing the GLB animation names (unnamed clips fall back to
      "track N"), a scrubbable timeline with a frame readout, stepped playback
      (whole-frame hold, no interpolation), direction (forward/reverse, both
      looping), and a speed select (0.25×–4×). Driven by
      `src/viewer/animator.ts` (TrackAnimator): the active group is started
      once then paused, and a manual per-render `goToFrame` clock advances it —
      Babylon's own clock cannot do stepped/reverse/scrub without restarting
      the group. NOTE: the animator measures wall time itself; FormEngine
      renders via its own RAF loop (not `engine.runRenderLoop`), so Babylon's
      `engine.getDeltaTime()` is always 0 there. `,`/`.` step one frame
      (pauses, wraps). Rail hides for trackless models. Guards:
      `scripts/anim-unit.mjs` (bun, NullEngine) + `scripts/anim-hud.mjs`
      (browser, dropdown/scrub/stepped/dir/speed round-trips + screenshots
      incl. light theme and phone viewport).

- [x] **Direct-3D cards: board + thread show posts as real models, toggled by
      a button** (agent arena, 2026-08-20, SPEC AMENDMENT 75): a topbar cube
      button (settings → Interface → "Show posts as 3D models", persisted,
      default OFF) renders posts as their real GLB meshes directly in the
      board and thread scenes instead of poster textures / render-to-texture.
      Framing follows AMENDMENT 43 — the model is rotated by inverse(main-
      camera rotation) so the flat camera sees the author's view; models
      without a camera auto-fit via dominant facing; uniform scale fits the
      oriented AABB into the card/node cell. `src/board/modelCard3d.ts`
      (Direct3DPool) loads models near the viewport, releases them on
      scroll/pan-away, animates them under the existing autoplay + per-card ▶
      gating (sound still needs the tap), claims embedded audio, and falls
      back to the poster pipeline when a 3D load fails; static models just
      render. Verified: tsc + vite + standalone builds clean; orient.mjs
      passes; a headless probe renders a local GLB through Direct3DPool
      (request → onPlaced → isLive → release); the toggle persists across
      reload with no page errors.

- [x] **Idle OOM: relay reconnect no longer stacks sockets** (agent arena,
      2026-08-20, SPEC AMENDMENT 73): leaving the tab open crashed after a
      long idle. Relays drop idle connections and background tabs get their
      WebSocket killed; each drop scheduled three retries (ws.onerror,
      ws.onclose, connect() reject) and `open()` built a new Relay without
      closing the previous one, so sockets + REQ subs grew without bound.
      Now: one in-flight open per URL, drop the previous socket before
      reconnecting, idempotent retry timer, 8s handshake timeout, verify-
      worker jobs time out at 8s. Live preview GLBs stay resident (already
      capped by settings; dropping them just re-parses). Guard:
      `scripts/relay-pool-unit.mjs`.
- [x] **Vertex colours render in view + post like in studio** (agent
      arena, 2026-08-20, SPEC AMENDMENT 74): two independent bugs shared
      the symptom. (1) Babylon's main-thread Draco decode
      (`numWorkers: 0`, the app's CSP-safe inline-wasm path) dropped the
      glTF accessor `normalized` flag that its WORKER path honours, so
      quantized u8 `COLOR_0` buffers arrived as raw 0–255 floats and the
      PBR viewer/poster rendered every library symbol (heart, cube, …) as
      a uniform white slab — pixel-verified. `src/model/draco.ts` now
      patches `decodeMeshToMeshDataAsync` to apply the same
      `gltfNormalizedOverride` the worker pool applies (idempotent if
      fixed upstream). (2) `bakeStamps` (studio paint) exported its
      bake-only material with a fixed 0.55 grey emissive: the studio
      StandardMaterial preview clamps `diffuse+emissive` before
      multiplying vColor (saturated ink), but PBR adds `emissiveFactor`
      UNMODULATED, so published strokes washed to pastel in view/post.
      Bake emissive is now Black. Along the way: `scripts/studio-unit.mjs`
      could never finish headless — the studio's always-on HighlightLayer
      keeps `scene.isReady()` false on a NullEngine (nothing renders its
      RTT chain) and `GLTF2Export.GLBAsync` awaits `whenReadyAsync()`, an
      infinite poll (reproduced on unmodified sources under bun AND node);
      the harness now disposes the studio's effect layers up front and the
      suite is fully green (< 1 s, incl. the publish e2e) via
      `npm run check:studio`. Guards: `npm run check:vcolor`
      (viewer/poster/paint-through-publish render suites, driven through
      `scripts/browser.mjs` — playwright first, `@sparticuz/chromium`
      fallback; sandbox browser recipe recorded in
      docs/SANDBOX-VERIFY.md); proof shots
      `.test-shots/shot-draco-hea.png`, `.test-shots/shot-viewer-paint.png`;
      all unit suites (paint/load/hash/search/model-info/publish/library/
      studio) green; tsc + vite standalone/typecheck clean.

- [x] **Fresh posts can't race their own upload + E101 retry really
      retries** (agent arena, 2026-08-20, SPEC AMENDMENT 72): "uploaded
      bush twice, they always fail to load due hash or size mismatch —
      right after upload; old models show correctly". Root cause was NOT
      the Blossom API: a fresh post is fetched by the client seconds
      after its PUT (relay echo → board card poster render) while the
      blob can still be settling on the CDN; one bad first fetch called
      `failHash` and that mark was permanent for the session — nothing
      ever cleared it or re-attempted the download, so every later tap
      replayed E101 without network. Old posts never race their upload,
      so they were never marked. Now the publish seeds the verified
      upload snapshot BEFORE the post becomes fetchable (own posts never
      touch the network), failure marks are revocable (`AssetCache.unfail`
      + `ThreadIndex.unrejectHash`), and the E101 action actually retries
      (`retryModel`: clear marks, re-list card, re-download). The viewer
      also splits E101 (download/verify, with per-replica detail) from
      E102 (parse) honestly. Guards: load-unit retry checks + search-unit
      reject/unreject round trip; tsc + vite + standalone clean.

- [x] **Own posts load from the verified snapshot + E101 diagnostics**
      (agent arena, 2026-08-20, SPEC AMENDMENT 71): fresh uploads could
      still fail to load with E101 ("hash or size mismatch") — the load
      path re-downloads from the Blossom replicas and re-hashes, so a
      replica serving wrong bytes (or none) broke the author's OWN view.
      Now `publishModel` returns the frozen upload snapshot and the app
      seeds the verified model caches with it (`AssetCache.seedModelBytes`,
      hash-checked on the way in), so an own post opens from local bytes
      with zero network — replicas cannot break the author's view (the
      hash re-check still runs on every read, so poisoned seeds never
      reach Babylon). E101 is no longer a black box: downloads record
      every replica's outcome (server, HTTP status, hash mismatch with
      the sha256 it actually returned, over-cap, redirect/network) and the
      error sheet shows it; gzip bodies served without Content-Encoding
      get one inflate-and-re-hash rescue before the replica is abandoned.
      Guards: `bun scripts/load-unit.mjs` (12 checks: exact/truncated/
      gzip/404/oversize replicas, diagnostics, zero-network seeded read) +
      `studio-unit.mjs` snapshot check; tsc + vite + standalone clean.

- [x] **Search queries content + own posts self-index** (agent arena,
      2026-08-20, SPEC AMENDMENT 70): a published post was findable only
      through the relay echo — an upload followed by a search could show
      nothing ("uploaded bush.glb twice, query 'bush' shows none"), because
      the echo can lag or never arrive and the NIP-50 fallback cannot see
      posts a relay index has not ingested yet. Now the filter matches the
      post `content` (the model name, AMENDMENT 66) alongside filename /
      base name / event id (`matchesSearchQuery`, thread-index.ts), and a
      publish is **self-indexed** from the signed event the moment it
      succeeds — no echo dependency, instant board + search hit. The
      owned-post record also persists a bounded, validated meta snapshot
      (`OwnedPostMeta` + `ownedToMeta`), so boot restores this browser's own
      posts even after the live feed's window (14 days / limit) drops them;
      records marked tombstoned at delete time (doDelete + relayed kind-5s)
      are skipped, so deletion still hides permanently. The search panel now
      advertises "name or content" (placeholder/hint/legend) and the hint
      count live-updates as remote/restored results stream in. Guards:
      `bun scripts/search-unit.mjs` (filter semantics, snapshot rebuild,
      tombstone persistence) + extended `studio-unit.mjs` publish checks;
      tsc + vite + standalone builds clean.

- [x] **Library symbols load (CSP Draco fix) + tint behaves like text**
      (agent arena, 2026-08-20, SPEC AMENDMENT 68): the whole symbol library
      silently failed to load in both builds — the local Draco decoder's wasm
      (`WebAssembly.instantiate`) was refused by CSP because neither policy
      had `'wasm-unsafe-eval'` (uploads showed “…Refused to compile or
      instantiate WebAssembly module… unsafe-inline…”). Both CSPs now carry
      the keyword (wasm compile only — no string eval) and WEB_CSP allows
      localhost http for dev/preview fetches. Placement errors now surface
      in the studio status line instead of the console. Placed symbols also
      re-tinted: they clear `useVertexColors`/`hasVertexAlpha` (the VEC4
      COLOR_0 vertex-colour path that rendered BLACK) and take the studio
      accent exactly like text (emissive tint over a black base), re-tint
      live on colour change, and publish the tint via the event `color` tag.
      Library size stays ~103 KiB; standalone ~4.4 MB. Verified in a real
      headless Chromium (standalone file:// and web build via vite preview):
      tsc, library-unit, `npm run check:symbols` (place cube/smile → tinted
      render on screen, not black; live re-tint; delete; upload-as-mesh
      imports the same GLB; no CSP violations, no CDN requests). Checks that
      need live relays (verify-publish etc.) are noted but not runnable in
      this sandbox.

- [x] **Studio model info + nostr `content` carries the model name + removable
      studio additions** (agent arena, 2026-08-20, SPEC AMENDMENT 66):
      - The studio upload tab shows an info card for the imported model
        (name, format, size, vertices, triangles, meshes/parts, materials,
        textures, texture memory, cameras, lights, skins, animations — from
        the safety-scan report). The size number + meter run green → red
        toward the 20 MiB hard limit; big (≥8 MiB) and near-limit (≥70% of
        any cap) models warn in amber, and refused models still fail import
        in red.
      - `publishModel` stamps the model name into the event `content`
        (`modelNameForPublish`: file base name, or the first typed line for
        a text post; single line, ≤ 140 chars). `parseModelEvent` accepts
        ≤140-char content onto `ThreadMeta.name` (searchable, shown in the
        info drawer) and keeps accepting legacy empty content.
      - Empty text never adds text to a model: the '/0' seed is skipped when
        a model is imported, no-op rebuilds don't dirty, stale text meshes
        are dropped at publish.
      - Byte-identity: text/paint/camera additions are observable state, so
        removing them restores the byte-for-byte pass-through by itself;
        gizmo moves/mesh deletes set a sticky `meshEdits` flag. The upload
        tab's "remove additions" button re-imports the pristine bytes,
        reverting even moves — the model publishes bit-identical again.
      - Guards: `scripts/model-info-unit.mjs`,
        `scripts/studio-unit.mjs` (pass-through + reset + publishModel
        content/upload byte-identity end-to-end), and verify-publish asserts
        `meta.name` on received posts. Verified (no browser in this sandbox):
        tsc, vite build, build:standalone, all headless unit suites green;
        browser scripts (verify-publish etc.) updated but runnable only on a
        machine with playwright's chromium.

- [x] **Studio symbol library — 2D + 3D low-poly GLBs** (agent arena,
      2026-08-20, SPEC AMENDMENT 67): the symbols tab is enabled with 54
      self-contained low-poly pieces (faces / reactions / statuses /
      primitives / objects). Clicking a cell ADDS the mesh without clearing
      an import; 2D plates keep flat and face the orbit camera; faces are
      CCW / outward so lighting cannot invert; no cameras/textures/skins/
      animations. GLBs are quantized (`KHR_mesh_quantization`); Draco only
      when it shrinks the file (56 pieces ≈ 103 KiB). Source PNGs are NOT
      committed — regenerate 2D plates via `scripts/trace-2d-glb.py`.
      Guard: `node scripts/library-unit.mjs`.

- [x] **Posters render to a transparent RTT, never a PNG** (agent arena, 2026-08-19,
      SPEC AMENDMENT 65): each post gets its own transparent RenderTargetTexture
      (detached after capture). No PNG, no pixel cache, no blank-check retry —
      cards sample the RTT in place. Camera fallback is a frustum-vs-AABB test.
      Opaque materials write alpha=1; card shader treats non-black RGB as coverage.
      Studio/tests take one `snapshot()` readback. IDB keeps anim/footprint only.

- [x] **Search models by name** (agent arena, 2026-08-19): a search menu
      (magnifier button in the topbar → overlay panel) filters the board by
      model name. Matching is a case-insensitive substring over the model's
      published filename, its base name (extension stripped), its event id
      and — since AMENDMENT 66/70 — its `content` (the model name), so older
      posts without a `filename` tag are still findable. The board
      re-filters live as you type; a `shown N models for "…"` hint and an
      accent-highlighted search button reflect the active filter. It is an
      overlay like `#/network` — it leaves the view behind it mounted and
      returns to it on close (X / Escape / re-tap). **NIP-50 remote fallback:**
      after the instant local filter (debounced 400 ms, ≥3 chars), it also
      opens a NIP-50 `{ search }` REQ on nostr.band (`RelayPool.search()`) to
      fetch UNLOADED remote models (older than the live feed's 14-day / limit
      window) and feeds them back through `onEvent` into the index; queries
      are superseded/cancelled as you type. Best-effort: nostr.band matches
      relay-defined text indexes and FORM/0 events carry empty content (name
      lives in the `filename` tag), so reliability is index-dependent. Verified:
      `tsc --noEmit` clean + `vite build` clean.

- [x] **Wrong-hash / wrong-size models still render** (agent arena, 2026-08-20,
      SPEC AMENDMENT 64): verify on LOAD, rebased onto format v4. `getModel`/
      `getModelBytes` re-hash every RAM/IDB hit (poisoned cache → del +
      redownload, not failHash). Blossom download hashes always — size is
      cap+meter; hash-valid bodies with a stale size tag are accepted.
      Format v4 already forces every plate through a local render, so a
      remote thumb cannot skip the GLB hash. `onHashFailed` drops the board
      card AND the thread node. `flatten`/`open` skip hashFailed.
      `validateGLBCached` is keyed by the actual bytes, not the claimed sha.
      Guard: `scripts/hash-unit.mjs` + `scripts/verify-hash.mjs`.

- [x] **Studio card preview + full-page resizable preview** (agent arena,
      2026-08-20, SPEC AMENDMENT 63): the studio's upper-left corner shows
      a live card preview (local poster render of the current content,
      debounced on studio.onDirty); click hides it with a "◱ card" pill to
      reveal, ⤢ opens a full page where the card sits on a drag-resizable
      canvas (dim limits enforced). The chosen size is published as `dim`.
      Verified: ad-hoc Playwright round-trip (paint, hide/reveal, resize
      448x280→560x280 with the aspect cap, publish carries `dim=560x280`)
      plus verify-publish, offline-verify (tap moved past the new HUD),
      smoke, interact, features, transfer, settings, network-panel green;
      tsc, vite build and build:standalone green.

- [x] **Offline rig: seed id collision shrunk the feed to 51** (agent arena,
      2026-08-20): `makeEvent` stamped `created_at` from per-call
      `Date.now()`; GLB generation is slow enough that the clock can advance
      by exactly the `ageSec` delta between two same-flavour roots,
      producing IDENTICAL events (same id) — the app dedupes by id, so the
      52-event feed silently became 51 and every `>= 52` gate stalled.
      `created_at` now derives from one `BOOT_NOW` captured at module load
      (strictly monotonic ageSec), and the rig loudly reports any seed
      duplicate at boot. Full format-v4 verification on the rig (this
      sandbox, SwiftShader): verify-publish, offline-verify, smoke,
      features, interact, orient, transfer, settings, network-panel — all
      green; build:standalone emits the single 4.21 MB file.

- [x] **Studio publish generates no poster** (agent arena, 2026-08-20, SPEC
      AMENDMENT 62 follow-up): the publish flow's local poster render (the
      "poster…" stage that validated the model and derived `dim`) is gone —
      the studio stamps the default render size (448x280) into `dim` and
      uploads only the model. Posters exist solely as on-demand local
      renders by whoever views a card; `renderPosterFor` stays as a
      pipeline probe for the verification rig's camera-policy pixel check.

- [x] **Post format v4: local-only posters + `dim` (width/height) in the
      event** (agent arena, 2026-08-20, SPEC AMENDMENT 62): removed the
      thumb PNG tags from kind-1063 — posters are now ONLY rendered locally
      from the model, sized by the new `dim` (`WxH`) tag; publish uploads
      the model GLB alone. The board and the thread map size their card /
      node quads from each post's declared aspect (band layout centres
      shorter cards in a row). Old v3 events parse unchanged (default
      448x280). Guard: `parsePosterDim` unit checks + updated
      `offline-rig`/`verify-publish` (format v4 seeds, `dim` assertion).

- [x] **Cancel publish + hash integrity** (agent arena, 2026-08-19, SPEC
      AMENDMENT 58): publish button stays enabled as **cancel** and aborts
      in-flight Blossom PUTs; the studio freezes before export and
      `freezeBlob()` snapshots the bytes so editing cannot tear the hash;
      cache/download re-verify SHA-256 and hide `hashFailed` cards from
      the board. Guard: `scripts/publish-unit.mjs` + verify-publish cancel
      / wrong-hash cases.

- [x] **Model cache keyed by content, not post** (agent arena, 2026-08-19,
      SPEC AMENDMENT 59): `AssetCache.getModel()` cached downloads and
      in-flight dedup by `eventId`, so the same GLB embedded in several posts
      (or a poster render racing a preview) was downloaded once per post.
      Switched both maps to key by `sha256` — one model, one download.
      Verified on the offline rig (17 concurrent same-sha requests → one
      `/models/*.glb` fetch) plus smoke, transfer, features and shaders.

- [x] **Build fix: duplicated board.ts tail from PR #13** (agent arena,
      2026-08-19, SPEC AMENDMENT 60): the board-tap change left a mangled
      duplicate of the `resize()` tail + a second `dispose()` after the
      `Board` class closed, breaking `tsc --noEmit` and the Pages deploy.
      Removed the duplicated fragment; board.ts ends at the single
      `dispose()` + class brace.

- [x] **Hash-failure wiring completed** (agent arena, 2026-08-19, SPEC
      AMENDMENT 61): AMENDMENT 58's `failHash`/`hashFailed`/`onHashFailed`
      plumbing was never called from `getModel()`, so wrong-hash models
      still rendered and `verify-publish` failed. `getModel()` now
      re-verifies IndexedDB cache hits and records download hash
      mismatches; network failures stay retryable. `scripts/verify-publish.mjs`
      is green again (wrong-hash card hidden, flagged + cache both true).

- [x] **Descriptive per-server network status: ping + per-server speeds**
      (agent arena, 2026-08-18, SPEC AMENDMENT 57): network-panel rows now
      show a worded status (`connected` / `connecting…` / `offline · retry N`
      / `not probed` / `probing…` / `reachable` / `unreachable`), a bucketed
      round-trip ping (relay REQ->EOSE on the live socket, Blossom HEAD with
      `no-store`), and that server's OWN download/upload rate — session
      totals when idle. Relays show events delivered instead of bytes.
      `transfers.track()` gained a host origin and a per-host meter;
      `RelayPool` gained `info()`, `ping()`, `pingAll()` and per-relay event
      counts; both probes return `{ ok, ms }`. Also fixed a long-standing
      silent bug: `--danger` existed only in the light theme, so the offline
      dot (and `.studio-status.err`, `.hbtn.danger`, remove-hover) had no
      colour in the dark theme. Verified: transfer.mjs (25), offline-verify
      (39), network-panel (16), verify-publish, settings, interact, smoke,
      orient, perf (idleBoard still 0 rps).

- [x] **Network panel closes back to the current page** (agent arena,
      2026-08-18, SPEC AMENDMENT 56): `#/network` no longer forces
      `setMode('board')`, so the panel draws over the viewer / thread /
      studio instead of destroying them, and closing it (X, Escape, route
      callback) returns to the route it was opened from. The return path only
      rewrites the hash (`skipNextApply`) so the studio's imported model and
      the viewer's loaded meshes survive. Verified by the new
      `scripts/network-panel.mjs` (16 checks) plus offline-verify (40),
      verify-publish, transfer, interact, settings, smoke, features, orient.

- [x] **Network button hit target + live download/upload speeds**
      (agent arena, 2026-08-18, SPEC AMENDMENT 55):
      - The topbar network control is a real 42x42 button (was an 8x8 dot —
        ~1/24th of the recommended touch target). The state dot is now a
        `::before` tinted via `--dot`; hover/active/focus affordances added.
      - New `src/core/transfer.ts`: one app-wide transfer meter (2s sliding
        window, 200ms tick, idle-stops) fed by every Blossom download and
        upload.
      - Loading overlay shows `↓ 4.2 MiB/s · 9.7/18 MiB · 54%` per direction
        plus a determinate bar; topbar shows a compact rate + a pulse ring on
        the network button; studio publish shows the live upload rate;
        network panel gained a TRAFFIC section (live rows, session totals).
      - `BlossomClient.upload` switched from `fetch` to XHR so upload
        progress exists at all (`fetch` has no request-body progress).
      - Verified: `scripts/transfer.mjs` (13 checks, new), offline-verify
        (39), verify-publish (7, covers the new XHR upload), orient,
        interact, settings, smoke, features, shaders, pages, memcheck, perf
        (`idleBoard.rendersPerSec` still 0 — the meter's ticker only runs
        during transfers).

- [x] **Preview resolution scales with camera zoom + hotkey typing guard**
      (agent arena, 2026-08-19, SPEC AMENDMENTS 52+53):
      - Thread-map live preview RTTs scale with the map camera zoom
        (ThreadView.applyPreviewScale: effective width = previewWidth/zoom,
        clamped 64-2048 px, 32 px snap). Zoomed in → sharper previews;
        zoomed out → cheaper. No GLB re-parse on zoom (setRttSize +
        onResize rebind).
      - Thread map zoom UI added: + / - / fit cluster in the topbar (only
        in thread mode) + + - = _ hotkeys; wheel/pinch still work.
      - Window keydown typing guard: INPUT/TEXTAREA/SELECT/contenteditable
        focus blocks game hotkeys (arrow keys were switching models while
        editing the preview width in settings). Escape for error
        sheet/network panel stays first.
      - Hand-off parity: handoffContainer now clones authored cameras and
        lights into viewer.scene too (instantiateModelsToScene doesn't),
        so the viewer's camera dots and authored framing match the
        byte-loading path.

- [x] **Settings: arbitrary preview width + viewer hand-off from live preview**
      (agent arena, 2026-08-18, SPEC AMENDMENTS 50+51):
      - `previewQuality` (select, 4 presets 224/320/448/640 px) renamed to
        `previewWidth` (slider, 32-4096 px, default 448, step 1). Height
        is derived from the 16:10 poster aspect. PreviewPool.setRttSize
        rebuilds every slot's RTT in place; a new `onResize` callback
        tells the board/thread to swap the card material's texture handle
        immediately (no fade). Preset keys still recommend the same
        widths, so picking a tier is unchanged.
      - Viewer's `openViewer` now hands off the live preview's parsed
        container to `viewer.loadFromContainer` when the user opens a
        currently-animating card. New helper `handoffContainer` (in
        `src/core/sceneTransfer.ts`) clones meshes/materials/skeletons/
        animationGroups into viewer.scene via Babylon's
        `instantiateModelsToScene(nameFn, /*cloneMaterials*/ true)` and
        disposes the source; PreviewPool.acquire() preserves the parsed
        container for the viewer. Hand-off bypasses LoadAssetContainerAsync
        entirely, AND skips the "loading model" flash since the model is
        already on screen. Falls through to the bytes path if the hand-off
        fails. The pool's staging offset (+800*N per slot) is subtracted
        so the model lands at the origin in viewer.scene.
      - Verification: `bun run build` clean (tsc strict + vite build), all
        new types resolve, no regressions to the existing viewer/poster
        pipeline (previewQuality consumed by ZERO call sites prior — it
        was a dead setting).

- [x] **Bugfix round 2 — audit + REGRESSIONS.txt, all verified headlessly**
      (agent arena, 2026-08-18, SPEC AMENDMENT 49, docs/SANDBOX-VERIFY.md):
      - THE live-preview root cause found and fixed: the pool never called
        `container.addAllToScene()` — live RTTs had been blank forever
        (pixel-verified now: live slots show the model).
      - `preview-camera` plumbing actually wired (assets -> pool field),
        pixel check: preview-camera=1 animates GREEN not red.
      - Authored-camera slot copy force-recomputes the parent chain (the
        800-unit slot offset was missing from the camera pose).
      - Real two-texture crossfade (shader blends tex/tex2) + the blend
        uniform now resets on completion (all-white-card regression).
      - POSTER_CACHE_V p4, blank-authored-camera -> auto-fit fallback,
        cancellable pending loads, pool prune on thread detach, studio
        look-at/fit drive the ACTIVE camera, publish waits for the relay
        echo before routing (delete button arm race), and the whole
        REGRESSIONS.txt UI list (upload tab, close X, toolbar in the
        inspector foot, collapsed camera panel, disabled paint/symbols,
        SVG rail glyphs, 22vh portrait inspector, consolidated studio CSS,
        aspect-aware viewer spotlight).
      - Verification: 39 offline-verify checks + 11 publish checks green on
        the dev AND the production preview builds; orient/interact/
        settings/smoke/features/pages/shaders/facing/memcheck green. The
        rig now resets its feed per run, proxies gzip HTML correctly, and
        injects the relay hook CSP-aware (inline for the standalone CSP).

- [x] **Feed/tree/studio bugfix round** (agent arena, 2026-08-18, SPEC
      AMENDMENT 48):
      - Posters and live previews render from the model's authored camera
        when it has one (auto-fit only as fallback); AMENDMENT 6's
        "ALWAYS auto-fit" wording corrected.
      - Live-preview pool reuses released slots + evicts offscreen ones
        (before: only the first N cards of a feed could ever animate, and
        STATIC rejection leaked the container).
      - Thread map animates its nodes via the same pool (was static posters
        only).
      - 120ms plate→poster→live crossfade in feed + tree (SPEC CARD
        crossfade had never been implemented; loading cards flashed black).
      - Studio no longer auto-frames the camera on import; added look-at
        average origin / look-at bounding-box center / fit-selected buttons.
      - Studio stage/topbar no longer intercept pointer events — gizmos
        above the W/E/R toolbar are pressable again.
      - Headless verification (see docs/SANDBOX-VERIFY.md — Chromium obtained
        from the npm registry because every browser CDN/apt/relay is blocked
        in this sandbox; scripts/offline-rig.mjs serves a local wss relay +
        models through a CSP-safe proxy; scripts/offline-verify.mjs has 25
        deterministic checks, all green, plus orient/interact/settings/
        smoke/features/pages suites green against the rig, on BOTH the dev
        and the production preview builds). The verification round caught
        and fixed two more pool bugs: the runtime-null
        `rotationQuaternion` crash for camera'd models, and the stale
        `slot.visible` eviction deadlock/churn.
      - Publish round-trip verified on the rig (scripts/verify-publish.mjs,
        11 checks green): export → poster (pixel-checked authored camera) →
        Blossom upload → relay OK → live feed event → SHA-verified
        re-download → kind-5 delete → live tombstone. Perf gates hold
        (static board 0 renders/s, flat heap, +0 shader recompiles); p95
        numbers are environment-bound here (see docs/SANDBOX-VERIFY.md).

- [x] **Branch integration + remaining security hardening** (agent arena,
      2026-08-17). Merged the sidecar-import work and then synced main's
      integrated studio-tools PR. Closed the audit's two open findings:
      per-post deletion keys are AES-256-GCM envelopes under an atomically
      created non-extractable WebCrypto key (event-id AAD, v3 plaintext
      migration), and persisted settings are schema/type/range/allowlist
      validated and repaired. Hardened the merged importer: GLB
      validate-before-load restored; glTF/OBJ inputs are 20 MiB/128-file/
      complexity bounded and local sidecars only. Also closed the data-image
      VRAM bypass by validating data-URI MIME + dimensions and counting decoded
      bytes. `npm run build`, standalone build, `npm audit` and focused
      WebCrypto/settings/GLB guard regressions are green. See SPEC AMENDMENTS
      44–47 and `docs/SECURITY-AUDIT.md`.

- [x] **Studio tools merged (PR #4 + sidecar-import)** (merged by
      agent-kestrel, a087e13): Unifont TTF text geometry (replaces 5x7
      bitmap font), GizmoManager move/rotate/scale on a UtilityLayer with
      tap-select + deleteSelection, free-fly camera toggle, responsive
      rail (side landscape / bottom portrait), glTF sidecar (.gltf+.bin+
      images) and OBJ/MTL import re-exported to a single GLB. Both agent
      branches deleted after merge.

- [x] **Security audit fixes — external-URI GLB fetch, kind-5 author
      check, Blossom redirect/URL hardening, standalone CSP** (agent arena).
      See docs/SPEC.md AMENDMENTS 37–40. (1) validateGLB now rejects ANY
      non-data: `uri` (buffers/images/extensions) — Babylon fetches external
      URIs verbatim with no size cap or hash check, so a tiny signed post
      could crash tabs (unbounded download) or leak viewer IPs to a third
      party; also rejects non-finite vertex positions (they poison the
      auto-fit cameras). Verified with a 7-case Node test of validateGLB.
      (2) Incoming kind-5 events only tombstone posts whose pubkey matches
      the signer (NIP-09 author check — relays don't enforce it). (3) Blossom
      download uses redirect:'error' (spec "no cross-origin redirects") and
      upload URL responses are parse-validated. (4) csp.ts: the standalone
      build now ships STANDALONE_CSP (previously NONE — that is the GitHub
      Pages artifact); web build unchanged (WEB_CSP). `npm run build` +
      `build:standalone` green. Browser-level smoke (scripts/smoke.mjs) needs
      a Playwright browser download, blocked in this sandbox — re-run before
      shipping to confirm the standalone CSP does not break file:// boot.

- [x] **Deletion made discoverable + mirrors** (agent-kestrel). Deletion
      logic extracted to `src/protocol/deletion.ts` (DeletionService) with a
      file-header map of every piece (button, ownership store, tombstone) —
      another agent could not find it buried in main.ts. main.ts keeps only
      HUD wiring. CI now mirrors every build to the `site` branch, servable
      via jsDelivr / githack for users whose ISP filters *.github.io (README
      "Mirrors" section).

- [x] **Poster thumbs fixed + rebrand to game vocabulary** (agent-kestrel,
      branch kestrel/thumb-magic-and-rename). ROOT CAUSE of "posters for my
      uploads never work": BlossomClient.download() enforced the GLB magic
      on EVERY blob, so published poster PNGs downloaded fine and were then
      silently rejected (fetchThumb -> undefined -> blank card forever).
      download() now takes kind:'glb'|'png' and checks the matching magic;
      fetchThumb passes 'png' + a 2 MiB cap, and an unfetchable thumb falls
      back to a local render instead of a blank card. Also: PR #2 (typed
      low-poly text + camera settings) merged, GLTF2Export switched to a
      deep import (-30 KB). All project text now describes FORM/0 as a
      wordless multiplayer game of 3D shapes (see NAMING RULE in AGENTS.md).

- [x] **Deletion UI** (agent-kestrel, branch kestrel/deletion-ui). Viewer
      bar shows a red delete button ONLY for posts in the ownedPosts store
      (wordless UI: no dead controls). Tap -> D001 confirm sheet (kind-5 is
      a tombstone, not destruction) -> pool.publish(kind 5, ['e', id]) with
      the per-post secret -> immediate local index.tombstone + board refresh
      + relay-count toast + back to board. Newly published posts become
      deletable without a reload. Verified headless: hidden for foreign
      posts, visible for owned, confirm flow, tombstone + board removal
      (publish stubbed — no junk kind-5 sent to real relays).

- [x] **Instant scroll-return + animations survive reloads** (agent-kestrel,
      branch kestrel/instant-rebind). (1) bind() re-applies a RAM-cached
      poster texture synchronously (assets.peekPoster) instead of resetting
      the slot to placeholder+spinner and re-queueing an async job —
      scroll-back re-show measured 0.8ms (was ~500ms+: settle-gate 150ms +
      queue + IDB decode). Footprint/shadow restored in the same frame.
      (2) The 'animated' flag is persisted in the poster cache
      (:anim key) and restored by cachedPoster() — after a reload the app
      knew a cached poster but forgot the post animates (events carry no
      hint), so live previews were never requested again. Verified: warm
      reload spins the live slot up again. (3) isSettled(): a slow inertia
      glide counts as settled — the glide tail no longer delays loads ~1s.

- [x] **Thread map: per-node reply buttons** (agent-kestrel, branch
      kestrel/thread-reply-buttons). Every node carries a ↩+ pill
      (bottom-right, board-badge visual language; ONE shared DynamicTexture,
      repainted on theme change; per-node 4-vert plane). Pill tap wins over
      the card body (picked first via metadata.treply) and routes to
      #/studio?root=<rootId>&parent=<nodeId> — the reply targets the TAPPED
      node, enabling deep-thread replies (board badge only reaches the
      root's thread; viewer reply button only the open model). Card-body tap
      still opens the viewer. Legend copy updated. Verified headless:
      pill projection -> tap -> studio "replying…" with correct parent id,
      body tap -> viewer, smoke/features/standalone green.

- [x] **Studio publish flow (merged to main by agent-kestrel)**: BUD-01
      Blossom upload w/ Nostr auth, kind-1063 publish, ownership secrets in
      ownedPosts, reply authoring, studio import/publish HUD (branch
      agent/studio-publish, merge 91617ca). Preservation report + partial-
      success UI still open. NOTE for the studio agent: importGLB/clearModel/
      setBackground now must kick() (SPEC 17) — added during the merge.

- [x] **Performance: demand-driven rendering** (agent-kestrel, branch
      kestrel/perf). The RAF loop renders only when (a) input/content
      invalidated the picture (`FormEngine.kick()`, 300ms window, uncapped)
      or (b) a registered animation source reports motion (capped 30fps):
      board = live slots/spinners/scroll-inertia, viewer = playing animation
      or orbit-inertia glide, thread = spinners, studio = camera glide.
      Static scenes render ZERO frames (measured: 0 frames/3s static board
      AND paused viewer, was 100% GPU forever). Live preview RTTs refresh at
      20fps instead of per-frame. Adaptive resolution: sustained >45ms EMA
      frames step hardwareScaling down to 0.7x, sustained <18ms restores to
      devicePixelRatio (spec PERF adaptive degrade). `engine.perfStats()`
      exposes renders/EMA/ratio for tests. Measured on SwiftShader: idle
      renders 42→~40 anim-capped / 0 static, scroll p50 render 1.1ms,
      viewer paused 0 frames; smoke/features/standalone all green.

- [x] **First-run legend + Network panel + Error sheets** (agent-kestrel,
      2026-08-17, branch kestrel/legend-network-errors). Legend: modal on
      first run (seen-flag in IDB 'settings'), `?` reopens, Esc/OK close.
      Network panel: `#/network` route + net-dot button; add/remove/probe/
      reset relays & Blossom; live relay state dots; `RelayPool.applyRelays()`
      hot-swaps connections (onclose detached during teardown so the swap
      can't false-fire E201); `RelayPool.probe`/`BlossomClient.probe` one-shot
      checks; persisted via saveNetworkConfig. Error sheets (`src/hud/
      errorSheet.ts`): stable codes E101 download / E102 parse / E201 relays
      / E301 import, each code+cause+action, replaces bare toasts for model
      failures. Verified headless: /tmp-style HUD test + smoke + features +
      standalone. Test scripts dismiss the legend after boot.

- [x] Vite + TS skeleton, one canvas / one Engine, fatal path, router.
- [x] Relay pool + live feed (both filters: `#t form-zero` + `#m model/*`),
      per-relay state, reconnect backoff. (`protocol/nostr.ts`)
- [x] Blossom download + SHA-256 verify, replicas in order, stream cap.
      (`protocol/blossom.ts`)
- [x] Local poster pipeline: GLB → 512×320 PNG, cached by SHA-256, auto-fit.
      (`model/poster.ts`)
- [x] Board: responsive 1–3 column grid, 16:10 cards, placeholders → posters →
      live previews, scroll + inertia, reply badges. (`board/board.ts`)
- [x] PreviewSlotPool: bounded RTT slots, interleaved refresh, STATIC/FAILED
      rejection memory. (`board/previewPool.ts`)
- [x] Viewer: orbit + authored cameras (dots / C), play/pause (A), metadata
      drawer (M), download, prev/next, thread (T). (`viewer/viewer.ts`)
- [x] Thread view: 2D force-relaxed tree map, pan/zoom, tap→viewer.
      (`board/threadView.ts`)
- [x] HTML HUD + settings (background color + scroll inertia, persisted).
      (`index.html`, `src/style.css`, `src/main.ts`)
- [x] Draco local (no CDN), KTX2 CDN URLs blanked, GLB limits.
      (`model/draco.ts`, `model/offline.ts`, `model/limits.ts`)
- [x] Standalone single-file build + GitHub Pages via Actions.
      (`vite.standalone.config.ts`, `make-standalone.py`, `.github/workflows/`)
- [x] Visual pass + texture-flip root-cause (`test/orient2.ts`,
      `scripts/visual_critique.py`).
- [x] ~~Mirror fix round 2: per-kind boot calibration~~ **superseded** — the
      calibration guessed wrong for badges/live previews. Round 3 removed it.
- [x] **Mirror fix round 3 (root cause, done)**: flat scenes now use
      `core/gfx.flatCamera()` (ortho at -Z). Babylon is left-handed, so the old
      +Z camera showed every card quad from behind — mirrored posters, mirrored
      reply badges, reversed column order. Zero flips, zero calibration.
      Guarded by `test/orient2.ts` + `scripts/orient.mjs`.
- [x] **Transparent cards for real**: `needAlphaBlending` passed as a
      ShaderMaterial option (the code was calling the getter) + offscreen
      scenes clear with `autoClear=true, clearColor=(0,0,0,0)`.
- [x] **Crisp HUD**: inline SVG icons, vector-drawn reply arrow, engine renders
      at `devicePixelRatio` (was pinned to 1.0/1.25).
- [x] **Thread map**: pan drift fixed (per-event deltas via native pointer
      events), pinch zoom + two-finger pan, wheel zoom about the cursor, tidy
      tree layout with elbow connectors + node frames, fit-to-content, `0`
      re-fits. Guarded by `scripts/interact.mjs`.
- [x] **Auto-fit**: `frameDistance()` (aspect-aware, 8 AABB corners) so wide
      models fill the card; `dominantFacing()` rewritten (thin axis + authored
      normals + `+axis` fallback) so flat wordmarks are never viewed from
      behind. Measured with `test/facing.ts` / `scripts/facing.mjs`.
- [x] **Design pass 3**: measured contact shadows under each model, spotlight
      viewer backdrop (the old one sat behind the camera and leaked a white
      band), full-bleed row hairlines, glass toolbar rail with labels, light
      theme for the whole HUD, settings swatches actually show their colours.
- [x] Mockup pass: frameless transparent cards, separator lines between rows,
      reply tree constrained to a <90° cone (measured ~84°), ghost badges +
      glassy HUD. (commit 9dfda25)

- [x] **Loading indicator**: spinning ring of dots — HUD overlay (connecting /
      loading model / building thread) + per-card and per-thread-node rings
      while posters render. (`gfx.makeSpinnerTexture`, `#loading`)
- [x] **Viewer overlap fixed**: load tokens in `Viewer.load` + a `viewerNav`
      ticket in `main.ts`, plus a stale-mesh sweep in `clear()`. Racing
      navigations can no longer stack two models in the single-model view.
      Guard: `scripts/interact.mjs`.

- [x] **Performance pass** (`scripts/perf.mjs` is the harness; numbers are
      headless SwiftShader @1280x800, medians):
      render-on-demand engine (idle board 13.7 -> 2.3 renders/sec, ~80% of
      frames skipped), virtualised board slots (also fixes rows past the 24th
      never drawing), viewport+settle gated poster/preview work (48-card
      scroll 5.6 fps/p95 858 ms -> 12.4 fps/p95 147 ms), direct GPU->texture
      posters with one reusable RTT (all posters ~15 s -> ~8-11 s), per-slot
      preview FPS cap, model-blob LRU, pixel budget for hardware scaling,
      curated glTF loader (bundle 1617 -> 1411 kB, standalone 3.52 -> 3.17 MB,
      first card 2.08 s -> 1.22 s on the production build).
- [x] **Perf round merged with kestrel/perf** (2026-08-17): two agents worked
      the performance task in parallel (my fault — the task was claimed in
      STATUS and I did not check first). The merge keeps kestrel's engine
      (`kick()` + `addAnimationSource()` + adaptive resolution, which is the
      documented API now) and layers this branch's work on top: precise
      animation probes (motion only while a ring step / preview refresh is
      DUE), board virtualisation, viewport+settle gated loading with a
      pausable poster queue, the direct GPU->texture poster path, blob LRU,
      pixel budget on the target ratio, and the curated glTF loader.
      `engine.invalidate()` is kept only as an alias of `kick()`.

- [x] **Perf round 6 — duplicated work** (`scripts/shaders.mjs`,
      `scripts/profile.mjs` are the new probes):
      shaders no longer recompile for models already drawn
      (`Effect.PersistentMode`; repeat opens went 3 compiles -> 0), the
      synchronous poster `readPixels` (11% of wall time) is now an async PBO
      read, signature verification moved to an inline worker AND stopped
      running three times per event, poster PNG encoding moved to an
      OffscreenCanvas worker, model bytes are decoded/validated once and shared
      by poster+preview+viewer, and repainted DynamicTextures no longer
      regenerate mipmaps. Main-thread idle during a load: 71% -> 82%.

- [x] **Comprehensive graphics/audio settings** (`src/settings/*`,
      `src/render/graphics.ts`, `src/audio/mixer.ts`): 11 groups, ~50 settings,
      Low/Medium/High/Ultra presets + Custom, search, per-row availability
      copy, live readout of the actual drawing buffer, brightness calibration
      pattern, performance overlay. Everything maps to a real engine feature;
      DLSS/FSR/XeSS, frame generation, hardware RT, HDR output, V-Sync toggle
      and VRAM reservation are shown disabled with the reason and the WebGL
      equivalent. Guarded by `scripts/settings.mjs` (20 checks: resolution
      modes, power-of-two snapping, frame cap, pipelines actually created,
      PBR→unlit, FOV, preview slots, contact shadows, presets, Custom
      switching, persistence).

## Incident log

- 2026-08-17 (~18:25 UTC): GitHub **Pages** returned 503 for every deployment
  attempt (`Failed to create deployment … Server error, is githubstatus.com
  reporting a Pages outage?`, 10 internal retries) on commit `3e2cbed`. The
  `build` job succeeded — only `actions/deploy-pages@v4` failed, so the
  artifact is good. Re-run the workflow (or just push again) once Pages
  recovers; nothing in the repo needs changing.

- 2026-08-17: `main` was force-pushed away (replaced by an unrelated 3-commit
  rewrite: "Babylon shell", IME textarea fix, Blossom auth fix). Restored by
  agent-kestrel from the last deployed CI SHA `dcb4d06` (the dangling merge
  commit was still fetchable). The rewrite is kept on `salvage/dev-rewrite` —
  it contains genuinely useful, unlanded work that maps to open tasks below:
    * `src/protocol/publish.ts` — a real BUD-01 upload + kind-1063 publish
      flow (task "Studio publish flow")
    * `src/studio/textMesh.ts` + `public/fonts/UnifontSubset.*` — text
      geometry (task "Low-poly text geometry")
    * `src/gui/topbar.ts`, `src/gui/icons.ts` — canvas GUI experiments
  Whoever picks those tasks up: CHERRY-PICK/port from `salvage/dev-rewrite`
  onto main instead of rewriting again. Branch protection now blocks force
  pushes to `main`.
## In progress

- [ ] **Per-card play/pause (animation + sound) + autoplay setting** — claimed by
      agent arena, 2026-08-20. SPEC AMENDMENT 69. Board cards and thread nodes
      get a ▶/⏸ button (Babylon mesh, bottom-left corner, opposite the reply
      badge) that toggles the live preview animation AND its embedded
      MSFT_audio_emitter sound. New settings entry `autoplayAnimations`
      (default ON = today's auto-animate feed; OFF = everything opens paused,
      the button is the only way to start). Model audio now actually plays:
      the curated loader registers MSFT_audio_emitter and Babylon's AudioEngine
      singleton is wired to the app mixer's context + master bus so post sound
      obeys master volume / mute-on-blur. Audio only ever starts from the
      per-card button (a user gesture) — autoplay stays silent, matching the
      browser autoplay policy and the SPEC "no autoplay" audio line.

- [ ] **Paint editor (hand-writing ink)** — claimed by agent arena, 2026-08-19.
      Rebased onto main (PR #12: preview width / viewer hand-off / zoom
      RTTs / typing guard). SPEC AMENDMENT 54.
      SPEC 05 Part B + AMENDMENT 10. Primary use case = writing letterforms
      with a pen-like brush (pressure, coalesced events, smoothing, eraser,
      undo ≥100). Packed Float32Array store + thin instances + spatial hash
      + Amanatides–Woo DDA. Not a voxel editor.

## Next (priority order — pick one and claim it)

**Editor core (the product's primary use cases — do these first):**

- [ ] ~~**Paint editor, primary = hand-writing text**~~ claimed above (Paint 3D ink style; NOT a
      voxel editor — free overlapping shape strokes, fine grid only for
      snapping; spec 05 Part B + AMENDMENT 10). The brush must feel like a pen:
      `PointerEvent.pressure`→width/alpha, `getCoalescedEvents()`, path
      smoothing, tight stamp spacing, eraser, undo. Then selection (solid/x-ray/
      wireframe), transforms via Babylon `GizmoManager`+`BoundingBoxGizmo`
      (don't hand-roll), packed Float32Array + `thinInstanceSetBuffer` +
      swap-last delete, command+inverse undo. See `docs/RESEARCH-EDITORS.md`
      (§1.1 fit-to-bounds fix, §2 gizmos, §3 grid DDA, §4 picking, §5 instances,
      §6 undo, §8 ink).
- [ ] **Animation editor** (spec 05b): timeline, keyframes, record-toggle, camera
      fly-through authoring, real glTF animation export (quaternion sign guard).
      Split from low-poly text (text is its own task below).
- [ ] **Audio recording** (AMENDMENT 11): mic via `getUserMedia` + `MediaRecorder`,
      in-app record/stop/preview, embed into GLB (KHR_audio / MSFT_audio_emitter,
      8 MiB cap). Do NOT re-export the model (append to BIN chunk).
- [ ] **Phone-pose camera while recording** (AMENDMENT 12): record camera
      animation from DeviceOrientation (rotation; HTTPS + iOS permission prompt),
      optionally WebXR pose for translation (DeviceMotion acceleration drifts —
      never use for position). Sync pose + audio on one clock, export as glTF
      camera animation + audio; play back in feed preview slots.

**Rest (spec order):**

- [ ] **3D thread view mode** (AMENDMENT 43): thread setting — (a) 2D posters
      (current), (b) tree view, (c) 3D actual GLB models. **(c) now lands as a
      button toggle for BOTH board and thread (SPEC AMENDMENT 75 / Direct3DPool);
      mode (b) tree-view layout is still open.** In 3D, apply the model's MAIN
      camera as the MODEL transform vs a static thread camera (model rotated by
      inverse(main-cam rotation); thread camera is only a position). Center a
      node -> thread view == model's main-camera view. Fall back to auto-fit
      when no camera. Load models only near viewport (same pipeline as board).
- [ ] **Viewer: remaining fixes from the AMENDMENT 87 research**
      (docs/VIEWER-RESEARCH.md §6 — deferred by decision 2026-08-21 to keep
      the codebase essential while there is a lot to optimize/polish/debug;
      pick in this order, extend scripts/viewer.mjs per feature):
      (1) screenshot button — render frame then read back in the SAME task
      (PBO fence like posters, or `toDataURL` right after `scene.render()`;
      `preserveDrawingBuffer` is false by design); (2) auto-rotate/turntable
      toggle — orbit behaviour + a registered animation source so
      render-on-demand keeps working, off under reduce motion; (3)
      share/copy-link button (the `#/viewer/<id>` URL already carries the
      model); (4) camera-pose tween on camera switches (~0.4 s, skippable by
      input) — decided "minor optional", last of the group; (5) P2
      presentation: environment-lighting presets via per-material
      `reflectionTexture` (fixes the black-PBR driver issue properly — the
      largest remaining visual-quality gap), wireframe/matcap inspection,
      loop / play-once control on the animation rail, camera fly-through
      (glTF camera animations as playable tracks). Out of scope per decision:
      title/author line, metadata-drawer upgrades (labels are fine as-is).
- [ ] **VR support** (AMENDMENT 41): WebXR immersive viewing in the viewer —
      `WebXRExperienceHelper`, xrCompatible canvas (same engine/canvas), 6-DOF
      tracking, enter-VR action hidden when unsupported, error sheet on failed
      entry, reduced-motion respected. AR (`immersive-ar` / Quick Look at 1:1)
      and first-person fly mode are the other research-deferred viewer items
      (docs/VIEWER-RESEARCH.md §6 P3).
- [ ] **New settings entries** (AMENDMENT 42): the settings system already
      exists (`src/settings/schema.ts`, ~50 settings, 11 groups). Add the NEW
      tunables to it — thread view mode (AMENDMENT 43) and VR toggle
      (AMENDMENT 41), plus any camera/editor defaults — as schema entries
      (persisted, searchable, presets-aware), never as hard-coded constants.
- [ ] **Low-poly text geometry** (spec 05b §1): pixel-font table, run-merge,
      weld, live triangle count — pairs with hand-writing (extrude strokes or
      offer the typed fallback).
- [ ] **Reply authoring** (compose → publish flow).
- [ ] **Tests**: Vitest unit suite (URL normalize, tags, NIP-10, VFS, GLB
      round-trip, text tris, quaternions) + Playwright browser suite
      (plateau, churn, preview isolation, 404 retry bound, publish round-trip).

## Known gaps / debt

- Paint editor: box/lasso + GPUPicker solid/x-ray selection, per-stamp
  BoundingBoxGizmo transforms, and 5-mode visibility are still open.
  Ink / erase / undo / export work.
- Poster/preview pool renders share one scene (serialized by a mutex) — fine
  for now, but per-slot isolation is on the roadmap (spec 03 §5).
- No service worker / offline caching beyond IndexedDB poster cache.
