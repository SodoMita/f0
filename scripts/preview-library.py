#!/usr/bin/env python3
"""Rasterize every library GLB into a contact sheet (sanity check)."""

from __future__ import annotations

import io
import json
import math
import os
import struct

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GLB_DIR = os.path.join(ROOT, "src", "studio", "library", "glb")
MANIFEST = os.path.join(ROOT, "src", "studio", "library", "manifest.json")
OUT = os.path.join(ROOT, "shots")


def load_glb(path: str):
    """Read a library GLB back: positions, normals, palette colours, faces.

    Colour comes from the embedded palette texture now (TEXCOORD_0 -> swatch),
    so this mirrors what a real renderer does with NEAREST sampling.
    """
    data = open(path, "rb").read()
    off = 12
    json_bytes = None
    bin_off = bin_len = 0
    while off + 8 <= len(data):
        clen = struct.unpack_from("<I", data, off)[0]
        ctype = struct.unpack_from("<I", data, off + 4)[0]
        off += 8
        if ctype == 0x4E4F534A:
            json_bytes = data[off : off + clen]
        if ctype == 0x004E4942:
            bin_off, bin_len = off, clen
        off += clen
    gltf = json.loads(json_bytes)
    blob = data[bin_off : bin_off + bin_len]
    acc = gltf["accessors"]
    views = gltf["bufferViews"]

    def take(i, ncomp):
        a = acc[i]
        v = views[a["bufferView"]]
        start = (v.get("byteOffset") or 0) + (a.get("byteOffset") or 0)
        n = a["count"]
        stride = a.get("byteStride") or v.get("byteStride")
        if a["componentType"] == 5126:
            return np.frombuffer(blob, np.float32, n * ncomp, start).reshape(n, ncomp).copy()
        if a["componentType"] == 5121 and a["type"] == "VEC2":
            raw = np.frombuffer(blob, np.uint8, n * (stride or 2), start).reshape(n, stride or 2)
            return raw[:, :2].astype(np.float64) / 255.0
        if a["componentType"] == 5120:
            raw = np.frombuffer(blob, np.int8, n * (stride or 3), start).reshape(n, stride or 3)
            return raw[:, :3].astype(np.float64) / 127.0
        return np.frombuffer(blob, np.uint16, n, start).astype(np.int32).copy()

    prim = gltf["meshes"][0]["primitives"][0]
    v = take(prim["attributes"]["POSITION"], 3)
    n = take(prim["attributes"]["NORMAL"], 3)
    uv = take(prim["attributes"]["TEXCOORD_0"], 2)
    f = take(prim["indices"], 1).reshape(-1, 3)
    # sample the palette exactly like a NEAREST sampler would
    img = np.asarray(Image.open(io.BytesIO(_image_bytes(gltf, blob))).convert("RGB"), np.float64) / 255.0
    h, w, _ = img.shape
    px = np.clip((uv[:, 0] * w).astype(int), 0, w - 1)
    py = np.clip((uv[:, 1] * h).astype(int), 0, h - 1)
    c = img[py, px]
    return v, n, c, f


def _image_bytes(gltf, blob) -> bytes:
    image = gltf["images"][0]
    view = gltf["bufferViews"][image["bufferView"]]
    start = view.get("byteOffset") or 0
    return blob[start : start + view["byteLength"]]


def look_at(eye, target):
    eye = np.asarray(eye, float)
    target = np.asarray(target, float)
    fwd = eye - target
    fwd /= np.linalg.norm(fwd)
    right = np.cross(np.array([0.0, 1.0, 0.0]), fwd)
    right /= np.linalg.norm(right)
    up = np.cross(fwd, right)
    R = np.stack([right, up, fwd], 0)
    return R, -R @ eye


