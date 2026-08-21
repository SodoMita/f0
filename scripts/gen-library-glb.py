#!/usr/bin/env python3
"""Author the studio library: tiny self-contained GLBs with outward CCW faces.

glTF is right-handed Y-up. Every triangle is wound CCW when viewed from
outside; after emit we flip any face whose normal points toward the mesh
centroid so lighting cannot invert (the previous hand-built OBJs did). Voxel
pieces are the exception: their winding is exact by construction and they are
concave, so they finish with prefer="keep" (the centroid test would invert the
faces inside a notch).

Colour is authored as a PALETTE NAME (`scripts/palette.py`) — never a loose RGB
literal. `libglb.write_glb` turns each vertex colour into a UV on the shared
32x32 palette texture that ships inside every GLB.

Art direction (2026-08-21): faces are low-poly BALLS (subdivided icosahedra
with beaded features), not flat plates, and there is a voxel group — space
invader, arcade ghost, creeper-style head, grass block, snake, sword, 8-bit
heart — built with greedy-meshed cubes.
"""

from __future__ import annotations

import json
import math
import os
import struct
from dataclasses import dataclass, field

_SCRIPTS = os.path.dirname(os.path.abspath(__file__))
if _SCRIPTS not in __import__("sys").path:
    __import__("sys").path.insert(0, _SCRIPTS)
import palette  # noqa: E402
from libglb import write_glb  # noqa: E402

P = palette.rgb

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "studio", "library", "glb")


@dataclass
class Mesh:
    v: list[list[float]] = field(default_factory=list)
    n: list[list[float]] = field(default_factory=list)
    c: list[list[float]] = field(default_factory=list)
    i: list[int] = field(default_factory=list)

    def add_tri(self, a, b, c, color) -> None:
        base = len(self.v)
        for p in (a, b, c):
            self.v.append([float(p[0]), float(p[1]), float(p[2])])
            self.c.append([float(color[0]), float(color[1]), float(color[2])])
            self.n.append([0.0, 0.0, 0.0])
        self.i.extend([base, base + 1, base + 2])

    def add_quad(self, a, b, c, d, color) -> None:
        self.add_tri(a, b, c, color)
        self.add_tri(a, c, d, color)

    def merge(self, other: "Mesh") -> "Mesh":
        off = len(self.v)
        self.v.extend(other.v)
        self.n.extend(other.n)
        self.c.extend(other.c)
        self.i.extend(i + off for i in other.i)
        return self

    def translated(self, t) -> "Mesh":
        out = Mesh()
        out.v = [[p[0] + t[0], p[1] + t[1], p[2] + t[2]] for p in self.v]
        out.n = [n[:] for n in self.n]
        out.c = [c[:] for c in self.c]
        out.i = list(self.i)
        return out

    def scaled(self, s) -> "Mesh":
        if isinstance(s, (int, float)):
            s = (s, s, s)
        out = Mesh()
        out.v = [[p[0] * s[0], p[1] * s[1], p[2] * s[2]] for p in self.v]
        out.n = [n[:] for n in self.n]
        out.c = [c[:] for c in self.c]
        out.i = list(self.i)
        return out

    def rotated(self, axis: str, deg: float) -> "Mesh":
        a = math.radians(deg)
        c, s = math.cos(a), math.sin(a)
        out = Mesh()
        for p in self.v:
            x, y, z = p
            if axis == "x":
                x, y, z = x, c * y - s * z, s * y + c * z
            elif axis == "y":
                x, y, z = c * x + s * z, y, -s * x + c * z
            else:
                x, y, z = c * x - s * y, s * x + c * y, z
            out.v.append([x, y, z])
        out.n = [n[:] for n in self.n]
        out.c = [col[:] for col in self.c]
        out.i = list(self.i)
        return out

    def finish(self, prefer: str = "outward") -> "Mesh":
        """Compute vertex normals.

        prefer='outward' flips a face only when it clearly points at the
        centroid (closed 3D). prefer='+z' keeps plates facing +Z — a flat
        mesh has a centroid in-plane, so the outward test is noise and
        used to invert features. prefer='keep' trusts the authored winding
        (voxel meshes: exact by construction, and concave, so the centroid
        test would invert every face inside a notch).
        """
        if not self.v:
            return self
        cx = sum(p[0] for p in self.v) / len(self.v)
        cy = sum(p[1] for p in self.v) / len(self.v)
        cz = sum(p[2] for p in self.v) / len(self.v)
        acc = [[0.0, 0.0, 0.0] for _ in self.v]
        new_idx: list[int] = []
        for ia, ib, ic in zip(self.i[0::3], self.i[1::3], self.i[2::3]):
            a, b, c = self.v[ia], self.v[ib], self.v[ic]
            e1 = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
            e2 = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
            nx = e1[1] * e2[2] - e1[2] * e2[1]
            ny = e1[2] * e2[0] - e1[0] * e2[2]
            nz = e1[0] * e2[1] - e1[1] * e2[0]
            flip = False
            if prefer == "keep":
                flip = False
            elif prefer == "+z":
                flip = nz < 0
            else:
                mx = (a[0] + b[0] + c[0]) / 3 - cx
                my = (a[1] + b[1] + c[1]) / 3 - cy
                mz = (a[2] + b[2] + c[2]) / 3 - cz
                flip = nx * mx + ny * my + nz * mz < -1e-8
            if flip:
                ia, ic = ic, ia
                nx, ny, nz = -nx, -ny, -nz
            new_idx.extend([ia, ib, ic])
            for i in (ia, ib, ic):
                acc[i][0] += nx
                acc[i][1] += ny
                acc[i][2] += nz
        self.i = new_idx
        self.n = []
        for vx, vy, vz in acc:
            L = math.sqrt(vx * vx + vy * vy + vz * vz) or 1.0
            self.n.append([vx / L, vy / L, vz / L])
        return self


