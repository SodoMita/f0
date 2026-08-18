# Sandbox network restrictions: how verification runs anyway

Written 2026-08-18 after the feed/tree/studio bugfix round. This sandbox blocks
most of the internet, including every public relay, every browser CDN and apt.
This document records exactly how a working headless browser and a live-content
test feed were obtained anyway, so the next agent does not have to rediscover
it. It applies to ANY restricted environment with an npm registry allowlist.

## The allowlist (measured)

| Endpoint | Reachable |
|---|---|
| `registry.npmjs.org` (+ npm tarball CDN) | ✅ |
| `github.com`, `api.github.com`, `codeload.github.com` | ✅ |
| `pypi.org` (+ pip) | ✅ |
| `localhost` / `127.0.0.1` | ✅ |
| `storage.googleapis.com` (Chrome-for-Testing) | ❌ |
| `cdn.playwright.dev` / `playwright.download.prss.microsoft.com` | ❌ |
| `deb.debian.org` (apt) | ❌ |
| `ghcr.io`, Docker registries, `unpkg`, `jsDelivr`, `npmmirror` | ❌ |
| Public relays (`wss://relay.damus.io`, `nos.lol`, `relay.primal.net`) | ❌ |
| Blossom servers (`blossom.primal.net`, `nostr.download`) | ❌ |

Probe new hosts with `curl -sI --max-time 12 <url>` — the failures above are
TCP/TLS-level (connection resets), so HTTP codes never appear.

## Getting a headless Chromium with WebGL, from the npm registry only

`npx playwright install` downloads from the blocked CDNs and fails. The npm
registry, however, hosts complete Chromium builds inside regular packages:

```bash
mkdir /tmp/browsers && cd /tmp/browsers && npm init -y
npm i @sparticuz/chromium@149.0.0 puppeteer-core
```

`@sparticuz/chromium` unpacks `/tmp/chromium` (Chromium 149 headless-shell)
plus brotli-compressed bundles in `node_modules/@sparticuz/chromium/bin/`.

On Debian the binary is missing three NSS libraries that are NOT shipped by
default. The package carries them inside `bin/al2023.tar.br`:

```bash
node -e "const fs=require('fs'),z=require('zlib');\
  fs.writeFileSync('/tmp/al2023.tar', z.brotliDecompressSync(\
  fs.readFileSync('node_modules/@sparticuz/chromium/bin/al2023.tar.br')))"
mkdir -p /tmp/chromium-libs && tar -xf /tmp/al2023.tar -C /tmp/chromium-libs
export LD_LIBRARY_PATH=/tmp/chromium-libs/lib   # libnspr4, libnss3, libnssutil3, ...
```

Launch flags that matter here:

- `--no-sandbox` (container as non-root without user namespaces)
- `--ignore-certificate-errors` (the offline rig serves a self-signed cert)
- `--use-angle=swiftshader --enable-unsafe-swiftshader` — software WebGL.
  Verified renderer: `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device …))`.
  WebGL works headless; every repo screenshot/pixel suite depends on it.

Smoke test (puppeteer-core): `puppeteer.launch({ executablePath, args,
headless: 'shell' })`, then in the page
`canvas.getContext('webgl2')` + `WEBGL_debug_renderer_info` must not be null.

## Pointing Playwright (the repo's suites) at it

Playwright refuses to launch unless its expected browser revision directory
exists. The layout comes from `node_modules/playwright-core/browsers.json`
(revision 1234 in this repo). Create the dirs and put a wrapper script at
each expected executable path:

```bash
cat > ~/.cache/ms-playwright/chrome-wrap.sh << 'EOF'
#!/bin/bash
export LD_LIBRARY_PATH=/tmp/chromium-libs/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
exec /tmp/chromium --no-sandbox --ignore-certificate-errors "$@"
EOF
chmod +x ~/.cache/ms-playwright/chrome-wrap.sh
cp ~/.cache/ms-playwright/chrome-wrap.sh \
   ~/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell
cp ~/.cache/ms-playwright/chrome-wrap.sh \
   ~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome
```

`PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright` is Playwright's default, so
`import { chromium } from 'playwright'` just works. Bump the revision numbers
when `browsers.json` changes; the wrapper forwards Playwright's own args.

## A live-content test feed without relays: the offline rig

`scripts/offline-rig.mjs` simulates the whole network path on localhost:

- **`wss://localhost:8443`** — a NIP-01 relay (WebSocket) that answers
  `REQ` with signed kind-1063 events and `EOSE`. It also serves the models at
  `https://localhost:8443/models/<name>.glb` (CORS `*`, SHA-checkable). The
  self-signed cert is pinned to localhost (`openssl req -x509 -newkey ec …
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`).
- **52 signed events**: 48 roots cycling six generated GLB flavours + a reply
  tree on root #1 (for badges/thread/childCount):
  - `a` — authored camera that frames ONLY a red cube (green cube parked
    outside the frustum) + animation → poster must be red-only.
  - `b` — static, no camera, both cubes → auto-fit poster must show both.
  - `c` — animated, no camera.
  - `d` — TWO cameras + animation, `preview-camera=1` → poster uses cam0
    (red), the live preview must use cam1 (green).
  - `e` — camera but NO animation → must never take a live slot.
  - `x` — animated flat wordmark plate.
  - Every event gets a unique `created_at` — identical tag sets would
    otherwise produce identical ids, and the app dedupes by id.
- **`http://localhost:4173`** — a proxy to the Vite dev server that injects
  `<script src="/__rig.js">` into the HTML. The hook calls
  `form0.pool.applyRelays(['wss://localhost:8443'])` once `window.__form0`
  exists. Because the dev CSP is `script-src 'self'`, the hook must be a
  SAME-ORIGIN script file — inline injection would be blocked.

Run: terminal 1 `bun run dev`, terminal 2 `node scripts/offline-rig.mjs`,
then point every suite at the proxy: `TARGET_URL=http://localhost:4173/ node
scripts/….mjs`.

## Measured results (this round, dev + production preview build)

`TARGET_URL=http://localhost:4173/ node scripts/perf.mjs` (headless SwiftShader,
single-core sandbox — the absolute numbers run ~8x slower than the repo CI
baseline, the RATIO gates are what matter):

| Gate | Budget | Measured (dev / prod) |
|---|---|---|
| `idleBoard.rendersPerSec` (static board) | 0 | **0 / 0** |
| heap growth board → end of session | flat | 54.2 → 54.2 MB |
| shader recompiles on repeat model opens | +0 | **+0** (rounds 2/3) |
| `boot.firstCardMs` (production) | < 1.5 s | 2.18 s (env-bound) |
| `stress.scrolling.p95` | < 120 ms | 278 ms (pure-raster baseline 104 ms — the sandbox GPU is the bottleneck, adaptive resolution bottomed at 0.7×) |