def render(v, nrm, col, faces, w=160, h=120, front=False):
    center = (v.min(0) + v.max(0)) * 0.5
    radius = np.linalg.norm(v - center, axis=1).max() or 1.0
    if front:
        eye = center + np.array([0.0, 0.0, radius * 3.2])
    else:
        eye = center + np.array([radius * 2.15, radius * 1.05, radius * 2.8])
    R, t = look_at(eye, center)
    vv = v @ R.T + t
    nn = nrm @ R.T
    nn /= np.clip(np.linalg.norm(nn, axis=1, keepdims=True), 1e-8, None)
    aspect = w / h
    f = 1.0 / math.tan(math.radians(28) * 0.5)
    z = vv[:, 2]
    inv = 1.0 / np.clip(-z, 1e-6, None)
    xs = ((f / aspect) * vv[:, 0] * inv * 0.5 + 0.5) * w
    ys = (1.0 - (f * vv[:, 1] * inv * 0.5 + 0.5)) * h
    key = np.array([0.35, 0.75, 0.45])
    key = key / np.linalg.norm(key)
    key_v = key @ R.T
    ndl = np.clip(nn @ key_v, 0, 1)
    hemi = 0.22 + 0.35 * np.clip(nn[:, 1], 0, 1)
    shaded = np.clip(col * (0.18 + hemi[:, None] + 0.85 * ndl[:, None]), 0, 1)

    img = np.zeros((h, w, 3), np.float64)
    yy = np.linspace(0, 1, h)[:, None, None]
    img[:] = (0.16, 0.16, 0.18) * (1 - yy) + (0.08, 0.08, 0.09) * yy
    depth = np.full((h, w), 1e9)

    # Front faces are CCW in world space; the screen y-flip makes them
    # clockwise, so iterate reversed and keep positive-area triangles.
    for ia, ib, ic in faces[:, ::-1]:
        if z[ia] >= -0.02 or z[ib] >= -0.02 or z[ic] >= -0.02:
            continue
        x0, y0 = xs[ia], ys[ia]
        x1, y1 = xs[ib], ys[ib]
        x2, y2 = xs[ic], ys[ic]
        area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
        if area <= 1e-4:
            continue
        minx = max(int(math.floor(min(x0, x1, x2))), 0)
        maxx = min(int(math.ceil(max(x0, x1, x2))), w - 1)
        miny = max(int(math.floor(min(y0, y1, y2))), 0)
        maxy = min(int(math.ceil(max(y0, y1, y2))), h - 1)
        if minx > maxx or miny > maxy:
            continue
        PX, PY = np.meshgrid(np.arange(minx, maxx + 1), np.arange(miny, maxy + 1))
        w0 = (x1 - PX) * (y2 - PY) - (x2 - PX) * (y1 - PY)
        w1 = (x2 - PX) * (y0 - PY) - (x0 - PX) * (y2 - PY)
        w2 = (x0 - PX) * (y1 - PY) - (x1 - PX) * (y0 - PY)
        mask = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not np.any(mask):
            continue
        inva = 1.0 / area
        b0, b1, b2 = w0 * inva, w1 * inva, w2 * inva
        iz = b0 * inv[ia] + b1 * inv[ib] + b2 * inv[ic]
        zpix = 1.0 / np.clip(iz, 1e-9, None)
        old = depth[miny : maxy + 1, minx : maxx + 1]
        vis = mask & (zpix < old)
        if not np.any(vis):
            continue
        rgb = (
            b0[..., None] * (shaded[ia] * inv[ia])
            + b1[..., None] * (shaded[ib] * inv[ib])
            + b2[..., None] * (shaded[ic] * inv[ic])
        ) * zpix[..., None]
        dest = img[miny : maxy + 1, minx : maxx + 1]
        dest[vis] = rgb[vis]
        old[vis] = zpix[vis]
        depth[miny : maxy + 1, minx : maxx + 1] = old
    return np.clip(img ** (1 / 1.9) * 255, 0, 255).astype(np.uint8)


def main():
    os.makedirs(OUT, exist_ok=True)
    items = json.load(open(MANIFEST))
    tiles = []
    for item in items:
        v, n, c, f = load_glb(os.path.join(GLB_DIR, item["id"] + ".glb"))
        tiles.append(Image.fromarray(render(v, n, c, f, front=bool(item.get("front"))), "RGB"))
    cols = 9
    rows = math.ceil(len(tiles) / cols)
    tw, th = tiles[0].size
    sheet = Image.new("RGB", (cols * tw, rows * th), (18, 18, 20))
    for i, im in enumerate(tiles):
        sheet.paste(im, ((i % cols) * tw, (i // cols) * th))
    path = os.path.join(OUT, "library-sheet.jpg")
    sheet.save(path, "JPEG", quality=90)
    print("wrote", path, sheet.size)


if __name__ == "__main__":
    main()
