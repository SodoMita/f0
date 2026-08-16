# STATUS — task board for agents

Claim a task by moving it to **In progress** with your name/date, push, then
move it to **Done** with a commit reference. One agent per area.

## Done

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

## In progress

- [ ] Studio: import GLB only. Publish (BUD-01) + audio embed + ownership are
      **not** implemented (`studio/studio.ts` is a stub).

## Next (spec order — pick one and claim it)

- [ ] **First-run legend** (spec 02 §1.1 — mandatory, not implemented yet).
- [ ] **Network panel** (add/remove/probe/reset relays + Blossom; only a status
      dot exists today).
- [ ] **Error sheets** (card/action error → code + cause + action; today it's a
      toast only).
- [ ] **Reply authoring** (reply button currently only opens the thread; no
      compose→publish flow).
- [ ] **Studio publish flow**: BUD-01 upload, kind-1063 event, ownership
      secrets, preservation report, partial-success UI.
- [ ] **Audio**: embed into GLB (KHR_audio / MSFT_audio_emitter), 8 MiB cap,
      play on gesture.
- [ ] **Paint editor** (Paint 3D-style brush; NOT a voxel editor — free
      overlapping shape strokes, fine grid only for snapping; spec 05 Part B):
      grid/cube-size independence, strokes, selection, transforms, erase, undo.
      See `docs/RESEARCH-EDITORS.md` — use Babylon `GizmoManager`+
      `BoundingBoxGizmo` (don't hand-roll gizmos), Amanatides–Woo grid DDA for
      brush/eraser hit tests, packed Float32Array + `thinInstanceSetBuffer` +
      swap-last delete, command+inverse undo stack. Also: fix fit-to-bounds to
      per-axis box extents (see research §1.1).
- [ ] **Low-poly text** + **animation editor** (spec 05b): pixel-font geometry,
      timeline, camera fly-through export.
- [ ] **Tests**: Vitest unit suite (URL normalize, tags, NIP-10, VFS, GLB
      round-trip, text tris, quaternions) + Playwright browser suite
      (plateau, churn, preview isolation, 404 retry bound, publish round-trip).
- [ ] Deletion UI (tombstones already applied in the index; no user-facing
      delete action yet).

## Known gaps / debt

- Studio scene is an import stub; no editor tooling.
- `#/network` route falls back to the board (no panel).
- Poster/preview pool renders share one scene (serialized by a mutex) — fine
  for now, but per-slot isolation is on the roadmap (spec 03 §5).
- No service worker / offline caching beyond IndexedDB poster cache.
