#!/usr/bin/env python3
"""Trace src/studio/library/traces/*.png into flat +Z GLBs (no stacked layers).

PNG → ImageMagick quantize → pixel-boundary loops → RDP → earcut with holes.
Every triangle sits at z=0; colours own disjoint pixels so they cannot z-fight.
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "src", "studio", "library", "2d")
TRACES = os.path.join(ROOT, "src", "studio", "library", "traces")

if HERE not in sys.path:
    sys.path.insert(0, HERE)

from imgtrace import trace_png  # noqa: E402
from libglb import write_glb  # noqa: E402


class FlatMesh:
    def __init__(self):
        self.v, self.n, self.c, self.i = [], [], [], []

    def add_tri(self, a, b, c, color) -> None:
        base = len(self.v)
        for p in (a, b, c):
            self.v.append([float(p[0]), float(p[1]), 0.0])
            self.c.append([float(color[0]), float(color[1]), float(color[2])])
            self.n.append([0.0, 0.0, 1.0])
        self.i.extend([base, base + 1, base + 2])

    def finish(self, prefer: str = "+z"):
        void = prefer
        del void
        return self


def mesh_from_tris(tris) -> FlatMesh:
    m = FlatMesh()
    for a, b, c, rgb in tris:
        # y-flip already applied; emit a,c,b so winding faces +Z.
        m.add_tri(a, c, b, rgb)
    return m


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    names = sorted(fn[:-4] for fn in os.listdir(TRACES) if fn.endswith(".png"))
    if not names:
        raise SystemExit("no PNGs in " + TRACES)
    for name in names:
        src = os.path.join(TRACES, name + ".png")
        tris = trace_png(src)
        zs = {round(p[2], 6) for t in tris for p in t[:3]}
        if zs != {0.0}:
            raise SystemExit(f"{name}: not flat, z={zs}")
        mesh = mesh_from_tris(tris)
        dest = os.path.join(OUT, name + ".glb")
        write_glb(mesh, dest, name, color=tris[0][3], double_sided=True, prefer="+z", animation=None)
        print(f"  2d  {name:8}  {os.path.getsize(dest):5d} B  tris={len(tris)}  colors={len({t[3] for t in tris})}")
    print(f"traced {len(names)} plates → {OUT}")


if __name__ == "__main__":
    main()
