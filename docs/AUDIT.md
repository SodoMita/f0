# Audit — `arena/01a023c0-f0`

Scope: `src/`, build configs, CSP, protocol, GLB pipeline. Threat model unchanged
from `docs/SECURITY-AUDIT.md`: untrusted signed events + untrusted model bytes.

## Findings

### P1 — PreviewPool dropped a still-wanted load (fixed)

`PreviewPool.request` treated `cancelled` as “already handled” and returned
true without clearing the flag. A card that scrolled away mid-parse then
scrolled back discarded the in-flight result (`Direct3DPool` already
un-cancelled). Fixed: in-flight `request()` now `cancelled.delete(postId)`.

### P2 — Two live-preview budgets

`apply.ts` still sets `board.setLivePreviewSlots(n)` **and**
`threadView.setLivePreviewSlots(min(3, n))`. Only the active route renders,
and the thread pool prunes on detach, so this is not a session-long double
allocation — but it is two stage scenes. Sharing one pool would cut GPU
memory when hopping board ↔ thread.

### P2 — Studio export still uses `any`

`Studio.getContentForPublish` types meshes/cameras/GLB files as `any`. The
export filter is the trust boundary for what leaves the editor. A typed
`Node` predicate would catch accidental inclusion of gizmo/paint-source
meshes at compile time (the runtime `studio-paint` name skip is the current
guard).

### L — Overlay / fade duplication (addressed)

Board and thread each owned a copy of the 120 ms two-texture crossfade, ▶/⏸
intent, glass-pill + reply-arrow painting, and overlay-group setup. That is
the class of bug that produced the all-white-card regression (blend uniform
not reset) in one viewport and not the other. Shared modules:

- `src/board/cardFade.ts`
- `src/board/playIntent.ts`
- `src/board/overlays.ts`

### L — CSS light theme is a override list, not tokens

`style.css` re-declares dozens of `body[data-theme="light"]` rules because
many dark-theme declarations use hardcoded `rgba(255,255,255,…)` instead of
`--glass` / `--line`. A missing override is a silent contrast bug (same
failure mode as `--danger` only existing in light). Not changed this pass:
visual suites own those colours.

## Security (re-check)

Prior High/Medium items remain closed: `validateGLB` rejects non-`data:`
URIs; data-URI images are MIME + dimension scanned; kind-5 requires matching
pubkey; standalone ships `STANDALONE_CSP`; owned secrets are AES-GCM
envelopes; sidecar imports are local-only. No new `innerHTML` sinks with
user data. Event `content` still goes through `textContent`.

## Performance

Shared helpers are inlined call sites on the existing per-slot objects — no
new allocations on the render path. `tickFade` is the same 120 ms lerp the
board already ran. Idle probe (`isAnimating`) is unchanged. PreviewPool
un-cancel avoids a wasted re-parse after a scroll-back.

## Not done

- Files still over the ~400 line convention: `main.ts`, `board.ts`,
  `threadView.ts`, `studio.ts`, `previewPool.ts`, `schema.ts`, `graphics.ts`.
- CSS tokenisation of the light theme.
- One shared preview/3D pool across board + thread.
