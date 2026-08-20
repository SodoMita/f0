#!/usr/bin/env python3
"""Quantized, self-contained GLB writer for the studio library.

Meshes stay as authored (flat 2D plates stay flat; 3D stays volumetric).
Library pieces ship STILL — no animation clips are written.
"""

from __future__ import annotations

import json
import os
import struct
from typing import Any


def pad4(n: int) -> int:
    return (4 - (n % 4)) % 4


def _u8(v: float) -> int:
    return max(0, min(255, int(round(v * 255.0))))


def _i8(v: float) -> int:
    return max(-127, min(127, int(round(v * 127.0))))


def write_glb(mesh, path: str, name: str, color=(0.8, 0.8, 0.8), double_sided=True,
              prefer: str = "outward") -> None:
    mesh = mesh.finish(prefer)
    nvert = len(mesh.v)
    nidx = len(mesh.i)
    if nvert < 3 or nidx < 3:
        raise ValueError(f"{name}: empty mesh")

    pos = b"".join(struct.pack("<fff", *p) for p in mesh.v)
    nrm = b"".join(struct.pack("<bbb", _i8(n[0]), _i8(n[1]), _i8(n[2])) + b"\x00" for n in mesh.n)
    col = b"".join(bytes((_u8(c[0]), _u8(c[1]), _u8(c[2]), 255)) for c in mesh.c)
    idx = struct.pack("<" + "H" * nidx, *mesh.i)

    blobs: list[bytes] = [pos, nrm, col, idx]
    views: list[tuple[int, int, int | None]] = []
    cursor = 0
    bin_body = b""
    targets = [34962, 34962, 34962, 34963]
    for i, blob in enumerate(blobs):
        target = targets[i] if i < 4 else None
        views.append((cursor, len(blob), target))
        pad = pad4(len(blob))
        bin_body += blob + (b"\x00" * pad)
        cursor += len(blob) + pad

    xs, ys, zs = zip(*mesh.v)
    accessors: list[dict[str, Any]] = [
        {"bufferView": 0, "componentType": 5126, "count": nvert, "type": "VEC3",
         "min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]},
        {"bufferView": 1, "byteStride": 4, "componentType": 5120, "count": nvert, "type": "VEC3",
         "normalized": True},
        {"bufferView": 2, "componentType": 5121, "count": nvert, "type": "VEC4", "normalized": True},
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
                "attributes": {"POSITION": 0, "NORMAL": 1, "COLOR_0": 2},
                "indices": 3,
                "material": 0,
                "mode": 4,
            }],
        }],
        "materials": [{
            "name": name,
            "pbrMetallicRoughness": {
                "baseColorFactor": [float(color[0]), float(color[1]), float(color[2]), 1.0],
                "metallicFactor": 0.0,
                "roughnessFactor": 0.7,
            },
            "doubleSided": bool(double_sided),
        }],
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
