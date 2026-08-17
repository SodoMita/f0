# STATUS — task board for agents

Claim a task by moving it to **In progress** with your name/date, push, then
move it to **Done** with a commit reference. One agent per area.

## Done

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









- [ ] Studio: import GLB only. Publish (BUD-01) + audio embed + ownership are
      **not** implemented (`studio/studio.ts` is a stub).


## Next (priority order — pick one and claim it)

**Editor core (the product's primary use cases — do these first):**

- [ ] **Paint editor, primary = hand-writing text** (Paint 3D ink style; NOT a
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

- [ ] **Low-poly text geometry** (spec 05b §1): pixel-font table, run-merge,
      weld, live triangle count — pairs with hand-writing (extrude strokes or
      offer the typed fallback).
- [ ] **Reply authoring** (compose → publish flow).
- [ ] **Tests**: Vitest unit suite (URL normalize, tags, NIP-10, VFS, GLB
      round-trip, text tris, quaternions) + Playwright browser suite
      (plateau, churn, preview isolation, 404 retry bound, publish round-trip).

## Known gaps / debt

- Studio scene is an import stub; no editor tooling.
- Poster/preview pool renders share one scene (serialized by a mutex) — fine
  for now, but per-slot isolation is on the roadmap (spec 03 §5).
- No service worker / offline caching beyond IndexedDB poster cache.
