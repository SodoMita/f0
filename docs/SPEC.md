FORM/0 BUILD SPEC (condensed). A wordless multiplayer game of 3D shapes; browser-only, direct to Nostr relays + Blossom; one canvas, Babylon.js. Player creations = animated GLB models, own cameras, optional embedded audio.
Goals: (1) real content from public relays on first run, no seeding/config; (2) build:standalone -> ONE .html from file://, fetches only user content.

BUILD (gated): 1 skeleton (scenes==1); 2 relay pool >=20 real GLB events (Node script vs real relays FIRST); 3 Blossom+SHA >=10 match; 4 thumbnails 512x320; 5 board recognizable; 6 RTT pool 4+ animate; 7 viewer/thread/network; 8 studio pass-through; 9 paint editor; 10 standalone file://.

NETWORK [MEASURED]: filter {'#m':['model/gltf-binary','model/gltf+json']} -> 66/66 (bare kinds = 94% junk); never '#t':['3d']. 0/46 events carry poster tags -> render posters locally. url x2 = replicas; ox = hash fallback. relay.nostr.band flaky. form-zero exists (24 posts, 12 replies/7 roots): subscribe {'#t':['form-zero']} + {'#m'} + {kinds:[5]}, merge. >20MiB -> "too large". Draco mandatory, local decoders, no CDN.

TRAPS: 1 SVG utf8 URI never loads -> PNG. 2 emissive+texture=white -> 0,0,0. 3 ScrollViewer calc()=transparent -> pixel heights. 4 GUI can't sample RTT -> meshes 1px=1unit. 5 rejection Map<'STATIC'|'FAILED'>. 6 scene audio emitter distance props reject GLB. 7 import screenshotTools/loaders. 8 SVG needs width/height. 9 BOOT/BOARD share '#/' -> compare names. 10 ARIA active scene only. 11 file dialog trusted click. 12 refreshRate=ceil(active/slotsPerFrame)+phase. 13 re-run npm i; never commit dist/.

CARD: flat plate (NEVER noise) -> local poster (smallest first, t=0, cache by SHA) -> live RTT. Crossfade 120ms.

PRODUCT: BOOT->BOARD->(THREAD->VIEWER|EDITOR, VIEWER, EDITOR, NETWORK). Card: render + audio/thread glyphs + ownership + !; viewer via main, thread via corner. Rhythm: 9th tall/5th wide, seeded shuffle. Viewer: one model, feed paused. Thread: tinted root, tombstones. Publish ring hash->Blossom->relays, partial amber. Network panel: only URLs. Errors: sheet, never '!' alone.

VISUAL: wordless = no labels, not no legibility; mandatory first-run legend (reopenable, seen-flag IDB). Indicators blink: NONE hollow/CONNECTING pulse/PARTIAL amber+notch/FULL static/RETRYING double-blink; reduced-motion -> dashed. One glyph = one meaning, PNG, >=44px, hidden a11y names. Audio: hint tag, verify bytes, no autoplay. Text only: legend/drawer/network/numbers/user text/errors/ARIA/fatal.

RUNTIME: 1 canvas/Engine/context, swap scenes; no per-card canvas; GLB near viewport only; bounded RTT pool; viewer = 1 model + paused feed; empty content; preserve names/hierarchy/cameras/anims. Scenes board/viewer/editor/ui. Cards = meshes 1px=1unit; virtualize ~48. Slots: 8 max (4 low-mem), isolated RTT+layer mask, hysteresis .55/.95, animated-only, adaptive 192-512px, rebind every frame. Budgets: 20MiB/1.5MiB/8MiB/48/240/22ms/3/50k@60fps. Dispose on close; 100 cycles no growth; per-post try/catch.

FEED: placeholder->poster->prefetch->slot->RTT->poster. Load: query+deletions->verify->index->layout->posters->slots; never 48x20MiB. Animated? v3 hints else preflight. Poster: t=0, 512x320, SHA, <=200KB, same camera policy. Camera: preview-camera->animated->imported->auto-fit; anim: preview-anim->camera->model->static; no cuts. Reply: parent never loaded.

PIPELINE: glb byte-for-byte; gltf/obj via virtual FS -> repack; never auto-rename/merge/bake/center/scale; unknown ext rejected; external URIs forbidden. GLTF2Export.GLBAsync(shouldExportNode); pass-through never exports. PreservationReport: loss blocks publish (fail closed). Audio -> repack, hash changes. Poster from published bytes. Errors name originals.

EDITOR: brush paint in 3D, not CAD. GRID 0.05 != CUBE 0.25, overlap, never dedupe by cell. Stroke stamps (spacing, interpolation, jitter, pressure, align-to-direction); shapes cube/sphere/cylinder/tetra/quad; RGBA+PBR. Paint plane or surfaces, depth lock. Eraser + undo >=100. Selection: 5 modes; solid/x-ray/wireframe visibility. Transform G/R/S, axis, pivots, AABB, snap. Data: flat store + thin instances + spatial hash + GPU ID picking; 50k@60fps. Nav: view keys, view cube, mouse presets, touch. Tools: brush, eraser, select, transform, plane, picker, text, import, audio.

TEXT+ANIM: text = real flat low-poly geometry (NOT textured quad), FORM <120 tris; pixel-font table + run-merge. Anim: tracks -> node props, keyframes {time,value,LINEAR|STEP|CUBICSPLINE}, RECORD keyframing. Camera anim fly-throughs, export real glTF (quaternion sign guard). FRAMING: auto-fit faces content (dominant facing), same policy poster+RTT. Acceptance: <120 tris, round-trips, 30s/200keys >=55fps.

