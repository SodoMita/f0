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


def bob(amp: float = 0.07, period: float = 1.4) -> dict[str, Any]:
    return {"name": "bob", "channels": [
        _chan("translation", [0.0, period * 0.5, period], [0, 0, 0, 0, amp, 0, 0, 0, 0]),
    ]}


def sway(axis: str = "z", deg: float = 12.0, period: float = 1.8) -> dict[str, Any]:
    times = [0.0, period * 0.25, period * 0.5, period * 0.75, period]
    vals: list[float] = []
    for d in (0.0, deg, 0.0, -deg, 0.0):
        vals.extend(q_axis(axis, d))
    return {"name": "sway", "channels": [_chan("rotation", times, vals)]}


def shake(period: float = 0.9, deg: float = 9.0) -> dict[str, Any]:
    times = [0.0, period * 0.2, period * 0.4, period * 0.6, period]
    vals: list[float] = []
    for d in (0.0, deg, -deg, deg * 0.4, 0.0):
        vals.extend(q_axis("z", d))
    return {"name": "shake", "channels": [_chan("rotation", times, vals)]}


def blink(period: float = 2.6) -> dict[str, Any]:
    t0, t1, t2 = period * 0.72, period * 0.78, period
    return {"name": "blink", "channels": [
        _chan("scale", [0.0, t0, t1, t2], [1, 1, 1, 1, 0.08, 1, 1, 1, 1, 1, 1, 1], "STEP"),
    ]}


def combine(name: str, *anims: dict[str, Any]) -> dict[str, Any]:
    ch: list[dict[str, Any]] = []
    for a in anims:
        ch.extend(a["channels"])
    return {"name": name, "channels": ch}


def library_anim(name: str, dim: str) -> dict[str, Any]:
    """Looping clip for an existing library piece. Never extrudes a plate."""
    faces = {"smile", "grin", "sad", "angry", "wow", "wink", "meh", "love", "dead", "cool"}
    if name in faces:
        return combine("idle", pulse(1.6, 1.06), bob(0.03, 1.6))
    table = {
        "heart": pulse(0.9, 1.18),
        "star": combine("twinkle", spin("z", 3.2), pulse(1.6, 1.08)),
        "plus": pulse(1.1, 1.14),
        "minus": pulse(1.3, 1.08),
        "check": pulse(1.0, 1.12),
        "xmark": pulse(1.0, 1.12),
        "question": bob(0.08, 1.1),
        "bang": bob(0.1, 0.85),
        "thumbup": bob(0.06, 1.2),
        "thumbdown": bob(0.06, 1.2),
        "spark": spin("z", 1.6),
        "fire": pulse(0.45, 1.2),
        "arrow": bob(0.1, 0.9),
        "sun": spin("z", 6.0),
        "moon": pulse(2.2, 1.07),
        "speech": bob(0.05, 1.5),
        "eye": blink(2.4),
        "plane": pulse(2.0, 1.04),
        "lock": shake(1.1, 8.0),
        "unlock": sway("z", 10.0, 1.4),
        "ok": pulse(1.4, 1.1),
        "wait": combine("wait", pulse(1.0, 1.08), spin("y", 2.8)),
        "off": pulse(1.8, 1.06),
        "pin": bob(0.09, 1.1),
        "flag": sway("z", 16.0, 1.5),
        "bell": sway("x", 14.0, 1.1),
        "cube": spin("y", 3.2),
        "sphere": bob(0.08, 1.3),
        "cylinder": spin("y", 3.6),
        "cone": spin("y", 3.2),
        "tetra": spin("y", 2.8),
        "pyramid": spin("y", 3.4),
        "torus": spin("x", 2.6),
        "capsule": bob(0.07, 1.4),
        "hexprism": spin("y", 3.0),
        "wedge": spin("y", 3.5),
        "octa": spin("y", 2.4),
        "house": bob(0.03, 2.0),
        "tree": sway("z", 8.0, 2.2),
        "person": bob(0.04, 1.3),
        "crate": pulse(2.4, 1.04),
        "coin": spin("y", 1.6),
        "key": spin("y", 2.8),
        "arrow3d": bob(0.1, 0.95),
    }
    if name in table:
        return table[name]
    return pulse(1.5, 1.08) if dim == "2d" else spin("y", 3.0)


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
    anim = animation or library_anim(name, "2d" if prefer == "+z" else "3d")
    anim_meta: list[tuple[str, int, int, int, int]] = []
    for ch in anim["channels"]:
        tblob = struct.pack("<" + "f" * len(ch["times"]), *ch["times"])
        vblob = struct.pack("<" + "f" * len(ch["values"]), *ch["values"])
        anim_meta.append((ch["path"], len(ch["times"]), len(blobs), len(blobs) + 1, len(ch["values"])))
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
    channels = []
    samplers = []
    for chan_path, count, t_i, v_i, _nval in anim_meta:
        t_acc = len(accessors)
        accessors.append({"bufferView": t_i, "componentType": 5126, "count": count, "type": "SCALAR",
                          "min": [min(anim["channels"][len(samplers)]["times"])],
                          "max": [max(anim["channels"][len(samplers)]["times"])]})
        vtype = "VEC4" if chan_path == "rotation" else "VEC3"
        accessors.append({"bufferView": v_i, "componentType": 5126, "count": count, "type": vtype})
        interp = anim["channels"][len(samplers)].get("interpolation", "LINEAR")
        samplers.append({"input": t_acc, "output": t_acc + 1, "interpolation": interp})
        channels.append({"sampler": len(samplers) - 1, "target": {"node": 1, "path": chan_path}})

    gltf: dict[str, Any] = {
        "asset": {"version": "2.0", "generator": "FORM/0 library"},
        "extensionsUsed": ["KHR_mesh_quantization"],
        "extensionsRequired": ["KHR_mesh_quantization"],
        "scene": 0,
        "scenes": [{"nodes": [0], "name": name}],
        "nodes": [
            {"name": name, "children": [1]},
            {"name": name + "-mesh", "mesh": 0},
        ],
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
        "animations": [{
            "name": anim.get("name", "idle"),
            "channels": channels,
            "samplers": samplers,
        }],
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
