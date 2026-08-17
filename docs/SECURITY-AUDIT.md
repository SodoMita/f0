# FORM/0 — Security Audit

**Date:** 2026-08-17 · **Scope:** full repository (`src/`, `index.html`, Vite
configs, deployment workflow, dependencies) · **Target:** the deployed
standalone (`form-zero-standalone.html` → GitHub Pages) and the web build.

Threat model: a fully untrusted public Nostr relay / Blossom server / other
player can feed this client arbitrary **signed** events and arbitrary model
bytes. Everything the bundle ships (our code, `nostr-tools`, Babylon.js) is
trusted; everything arriving over the wire is not until verified.

---

## Summary

| ID | Severity | Finding | Status |
|----|----------|---------|--------|
| H1 | **High** | Untrusted GLBs can trigger arbitrary, uncapped network fetches (tab crash + viewer-IP leak) | **Fixed** |
| H2 | **High** | `data:` textures bypass decoded-image limits (VRAM exhaustion) | **Fixed** |
| M1 | **Medium** | Anyone can hide any post for all users (kind-5 tombstone without NIP-09 author check) | **Fixed** |
| M2 | **Medium** | Deployed standalone shipped with **no CSP** (the web build had a strict one) | **Fixed** (tradeoff in M2) |
| M3 | Medium | Per-post deletion secrets stored in plaintext IndexedDB (spec claims AES-GCM) | **Fixed** |
| M4 | Medium | Sidecar imports could fetch remote resources and loaded GLBs before validation | **Fixed** |
| L1 | Low | Blossom download never enforced the documented "no cross-origin redirects" | **Fixed** |
| L2 | Low | Malicious Blossom response (`{"url":"https://"}`) crashes the publish flow | **Fixed** |
| L3 | Low | Non-finite (NaN/±Inf) vertex positions poison the auto-fit cameras | **Fixed** |
| L4 | Low | Persisted settings not range-validated on load (local tampering → boot failure) | **Fixed** |

Verified clean: no XSS sinks, event signature handling is sound, download
path is cap+hash+magic verified, dependency audit is clean, no secrets in
the repo, endpoint scheme allowlists are correct.

---

## 1. High

### H1 — Untrusted GLBs can make the browser fetch arbitrary URLs (uncapped download → crash; tracking)

**Where:** `src/model/limits.ts` (`validateGLB`), all three load paths
(`poster.ts`, `previewPool.ts`, `viewer.ts`, `studio.ts`).

**What:** `validateGLB` counts only the GLB *container*. A hostile post can
be a tiny, validly-signed GLB (a few hundred bytes — passes every limit)
whose JSON references external resources:

```json
"buffers": [{ "uri": "https://attacker.example/1GB.bin", "byteLength": 44 }],
"images":  [{ "uri": "https://attacker.example/pixel.png" }]
```

We confirmed against Babylon 8.10.1 sources and at runtime (Node, real
modules) that when a GLB is loaded from raw bytes — the exact path
`LoadAssetContainerAsync(bytes, scene, {pluginExtension:'.glb'})` uses —
the glTF loader's `_rootUrl` is `''` and `loadUriAsync()` passes any URI
straight to `_loadFile()` (XHR/fetch):

```
GET https://evil.example/large.bin
GET http://127.0.0.1:9999/track.png
GET images/tex.png          ← relative URIs resolve against the app origin
_ValidateUri() only blocks ".."
```

No size cap (the 20 MiB cap applies to the container, not the external
fetch), no hash check, no timeout of our own.

**Impact:**
- **Client DoS / tab crash.** A `buffers[].uri` pointing at a large or
  drip-slow file exhausts memory/bandwidth — "Aw, Snap!" — automatically,
  with zero user interaction, because the poster pipeline renders every
  card near the viewport. This bypasses the stated crash-prevention goal
  (AGENTS.md rule 3, SPEC "GLB limits … crash prevention").
