-- sky: white glowing cloud nodes + weather particles.
-- Art: 16x16 raymarched volumes (nodes) and AI pictograms traced to SVG
-- (particles). Colours: white + glow; rare pale accents only where essential.
--
-- Scope on purpose: static node definitions, static particle definitions,
-- and callable generator functions. No hooks, no join-time effects, no
-- entities: swimming is a node property (liquidtype), not Lua.

local S = minetest.get_translator("sky")

sky = {}
sky.CLOUD_Y = 112 -- default height used by the callable generators

-- ---------------------------------------------------------------- nodes ----

-- Plantlike passable cloud shoot: foliage made of cloud, walk through it.
minetest.register_node("sky:shoot", {
	description = S("Cloud Shoot"),
	drawtype = "plantlike",
	tiles = {"sky_shoot.png"},
	inventory_image = "sky_shoot.png",
	wield_image = "sky_shoot.png",
	paramtype = "light",
	sunlight_propagates = true,
	use_texture_alpha = "clip",
	walkable = false,
	buildable_to = true,
	floodable = true,
	is_ground_content = false,
	light_source = 7,
	groups = {snappy = 3, dig_immediate = 3, flammable = 0},
})

-- Opaque walkable cloud block: stand on it, build with it.
minetest.register_node("sky:block", {
	description = S("Cloud Block"),
	tiles = {"sky_block.png"},
	paramtype = "light",
	is_ground_content = false,
	light_source = 4,
	groups = {snappy = 3, dig_immediate = 3, flammable = 0},
})

-- Transparent thin cloud: swimmable + breathable, but NOT a fluid.
-- Swimming comes from the node type (liquidtype = "water"); the empty
-- flowing alternative + liquid_range = 0 mean it never flows or spreads,
-- and drowning = 0 keeps it breathable.
minetest.register_node("sky:wisp", {
	description = S("Thin Cloud"),
	drawtype = "allfaces_optional",
	tiles = {"sky_wisp.png"},
	inventory_image = "sky_wisp.png^[opacity:160",
	wield_image = "sky_wisp.png",
	paramtype = "light",
	sunlight_propagates = true,
	use_texture_alpha = "blend",
	walkable = false,
	climbable = 1,
	buildable_to = true,
	floodable = true,
	is_ground_content = false,
	liquidtype = "water",
	liquid_alternative_source = "sky:wisp",
	liquid_alternative_flowing = "",
	liquid_viscosity = 1,
	liquid_renewable = false,
	liquid_range = 0,
	drowning = 0,
	light_source = 6,
	groups = {snappy = 3, dig_immediate = 3, flammable = 0},
})

-- ------------------------------------------------------------- particles --

-- Static particle definitions: white glow mist, plus the four real-world
-- weather symbols drifting as sprite particles.
sky.particles = {
	mist = {
		amount = 24,
		time = 8,
		collisiondetection = false,
		vertical = false,
		texture = "sky_wisp.png^[opacity:90",
		minpos = {x = -8, y = -2, z = -8},
		maxpos = {x = 8, y = 2, z = 8},
		minvel = {x = -0.2, y = 0.05, z = -0.2},
		maxvel = {x = 0.2, y = 0.25, z = 0.2},
		minacc = {x = 0, y = 0, z = 0},
		maxacc = {x = 0, y = 0.05, z = 0},
		minexptime = 4,
		maxexptime = 8,
		minsize = 2,
		maxsize = 4,
	},
	storm = {
		amount = 1, time = 12,
		collisiondetection = false,
		texture = "sky_entity_storm.png",
		minpos = {x = -1, y = 0, z = -1}, maxpos = {x = 1, y = 0, z = 1},
		minvel = {x = 0.6, y = 0, z = 0}, maxvel = {x = 1.2, y = 0.1, z = 0},
		minexptime = 10, maxexptime = 12,
		minsize = 6, maxsize = 8,
	},
	rain = {
		amount = 1, time = 12,
		collisiondetection = false,
		texture = "sky_entity_rain.png",
		minpos = {x = -1, y = 0, z = -1}, maxpos = {x = 1, y = 0, z = 1},
		minvel = {x = 0.6, y = -0.15, z = 0}, maxvel = {x = 1.2, y = 0, z = 0},
		minexptime = 10, maxexptime = 12,
		minsize = 6, maxsize = 8,
	},
	snow = {
		amount = 1, time = 12,
		collisiondetection = false,
		texture = "sky_entity_snow.png",
		minpos = {x = -1, y = 0, z = -1}, maxpos = {x = 1, y = 0, z = 1},
		minvel = {x = 0.4, y = -0.25, z = 0}, maxvel = {x = 0.8, y = -0.1, z = 0},
		minexptime = 10, maxexptime = 12,
		minsize = 6, maxsize = 8,
	},
	sun = {
		amount = 1, time = 12,
		collisiondetection = false,
		texture = "sky_entity_sun.png",
		minpos = {x = -1, y = 0, z = -1}, maxpos = {x = 1, y = 0, z = 1},
		minvel = {x = 0.3, y = 0.05, z = 0}, maxvel = {x = 0.6, y = 0.1, z = 0},
		minexptime = 10, maxexptime = 12,
		minsize = 6, maxsize = 8,
	},
}

