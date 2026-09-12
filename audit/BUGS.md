# FORM/0 — Agent-Browser Audit (2026-09-11)

Driven with a real headless Chromium (Playwright + SwiftShader WebGL) against the
dev server through the repo's own offline rig (`node scripts/offline-rig.mjs`,
48 posts + reply tree + local relay/blossom on `http://localhost:4173`).
Every finding below was reproduced in the browser; harness artifacts were
re-tested and withdrawn where they didn't hold. Screenshots:
`audit/shots/*.png`. Harness scripts: `audit/p*.mjs`.

Severity: **A** = feature broken/data loss · **B** = clearly wrong behavior/visual ·
**C** = polish/a11y.

---

## A. Broken features

**1. Board "3D mode" renders no models at all.** Toggle the cube button: cards
disappear and never come back — after 35 s the screen shows only play buttons,
shadows and hairlines. Internals: `pool3d.byPost` fills, slots reserved, meshes
enabled, `camera.isInFrustum() === true`, lights enabled, transform nodes scaled
correctly — nothing draws (suspect: the 4-cell clip planes or a render-group
issue). Evidence: `b3d-01-3d-after-35s.png`, `b3d7-after-manual-render.png`.
This is the spec's flagship AMENDMENT-43 mode.

**2. Thread "3D mode" is dead the same way.** Node frames + reply pills render,
play buttons render, but every node's actual 3D model is missing (empty
rectangles). `threadView.threeD === true`, `d3-*` roots exist in the scene.
Evidence: `f9-02-thread-3d.png`.

**3. Authored-camera switching in the viewer doesn't change the view.** Open the
two-camera rig post (`#/viewer/<d-post>`): both dots show, `C` cycles the dot
highlight, but the rendered view stays identical — camera 2 must show the green
framing, the screen never changes. After prev/next the model can also stay
hard-cropped (see `p2-06-after-delete-click.png`, red cube filling the frame).
The "1" dot is styled active even while an authored camera is in use.

**4. Viewer deep links break after a reload.** With `#/viewer/<id>` in the URL,
reload: the app boots to the **board** while the URL still says viewer.
`openViewer()` gives up if the event hasn't arrived from the relay yet and
silently routes to the board — no retry, no pending queue (main.ts
`openViewer`, `if (!meta …) { setMode('board'); return }`). Evidence: p6 log
`after reload on viewer deep link: {"hash":"#/viewer/…","mode":"board"}`.

**5. Unknown post id in a viewer deep link: silent fallback.**
`#/viewer/ffff…` lands on the board with no sheet, toast or notice.

**6. Unknown thread id: permanent empty void.** `#/thread/eeee…` shows an empty
backdrop forever — no nodes, no "not found" notice (the thread view has a
`noticeMesh` facility; nothing is shown). Evidence: `p6-05-unknown-thread.png`.

**7. The settings panel ignores Escape.** Every other overlay (thread, network
panel, search, error sheet, preview page) closes on Escape; the 161-input
settings drawer does not — the keydown handler in main.ts has no branch for it.
Verified: display stays `flex` after Escape. You must click ✕.

**8. Escape with the metadata drawer open exits the viewer.** Expected: close
the drawer. Actual: drawer closes **and** you're dumped on the board (Escape is
handled by the viewer branch before the drawer gets a say).

**9. Escape with the export review open abandons the studio.** The review modal
stays open **floating over the board** while the studio (and its imported model)
is gone — a broken combined state. Verified: `{review: grid, mode: board}`.

**10. Board keyboard navigation doesn't exist.** Spec A11Y: "Board
arrows/Enter/PgUp/PgDn/Escape". Reality: the window keydown handler has **no
board branch at all**, and the board's own Babylon keyboard observable handles
only PageUp/PageDown/Home/End. Arrows/Enter do nothing on the board (verified
synthetic + real keydowns; note PageUp/PgDn *do* work once the canvas has
focus — an invisible focus requirement of its own).

**11. Thread zoom `+`/`−` are inverted.** `+` calls `zoomBy(1.25)`, but zoom is
the ortho half-height: bigger = **zoomed out**. Pressing `-` four times zooms
hugely IN (`tr-02-tree-zoomed-out.png` — misnamed for a reason), while wheel-up
zooms in. Both the HUD buttons and the keys contradict the wheel and every
convention.

**12. The "Preset" dropdown applies nothing.** Choosing Low/Medium/High/Ultra in
the select only stores the label — all values stay as they were (verified:
msaa manually set to 4, choosing `low` leaves `msaa=4` in store and control).
Only the pill buttons at the top call `applyPreset()` (direct call works:
msaa → 1). A player switching to "Low" via the dropdown thinks they got the
minimal profile and keeps the heavy one.

**13. The viewer handoff fast-path never works.** Every single viewer open logs
`viewer handoff failed, falling back to parse: UniversalCamera needs to be
imported before it contains a side-effect required by your code`
(viewer.ts:301). The advertised optimization (reuse the board's parsed model,
skip the "loading model" flash) is dead code; every open re-parses the GLB and
spams the console. Missing side-effect import (`@babylonjs/core/Cameras/
universalCamera`).

**14. Draco re-encode fails on a plain animated model — with wrong copy.**
Export review → geometry `draco` on the rig's two-cube+animation GLB:
`codec failed · original kept — "Audio clip references a missing buffer view."`
The model contains zero audio. Either the encoder genuinely mangles animation
accessors or the error text is picked from the wrong bucket; either way the
"encoders appear only when they provably work" promise fails its own gate.

