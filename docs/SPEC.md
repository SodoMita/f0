FORM/0 BUILD SPEC (condensed). Anonymous wordless 3D imageboard; browser-only, direct to Nostr relays + Blossom; one canvas, Babylon.js. Posts = animated GLB models, own cameras, optional embedded audio.
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

6. Poster camera = ALWAYS auto-fit. The thumbnail never uses the model's
   authored camera (it may point anywhere and yields blank posters); authored
   cameras belong in the viewer (camera dots / C key). Auto-fit frames
   worldBounds (union AABB) + dominant facing + fitDistance.

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
