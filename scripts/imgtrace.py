#!/usr/bin/env python3
"""PNG → disjoint colour regions → flat (z=0) triangles.

Pipeline: ImageMagick quantize to PPM, stitch pixel-boundary loops, RDP,
earcut (holes as holes — never stacked layers). One pixel, one colour, so
regions cannot overlap and cannot z-fight.
"""

from __future__ import annotations

import json
import os
import subprocess
from collections import defaultdict, deque

HERE = os.path.dirname(os.path.abspath(__file__))


def _skip_ppm(raw: bytes, i: int) -> int:
    while i < len(raw):
        if raw[i] in b" \t\r\n":
            i += 1
            continue
        if raw[i:i + 1] == b"#":
            while i < len(raw) and raw[i] not in b"\n":
                i += 1
            continue
        break
    return i


def load_quantized(path: str, size: int = 180, colors: int = 8) -> tuple[int, int, list[tuple[int, int, int]]]:
    raw = subprocess.check_output([
        "convert", path, "-alpha", "off", "-resize", f"{size}x{size}",
        "-colors", str(colors), "-depth", "8", "ppm:-",
    ])
    if not raw.startswith(b"P6"):
        raise ValueError("expected binary PPM from convert")
    i = _skip_ppm(raw, 2)
    tokens: list[bytes] = []
    while len(tokens) < 3:
        i = _skip_ppm(raw, i)
        j = i
        while j < len(raw) and raw[j] not in b" \t\r\n":
            j += 1
        tokens.append(raw[i:j])
        i = j
    w, h = int(tokens[0]), int(tokens[1])
    i = _skip_ppm(raw, i)
    pix = raw[i:]
    pixels = [(pix[k], pix[k + 1], pix[k + 2]) for k in range(0, w * h * 3, 3)]
    return w, h, pixels


def _white(c: tuple[int, int, int]) -> bool:
    return c[0] > 240 and c[1] > 240 and c[2] > 240


def components(w: int, h: int, pixels: list[tuple[int, int, int]], color) -> list[list[tuple[int, int]]]:
    seen = [False] * (w * h)
    out: list[list[tuple[int, int]]] = []
    for y in range(h):
        for x in range(w):
            i = y * w + x
            if seen[i] or pixels[i] != color:
                continue
            blob: list[tuple[int, int]] = []
            q = deque([(x, y)])
            seen[i] = True
            while q:
                cx, cy = q.popleft()
                blob.append((cx, cy))
                for nx, ny in ((cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)):
                    if nx < 0 or ny < 0 or nx >= w or ny >= h:
                        continue
                    j = ny * w + nx
                    if seen[j] or pixels[j] != color:
                        continue
                    seen[j] = True
                    q.append((nx, ny))
            if len(blob) >= 8:
                out.append(blob)
    return out


def _loops_from_mask(w: int, h: int, filled: set[tuple[int, int]]) -> list[list[tuple[float, float]]]:
    nxt: dict[tuple[int, int], list[tuple[int, int]]] = defaultdict(list)

    def edge(a, b):
        nxt[a].append(b)

    for x, y in filled:
        if (x, y - 1) not in filled:
            edge((x, y), (x + 1, y))
        if (x + 1, y) not in filled:
            edge((x + 1, y), (x + 1, y + 1))
        if (x, y + 1) not in filled:
            edge((x + 1, y + 1), (x, y + 1))
        if (x - 1, y) not in filled:
            edge((x, y + 1), (x, y))

    used: set[tuple[tuple[int, int], tuple[int, int]]] = set()
    loops: list[list[tuple[float, float]]] = []
    for start in list(nxt.keys()):
        for first in nxt[start]:
            if (start, first) in used:
                continue
            path = [start]
            a, b = start, first
            while True:
                used.add((a, b))
                path.append(b)
                cands = [c for c in nxt[b] if (b, c) not in used]
                if not cands:
                    break
                # prefer continuing; otherwise first unused
                a, b = b, cands[0]
                if b == start:
                    path.append(b)
                    break
            if len(path) >= 4:
                loops.append([(float(p[0]), float(p[1])) for p in path[:-1]])
    return loops


def rdp(pts: list[tuple[float, float]], eps: float) -> list[tuple[float, float]]:
    if len(pts) < 3:
        return pts
    ax, ay = pts[0]
    bx, by = pts[-1]
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    if L2 < 1e-12:
        # degenerate (closed ring passed in) — split at farthest from start
        best, idx = -1.0, 1
        for i in range(1, len(pts) - 1):
            px, py = pts[i]
            d = (px - ax) * (px - ax) + (py - ay) * (py - ay)
            if d > best:
                best, idx = d, i
        if best < eps * eps or idx <= 0:
            return [pts[0]]
        left = rdp(pts[: idx + 1], eps)
        right = rdp(pts[idx:], eps)
        return left[:-1] + right
    L = L2 ** 0.5
    best, idx = -1.0, 0
    for i in range(1, len(pts) - 1):
        px, py = pts[i]
        d = abs(dx * (ay - py) - dy * (ax - px)) / L
        if d > best:
            best, idx = d, i
    if best < eps:
        return [pts[0], pts[-1]]
    left = rdp(pts[: idx + 1], eps)
    right = rdp(pts[idx:], eps)
    return left[:-1] + right