- **Privacy leak to arbitrary third parties.** An `images[].uri` tracking
  pixel reveals the viewer's IP/UA/timing to a host that is neither a relay
  nor a Blossom server — outside the documented "IP visible to relays"
  privacy model, and independent of which relay served the event.

**Fix (applied):** `validateGLB` now rejects any non-empty `uri` that is
not a `data:` URI, anywhere in the JSON (buffers, images, extensions). The
product already only publishes self-contained GLBs (spec PIPELINE "external
URIs forbidden"), so this aligns enforcement with the spec. `data:` URIs
remain allowed, but image data URIs are MIME-allowlisted and dimension-scanned
before decode (H2).

**Verification:** Node regression tests against the real `limits.ts` cover
external buffer/image URIs, self-contained files, non-finite positions,
interleaved accessors, unsafe SVG data URIs and oversized data-texture headers.

### H2 — Data-URI textures bypassed decoded-image limits

**Where:** `src/model/limits.ts` image-budget loop.

The H1 fix deliberately allowed `data:` URIs because their compressed bytes
fit inside the 2 MiB JSON cap. Compressed size is not decoded size: up to 64
small solid-colour 4096² images can fit in that cap and ask the browser for
roughly 4 GiB of RGBA textures. The old image loop skipped every `img.uri`, so
none contributed to the decoded-pixel budget.

**Fix (applied):** data-image headers are decoded only far enough to read their
dimensions; PNG, JPEG (up to 64 KiB marker scan), every WebP framing, GIF, BMP
and KTX2 are covered. Unsafe/active image formats such as SVG and unknown
headers fail closed. BufferView images use the same parser and MIME allowlist.

---

## 2. Medium

### M1 — Any user can hide any post for every viewer (kind-5 without author check)

**Where:** `src/main.ts` (`pool.onEvent`, kind-5 branch).

**What:** incoming kind-5 events are signature-verified, but the client
tombstoned every `e`-tagged id **regardless of who signed it**. NIP-09
requires that a deletion event be authored by the same key as the deleted
event; relays are *not* required to enforce this, and many don't. So any
player can publish `{"kind":5,"tags":[["e","<victim-event-id>"]]}` signed
with their own key and the post vanishes from every FORM/0 board/thread.

**Fix (applied):** the client now checks `index.byId.get(id)?.pubkey ===
event.pubkey` before tombstoning. In-app deletion still works: posts are
signed with a per-post key and the kind-5 uses the same key, so the check
passes for the legitimate flow.

### M2 — The deployed artifact shipped with no Content-Security-Policy

**Where:** `vite.standalone.config.ts` (`plugins: []` — deliberately
dropped the CSP plugin), `make-standalone.py`.

**What:** the strict CSP exists only in `vite.config.ts`. The file that
actually goes to GitHub Pages / githack / jsDelivr mirrors is
`form-zero-standalone.html`, which had **no CSP at all** — while the app
ingests fully untrusted content (GLBs, event metadata). The original
comment's constraint is real (`script-src 'self'` cannot work from
`file://` with an inline script and `data:` Draco assets), but that doesn't
justify dropping the header entirely.

**Fix (applied):** new `csp.ts` with `WEB_CSP` (byte-identical to before)
and `STANDALONE_CSP`. The standalone now ships:

```
default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline';
connect-src https: wss: blob: data:; img-src blob: data: https:;
media-src blob: data: https:; worker-src blob: data:; font-src data:;
base-uri 'none'; object-src 'none'; frame-src 'none'
```

`base-uri/object-src/frame-src` are locked down and every fetch/worker/
media channel is restricted to the schemes the app actually uses (also
drops the unnecessary plain `ws:`). Tradeoff: the inline single-file script
cannot be `'self'`, so `script-src` falls back to `'unsafe-inline' data:` —
defense-in-depth (the app has no `innerHTML` sinks, so the practical
injection surface is small, but the header still blocks the most common
payload shapes and enforces the "no network except user content" property
by policy).

> **Action required before shipping:** `scripts/smoke.mjs` (headless
> browser) could not run in this sandbox — the Playwright browser download
> is blocked by the sandbox network. Verify the standalone still boots from
> `file://` under the new CSP with the repo's verification suite.