PROTOCOL: relays damus.io/nos.lol/primal.net + nostr.band (flaky). Filters {'#m':[gltf-binary,gltf+json]} + {kinds:[5]}; mime recheck. v2 tags: t/m/x/size/url/server/color/v/e(root/reply); v3 adds thumb(x/size/dim 512x320), preview-camera/animation (index), anim/cameras/camera-anim, filename/source-format/source-filename. Parse: multi-url replicas, x->ox, NIP-10. Publish: empty content, url(xN)/m/x/ox/size/poster/poster-x/f flags/e tags, nostr-tools, 1/3=partial. Kind-5: pubkey match, tombstones. Blossom: blossom.primal.net + cdn.satellite.earth, replicas, SHA-256; BUD-01 (kind-24242). Audio: KHR_audio/MSFT_audio_emitter, append BIN, <=8MiB. IndexedDB: posts/posters/blobs/owned/config, forward-only, never deleteDatabase(), secrets AES-GCM, poster LRU.

SECURITY: trusted = bundle + nostr-tools + Babylon; else untrusted until verified (sig/schema/size/URL/cycles). Blob: cap, no credentials, timeout, SHA-256, magic/length, no cross-origin redirects. GLB limits: 20MiB, 2MiB JSON, 2k nodes, 500 meshes, 2M verts, 6M idx, 256 mats, 64 tex, 128MP, 32 skins, 16 cams, 32 lights, depth 128; re-verify, dispose on mismatch. GPU: caps, one model, contextlost -> stop. Secrets: per-post keys, envelope only. Endpoints: wss:/https: only, no localhost. Privacy: IP visible, deletion != destroy, per-post key unlinks.

PERF: <=200 events, 48 roots; poster <=200KB; model 8/20MiB. Pool: desktop 6/8 @512, tablet 4 @320, mobile 2 @256, reduced-motion 0. Frame 16.7ms: board<=4/RTT<=7/JS<=3/reserve>=2. Score: visibility x centerProximity x animationValue x readyBonus - loadCost. Adaptive degrade->posters. Gates: 100 cards x10, 100 cycles unchanged.

A11Y: hidden DOM bridge (Babylon GUI = no a11y tree), active scene only. Keys: Board arrows/Enter/T/PgUp/PgDn/Escape; Viewer Left/Right/C cameras/A play (NOT audio)/M/R/T/S sound; Editor G/R/S/numpad. Touch >=44px, threshold, gestures. Reduced motion: 0 slots, dashed. Errors: sheet (code+cause+action); fatal = HTML box, never deleteDatabase; aria-live.

