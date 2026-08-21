FORM/0 BUILD SPEC (condensed). A wordless multiplayer game of 3D shapes; browser-only, direct to Nostr relays + Blossom; one canvas, Babylon.js. Player creations = animated GLB models, own cameras, optional embedded audio.
Goals: (1) real content from public relays on first run, no seeding/config; (2) build:standalone -> ONE .html from file://, fetches only user content.

BUILD (gated): 1 skeleton (scenes==1); 2 relay pool >=20 real GLB events (Node script vs real relays FIRST); 3 Blossom+SHA >=10 match; 4 local poster render at the post's `dim`; 5 board recognizable; 6 RTT pool 4+ animate; 7 viewer/thread/network; 8 studio pass-through; 9 paint editor; 10 standalone file://.

NETWORK [MEASURED]: filter {'#m':['model/gltf-binary','model/gltf+json']} -> 66/66 (bare kinds = 94% junk); never '#t':['3d']. 0/46 events carry poster tags -> render posters locally (format v4: posters are ALWAYS local, `dim` gives the size). url x2 = replicas; ox = hash fallback. relay.nostr.band flaky. form-zero exists (24 posts, 12 replies/7 roots): subscribe {'#t':['form-zero']} + {'#m'} + {kinds:[5]}, merge. >20MiB -> "too large". Draco mandatory, local decoders, no CDN.

TRAPS: 1 SVG utf8 URI never loads -> PNG. 2 emissive+texture=white -> 0,0,0. 3 ScrollViewer calc()=transparent -> pixel heights. 4 GUI can't sample RTT -> meshes 1px=1unit. 5 rejection Map<'STATIC'|'FAILED'>. 6 scene audio emitter distance props reject GLB. 7 import screenshotTools/loaders. 8 SVG needs width/height. 9 BOOT/BOARD share '#/' -> compare names. 10 ARIA active scene only. 11 file dialog trusted click. 12 refreshRate=ceil(active/slotsPerFrame)+phase. 13 re-run npm i; never commit dist/.

CARD: flat plate (NEVER noise) -> local poster (smallest first, t=0, cache by SHA) -> live RTT. Crossfade 120ms.

PRODUCT: BOOT->BOARD->(THREAD->VIEWER|EDITOR, VIEWER, EDITOR, NETWORK). Card: render + audio/thread glyphs + ownership + !; viewer via main, thread via corner. Rhythm: 9th tall/5th wide, seeded shuffle. Viewer: one model, feed paused. Thread: tinted root, tombstones. Publish ring hash->Blossom->relays, partial amber. Network panel: only URLs. Errors: sheet, never '!' alone.

VISUAL: wordless = no labels, not no legibility; mandatory first-run legend (reopenable, seen-flag IDB). Indicators blink: NONE hollow/CONNECTING pulse/PARTIAL amber+notch/FULL static/RETRYING double-blink; reduced-motion -> dashed. One glyph = one meaning, PNG, >=44px, hidden a11y names. Audio: hint tag, verify bytes, no autoplay. Text only: legend/drawer/network/numbers/user text/errors/ARIA/fatal.

RUNTIME: 1 canvas/Engine/context, swap scenes; no per-card canvas; GLB near viewport only; bounded RTT pool; viewer = 1 model + paused feed; empty content; preserve names/hierarchy/cameras/anims. Scenes board/viewer/editor/ui. Cards = meshes 1px=1unit; virtualize ~48. Slots: 8 max (4 low-mem), isolated RTT+layer mask, hysteresis .55/.95, animated-only, adaptive 192-512px, rebind every frame. Budgets: 20MiB/1.5MiB/8MiB/48/240/22ms/3/50k@60fps. Dispose on close; 100 cycles no growth; per-post try/catch.

FEED: placeholder->poster->prefetch->slot->RTT->poster. Load: query+deletions->verify->index->layout->posters->slots; never 48x20MiB. Animated? v3 hints else preflight. Poster: t=0, ALWAYS locally rendered at the post's `dim` (default 448x280), same camera policy. Camera: preview-camera->animated->imported->auto-fit; anim: preview-anim->camera->model->static; no cuts. Reply: parent never loaded.

PIPELINE: glb byte-for-byte; gltf/obj via virtual FS -> repack; never auto-rename/merge/bake/center/scale; unknown ext rejected; external URIs forbidden. GLTF2Export.GLBAsync(shouldExportNode); pass-through never exports. PreservationReport: loss blocks publish (fail closed). Audio -> repack, hash changes. Poster from published bytes. Errors name originals.

EDITOR: brush paint in 3D, not CAD. GRID 0.05 != CUBE 0.25, overlap, never dedupe by cell. Stroke stamps (spacing, interpolation, jitter, pressure, align-to-direction); shapes cube/sphere/cylinder/tetra/quad; RGBA+PBR. Paint plane or surfaces, depth lock. Eraser + undo >=100. Selection: 5 modes; solid/x-ray/wireframe visibility. Transform G/R/S, axis, pivots, AABB, snap. Data: flat store + thin instances + spatial hash + GPU ID picking; 50k@60fps. Nav: view keys, view cube, mouse presets, touch. Tools: brush, eraser, select, transform, plane, picker, text, import, audio.

TEXT+ANIM: text = real flat low-poly geometry (NOT textured quad), FORM <120 tris; pixel-font table + run-merge. Anim: tracks -> node props, keyframes {time,value,LINEAR|STEP|CUBICSPLINE}, RECORD keyframing. Camera anim fly-throughs, export real glTF (quaternion sign guard). FRAMING: auto-fit faces content (dominant facing), same policy poster+RTT. Acceptance: <120 tris, round-trips, 30s/200keys >=55fps.

