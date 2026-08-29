# Cloud node & entity textures — 16×16, white + glow

All textures are **16×16 RGBA PNGs**. Node tiles are seamless (periodic
noise). Entity sprites are WMO-style real-world weather pictograms.
Python generators live OUTSIDE the repo (scratch only); the deliverables
are these files.

## Node textures

| File | Look | Intended node definition (Luanti/Minetest vocabulary) |
|---|---|---|
| `cloud_plantlike.png` | plantlike leaf/fern made of cloud puffs on transparent bg | `drawtype = "plantlike"`, `walkable = false` (passable), `paramtype = "light"`, `sunlight_propagates = true`, `use_texture_alpha = "clip"`, white + `light_source` for glow |
| `cloud_block.png` | opaque cotton tile, seamless | `drawtype = "normal"`, `walkable = true`, opaque (alpha 255 everywhere), `use_texture_alpha = "opaque"` |
| `cloud_swim.png` | seamless translucent wisp haze (mean alpha ≈ 0.36) | `drawtype = "allfaces_optional"`, `walkable = false`, `use_texture_alpha = "blend"`, **no** `liquidtype`, `drowning = 0` → swimmable + breathable, not a fluid |

Mean alpha measured on the shipped files: plantlike 0.25 (sprite on
transparent), block 1.00, swim 0.36.

## Entity textures (real-world weather symbols)

`cloud_entity_storm.png`, `cloud_entity_rain.png`, `cloud_entity_snow.png`,
`cloud_entity_sun.png` — white cumulus silhouette + one accent, used only
where essential (bolt pale gold, rain pale blue, snowflake ice-blue, sun
pale warm). Each has a 1-px pale-blue glow halo (alpha ≈ 27 %). Companion
`*.svg` files are the traced vectors (16×16 viewBox) for re-rendering at
any size.

## How they were made

- **Node tiles & plantlike sprite:** raymarched volumetric fBm (orthographic
  front-to-back march, gradient lighting, Beer–Lambert extinction) at
  128×128, area-downsampled to 16×16. Plantlike = leaflet ellipsoids eroded
  by noise so the silhouette is fluffy-leaf-like.
- **Entity symbols:** AI image asked for *flat vector, single colour, sharp
  edges, no blur, no gradients* → binarize → boundary trace → RDP → SVG →
  supersampled polygon fill to 16×16 (keeps edges crisp, no AI blur).

## Suggested registration (drop-in for a `clouds` mod)

```lua
minetest.register_node("clouds:plantlike", {
    description = "Cloud Shoot",
    drawtype = "plantlike",
    tiles = {"cloud_plantlike.png"},
    paramtype = "light", sunlight_propagates = true,
    use_texture_alpha = "clip",
    walkable = false,
    light_source = 7,               -- glow
    groups = {snappy = 3, not_in_creative_inventory = 0},
})
minetest.register_node("clouds:block", {
    description = "Cloud Block",
    tiles = {"cloud_block.png"},
    walkable = true,
    light_source = 4,
    groups = {snappy = 3, fluffy = 1},
})
minetest.register_node("clouds:swim", {
    description = "Thin Cloud",
    drawtype = "allfaces_optional",
    tiles = {"cloud_swim.png"},
    paramtype = "light", sunlight_propagates = true,
    use_texture_alpha = "blend",
    walkable = false,
    drowning = 0,                   -- breathable
    -- no liquidtype: not a fluid, yet passable/swimmable
    light_source = 6,
    groups = {not_in_creative_inventory = 0},
})
```

Entity example (sprite visual, 16×16):

```lua
minetest.register_entity("clouds:storm", {
    initial_sprite = "cloud_entity_storm.png",
    visual = "sprite", visual_size = {x = 1, y = 1},
    glow = 12, physical = false,
})
```

Contact sheet: `contact_sheet.png` (each texture at 16× zoom over a
checkerboard, and as a 2×2 tiling to verify seamlessness).
