#!/usr/bin/env python3
"""Quantized, self-contained GLB writer for the studio library.

Meshes stay as authored (flat 2D plates stay flat; 3D stays volumetric).
Library pieces ship STILL — no animation clips are written.

COLOUR COMES FROM A TEXTURE (2026-08-21). Instead of a COLOR_0 stream, every
vertex carries a UV that lands on the centre of one swatch of the shared
palette (`scripts/palette.py`): a 32x32 PNG embedded in the GLB's own BIN
chunk, sampled NEAREST. Same bytes per vertex as the old vertex colours, one
art-directed palette for the whole library, and a normal textured PBR material
that the studio tint, the poster path and the export codecs already handle.
"""

from __future__ import annotations

import json
import os
import struct
import sys
from typing import Any

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import palette  # noqa: E402


def pad4(n: int) -> int:
    return (4 - (n % 4)) % 4


def _u8(v: float) -> int:
    return max(0, min(255, int(round(v * 255.0))))


def _i8(v: float) -> int:
    return max(-127, min(127, int(round(v * 127.0))))


def write_glb(mesh, path: str, name: str, color=(0.8, 0.8, 0.8), double_sided=True,
              prefer: str = "outward") -> dict[str, Any]:
    """Write `mesh` as a palette-textured GLB. Returns a small report."""
    mesh = mesh.finish(prefer)
    nvert = len(mesh.v)
    nidx = len(mesh.i)
    if nvert < 3 or nidx < 3:
        raise ValueError(f"{name}: empty mesh")

    # ---- colour -> palette slot -> UV ------------------------------------
    slots: list[int] = []
    worst = 0.0
    cache: dict[tuple[int, int, int], tuple[int, float]] = {}
    for c in mesh.c:
        key = (_u8(c[0]), _u8(c[1]), _u8(c[2]))
        hit = cache.get(key)
        if hit is None:
            hit = palette.snap(c)
            cache[key] = hit
        slot, dist = hit
        slots.append(slot)
        worst = max(worst, dist)

    pos = b"".join(struct.pack("<fff", *p) for p in mesh.v)
    nrm = b"".join(struct.pack("<bbb", _i8(n[0]), _i8(n[1]), _i8(n[2])) + b"\x00" for n in mesh.n)
    # UV as 2x unsigned byte (KHR_mesh_quantization), padded to a 4-byte stride
    # because vertex attributes must be 4-byte aligned.
    uvs = b""
    for slot in slots:
        u, v = palette.uv(slot)
        uvs += bytes((_u8(u), _u8(v), 0, 0))
    idx = struct.pack("<" + "H" * nidx, *mesh.i)
    png = palette.png_bytes()

    blobs: list[bytes] = [pos, nrm, uvs, idx, png]
    views: list[tuple[int, int, int | None]] = []
    cursor = 0
    bin_body = b""
    targets = [34962, 34962, 34962, 34963, None]
    for i, blob in enumerate(blobs):
        views.append((cursor, len(blob), targets[i]))
        pad = pad4(len(blob))
        bin_body += blob + (b"\x00" * pad)
        cursor += len(blob) + pad

    xs, ys, zs = zip(*mesh.v)
    accessors: list[dict[str, Any]] = [
        {"bufferView": 0, "componentType": 5126, "count": nvert, "type": "VEC3",
         "min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]},
        {"bufferView": 1, "byteStride": 4, "componentType": 5120, "count": nvert, "type": "VEC3",
         "normalized": True},
        {"bufferView": 2, "byteStride": 4, "componentType": 5121, "count": nvert, "type": "VEC2",
         "normalized": True},
        {"bufferView": 3, "componentType": 5123, "count": nidx, "type": "SCALAR"},
    ]

    nodes: list[dict[str, Any]] = [{"name": name, "mesh": 0}]

    gltf: dict[str, Any] = {
        "asset": {"version": "2.0", "generator": "FORM/0 library"},
        "extensionsUsed": ["KHR_mesh_quantization"],
        "extensionsRequired": ["KHR_mesh_quantization"],
        "scene": 0,
        "scenes": [{"nodes": [0], "name": name}],
        "nodes": nodes,
        "meshes": [{
            "name": name,
            "primitives": [{
                "attributes": {"POSITION": 0, "NORMAL": 1, "TEXCOORD_0": 2},
                "indices": 3,
                "material": 0,
                "mode": 4,
            }],
        }],
        "materials": [{
            "name": name,
            "pbrMetallicRoughness": {
                # White factor: the palette texture IS the colour. The studio
                # tint multiplies this factor at runtime.
                "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
                "baseColorTexture": {"index": 0, "texCoord": 0},
                "metallicFactor": 0.0,
                "roughnessFactor": 0.7,
            },
            "doubleSided": bool(double_sided),
        }],
        # NEAREST + clamp: one texel per palette swatch must never be blended
        # with its neighbour (and no mips are generated).
        "samplers": [{"magFilter": 9728, "minFilter": 9728, "wrapS": 33071, "wrapT": 33071}],
        "images": [{"name": "palette", "mimeType": "image/png", "bufferView": 4}],
        "textures": [{"name": "palette", "sampler": 0, "source": 0}],
        "accessors": accessors,
        "bufferViews": [
            ({"buffer": 0, "byteOffset": o, "byteLength": n} | ({"target": t} if t else {}))
            for o, n, t in views
        ],
        "buffers": [{"byteLength": len(bin_body)}],
    }

    json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_bytes += b" " * pad4(len(json_bytes))
    bin_body += b"\x00" * pad4(len(bin_body))
    total = 12 + 8 + len(json_bytes) + 8 + len(bin_body)
    header = struct.pack("<4sII", b"glTF", 2, total)
    jchunk = struct.pack("<I4s", len(json_bytes), b"JSON") + json_bytes
    bchunk = struct.pack("<I4s", len(bin_body), b"BIN\x00") + bin_body
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as f:
        f.write(header + jchunk + bchunk)
    void = color
    del void
    return {"bytes": total, "vertices": nvert, "slots": sorted(set(slots)), "snap": worst}
