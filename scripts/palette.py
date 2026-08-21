#!/usr/bin/env python3
"""The FORM/0 library palette — colour lives in a texture, not in vertices.

Every generated library piece samples ONE shared 32x32 PNG: an 8x8 grid of
4x4-pixel swatches, one swatch per palette slot. A vertex carries a UV that
lands on the CENTRE of its swatch instead of an RGB triple, so:

  * the whole library is art-directed by one palette (change a swatch here and
    every piece that uses it changes),
  * a vertex costs 4 bytes of UV instead of 4 bytes of COLOR_0 (same size) but
    the material is a real textured PBR material the studio/export path
    already understands,
  * the sampler is NEAREST and the swatches are 4x4 with a 2-texel margin, so
    neither bilinear filtering nor a lossy WebP re-encode in the export review
    can bleed one palette entry into its neighbour.

Slots are addressed by NAME. `snap()` maps a legacy float RGB literal to the
nearest slot so older authoring code keeps working (the generator prints how
far each literal had to move).
"""

from __future__ import annotations

import struct
import zlib

# 8 columns x 8 rows = 64 slots. Row order is the art direction:
# neutrals / reds / oranges+browns / yellows+skin / greens / blues / purples /
# specials.
PALETTE: list[tuple[str, str]] = [
    # -- neutrals ----------------------------------------------------------
    ("black", "#0B0B0E"), ("ink", "#1F1610"), ("charcoal", "#2E2F36"), ("slate", "#4A4F5A"),
    ("grey", "#7C828C"), ("silver", "#B4B9C1"), ("bone", "#E4E1D6"), ("white", "#F7F7F4"),
    # -- reds / pinks ------------------------------------------------------
    ("wine", "#6E1122"), ("crimson", "#A8172E"), ("red", "#E62E47"), ("coral", "#F0563C"),
    ("salmon", "#F58C74"), ("rose", "#F2A0B5"), ("pink", "#EE6E9C"), ("magenta", "#C7397E"),
    # -- oranges / browns --------------------------------------------------
    ("rust", "#8A4420"), ("orange", "#E8762A"), ("amber", "#F2A03D"), ("tan", "#D9A46B"),
    ("wood", "#8C5A2B"), ("brown", "#5C3A1E"), ("dirt", "#6B4A32"), ("sand", "#E6CE9B"),
    # -- yellows / gold / skin --------------------------------------------
    ("gold", "#E8B92A"), ("yellow", "#F2D64B"), ("lemon", "#F7EC85"), ("cream", "#F5EBC8"),
    ("skin", "#F5D16B"), ("tanned", "#F2B45C"), ("khaki", "#C6B677"), ("olive", "#7C7A33"),
    # -- greens ------------------------------------------------------------
    ("forest", "#1E5B33"), ("leaf", "#2F8A46"), ("grass", "#4CB050"), ("lime", "#8FD64A"),
    ("mint", "#B8E6A8"), ("slime", "#6FC13F"), ("jade", "#2FA37A"), ("moss", "#5A7A3A"),
    # -- teals / blues -----------------------------------------------------
    ("teal", "#1F7A82"), ("aqua", "#48C0C8"), ("ice", "#BFE8EF"), ("sky", "#6FB7E8"),
    ("azure", "#2F7BD6"), ("blue", "#2B4FA8"), ("navy", "#1B2B5E"), ("steel", "#6E7E96"),
    # -- purples -----------------------------------------------------------
    ("indigo", "#4A2E8C"), ("violet", "#7A4CC4"), ("purple", "#A05BD6"), ("lilac", "#C9A7EE"),
    ("plum", "#5E2A55"), ("orchid", "#D77BC4"), ("mauve", "#9A6E8C"), ("dusk", "#3A3457"),
    # -- specials ----------------------------------------------------------
    ("flesh", "#F0C09A"), ("blush", "#F09A9A"), ("shadow", "#14161C"), ("glass", "#7FB6C4"),
    ("iris", "#3F6FA8"), ("apple", "#D32F2F"), ("emerald", "#17A66B"), ("void", "#05060A"),
]

GRID = 8          # swatches per row / column
CELL = 4          # pixels per swatch
SIDE = GRID * CELL  # 32 px texture

_INDEX: dict[str, int] = {name: i for i, (name, _hex) in enumerate(PALETTE)}


def _hex_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


RGB255: list[tuple[int, int, int]] = [_hex_rgb(h) for _n, h in PALETTE]
RGB: list[tuple[float, float, float]] = [(r / 255, g / 255, b / 255) for r, g, b in RGB255]


def index_of(name: str) -> int:
    try:
        return _INDEX[name]
    except KeyError:
        raise KeyError(f"no palette slot named {name!r}") from None


def rgb(name: str) -> tuple[float, float, float]:
    """Float RGB for a palette name — what the mesh authoring code passes around."""
    return RGB[index_of(name)]


def snap(color) -> tuple[int, float]:
    """Nearest palette slot for a float RGB triple + the distance it moved."""
    r, g, b = float(color[0]), float(color[1]), float(color[2])
    best, best_d = 0, 1e9
    for i, (pr, pg, pb) in enumerate(RGB):
        d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2
        if d < best_d:
            best, best_d = i, d
    return best, best_d ** 0.5


def uv(slot: int) -> tuple[float, float]:
    """UV at the centre of a swatch (glTF UV origin is the image top-left)."""
    col, row = slot % GRID, slot // GRID
    return (col + 0.5) / GRID, (row + 0.5) / GRID


def png_bytes() -> bytes:
    """The palette as a 32x32 8-bit RGB PNG (no filtering, deterministic)."""
    rows = bytearray()
    for y in range(SIDE):
        rows.append(0)  # filter type 0 (None)
        row_slot = (y // CELL) * GRID
        for x in range(SIDE):
            r, g, b = RGB255[row_slot + x // CELL]
            rows += bytes((r, g, b))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", SIDE, SIDE, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
            + chunk(b"IEND", b""))


if __name__ == "__main__":  # pragma: no cover - manual inspection
    png = png_bytes()
    print(f"{len(PALETTE)} slots, {SIDE}x{SIDE} px, {len(png)} B PNG")
    for i, (name, hexv) in enumerate(PALETTE):
        end = "\n" if i % GRID == GRID - 1 else "  "
        print(f"{i:2d} {name:9s} {hexv}", end=end)
