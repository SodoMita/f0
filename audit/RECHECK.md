# Audit re-check — measured results

Every finding from the 2026-09-11 agent-browser audit (`audit/BUGS.md`, tracking
issue #83) re-measured against the running app on the repo's own offline rig:

```sh
bun run dev &                          # vite :5173
node scripts/offline-rig.mjs &         # rig :4173 + :8443
node audit/recheck.mjs                 # all 30
CHECKS="75 76" node audit/recheck.mjs  # a subset
```

Each check prints the number that decided it, so a fix can only be claimed with a
measurement attached. `audit/png.mjs` decodes the screenshots in-process: the agent
sandbox has no PIL/numpy, and compositor screenshots are the only pixels that are
not racy — `gl.readPixels` on the default framebuffer can return a half-drawn frame
because it is not preserved after compositing.

**Last full run: 30 findings, 30 pass, 0 fail.**

Fixed on this branch: **#75** viewer backdrop seam, **#76** phone viewer rail,
**#82** model audio (loader drops the emitter's loop flag; the SOUND button stayed
lit over silence), **#68** feed snap never armed on a quiet board. The rest were
already fixed by PR #84 and are *verified* here rather than assumed. Root causes
and before/after numbers: SPEC AMENDMENTS 95–98.

| # | Finding | Result | Measured |
|---|---|---|---|
| #53 | [board] 3D mode renders real models | ✅ PASS | 3D board paints model pixels (changed 7.7%, saturated 5.2%) |
| #68 | [board] feed snaps to a row band **(fixed here)** | ✅ PASS | feed rests 0.000 units from a band top (pitch 13.4 = 0.0% of a row) |
| #69 | [ui] wheel over the topbar does not scroll the scene | ✅ PASS | topbar wheel shielded (Δ0.00) while the same wheel over canvas moves the feed Δ62.7 |
| #70 | [ui] no Babylon unmute icon over the brand | ✅ PASS | icon never created |
| #71 | [board] reply badge is inside its card, not the row above | ✅ PASS | every badge inside its card (worst \|dy\| = 0% of half-height) |
| #78 | [theme] light background: contact shadows are not ink blots | ✅ PASS | on white the shadow takes 9.2% off the backdrop, not the ~85% the audit measured (dark theme 31.2%) |
| #62 | [board] arrows/Enter keyboard navigation | ✅ PASS | arrows select (57a37ac0) and Enter opens the viewer |
| #55 | [viewer] authored-camera switch (C / dots) changes the view | ✅ PASS | C switches the rendered view (98.9% of pixels change) |
| #72 | [viewer] animation rail hidden for models with no animations | ✅ PASS | anim rail hidden for a static model |
| #82 | [audio] SOUND control reflects the model's real audio **(fixed here)** | ✅ PASS | silent model hides the control; glTF loop:true survives (loop=true, still sounding 5 clip lengths in); a one-shot un-lights itself (lit=false) |
| #79 | [viewer] no playing HUD over an empty canvas | ✅ PASS | the rail waits for the model (or the loading ring covers the gap) |
| #60 | [viewer] Escape closes the metadata drawer first | ✅ PASS | first Escape closes the drawer and stays in the viewer |
| #75 | [viewer] backdrop has no hard horizontal seam **(fixed here)** | ✅ PASS | no seam (worst 1-row step 0.65; glow darkest at 71%, 20 points below its edge) |
| #76 | [mobile] viewer bar buttons reachable at 390px **(fixed here)** | ✅ PASS | every control on-screen at 390px, no sideways scroll, button targets >= 30px |
| #77 | [mobile] auto-fit respects portrait aspect | ✅ PASS | model fits with margin (box {"minX":6,"maxX":266,"minY":148,"maxY":398}) |
| #63 | [thread] +/− zoom the expected way | ✅ PASS | + shrinks the half-height (0.6310399999999998→0.5048319999999998), − grows it (→0.6310399999999998) |
| #54 | [thread] 3D thread mode renders real models in the node frames | ✅ PASS | 4 node(s) carry a live model and those models paint 1.92% of the frame |
| #74 | [thread] node posters stay inside their frames | ✅ PASS | 5 node poster(s) all inside their frames |
| #58 | [thread] unknown thread id shows a not-found notice | ✅ PASS | unknown thread shows the notice card |
| #56 | [routing] #/viewer/<id> survives a reload | ✅ PASS | after reload: mode=viewer hash=#/viewer/d53e5b85924be07 |
| #57 | [routing] unknown post id shows an error sheet | ✅ PASS | sheet=E103 No relay returned this post (ffffffffffff…). It may be delet |
| #59 | [settings] panel closes on Escape | ✅ PASS | Escape closes the settings panel |
| #64 | [settings] Preset dropdown applies the preset | ✅ PASS | choosing Low drove msaa to 1 |
| #65 | [perf] viewer handoff fast-path works (no fallback log) | ✅ PASS | 0 handoff-failure console message(s) after two viewer opens |
| #80 | [a11y] toasts are announced | ✅ PASS | #toast role=status aria-live=polite |
| #81 | [a11y] #a11y-bridge is populated | ✅ PASS | bridge follows the mode: "board — the feed of 3D models" -> "model view" |
| #73 | [legend] no U+23F8 tofu in the legend | ✅ PASS | legend uses 10 inline SVG glyphs, no U+23F8 |
| #61 | [studio] Escape closes the export review, keeps the studio | ✅ PASS | first Escape closes the review (display grid -> none) and keeps the studio with its model |
| #66 | [studio/export] draco does not lose the audio buffer view | ✅ PASS | draco derive succeeded and re-validated |
| #67 | [studio/text] triangle budget is not stuck at 0 | ✅ PASS | readout "5 chars · 1 lines · 134 tris" -> 134 tris |

## Probe corrections — read before re-running these

Six findings only measured honestly once the *probe* was fixed. Each is commented
at its check in `recheck.mjs`; the short version:

- **#61** dispatched `change` on `#file-input` without clicking `#btn-studio-import`
  — that click is what registers the listener, so the studio never received the
  model and the export review never opened.
- **#69** sampled `scrollY` through the tail of the scroll snap and read the drift as
  a wheel leak. It now waits for rest and compares against a control wheel over open
  canvas (topbar Δ0.00 vs canvas Δ62.7).
- **#78** compared themes with an absolute luminance delta; the same 0.55-opacity
  black shadow is a 6-unit delta on the dark backdrop and a 50-unit one on white.
  Each pixel is now normalised to its own unshadowed value.
- **#81** demanded >10 chars from the a11y bridge, but three of its four mode
  announcements are legitimately shorter (`model view`, `thread map`, `studio`).
- **#54** relied on another check to navigate to the thread first, so a filtered run
  measured an empty node map while still on the board.
- **#66** sampled the codec buttons the instant the review opened; they appear only
  once the availability probes resolve.

Two harness bugs mattered enough to fix in place: a cluster that declares several
checks up front must `focus()` each record before its body (otherwise every verdict
lands on the last-declared check — #76 reported SKIP while its own verdict was
attributed to #77), and every pixel-diff probe must pin the framebuffer, because
adaptive resolution (default ON) changes the render size between frames and alone
fakes row-level steps.