PROTOCOL: relays damus.io/nos.lol/primal.net + nostr.band (flaky). Filters {'#m':[gltf-binary,gltf+json]} + {kinds:[5]}; mime recheck. v2 tags: t/m/x/size/url/server/color/v/e(root/reply); v3 added preview-camera/animation (index), anim/cameras/camera-anim, filename/source-format/source-filename; v4 REMOVES the thumb PNG tags (posters are only ever rendered locally from the model) and adds dim (WxH, the local poster render size; validated 64..4096 px, aspect 0.5..2, default 448x280). Parse: multi-url replicas, x->ox, NIP-10. Publish: empty content, url(xN)/m/x/ox/size/dim/f flags/e tags, nostr-tools, 1/3=partial — model bytes only, no poster upload. Kind-5: pubkey match, tombstones. Blossom: blossom.primal.net + cdn.satellite.earth, replicas, SHA-256; BUD-01 (kind-24242). Audio: KHR_audio/MSFT_audio_emitter, append BIN, <=8MiB. IndexedDB: posts/posters/blobs/owned/config, forward-only, never deleteDatabase(), secrets AES-GCM, poster LRU.

SECURITY: trusted = bundle + nostr-tools + Babylon; else untrusted until verified (sig/schema/size/URL/cycles). Blob: cap, no credentials, timeout, SHA-256, magic/length, no cross-origin redirects. GLB limits: 20MiB, 2MiB JSON, 2k nodes, 500 meshes, 2M verts, 6M idx, 256 mats, 64 tex, 128MP, 32 skins, 16 cams, 32 lights, depth 128; re-verify, dispose on mismatch. GPU: caps, one model, contextlost -> stop. Secrets: per-post keys, envelope only. Endpoints: wss:/https: only, no localhost. Privacy: IP visible, deletion != destroy, per-post key unlinks.

PERF: <=200 events, 48 roots; poster is a local render (no transfer); model 8/20MiB. Pool: desktop 6/8 @512, tablet 4 @320, mobile 2 @256, reduced-motion 0. Frame 16.7ms: board<=4/RTT<=7/JS<=3/reserve>=2. Score: visibility x centerProximity x animationValue x readyBonus - loadCost. Adaptive degrade->posters. Gates: 100 cards x10, 100 cycles unchanged.

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
   a blank poster -> the card shows the quiet failed plate (format v4: the
   studio neither renders nor uploads a poster, so there is no placeholder
   PNG to fall back to). Live previews use
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
    (`protocol/verify.worker.ts`) is `?worker&inline` (poster PNGs were removed
    in AMENDMENT 65). Blob workers, which the
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

62. POST FORMAT V4 — NO POSTER PNG IN THE EVENT; `dim` DECLARES THE POSTER
    SIZE (2026-08-20): the thumb/thumb-x/thumb-size/thumb-dim tags are GONE
    from the kind-1063 format. Posters are ONLY ever rendered locally from
    the model bytes (poster scene, camera policy per §6) at the size the
    event declares in `dim` (`WxH`, e.g. `448x280`; validated 64..4096 px
    per side and aspect 0.5..2, falling back to 448x280 when absent or
    unusable — so older v3 posts parse unchanged). The studio generates NO poster at
    all — publish just stamps `dim` with the default render size (448x280)
    and uploads the model GLB as the ONLY blob. Downstream: `ThreadMeta`
    carries width/height instead of thumbUrl/thumbSha256/thumbSize;
    `AssetCache` renders posters at `dim` (POSTER_CACHE_V p5, cache key
    includes the size; the PNG download path is deleted — blossom download
    is GLB-magic only); owned-post records no longer store poster fields;
    the board sizes each card quad from the post's aspect (width fixed at
    16 world units, band layout = tallest card in the row of N columns,
    shorter cards centred in the band) and the thread map sizes each node
    quad the same way; the shared live-preview RTT keeps the 16:10
    reference aspect. `v` tag is `form-zero:4`.

63. STUDIO CARD PREVIEW + FULL-PAGE RESIZABLE PREVIEW; `dim` IS AUTHOR
    CHOSEN (2026-08-20): the studio shows the exact card a creation will
    get — a corner preview in the stage's upper-left (a live local poster
    render of the current content, debounced ~600 ms after any edit:
    paint/text/gizmo/camera changes fire `studio.onDirty`). Clicking the
    image hides it (state persists in localStorage); a "◱ card" pill
    reveals it again. The ⤢ button opens a FULL PAGE: the card on a canvas
    with a corner drag handle. Dragging resizes the canvas (live CSS
    stretch during the drag; re-render at the released resolution), bound
    by the format's `dim` limits (64..4096 px, aspect 0.5..2). The chosen
    size becomes the event's `dim` at publish (reset to the 448x280
    default on entering the studio for a fresh post). offline-verify's
    empty-stage tap now hides the preview first (covering the hide/reveal
    pair as a side effect).

64. VERIFY ON LOAD — HASH WINS (2026-08-20):
    AMENDMENT 61 still left holes: RAM cache hits were returned unverified,
    `blossom.download` skipped a replica when `size` ≠ byte length BEFORE
    hashing (a stale size tag false-refused a hash-valid body), and the
    thread map neither filtered `hashFailed` nor tore a node down on
    mismatch. Format v4 already forces every plate through a local render
    (`getModelBytes`), so a remote thumb can no longer skip the GLB hash.
    Policy (overrides 58/61 where they conflict):
    - Hash every blob/bytes before return from `getModel` / `getModelBytes`.
      Cache key = claimed sha; key-exists ≠ bytes match. Poisoned IDB/RAM
      → delete + redownload (do NOT failHash — the event `x` may be honest).
      Confirmed download mismatch → `failHash(meta)`. Never store unverified
      bytes. Empty / non-hex64 `x` is a refuse (`parse` already requires it).
    - Size is a progress meter and a stream cap
      (`total > max(size, modelBytesHard)`), never a refuse. Hash matches
      `x` → ACCEPT even if the size tag is wrong (local `meta.size` is
      repaired). Hash mismatch → refuse, hide. Oversize and network errors
      are distinct from `HashMismatchError` and do not hide the post.
    - On `hashFailed` tear down the board card AND the thread node
      (`dropNode`, dispose poster). Verify at first byte use (poster /
      preview / viewer), then evict. Hide only on confirmed hash mismatch,
      never on network failure.
    - Thread: `flatten` / `ThreadView.open` skip `hashFailed` and
      tombstoned; `onHashFailed` calls `threadView.dropNode` and leaves
      the thread if the open root failed.
    - `validateGLBCached` is memoised by the actual `Uint8Array` identity
      (WeakMap), not the claimed sha.
    - Guard: `scripts/hash-unit.mjs` + `scripts/verify-hash.mjs`.