**15. The text tool's triangle budget is stuck at 0.** Type "HELLO": glowing
text renders on screen, the live scene mesh holds 198 indices, the readout says
`5 chars · 1 lines · 0 tris` (`updateTextBudget()` finds the mesh by name but
always reports 0 — name/mesh mismatch after rebuild).

## B. Wrong behavior / visual defects

**16. No scroll snapping.** After any wheel/fling the feed rests mid-row
(`scrollY = 179.2` with rows at 128.8 pitch): cards are cut off at top and
bottom, nothing is centered. Evidence: `p1-04-after-wheel.png`,
`f4-01-end-of-feed.png`.

**17. Wheel input passes through the top HUD.** Cursor over the topbar: the
board scrolls behind it (0 → 65) and in the viewer the model zooms (radius
9.59 → 5.32) while you're hovering the brand/relay area. The fullscreen canvas
eats wheel events that should belong to the chrome.

**18. Babylon's stock "unmute" overlay is pinned over the FORM/0 brand.**
`#babylonUnmuteIconBtn` (`.babylonUnmuteIcon`, 60×40 at 20,20) — an unstyled
giant speaker-with-X icon — sits over the top-left corner of **every** screen
(board, viewer, thread, studio, mobile). It's the AudioEngine's unmute button
leaking through with no CSS. Evidence: every screenshot, e.g. `p2-01`, `p7-02`.

**19. The reply badge renders above/over the wrong card.** At 3 columns, the
middle-column card's `↩N` badge is placed at +8.7 units above its card center
(card center y=12.6, badge y=21.3 in board units) — it floats over the **row
above** and overlaps that row's card. Visible as a giant stray "↩ 1" pill in
`bg-01`, `p4-02`, `p3-05`, `f4-01`. Root cause sits in `positionExtras()`
(board.ts): badge offset is computed for a different slot geometry.

**20. The animation rail shows for models with zero animations.** Open the
static camera'd rig post: the full play/timeline/speed rail renders and the
frame counter reads `1/1`, for a model with no animation groups.

**21. Legend uses a glyph the font doesn't have.** "the ⏸ pauses both" renders
as "the □ pauses both" (U+23F8 has no glyph in the bundled/system font).
Evidence: `p1-01-first-boot.png`.

**22. Thread node posters overflow their frames.** A child node's poster can be
larger than the node card and spills past its border (blue reply in
`tr-01-tree.png`) — no clipping on node quads.

**23. Viewer backdrop seam.** A hard horizontal line crosses the viewer where
the spotlight backdrop meets the floor glow (`f8-01-viewer-seam.png`,
`p1-03-after-enter.png`).

**24. Mobile (390 px): core viewer actions are off-screen.** THREAD, REPLY,
SAVE, INFO are laid out at x ≈ 468–602 on a 390 px viewport — beyond the right
edge, unreachable. Measured via `getBoundingClientRect` in the mobile profile;
see `p7-02-mobile-viewer.png` (bar truncated after FIT).

**25. Mobile viewer crop ignores portrait aspect.** The same model that fits
perfectly at 1280×800 fills/overflows the screen on a phone-sized viewport —
auto-fit uses a landscape assumption. Evidence: `p7-02-mobile-viewer.png`
(only a slice of the cube is visible).

**26. Light theme: contact shadows turn into near-black smudges.** Switch the
background to the white swatch: elliptical shadows stay ~85% black under every
card (`bg-02-custom-magenta.png`, also visible around the swatch row).

**27. The viewer shows a playing animation rail over an empty canvas.** On
open, the HUD (clip name, timeline, frame counter — "viewer-bob 28/60")
appears and starts immediately while the canvas is still empty for seconds,
with no loading indicator in the viewer itself (related to #13's dead handoff).

## C. Accessibility / polish

**28. Toasts are invisible to screen readers.** `#toast` has no `aria-live` and
no `role` (index.html:381) although the spec requires aria-live announcements.
Publish/download/copy feedback is never announced.

**29. The a11y bridge is an empty div.** `#a11y-bridge` exists (the spec's
"hidden DOM bridge" because Babylon draws the real UI) but its textContent
stays empty forever — the board/thread/viewer states are never mirrored into
it. Assistive tech sees one blank canvas.

**30. The SOUND control is offered for silent models and lies about state.**
`viewer.soundCount` is 1 for a model with no audio at all, so the SOUND button
is visible/enabled; pressing S toggles it to its "on" styling while nothing can
play (the same family as #18's bogus unmute icon — the app's audio plumbing
over-reports).

---

## Verified-OK (checked, not bugs)

Settings persist across reload (IndexedDB); settings search filters; manual
resolution (50 px) applies; FOV/bloom/reduce-motion/clear-cache/volume settings
reach the engine; calibration overlay runs and dismisses on click; display-mode
fullscreen works; network panel add/remove relay + probe + Escape; reply badge
tap opens the thread (at its true position); thread fit/pan/wheel-zoom/node
tap; viewer download, orbit, wheel zoom, prev/next wrap, `,`/`.` stepping;
paint stamps + undo/redo (in the paint tab); symbols & image tools; import via
the real file chooser; empty-studio publish is disabled; delete is gated to
owned posts; E302 sheet on total blossom failure; shuffle reorders; board
scroll position survives a viewer round-trip; camera dots appear for authored
cameras; legend reopens with `?` and closes with Escape.

## Environment

- Dev server: `bun run dev` (port 5173) + rig `node scripts/offline-rig.mjs`
  (relay+blossom :8443, proxy :4173 — this URL injects the local relay, since
  the sandbox blocks all public relays/CDNs).
- Public internet (real relays, blossom.primal.net, nostr.download) is blocked
  in this sandbox; those servers show "unreachable" — expected here, not a bug.
