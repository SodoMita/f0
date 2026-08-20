# STATUS — task board for agents

Claim a task by moving it to **In progress** with your name/date, push, then
move it to **Done** with a commit reference. One agent per area.

## Done

- [x] **Embedded audio playback** (agent arena, 2026-08-20, SPEC AMENDMENT
      66): verified extraction of optional KHR_audio/MSFT_audio_emitter
      WAV/MP3 bufferViews with MIME/file-signature/range checks and a 256 KiB
      hard clip cap; identity/WeakMap caching; Nostr audio tag treated as a
      hint until bytes verify. Verified clips show a vector speaker badge on
      cards and a no-autoplay viewer control (button/S, loop, volume 0.78,
      pending/error state, object-URL cleanup on navigation). Pass-through
      publish preserves the hint only for a final GLB that still verifies.
      Guards: audio-unit, audio-playback, audio-integration (real rig GLB),
      build, smoke and orient.

- [x] **Posters render to a transparent RTT, never a PNG** (agent arena, 2026-08-19,
      SPEC AMENDMENT 65): each post gets its own transparent RenderTargetTexture
      (detached after capture). No PNG, no pixel cache, no blank-check retry —
      cards sample the RTT in place. Camera fallback is a frustum-vs-AABB test.
      Opaque materials write alpha=1; card shader treats non-black RGB as coverage.
      Studio/tests take one `snapshot()` readback. IDB keeps anim/footprint only.

- [x] **Search models by name** (agent arena, 2026-08-19): a search menu
      (magnifier button in the topbar → overlay panel) filters the board by
      model name. Matching is a case-insensitive substring over the model's
      published filename, its base name (extension stripped) and its event id,
      so older posts without a `filename` tag are still findable. The board
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

- [ ] **HRTF positional post audio** — claimed by agent arena, 2026-08-20.
      Route verified media elements through per-post WebAudio PannerNodes and
      add in-canvas sound buttons to audio posts on the gallery and thread map.

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
      (current), (b) tree view, (c) 3D actual GLB models. In 3D, apply the
      model's MAIN camera as the MODEL transform vs a static thread camera
      (model rotated by inverse(main-cam rotation), at the node's camera
      position; thread camera is only a position). Center a node -> thread view
      == model's main-camera view. Fall back to auto-fit when no camera. Load
      models only near viewport (same pipeline as board).
- [ ] **VR support** (AMENDMENT 41): WebXR immersive viewing in the viewer —
      `WebXRExperienceHelper`, xrCompatible canvas (same engine/canvas), 6-DOF
      tracking, enter-VR action hidden when unsupported, error sheet on failed
      entry, reduced-motion respected.
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
