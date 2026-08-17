FORM/0 — quick reference (digest of README.md)

WHAT: anonymous, wordless 3D imageboard. Browser-only client -> Nostr relays +
Blossom, one canvas, Babylon.js. Posts = animated GLB models w/ own cameras +
optional audio.

LAYOUT: board = 1-3 column grid of 16:10 cards, scroll + inertia, tap card ->
viewer, reply badge (↩ N) -> thread. Thread = 2D force-relaxed tree map
(pan/zoom/tap). Viewer = one model, orbit (A) or authored cameras (C), play/pause,
metadata (M), download, thread (T), prev/next.

HUD: settings/nav/toolbars/metadata/toasts are plain HTML. Only models, board,
badges, thread map are Babylon. Settings: background color + scroll inertia.

KEY FIXES: per-path texture flip (posters flip Y; RTT/badges don't) · transparent
previews · visual pass (grid, shadows, rounded cards, glow) · black posters
(scene.render() not rtt.render(); no IBL) · posters always auto-fit.

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
