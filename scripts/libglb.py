#!/usr/bin/env python3
"""Quantized self-contained GLB writer + looping TRS clips for the studio library.

Meshes stay as authored (flat 2D plates stay flat; 3D stays volumetric).
Animation lives on a child node so studio lookAt on the root cannot fight it.
"""

from __future__ import annotations

import json
import math
import os
import struct
from typing import Any


def pad4(n: int) -> int:
    return (4 - (n % 4)) % 4


def q_axis(axis: str, deg: float) -> list[float]:
    a = math.radians(deg)
    s, c = math.sin(a / 2.0), math.cos(a / 2.0)
    if axis == "x":
        return [s, 0.0, 0.0, c]
    if axis == "y":
        return [0.0, s, 0.0, c]
    return [0.0, 0.0, s, c]


def _chan(path: str, times: list[float], values: list[float], interp: str = "LINEAR") -> dict[str, Any]:
    return {"path": path, "interpolation": interp, "times": times, "values": values}


def pulse(period: float = 1.2, hi: float = 1.12) -> dict[str, Any]:
    return {"name": "pulse", "channels": [
        _chan("scale", [0.0, period * 0.5, period], [1, 1, 1, hi, hi, hi, 1, 1, 1]),
    ]}


def spin(axis: str = "y", period: float = 2.4) -> dict[str, Any]:
    times = [0.0, period * 0.25, period * 0.5, period * 0.75, period]
    vals: list[float] = []
    for d in (0.0, 90.0, 180.0, 270.0, 360.0):
        vals.extend(q_axis(axis, d))
    return {"name": "spin", "channels": [_chan("rotation", times, vals)]}


def sway(axis: str = "z", deg: float = 12.0, period: float = 1.8) -> dict[str, Any]:
    times = [0.0, period * 0.25, period * 0.5, period * 0.75, period]
    vals: list[float] = []
    for d in (0.0, deg, 0.0, -deg, 0.0):
        vals.extend(q_axis(axis, d))
    return {"name": "sway", "channels": [_chan("rotation", times, vals)]}


def blink(period: float = 2.6) -> dict[str, Any]:
    t0, t1, t2 = period * 0.72, period * 0.78, period
    return {"name": "blink", "channels": [
        _chan("scale", [0.0, t0, t1, t2], [1, 1, 1, 1, 0.08, 1, 1, 1, 1, 1, 1, 1], "STEP"),
    ]}


# Allowlist for a later pass. Empty on purpose: name-based TRS loops
# (pulse a heart, spin a coin) shipped as "animation" and were not.
ANIMATED: dict[str, Any] = {}


def library_anim(name: str, dim: str) -> dict[str, Any] | None:
    """No shipped clips. Helpers above stay for a later author."""
    void = name, dim
    del void
    fn = ANIMATED.get(name)
    return fn() if callable(fn) else None


def _u8(v: float) -> int:
    return max(0, min(255, int(round(v * 255.0))))


def _i8(v: float) -> int:
    return max(-127, min(127, int(round(v * 127.0))))


def write_glb(mesh, path: str, name: str, color=(0.8, 0.8, 0.8), double_sided=True,
              prefer: str = "outward", animation: dict[str, Any] | None = None) -> None:
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
    anim = animation
    anim_meta: list[tuple[str, int, int, int]] = []
    if anim and anim.get("channels"):
        for ch in anim["channels"]:
            tblob = struct.pack("<" + "f" * len(ch["times"]), *ch["times"])
            vblob = struct.pack("<" + "f" * len(ch["values"]), *ch["values"])
            anim_meta.append((ch["path"], len(ch["times"]), len(blobs), len(blobs) + 1))
            blobs.append(tblob)
            blobs.append(vblob)

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
    channels: list[dict[str, Any]] = []
    samplers: list[dict[str, Any]] = []
    if anim and anim_meta:
        for chan_path, count, t_i, v_i in anim_meta:
            t_acc = len(accessors)
            accessors.append({"bufferView": t_i, "componentType": 5126, "count": count, "type": "SCALAR",
                              "min": [min(anim["channels"][len(samplers)]["times"])],
                              "max": [max(anim["channels"][len(samplers)]["times"])]})
            vtype = "VEC4" if chan_path == "rotation" else "VEC3"
            accessors.append({"bufferView": v_i, "componentType": 5126, "count": count, "type": vtype})
            interp = anim["channels"][len(samplers)].get("interpolation", "LINEAR")
            samplers.append({"input": t_acc, "output": t_acc + 1, "interpolation": interp})
            channels.append({"sampler": len(samplers) - 1, "target": {"node": 1, "path": chan_path}})

    nodes: list[dict[str, Any]]
    if anim_meta:
        nodes = [{"name": name, "children": [1]}, {"name": name + "-mesh", "mesh": 0}]
    else:
        nodes = [{"name": name, "mesh": 0}]

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
    if anim_meta:
        gltf["animations"] = [{
            "name": (anim or {}).get("name", "idle"),
            "channels": channels,
            "samplers": samplers,
        }]

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
