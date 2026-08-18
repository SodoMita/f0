# Re-audit: `arena/01a011f8-f0` (HEAD `6cc4431`)

Previous audit was against `f766032`. Five more commits landed, notably
`8405747` (“fix rotationQuaternion crash and eviction deadlock”) plus an
offline rig / 25-check verify suite the branch now treats as green.

The crash and the eviction deadlock are fixed. The rest of the last
audit is still open. The new suite **encodes one of those bugs as the
expected result** and never checks the behaviour the rig’s own comments
describe.

---

## Fixed since last audit

| Was | Now |
|---|---|
| `rotationQuaternion.copyFrom` threw on every camera’d model | Assigns `camQuat.rotationQuaternion = quat`; auto-fit sets it back to `null` |
| `pickEvictable` used stale `slot.visible` (default false) → ping-pong / deadlock | `request(postId, visible)` takes the caller’s fresh set; board only requests **on-screen** cards |
| STATIC path leaked the container | `clearSlotModel` un-reparents `rootNodes` then dispose |
| Mid-load `FAILED` on `setMaxSlots` | Still correctly skipped when `!alive()` |

CSS gizmo hit-area is still correct.

---

## Still P0 — `preview-camera` is never applied

Unchanged:

```ts
// src/core/assets.ts
return bytes ? { bytes, sha256: meta.sha256, previewCamera: meta.previewCamera } : undefined

// src/board/previewPool.ts
const cameraIndex = model.cameraIndex ?? 0
```

`PreviewModel.cameraIndex` is never populated. Live previews always use
camera 0. SPEC AMENDMENT 6 still says
`preview-camera index → first imported → auto-fit`.

The new rig **knows** this is the intended contract:

```
// scripts/offline-rig.mjs
// d  TWO cameras (cam0=red, cam1=green) + animation, event
//    carries preview-camera=1 — poster uses cam0 (red), live preview
//    must use cam1 (green).
```

`scripts/offline-verify.mjs` then:

- asserts the **poster** is red (cam0) — and treats that as a pass
- **never samples a live preview of `d.glb` for green**

So the suite cannot fail this bug. The comment is the spec; the test is
a ratification of the broken plumbing.

Poster path is independently cam0-only (`container.cameras[0]` in
`poster.ts`) with no index at all. That matches the poster half of the
test, not the live-preview half of AMENDMENT 6.

---

## Still P0 — poster cache not invalidated

```ts
const POSTER_CACHE_V = 'p3:'
```

Camera policy changed. Comment on that constant still says bump it when
the pipeline changes visually. Returning users with a warm IndexedDB
cache keep auto-fit (or old blank) posters. The headline “poster from
camera after upload” bug stays broken in production.

---

## Still P1 — AMENDMENT 6 has no blank → auto-fit fallback

Authored camera that frames nothing still throws `'poster rendered empty'`
→ publish placeholder diamond. That is the failure mode the old
always-auto-fit rule existed to prevent. The new suite only uses cameras
that were authored to frame the red cube, so it cannot catch this.

---

## Still P1 — “120 ms crossfade” is a one-layer fade-in

Unchanged: one texture, opacity lerp.

- plate → poster: swap texture, then 0.14 → 1 (fade-in). This is what
  `offline-verify` measures (`rampMs >= 90`).
- poster → live: `fadeTo(1)` while already at 1 → **hard swap**.
- live → poster on evict: same hard swap.

SPEC CARD and AMENDMENT 48 still claim plate → poster → live. The suite
does not observe the live transition at all.

---

## Still P2

**Pending loads cannot be released.** `release()` still only looks in
`byPost`. A scroll-away / card recycle during `pending` is a no-op; the
parse continues and pins a slot until `onLoadDone`.

**Two pools, not a shared budget.** `apply.ts` still does
`board.setLivePreviewSlots(slots)` **and**
`threadView.setLivePreviewSlots(min(3, slots))`. Two stage scenes, two
RTT sets, allocated for the whole session.

**Studio origin / center / fit-sel ignore fly-cam.** They call
`setCameraState({ target, radius? })` with no `projection`. That only
writes the orbit camera. In fly mode the buttons are dead. The suite
never toggles fly-cam before clicking them.

**`selectedSet()` includes descendants**, so “average origin of selected”
is the subtree centroid. Origin vs center only differs for the
whole-model fallback (which the suite does test).

---

## New since last audit

### `VITE_UPSTREAM` is dead

`97c9725` added:

```ts
const VITE = process.env.VITE_UPSTREAM || 'http://localhost:5173'
```

Both the HTTP proxy and the HMR upgrade still hardcode `port: 5173`.
The log line prints `VITE`, so `VITE_UPSTREAM=http://localhost:5174`
looks wired and silently talks to the wrong process. STATUS claims the
suite is green “on BOTH the dev and the production preview builds”.

### Verify suite is not a substitute for the missing asserts

`offline-verify.mjs` is useful (slot-budget, STATIC reject, no-auto-look
on import, canvas hit-test above the toolbar). It is also written so
that:

1. `preview-camera` live path cannot fail.
2. Poster→live “crossfade” cannot fail.
3. Fly-cam look-at cannot fail.
4. Cache-key bump cannot fail.
5. Blank-authored-camera fallback cannot fail.

“25 checks, all green” does not cover the remaining P0/P1s.

### `computeWorldMatrix()` still not forced

Authored-camera copy runs after reparenting onto the 800-unit slot
offset, without `computeWorldMatrix(true)`. Slot 0 (offset 0) hides
this; later slots / reuse may aim the camera at the un-offset pose.
The suite only checks `activeCount > 0`, not live-preview pixels.

---

## Merge bar (updated)

Do not merge until:

1. `getModelBytesByPostId` actually fills `cameraIndex` (or the pool
   reads `previewCamera`). Add a pixel assert that a `d.glb` live
   preview is **green**.
2. `POSTER_CACHE_V` → `p4:`.
3. Blank authored frames fall back to auto-fit before the publish
   placeholder.
4. Either implement a real two-texture crossfade or stop claiming
   “plate → poster → live 120 ms” in SPEC/STATUS.

Then: cancel pending loads on `release`, share one pool (or one budget),
drive look-at/fit through the *active* camera, actually parse
`VITE_UPSTREAM`.