def box(sx=1.0, sy=1.0, sz=1.0, color=P("bone"), center=(0, 0, 0)) -> Mesh:
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    cx, cy, cz = center
    p = [
        (cx - hx, cy - hy, cz - hz),
        (cx + hx, cy - hy, cz - hz),
        (cx + hx, cy + hy, cz - hz),
        (cx - hx, cy + hy, cz - hz),
        (cx - hx, cy - hy, cz + hz),
        (cx + hx, cy - hy, cz + hz),
        (cx + hx, cy + hy, cz + hz),
        (cx - hx, cy + hy, cz + hz),
    ]
    m = Mesh()
    # CCW from outside
    m.add_quad(p[4], p[5], p[6], p[7], color)  # +Z
    m.add_quad(p[1], p[0], p[3], p[2], color)  # -Z
    m.add_quad(p[5], p[1], p[2], p[6], color)  # +X
    m.add_quad(p[0], p[4], p[7], p[3], color)  # -X
    m.add_quad(p[3], p[7], p[6], p[2], color)  # +Y
    m.add_quad(p[0], p[1], p[5], p[4], color)  # -Y
    return m


def plane(sx=1.0, sy=1.0, color=P("white"), z=0.0) -> Mesh:
    hx, hy = sx / 2, sy / 2
    m = Mesh()
    m.add_quad((-hx, -hy, z), (hx, -hy, z), (hx, hy, z), (-hx, hy, z), color)
    return m


def disc(r=0.5, segs=16, color=P("white"), z=0.0) -> Mesh:
    m = Mesh()
    c = (0.0, 0.0, z)
    for i in range(segs):
        a0 = 2 * math.pi * i / segs
        a1 = 2 * math.pi * (i + 1) / segs
        m.add_tri(c, (r * math.cos(a0), r * math.sin(a0), z), (r * math.cos(a1), r * math.sin(a1), z), color)
    return m


def lathe(profile, segs=16, color=P("silver")) -> Mesh:
    """profile: list of (radius, y)."""
    m = Mesh()
    rings = []
    for i in range(segs):
        th = 2 * math.pi * i / segs
        ct, st = math.cos(th), math.sin(th)
        rings.append([(r * ct, y, r * st) for r, y in profile])
    for i in range(segs):
        i2 = (i + 1) % segs
        for j in range(len(profile) - 1):
            a, b = rings[i][j], rings[i2][j]
            c, d = rings[i2][j + 1], rings[i][j + 1]
            if profile[j][0] < 1e-8 and profile[j + 1][0] < 1e-8:
                continue
            m.add_quad(a, b, c, d, color)
    return m


def sphere(r=0.5, segs=10, stacks=6, color=P("bone")) -> Mesh:
    prof = []
    for i in range(stacks + 1):
        t = i / stacks
        a = math.pi * (0.5 - t)
        prof.append((max(1e-4, r * math.cos(a)), r * math.sin(a)))
    return lathe(prof, segs, color)


def cylinder(r=0.35, h=1.0, segs=12, color=P("silver"), caps=True) -> Mesh:
    y0, y1 = -h / 2, h / 2
    prof = [(r, y0), (r, y1)]
    if caps:
        prof = [(0.0, y0), (r, y0), (r, y1), (0.0, y1)]
    return lathe(prof, segs, color)


def cone(r=0.4, h=1.0, segs=12, color=P("silver")) -> Mesh:
    return lathe([(r, -h / 2), (0.0, h / 2)], segs, color)


def tetra(s=0.7, color=P("amber")) -> Mesh:
    t = s * 0.5
    a, b, c, d = (t, t, t), (t, -t, -t), (-t, t, -t), (-t, -t, t)
    m = Mesh()
    m.add_tri(a, c, b, color)
    m.add_tri(a, b, d, color)
    m.add_tri(a, d, c, color)
    m.add_tri(b, c, d, color)
    return m


def pyramid(s=0.9, h=0.8, color=P("orange")) -> Mesh:
    hs = s / 2
    apex = (0.0, h / 2, 0.0)
    p = [(-hs, -h / 2, -hs), (hs, -h / 2, -hs), (hs, -h / 2, hs), (-hs, -h / 2, hs)]
    m = Mesh()
    m.add_quad(p[0], p[1], p[2], p[3], color)
    m.add_tri(p[0], p[1], apex, color)
    m.add_tri(p[1], p[2], apex, color)
    m.add_tri(p[2], p[3], apex, color)
    m.add_tri(p[3], p[0], apex, color)
    return m


def torus(R=0.38, r=0.14, seg=14, tube=8, color=P("purple")) -> Mesh:
    m = Mesh()
    pts = []
    for i in range(seg):
        u = 2 * math.pi * i / seg
        ring = []
        for j in range(tube):
            v = 2 * math.pi * j / tube
            x = (R + r * math.cos(v)) * math.cos(u)
            y = r * math.sin(v)
            z = (R + r * math.cos(v)) * math.sin(u)
            ring.append((x, y, z))
        pts.append(ring)
    for i in range(seg):
        i2 = (i + 1) % seg
        for j in range(tube):
            j2 = (j + 1) % tube
            m.add_quad(pts[i][j], pts[i2][j], pts[i2][j2], pts[i][j2], color)
    return m


def octa(s=0.55, color=P("aqua")) -> Mesh:
    p = [(s, 0, 0), (-s, 0, 0), (0, s, 0), (0, -s, 0), (0, 0, s), (0, 0, -s)]
    faces = [(0, 2, 4), (2, 1, 4), (1, 3, 4), (3, 0, 4), (2, 0, 5), (1, 2, 5), (3, 1, 5), (0, 3, 5)]
    m = Mesh()
    for a, b, c in faces:
        m.add_tri(p[a], p[b], p[c], color)
    return m