### M3 — Per-post deletion secrets stored in plaintext (spec says AES-GCM)

**Where:** `src/protocol/publish.ts` → `saveOwnedPost({ secretKey:
bytesToHex(secret), … })`; `src/protocol/storage.ts` (IndexedDB
`ownedPosts`).

**What:** docs/SPEC.md SECURITY claims "Secrets: per-post keys, envelope
only" and PROTOCOL claims "secrets AES-GCM"; the code stored each per-post
Nostr signing key as plaintext hex in IndexedDB.

**Fix (applied):** database v4 adds a `keyring` store. It atomically creates
one non-extractable 256-bit WebCrypto AES-GCM key (the read + conditional put
share a readwrite transaction, so two tabs cannot race). `ownedPosts` now
stores `{v, algorithm, iv, ciphertext}`; the event id is authenticated as AAD,
so envelopes cannot be swapped between posts. v3 plaintext records migrate
one-way before reaching the deletion service, malformed/decryption-failed
records are not exposed to signing, and secret byte arrays are zeroed after
use. Security-sensitive writes propagate quota/clone failures and complete
before relay broadcast, so the app does not knowingly publish a creation it
cannot later sign a deletion for.

The wrapping key remains same-origin browser state so deletion survives a
reload. This is at-rest envelope protection and fulfills the spec; it is not a
claim that client-side encryption can defeat arbitrary same-origin script
execution, which could ask WebCrypto to decrypt on its behalf.

**Verification:** real WebCrypto round-trip test plus an AAD substitution test
(event-id swap) passed; the production typecheck/build is green.

### M4 — Sidecar imports crossed the network boundary and bypassed pre-validation

The merged sidecar branch called Babylon on `.glb` bytes before `validateGLB`
and allowed `.gltf`/OBJ/MTL references to fall through to HTTP or app-origin
URLs. An imported file could therefore restore H1's request/DoS behavior.

**Fix (applied):** GLBs are validated before load. Multi-file imports are
limited to 128 files / 20 MiB total; glTF structure, buffers, accessors, scene
depth and texture dimensions are preflighted; OBJ vertices/faces/materials are
bounded. Every dependency must be a selected local basename (or a safe `data:`
URI for glTF), remote/absolute/missing/ambiguous references fail closed, and
the global OBJ hook only intercepts `file:` dependencies.

---

## 3. Low

### L1 — "No cross-origin redirects" was documented but not implemented

`BlossomClient.download` used default `redirect: 'follow'`. Content stays
SHA-256+magic verified either way, so no injection — but a redirect hands
the viewer's IP to the redirect target. **Fixed:** `redirect: 'error'`;
redirecting replicas are skipped in favor of the next replica (which is the
point of having replicas).

### L2 — Malicious Blossom response breaks the publish flow

`upload()` accepted `{"url":"https://"}` (regex `/^https:\/\//` passes),
then `publish.ts`'s `new URL(u.url).origin` throws — the whole publish dies
*after* the bytes were uploaded. **Fixed:** upload now `new URL(...)`-parses
and requires `https:` + a real hostname.

### L3 — NaN/±Infinity geometry poisons the auto-fit cameras

Positions are attacker-controlled float32 values; LIMITS counts only
vertices. A NaN bubbles through `worldBox`/`frameDistance` → NaN camera →
blank poster / invisible model (per-post self-DoS, caught by existing
try/catch). **Fixed:** `validateGLB` scans uncompressed `POSITION`
accessors (including interleaved) and rejects non-finite values; Draco/
meshopt primitives stay covered by container caps.

### L4 — Persisted settings are not range-validated on load

`SettingsStore.load` merged any string/number/boolean from IndexedDB into
the schema — a corrupted/tampered record (`background: "garbage"`,
`resolutionWidth: 1e9`) could fail `Color4.FromHexString` or request a
ludicrous drawing buffer and break boot.