IMPL: TS strict, Vite, Babylon, nostr-tools, Vitest+Playwright; no React/Vue/Three/CDN. Files <=400 lines. Comment every engine-bug workaround. Tests: unit (URL/tags/NIP-10/VFS/GLB/audio/text/anim/editor) + browser (live feed>0; plateau; churn; zero RTT in viewer; 404=1 fetch; publish+audio round-trip; standalone file://; editor) + screenshot everything. Standalone: single JS chunk, inline assets+CSS+Draco (no CDN), zero own-asset requests.

AMENDMENTS (2026-08-16, decided during implementation — override earlier wording):

1. HTML HUD. Settings, navigation, toolbars, metadata drawer, toasts and error
   sheets ARE plain HTML (DOM overlay). Only the 3D models, the board, the
   reply badges and the thread map live on the canvas. (Earlier "HTML is
   technical only" is relaxed for chrome/HUD.)

2. Replies live in Babylon. Reply buttons, reply counts and the reply graph are
   Babylon meshes in the SAME space as the board — not HTML. Each card carries a
   reply-count badge ("↩ N") pinned to its bottom-right corner; the badge IS the
   reply button (tap -> open thread). Badge hidden when count = 0. Count =
   direct children (index.childCount).

3. Thread = 2D tree map. The thread view renders the reply tree as a 2D map:
   one node plane per post (poster or tinted plate), lines parent->child,
   laid out by a Fruchterman-Reingold force relaxation (repulsion between all
   nodes, spring attraction along edges; root fixed at center). Pan = drag,
   zoom = wheel, tap node = open viewer. Background from settings.

4. Scroll inertia. The board scroll has momentum; inertia strength is a
   settings slider (0..1, persisted). Wheel-down/drag-down scrolls toward later
   cards; momentum decays after release (0 = no momentum).

5. Background setting. Settings background color applies to the detail viewer,
   the thread map and the studio (scene.clearColor). The engine must NOT
   overwrite scene.clearColor on setActiveScene (scenes own their clearColor).

6. Poster camera = the model's authored camera when it has one. The poster
   shows the view the author framed, not a synthetic auto-fit (auto-fit is
   only the fallback for models without a camera: worldBounds union AABB +
   dominant facing + fitDistance). A camera that frames nothing still yields
   a blank poster -> publish falls back to a placeholder. Live previews use
   the same policy: preview-camera index -> first imported camera ->
   auto-fit. Authored cameras also belong in the viewer (camera dots / C).

7. Offscreen renders use scene.render(). Babylon's manual
   RenderTargetTexture.render()/renderList path does NOT compile materials on
   some GL drivers (blank posters/live previews). Render the poster/stage scene
   into the RTT via camera.outputRenderTarget + scene.render(). For the slot
   pool, models are offset far apart so each slot camera's frustum isolates its
   own model.

8. No environment texture. Setting scene.environmentTexture (IBL) with a dark
   env cube rendered every PBR model black. Use a lights-only rig (hemispheric
   + directional + fill). The earlier "black model" was a camera-framing bug,
   not missing IBL.

9. Render serialization. The shared poster scene serializes renders via a
   promise-chain mutex (concurrent renders stomp each other's activeCamera);
   downloads stay concurrent (<=3). Containers are removeAllFromScene() before
   dispose so no meshes leak into the next render.

10. Paint editor's primary use case = hand-written text. The Studio's main job
    is writing text by hand: freehand strokes that form letterforms (Paint 3D
    ink/doodle style). The brush must feel like a pen FIRST — pointer pressure
    → stroke width/alpha, path smoothing, coalesced-event sampling, tight
    stamp spacing, an eraser, and undo. Shape placement and the grid are
    secondary tools, not the point. (Amanatides–Woo grid DDA is still the hit-
    test technique; using it does not make this a voxel editor.)

11. Editor priorities (in order): (1) hand-writing text; (2) animation editing
    (timeline + camera fly-through, spec 05b); (3) audio RECORDING — mic
    capture via getUserMedia + MediaRecorder, then embed into the GLB
    (KHR_audio / MSFT_audio_emitter, 8 MiB cap). "Embed" is not enough; the
    user records in-app.

12. Phone-pose camera while recording. During audio recording the camera
    animation may be captured from the phone's sensors: rotation from
    DeviceOrientation (alpha/beta/gamma; works broadly, HTTPS + a permission
    prompt on iOS), translation from WebXR device pose where available.
    DeviceMotion acceleration double-integrates with unbounded drift — DO NOT
    use it for position (rotationRate is fine for rotation smoothing). Pose
    and audio are sampled on one clock and exported as a synced glTF camera
    animation + embedded audio. Rotation-only is an acceptable fallback; the
    recorded camera must play back in the feed's live preview like any other
    authored camera animation (spec 05b §2.3).

13. Card orientation is a CAMERA contract, not a driver quirk. All flat scenes
    use core/gfx.flatCamera() (ortho ArcRotateCamera at -Z, alpha=-PI/2).
    Babylon is left-handed, so a camera at +Z sees every CreatePlane quad from
    behind: mirrored textures AND mirrored column order. With the camera at -Z
    no texture kind needs a flip (raw/dyn/rtt all sample (0,0)); the previous
    per-GPU, per-kind boot calibration is DELETED. Guard: scripts/orient.mjs.

14. Alpha blending on ShaderMaterial is an OPTION, not a method call.
    `new ShaderMaterial(..., { needAlphaBlending: true })`. `mat.needAlphaBlending()`
    is a getter; calling it (as the code did) leaves the material opaque, which
    is why transparent posters/previews still showed black rectangles.

15. Offscreen scenes own their clear. When rendering via
    camera.outputRenderTarget + scene.render(), the SCENE clears the bound
    framebuffer: set scene.autoClear = true and scene.clearColor = (0,0,0,0).
    Setting only rtt.clearColor does nothing on that path.

16. Auto-fit must respect the frame aspect. frameDistance() solves both
    frustum planes over the 8 AABB corners (fill ~0.86 for posters). A bounding
    SPHERE fit shrinks wide/flat models to a stamp in a 16:10 card.

17. Facing for flat content. dominantFacing(): thin AABB axis when the model is
    clearly flat, signed by AREA-WEIGHTED AUTHORED NORMALS (winding uses the
    left-handed cross(e2,e1) — Babylon's own CreatePlane proves the sign), and
    +axis when the shape is closed and the normals cancel. Measured on live
    board content with test/facing.ts; the opposite convention rendered every
    wordmark mirrored.

18. Multi-touch does not come from Babylon's observable. Babylon routes touches
    through navigator.maxTouchPoints device slots and silently drops extra
    fingers, so the thread map binds NATIVE pointer events on the canvas
    (attach()/detach() with the route). Pan integrates the delta since the
    PREVIOUS move event — measuring from the pointer-down anchor and adding it
    every move makes the map drift forever (reported bug). Guard:
    scripts/interact.mjs.

19. HUD icons are inline SVG, never font glyphs. Symbols like the reply arrow,
    shuffle and download glyphs are missing from default UI fonts and fall back
    to a blurry substitute face; the reply badge draws its arrow with canvas
    vector strokes. The engine renders at devicePixelRatio (capped at 2) — it
    was pinned to 1.0/1.25, which softened everything Babylon drew on HiDPI.

20. One model in the single-model view. Viewer.load() clears, then AWAITS the
    GLB parse — so racing navigations (fast prev/next, or leaving for the
    board) used to add several containers to the same scene and never dispose
    the earlier ones (models drawn on top of each other). Every load takes a
    token (`++this.loadToken`); a parse that returns with a stale token
    removeAllFromScene()+dispose()s its container instead of adding it.
    clear() bumps the token (cancels in flight), disposes the container, and
    sweeps any non-helper mesh/transform/camera left in the scene. main.ts
    mirrors this with a `viewerNav` ticket so a late download cannot paint into
    a view the user already left. Guard: scripts/interact.mjs asserts
    `viewer.sceneModelMeshCount() === viewer.stats().meshes` after hammering
    next/prev.

21. Loading is always visible. A 12-dot spinning ring is the one loading
    idiom: `#loading` in the HUD (SVG + CSS `steps(12)` rotation, with a label:
    connecting / loading model / building thread) and an in-canvas ring on
    every board card and thread node that has no poster yet
    (`gfx.makeSpinnerTexture` + stepped `rotation.z`, so it stays crisp at any
    zoom). setLoading(reason, on) is reference-counted by reason — never hide
    the ring while another reason is still loading.

22. DEMAND-DRIVEN RENDER LOOP (kestrel/perf + hedgehog/perf, merged).
    FormEngine renders a frame only when (a) `kick()`ed — any input, content
    arrival, scene swap, resize, background change: a 300 ms uncapped window —
    or (b) a registered animation source (`addAnimationSource`) reports
    motion, capped at ANIM_FPS. A static board/viewer/thread renders ZERO
    frames. Rules:
      * ANY code that changes the picture outside a render MUST `kick()`.
      * New continuous animation MUST register a source or it will freeze
        when input stops.
      * A source must report motion only while something is genuinely due:
        a ring STEP due, a live preview refresh DUE, real camera movement,
        drag/momentum. Never latch a source flag true — a stuck flag silently
        restores full-rate rendering (two such bugs were found and fixed while
        merging: a latched scroll-settle flag, and loading rings left spinning
        on offscreen cards).
    Adaptive resolution lives in FormEngine.adaptResolution (frame-time EMA
    steps hardware scaling between 0.7x and the target ratio) — do not fight
    it by pinning setHardwareScalingLevel elsewhere. The target ratio itself
    is devicePixelRatio clamped by a 2.6 Mpx drawing-buffer budget, so a
    4K/DPR2 screen never rasterises 33 Mpx before the controller reacts.

23. The board is virtualised. Card slots are recycled to the rows nearest the
    viewport; never bind `rows[i] -> cards[i]` (with more roots than slots the
    extra rows were simply never drawn). Slot state that must survive
    recycling (reply counts) lives in a Map on the Board, not on the slot.

24. Work follows the viewport. Posters and live previews are only requested
    inside a one-screen prefetch window AND only once scrolling has settled
    (150 ms); `AssetCache.setPaused(true)` stops the poster queue while the
    feed moves, because a GLB parse plus an offscreen render blocks the main
    thread for tens to hundreds of ms. Live previews are capped per slot
    (PREVIEW_FPS) and skipped entirely for offscreen cards.

25. Posters are cheap. 448x280 into ONE reusable render target with ONE
    reusable readback buffer; 3 warm-up frames then a single readback (not up
    to 60 readbacks with 100 ms sleeps); the freshly rendered poster is
    uploaded straight from the GPU readback to a RawTexture and the PNG for
    the IndexedDB cache is encoded off the critical path. Model blobs in RAM
    are an LRU (6 items / 48 MiB) on top of the IndexedDB cache.

26. Loader is curated (`src/model/gltf.ts`). Importing `@babylonjs/loaders/glTF`
    drags in the glTF 1.0 loader and every 2.0 extension, including
    KHR_interactivity's FlowGraph engine which a viewer can never run. Import
    the 2.0 loader plus the extensions that change how a model LOOKS. If a
    real post needs another extension, add the import (and MSFT_audio_emitter
    when audio playback lands).

27. Compiled shaders must survive material disposal. `Effect.PersistentMode = true`
    (set in core/engine.ts). Babylon keys compiled programs by
    "vertex+fragment@defines", but `Effect.dispose()` DELETES the cache entry
    when the last material using it goes away — and we dispose an
    AssetContainer after every poster render, every preview swap and every
    viewer navigation. Measured before the flag (scripts/shaders.mjs): opening
    the SAME model three times compiled its shaders three times, zero cache
    hits, and only 2 of 14 compiled programs were still cached. After: +0
    programs on repeat opens. The cache is bounded by distinct define sets, not
    by models, so it does not grow with the feed.

28. Never stall the main thread on the GPU. `rtt.readPixels()` is a
    Promise-wrapped SYNCHRONOUS `gl.readPixels` (a full pipeline sync) and was
    11% of wall time during a board load. Posters read back through
    `engine._readPixelsAsync` (PIXEL_PACK_BUFFER + fence) with the sync call
    only as a fallback (WebGL1 / missing internals).

29. Heavy CPU work goes to inline workers. Signature verification
    (`protocol/verify.worker.ts`) and poster encoding
    (`model/encode.worker.ts`) are `?worker&inline` — blob workers, which the
    CSP already allows (`worker-src 'self' blob:`) and which are verified to
    work from `file://` in the standalone build. Both have main-thread
    fallbacks. ALSO: nostr-tools' Relay verifies every matching event itself,
    synchronously — that duplicate check is disabled (`relay.verifyEvent`)
    because we verify off-thread before dispatching, and `verifyFresh` now
    remembers what WE verified in a WeakSet (it used to run twice per event:
    ingress + parseModelEvent).

30. Decode a model's bytes ONCE. `AssetCache.getModelBytes()` hands the same
    `Uint8Array` to the poster renderer, the preview pool and the viewer, and
    `validateGLBCached(bytes, sha)` memoises the limit report by content hash.
    Load with `LoadAssetContainerAsync(bytes, scene, { pluginExtension: '.glb' })`
    — a `File` source makes Babylon re-read the whole model through a
    FileReader. Before: three `blob.arrayBuffer()` copies + three JSON-chunk
    parses per post.

31. DynamicTextures that are repainted (badges, rings) must be created with
    `generateMipMaps = false`. Every `update()` otherwise re-uploads AND
    regenerates the whole mip chain — with slot recycling that fires
    constantly while scrolling.

32. SETTINGS ARE HONEST. `src/settings/schema.ts` is the single source of
    truth: it drives persistence, the panel UI, the quality presets and the
    "why is this greyed out" copy, so a new setting is added in exactly one
    place. Anything the web platform cannot provide is rendered DISABLED with
    the reason and the closest real equivalent next to it — never a switch
    that does nothing. Currently unavailable, with copy in
    `settings/capabilities.ts`: DLSS / FSR / XeSS (native SDK only → offer
    render scale + sharpen), frame generation, hardware ray tracing (→ SSR),
    HDR swapchain (→ exposure/tone mapping), V-Sync toggle (rAF is always
    display-synced → frame cap), VRAM reservation (→ our own budgets).
    Runtime failures (a pipeline this GPU refuses) are surfaced the same way
    via `graphics.errors`.

33. Everything else in the panel maps to a REAL engine feature: MSAA
    (`pipeline.samples`), FXAA, TAA, SSAO/SSAO2, SSR, bloom (weight/kernel/
    threshold), sharpen, grain, vignette, exposure/contrast/tone mapping,
    anisotropy, unlit (PBR off), shadow maps with blur, camera FOV/near/far/
    inertia, drawing-buffer size (auto / scale / exact pixels, power-of-two
    snapping), frame cap, adaptive resolution, our memory budgets and the
    Web Audio mixer (per-bus gain, `setSinkId` output routing, device
    enumeration, HRTF, surround channel count, mute-on-blur).

34. Heavy pipelines load on demand. SSAO2/SSR/TAA/DefaultRenderingPipeline are
    `await import(...)`ed the first time a setting needs them (they add ~380 kB
    to the entry chunk otherwise). The standalone build inlines those chunks.
    SSAO2/SSR additionally need the PrePass + geometry-buffer scene components
    imported alongside them, or the constructor throws
    "scene.enablePrePassRenderer is not a function".

35. Image processing is only switched ON when a value deviates from neutral.
    Enabling `scene.imageProcessingConfiguration` adds IMAGEPROCESSING defines
    to every PBR material — new shader permutations and a heavier fragment
    shader — which measurably slowed poster rendering when it was on by
    default.

36. A settings change must not silently drop content. The texture cap is a
    LOAD-TIME GUARD ("skip models with textures over N"), defaults to no extra
    limit, and only the Low preset tightens it; WebGL cannot downscale a
    model's textures after decode, so pretending otherwise would just hide
    posts. GLB image dimensions are now really parsed (PNG/JPEG/WebP headers)
    so the spec's decoded-pixel budget is enforced instead of stubbed.


37. SECURITY: GLBs are self-contained, enforced at validation
    (`validateGLB`, src/model/limits.ts). Any non-empty `uri` that is not a
    `data:` URI — `buffers[].uri`, `images[].uri`, or any extension uri —
    now FAILS validation: Babylon's glTF loader would otherwise fetch it
    verbatim (rootUrl ''), uncapped and un-hashed, so a tiny signed post
    could point at an arbitrary host for an unbounded download (tab crash)
    or a tracking request (viewer IP leak to a third party). The 20 MiB /
    2 MiB caps cover the container only, never external fetches. `data:`
    URIs stay allowed, but image data URIs are safe-MIME allowlisted and
    dimension-scanned against texture-side + decoded-memory limits before
    decode (compressed bytes are not a VRAM bound). Vertex positions with
    non-finite values (NaN/±Infinity) also fail validation — they
    poison worldBox/frameDistance and render blank/invisible models.

38. SECURITY: incoming kind-5 events tombstone ONLY the signer's own posts
    (NIP-09 author check in main.ts). Relays are not required to enforce
    pubkey matching, so a verified kind-5 signed by anyone else must not
    hide a post from every viewer. Deletions from the in-app delete button
    are unaffected: posts are signed with the per-post key, and the
    kind-5 uses the same key, so `target.pubkey === event.pubkey` holds.

39. SECURITY: Blossom downloads refuse redirects (`redirect: 'error'`,
    enforcing the SECURITY line's "no cross-origin redirects") and upload
    responses are URL-parse-validated (an "https://" with no host used to
    crash publish.ts's `new URL(u.url)` server-tag loop after the bytes
    were already uploaded).

40. SECURITY: the standalone build ships a CSP too (csp.ts STANDALONE_CSP).
    It previously had none because the file:// single-file build cannot use
    `script-src 'self'` (inline script + data: Draco assets), but even the
    weaker header (`script-src 'unsafe-inline' data:`) locks base-uri,
    object-src, frame-src and every connect/img/media/worker scheme to what
    the app actually uses.

41. VR support. WebXR immersive viewing is a first-class, natural feature:
    - Viewer: an "enter VR" action (hidden when unsupported) puts the model in
      1:1 immersive space with 6-DOF head tracking via WebXR
      (WebXRExperienceHelper + xrCompatible canvas; same single canvas, same
      engine — the one-canvas rule still holds).
    - Board/thread/editor previews may add a VR mode later; the viewer is the
      primary surface.
    - Constraints: requires a secure context (HTTPS) and a WebXR-capable
      browser/headset; degrade gracefully (button hidden, error sheet if entry
      fails). Respect prefers-reduced-motion.

42. Many settings. FORM/0 has MANY settings — see `src/settings/schema.ts`
    (single source of truth, ~50 settings across 11 groups, presets + Custom,
    search, persistence) and AMENDMENT 32. The settings surface is HTML and
    keeps GROWING: new tunables (thread view mode — AMENDMENT 43 — VR toggle,
    camera options, network endpoints, editor defaults) go into the schema, are
    persisted, and are read at use-sites — never hard-code a tunable in a
    module.

43. Thread view = three modes (a settings choice):
    (a) 2D posts — flat poster cards (the current force-relaxed map, AMENDMENT 3);
    (b) tree view — hierarchical tree layout;
    (c) 3D — actual GLB models instead of poster textures, arranged in 3D space.
    In 3D mode each node shows its REAL model through the model's MAIN camera,
    applied as the MODEL's transform relative to a static camera: the model is
    rotated by inverse(main-camera rotation) and placed at the node's camera
    position; the thread camera's orientation never changes — it is "just a
    position" that moves between nodes. When a model's node is at the center of
    the view, the thread camera and the model's main camera show the same view.
    (Fall back to auto-fit when a model has no camera.) Nodes load models only
    near the viewport, same pipeline as the board.

44. SECURITY: deletion ownership records are AES-256-GCM envelopes, never
    plaintext secrets at rest. IndexedDB v4 stores one non-extractable
    WebCrypto wrapping key in `keyring`; each `ownedPosts` ciphertext has a
    random 96-bit IV and authenticates its event id as AAD. Legacy plaintext
    records migrate one-way before use. Decryption/migration failures do not
    reach the signing path. This is same-origin at-rest protection, not a
    claim to defeat arbitrary same-origin script execution.

45. SECURITY: persistence is a trust boundary. `SettingsStore` accepts only
    known schema keys with exact types, finite in-range numbers, select
    allowlists and valid colours; invalid values reset to defaults and the
    repaired record is saved. Runtime patches use the same validator.
    Cross-field projection invariants (`nearClip < farClip`) and persisted
    network-config shapes are validated too.

46. SECURITY: studio sidecar imports are fully local and bounded before
    Babylon parses them. Exactly one `.glb`/`.gltf`/`.obj`, at most 128 files
    and 20 MiB total; GLBs pass `validateGLB` before load; glTF structure,
    buffers/accessors/depth/images and OBJ geometry/materials are preflighted.
    Every glTF/OBJ/MTL dependency must resolve to an unambiguous selected
    basename (safe glTF `data:` is the only exception); remote, absolute,
    missing and ambiguous URIs fail closed. The importer uses the curated
    loader (never the barrel that registers `KHR_interactivity`/FlowGraph).
    The exported GLB is validated again before preview/publish.

47. SECURITY: all embedded image paths—including `data:` image URIs—count
    decoded RGBA bytes before decode. PNG, JPEG, WebP, GIF, BMP, TGA and KTX2
    dimensions are read from bounded headers; unknown headers, unsafe SVG
    data images, oversized sides and aggregate decoded-memory excess fail
    closed.


48. BUGFIX ROUND (feed/tree/studio, 2026-08-18):
    - Posters + live previews render from the model's authored camera when
      one exists (AMENDMENT 6 rewritten — the old "ALWAYS auto-fit" wording
      was wrong in practice; users want the camera view).
    - The live-preview pool REUSES released slots and evicts offscreen ones.
      Previously every request allocated a slot up to maxSlots and then the
      pool refused every later post — only the first N cards of a feed could
      ever animate. STATIC rejection also leaked the container (release()
      looked the post up in byPost, which it never entered).
    - The thread map now runs live previews for animated nodes (small share
      of the same slot budget, viewport-gated, same pipeline as the board).
      Before, the tree only ever showed static posters.
    - Card/nodes crossfade between plate -> poster -> live over 120ms (the
      SPEC CARD "Crossfade 120ms" that was never implemented): loading cards
      no longer flash black while scrolling the feed or building the tree.
    - Studio: importing a model no longer snaps the camera to the object —
      the composed view stays. New camera buttons: look at average origin of
      selected, look at bounding-box centre of selected, fit selected in view.
    - Studio: `.studio-stage`/`.stage-top` no longer intercept pointer
      events, so gizmo handles, orbit drags and mesh taps anywhere above the
      W/E/R toolbar finally reach the canvas (only the real controls grab).
    - VERIFIED headlessly (docs/SANDBOX-VERIFY.md: npm-registry Chromium +
      local wss relay + offline rig). Two more real bugs found and fixed:
      (a) `Camera.rotationQuaternion` is null at runtime despite the .d.ts —
      the pool's `.copyFrom()` failed every model WITH an authored camera;
      (b) pool eviction used `slot.visible`, updated only in tick() AFTER the
      request pass — stale flags either deadlocked eviction (visible cards
      stopped animating once the pool filled) or ping-ponged prefetch cards
      (thousands of churned GLB loads). `request()` now takes the caller's
      fresh visible set and the board requests live slots only for on-screen
      cards; slot cleanup un-reparents root nodes before
      removeAllFromScene().

49. BUGFIX ROUND 2 (audit + REGRESSIONS, 2026-08-18, all verified headlessly):
    - THE live-preview root cause: the pool never called
      `container.addAllToScene()` — every live RTT rendered nothing since
      the pool existed (the poster pipeline adds it; the pool didn't).
      Fixed + pixel-verified (live slots now show the actual model).
    - `preview-camera` plumbing: assets passes `cameraIndex` (was dead
      field name); pixel check proves a preview-camera=1 post animates
      GREEN (cam1), not red (cam0).
    - Authored-camera slot copy: the slot offset is applied to the
      container root, so the whole parent chain must be force-recomputed —
      otherwise the camera films empty space 800*index units away.
    - Two-texture card crossfade (SPEC CARD "Crossfade 120ms"): the card
      shader mixes tex/tex2 by a blend uniform; plate->poster->live are
      REAL crossfades now. (First version forgot to reset the blend
      uniform on completion — every card sampled the white fallback.)
    - POSTER_CACHE_V -> p4 (camera-policy posters invalidate old caches).
    - Blank authored camera -> auto-fit fallback before the placeholder.
    - Pending loads are cancellable; pool slots prune on thread detach.
    - Studio: look-at origin/center/fit drive the ACTIVE camera (fly mode
      included); origin = direct pick only (no subtree centroid);
      Vector3.subtract mutation bug in the first version fixed.
    - Publish flow waits for the relay echo before routing to the new
      post's viewer (publish->board flash + dead delete button).
    - REGRESSIONS.txt UI items: upload tab first, studio close button,
      transform tools moved into the inspector foot, camera panel
      collapsed by default, paint/symbols tabs disabled, rail glyphs as
      SVG, portrait inspector 22vh, duplicate studio CSS block
      consolidated, aspect-aware viewer spotlight (phone grey slab),
      type-tab seed enables publish.

50. Card preview width is an arbitrary positive integer (settings →
    Textures → "Card / preview width", renamed from "Card / preview
    resolution"). The previous 4-preset select (224 / 320 / 448 / 640 px
    width) became a numeric slider (32-4096 px, default 448, step 1).
    Height is derived from the 16:10 poster aspect (width × 5/8) so the
    live preview never stretches the model. PreviewPool.setRttSize(w,h)
    rebuilds every slot's RenderTargetTexture in place; onResize(postId,
    rtt) callback tells the card / thread-node shader to swap its
    texture handle immediately (no fade — the model pose and animation
    don't change, only the pixel grid).
51. Model viewer hands off the live-preview container. When the user
    opens the model view for a post currently animating in the board's
    live preview pool, Viewer.loadFromContainer() adopts the
    already-parsed AssetContainer (cloned into viewer.scene by
    `handoffContainer` in src/core/sceneTransfer.ts) instead of running
    a fresh LoadAssetContainerAsync. Skips the parse entirely AND the
    "loading model" indicator, since the model is already on screen.
    Falls back to the byte-loading path silently if the hand-off fails.
    The slot's staging offset (the +800*N the pool uses to keep slots
    outside one another's frustums) is subtracted from each cloned
    rootNode so the model lands at the viewer-scene origin.

52. Live preview resolution follows the map camera zoom (thread view). The
    thread map's camera zoom (0.12x-6x, wheel/pinch/+ - keys/fit button)
    changes how big a node appears on screen; the node preview RTT now
    scales with it: effective width = previewWidth / zoom (clamped 64-2048
    px, snapped to 32 px steps so a wheel gesture rebuilds RTTs a handful
    of times, not per notch). Zoomed in → previews stay sharp; zoomed out
    → previews get cheaper. PreviewPool.setRttSize is idempotent and
    rebinds live card textures via onResize, so zooming never re-parses a
    GLB. The thread map's zoom UI is a + / - / fit cluster in the topbar
    (visible only in thread mode) plus the existing wheel/pinch.
53. Hotkeys never fire while typing. The window keydown handler ignores
    game hotkeys when the event target is an INPUT / TEXTAREA / SELECT /
    contenteditable element. Previously the viewer's ArrowLeft/ArrowRight
    (model prev/next) and the thread map's 0/+/-/Escape fired while the
    user was editing a settings input (e.g. typing the preview width),
    switching models under the caret.

54. PAINT EDITOR (2026-08-19). Studio paint tab is the hand-writing ink
    tool (AMENDMENT 10), not a voxel editor. Implementation notes that
    later agents must not "clean up":
    - Packed Float32Array store + swap-last delete; spatial hash on GRID
      0.05; Amanatides–Woo DDA for eraser traversal. Stamps overlap —
      never dedupe by cell.
    - Native pointer events on the canvas (getCoalescedEvents, pressure,
      setPointerCapture). Babylon's pointer observable does not expose
      coalesced sub-frame points. Left button paints; right/middle orbit
      (`camera.inputs.attached.pointers.buttons = [1,2]` while painting).
    - Depth-lock: the first hit of a stroke freezes the writing plane
      (default XY / z=0 facing +Z, matching the studio orbit). Surface
      mode raycasts existing meshes and offsets by the hit normal.
    - Thin instances are display-only. GLTF2Export does not expand them,
      so publish bakes each shape into a real mesh (vertex colours) and
      excludes `studio-paint-*` helpers from shouldExportNode.
    - Undo is inverse commands (add/remove stamp snapshots), cap 100,
      redo tail cleared on new edits. Guard: `bun scripts/paint-unit.mjs`.
    - Studio paint hotkeys (Z/B/X/V) run only after AMENDMENT 53's typing
      guard, so they never steal keys from settings / the text textarea.
55. NETWORK BUTTON + LIVE TRANSFER STATUS (2026-08-18):
    - The network control in the topbar is a **42x42 button** (the same size
      as every other HUD control, 10px gap => WCAG 2.5.5 target size), with
      the relay-state dot drawn as a `::before` pseudo-element tinted through
      a `--dot` custom property. It used to be an 8x8 `<button class=net-dot>`
      — a 64px^2 target, roughly 1/24th of the recommended minimum, so on
      touch it was mostly a miss. The dot's meaning is unchanged (grey none /
      amber partial / green all connected) and the legend glyph still renders
      as the plain 8px span.
    - **Loading statuses now report throughput.** `src/core/transfer.ts` is a
      single app-wide meter: every Blossom download (models AND posters) and
      every Blossom upload registers a handle, reports byte deltas, and ends
      in a `finally`. Speed is measured over a 2s sliding window of
      cumulative-byte samples ticked at 200ms, so a stalled replica visibly
      drops to 0 instead of being hidden by a whole-transfer average. The
      ticker only runs while something is in flight (idle board still renders
      ~0 fps — see perf.mjs `idleBoard.rendersPerSec`).
    - Four surfaces read that one meter:
      (a) the loading overlay — one line per active direction
          `↓ 4.2 MiB/s · 9.7/18 MiB · 54%` plus a determinate bar once a total
          size is known;
      (b) the topbar — a compact `↓ 4.2 MiB/s` readout beside the network
          button (slot reserved so the toolbar never jumps; hidden < 560px)
          and a pulse ring on the button itself while bytes move;
      (c) the studio publish status — the live upload rate + percent instead
          of a static `upload…`;
      (d) the network panel — a TRAFFIC section with a live row per direction
          that falls back to `idle · N MiB this session`.
    - Uploads had NO progress signal because `fetch` does not report
      request-body progress. `BlossomClient.upload` now PUTs through
      XMLHttpRequest (`upload.onprogress`), same semantics as before (no
      credentials, 60s cap, JSON response, URL validation), with a `fetch`
      fallback where XHR is unavailable.
    - Downloads late-bind their total from `Content-Length` when the event
      carried no `size` tag.
    - Verified with `scripts/transfer.mjs` (13 checks: 42x42 target,
      no overlap, off-centre tap opens the panel, a real rig download is
      metered end-to-end, determinate totals, return-to-idle, session totals,
      and the upload readouts) plus the existing offline-verify (39) and
      verify-publish (7, exercising the new XHR upload path) suites.

56. THE NETWORK PANEL IS AN OVERLAY, NOT A PAGE (2026-08-18):
    Opening `#/network` used to run `setMode('board')`, so tapping the network
    button from the viewer, the thread map or the studio tore that view down;
    closing the panel then always landed on the board (and re-entering the
    studio route wipes an imported model, so work in progress was lost).
    - `#/network` now leaves the current mode alone — the panel simply draws
      over the viewer / thread / studio, which keep rendering behind it. Only
      a cold load straight into `#/network` falls back to the board, because
      there is nothing behind the panel.
    - `main.ts` records the last non-overlay route (`networkReturn`) and, on
      close (X button, Escape, or the route callback), rewrites the hash back
      to it. That rewrite sets `skipNextApply` so `applyRoute` does NOT
      rebuild the view: the view was never replaced, and re-applying `studio`
      would clear the imported model while `viewer`/`thread` would reload the
      model / rebuild the tree for nothing.
    - Navigating away while the panel is open (home button, any route change)
      still closes it, unchanged.
    - Verified by `scripts/network-panel.mjs` (16 checks): opens over and
      returns to board / viewer / thread / studio, the viewer's meshes and the
      studio's in-progress text survive the round trip, Escape behaves like
      the close button, a cold `#/network` load closes to the board, and
      navigating away while open still closes the panel.

57. DESCRIPTIVE PER-SERVER NETWORK STATUS (2026-08-18):
    A row in the network panel was a coloured dot and a hostname; it could
    not answer "is this relay actually doing anything for me". Each row is
    now two lines — host, then status / ping / throughput:
    - **Status in words, not just hue.** Relays: `connected`,
      `connecting…`, `offline` and `offline · retry N` (the pool's own
      backoff attempt count). Blossom servers have no persistent connection,
      so they report probe results: `not probed`, `probing…`, `reachable`,
      `unreachable`.
    - **Ping.** `RelayPool.ping()` times a REQ->EOSE round trip on the LIVE
      connection using a `#t` filter that can match nothing, so the relay
      does no work and the number is latency rather than query cost (the
      WebSocket API exposes no ping/pong frame). A relay that is not
      connected falls back to a fresh handshake via `RelayPool.probe`, and a
      successful `open()` seeds the ping from its own handshake so a row
      shows a latency immediately. `BlossomClient.probe` times its HEAD with
      `cache: 'no-store'` (a cached response would report a fake sub-ms
      ping). Both probes now return `{ ok, ms }`. Values are bucketed
      good/fair/slow (<150ms / <400ms / >=400ms) so 2400ms cannot read as
      fine.
    - **Per-server throughput.** `transfers.track()` takes a server ORIGIN
      and fans each transfer into a per-host meter as well as the global
      one, so a row shows its OWN `↓ 1.4 MiB/s ↑ 90 KiB/s` while busy and its
      own session totals when idle. Downloads are attributed by the replica
      URL's origin, uploads by the target server.
    - **Relays report events, not bytes.** Relay traffic is JSON on a socket
      we do not byte-meter; the meaningful number is how much of the feed
      that relay actually delivered, so the column shows `54 events` — or
      `no events` for a relay that is connected but silent, which is a real
      diagnostic.
    - The panel measures on open and re-measures every 8s while open, and
      repaints once a second (plus on every meter tick). Rows are reused and
      only their text mutates — `replaceChildren()` five times a second would
      churn the DOM and fight the remove buttons.
    - The old global TRAFFIC section is kept as `TOTAL / all servers`.
    - BUGFIX found by this work: **`--danger` was defined only under
      `body[data-theme="light"]`**, so in the default dark theme every
      `var(--danger)` resolved to nothing and the offline dot was invisible
      (also `.net-remove:hover`, `.studio-status.err`, `.hbtn.danger`). Added
      to `:root` with theme.ts's value `#FF674B`.
    - Verified by `scripts/transfer.mjs` (now 25 checks): status wording,
      bucketed ping, per-relay event counts, an unreachable server's copy and
      its painted dot, download attribution to the serving origin (and zero
      for a server that served nothing), a live per-server rate that does not
      leak onto other rows, and the fall back to per-server session totals.

58. CANCEL PUBLISH + HASH INTEGRITY (2026-08-19):
    - Studio publish used to disable the publish button, so an in-flight
      upload could not be cancelled. The same button now flips to **cancel**
      (kept enabled) and aborts every Blossom PUT via `AbortSignal` +
      `xhr.abort()`. Leaving the studio or Escape also cancels. A cancelled
      publish never signs or broadcasts the kind-1063 event.
    - Editing during export/upload tore the GLB: `GLTF2Export` / XHR read
      live scene buffers while gizmos and paint kept writing them, so the
      event `x` tag and the uploaded body diverged ("hash corruption").
      Publish now freezes the studio (no gizmos / paint / import / text
      rebuild) BEFORE export, then `freezeBlob()` copies the bytes into a
      private snapshot that later edits cannot touch. The event hash and
      the PUT body are that snapshot.
    - Models whose downloaded (or cached) bytes do not match the event `x`
      tag must not appear on the board. IndexedDB/RAM cache hits are
      re-hashed; a mismatch deletes the poisoned entry. Blossom download
      no longer skips the SHA check when the hash is empty (GLB always
      requires hex64). A confirmed mismatch sets `ThreadMeta.hashFailed`
      and drops the card from `orderedRoots`. Network-down is NOT a hash
      fail (`HashMismatchError` is distinct from "no replica").
    - Guard: `node --experimental-strip-types scripts/publish-unit.mjs`
      plus the cancel + wrong-hash cases in `scripts/verify-publish.mjs`.

59. MODEL CACHE IS KEYED BY CONTENT, NOT POST (2026-08-19):
    `AssetCache.getModel()` keyed its in-RAM blob cache and its in-flight
    dedup map by `eventId`. A model is the same bytes no matter how many
    posts embed it (reposts, replies reusing a GLB, or a poster render racing
    a live preview), so the same file was fetched once PER POST: a board of
    N posts sharing one GLB issued N downloads of the identical bytes.
    Both maps are now keyed by `sha256` (matching the already-content-keyed
    `modelBytes` and IndexedDB `modelCache`), so one model = one download,
    one decoded `Uint8Array`, one blob. `failHash()` drops the poisoned blob
    by sha256 too. Verified with the offline rig: 17 concurrent
    `getModelBytes()` calls for one sha256 now produce a single
    `/models/*.glb` request (previously 17).

60. BUILD FIX — PR #13 SHIPPED A DUPLICATED board.ts TAIL (2026-08-19):
    The board-tap change left the `Board` class followed by a mangled
    duplicate of the `resize()` tail (`erHeight()` — the `getRend` prefix of
    `getRenderHeight()` lost) plus a second `dispose()`, so `tsc --noEmit`
    and `build:standalone` both failed and the Pages deploy went red. The
    duplicated fragment is removed; the file now ends at the single
    `dispose()` + class brace.

61. HASH-FAILURE WIRING COMPLETED (2026-08-19):
    AMENDMENT 58 added the plumbing (`failHash`, `hashFailed`,
    `onHashFailed`, and the `del` / `blobMatchesHash` / `isHashMismatch`
    helpers) but `getModel()` never called `failHash`, so wrong-hash models
    still rendered on the board and `scripts/verify-publish.mjs` failed.
    `getModel()` now re-verifies an IndexedDB cache hit
    (`blobMatchesHash` → `del` + `failHash`) and records a download
    `HashMismatchError` via `failHash`; a network failure stays retryable
    (no flag).