def hex_prism(r=0.45, h=0.7, color=P("grass")) -> Mesh:
    prof = [(0.0, -h / 2), (r, -h / 2), (r, h / 2), (0.0, h / 2)]
    return lathe(prof, 6, color)


def capsule(r=0.22, h=0.7, color=P("salmon")) -> Mesh:
    prof = []
    for i in range(5):
        a = -math.pi / 2 + (math.pi / 2) * i / 4
        prof.append((max(1e-4, r * math.cos(a)), -h / 2 + r * math.sin(a)))
    for i in range(5):
        a = 0 + (math.pi / 2) * i / 4
        prof.append((max(1e-4, r * math.cos(a)), h / 2 + r * math.sin(a)))
    return lathe(prof, 10, color)


def wedge(color=P("khaki")) -> Mesh:
    m = Mesh()
    a, b, c = (-0.5, -0.35, 0.35), (0.5, -0.35, 0.35), (0.5, 0.35, 0.35)
    d, e, f = (-0.5, -0.35, -0.35), (0.5, -0.35, -0.35), (0.5, 0.35, -0.35)
    m.add_tri(a, b, c, color)
    m.add_tri(d, f, e, color)
    m.add_quad(a, d, e, b, color)
    m.add_quad(b, e, f, c, color)
    m.add_quad(a, c, f, d, color)
    return m


def star_flat(color=P("gold"), z=0.04) -> Mesh:
    m = Mesh()
    pts = []
    for i in range(10):
        a = -math.pi / 2 + i * math.pi / 5
        rad = 0.52 if i % 2 == 0 else 0.22
        pts.append((rad * math.cos(a), rad * math.sin(a), z))
    c = (0.0, 0.0, z)
    for i in range(10):
        m.add_tri(c, pts[i], pts[(i + 1) % 10], color)
    return m


def heart_flat(color=P("red"), z=0.04) -> Mesh:
    m = Mesh()
    # two discs + a diamond
    left = disc(0.22, 12, color, z).translated((-0.16, 0.16, 0))
    right = disc(0.22, 12, color, z).translated((0.16, 0.16, 0))
    tip = Mesh()
    tip.add_tri((-0.36, 0.12, z), (0.36, 0.12, z), (0.0, -0.42, z), color)
    return left.merge(right).merge(tip)


def plus_flat(color=P("grass"), z=0.05) -> Mesh:
    m = Mesh()
    m.merge(plane(0.18, 0.7, color, z))
    m.merge(plane(0.7, 0.18, color, z))
    return m


def minus_flat(color=P("red"), z=0.05) -> Mesh:
    return plane(0.7, 0.16, color, z)


def check_flat(color=P("grass"), z=0.05) -> Mesh:
    m = Mesh()
    # two thick segments
    def bar(x0, y0, x1, y1, w=0.1):
        dx, dy = x1 - x0, y1 - y0
        L = math.hypot(dx, dy) or 1
        px, py = -dy / L * w, dx / L * w
        m.add_quad((x0 - px, y0 - py, z), (x1 - px, y1 - py, z), (x1 + px, y1 + py, z), (x0 + px, y0 + py, z), color)
    bar(-0.32, 0.02, -0.08, -0.28)
    bar(-0.08, -0.28, 0.36, 0.28)
    return m


def x_flat(color=P("red"), z=0.05) -> Mesh:
    m = Mesh()
    def bar(ang):
        c, s = math.cos(ang), math.sin(ang)
        hx, hy = 0.42, 0.08
        pts = [(-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)]
        rot = [(c * x - s * y, s * x + c * y, z) for x, y in pts]
        m.add_quad(*rot, color)
    bar(math.pi / 4)
    bar(-math.pi / 4)
    return m


def bang_flat(color=P("gold"), z=0.05) -> Mesh:
    m = plane(0.14, 0.48, color, z).translated((0, 0.12, 0))
    m.merge(disc(0.09, 10, color, z).translated((0, -0.34, 0)))
    return m


def question_flat(color=P("sky"), z=0.05) -> Mesh:
    m = Mesh()
    # hook as a few boxes + dot
    m.merge(disc(0.09, 10, color, z).translated((0, -0.36, 0)))
    m.merge(plane(0.12, 0.18, color, z).translated((0, -0.08, 0)))
    m.merge(plane(0.34, 0.12, color, z).translated((0.04, 0.28, 0)))
    m.merge(plane(0.12, 0.22, color, z).translated((0.16, 0.18, 0)))
    m.merge(plane(0.12, 0.18, color, z).translated((-0.12, 0.28, 0)))
    return m


def arrow_flat(color=P("yellow"), z=0.05) -> Mesh:
    m = plane(0.18, 0.45, color, z).translated((0, -0.08, 0))
    tip = Mesh()
    tip.add_tri((-0.32, 0.08, z), (0.32, 0.08, z), (0.0, 0.46, z), color)
    return m.merge(tip)


def thumb_flat(up=True, color=P("amber"), z=0.05) -> Mesh:
    m = box(0.38, 0.32, 0.08, color, (0.04, -0.06, z))
    m.merge(box(0.12, 0.34, 0.08, color, (-0.18 if up else -0.18, 0.14 if up else -0.26, z)))
    return m


def fire_flat(color=P("orange"), z=0.05) -> Mesh:
    m = Mesh()
    m.add_tri((-0.28, -0.35, z), (0.28, -0.35, z), (0.0, 0.42, z), color)
    m.add_tri((-0.12, -0.35, z), (0.22, -0.1, z), (0.18, 0.18, z), P("amber"))
    return m


