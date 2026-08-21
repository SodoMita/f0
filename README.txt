FORM/0 — quick reference (digest of README.md)

WHAT: anonymous, wordless 3D imageboard. Browser-only client -> Nostr relays +
Blossom, one canvas, Babylon.js. Posts = animated GLB models w/ own cameras +
optional audio.

LAYOUT: board = responsive 1-3 column grid of transparent cards (aspect from
each post's `dim`, default 16:10), scroll
+ inertia, tap card -> viewer, reply badge (↩ N) -> thread. Thread = tree map
(pan/pinch/zoom, tidy tree, tap node). 3D MODE (settings -> Interface -> "Show
posts as 3D models", also the topbar cube) swaps BOTH the board and the tree
from posters to the ACTUAL GLB models, each shown through the model's own MAIN
camera applied as the model transform vs a static camera (camera = just a
position), so a centered model matches its main-camera view: the model is
pivoted at the camera, rotated by the inverse of its rotation and scaled so the
camera's frame maps onto the card, cropped at the card's edges like a poster
(spec AMENDMENTS 43/75/81, src/model/framing.ts). No camera -> auto-fit.
Viewer = one model, orbit (A) or authored cameras (C), play/pause,
metadata (M), download, thread (T), prev/next; VR = WebXR immersive 1:1 viewing
(spec AMENDMENT 41), hidden when unsupported.

HUD: settings/nav/toolbars/metadata/toasts are plain HTML; models, board,
badges, thread map are Babylon. Settings: there are MANY (spec AMENDMENT 42) —
~50 graphics/audio settings in src/settings/schema.ts (presets, search,
persistence), plus background color, scroll inertia, and upcoming thread-mode
+ VR toggles.

KEY FIXES: per-path texture flip (posters flip Y; RTT/badges don't) · transparent
previews · visual pass (grid, shadows, rounded cards, glow) · black posters
(scene.render() not rtt.render(); no IBL) · posters always auto-fit (3D cards
use the authored camera instead) · 3D cards framed by the model's main camera,
cropped to the card, glued to it while scrolling.

RUN (Bun): bun install · bun run dev · bun run build · bun run build:standalone ·
bun scripts/smoke.mjs · bun scripts/features.mjs.

STRUCTURE: core/ (engine, router, assets) · protocol/ (nostr, blossom, events,
thread-index, storage) · model/ (draco, limits, facing, poster) · board/ (board,
cardMaterial, previewPool, threadView) · viewer/ · studio/ (stub).

NEXT: paint editor (hand-writing) -> animation editor -> audio recording ->
phone-pose camera -> publish -> legend -> tests.

DEPLOY: automatic via .github/workflows/deploy-pages.yml (Bun build -> Pages).

DOCS: start at AGENTS.md, then docs/{SPEC,ARCHITECTURE,STATUS,CONVENTIONS,
RESEARCH-EDITORS}.

NEXT: paint editor (hand-writing) -> animation editor -> audio recording ->
phone-pose camera -> thread mode picker (2D/tree/3D as a setting) -> VR ->
new settings entries -> low-poly text -> tests.
