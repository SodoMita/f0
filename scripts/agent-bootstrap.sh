#!/bin/bash
# agent-bootstrap.sh — one-shot environment setup for a fresh agent sandbox.
#
#   bash scripts/agent-bootstrap.sh
#
# Run this FIRST in every new session. Sandboxes here reset at any moment and
# nothing outside the repo (and none of node_modules/) survives, so every
# session starts with: no bun, no node_modules, no browser, no rig certs.
# This script rebuilds all of it, idempotently, in ~1-2 minutes.
#
# Network constraints this script is built around (measured 2026-08-20):
#   - bun.sh install CDN         BLOCKED  -> bun comes from the npm registry
#   - Playwright browser CDN     BLOCKED  -> `npx playwright install` fails
#   - deb.debian.org (apt)       BLOCKED  -> no system packages
#   - registry.npmjs.org         WORKS    -> everything comes from here
#   - real Nostr relays / CDNs   BLOCKED  -> tests run on scripts/offline-rig.mjs
#
# What it sets up (each step skipped if already present):
#   1. bun            npm i -g bun (NOT curl|bash — that CDN is unreachable)
#   2. repo deps      bun install (bun.lock is the lockfile; never npm install)
#   3. chromium       @sparticuz/chromium from the npm registry (headless
#                     shell w/ SwiftShader WebGL) + its NSS libs, unpacked to
#                     /tmp/chromium + /tmp/chromium-libs (docs/SANDBOX-VERIFY.md)
#   4. playwright     wrapper shims at the revision paths playwright-core
#                     expects, so `import { chromium } from 'playwright'` and
#                     every scripts/*.mjs suite just work
#   5. rig certs      self-signed localhost cert for scripts/offline-rig.mjs
#   6. smoke check    bun + headless WebGL2 actually work
#
# After it finishes, the usual loop is:
#   bun run dev                                    # terminal 1 (port 5173)
#   node scripts/offline-rig.mjs                   # terminal 2 (4173 + 8443)
#   TARGET_URL=http://localhost:4173/ node scripts/smoke.mjs   # etc.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BROWSERS_DIR=/tmp/browsers
CHROMIUM_BIN=/tmp/chromium
CHROMIUM_LIBS=/tmp/chromium-libs
PW_CACHE="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
RIG_CERTS=/tmp/rig-certs
SPARTICUZ_VERSION=149.0.0

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32mok\033[0m  %s\n' "$*"; }
skip() { printf '   \033[2mskip\033[0m %s (already present)\n' "$*"; }
die()  { printf '   \033[31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 1. bun
say "bun"
if command -v bun >/dev/null 2>&1; then
  skip "bun $(bun --version)"
else
  # bun.sh's install CDN is unreachable from this sandbox; the npm registry
  # hosts the same binaries inside the `bun` package.
  npm install -g bun >/dev/null 2>&1 || die "npm i -g bun failed (is the npm registry reachable?)"
  command -v bun >/dev/null 2>&1 || die "bun not on PATH after npm i -g bun"
  ok "bun $(bun --version) (via npm registry)"
fi

# ---------------------------------------------------- 2. repo dependencies
say "repo dependencies"
cd "$REPO_DIR"
if [ -d node_modules/@babylonjs/core ] && [ -d node_modules/playwright-core ]; then
  skip "node_modules"
else
  bun install || die "bun install failed"
  ok "bun install"
fi

# --------------------------------------------------------- 3. chromium
# `npx playwright install` downloads from blocked CDNs. The npm registry
# hosts a complete Chromium headless shell inside @sparticuz/chromium
# (unpacks to /tmp/chromium on install). Full recipe: docs/SANDBOX-VERIFY.md.
say "headless chromium (npm registry route)"
if [ -x "$CHROMIUM_BIN" ]; then
  skip "$CHROMIUM_BIN"
else
  mkdir -p "$BROWSERS_DIR"
  cd "$BROWSERS_DIR"
  [ -f package.json ] || npm init -y >/dev/null 2>&1
  npm install "@sparticuz/chromium@$SPARTICUZ_VERSION" puppeteer-core >/dev/null 2>&1 \
    || die "npm i @sparticuz/chromium failed"
  # calling executablePath() unpacks /tmp/chromium (the CJS export nests
  # the API under .default)
  if [ ! -x "$CHROMIUM_BIN" ]; then
    node -e "const c=require('@sparticuz/chromium');const api=c.executablePath?c:c.default;api.executablePath().then(p=>console.log(p))" >/dev/null \
      || die "@sparticuz/chromium did not unpack $CHROMIUM_BIN"
    [ -x "$CHROMIUM_BIN" ] || die "$CHROMIUM_BIN still missing after executablePath()"
  fi
  ok "$CHROMIUM_BIN"
fi

# Debian lacks the three NSS libs the binary needs; the package ships them
# in a brotli-compressed bundle.
if [ -d "$CHROMIUM_LIBS/lib" ]; then
  skip "$CHROMIUM_LIBS/lib (NSS libs)"
else
  cd "$BROWSERS_DIR"
  node -e "const fs=require('fs'),z=require('zlib');fs.writeFileSync('/tmp/al2023.tar',z.brotliDecompressSync(fs.readFileSync('node_modules/@sparticuz/chromium/bin/al2023.tar.br')))" \
    || die "failed to decompress al2023.tar.br (NSS libs)"
  mkdir -p "$CHROMIUM_LIBS"
  tar -xf /tmp/al2023.tar -C "$CHROMIUM_LIBS"
  rm -f /tmp/al2023.tar
  [ -d "$CHROMIUM_LIBS/lib" ] || die "NSS libs missing after extract"
  ok "$CHROMIUM_LIBS/lib (libnspr4, libnss3, ...)"
fi

# ----------------------------------------------- 4. playwright wrapper shims
# playwright-core refuses to launch unless its expected revision directories
# exist. Read the revisions from the installed browsers.json (they change
# when the playwright dep is bumped — never hardcode them) and drop a wrapper
# script at each expected executable path.
say "playwright shims"
cd "$REPO_DIR"
WRAP="$PW_CACHE/chrome-wrap.sh"
mkdir -p "$PW_CACHE"
cat > "$WRAP" <<WRAPEOF
#!/bin/bash
export LD_LIBRARY_PATH=$CHROMIUM_LIBS/lib\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}
exec $CHROMIUM_BIN --no-sandbox --ignore-certificate-errors "\$@"
WRAPEOF
chmod +x "$WRAP"

node -e "
const d = require('$REPO_DIR/node_modules/playwright-core/browsers.json');
for (const b of d.browsers) {
  if (b.name === 'chromium') console.log('chromium-' + b.revision + '/chrome-linux64/chrome');
  if (b.name === 'chromium-headless-shell') console.log('chromium_headless_shell-' + b.revision + '/chrome-headless-shell-linux64/chrome-headless-shell');
}" | while read -r rel; do
  target="$PW_CACHE/$rel"
  if [ -x "$target" ] && cmp -s "$WRAP" "$target"; then
    skip "$rel"
  else
    mkdir -p "$(dirname "$target")"
    cp "$WRAP" "$target"
    touch "$PW_CACHE/$(echo "$rel" | cut -d/ -f1)/INSTALLATION_COMPLETE"
    ok "$rel"
  fi
done

# ------------------------------------------------------ 5. offline-rig certs
# scripts/offline-rig.mjs (the no-relay test feed) reads a self-signed
# localhost cert from /tmp/rig-certs and dies without it.
say "offline-rig TLS certs"
if [ -f "$RIG_CERTS/key.pem" ] && [ -f "$RIG_CERTS/cert.pem" ] \
   && openssl x509 -checkend 86400 -noout -in "$RIG_CERTS/cert.pem" >/dev/null 2>&1; then
  skip "$RIG_CERTS (valid > 24h)"
else
  mkdir -p "$RIG_CERTS"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout "$RIG_CERTS/key.pem" -out "$RIG_CERTS/cert.pem" \
    -days 30 -nodes -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1 \
    || die "openssl cert generation failed"
  ok "$RIG_CERTS/{key,cert}.pem"
fi

# ------------------------------------------------------------ 6. smoke check
# Prove the whole chain end to end: playwright launches the shimmed chromium
# and WebGL2 (SwiftShader) is actually available — every visual suite in
# scripts/ depends on exactly this.
say "smoke check"
cd "$REPO_DIR"
node -e "
import('playwright').then(async ({ chromium }) => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await b.newPage();
  const gl = await p.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
  await b.close();
  if (!gl) { console.error('webgl2 unavailable'); process.exit(1); }
  console.log('   \x1b[32mok\x1b[0m  playwright + chromium + WebGL2 (SwiftShader)');
}).catch((e) => { console.error('   FAIL playwright launch: ' + e.message); process.exit(1); });
" || die "smoke check failed"

say "done"
cat <<'NEXT'
   Everything is ready. Typical next steps:
     bun run dev                      # dev server on :5173
     node scripts/offline-rig.mjs     # offline relay+model rig on :4173/:8443
     TARGET_URL=http://localhost:4173/ node scripts/smoke.mjs
     bun run build                    # typecheck + bundle
   Reminder: commit + push every ~60s of work (docs/CONVENTIONS.md § Git).
NEXT