def spark_flat(color=P("yellow"), z=0.05) -> Mesh:
    m = plus_flat(color, z).scaled(0.7)
    m.merge(plus_flat(color, z).rotated("z", 45).scaled(0.45))
    return m


def slab_disc(r=0.5, segs=16, color=P("white"), thick=0.08) -> Mesh:
    """A coin-thick disc so 2D icons have a front AND a back."""
    return lathe([(0.0, -thick / 2), (r, -thick / 2), (r, thick / 2), (0.0, thick / 2)], segs, color)


# ---------------------------------------------------------------------------
# Low-poly balls (the faces) — subdivided icosahedra, flat shaded
# ---------------------------------------------------------------------------

_ICO_T = (1.0 + math.sqrt(5.0)) / 2.0
_ICO_V = [
    (-1, _ICO_T, 0), (1, _ICO_T, 0), (-1, -_ICO_T, 0), (1, -_ICO_T, 0),
    (0, -1, _ICO_T), (0, 1, _ICO_T), (0, -1, -_ICO_T), (0, 1, -_ICO_T),
    (_ICO_T, 0, -1), (_ICO_T, 0, 1), (-_ICO_T, 0, -1), (-_ICO_T, 0, 1),
]
_ICO_F = [
    (0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11),
    (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6), (7, 1, 8),
    (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9),
    (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1),
]


def _norm(p, r):
    L = math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) or 1.0
    return (p[0] / L * r, p[1] / L * r, p[2] / L * r)


def ball(r=0.5, subdiv=1, color=P("skin"), belly=None) -> Mesh:
    """A faceted low-poly sphere.

    subdiv 0 = 20 faces (a gem), 1 = 80 (the face balls), 2 = 320.
    `belly` paints the lower hemisphere in a second palette colour so a flat
    ball still reads as round in the poster's flat light.
    """
    tris = [tuple(_norm(v, r) for v in (_ICO_V[a], _ICO_V[b], _ICO_V[c])) for a, b, c in _ICO_F]
    for _ in range(subdiv):
        out = []
        for a, b, c in tris:
            ab = _norm(((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), r)
            bc = _norm(((b[0] + c[0]) / 2, (b[1] + c[1]) / 2, (b[2] + c[2]) / 2), r)
            ca = _norm(((c[0] + a[0]) / 2, (c[1] + a[1]) / 2, (c[2] + a[2]) / 2), r)
            out += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
        tris = out
    m = Mesh()
    for a, b, c in tris:
        col = color
        if belly is not None and (a[1] + b[1] + c[1]) / 3 < -0.42 * r:
            col = belly
        m.add_tri(a, b, c, col)
    return m


def on_ball(feature: Mesh, u_deg: float, v_deg: float, r: float) -> Mesh:
    """Move a +Z-facing feature onto the surface of a ball of radius `r`.

    u = azimuth (right positive), v = elevation (up positive), both degrees.
    """
    return feature.translated((0, 0, r)).rotated("x", -v_deg).rotated("y", u_deg)


FACE_R = 0.5
_SKIN_OUT = 0.012   # stickers float just clear of the facets (no z-fighting)
_EYE_U, _EYE_V = 20.0, 12.0


def sticker(shape: Mesh, u_deg: float, v_deg: float, lift: float = 0.0) -> Mesh:
    """Lay a flat +Z shape flush onto the face ball at (u, v).

    A feature spans at most ~0.2 units, where the ball's sagitta is 0.006 —
    a flat patch lifted 0.012 clears the facets everywhere it covers, so the
    features read as painted-on marks instead of half-buried lumps.
    """
    return on_ball(shape, u_deg, v_deg, FACE_R + _SKIN_OUT + lift)


def _mouth_arc(n: int, spread: float, base: float, curve: float,
               bead=0.048, color=P("ink")) -> Mesh:
    """Overlapping round beads along an arc: `curve` > 0 lifts the corners."""
    m = Mesh()
    for k in range(n):
        t = -1.0 + 2.0 * k / (n - 1)
        m.merge(sticker(disc(bead, 8, color), spread * t, base + curve * t * t))
    return m


def _eye(color=P("ink"), r=0.082) -> Mesh:
    """A round eye with a small catchlight — the thing that makes it alive."""
    m = disc(r, 10, color)
    m.merge(disc(r * 0.32, 6, P("white"), 0.004).translated((-r * 0.3, r * 0.32, 0)))
    return m


def face(mouth="smile", extra=None) -> Mesh:
    """A low-poly ball wearing painted-on features — the emotion set.

    Replaces the old flat smiley plates (2026-08-21). The head is a
    once-subdivided icosahedron (80 facets, flat shaded) with a darker belly
    swatch; every feature is a flat palette-coloured patch laid onto the
    surface with `sticker()`.
    """
    ink = P("ink")
    skin, belly = P("skin"), P("tanned")
    if extra == "angry":
        skin, belly = P("tanned"), P("orange")
    if extra == "dead":
        skin, belly = P("silver"), P("grey")
    m = ball(FACE_R, 1, skin, belly)

    # ---- eyes ------------------------------------------------------------
    if extra not in ("wink", "dead", "love", "cool"):
        for side in (-1, 1):
            m.merge(sticker(_eye(ink), side * _EYE_U, _EYE_V))
    if extra == "wink":
        m.merge(sticker(_eye(ink), -_EYE_U, _EYE_V))
        m.merge(sticker(plane(0.17, 0.045, ink), _EYE_U, _EYE_V))
    if extra == "dead":
        for side in (-1, 1):
            cross = Mesh()
            cross.merge(plane(0.17, 0.045, ink).rotated("z", 45))
            cross.merge(plane(0.17, 0.045, ink).rotated("z", -45))
            m.merge(sticker(cross, side * _EYE_U, _EYE_V))
    if extra == "love":
        for side in (-1, 1):
            m.merge(sticker(heart_flat(P("red"), 0.0).scaled(0.3), side * _EYE_U, _EYE_V))
    if extra == "cool":
        for side in (-1, 1):
            lens = Mesh()
            lens.merge(disc(0.105, 10, P("charcoal")).scaled((1.3, 0.9, 1)))
            lens.merge(plane(0.1, 0.024, P("glass"), 0.004).rotated("z", 16).translated((-0.02, 0.025, 0)))
            m.merge(sticker(lens, side * 20.0, 11.0))
        m.merge(sticker(plane(0.13, 0.03, P("charcoal")), 0.0, 12.0))
    if extra == "angry":
        for side in (-1, 1):
            m.merge(sticker(plane(0.2, 0.05, ink).rotated("z", side * 22.0), side * _EYE_U, 27.0))

    # ---- mouths ----------------------------------------------------------
    if mouth == "smile":
        m.merge(_mouth_arc(11, 29.0, -25.0, 11.0, bead=0.052))
    elif mouth == "sad":
        m.merge(_mouth_arc(11, 27.0, -21.0, -10.0, bead=0.052))
    elif mouth == "meh":
        m.merge(_mouth_arc(9, 24.0, -21.0, 0.0, bead=0.044))
    elif mouth == "wow":
        m.merge(sticker(disc(0.1, 12, ink).scaled((0.85, 1.15, 1)), 0.0, -19.0))
    elif mouth == "grin":
        m.merge(sticker(disc(0.13, 12, ink).scaled((1.7, 0.85, 1)), 0.0, -20.0))
        m.merge(sticker(plane(0.2, 0.032, P("white")), 0.0, -16.5, lift=0.008))
        m.merge(sticker(disc(0.05, 8, P("blush")).scaled((1.6, 0.7, 1)), 0.0, -24.5, lift=0.008))
    return m


# ---------------------------------------------------------------------------
# Voxel art — greedy-meshed cubes, one palette slot per cell
# ---------------------------------------------------------------------------

def voxels(cells: dict[tuple[int, int, int], str], fit: float = 0.95) -> Mesh:
    """Build a voxel model from {(x, y, z): palette-name}.

    Only faces on the boundary are emitted, and coplanar same-colour faces are
    merged greedily into the largest rectangles that fit — a 8x8x8 block costs
    a handful of quads instead of 384. Winding is exact (CCW seen from
    outside), so these meshes finish with prefer="keep".
    """
    m = Mesh()
    for axis in range(3):
        u, v = (axis + 1) % 3, (axis + 2) % 3  # (u, v, axis) is right-handed
        for sign in (1, -1):
            planes: dict[int, dict[tuple[int, int], str]] = {}
            for pos, name in cells.items():
                nb = list(pos)
                nb[axis] += sign
                if tuple(nb) in cells:
                    continue
                planes.setdefault(pos[axis], {})[(pos[u], pos[v])] = name
            for slice_i, mask in planes.items():
                todo = dict(mask)
                while todo:
                    a0, b0 = min(todo)
                    name = todo[(a0, b0)]
                    w = 1
                    while todo.get((a0 + w, b0)) == name:
                        w += 1
                    h = 1
                    while all(todo.get((a0 + i, b0 + h)) == name for i in range(w)):
                        h += 1
                    for i in range(w):
                        for j in range(h):
                            del todo[(a0 + i, b0 + j)]
                    plane_at = slice_i + (1 if sign > 0 else 0)

                    def corner(a, b):
                        p = [0.0, 0.0, 0.0]
                        p[axis] = float(plane_at)
                        p[u] = float(a)
                        p[v] = float(b)
                        return tuple(p)

                    quad = [corner(a0, b0), corner(a0 + w, b0), corner(a0 + w, b0 + h), corner(a0, b0 + h)]
                    if sign < 0:
                        quad.reverse()
                    m.add_quad(*quad, P(name))
    # centre on the origin and scale the longest side to `fit`
    xs = [p[0] for p in m.v]
    ys = [p[1] for p in m.v]
    zs = [p[2] for p in m.v]
    cx, cy, cz = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, (min(zs) + max(zs)) / 2
    span = max(max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs)) or 1.0
    k = fit / span
    return m.translated((-cx, -cy, -cz)).scaled(k)