65. POSTERS RENDER TO A TRANSPARENT RTT, NEVER A PNG (2026-08-19):
    The card texture IS the offscreen render target. PosterRenderer allocates
    a dedicated transparent RTT per post (`scene.clearColor = (0,0,0,0)`,
    `refreshRate = RENDER_ONCE`, then detached from `customRenderTargets` so
    the next poster.scene.render() cannot wipe earlier cards). No PNG, no
    pixel cache, no blank-check retry loop: cards sample the RTT in place
    (VRAM stays VRAM). Camera choice is a CPU frustum-vs-AABB test — an
    authored camera that misses the model falls back to auto-fit without
    reading the framebuffer. Pixel blank-checks were a waste: existing posts
    are visible in the viewer anyway, and the probe burned 14 readbacks +
    sleeps per card. `readPixels` runs only for studio preview / test probes
    (`snapshot()`). Opaque materials write alpha=1; the card shader treats
    non-black RGB as coverage. IDB keeps anim/footprint flags only (p7).
    Guard: offline-verify + verify-publish sample a one-shot snapshot.

66. STUDIO MODEL INFO, EVENT `content` CARRIES THE MODEL NAME, STUDIO
    ADDITIONS REMOVABLE (2026-08-20):
    - The studio upload tab shows an info card for the imported model: name,
      source format, size, vertices, triangles, meshes/parts, materials,
      textures, decoded texture memory, cameras, lights, skins, animations —
      all from the `validateGLB` safety-scan report (measured, not claimed).
      The size number and its meter run GREEN at 0 bytes to RED at the 20 MiB
      hard limit (`sizeHeatColor`, an RGB lerp of the theme success/danger
      endpoints). Big (>= the 8 MiB recommendation) and near-limit (>= 70% of
      any cap) models show AMBER warnings in the card and a status hint;
      over-limit / hostile models are still REFUSED at import with the scan
      reason shown in red.
    - The nostr event `content` (always '' before) now carries the model
      NAME: file base name for an imported model, first typed line for a
      text post (`modelNameForPublish`; single line, control chars stripped,
      capped at LIMITS.contentChars = 140). `parseModelEvent` accepts content
      up to 140 chars (landed on `ThreadMeta.name`, searchable and shown in
      the info drawer) and still accepts the legacy empty content; longer
      content is off-format and the event is skipped. NOTE: clients older
      than this amendment REQUIRE `content === ''` and will skip named
      posts; every tag is unchanged (`v` stays `form-zero:4`) — the name is
      additive metadata only.
    - Empty text adds NOTHING to the model: the '/0' seed applies only when
      no model is imported, a no-op `rebuildText()` no longer dirties
      anything, and a stale text mesh (cleared within the rebuild debounce)
      is dropped at publish time.
    - Byte-identity rule: publishing an imported GLB ships the imported bytes
      unless the player added text/paint/cameras or moved/deleted imported
      meshes. Text, paint and camera additions are OBSERVABLE state
      (textValue / paint.count / storedCameras), so removing them restores
      the pass-through automatically; only gizmo drags and mesh deletes set
      the sticky `meshEdits` flag (the old blanket `contentDirty` made even
      an undone text rebuild re-export the model). The upload tab's
      "remove additions" button re-imports the pristine bytes into the
      studio — reverting even moves — so the model publishes bit-identical
      again (the only exception is a model whose bytes fail the safety scan,
      which never imports at all).
    - Guards: `scripts/model-info-unit.mjs` (name/heat/warning helpers),
      `scripts/studio-unit.mjs` (pass-through, restore-on-remove, reset,
      publishModel content + byte-identical upload end-to-end), and
      verify-publish asserts `meta.name` on the received events.

67. STUDIO SYMBOL LIBRARY (2026-08-20): the symbols tab is a drop-in set of
    low-poly 2D plates and 3D primitives (emotions, reactions, statuses,
    shapes, objects) shipped as self-contained GLBs under
    `src/studio/library/glb/` (traced plates in `library/2d/`). Clicking a
    cell ADDS the mesh to the studio scene (it does not clear an imported
    model). Faces are authored CCW / outward so lighting cannot invert. No
    cameras/textures/skins/animations. Vertex colours/normals are quantized
    (`KHR_mesh_quantization`); Draco is applied only when it actually
    shrinks the file. 2D plates stay flat — never extrude a plate into a 3D
    counterpart. Image plates are traced PNG→quantize→contour→earcut
    (`scripts/trace-2d-glb.py`); triangles share z=0 (no stacked layers,
    no z-fighting); source art is not committed (regenerate via the tracer).
    Posters auto-fit; the author can still +cam.
    Guard: `node scripts/library-unit.mjs`.