def area(pts: list[tuple[float, float]]) -> float:
    s = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return 0.5 * s


def pip(pt: tuple[float, float], poly: list[tuple[float, float]]) -> bool:
    x, y = pt
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            t = (y - y1) / (y2 - y1 + 1e-18)
            if x < x1 + t * (x2 - x1):
                inside = not inside
    return inside


def _ensure_ccw(pts: list[tuple[float, float]], want_ccw: bool) -> list[tuple[float, float]]:
    a = area(pts)
    if (a > 0) != want_ccw:
        return list(reversed(pts))
    return pts


def nest(loops: list[list[tuple[float, float]]]) -> list[tuple[list, list]]:
    """Return [(outer, [holes]), …]. Image y-down: outer is clockwise (area<0)."""
    scored = [(abs(area(p)), p) for p in loops if abs(area(p)) > 1.5]
    scored.sort(reverse=True)
    groups: list[tuple[list, list]] = []
    for _a, loop in scored:
        parent = None
        sample = loop[0]
        for i, (outer, _holes) in enumerate(groups):
            if pip(sample, outer):
                parent = i
        if parent is None:
            groups.append((_ensure_ccw(loop, True), []))
        else:
            groups[parent][1].append(_ensure_ccw(loop, False))
    return groups


def _earcut(outer, holes) -> list[tuple[tuple[float, float], tuple[float, float], tuple[float, float]]]:
    data: list[float] = []
    hole_idx: list[int] = []
    for x, y in outer:
        data.extend((x, y))
    for hole in holes:
        hole_idx.append(len(data) // 2)
        for x, y in hole:
            data.extend((x, y))
    proc = subprocess.run(
        ["node", os.path.join(HERE, "earcut-cli.mjs")],
        input=json.dumps({"data": data, "holes": hole_idx}),
        text=True, capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr[-400:])
    idx = json.loads(proc.stdout or "[]")
    verts = [(data[i * 2], data[i * 2 + 1]) for i in range(len(data) // 2)]
    tris = []
    for i in range(0, len(idx), 3):
        tris.append((verts[idx[i]], verts[idx[i + 1]], verts[idx[i + 2]]))
    return tris


def _merge_colors(pixels: list[tuple[int, int, int]], thresh: int = 200) -> list[tuple[int, int, int]]:
    """Snap anti-alias fringes onto the nearest dominant fill colour."""
    counts: dict[tuple[int, int, int], int] = {}
    for c in pixels:
        if _white(c):
            continue
        counts[c] = counts.get(c, 0) + 1
    ranked = sorted(counts, key=lambda c: -counts[c])
    remap: dict[tuple[int, int, int], tuple[int, int, int]] = {}
    masters: list[tuple[int, int, int]] = []
    for c in ranked:
        hit = None
        for m in masters:
            l1 = abs(c[0] - m[0]) + abs(c[1] - m[1]) + abs(c[2] - m[2])
            # AA fringes are close AND rare; real fills (door vs roof) are not rare
            if l1 <= 24 or (l1 <= thresh and counts[c] < 0.18 * counts[m]):
                hit = m
                break
        if hit is None:
            masters.append(c)
            remap[c] = c
        else:
            remap[c] = hit
    return [remap.get(c, c) for c in pixels]


def trace_png(path: str, size: int = 160, colors: int = 8, rdp_eps: float = 1.6):
    w, h, pixels = load_quantized(path, size=size, colors=colors)
    pixels = _merge_colors(pixels)
    palette = {}
    for c in pixels:
        if _white(c):
            continue
        palette[c] = palette.get(c, 0) + 1
    filled = sum(palette.values()) or 1
    keep = {c for c, n in palette.items() if n >= max(40, filled // 80)}
    tris: list[tuple[tuple[float, float, float], tuple[float, float, float]]] = []
    # y-down image → y-up mesh later
    for color in keep:
        for blob in components(w, h, pixels, color):
            filled = set(blob)
            loops = []
            for loop in _loops_from_mask(w, h, filled):
                simp = rdp(loop + [loop[0]], rdp_eps)[:-1]
                if len(simp) >= 3:
                    loops.append(simp)
            for outer, holes in nest(loops):
                if len(outer) < 3:
                    continue
                rgb = (color[0] / 255.0, color[1] / 255.0, color[2] / 255.0)
                for a, b, c in _earcut(outer, [hh for hh in holes if len(hh) >= 3]):
                    tris.append(((a[0], a[1], 0.0), (b[0], b[1], 0.0), (c[0], c[1], 0.0), rgb))  # type: ignore
    if not tris:
        raise RuntimeError(f"no fill in {path}")
    xs = [p[0] for t in tris for p in t[:3]]
    ys = [p[1] for t in tris for p in t[:3]]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    cx, cy = (minx + maxx) * 0.5, (miny + maxy) * 0.5
    span = max(maxx - minx, maxy - miny) or 1.0
    s = 1.0 / span
    out = []
    for a, b, c, rgb in tris:  # type: ignore
        def map_pt(p):
            # flip y (image down → mesh up), centre, unit size
            return ((p[0] - cx) * s, -(p[1] - cy) * s, 0.0)
        out.append((map_pt(a), map_pt(b), map_pt(c), rgb))
    return out
