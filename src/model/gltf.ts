/**
 * Curated glTF loader.
 *
 * `import '@babylonjs/loaders/glTF'` pulls in the glTF **1.0** loader plus
 * every 2.0 extension, including KHR_interactivity — which drags in Babylon's
 * whole FlowGraph behaviour engine (dozens of modules) that a viewer can never
 * execute. This module registers the 2.0 loader and only the extensions that
 * can change how a posted model LOOKS.
 *
 * Adding an extension is cheap; if a model in the wild needs one, add the
 * import here (and note it in docs/SPEC.md).
 */
import '@babylonjs/loaders/glTF/glTFFileLoader'
import '@babylonjs/loaders/glTF/2.0/glTFLoader'

// geometry / compression
import '@babylonjs/loaders/glTF/2.0/Extensions/KHR_draco_mesh_compression'
import '@babylonjs/loaders/glTF/2.0/Extensions/KHR_mesh_quantization'
import '@babylonjs/loaders/glTF/2.0/Extensions/EXT_meshopt_compression'
import '@babylonjs/loaders/glTF/2.0/Extensions/EXT_mesh_gpu_instancing'

// textures
import '@babylonjs/loaders/glTF/2.0/Extensions/KHR_texture_transform'
import '@babylonjs/loaders/glTF/2.0/Extensions/KHR_texture_basisu'
import '@babylonjs/loaders/glTF/2.0/Extensions/EXT_texture_webp'
import '@babylonjs/loaders/glTF/2.0/Extensions/EXT_texture_avif'

// materials
import '@babylonjs/loaders/glTF/2.0/Extensions/KHR_materials_unlit'
import '@babylonjs/loaders/glTF/2.0/Extensions/KHR_materials_emissive_strength'
import '@babylonjs/loaders/glTF/2.0/Extensions/KHR_materials_ior'
import '@babylonjs/loaders/glTF/2.0/Extensions/KHR_materials_specular'
import '@babylonjs/loaders/glTF/2.0/Extensions/KHR_materials_clearcoat'
import '@babylonjs/loaders/glTF/2.0/Extensions/KHR_materials_iridescence'
import '@babylonjs/loaders/glTF/2.0/Extensions/KHR_materials_sheen'
import '@babylonjs/loaders/glTF/2.0/Extensions/KHR_materials_transmission'
import '@babylonjs/loaders/glTF/2.0/Extensions/KHR_materials_volume'
import '@babylonjs/loaders/glTF/2.0/Extensions/KHR_materials_dispersion'
import '@babylonjs/loaders/glTF/2.0/Extensions/KHR_materials_anisotropy'
import '@babylonjs/loaders/glTF/2.0/Extensions/KHR_materials_diffuse_transmission'
import '@babylonjs/loaders/glTF/2.0/Extensions/KHR_materials_pbrSpecularGlossiness'
import '@babylonjs/loaders/glTF/2.0/Extensions/KHR_materials_variants'
import '@babylonjs/loaders/glTF/2.0/Extensions/EXT_materials_diffuse_roughness'

// scene features a post may rely on
import '@babylonjs/loaders/glTF/2.0/Extensions/KHR_lights_punctual'
import '@babylonjs/loaders/glTF/2.0/Extensions/KHR_animation_pointer'
import '@babylonjs/loaders/glTF/2.0/Extensions/MSFT_lod'
import '@babylonjs/loaders/glTF/2.0/Extensions/MSFT_minecraftMesh'
import '@babylonjs/loaders/glTF/2.0/Extensions/MSFT_sRGBFactors'
