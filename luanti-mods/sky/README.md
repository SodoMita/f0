# sky — glowing cloud nodes & weather particles

White glowing clouds for Luanti. 16×16 textures: node tiles are raymarched
volumetric fBm; the four weather symbols are AI pictograms (flat 1-colour,
sharp edges) traced to SVG and rendered to 16×16. Sources live in this
repo's `cloud-textures/` folder.

Scope on purpose: **static node definitions, static particle definitions,
and callable generator functions.** No hooks, no join-time effects, no
entities, no Lua physics hacks — swimming is a node property.

## Nodes

| Node | Behaviour |
|---|---|
| `sky:shoot` | plantlike, passable (`walkable = false`), cloud foliage, glow 7 |
| `sky:block` | opaque, walkable cloud tile, glow 4 |
| `sky:wisp` | transparent (blended alpha), **swimmable + breathable, no fluid**: `liquidtype = "water"` gives the swim node type, `liquid_alternative_flowing = ""` + `liquid_range = 0` mean it never flows, `drowning = 0` keeps breath, glow 6 |

## Particles (static specs in `sky.particles`)

`mist` — white glow haze; `storm` / `rain` / `snow` / `sun` — the real-world
weather symbols drifting as sprite particles.

## Callable generators

```lua
sky.cloud_blob(pos, radius, seed)          -- one lens-shaped cloud
sky.generate(minp, maxp, seed)             -- perlin cloud stratum for a chunk
sky.spawn_weather(pos, "rain")             -- particle drifter at pos
sky.spawn_mist(pos)                        -- glow mist at pos
```

The mod installs **no** mapgen hook. Wire `sky.generate` yourself where you
want clouds, e.g.:

```lua
minetest.register_on_generated(function(minp, maxp, seed)
	sky.generate(minp, maxp, seed)
end)
```

`sky.CLOUD_Y` (default 112) is the stratum height.

## Install

Copy this folder into your game's `mods/` (mod name `sky`). Depends on
nothing.
