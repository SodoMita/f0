#!/usr/bin/env python3
"""Inline release/ into ONE self-contained .html (spec step 10).

Preconditions (already configured in vite.config.ts):
  - inlineDynamicImports: exactly one JS chunk
  - assetsInlineLimit: 100 MB -> Draco wasm/js are data: URIs inside the chunk
This script inlines the JS chunk and the CSS into index.html.
"""
from pathlib import Path
import re

root = Path(__file__).resolve().parent
release = root / 'release'
html = (release / 'index.html').read_text(encoding='utf-8')

js_files = sorted((release / 'assets').glob('*.js'))
assert len(js_files) == 1, f'expected exactly 1 JS chunk, found {[f.name for f in js_files]}'
js = js_files[0].read_text(encoding='utf-8')

css_files = list((release / 'assets').glob('*.css'))
css = css_files[0].read_text(encoding='utf-8') if css_files else ''

# Strip modulepreload + any stylesheet links (CSS is inlined below).
html = re.sub(r'<link[^>]*rel="modulepreload"[^>]*>', '', html)
html = re.sub(r'<link[^>]*rel="stylesheet"[^>]*>', '', html)
if css:
    html = html.replace('</head>', f'<style>{css}</style></head>')

# Escape any literal "</script" inside the bundle and inline it.
js = js.replace('</script', '<\\/script')
html = re.sub(
    r'<script[^>]*type="module"[^>]*src="[^"]*"[^>]*></script>',
    lambda m: f'<script type="module">{js}</script>',
    html,
)

target = root / 'form-zero-standalone.html'
target.write_text(html, encoding='utf-8')
print(f'wrote {target} ({target.stat().st_size/1048576:.2f} MB)')