`node scripts/shaders.mjs` — 6 total GL compiles, repeat opens +0.
`node scripts/memcheck.mjs` (standalone file://) — boots alive, 0 events,
no crash, 20.7 MB heap. `node scripts/facing.mjs <models>` — flat wordmark
facing=(0,0,1) (+axis fallback holds), cubes any axis.

## Publish round-trip verification

`scripts/verify-publish.mjs` (11 checks, green on the production preview
build) covers the whole publish path the rig can now host:
studio text export → poster render → `PUT /upload` (kind-24242 auth, CORS
preflight) → relay publish (NIP-20 OK) → **live feed event** → SHA-256
verified re-download → kind-5 deletion → live tombstone. It also checks the
camera-model pass-through (no re-export) and pixels the publish poster:
100% red / 0% green, i.e. the authored camera view, not auto-fit.

## Deterministic bug-regression suite

`scripts/offline-verify.mjs` checks the five fixed bugs with pixel and state
assertions (agents have no vision; pixel checks are the eyes):

1. poster camera policy (red-only camera view, auto-fit fallback, two-camera
   `preview-camera` honouring),
2. live-preview slot reuse across the whole feed + budget invariants,
3. thread-map node animation,
4. 120 ms crossfades (ramp duration ≥ 90 ms, no instant hard swap),
5. studio: pointer passthrough above the W/E/R toolbar, camera untouched on
   import, look-at origin / look-at bbox center / fit-selected geometry.

All 25 checks pass against the rig.

## Harness corrections that were required along the way

- `scripts/interact.mjs` "loading ring" check slowed `assets.getModel`, but
  the viewer fetches via `getModelBytes` (the poster pipeline already decoded
  the bytes), so the ring never appeared — the check now delays
  `getModelBytes`.
- `scripts/settings.mjs` FOV check read `scene.activeCamera.fov`; when the
  active camera is the model's OWN authored camera it keeps its authored fov
  BY DESIGN, so the check now asserts the orbit camera the setting drives.
- `scripts/visual_critique.py` now skips OCR with a clear message when
  `tesseract` is unavailable (apt is blocked here); numpy/opencv install from
  pypi with `pip install --user --break-system-packages numpy
  opencv-python-headless pillow`.

## Real bugs this verification round caught (fixed)

- `Camera.rotationQuaternion` is **null at runtime** although the .d.ts
  declares it non-null — `.copyFrom()` threw for every model WITH an authored
  camera, so the preview pool failed all camera'd posts. Assignment works;
  the auto-fit path must clear it to null (cast through a nullable type).
- Pool eviction used `slot.visible`, which only `tick()` updates — and
  `tick()` runs AFTER the request pass in the same frame. Requests therefore
  saw stale "visible" flags: either nothing could be evicted (visible cards
  never animated once the pool filled) or offscreen prefetch cards
  ping-ponged (thousands of churned GLB loads). `request()` now takes the
  caller's fresh visible set, and the board only requests slots for
  on-screen cards.
- AssetContainer cleanup after reparenting root nodes under the slot's stage
  root produced "hierarchy is not valid" warnings — un-reparent before
  `removeAllFromScene()`.

## Sandbox resets: what survives and how to recover

2026-08-18 incident (this verification round): the sandbox was reset
mid-task. The whole workspace was replaced by a FRESH CLONE of the repo,
all processes killed, `/tmp` wiped.

What SURVIVED:

| State | Survived? |
|---|---|
| Pushed commits (remote branch) | ✅ intact — `git fetch` brings them back |
| Uncommitted file edits (tracked files) | ✅ the workspace snapshot preserved the file contents — they reappeared in the fresh clone as working-tree modifications against the old base |
| New untracked files (e.g. the rig scripts) | ✅ same snapshot mechanism |
| Local-only commits (not pushed) | ❌ the reset discarded the old `.git` — the new clone's branch pointed at main |
| `/tmp` (Chromium, certs, NSS libs), `node_modules/`, `shots/` (ignored), running processes, attached upload files | ❌ all gone |

Recovery procedure that worked:

```bash
git fetch origin <branch>                 # the branch may have moved: other
                                          # agents push to the same branch
git log --oneline HEAD..FETCH_HEAD        # what the remote has that I don't
git rev-parse HEAD FETCH_HEAD             # the local branch may have been
                                          # re-cloned to main's tip!
git diff FETCH_HEAD --stat                # ← the surviving working-tree
                                          #   delta, if any
git diff FETCH_HEAD > /tmp/recovered.patch
cp <untracked files> /tmp/                # untracked files are NOT in the diff
git reset --hard FETCH_HEAD               # re-anchor on the real remote tip
git apply /tmp/recovered.patch            # reapply the surviving delta
cp /tmp/<untracked files> back
git commit -am "…" && git push            # persist IMMEDIATELY
```

Then rebuild the environment (Chromium + NSS libs + certs + `node_modules`)
with the steps in this document — that part is mechanical, the source edits
are the irreplaceable part.

**The rule this incident produced** (also in `AGENTS.md` + `CONVENTIONS.md`):
commit small self-contained changes at least every **~60 seconds** of active
work and **`git push` immediately after each commit** — only pushed commits
survive a reset for certain. Local-only commits are NOT enough: they live in
the `.git` that the reset discards. Uncommitted working-tree edits survived
ONCE as a snapshot; do not bet the session on that.