68. LIBRARY SYMBOLS LOAD + TINT MODULATES VERTEX COLOURS + PER-ITEM COLOURS
    (2026-08-20, corrected 2026-08-21): two defects were closed, the tint
    approach was revised, and then colours became per-item.
    - DEFECT A — Draco decode was CSP-blocked, so every library piece (and
      every other Draco-compressed model) FAILED to load in both builds.
      The GLBs ship `KHR_draco_mesh_compression` and the local decoder
      (src/model/draco.ts, wasm + zero workers, no CDN) compiles its wasm
      with `WebAssembly.instantiate`, which Chromium gates on the
      `'wasm-unsafe-eval'` script-src keyword. Neither CSP had it: the web
      build refused with a `script-src 'self'` violation and the standalone
      with a `script-src 'unsafe-inline' data:` violation — the error an
      upload showed as “…Refused to compile or instantiate WebAssembly
      module… unsafe-inline…”. Both CSPs (csp.ts) now include
      `'wasm-unsafe-eval'` (a wasm-compile permit, NOT `'unsafe-eval'`:
      no string eval is enabled). WEB_CSP connect-src also gained `data:`
      (the library GLBs are inlined as data: URIs in both builds) and
      `http://localhost:* http://127.0.0.1:*` so the dev / preview servers
      can serve the Draco wasm/js assets over plain http.
      The symbols tab no longer fails silently: placement errors now
      surface in the error sheet (code E301) AND the studio status line,
      exactly like import errors do.
    - DEFECT B (corrected) — initially the fix used `useVertexColors=false`
      + `albedo=Black` + `emissive=tint`, which made the tint FULLY
      replace the model's colour — the original vertex colours were lost
      and a neutral grey tint still showed as solid grey. The library GLBs
      carry per-vertex COLOR_0 (VEC4); the shader should modulate those
      colors, not discard them. `tintMesh` keeps `useVertexColors=true`
      and sets `albedoColor` to the tint, so the tint MULTIPLIES with the
      vertex colours (final = tint × vertex). This way the original model
      colours remain visible — a white tint leaves them unchanged, a grey
      tint dims them proportionally, and a coloured tint shifts the hue
      without losing the shape's shading. `emissiveColor` is Black.
      The text tool (buildTextMesh) continues to use the old emissive
      approach because text geometry has no vertex colours.
    - PER-ITEM COLOURS (2026-08-21) — every placed symbol and the text
      carry their OWN colour instead of sharing one studio tint. The colour
      picker sets the colour of the NEXT placement; selecting a symbol or
      the text mesh loads its colour into the picker and repainting
      repaints only that item (`studio.setSelectedColor` /
      `getSelectedColor`, per-container `extraColors` map). Text has its
      own `textColor` (baked at rebuild). The global `tint` remains the
      fallback for placements without an explicit colour and the event
      `color` tag follows the most recently placed symbol's colour.
    - Size stays put: the library is still ~103 KiB and the standalone is
      ~4.4 MB; the wasm decoder path is used as before (no fallback JS
      decoder inlined as a new dependency).
    Guards: `node scripts/library-unit.mjs` (size + GLB invariants),
    `npx tsc --noEmit`, and a browser round trip (place → per-item
    repaint → delete → publish carries the tint).


69. PER-CARD PLAY/PAUSE + AUTOPLAY SETTING; POST AUDIO PLAYBACK LANDS
    (2026-08-20):
    - Every board card and every thread node carries a ▶/⏸ button (Babylon
      mesh, bottom-LEFT corner — the reply badge/pill owns bottom-right, so
      the two never overlap). The button toggles the post's live preview:
      ▶ starts the animation AND the model's embedded audio, ⏸ pauses both
      in place (the frozen frame stays on the card; paused slots are not
      render work, so the board still idles at ~0 fps). Icons are shared
      vector-drawn textures (play triangle / two pause bars), never font
      glyphs. The button is hidden for posts that cannot animate (poster-
      render knowledge or v3 anim/camera hints, overridden by the pool's
      STATIC/FAILED verdict) and when livePreviews = 0 — a control that can
      never start a slot is a dead control.
    - Settings → Interface gains "Autoplay animations" (`autoplayAnimations`,
      default ON = the historical auto-animating feed; OFF = everything opens
      on its poster, the ▶ button is the only way to start). Turning OFF
      pauses auto-started slots in place (user-started plays keep running);
      turning ON resumes them. A post the user paused is never auto-restarted
      (pausedByUser latch), and a post the user started keeps playing with
      sound even with autoplay off (manualPlay latch). Both latches survive
      slot recycling and live as long as the post is in the feed / tree.
    - SOUND ONLY STARTS FROM THE BUTTON TAP. Autoplay animation is always
      silent — browsers block audio without a user gesture, the SPEC's audio
      line says "no autoplay", and a scrolled feed of N live cards must not
      play N sounds. The ▶ tap is the gesture that unlocks the AudioContext.
    - POST AUDIO PDMENT 26's "when audio playback lands"
      is now): the curated loader registers MSFT_audio_emitter, so GLBs with
      embedded audio create Babylon Sounds on load. Babylon builds every
      Sound on a page-wide AudioEngine singleton; boot now points that
      singleton at the app mixer's AudioContext + master bus
      (`AbstractEngine.audioEngine = new AudioEngine(null, ctx, masterGain)`),
      so post sound obeys master volume and mute-on-blur. PreviewPool claims
      each container's Sounds (by node attachment, plus a bounded delta for
      scene-level emitters — a claimedSounds set makes one owner per sound
      under concurrent loads), plays them on ▶ (with a bounded decode-retry
      for clips still loading), pauses/stops them with the animation, and
      disposes them on slot release / viewer handoff (the viewer itself never
      plays audio — its A key remains animation-only).

