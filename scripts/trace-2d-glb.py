#!/usr/bin/env python3
"""Trace the image plates in src/studio/library/traces/ into flat +Z GLBs.

Output: src/studio/library/2d/<name>.glb
"""

from __future__ import annotations

import importlib.util
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "src", "studio", "library", "2d")


def _load_gen():
    import sys
    path = os.path.join(HERE, "gen-library-glb.py")
    spec = importlib.util.spec_from_file_location("genlib", path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader
    sys.modules["genlib"] = mod
    spec.loader.exec_module(mod)
    return mod


G = _load_gen()
Mesh = G.Mesh
disc = G.disc
write_glb = G.write_glb


INK = (0.07, 0.07, 0.08)
YELLOW = (1.0, 0.82, 0.0)
HEART = (0.89, 0.11, 0.14)
STAR = (0.96, 0.71, 0.0)
CHECK = (0.13, 0.69, 0.30)
LOCK = (0.96, 0.71, 0.0)
ROOF = (0.89, 0.11, 0.14)
DOOR = (0.55, 0.35, 0.18)
GLASS = (0.31, 0.76, 0.97)
WALL = (1.0, 0.82, 0.0)


def poly(pts, color, z=0.0) -> Mesh:
    m = Mesh()
    if len(pts) < 3:
        return m
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    c = (cx, cy, z)
    for i in range(len(pts)):
        a = (pts[i][0], pts[i][1], z)
        b = (pts[(i + 1) % len(pts)][0], pts[(i + 1) % len(pts)][1], z)
        m.add_tri(c, a, b, color)
    return m


def ring(r0, r1, segs, color, z=0.0) -> Mesh:
    m = Mesh()
    for i in range(segs):
        a0 = 2 * math.pi * i / segs
        a1 = 2 * math.pi * (i + 1) / segs
        p0 = (r0 * math.cos(a0), r0 * math.sin(a0), z)
        p1 = (r1 * math.cos(a0), r1 * math.sin(a0), z)
        p2 = (r1 * math.cos(a1), r1 * math.sin(a1), z)
        p3 = (r0 * math.cos(a1), r0 * math.sin(a1), z)
        m.add_quad(p0, p3, p2, p1, color)
    return m


def arc_ribbon(r, half_w, a0, a1, segs, color, z=0.0) -> Mesh:
    m = Mesh()
    for i in range(segs):
        t0 = a0 + (a1 - a0) * i / segs
        t1 = a0 + (a1 - a0) * (i + 1) / segs
        c0, s0 = math.cos(t0), math.sin(t0)
        c1, s1 = math.cos(t1), math.sin(t1)
        inner0 = ((r - half_w) * c0, (r - half_w) * s0, z)
        outer0 = ((r + half_w) * c0, (r + half_w) * s0, z)
        inner1 = ((r - half_w) * c1, (r - half_w) * s1, z)
        outer1 = ((r + half_w) * c1, (r + half_w) * s1, z)
        m.add_quad(inner0, inner1, outer1, outer0, color)
    # round caps
    m.merge(disc(half_w, 10, color, z).translated((r * math.cos(a0), r * math.sin(a0), 0)))
    m.merge(disc(half_w, 10, color, z).translated((r * math.cos(a1), r * math.sin(a1), 0)))
    return m


def bar(x0, y0, x1, y1, w, color, z=0.0) -> Mesh:
    m = Mesh()
    dx, dy = x1 - x0, y1 - y0
    L = math.hypot(dx, dy) or 1.0
    px, py = -dy / L * w, dx / L * w
    m.add_quad((x0 - px, y0 - py, z), (x1 - px, y1 - py, z), (x1 + px, y1 + py, z), (x0 + px, y0 + py, z), color)
    m.merge(disc(w, 10, color, z).translated((x0, y0, 0)))
    m.merge(disc(w, 10, color, z).translated((x1, y1, 0)))
    return m


def rounded_rect(hx, hy, r, color, z=0.0) -> Mesh:
    r = min(r, hx - 0.01, hy - 0.01)
    m = Mesh()
    m.merge(poly(
        [(-hx + r, -hy), (hx - r, -hy), (hx - r, hy), (-hx + r, hy)],
        color, z,
    ))
    m.merge(poly(
        [(-hx, -hy + r), (hx, -hy + r), (hx, hy - r), (-hx, hy - r)],
        color, z,
    ))
    for cx, cy in ((-hx + r, -hy + r), (hx - r, -hy + r), (hx - r, hy - r), (-hx + r, hy - r)):
        m.merge(disc(r, 10, color, z).translated((cx, cy, 0)))
    return m


def smile() -> Mesh:
    m = disc(0.50, 36, INK, 0.0)
    m.merge(disc(0.43, 36, YELLOW, 0.002))
    m.merge(disc(0.075, 14, INK, 0.004).translated((-0.155, 0.10, 0)))
    m.merge(disc(0.075, 14, INK, 0.004).translated((0.155, 0.10, 0)))
    # mouth: lower arc, matching the photo
    m.merge(arc_ribbon(0.22, 0.038, math.radians(210), math.radians(330), 16, INK, 0.004).translated((0, -0.02, 0)))
    return m


def heart() -> Mesh:
    pts = []
    steps = 40
    for i in range(steps):
        t = 2 * math.pi * i / steps
        x = 0.028 * 16 * math.sin(t) ** 3
        y = 0.028 * (13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t))
        pts.append((x, y - 0.04))
    return poly(pts, HEART, 0.0)


def star() -> Mesh:
    pts = []
    for i in range(10):
        a = -math.pi / 2 + i * math.pi / 5
        rad = 0.50 if i % 2 == 0 else 0.191
        pts.append((rad * math.cos(a), rad * math.sin(a)))
    return poly(pts, STAR, 0.0)