def sprite(rows: list[str], colors: dict[str, str], depth: int = 2) -> dict[tuple[int, int, int], str]:
    """ASCII pixel art -> voxel cells, extruded `depth` deep along +Z."""
    width = len(rows[0])
    cells: dict[tuple[int, int, int], str] = {}
    for y, row in enumerate(rows):
        if len(row) != width:
            raise ValueError(f"sprite row {y} is {len(row)} wide, expected {width}: {row!r}")
        for x, ch in enumerate(row):
            if ch == ".":
                continue
            if ch not in colors:
                raise KeyError(f"sprite char {ch!r} has no colour")
            for z in range(depth):
                cells[(x, len(rows) - 1 - y, z)] = colors[ch]
    return cells


INVADER = [
    "..#.....#..",
    "...#...#...",
    "..#######..",
    ".##i###i##.",
    "###########",
    "#.#######.#",
    "#.#.....#.#",
    "...##.##...",
]

GHOST = [
    "....####....",
    "..########..",
    ".##########.",
    "############",
    "#oooo##oooo#",
    "#oiio##oiio#",
    "#oiio##oiio#",
    "#oooo##oooo#",
    "############",
    "############",
    "############",
    "###.####.###",
]

# The snake reads as the ARCADE snake: 2x2 segments on a 3-cell pitch, so the
# grid gaps show the chain, with an apple waiting in the corner.
SNAKE = [
    "ss.ss.ss.ehe",
    "ss.ss.ss.hhh",
    "............",
    "ss..........",
    "ss..........",
    "............",
    "ss.ss.ss....",
    "ss.ss.ss....",
    "............",
    ".........l..",
    "........aa..",
    "........aa..",
]

