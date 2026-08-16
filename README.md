# FORM/0

Anonymous, wordless 3D imageboard — browser-only client, direct to Nostr
relays + Blossom servers, one `<canvas>` drawn entirely by Babylon.js.
Posts are animated GLB models with their own cameras, optional embedded audio.

## Layout & interaction
- **Board**: single vertical column of 16:10 model cards (no borders, no
  stretching). Wheel-down / drag-down scroll toward later cards; PageUp/PageDown/
  Home/End; **scroll inertia** (configurable in settings). Tap a card → viewer;
  the **reply badge (↩ N)** at the card's bottom-right is the reply button →
  thread.
- **Thread**: a 2D map of the reply tree — node planes + parent→child lines,
  laid out by Fruchterman-Reingold force relaxation. Drag pans, wheel zooms,
  tapping a node opens it.
- **Viewer**: one interactive model; orbit camera (A) or the model's own
  cameras via dots / C; play/pause (A); metadata drawer (M); download; thread
  (T); prev/next.

## HUD is HTML
Settings, navigation, toolbars, metadata, toasts are plain HTML overlays.
Only the models, the board, the reply badges and the thread map are Babylon.
Settings: **background color** (viewer/thread/studio) + **scroll inertia**.

## Verified live (2026-08-16, headless Chromium)
- 13 events / 7 roots → 7 posters + 1 live animated card; posters bright
  (capsule max≈148, numbers max≈115).
- Reply badges: roots with 1 and 2 replies show "↩ 1" / "↩ 2".
- Thread map opens with nodes + edges; tap → viewer; background setting
  applies to viewer AND thread.
- Standalone `file://` build boots with only user-content requests, zero CDN.

## Key fixes this round (see spec AMENDMENTS)
- **Black posters**: two causes — (a) `RenderTargetTexture.render()`/renderList
  never compiled materials on this driver → render via `camera.outputRenderTarget`
  + `scene.render()`; (b) `whenReadyAsync()` on a never-rendered scene hangs →
  removed; (c) environment-texture IBL blackened PBR → removed, lights-only.
- Poster thumbnails always auto-fit (authored cameras belong in the viewer).

## Run
```bash
npm install
npm run dev              # http://localhost:5173
npm run build            # normal build → release/
npm run build:standalone # ONE .html → form-zero-standalone.html
node scripts/smoke.mjs   # headless boot + layout/poster/live/click/scroll
node scripts/features.mjs# badges + thread view + settings assertions
```

## Structure
```
src/
  core/      engine (1 canvas/1 context), router, assets (poster/model cache)
  protocol/  nostr (Relay pool + backoff), blossom (SHA-256 verified), events, storage
  model/     draco (local), limits (pre-load GLB validation), facing, poster
  board/     board (vertical column + badges + inertia), threadView (2D force map),
             cardMaterial (unlit quad shader), previewPool (RTT slots)
  viewer/    detail viewer (one model, own cameras + orbit)
  studio/    import foundation
```

## Next (spec order)
Network panel / error sheets → studio publish (BUD-01) + audio embed →
brush editor (05-B) + low-poly text + animation editor (05b) →
Vitest + Playwright suite with screenshots.
