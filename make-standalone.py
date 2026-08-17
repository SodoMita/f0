#!/usr/bin/env python3
"""Inline the release/ build into a single self-contained HTML file."""
from pathlib import Path
import base64
import re

root = Path(__file__).resolve().parent
release = root / 'release'
html = (release / 'index.html').read_text(encoding='utf-8')

chunks = {f.name: f.read_text(encoding='utf-8') for f in (release / 'assets').glob('*.js')}

# Remove modulepreload links
html = re.sub(r'<link[^>]*rel="modulepreload"[^>]*>', '', html)


def data_url(name: str) -> str:
    return 'data:text/javascript;base64,' + base64.b64encode(chunks[name].encode()).decode()


def inline_entry(match):
    src = match.group(1)
    if src.startswith(('http://', 'https://', '//')):
        return match.group(0)
    name = Path(src).name
    if name not in chunks:
        return match.group(0)
    js = chunks[name]
    # Rewrite from"./chunk.js" / from"./chunk.js" / import"./chunk.js"
    def repl(m):
        spec = m.group(2)
        base = Path(spec).name
        if base not in chunks:
            return m.group(0)
        return m.group(1) + '"' + data_url(base) + '"'
    js = re.sub(r'(from|import)\s*"([^"]+\.js)"', repl, js)
    js = js.replace('</script', '<\\/script')
    return f'<script type="module">{js}</script>'


html = re.sub(r'<script[^>]*src="([^"]+)"[^>]*></script>', inline_entry, html)

target = root / 'form-zero-standalone.html'
target.write_text(html, encoding='utf-8')
print(f'wrote {target} ({target.stat().st_size/1048576:.2f} MB)')