70. SEARCH QUERIES CONTENT + OWN POSTS SELF-INDEX (2026-08-20): a published
    post entered the local index ONLY through the relay echo, so a fresh
    upload could be invisible to the board and to search ("uploaded bush.glb
    twice, query 'bush' shows none"): echoes can lag or never arrive, and
    the NIP-50 remote fallback cannot see posts a relay index has not
    ingested yet. Fixes:
    - The board search filter is a named, testable matcher
      (`matchesSearchQuery` in thread-index.ts): case-insensitive substring
      over the published `filename`, its base name, the post `content`
      (the model name, AMENDMENT 66) and the event id. The search panel
      advertises this ("name or content" placeholder/hint/legend) and the
      "shown N models" hint live-updates as remote or restored results
      stream in.
    - `publishModel` returns the signed kind-1063 event; the app parses and
      self-indexes it the moment the publish succeeds — the post is on the
      board and searchable immediately, no echo dependency (the echo, when
      it comes, re-adds the same meta harmlessly; the 8 s echo-wait before
      routing is gone).
    - The owned-post record persists a bounded, strictly validated meta
      snapshot (`OwnedPostMeta`; pubkey, mime, size, tint, dim, filename,
      content name, source format, cameras/anim/audio flags). At boot the
      app rebuilds each own post's ThreadMeta from that snapshot
      (`ownedToMeta`) — own posts stay on the board and findable after the
      live feed's window (14 days / limit) drops them. Records older than
      the snapshot (no meta) rely on the feed like any foreign post.
    - Deletion cannot be undone by the restore: `doDelete` and relayed
      kind-5s for own posts persist a `tombstoned` flag on the record
      (`markOwnedPostTombstoned`), and boot restore skips tombstoned
      records.
    Guards: `bun scripts/search-unit.mjs` (filter semantics, snapshot
    rebuild, tombstone persistence) + `studio-unit.mjs` publish checks
    (signed-event return + persisted snapshot round trip); tsc, vite and
    standalone builds clean.

71. OWN POSTS LOAD FROM THE VERIFIED SNAPSHOT + E101 DIAGNOSTICS
    (2026-08-20): a freshly published post could still fail to load with
    E101 ("hash or size mismatch") even though the upload succeeded — the
    load path is a download + SHA-256 verify against the Blossom replicas,
    so a replica that serves different bytes (or none) broke the AUTHOR's
    own view, with no hint which server failed. Fixes:
    - `publishModel` returns the frozen upload snapshot (`sha256` +
      `bytes` — the exact body that was PUT and that the event `x` tag
      hashes). The app seeds the verified model caches with it
      (`AssetCache.seedModelBytes`, hash-checked before it is accepted),
      so the author's own post opens from local bytes with ZERO network
      round trips — replicas that serve bad bytes, redirect, or are
      unreachable can no longer break the author's own view. The hash
      check still runs on every cache read (AMENDMENT 64), so a poisoned
      seed can never reach Babylon.
    - E101 is no longer a black box: `BlossomClient.download` records
      every replica's outcome (server, HTTP status, hash mismatch with
      the sha256 it actually returned, body-over-cap, redirect/network
      error) and folds them into the thrown error; `AssetCache` keeps the
      last failure per event and the error sheet shows it ("No verified
      replica available — nostr.download: HTTP 404; …").
    - gzip rescue: a body that starts with the gzip magic but does not
      hash to `x` is inflated once (DecompressionStream, when available)
      and re-hashed before the replica is given up on — some stores serve
      pre-compressed bytes without a Content-Encoding header, and the
      browser then hands the client gzip bytes for a model the server
      holds intact. The hash remains the sole arbiter.
    Guards: `bun scripts/load-unit.mjs` (exact/truncated/gzip/404/oversize
    replicas, per-replica diagnostics, seeding with zero-network read) +
    `studio-unit.mjs` snapshot check; tsc, vite and standalone builds
    clean.

72. FRESH POSTS CANNOT RACE THEIR OWN UPLOAD + E101 RETRY REALLY RETRIES
    (2026-08-20): reported as "uploaded bush twice, they always fail to
    load due hash or size mismatch — right after upload; old models show
    correctly". The servers were not the story: a published post is
    fetched by the client SECONDS after its PUT (the relay echo → board
    card → poster render), while the blob can still be settling on the
    CDN. ONE bad first fetch called `failHash`, and that mark was
    permanent for the rest of the session — no code path ever cleared it
    or re-attempted the download, so every later tap replayed E101
    without touching the network. Old posts never race their own upload,
    so they were never marked. Fixes:
    - Seeding wins the race: `publishStudio` now seeds the verified
      upload snapshot (AMENDMENT 71) BEFORE self-indexing the post
      (`refreshBoard` → preview pool). The pool's first fetch hits the
      local cache — own posts never touch the network at all, so the
      CDN race cannot mark them.
    - Failure marks are revocable and retry is real:
      `AssetCache.unfail()` clears the event's hash-failure + failure
      detail; `ThreadIndex.unrejectHash()` clears the meta flag; the
      E101 sheet's action now runs `retryModel()` (clear both, re-list
      the card, re-open and re-download) instead of just routing to the
      board. Verified local bytes, when present, serve immediately after
      the clear.
    - The viewer error split is honest: download/verify failures show
      E101 (with per-replica detail, AMENDMENT 71); E102 remains for
      model bytes that fetched and verified but failed GLB validation
      or the loader.
    Guards: `bun scripts/load-unit.mjs` (marked post refuses while the
    flag stands; unfail + retry serves the seeded cache again) +
    `search-unit.mjs` (rejectHash/unrejectHash round trip); tsc, vite
    and standalone builds clean.

