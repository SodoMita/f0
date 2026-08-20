#!/usr/bin/env python3
"""Author the studio library: tiny self-contained GLBs with outward CCW faces.

glTF is right-handed Y-up. Every triangle is wound CCW when viewed from
outside; after emit we flip any face whose normal points toward the mesh
centroid so lighting cannot invert (the previous hand-built OBJs did).
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
from libglb import write_glb  # noqa: E402

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
        used to invert features.
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
            if prefer == "+z":
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


def box(sx=1.0, sy=1.0, sz=1.0, color=(0.85, 0.85, 0.85), center=(0, 0, 0)) -> Mesh:
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


def plane(sx=1.0, sy=1.0, color=(0.9, 0.9, 0.9), z=0.0) -> Mesh:
    hx, hy = sx / 2, sy / 2
    m = Mesh()
    m.add_quad((-hx, -hy, z), (hx, -hy, z), (hx, hy, z), (-hx, hy, z), color)
    return m


def disc(r=0.5, segs=16, color=(0.9, 0.9, 0.9), z=0.0) -> Mesh:
    m = Mesh()
    c = (0.0, 0.0, z)
    for i in range(segs):
        a0 = 2 * math.pi * i / segs
        a1 = 2 * math.pi * (i + 1) / segs
        m.add_tri(c, (r * math.cos(a0), r * math.sin(a0), z), (r * math.cos(a1), r * math.sin(a1), z), color)
    return m


def lathe(profile, segs=16, color=(0.8, 0.8, 0.8)) -> Mesh:
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


def sphere(r=0.5, segs=10, stacks=6, color=(0.85, 0.85, 0.85)) -> Mesh:
    prof = []
    for i in range(stacks + 1):
        t = i / stacks
        a = math.pi * (0.5 - t)
        prof.append((max(1e-4, r * math.cos(a)), r * math.sin(a)))
    return lathe(prof, segs, color)


def cylinder(r=0.35, h=1.0, segs=12, color=(0.8, 0.8, 0.8), caps=True) -> Mesh:
    y0, y1 = -h / 2, h / 2
    prof = [(r, y0), (r, y1)]
    if caps:
        prof = [(0.0, y0), (r, y0), (r, y1), (0.0, y1)]
    return lathe(prof, segs, color)


def cone(r=0.4, h=1.0, segs=12, color=(0.8, 0.8, 0.8)) -> Mesh:
    return lathe([(r, -h / 2), (0.0, h / 2)], segs, color)


def tetra(s=0.7, color=(0.85, 0.55, 0.25)) -> Mesh:
    t = s * 0.5
    a, b, c, d = (t, t, t), (t, -t, -t), (-t, t, -t), (-t, -t, t)
    m = Mesh()
    m.add_tri(a, c, b, color)
    m.add_tri(a, b, d, color)
    m.add_tri(a, d, c, color)
    m.add_tri(b, c, d, color)
    return m


def pyramid(s=0.9, h=0.8, color=(0.8, 0.45, 0.2)) -> Mesh:
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


def torus(R=0.38, r=0.14, seg=14, tube=8, color=(0.7, 0.35, 0.85)) -> Mesh:
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


def octa(s=0.55, color=(0.4, 0.75, 0.85)) -> Mesh:
    p = [(s, 0, 0), (-s, 0, 0), (0, s, 0), (0, -s, 0), (0, 0, s), (0, 0, -s)]
    faces = [(0, 2, 4), (2, 1, 4), (1, 3, 4), (3, 0, 4), (2, 0, 5), (1, 2, 5), (3, 1, 5), (0, 3, 5)]
    m = Mesh()
    for a, b, c in faces:
        m.add_tri(p[a], p[b], p[c], color)
    return m


def hex_prism(r=0.45, h=0.7, color=(0.45, 0.7, 0.45)) -> Mesh:
    prof = [(0.0, -h / 2), (r, -h / 2), (r, h / 2), (0.0, h / 2)]
    return lathe(prof, 6, color)


def capsule(r=0.22, h=0.7, color=(0.85, 0.55, 0.35)) -> Mesh:
    prof = []
    for i in range(5):
        a = -math.pi / 2 + (math.pi / 2) * i / 4
        prof.append((max(1e-4, r * math.cos(a)), -h / 2 + r * math.sin(a)))
    for i in range(5):
        a = 0 + (math.pi / 2) * i / 4
        prof.append((max(1e-4, r * math.cos(a)), h / 2 + r * math.sin(a)))
    return lathe(prof, 10, color)


def wedge(color=(0.75, 0.6, 0.3)) -> Mesh:
    m = Mesh()
    a, b, c = (-0.5, -0.35, 0.35), (0.5, -0.35, 0.35), (0.5, 0.35, 0.35)
    d, e, f = (-0.5, -0.35, -0.35), (0.5, -0.35, -0.35), (0.5, 0.35, -0.35)
    m.add_tri(a, b, c, color)
    m.add_tri(d, f, e, color)
    m.add_quad(a, d, e, b, color)
    m.add_quad(b, e, f, c, color)
    m.add_quad(a, c, f, d, color)
    return m


def star_flat(color=(0.95, 0.78, 0.18), z=0.04) -> Mesh:
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


def heart_flat(color=(0.9, 0.18, 0.28), z=0.04) -> Mesh:
    m = Mesh()
    # two discs + a diamond
    left = disc(0.22, 12, color, z).translated((-0.16, 0.16, 0))
    right = disc(0.22, 12, color, z).translated((0.16, 0.16, 0))
    tip = Mesh()
    tip.add_tri((-0.36, 0.12, z), (0.36, 0.12, z), (0.0, -0.42, z), color)
    return left.merge(right).merge(tip)


def plus_flat(color=(0.25, 0.78, 0.42), z=0.05) -> Mesh:
    m = Mesh()
    m.merge(plane(0.18, 0.7, color, z))
    m.merge(plane(0.7, 0.18, color, z))
    return m


def minus_flat(color=(0.85, 0.3, 0.28), z=0.05) -> Mesh:
    return plane(0.7, 0.16, color, z)


def check_flat(color=(0.25, 0.78, 0.42), z=0.05) -> Mesh:
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


def x_flat(color=(0.9, 0.25, 0.28), z=0.05) -> Mesh:
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


def bang_flat(color=(0.95, 0.78, 0.15), z=0.05) -> Mesh:
    m = plane(0.14, 0.48, color, z).translated((0, 0.12, 0))
    m.merge(disc(0.09, 10, color, z).translated((0, -0.34, 0)))
    return m


def question_flat(color=(0.45, 0.65, 0.95), z=0.05) -> Mesh:
    m = Mesh()
    # hook as a few boxes + dot
    m.merge(disc(0.09, 10, color, z).translated((0, -0.36, 0)))
    m.merge(plane(0.12, 0.18, color, z).translated((0, -0.08, 0)))
    m.merge(plane(0.34, 0.12, color, z).translated((0.04, 0.28, 0)))
    m.merge(plane(0.12, 0.22, color, z).translated((0.16, 0.18, 0)))
    m.merge(plane(0.12, 0.18, color, z).translated((-0.12, 0.28, 0)))
    return m


def arrow_flat(color=(0.95, 0.85, 0.25), z=0.05) -> Mesh:
    m = plane(0.18, 0.45, color, z).translated((0, -0.08, 0))
    tip = Mesh()
    tip.add_tri((-0.32, 0.08, z), (0.32, 0.08, z), (0.0, 0.46, z), color)
    return m.merge(tip)


def thumb_flat(up=True, color=(0.95, 0.78, 0.35), z=0.05) -> Mesh:
    m = box(0.38, 0.32, 0.08, color, (0.04, -0.06, z))
    m.merge(box(0.12, 0.34, 0.08, color, (-0.18 if up else -0.18, 0.14 if up else -0.26, z)))
    return m


def fire_flat(color=(0.95, 0.4, 0.12), z=0.05) -> Mesh:
    m = Mesh()
    m.add_tri((-0.28, -0.35, z), (0.28, -0.35, z), (0.0, 0.42, z), color)
    m.add_tri((-0.12, -0.35, z), (0.22, -0.1, z), (0.18, 0.18, z), (1.0, 0.7, 0.2))
    return m


def spark_flat(color=(0.95, 0.85, 0.3), z=0.05) -> Mesh:
    m = plus_flat(color, z).scaled(0.7)
    m.merge(plus_flat(color, z).rotated("z", 45).scaled(0.45))
    return m


def slab_disc(r=0.5, segs=16, color=(0.9, 0.9, 0.9), thick=0.08) -> Mesh:
    """A coin-thick disc so 2D icons have a front AND a back."""
    return lathe([(0.0, -thick / 2), (r, -thick / 2), (r, thick / 2), (0.0, thick / 2)], segs, color)


def face(mouth="smile", extra=None) -> Mesh:
    skin = (0.96, 0.82, 0.42)
    ink = (0.12, 0.08, 0.06)
    z = 0.05
    # lathe is Y-up (a coin on the floor); rotate so the face looks down +Z
    m = slab_disc(0.52, 18, skin, 0.08).rotated("x", 90)
    # default eyes (skipped when a variant draws its own)
    if extra not in ("wink", "dead", "love", "cool"):
        m.merge(disc(0.08, 10, ink, z).translated((-0.18, 0.12, 0)))
        m.merge(disc(0.08, 10, ink, z).translated((0.18, 0.12, 0)))
    if extra == "wink":
        m.merge(disc(0.08, 10, ink, z).translated((-0.18, 0.12, 0)))
        m.merge(plane(0.18, 0.05, ink, z).translated((0.18, 0.12, 0)))
    if extra == "dead":
        m.merge(x_flat(ink, z).scaled(0.28).translated((-0.18, 0.12, 0)))
        m.merge(x_flat(ink, z).scaled(0.28).translated((0.18, 0.12, 0)))
    if extra == "love":
        m.merge(heart_flat((0.9, 0.16, 0.24), z).scaled(0.28).translated((-0.18, 0.12, 0)))
        m.merge(heart_flat((0.9, 0.16, 0.24), z).scaled(0.28).translated((0.18, 0.12, 0)))
    if extra == "cool":
        m.merge(box(0.58, 0.14, 0.06, (0.08, 0.08, 0.1), (0, 0.12, 0.04)))
        m.merge(box(0.18, 0.16, 0.05, (0.12, 0.12, 0.16), (-0.18, 0.12, 0.06)))
        m.merge(box(0.18, 0.16, 0.05, (0.12, 0.12, 0.16), (0.18, 0.12, 0.06)))
    if extra == "angry":
        m.merge(plane(0.2, 0.05, ink, z).rotated("z", 24).translated((-0.18, 0.24, 0)))
        m.merge(plane(0.2, 0.05, ink, z).rotated("z", -24).translated((0.18, 0.24, 0)))
    if mouth == "smile":
        for k in range(6):
            t = math.pi * (0.15 + 0.7 * k / 5)
            m.merge(disc(0.055, 8, ink, z).translated((0.22 * math.cos(t), -0.08 - 0.16 * math.sin(t), 0)))
    elif mouth == "sad":
        for k in range(6):
            t = math.pi * (0.15 + 0.7 * k / 5)
            m.merge(disc(0.055, 8, ink, z).translated((0.2 * math.cos(t), -0.32 + 0.14 * math.sin(t), 0)))
    elif mouth == "wow":
        m.merge(disc(0.12, 10, ink, z).translated((0, -0.2, 0)))
    elif mouth == "meh":
        m.merge(plane(0.32, 0.06, ink, z).translated((0, -0.18, 0)))
    elif mouth == "grin":
        m.merge(box(0.42, 0.14, 0.05, ink, (0, -0.18, 0.04)))
        m.merge(box(0.34, 0.05, 0.04, (0.95, 0.95, 0.92), (0, -0.16, 0.06)))
    return m


def house() -> Mesh:
    wall = (0.86, 0.8, 0.7)
    roof = (0.72, 0.28, 0.2)
    door = (0.4, 0.25, 0.16)
    m = box(0.8, 0.55, 0.7, wall, (0, -0.05, 0))
    m.merge(pyramid(1.05, 0.42, roof).translated((0, 0.42, 0)))
    m.merge(box(0.18, 0.28, 0.06, door, (0, -0.18, 0.36)))
    m.merge(box(0.14, 0.14, 0.04, (0.55, 0.75, 0.85), (-0.22, 0.02, 0.36)))
    return m


def tree() -> Mesh:
    m = cylinder(0.08, 0.35, 8, (0.45, 0.28, 0.14))
    m.merge(cone(0.32, 0.45, 8, (0.22, 0.55, 0.28)).translated((0, 0.28, 0)))
    m.merge(cone(0.26, 0.38, 8, (0.28, 0.62, 0.3)).translated((0, 0.48, 0)))
    return m


def person() -> Mesh:
    skin = (0.92, 0.74, 0.52)
    cloth = (0.28, 0.45, 0.72)
    m = sphere(0.16, 8, 5, skin).translated((0, 0.42, 0))
    m.merge(box(0.32, 0.36, 0.18, cloth, (0, 0.08, 0)))
    m.merge(box(0.1, 0.28, 0.1, (0.22, 0.22, 0.25), (-0.08, -0.28, 0)))
    m.merge(box(0.1, 0.28, 0.1, (0.22, 0.22, 0.25), (0.08, -0.28, 0)))
    m.merge(box(0.08, 0.28, 0.08, cloth, (-0.22, 0.08, 0)))
    m.merge(box(0.08, 0.28, 0.08, cloth, (0.22, 0.08, 0)))
    return m


def crate() -> Mesh:
    wood = (0.62, 0.42, 0.22)
    m = box(0.7, 0.7, 0.7, wood)
    strap = (0.35, 0.22, 0.1)
    m.merge(box(0.74, 0.08, 0.74, strap, (0, 0.2, 0)))
    m.merge(box(0.74, 0.08, 0.74, strap, (0, -0.2, 0)))
    return m


def coin() -> Mesh:
    return cylinder(0.38, 0.08, 16, (0.92, 0.75, 0.22))


def key() -> Mesh:
    gold = (0.9, 0.74, 0.22)
    m = torus(0.16, 0.05, 10, 6, gold).translated((-0.22, 0, 0))
    m.merge(box(0.42, 0.08, 0.08, gold, (0.12, 0, 0)))
    m.merge(box(0.08, 0.16, 0.08, gold, (0.26, -0.08, 0)))
    m.merge(box(0.08, 0.12, 0.08, gold, (0.16, -0.06, 0)))
    return m


def sun() -> Mesh:
    m = disc(0.22, 12, (0.98, 0.82, 0.2), 0.04)
    for i in range(8):
        a = i * math.pi / 4
        ray = plane(0.08, 0.22, (0.98, 0.75, 0.15), 0.04).translated((0, 0.38, 0)).rotated("z", math.degrees(a))
        m.merge(ray)
    return m


def moon() -> Mesh:
    m = disc(0.4, 16, (0.9, 0.88, 0.7), 0.04)
    # bite
    bite = disc(0.32, 14, (0.12, 0.12, 0.14), 0.05).translated((0.16, 0.08, 0))
    # just overlay a dark disc — reads as a crescent on the plate
    return m.merge(bite)


def speech() -> Mesh:
    m = box(0.7, 0.45, 0.1, (0.92, 0.92, 0.95), (0, 0.06, 0))
    tip = Mesh()
    tip.add_tri((-0.08, -0.16, 0.05), (0.12, -0.16, 0.05), (-0.18, -0.4, 0.05), (0.92, 0.92, 0.95))
    return m.merge(tip)


def lock(open_=False) -> Mesh:
    body = (0.75, 0.62, 0.28)
    m = box(0.42, 0.32, 0.22, body, (0, -0.12, 0))
    shackle = torus(0.16, 0.045, 10, 6, (0.7, 0.7, 0.72)).translated((0.08 if open_ else 0, 0.12, 0))
    return m.merge(shackle)


def pin() -> Mesh:
    m = sphere(0.16, 8, 5, (0.85, 0.2, 0.22)).translated((0, 0.18, 0))
    m.merge(cone(0.1, 0.42, 8, (0.75, 0.75, 0.78)).rotated("x", 180).translated((0, -0.12, 0)))
    return m


def flag() -> Mesh:
    m = cylinder(0.035, 0.8, 8, (0.55, 0.4, 0.22))
    m.merge(box(0.42, 0.26, 0.04, (0.85, 0.2, 0.22), (0.24, 0.22, 0)))
    return m


def eye() -> Mesh:
    m = disc(0.38, 14, (0.95, 0.95, 0.95), 0.03).scaled((1.25, 0.7, 1))
    m.merge(disc(0.16, 10, (0.28, 0.5, 0.75), 0.04))
    m.merge(disc(0.07, 8, (0.08, 0.08, 0.1), 0.05))
    return m


def bell() -> Mesh:
    m = lathe([(0.05, -0.25), (0.28, -0.2), (0.22, 0.15), (0.08, 0.28), (0.0, 0.32)], 10, (0.9, 0.75, 0.22))
    m.merge(sphere(0.06, 6, 4, (0.9, 0.75, 0.22)).translated((0, -0.28, 0)))
    return m


def arrow3d() -> Mesh:
    m = cylinder(0.1, 0.55, 8, (0.95, 0.8, 0.2))
    m.merge(cone(0.22, 0.35, 8, (0.95, 0.75, 0.15)).translated((0, 0.4, 0)))
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


ITEMS: list[tuple[str, str, str, tuple[float, float, float], Mesh]] = []


def add(group: str, dim: str, name: str, color, mesh: Mesh) -> None:
    ITEMS.append((group, dim, name, color, mesh))


def build_catalog() -> None:
    ITEMS.clear()
    # faces (2d plates)
    add("face", "2d", "smile", (0.96, 0.82, 0.42), face("smile"))
    add("face", "2d", "grin", (0.96, 0.82, 0.42), face("grin"))
    add("face", "2d", "sad", (0.96, 0.82, 0.42), face("sad"))
    add("face", "2d", "angry", (0.96, 0.7, 0.35), face("smile", "angry"))
    add("face", "2d", "wow", (0.96, 0.82, 0.42), face("wow"))
    add("face", "2d", "wink", (0.96, 0.82, 0.42), face("smile", "wink"))
    add("face", "2d", "meh", (0.96, 0.82, 0.42), face("meh"))
    add("face", "2d", "love", (0.96, 0.82, 0.42), face("smile", "love"))
    add("face", "2d", "dead", (0.85, 0.85, 0.85), face("meh", "dead"))
    add("face", "2d", "cool", (0.96, 0.82, 0.42), face("meh", "cool"))

    # reactions
    add("react", "2d", "heart", (0.9, 0.18, 0.28), heart_flat())
    add("react", "2d", "star", (0.95, 0.78, 0.18), star_flat())
    add("react", "2d", "plus", (0.25, 0.78, 0.42), plus_flat())
    add("react", "2d", "minus", (0.85, 0.3, 0.28), minus_flat())
    add("react", "2d", "check", (0.25, 0.78, 0.42), check_flat())
    add("react", "2d", "xmark", (0.9, 0.25, 0.28), x_flat())
    add("react", "2d", "question", (0.45, 0.65, 0.95), question_flat())
    add("react", "2d", "bang", (0.95, 0.78, 0.15), bang_flat())
    add("react", "2d", "thumbup", (0.95, 0.78, 0.35), thumb_flat(True))
    add("react", "2d", "thumbdown", (0.95, 0.78, 0.35), thumb_flat(False))
    add("react", "2d", "spark", (0.95, 0.85, 0.3), spark_flat())
    add("react", "2d", "fire", (0.95, 0.4, 0.12), fire_flat())
    add("react", "2d", "arrow", (0.95, 0.85, 0.25), arrow_flat())

    # status
    add("status", "3d", "ok", (0.25, 0.78, 0.42), sphere(0.42, 10, 6, (0.25, 0.78, 0.42)))
    add("status", "3d", "wait", (0.95, 0.75, 0.2), sphere(0.42, 10, 6, (0.95, 0.75, 0.2)))
    add("status", "3d", "off", (0.85, 0.25, 0.22), sphere(0.42, 10, 6, (0.85, 0.25, 0.22)))
    add("status", "3d", "lock", (0.75, 0.62, 0.28), lock(False))
    add("status", "3d", "unlock", (0.75, 0.62, 0.28), lock(True))
    add("status", "3d", "pin", (0.85, 0.2, 0.22), pin())
    add("status", "3d", "flag", (0.85, 0.2, 0.22), flag())
    add("status", "2d", "eye", (0.95, 0.95, 0.95), eye())
    add("status", "3d", "bell", (0.9, 0.75, 0.22), bell())

    # primitives
    add("shape", "3d", "cube", (0.85, 0.85, 0.88), box(0.85, 0.85, 0.85, (0.85, 0.85, 0.88)))
    add("shape", "3d", "sphere", (0.75, 0.8, 0.9), sphere(0.48, 12, 7, (0.75, 0.8, 0.9)))
    add("shape", "3d", "cylinder", (0.7, 0.78, 0.85), cylinder(0.35, 0.9, 12, (0.7, 0.78, 0.85)))
    add("shape", "3d", "cone", (0.85, 0.6, 0.3), cone(0.4, 0.95, 12, (0.85, 0.6, 0.3)))
    add("shape", "3d", "tetra", (0.85, 0.55, 0.25), tetra())
    add("shape", "3d", "pyramid", (0.8, 0.45, 0.2), pyramid())
    add("shape", "3d", "torus", (0.7, 0.35, 0.85), torus())
    add("shape", "3d", "capsule", (0.85, 0.55, 0.35), capsule())
    add("shape", "3d", "hexprism", (0.45, 0.7, 0.45), hex_prism())
    add("shape", "3d", "wedge", (0.75, 0.6, 0.3), wedge())
    add("shape", "3d", "octa", (0.4, 0.75, 0.85), octa())
    add("shape", "2d", "plane", (0.82, 0.82, 0.86), plane(1.0, 1.0, (0.82, 0.82, 0.86), 0.0))

    # objects
    add("object", "3d", "house", (0.86, 0.8, 0.7), house())
    add("object", "3d", "tree", (0.22, 0.55, 0.28), tree())
    add("object", "3d", "person", (0.28, 0.45, 0.72), person())
    add("object", "3d", "crate", (0.62, 0.42, 0.22), crate())
    add("object", "3d", "coin", (0.92, 0.75, 0.22), coin())
    add("object", "3d", "key", (0.9, 0.74, 0.22), key())
    add("object", "2d", "sun", (0.98, 0.82, 0.2), sun())
    add("object", "2d", "moon", (0.9, 0.88, 0.7), moon())
    add("object", "2d", "speech", (0.92, 0.92, 0.95), speech())
    add("object", "3d", "arrow3d", (0.95, 0.8, 0.2), arrow3d())


def write_manifest(path: str) -> None:
    rows = [{"id": name, "group": g, "dim": d} for g, d, name, _c, _m in ITEMS]
    extras = [
        {"id": "house", "group": "object", "dim": "2d"},
        {"id": "lock", "group": "status", "dim": "2d"},
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
    for group, dim, name, color, mesh in ITEMS:
        prefer = "+z" if dim == "2d" else "outward"
        if not winding_ok(mesh, prefer):
            failed.append(name)
        dest = os.path.join(OUT, f"{name}.glb")
        write_glb(mesh, dest, name, color, double_sided=(dim == "2d"), prefer=prefer)
        print(f"  {group:6} {dim}  {name:12}  {os.path.getsize(dest):5d} B")
    write_manifest(os.path.join(os.path.dirname(OUT), "manifest.json"))
    if failed:
        raise SystemExit("inward faces after finish(): " + ", ".join(failed))
    print(f"wrote {len(ITEMS)} glbs → {OUT}")


if __name__ == "__main__":
    main()