-- Spawn a weather-symbol particle drifter centred at `pos`.
function sky.spawn_weather(pos, kind)
	local spec = sky.particles[kind]
	if not spec then return nil end
	local s = {}
	for k, v in pairs(spec) do s[k] = v end
	s.minpos = {x = pos.x + spec.minpos.x, y = pos.y + spec.minpos.y, z = pos.z + spec.minpos.z}
	s.maxpos = {x = pos.x + spec.maxpos.x, y = pos.y + spec.maxpos.y, z = pos.z + spec.maxpos.z}
	return minetest.add_particlespawner(s)
end

-- Spawn the white glow mist around `pos`.
function sky.spawn_mist(pos)
	local spec = sky.particles.mist
	local s = {}
	for k, v in pairs(spec) do s[k] = v end
	s.minpos = {x = pos.x + spec.minpos.x, y = pos.y + spec.minpos.y, z = pos.z + spec.minpos.z}
	s.maxpos = {x = pos.x + spec.maxpos.x, y = pos.y + spec.maxpos.y, z = pos.z + spec.maxpos.z}
	return minetest.add_particlespawner(s)
end

-- ------------------------------------------------ callable generators -----

-- A single lens-shaped cloud blob at `pos`: opaque block core, plantlike
-- shoots on top, wisp fringe underneath. Returns nodes placed.
function sky.cloud_blob(pos, radius, seed)
	seed = seed or 0
	local placed = 0
	local r = radius or 4
	for dx = -r, r do
		for dz = -r, r do
			local d = math.sqrt(dx * dx + dz * dz)
			if d <= r then
				local th = math.max(1, math.floor((1 - d / (r + 1)) * 3))
				for i = 0, th - 1 do
					minetest.set_node({x = pos.x + dx, y = pos.y + i, z = pos.z + dz},
						{name = "sky:block"})
					placed = placed + 1
				end
				local n = math.sin((pos.x + dx) * 12.9898 + (pos.z + dz) * 78.233 + seed) * 43758.5453
				n = n - math.floor(n)
				if n > 0.6 then
					minetest.set_node({x = pos.x + dx, y = pos.y + th, z = pos.z + dz},
						{name = "sky:shoot"})
				elseif n < 0.25 then
					minetest.set_node({x = pos.x + dx, y = pos.y - 1, z = pos.z + dz},
						{name = "sky:wisp"})
				end
			end
		end
	end
	return placed
end

-- Fill the cloud stratum for a mapchunk: perlin-driven field of blobs.
-- Callable from mapgen hooks, Mesecons/digilines, admin tools — the mod
-- itself installs no hook.
function sky.generate(minp, maxp, seed)
	if maxp.y < sky.CLOUD_Y - 8 or minp.y > sky.CLOUD_Y + 12 then return 0 end
	local noise = minetest.get_perlin({
		offset = 0, scale = 1, spread = {x = 96, y = 96, z = 96},
		octaves = 3, persistence = 0.55, seed_offset = seed % 65536,
	})
	local placed = 0
	for x = minp.x, maxp.x, 9 do
		for z = minp.z, maxp.z, 9 do
			local n = noise:get2d({x = x, y = z})
			if n > 0.5 then
				placed = placed + sky.cloud_blob(
					{x = x, y = sky.CLOUD_Y, z = z},
					2 + math.floor((n - 0.5) * 8), seed)
			end
		end
	end
	return placed
end