def house() -> Mesh:
    # black under-silhouette, then fills (matches the outlined cartoon house)
    m = Mesh()
    # roof outline
    roof_outer = [(-0.48, 0.08), (0.0, 0.58), (0.48, 0.08)]
    roof_inner = [(-0.38, 0.12), (0.0, 0.48), (0.38, 0.12)]
    m.merge(poly(roof_outer, INK, 0.0))
    m.merge(poly(roof_inner, ROOF, 0.002))
    # body outline + fill
    m.merge(poly([(-0.38, -0.48), (0.38, -0.48), (0.38, 0.12), (-0.38, 0.12)], INK, 0.0))
    m.merge(poly([(-0.32, -0.42), (0.32, -0.42), (0.32, 0.08), (-0.32, 0.08)], WALL, 0.002))
    # door
    m.merge(poly([(-0.26, -0.42), (-0.04, -0.42), (-0.04, -0.08), (-0.26, -0.08)], INK, 0.003))
    m.merge(poly([(-0.23, -0.39), (-0.07, -0.39), (-0.07, -0.11), (-0.23, -0.11)], DOOR, 0.004))
    m.merge(disc(0.018, 8, INK, 0.005).translated((-0.10, -0.25, 0)))
    # window
    m.merge(poly([(0.06, -0.18), (0.28, -0.18), (0.28, 0.02), (0.06, 0.02)], INK, 0.003))
    m.merge(poly([(0.09, -0.15), (0.15, -0.15), (0.15, -0.05), (0.09, -0.05)], GLASS, 0.004))
    m.merge(poly([(0.19, -0.15), (0.25, -0.15), (0.25, -0.05), (0.19, -0.05)], GLASS, 0.004))
    m.merge(poly([(0.09, -0.02), (0.15, -0.02), (0.15, 0.00), (0.09, -0.00)], GLASS, 0.004))
    m.merge(poly([(0.09, -0.02), (0.15, -0.02), (0.15, -0.00), (0.09, 0.00)], GLASS, 0.004))
    m.merge(poly([(0.09, -0.02), (0.15, -0.02), (0.15, 0.00), (0.09, 0.00)], GLASS, 0.004))
    m.merge(poly([(0.19, -0.02), (0.25, -0.02), (0.25, 0.00), (0.19, 0.00)], GLASS, 0.004))
    # four panes properly
    m.merge(poly([(0.09, -0.15), (0.155, -0.15), (0.155, -0.085), (0.09, -0.085)], GLASS, 0.004))
    m.merge(poly([(0.185, -0.15), (0.25, -0.15), (0.25, -0.085), (0.185, -0.085)], GLASS, 0.004))
    m.merge(poly([(0.09, -0.055), (0.155, -0.055), (0.155, 0.00), (0.09, 0.00)], GLASS, 0.004))
    m.merge(poly([(0.185, -0.055), (0.25, -0.055), (0.25, 0.00), (0.185, 0.00)], GLASS, 0.004))
    return m


def check() -> Mesh:
    # two thick rounded bars, photo angles
    m = bar(-0.32, -0.02, -0.08, -0.28, 0.09, CHECK, 0.0)
    m.merge(bar(-0.08, -0.28, 0.38, 0.26, 0.09, CHECK, 0.0))
    return m


def lock() -> Mesh:
    m = Mesh()
    # shackle: gold ring, open at the bottom where it meets the body
    sh = ring(0.18, 0.30, 28, LOCK, 0.0)
    # keep only the upper 200 degrees by rebuilding
    sh = Mesh()
    segs = 22
    a0, a1 = math.radians(10), math.radians(170)
    r0, r1 = 0.18, 0.30
    for i in range(segs):
        t0 = a0 + (a1 - a0) * i / segs
        t1 = a0 + (a1 - a0) * (i + 1) / segs
        # shackle sits above the body; angles from +X, we want upper half in +Y
        # use angles from +X going CCW: 10°..170° is upper half
        p0 = (r0 * math.cos(t0), 0.08 + r0 * math.sin(t0), 0.0)
        p1 = (r1 * math.cos(t0), 0.08 + r1 * math.sin(t0), 0.0)
        p2 = (r1 * math.cos(t1), 0.08 + r1 * math.sin(t1), 0.0)
        p3 = (r0 * math.cos(t1), 0.08 + r0 * math.sin(t1), 0.0)
        sh.add_quad(p0, p3, p2, p1, LOCK)
    m.merge(sh)
    # body
    m.merge(rounded_rect(0.32, 0.28, 0.08, LOCK, 0.0).translated((0, -0.20, 0)))
    # keyhole as a cut-looking inset (darker gold, sits on the plate)
    hole = (0.96, 0.88, 0.55)
    # use a near-white cut so it reads as a hole on the yellow lock
    cut = (0.98, 0.98, 0.97)
    m.merge(disc(0.07, 14, cut, 0.003).translated((0, -0.14, 0)))
    m.merge(poly([(-0.045, -0.16), (0.045, -0.16), (0.028, -0.32), (-0.028, -0.32)], cut, 0.003))
    return m


TRACES = [
    ("smile", YELLOW, smile),
    ("heart", HEART, heart),
    ("star", STAR, star),
    ("house", WALL, house),
    ("check", CHECK, check),
    ("lock", LOCK, lock),
]


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    for name, color, fn in TRACES:
        mesh = fn()
        dest = os.path.join(OUT, name + ".glb")
        write_glb(mesh, dest, name, color, double_sided=True, prefer="+z")
        print(f"  2d  {name:8}  {os.path.getsize(dest):5d} B  tris={len(mesh.i)//3}")
    print(f"wrote {len(TRACES)} traced plates → {OUT}")


if __name__ == "__main__":
    main()
