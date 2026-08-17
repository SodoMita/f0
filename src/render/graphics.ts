// Heavy post-processing pipelines are loaded ON DEMAND: bundling SSAO2 + SSR +
// TAA + the default pipeline statically added ~380 kB to first paint for
// features most sessions never switch on. The standalone build inlines these
// chunks (rollupOptions.inlineDynamicImports), so file:// still works.
import type { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline'
import type { SSAO2RenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline'
import type { SSAORenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssaoRenderingPipeline'
import type { SSRRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssrRenderingPipeline'
import type { TAARenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/taaRenderingPipeline'
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration'
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import type { Scene } from '@babylonjs/core/scene'
import type { Camera } from '@babylonjs/core/Cameras/camera'
import type { AssetContainer } from '@babylonjs/core/assetContainer'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import type { SettingsValues } from '../settings/schema'

export type SceneKind = 'viewer' | 'studio' | 'offscreen' | 'flat'

interface Registered {
  scene: Scene
  kind: SceneKind
  camera?: () => Camera | null
  baseLight: Map<string, number>
  pipeline?: DefaultRenderingPipeline
  ssao?: SSAO2RenderingPipeline | SSAORenderingPipeline
  ssr?: SSRRenderingPipeline
  taa?: TAARenderingPipeline
  shadows?: ShadowGenerator
}

const BLOOM_KERNEL: Record<string, number> = { low: 16, medium: 32, high: 64, ultra: 128 }

/**
 * Applies the graphics settings to every Babylon scene in the app.
 *
 * Everything here is a REAL engine feature: MSAA/FXAA/TAA, SSAO2, SSR, bloom,
 * tone mapping + exposure/contrast, anisotropy, shadow maps, unlit (PBR off).
 * Vendor upscalers (DLSS/FSR/XeSS), frame generation and hardware ray tracing
 * do not exist in WebGL — the settings panel shows those as unavailable and
 * offers render-scale + sharpening as the equivalent.
 */
export class Graphics {
  private scenes: Registered[] = []
  private values: SettingsValues | null = null
  private containers = new Set<AssetContainer>()
  onInvalidate: (() => void) | null = null
  /** Feature id -> why it could not be enabled on this GPU (shown in the panel). */
  readonly errors = new Map<string, string>()
  onError: (() => void) | null = null

  private failed(id: string, err: unknown): void {
    this.errors.set(id, `not available on this GPU/driver: ${String(err).slice(0, 120)}`)
    this.onError?.()
  }

  register(scene: Scene, kind: SceneKind, camera?: () => Camera | null): void {
    const baseLight = new Map<string, number>()
    for (const l of scene.lights) baseLight.set(l.name, l.intensity)
    const entry: Registered = { scene, kind, camera, baseLight }
    this.scenes.push(entry)
    if (this.values) this.applyTo(entry, this.values)
  }

  /** Called after a model loads so per-material settings reach it. */
  trackContainer(container: AssetContainer): void {
    this.containers.add(container)
    if (this.values) this.applyMaterials(this.values)
  }

  /** One-shot: apply material settings to a container we do not keep. */
  applyToContainer(container: AssetContainer): void {
    if (!this.values) return
    this.applyContainerMaterials(container, this.values)
  }

  untrackContainer(container: AssetContainer): void {
    this.containers.delete(container)
  }

  apply(values: SettingsValues): void {
    this.values = values
    for (const entry of this.scenes) this.applyTo(entry, values)
    this.applyMaterials(values)
    this.onInvalidate?.()
  }

  /** Shadow casters for the dynamic mode (model self-shadowing). */
  setShadowCasters(scene: Scene, meshes: AbstractMesh[]): void {
    const entry = this.scenes.find((s) => s.scene === scene)
    if (!entry) return
    if (this.values?.shadows !== 'dynamic') {
      entry.shadows?.dispose()
      entry.shadows = undefined
      return
    }
    void this.ensureShadows(entry).then((gen) => {
      if (!gen) return
      gen.getShadowMap()?.renderList?.splice(0)
      for (const m of meshes) {
        gen.addShadowCaster(m, false)
        m.receiveShadows = true
      }
      this.onInvalidate?.()
    })
  }

  private async ensureShadows(entry: Registered): Promise<ShadowGenerator | undefined> {
    if (entry.shadows) return entry.shadows
    const key = entry.scene.lights.find((l): l is DirectionalLight => l instanceof DirectionalLight)
    if (!key) return undefined
    const [{ ShadowGenerator }] = await Promise.all([
      import('@babylonjs/core/Lights/Shadows/shadowGenerator'),
      import('@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent'),
    ])
    if (entry.scene.isDisposed) return undefined
    const size = Number(this.values?.shadowQuality ?? 1024)
    entry.shadows ??= new ShadowGenerator(size, key)
    entry.shadows.useBlurExponentialShadowMap = true
    entry.shadows.forceBackFacesOnly = false
    return entry.shadows
  }

  // --------------------------------------------------------------- scenes

  private applyTo(entry: Registered, v: SettingsValues): void {
    const { scene } = entry

    // ---- image processing (exposure / contrast / tone mapping / vignette).
    // Applies to every PBR + Standard material, so posters and live previews
    // inherit it too — that is why offscreen scenes are registered as well.
    // Only switch image processing ON when something actually deviates from
    // neutral: enabling it adds IMAGEPROCESSING defines to every PBR material,
    // which means new shader permutations and a heavier fragment shader.
    // (Forcing it on by default made poster rendering ~7x slower.)
    const brightness = Number(v.brightness ?? 100)
    const contrast = Number(v.contrast ?? 100)
    const neutral = brightness === 100 && contrast === 100
      && (v.toneMapping ?? 'none') === 'none'
      && !(v.vignette && entry.kind !== 'flat')
    const ip = scene.imageProcessingConfiguration
    if (neutral) {
      ip.isEnabled = false
    } else {
      ip.exposure = brightness / 100
      ip.contrast = contrast / 100
      ip.toneMappingEnabled = v.toneMapping !== 'none'
      ip.toneMappingType = v.toneMapping === 'aces'
        ? ImageProcessingConfiguration.TONEMAPPING_ACES
        : ImageProcessingConfiguration.TONEMAPPING_STANDARD
      ip.vignetteEnabled = !!v.vignette && entry.kind !== 'flat'
      ip.vignetteWeight = 2.5
      ip.isEnabled = true
    }

    // ---- light rig intensity
    const lightScale = Number(v.lightIntensity ?? 100) / 100
    for (const l of scene.lights) {
      const base = entry.baseLight.get(l.name)
      if (base !== undefined) l.intensity = base * lightScale
    }

    if (entry.kind === 'flat' || entry.kind === 'offscreen') return
    const camera = entry.camera?.() ?? scene.activeCamera
    if (!camera) return

    void this.applyPipelines(entry, v, camera)

    // ---- shadow map resolution changes need a rebuild
    if (entry.shadows && Number(v.shadowQuality ?? 1024) !== entry.shadows.mapSize) {
      entry.shadows.dispose()
      entry.shadows = undefined
    }
    if (entry.shadows) {
      entry.shadows.blurScale = 1 + (Number(v.shadowSoftness ?? 40) / 100) * 3
      entry.shadows.useBlurExponentialShadowMap = Number(v.shadowSoftness ?? 40) > 5
    }
  }

  /** Create/update the on-demand pipelines (dynamic imports). */
  private async applyPipelines(entry: Registered, v: SettingsValues, camera: Camera): Promise<void> {
    // ---- main post pipeline (bloom / FXAA / sharpen / MSAA / grain)
    const wantPipeline = !!v.bloom || !!v.fxaa || !!v.sharpen || v.upscaler === 'spatial'
      || !!v.grain || Number(v.msaa) > 1 || !!v.vignette
    if (wantPipeline) {
      if (!entry.pipeline) {
        const { DefaultRenderingPipeline } = await import('@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline')
        if (entry.scene.isDisposed) return
        entry.pipeline ??= new DefaultRenderingPipeline('form0-post', true, entry.scene, [camera])
      }
      const p = entry.pipeline
      p.samples = Math.max(1, Number(v.msaa ?? 1))
      p.fxaaEnabled = !!v.fxaa
      p.bloomEnabled = !!v.bloom
      if (v.bloom) {
        p.bloomWeight = Number(v.bloomStrength ?? 40) / 100
        p.bloomThreshold = Number(v.bloomThreshold ?? 80) / 100
        p.bloomKernel = BLOOM_KERNEL[String(v.bloomQuality ?? 'medium')] ?? 32
        p.bloomScale = 0.5
      }
      p.sharpenEnabled = !!v.sharpen || v.upscaler === 'spatial'
      p.sharpen.edgeAmount = Number(v.sharpness ?? 30) / 100
      p.grainEnabled = !!v.grain
      p.grain.intensity = Number(v.grainIntensity ?? 15) / 2
      p.grain.animated = true
    } else if (entry.pipeline) {
      entry.pipeline.dispose()
      entry.pipeline = undefined
    }

    // ---- temporal AA
    if (v.taa && !entry.taa) {
      try {
        const [{ TAARenderingPipeline }] = await Promise.all([
          import('@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/taaRenderingPipeline'),
          import('@babylonjs/core/Rendering/depthRendererSceneComponent'),
        ])
        if (entry.scene.isDisposed) return
        entry.taa ??= new TAARenderingPipeline('form0-taa', entry.scene, [camera])
        this.errors.delete('taa')
      } catch (err) { entry.taa = undefined; this.failed('taa', err) }
    }
    if (entry.taa) {
      if (!v.taa) { entry.taa.dispose(); entry.taa = undefined } else {
        entry.taa.samples = Math.max(2, Number(v.taaSamples ?? 8))
        entry.taa.isEnabled = true
      }
    }

    // ---- ambient occlusion
    const aoMode = String(v.ao ?? 'off')
    const aoWanted = aoMode !== 'off'
    const aoName = entry.ssao ? (('samples' in entry.ssao) ? 'ssao2' : 'ssao') : null
    if (entry.ssao && (!aoWanted || aoName !== aoMode)) { entry.ssao.dispose(); entry.ssao = undefined }
    if (aoWanted && !entry.ssao) {
      try {
        if (aoMode === 'ssao2') {
          // SSAO2 samples the PrePass/geometry buffer — both are opt-in scene
          // components (deep-import rule), without them the constructor throws
          // "scene.enablePrePassRenderer is not a function".
          const [{ SSAO2RenderingPipeline }] = await Promise.all([
            import('@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline'),
            import('@babylonjs/core/Rendering/prePassRendererSceneComponent'),
            import('@babylonjs/core/Rendering/geometryBufferRendererSceneComponent'),
            import('@babylonjs/core/Rendering/depthRendererSceneComponent'),
          ])
          if (entry.scene.isDisposed) return
          entry.ssao ??= new SSAO2RenderingPipeline('form0-ssao', entry.scene, { ssaoRatio: 0.75, blurRatio: 1 }, [camera])
        } else {
          const [{ SSAORenderingPipeline }] = await Promise.all([
            import('@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssaoRenderingPipeline'),
            import('@babylonjs/core/Rendering/depthRendererSceneComponent'),
          ])
          if (entry.scene.isDisposed) return
          entry.ssao ??= new SSAORenderingPipeline('form0-ssao', entry.scene, { ssaoRatio: 0.75, combineRatio: 1 }, [camera])
        }
        this.errors.delete('ao')
      } catch (err) { entry.ssao = undefined; this.failed('ao', err) }
    }
    if (entry.ssao) {
      entry.ssao.totalStrength = Number(v.aoStrength ?? 100) / 100
      entry.ssao.radius = 1.2
      if ('samples' in entry.ssao) {
        const ssao2 = entry.ssao as SSAO2RenderingPipeline
        ssao2.samples = Math.max(4, Number(v.aoSamples ?? 8))
        ssao2.expensiveBlur = Number(v.aoSamples ?? 8) > 12
      }
    }

    // ---- screen-space reflections (the WebGL stand-in for RT reflections)
    if (v.ssr && !entry.ssr) {
      try {
        const [{ SSRRenderingPipeline }] = await Promise.all([
          import('@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssrRenderingPipeline'),
          import('@babylonjs/core/Rendering/prePassRendererSceneComponent'),
          import('@babylonjs/core/Rendering/geometryBufferRendererSceneComponent'),
        ])
        if (entry.scene.isDisposed) return
        entry.ssr ??= new SSRRenderingPipeline('form0-ssr', entry.scene, [camera], false)
        this.errors.delete('ssr')
      } catch (err) { entry.ssr = undefined; this.failed('ssr', err) }
    }
    if (entry.ssr && !v.ssr) { entry.ssr.dispose(); entry.ssr = undefined }
    this.onInvalidate?.()
  }

  // ------------------------------------------------------------ materials

  private applyMaterials(v: SettingsValues): void {
    for (const container of this.containers) this.applyContainerMaterials(container, v)
  }

  private applyContainerMaterials(container: AssetContainer, v: SettingsValues): void {
    const unlit = !v.pbr
    const specular = !!v.pbrSpecular
    const reflections = !!v.pbrReflections
    const aniso = Math.max(1, Number(v.anisotropy ?? 4))
    {
      for (const mat of container.materials) {
        if (mat instanceof PBRMaterial) {
          mat.unlit = unlit
          mat.disableLighting = unlit
          mat.specularIntensity = specular ? 1 : 0
          mat.environmentIntensity = reflections ? 1 : 0
          mat.reflectionTexture = reflections ? mat.reflectionTexture : null
        } else if (mat instanceof StandardMaterial) {
          mat.disableLighting = unlit
          mat.specularPower = specular ? 64 : 0
        }
      }
      for (const tex of container.textures) {
        if (tex instanceof Texture) tex.anisotropicFilteringLevel = aniso
      }
    }
  }

  dispose(): void {
    for (const e of this.scenes) {
      e.pipeline?.dispose(); e.ssao?.dispose(); e.ssr?.dispose(); e.taa?.dispose(); e.shadows?.dispose()
    }
    this.scenes = []
  }
}

export const graphics = new Graphics()