73. IDLE OOM — RELAY RECONNECT MUST NOT STACK SOCKETS (2026-08-20):
    Leaving the tab open used to crash with an out-of-memory after a long
    idle. Relays drop idle connections and background tabs get their
    WebSocket killed; each drop scheduled THREE retries (ws.onerror,
    ws.onclose, and `connect()`'s reject) and `open()` built a new
    `Relay` without closing the previous one, so sockets + REQ subs
    grew without bound. Fix:
    - One in-flight `open()` per URL (`opening` Map keyed by the Relay
      instance so applyRelays mid-connect cannot clear a newer attempt).
    - `dropRelay` closes the previous socket + REQ before a new one is
      created; `subs` is a Map keyed by URL, not an append-only array.
    - `onclose` during `connect()` does not retry — the catch path does,
      once. `scheduleRetry` is idempotent (one timer per URL).
    - `connect({ timeout: 8000 })` so a hung handshake cannot pin a
      socket forever.
    - Verify-worker jobs time out at 8s (a stuck worker used to pin
      every event in `jobs` forever while relays kept sending).
    Live preview GLBs are NOT dropped on idle or on hide — they are
    small, already capped by settings (livePreviews / keepOffscreen /
    modelRamBudget), and dropping them just re-parses on wake.
    Guard: `npx tsx scripts/relay-pool-unit.mjs`
    (failed handshake retries once, eight remote drops stay at 1 live
    socket, close() stops the loop, applyRelays/connect are idempotent).

74. VERTEX COLOURS RENDER IN VIEW + POST LIKE IN STUDIO (2026-08-20):
    reported as "make vertex color work in view, post like in studio".
    The studio was fine everywhere (it loads the same GLBs); the viewer and
    the board poster both lost the colours. TWO independent bugs shared the
    symptom, both on the load/render path the studio never exercises:
    - DRACO MAIN-THREAD DECODE DROPPED `normalized` — library GLBs carry
      quantized vertex colours (`KHR_mesh_quantization`: COLOR_0 is
      `{componentType: 5121 (u8), type: VEC4, normalized: true}`) with
      `KHR_draco_mesh_compression`. The app decodes Draco on the main
      thread (`configureDraco` in src/model/draco.ts sets `numWorkers: 0`
      and ships the wasm inline — no CDN, see AMENDMENT 68). Babylon's
      `DracoDecoder.decodeMeshToMeshDataAsync` has TWO paths: the worker
      pool applies the KHR_draco extension's `gltfNormalizedOverride` map
      to every decoded attribute, but the single-module path returned the
      buffer with `normalized: false`. The vertex shader then read the raw
      bytes 0..255 as floats — every channel ≥ 1 — and the PBR material
      rendered a uniform white slab (verified by pixel sampling: the red
      heart library symbol rendered solid white in the viewer). The plain
      (non-Draco) loader was never affected (glTFLoader passes
      `accessor.normalized` straight into the VertexBuffer, which is why
      hand-imported models always looked fine). The studio LOOKED fine
      with the same broken bytes only by accident: placed symbols set
      `albedoColor` to the tint and multiply it with the vertex colours,
      so white-clipped channels (all ≥ 1.0) still read as saturated hues
      modulo brightness — the wash-out only becomes obvious in the
      plain-PBR viewer/poster. Fix: src/model/
      draco.ts monkey-patches `DracoDecoder.prototype.decodeMeshToMeshDataAsync`
      to apply the normalized override exactly like the worker
      path does (idempotent — a no-op once/if Babylon fixes it upstream,
      because it only corrects attributes whose flag differs from the
      accessor's).
    - PAINT BAKE EXPORTED A FIXED GREY EMISSIVE — the studio paint stroke
      preview (thin instances, StandardMaterial, emissive 0.55) shows
      saturated ink because the STANDARD shader clamps
      `diffuse + emissive` to [0,1] before multiplying the vertex colour.
      The publish bake (`bakeStamps`, paint/bake.ts) reused a 0.55 grey
      emissive on the EXPORT-ONLY material; the exported PBR metallic-
      roughness factors came out `emissiveFactor [0.55,0.55,0.55]`, and in
      the PBR shader `surfaceAlbedo *= vColor.rgb` while emissive is added
      UNMODULATED — a constant grey floor that washed every stroke to
      pastel in the viewer/poster. The bake material's emissive is now
      Black: vertex-colour strokes export as pure albedo×vColor, matching
      what the studio shows. (Diffuse white stays — the glTF exporter's
      0.5-scale linear conversion is the STANDARD convention and cancels
      out; emissive was the only channel that broke the hue.)
    Guards: `npm run check:vcolor` = three render suites against the dev
    server (`scripts/vcolor-check.mjs` — viewer: plain-u8 control plus the
    draco heart/cube library GLBs, asserting the decoded VertexBuffer has
    `normalized: true` and pixel hue dominance; `scripts/vcolor-poster.mjs`
    — the board's PosterRenderer in-process; `scripts/vcolor-paint.mjs` —
    studio paint strokes through `getContentForPublish` into the viewer,
    asserting no fixed emissive in the exported materials and all three
    inks rendering saturated). Proof shots: `.test-shots/shot-draco-hea.png`
    (red heart in the viewer), `.test-shots/shot-viewer-paint.png` (three
    painted inks). Browser acquisition for the sandbox is documented in
    docs/SANDBOX-VERIFY.md (2026-08-20 section); the shared launcher is
    `scripts/browser.mjs`.

75. DIRECT-3D CARDS (BOARD + THREAD), TOGGLED BY A BUTTON (2026-08-20):
    A topbar cube button (persisted as settings → Interface → "Show posts as
    3D models", default OFF) swaps the board AND the thread map from poster /
    render-to-texture rendering to the posts' REAL GLB meshes rendered
    directly in the visible scene — no poster, no offscreen RTT. Each model
    is rotated by inverse(main-camera rotation) (AMENDMENT 43's 3D framing)
    so the static flat camera sees exactly the view the author framed;
    models without a camera auto-fit via dominantFacing. Uniform scale fits
    the oriented AABB into the card/node cell (0.7 fill so corner badges stay
    clear). A bounded Direct3DPool (`src/board/modelCard3d.ts`) mirrors the
    preview pool's load/evict/audio-claiming, but adds the meshes to the
    board/thread scene under a root→orient→fit chain instead of a hidden
    stage: models load only near the viewport (same budget as posters),
    release on scroll/pan-away, animate in place under the existing autoplay
    + per-card ▶ gating (sound still needs the tap), and fall back to the
    poster pipeline when a 3D load fails. Static models simply render (no ▶).
    Verified: tsc + vite + standalone builds clean; orient.mjs passes; a
    headless probe renders a local GLB through Direct3DPool
    (request → onPlaced → isLive → release); the button toggle persists
    across reload with no page errors.

76. OVERLAY DRAW ORDER — CARDS/NODES MUST NOT PAINT OVER THEIR BUTTONS
    (2026-08-20):
    A board card's reply badge and play button (and a thread node's reply
    pill and play button) are corner-mounted planes that float in FRONT of
    their card/node in z, yet the post could still paint over them — the
    user saw "posts appear in front of their buttons". Babylon sorts
    transparent meshes back-to-front by the distance from the camera to
    each mesh's bounding-sphere CENTER (`RenderingGroup.defaultTransparent
    SortCompare`). A corner button's center is several world units off its
    card's center, so a card near screen-center sorted CLOSER than its own
    buttons and drew on top of them wherever its opaque poster/live pixels
    reached the corner (position- and content-dependent — hence
    "sometimes"). Fix: the overlay meshes (badge + play on the board,
    reply + play in the thread) render in `renderingGroupId = 1`, which
    Babylon renders after group 0 (cards/nodes/backdrop), independent of
    the distance sort — they are always on top. Depth convention is
    unchanged (smaller z = closer; overlays at z ≈ -0.05…-0.12, cards 0).
    Guard: `node scripts/overlay-order.mjs` (asserts overlays are group 1,
    cards/nodes group 0, overlays geometrically in front, and that a
    centered card's center sorts nearer than its own button).

77. DIRECT-3D CARDS BUGFIX (2026-08-20): the AMENDMENT 75 toggle shipped several
    real bugs. Fix:
    - `release()` of a still-loading post must CANCEL (same as PreviewPool),
      not drop the id from `loading`. Dropping it let the parse land on a
      recycled card (two models, or the wrong model). Scroll-back un-cancels.
    - A full pool is not a failure. Capacity misses used to set `slot.failed`
      and fall back to the poster forever; only the first N cards ever went
      3D. Retry every visibility pass; fall back to the poster only when the
      pool actually rejected the post (bad bytes / over-cap).
    - Eviction uses the caller's fresh visible set, not stale `slot.visible`
      (the same deadlock AMENDMENT 48 documented for the preview pool). The
      board now calls `pool3d.tick()`.
    - Thread 3D loads only near the viewport. Toggling 3D / opening a tree
      used to request EVERY node and fill the 6-slot budget with offscreen
      models (and leave every spinner running, so the thread never idled).
    - Imported GLB lights and cameras are disabled — they lit neighbouring
      cards. The pool's own rig is the only light; leftover board dummy hemi
      is disabled so PBR is not double-lit.
    - Models are centred on the card/node plane (z=0) with depth
      0.4·min(w,h) so they do not poke behind the opaque backdrop (board z=2)
      or through the contact shadow (moved to z=1.9 in 3D). Overlays (badge /
      play / spinner / reply) render in group 1 so a post cannot paint over
      its buttons. Transparent card materials disable depth write (an
      opacity-0 tap target must not occlude the model).
    - A 2D poster requested BEFORE the 3D toggle resolves asynchronously and
      used to land on the card quad over the live model. Both views bump a
      mode-generation counter on every 2D↔3D switch and drop poster results
      whose generation is stale. A stale preview-pool release must not
      re-show a poster over a direct model.
    - The no-camera auto-fit rotation was `FromUnitVectorsToRef(facing, -Z)`;
      for opposite vectors that picks an arbitrary 180° axis and flips flat
      models. It is now the exact inverse of the poster's auto-fit camera
      (`LookAtLH(eye=facing, target=0, up≈+Y)` → quaternion).
    - A load that completes after the feed scrolled landed at the cell
      captured at REQUEST time. The pool keeps the latest pending place per
      post and applies it on completion (models stay glued to their cards).
    - FormEngine calls `engine.beginFrame()`/`endFrame()` so
      `getDeltaTime()` is real. Without that, AnimationGroup.start() on
      direct-3D cards never advanced (demand-driven RAF is not
      `runRenderLoop`). The viewer's TrackAnimator is unchanged (it pauses
      the group and drives `goToFrame` itself).
    - Thread `sync3D()` / `request3D()` MUST no-op when the 3D toggle is off.
      `onBeforeRender` used to call `sync3D()` every frame even in 2D, so
      opening a thread as posters also parsed every in-view GLB into the map
      (main-thread freeze) and left overflow spinners running (isAnimating
      latched → 30 fps forever).
    - 2D thread posters are viewport-gated too (`syncPosters`). open() used
      to getPoster() every node in the tree; a large thread froze the tab.
      Failed posters must stop their spinner (else isAnimating latches).
      Opening a thread unpauses the poster queue (the board may have paused
      it mid-fling, and board.tick no longer runs to unpause).
    - `fit()` frames the WHOLE tree, so "in view" is every node on open —
      a viewport gate alone is a no-op. Skip postage-stamp nodes
      (`nodeWorthTexture`, <48 CSS px tall), bind `peekPoster` instantly
      (the board already rendered those textures), trickle at most two
      new getPoster jobs per pass, and cancel queued posters that panned
      off or shrank. Live previews and 3D models use the same size gate.
    Guard: `bun scripts/direct3d-unit.mjs` + `bun scripts/thread-open-unit.mjs`.

78. STUDIO MUST CLOSE THE BOARD (2026-08-21): opening the studio left the
    feed "still open" — board-only topbar controls (search / shuffle / 3D /
    create) stayed clickable over the editor, a live feed event re-bound
    cards `isPickable=true`, and the studio camera called `attachControl`
    in its constructor so it stole canvas pointers while the board was on
    screen. Fix: `body[data-mode=studio]` hides those controls; `Board.setInteractive(false)`
    while another view owns the canvas (bind/tap respect the flag); studio
    camera attaches only in `attach()`/`detach()`. Poster queue pauses in
    studio/viewer. Guard: `node scripts/studio-open.mjs`.

79. PAGE ZOOM MUST NOT STRETCH OR SOFTEN 3D (2026-08-21): zooming the page
    (or dragging the window to a screen with a different scale factor) left
    the drawing buffer at the device pixel ratio sampled when the engine was
    constructed. `FormEngine.resize()` called `engine.resize()`, which
    re-reads the CSS box but KEEPS `hardwareScalingLevel`, so the browser
    scaled a stale frame over the new box: content came out soft, and any
    view holding a cached frustum came out stretched. Reloading — or anything
    else that happened to recompute the ratio — appeared to "fix" it, which
    is why the bug looked intermittent. Fix:
    - `resize()` now re-runs the full resolution policy (`applyResolution`),
      so devicePixelRatio AND the MAX_PIXELS budget (which depends on the CSS
      box) are re-derived on every viewport change. A degrade the adaptive
      controller had earned is carried across the change instead of being
      silently reset.
    - devicePixelRatio is watched with a re-armed `(resolution: Xdppx)` media
      query. Zoom fires `resize`, but a same-size DPI change (second monitor)
      does not, and the buffer would keep the old ratio.
    - New `engine.onViewportChange(fn)`: fires when the buffer size or its
      aspect actually moves (not on every adaptive step). Board, thread,
      viewer AND studio subscribe. Previously one `window resize` handler in
      main.ts re-measured three views by hand, so the studio was never told,
      and a resolution-policy change re-measured only two of them.
    - `Studio.resize()` recomputes its orthographic frustum. Babylon
      re-derives a PERSPECTIVE camera's aspect from the engine on every
      projection recompute, but `orthoLeft/Right/Top/Bottom` are cached, so
      studio ortho stayed frozen at the aspect it was authored at (1.6) and
      rendered stretched after any resize. The four duplicated copies of that
      frustum math are now one private `applyOrtho()`; `syncCameraNode()`
      joins them (it used to set `mode` and never refresh the bounds, so a
      stored ortho camera kept the frustum it was born with).
    - Manual resolution with `aspectLock` OFF renders an arbitrary buffer
      aspect while `#engine` is 100vw/100vh, so a 16:9 buffer in a 4:3 window
      was stretched non-uniformly — circles drew as ellipses. The canvas
      element is now LETTERBOXED to the buffer's aspect (bars, centred)
      rather than stretched, and the toggle's hint says so (rule 9j: a
      control must not silently do something visually wrong).
    Guard: `node scripts/zoom.mjs` — asserts, from the ACTIVE CAMERA's
    projection matrix against the canvas CSS box, that pixels-per-world-unit
    is equal on X and Y (m00·cssW == m11·cssH) for board / thread / studio at
    67…300% zoom, that the buffer tracks the device ratio (sharpness), that
    studio ortho follows four window sizes plus a route re-entry, and that
    manual mode letterboxes instead of stretching.

80. ONE PREVIEW/3D POOL ACROSS BOARD + THREAD (2026-08-21): board and thread
    used to each construct a PreviewPool — two hidden stage scenes and two
    RTT sets for the session, even though only one view renders. Direct3D
    meshes must live in the visible scene, so those pools stay per-scene.
    `LivePool` (`src/board/livePool.ts`) owns the single PreviewPool and both
    Direct3D pools. `activate(view)`:
    - board↔thread: keep preview RTTs so a post already parsed does not
      re-parse (`request()` re-emits onLive; the incoming view evicts what
      it cannot see); release the inactive 3D pool; restore board RTT size
      when leaving the zoom-scaled thread map.
    - viewer: keep preview for `acquire()` hand-off; release both 3D pools.
    - studio (idle): release + prune everything.
    Inactive views must not request or release the shared pool (a window
    resize or onLoadDone behind the other view used to steal slots). The
    `livePreviews` setting is one budget, not `min(3, n)` for the thread.
    Graphics registers the stage scene once. Guard: board.previewPool ===
    threadView.previewPool (offline-verify).

81. 3D VIEW BUGS (2026-08-21): empty glTF `__root__` / group nodes must not
    enter worldBox / dominantFacing (zero-size boxes at the origin stretched
    off-origin models into specks). Overlay materials use depthFunction
    ALWAYS — renderingGroup 1 only fixes sort, not the depth test against a
    3D mesh that pokes out of the card. Direct3DPool.hasWork is true while
    shaders compile (demand-driven render otherwise left cards blank). Models
    crop to the card with four clip planes. Transform scale is on the root
    (scale on `fit` drifted off-origin models). `Node.dispose(true)` means
    doNotRecurse — release must recurse or orient/fit leak. The glTF loader
    auto-starts animation group 0; the pool stops it so play/pause own
    playback. Contact shadow uses the model's real footprint in the cell.
82. POSTER AUTHORED-CAMERA FRUSTUM TEST USED A STALE MATRIX (2026-08-21):
    cameraFramesBox() called cam.getTransformationMatrix(), which multiplies
    the CACHED view and projection matrices — still identity for a
    freshly-loaded glTF camera that has never rendered. The frustum test
    therefore always reported "camera misses the model" and every poster fell
    back to auto-fit, silently ignoring AMENDMENT 6's authored-camera policy.
    The fix builds the view-projection fresh (getViewMatrix() ×
    getProjectionMatrix()) and uses the standard AABB-vs-frustum test, which
    also rejects boxes fully behind the camera (a hand-rolled NDC projection
    flips behind-camera points and misclassified the blank camera, model 'f',
    as framing the model). Guard: scripts/offline-verify.mjs §1 (poster
    camera policy) — authored camera must frame only the authored view, and a
    camera that frames nothing must fall back to auto-fit.
83. BOARD CARD CROSSFADE NOT SNAPPED BY A FAST LIVE RTT (2026-08-21): the
    shared preview pool (AMENDMENT 80) can re-load a cached live RTT in under
    the 120 ms poster crossfade. When onLive fired mid-fade, crossfadeTo()
    called finishFade(), snapping opacity to 1 and cutting the plate->poster
    fade-in short (a real instant-swap glitch, not just a test artifact).
    Fix: the board defers a live RTT that arrives during a crossfade onto
    slot.pendingLive and binds it in the tick loop once the fade completes;
    onRelease clears it. Guard: scripts/offline-verify.mjs §1b "board card
    crossfades over >=60ms".

84. STUDIO EXPORT CODECS (2026-08-21): the export review (frozen pre-publish
    snapshot, exact bytes for download/publish) grows LOCAL codec encoders:
    geometry KHR_draco_mesh_compression (Babylon's own DracoEncoder wasm via
    `?url`, main thread, no asm.js fallback — without wasm the probe fails
    and the control stays hidden) and textures EXT_texture_webp (canvas).
    An option appears only after its encoder passes a probe. A choice
    re-derives from the SAME frozen pristine export and must re-pass
    validateGLB before it can become the reviewed snapshot (`raw` restores
    the exact serializer bytes). The rewrite (`src/model/compressGlb.ts`,
    encoders injected) never grows a file: skinned / morph-target /
    already-compressed primitives and animations keep their raw buffers;
    accessors keep count/min/max and lose only their bufferView; shared
    views survive while anything still reads them raw. Standalone inlines
    the encoder (+~570 KB → 5.09 MB single file).
    Riding along: PosterRenderer awaits `scene.whenReadyAsync()` once before
    its render loop (the first poster of a texture-bearing post used to
    render before the texture decoded), and the publish button's mid-upload
    cancel — lost when the review flow took over its click — works again.
    (The "authored camera poster shows green" red check found during this
    work was root-caused and fixed on main as AMENDMENT 82.)
    Guards: `check:codec` (container, draco rewrite with real-wasm Babylon
    load roundtrips, webp rewrite, shared views, animations byte-exact),
    `check:codec-browser` (review UI, draco publish roundtrip with
    SHA-verified bytes, webp poster equivalence).

85. EXPORT CODEC PREVIEW + FINE SETTINGS (2026-08-21): both codecs are LOSSY,
    so the review proves their cost: when one is active it renders the EXACT
    reviewed bytes through the card pipeline beside the raw export, with a
    mean pixel-difference readout (baseline cached per export, renders
    token-guarded, hidden when no codec is on). Fine settings: geometry bits
    presets 14/12/10 (position/normal/uv/color/tangent quantization) and a
    texture quality slider (50–100%, default 85%); the note reports the
    applied bits and quality. Every change re-derives + re-validates +
    re-previews; derives queue instead of swallowing clicks, and a busy pass
    can never leave the controls locked (fallback clears busy, edits reset).
    Guards: `check:codec` fine-settings units + `check:codec-browser`
    (preview, dials, visibility).