SWORD = [
    ".....b......",
    ".....bb.....",
    "....bbb.....",
    "....bbb.....",
    "....bbb.....",
    "....bbb.....",
    "....bbb.....",
    "..gggggggg..",
    ".....hh.....",
    ".....hh.....",
    ".....hh.....",
    "....pppp....",
]

PIXHEART = [
    "..##..##..",
    ".########.",
    "##oo######",
    "##oo######",
    "##########",
    ".########.",
    "..######..",
    "...####...",
    "....##....",
]

CREEP_FACE = [
    "........",
    ".##..##.",
    ".##..##.",
    "...##...",
    "..####..",
    "..####..",
    "..#..#..",
    "........",
]


def _mottle(x: int, y: int, z: int, a: str, b: str) -> str:
    """Deterministic 2x2 patchwork so the greedy mesher still merges well."""
    return b if ((x // 2) * 7 + (y // 2) * 13 + (z // 2) * 5) % 3 == 0 else a


def creep(n: int = 8) -> Mesh:
    """A creeper-style head: a mottled green cube with the face on +Z."""
    cells: dict[tuple[int, int, int], str] = {}
    for x in range(n):
        for y in range(n):
            for z in range(n):
                if not (x in (0, n - 1) or y in (0, n - 1) or z in (0, n - 1)):
                    continue  # hollow: only the shell is ever visible
                cells[(x, y, z)] = _mottle(x, y, z, "slime", "leaf")
    for row, line in enumerate(CREEP_FACE):
        for col, ch in enumerate(line):
            if ch == "#":
                cells[(col, n - 1 - row, n - 1)] = "shadow"
    return voxels(cells)


def grass_block(n: int = 8) -> Mesh:
    """A minecraft-style grass block: grass cap, dirt body, ragged fringe."""
    cells: dict[tuple[int, int, int], str] = {}
    for x in range(n):
        for y in range(n):
            for z in range(n):
                if not (x in (0, n - 1) or y in (0, n - 1) or z in (0, n - 1)):
                    continue
                if y == n - 1:
                    name = _mottle(x, 0, z, "grass", "leaf")
                elif y >= n - 3 and (x + z * 3 + y) % 3 != 0:
                    name = _mottle(x, y, z, "leaf", "forest")  # fringe hanging down the sides
                else:
                    name = _mottle(x, y, z, "dirt", "brown")
                cells[(x, y, z)] = name
    return voxels(cells)


def house() -> Mesh:
    wall, roof, door = P("sand"), P("rust"), P("brown")
    m = box(0.8, 0.55, 0.7, wall, (0, -0.05, 0))
    m.merge(pyramid(1.05, 0.42, roof).translated((0, 0.42, 0)))
    m.merge(box(0.18, 0.28, 0.06, door, (0, -0.18, 0.36)))
    m.merge(box(0.14, 0.14, 0.04, P("sky"), (-0.22, 0.02, 0.36)))
    return m


def tree() -> Mesh:
    m = cylinder(0.08, 0.35, 8, P("brown"))
    m.merge(cone(0.32, 0.45, 8, P("leaf")).translated((0, 0.28, 0)))
    m.merge(cone(0.26, 0.38, 8, P("grass")).translated((0, 0.48, 0)))
    return m


def person() -> Mesh:
    skin, cloth = P("flesh"), P("blue")
    m = ball(0.17, 1, skin).translated((0, 0.42, 0))
    m.merge(box(0.32, 0.36, 0.18, cloth, (0, 0.08, 0)))
    m.merge(box(0.1, 0.28, 0.1, P("charcoal"), (-0.08, -0.28, 0)))
    m.merge(box(0.1, 0.28, 0.1, P("charcoal"), (0.08, -0.28, 0)))
    m.merge(box(0.08, 0.28, 0.08, cloth, (-0.22, 0.08, 0)))
    m.merge(box(0.08, 0.28, 0.08, cloth, (0.22, 0.08, 0)))
    return m


def crate() -> Mesh:
    wood, strap = P("wood"), P("brown")
    m = box(0.7, 0.7, 0.7, wood)
    m.merge(box(0.74, 0.08, 0.74, strap, (0, 0.2, 0)))
    m.merge(box(0.74, 0.08, 0.74, strap, (0, -0.2, 0)))
    return m


def coin() -> Mesh:
    return cylinder(0.38, 0.08, 16, P("gold"))


def key() -> Mesh:
    gold = P("gold")
    m = torus(0.16, 0.05, 10, 6, gold).translated((-0.22, 0, 0))
    m.merge(box(0.42, 0.08, 0.08, gold, (0.12, 0, 0)))
    m.merge(box(0.08, 0.16, 0.08, gold, (0.26, -0.08, 0)))
    m.merge(box(0.08, 0.12, 0.08, gold, (0.16, -0.06, 0)))
    return m


def sun() -> Mesh:
    m = disc(0.22, 12, P("gold"), 0.04)
    for i in range(8):
        a = i * math.pi / 4
        ray = plane(0.08, 0.22, P("amber"), 0.04).translated((0, 0.38, 0)).rotated("z", math.degrees(a))
        m.merge(ray)
    return m


def moon() -> Mesh:
    m = disc(0.4, 16, P("cream"), 0.04)
    # bite
    bite = disc(0.32, 14, P("shadow"), 0.05).translated((0.16, 0.08, 0))
    # just overlay a dark disc — reads as a crescent on the plate
    return m.merge(bite)


def speech() -> Mesh:
    m = box(0.7, 0.45, 0.1, P("white"), (0, 0.06, 0))
    tip = Mesh()
    tip.add_tri((-0.08, -0.16, 0.05), (0.12, -0.16, 0.05), (-0.18, -0.4, 0.05), P("white"))
    return m.merge(tip)


def lock(open_=False) -> Mesh:
    body = P("khaki")
    m = box(0.42, 0.32, 0.22, body, (0, -0.12, 0))
    shackle = torus(0.16, 0.045, 10, 6, P("silver")).translated((0.08 if open_ else 0, 0.12, 0))
    return m.merge(shackle)


def pin() -> Mesh:
    m = ball(0.17, 1, P("red"), P("crimson")).translated((0, 0.18, 0))
    m.merge(cone(0.1, 0.42, 8, P("silver")).rotated("x", 180).translated((0, -0.12, 0)))
    return m


def flag() -> Mesh:
    m = cylinder(0.035, 0.8, 8, P("wood"))
    m.merge(box(0.42, 0.26, 0.04, P("red"), (0.24, 0.22, 0)))
    return m


def eye() -> Mesh:
    m = disc(0.38, 14, P("white"), 0.03).scaled((1.25, 0.7, 1))
    m.merge(disc(0.16, 10, P("iris"), 0.04))
    m.merge(disc(0.07, 8, P("black"), 0.05))
    return m


def bell() -> Mesh:
    m = lathe([(0.05, -0.25), (0.28, -0.2), (0.22, 0.15), (0.08, 0.28), (0.0, 0.32)], 10, P("gold"))
    m.merge(ball(0.07, 0, P("amber")).translated((0, -0.28, 0)))
    return m


def arrow3d() -> Mesh:
    m = cylinder(0.1, 0.55, 8, P("gold"))
    m.merge(cone(0.22, 0.35, 8, P("amber")).translated((0, 0.4, 0)))
    return m


# ---------------------------------------------------------------------------
# GLB writer
# ---------------------------------------------------------------------------

def winding_ok(mesh: Mesh, prefer: str = "outward") -> bool:
    mesh = Mesh(v=[p[:] for p in mesh.v], n=[n[:] for n in mesh.n], c=[c[:] for c in mesh.c], i=list(mesh.i)).finish(prefer)
    if not mesh.v:
        return False
    if prefer == "+z":
        return sum(n[2] for n in mesh.n) > 0
    if prefer == "keep":
        # Voxel meshes are closed manifolds, so the divergence theorem is an
        # exact outward test: the signed volume of a correctly wound closed
        # mesh is positive. Faces must also stay axis-aligned.
        vol = 0.0
        for ia, ib, ic in zip(mesh.i[0::3], mesh.i[1::3], mesh.i[2::3]):
            a, b, c = mesh.v[ia], mesh.v[ib], mesh.v[ic]
            vol += (a[0] * (b[1] * c[2] - b[2] * c[1])
                    - a[1] * (b[0] * c[2] - b[2] * c[0])
                    + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
        axis_aligned = all(sum(1 for k in n if abs(abs(k) - 1) < 1e-6) == 1 for n in mesh.n)
        return vol > 1e-9 and axis_aligned
    cx = sum(p[0] for p in mesh.v) / len(mesh.v)
    cy = sum(p[1] for p in mesh.v) / len(mesh.v)
    cz = sum(p[2] for p in mesh.v) / len(mesh.v)
    bad = 0
    for ia, ib, ic in zip(mesh.i[0::3], mesh.i[1::3], mesh.i[2::3]):
        a, b, c = mesh.v[ia], mesh.v[ib], mesh.v[ic]
        e1 = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
        e2 = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
        nx = e1[1] * e2[2] - e1[2] * e2[1]
        ny = e1[2] * e2[0] - e1[0] * e2[2]
        nz = e1[0] * e2[1] - e1[1] * e2[0]
        mx = (a[0] + b[0] + c[0]) / 3 - cx
        my = (a[1] + b[1] + c[1]) / 3 - cy
        mz = (a[2] + b[2] + c[2]) / 3 - cz
        if nx * mx + ny * my + nz * mz < -1e-8:
            bad += 1
    return bad == 0


ITEMS: list[tuple[str, str, str, Mesh, bool, str]] = []


def add(group: str, dim: str, name: str, mesh: Mesh, front: bool = False,
        prefer: str | None = None) -> None:
    """Register a library piece.

    front=True  -> the studio turns the piece to the camera when it is placed
                   (plates, face balls and voxel sprites are authored facing +Z).
    prefer      -> normal policy for finish(): "+z" plates, "keep" voxels,
                   "outward" everything else.
    """
    if prefer is None:
        prefer = "+z" if dim == "2d" else "outward"
    ITEMS.append((group, dim, name, mesh, front, prefer))


def build_catalog() -> None:
    ITEMS.clear()
    # faces — low-poly BALLS (2026-08-21): a subdivided icosahedron with the
    # features beaded onto the surface. They replaced the flat smiley plates.
    add("face", "3d", "smile", face("smile"), front=True)
    add("face", "3d", "grin", face("grin"), front=True)
    add("face", "3d", "sad", face("sad"), front=True)
    add("face", "3d", "angry", face("sad", "angry"), front=True)
    add("face", "3d", "wow", face("wow"), front=True)
    add("face", "3d", "wink", face("smile", "wink"), front=True)
    add("face", "3d", "meh", face("meh"), front=True)
    add("face", "3d", "love", face("smile", "love"), front=True)
    add("face", "3d", "dead", face("meh", "dead"), front=True)
    add("face", "3d", "cool", face("meh", "cool"), front=True)

    # voxel art (2026-08-21): greedy-meshed cubes, palette colours per cell
    add("voxel", "3d", "invader", voxels(sprite(INVADER, {"#": "slime", "i": "ink"})),
        front=True, prefer="keep")
    add("voxel", "3d", "ghost", voxels(sprite(GHOST, {"#": "pink", "o": "white", "i": "iris"})),
        front=True, prefer="keep")
    add("voxel", "3d", "creep", creep(), front=True, prefer="keep")
    add("voxel", "3d", "grassblock", grass_block(), prefer="keep")
    add("voxel", "3d", "snake", voxels(sprite(SNAKE, {
        "s": "emerald", "h": "jade", "e": "white", "a": "apple", "l": "leaf"})),
        front=True, prefer="keep")
    add("voxel", "3d", "sword", voxels(sprite(SWORD, {
        "b": "silver", "g": "gold", "h": "brown", "p": "gold"})), front=True, prefer="keep")
    add("voxel", "3d", "pixheart", voxels(sprite(PIXHEART, {"#": "red", "o": "rose"})),
        front=True, prefer="keep")

    # reactions
    add("react", "2d", "heart", heart_flat(), front=True)
    add("react", "2d", "star", star_flat(), front=True)
    add("react", "2d", "plus", plus_flat(), front=True)
    add("react", "2d", "minus", minus_flat(), front=True)
    add("react", "2d", "check", check_flat(), front=True)
    add("react", "2d", "xmark", x_flat(), front=True)
    add("react", "2d", "question", question_flat(), front=True)
    add("react", "2d", "bang", bang_flat(), front=True)
    add("react", "2d", "thumbup", thumb_flat(True), front=True)
    add("react", "2d", "thumbdown", thumb_flat(False), front=True)
    add("react", "2d", "spark", spark_flat(), front=True)
    add("react", "2d", "fire", fire_flat(), front=True)
    add("react", "2d", "arrow", arrow_flat(), front=True)

    # status
    add("status", "3d", "ok", ball(0.44, 1, P("grass"), P("leaf")))
    add("status", "3d", "wait", ball(0.44, 1, P("gold"), P("amber")))
    add("status", "3d", "off", ball(0.44, 1, P("red"), P("crimson")))
    add("status", "3d", "lock", lock(False))
    add("status", "3d", "unlock", lock(True))
    add("status", "3d", "pin", pin())
    add("status", "3d", "flag", flag())
    add("status", "2d", "eye", eye(), front=True)
    add("status", "3d", "bell", bell())

    # primitives
    add("shape", "3d", "cube", box(0.85, 0.85, 0.85, P("silver")))
    add("shape", "3d", "sphere", ball(0.48, 2, P("ice")))
    add("shape", "3d", "cylinder", cylinder(0.35, 0.9, 12, P("ice")))
    add("shape", "3d", "cone", cone(0.4, 0.95, 12, P("amber")))
    add("shape", "3d", "tetra", tetra())
    add("shape", "3d", "pyramid", pyramid())
    add("shape", "3d", "torus", torus())
    add("shape", "3d", "capsule", capsule())
    add("shape", "3d", "hexprism", hex_prism())
    add("shape", "3d", "wedge", wedge())
    add("shape", "3d", "octa", octa())
    add("shape", "2d", "plane", plane(1.0, 1.0, P("silver"), 0.0), front=True)

    # objects
    add("object", "3d", "house", house())
    add("object", "3d", "tree", tree())
    add("object", "3d", "person", person())
    add("object", "3d", "crate", crate())
    add("object", "3d", "coin", coin())
    add("object", "3d", "key", key())
    add("object", "2d", "sun", sun(), front=True)
    add("object", "2d", "moon", moon(), front=True)
    add("object", "2d", "speech", speech(), front=True)
    add("object", "3d", "arrow3d", arrow3d())


def write_manifest(path: str) -> None:
    rows = [{"id": name, "group": g, "dim": d} | ({"front": True} if front else {})
            for g, d, name, _m, front, _p in ITEMS]
    extras = [
        {"id": "house", "group": "object", "dim": "2d", "front": True},
        {"id": "lock", "group": "status", "dim": "2d", "front": True},
    ]
    have = {(r["id"], r["dim"]) for r in rows}
    for extra in extras:
        if (extra["id"], extra["dim"]) not in have:
            rows.append(extra)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=2)
        f.write("\n")


def main() -> None:
    build_catalog()
    os.makedirs(OUT, exist_ok=True)
    # wipe stale
    for fn in os.listdir(OUT):
        if fn.endswith(".glb"):
            os.remove(os.path.join(OUT, fn))
    failed = []
    total = 0
    worst = 0.0
    used: set[int] = set()
    for group, dim, name, mesh, front, prefer in ITEMS:
        if not winding_ok(mesh, prefer):
            failed.append(name)
        dest = os.path.join(OUT, f"{name}.glb")
        report = write_glb(mesh, dest, name, double_sided=(dim == "2d"), prefer=prefer)
        total += report["bytes"]
        worst = max(worst, report["snap"])
        used.update(report["slots"])
        swatches = " ".join(palette.PALETTE[i][0] for i in report["slots"])
        print(f"  {group:6} {dim}  {name:12} {report['bytes']:6d} B  "
              f"{report['vertices']:5d} v  [{swatches}]")
    write_manifest(os.path.join(os.path.dirname(OUT), "manifest.json"))
    if failed:
        raise SystemExit("inward faces after finish(): " + ", ".join(failed))
    print(f"wrote {len(ITEMS)} glbs ({total / 1024:.0f} KiB) → {OUT}")
    print(f"palette: {len(used)}/{len(palette.PALETTE)} swatches used, "
          f"worst colour snap {worst:.3f}")
    if worst > 0.12:
        raise SystemExit(f"a colour literal is {worst:.3f} away from every palette slot — "
                         "author it as a palette name or add the swatch")


if __name__ == "__main__":
    main()
