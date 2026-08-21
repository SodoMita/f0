# Studio symbol library

Tiny, self-contained GLBs the player drops into a creation from the studio's
symbols tab. Everything here is generated — never hand-edited.

## Colour lives in a texture (AMENDMENT 86, 2026-08-21)

Every generated piece samples ONE shared palette:

- `scripts/palette.py` — 64 curated swatches (neutrals, reds, oranges,
  yellows/skin, greens, blues, purples, specials) rendered to a **32x32 PNG**,
  an 8x8 grid of 4x4-pixel swatches.
- `scripts/libglb.py` embeds that PNG in the GLB's own BIN chunk, binds it as
  `baseColorTexture` with a **NEAREST** sampler, and gives every vertex a
  `TEXCOORD_0` that lands on its swatch centre. There is no `COLOR_0` stream.
- A vertex costs the same 4 bytes it used to, the material is a normal
  textured PBR material (the studio tint, posters and the export codecs all
  understand it), and 4x4 swatches with a 2-texel margin mean neither bilinear
  filtering nor a lossy re-encode can bleed one palette entry into another.

Author colour as a palette NAME (`P("skin")`), never a loose RGB literal. The
generator snaps stray literals to the nearest slot and fails the build if
anything is further than 0.12 away — add the swatch instead.

The studio tint multiplies the palette (`albedoColor` x `albedoTexture`), so
the **white** default shows the art exactly as authored and picking a colour
still tints the piece.

## Art direction

- **face** — low-poly BALLS: a once-subdivided icosahedron (80 flat-shaded
  facets) with a darker belly swatch, and features laid onto the surface as
  flat palette patches (`sticker()`). The old flat smiley plates are gone.
- **voxel** — greedy-meshed cubes: `invader`, `ghost`, `creep`, `grassblock`,
  `snake`, `sword`, `pixheart`. Sprites are ASCII art in the generator
  (`sprite()`), extruded 2 voxels deep; only boundary faces are emitted and
  coplanar same-colour faces merge into the biggest rectangle that fits.
  Winding is exact, so voxels finish with `prefer="keep"` — the centroid
  "outward" test would invert every face inside a notch.
- **react / status / shape / object** — as before, now palette-coloured.

`front: true` in the manifest means the piece is authored facing +Z (plates,
face balls, voxel sprites); the studio turns those to the camera on placement.

## Regenerating

```bash
python3 scripts/gen-library-glb.py    # meshes + manifest.json  (raw)
python3 scripts/preview-library.py    # contact sheet -> shots/library-sheet.jpg
node    scripts/encode-library.mjs    # draco pass, kept only when smaller
node    scripts/library-unit.mjs      # guard
node    scripts/library-shot.mjs      # place pieces in a real browser + shoot
```

Run the preview BEFORE the Draco pass — it reads raw GLBs (no Draco decoder in
Python) and draws Draco'd pieces as empty tiles.

`2d/*.glb` are traced plates from `traces/` (see the README there). They are
Draco-compressed with their source PNGs uncommitted, so they are the last
pieces still carrying per-vertex `COLOR_0`.