**Fixed:** schema-driven validation now accepts only known stateful keys with
exact types, finite values, declared min/max ranges, select allowlists and
six-digit colours. Invalid values fall back to defaults, unknown/action/info
keys are dropped, `nearClip < farClip` is enforced, and the repaired record is
persisted. Runtime patches pass through the same boundary. Network config and
the legacy settings helper also validate their IndexedDB shapes.

**Verification:** a tampered-record regression test covered bad colour,
1e9 resolution, Infinity budget, inverted clip range, forged select values and
an unknown prototype key; all reset while valid values survived.

---

## 4. Remaining recommendations

1. **Browser-level re-verification of the standalone under the CSP** (repo
   suite: `scripts/smoke.mjs`, `features.mjs`, `perf.mjs`) once a Playwright
   browser is available in CI/sandbox.
2. **Pin GitHub Actions and consider scheduled dependency audits.** Runtime
   package versions are locked and `npm audit` is clean today; action tags are
   still mutable upstream references.
3. Optional: keep `KHR_materials_*`/loader-extension allowlist in
   `src/model/gltf.ts` documented — it already excludes
   `KHR_interactivity` (Babylon's FlowGraph); add a security review whenever
   enabling an extension that can fetch external data or execute behavior.

---

## 5. Verified clean (non-findings)

| Area | Result |
|---|---|
| XSS | No `innerHTML`/`insertAdjacentHTML` with data — all user content (metadata drawer, HUD, network panel rows, toasts, filenames) goes through `textContent` or canvas; the only `innerHTML` uses are compile-time constants. Babylon GUI text is canvas-drawn. |
| Event signature verification | Verified once per event in an inline worker (sync fallback); nostr-tools' `verifiedSymbol` is stripped so relays cannot pre-bless wire objects; the relay's duplicate check is deliberately disabled only because the app verifies first (`nostr.ts`). |
| Event schema hardening | mime allowlist, sha256 hex64, size ∈ [1, 20 MiB], future-timestamp cap (+300 s), https-only `url`/`fallback`/`thumb`, thread refs validated as exactly-one hex64 root+reply, non-hex/future → dropped. |
| Download path | Streaming size cap (20 MiB model / 2 MiB thumb), 30 s timeout, `credentials: 'omit'`, per-replica SHA-256 + magic-byte + exact-size verification, poster fallback to local render. |
| Endpoints | Relay URLs: `wss:` only, credentials stripped (`normalizeRelay`). Blossom: `https:` only. Private-network targets are additionally blocked by Chrome's Private Network Access / mixed-content rules. |
| Crypto | SHA-256 plus AES-256-GCM ownership envelopes with random 96-bit IVs and event-id AAD; the wrapping key is non-extractable. Per-post signing secrets come from `generateSecretKey`; Blossom auth kind-24242 carries a 10-minute `expiration`. |
| CSP (web build) | Strict: `script-src 'self'`, no unsafe-eval, `base-uri/object-src/frame-src` locked. |
| Dependencies | `npm audit` (prod + dev): **0 vulnerabilities** today. |
| Deployment | No secrets in repo or workflow; GitHub token least-privilege for the mirror push; Pages source stays `workflow`-built artifact. |
| WebSocket/Blossom auth | No credentials on any fetch; `Authorization: Nostr` only on intentional uploads. |

---

## 6. Scope notes

- The audit covered the client code (including the subsequently merged
  sidecar importer), both Vite configs, the standalone bundler, the deploy
  workflow, and dependency advisories. It did **not**
  audit Babylon.js / nostr-tools internals beyond the loader fetch path
  (they are the trusted third-party surface; both are pinned exact, and the
  loader-extension allowlist in `src/model/gltf.ts` is the right control).
- Browser-based verification (smoke/perf/feature scripts, plus a live
  headless PoC of H1) could not run here — the sandbox cannot download a
  Playwright browser. The Babylon fetch behavior was instead confirmed by
  reading the loader source and by executing the real `glTFLoader.js`
  modules in Node with a stubbed fetch (see §1 H1).
