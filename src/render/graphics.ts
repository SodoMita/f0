// Heavy post-processing pipelines are loaded ON DEMAND: bundling SSAO2 + SSR +
// TAA + the default pipeline statically added ~380 kB to first paint for
// features most sessions never switch on. The standalone build inlines these
// chunks (rollupOptions.inlineDynamicImports), so file:// still works.
import type { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline'
import type { SSAO2RenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline'
import type { SSAORenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssaoRenderingPipeline'
import type { SSRRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssrRenderingPipeline'
import type { TAARenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/taaRenderingPipeline'
import type { MotionBlurPostProcess } from '@babylonjs/core/PostProcesses/motionBlurPostProcess'
import type { ScreenSpaceCurvaturePostProcess } from '@babylonjs/core/PostProcesses/screenSpaceCurvaturePostProcess'
import type { GlowLayer } from '@babylonjs/core/Layers/glowLayer'
import type { CascadedShadowGenerator } from '@babylonjs/core/Lights/Shadows/cascadedShadowGenerator'
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration'
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import { Color3 } from '@babylonjs/core/Maths/math.color'
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
  motionBlur?: MotionBlurPostProcess
  curvature?: ScreenSpaceCurvaturePostProcess
  glow?: GlowLayer
  shadows?: ShadowGenerator | CascadedShadowGenerator
  /** mode|resolution|filter the current generator was built for (rebuild key) */
  shadowKey?: string
  shadowIsCascaded?: boolean
  /** casters remembered so a rebuilt generator does not lose its render list */
  shadowCasters?: AbstractMesh[]
  /** helper meshes (backdrops, contact shadows) that must never glow */
  excludeFromGlow?: () => Mesh[]
}

const BLOOM_KERNEL: Record<string, number> = { low: 16, medium: 32, high: 64, ultra: 128 }

/** Settings value -> Babylon tone mapper. 'none' is handled via toneMappingEnabled. */
const TONE_MAPPING_TYPES: Record<string, number> = {
  standard: ImageProcessingConfiguration.TONEMAPPING_STANDARD,
  aces: ImageProcessingConfiguration.TONEMAPPING_ACES,
  pbrNeutral: ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL,
}

/** Settings value -> DepthOfFieldEffectBlurLevel (Low=0, Medium=1, High=2). */
const DOF_BLUR: Record<string, number> = { low: 0, medium: 1, high: 2 }

/** Settings value -> Scene.FOGMODE_* (NONE=0, EXP=1, EXP2=2, LINEAR=3). */
const FOG_MODES: Record<string, number> = { off: 0, exp: 1, exp2: 2, linear: 3 }

const HEX_COLOR = /^#[0-9a-f]{6}$/i

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

  register(scene: Scene, kind: SceneKind, camera?: () => Camera | null, opts?: { excludeFromGlow?: () => Mesh[] }): void {
    const baseLight = new Map<string, number>()
    for (const l of scene.lights) baseLight.set(l.name, l.intensity)
    const entry: Registered = { scene, kind, camera, baseLight, excludeFromGlow: opts?.excludeFromGlow }
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

  /** Shadow casters for the dynamic/cascaded modes (model self-shadowing). */
  setShadowCasters(scene: Scene, meshes: AbstractMesh[]): void {
    const entry = this.scenes.find((s) => s.scene === scene)
    if (!entry) return
    const mode = String(this.values?.shadows ?? 'contact')
    if (mode !== 'dynamic' && mode !== 'cascaded') {
      entry.shadowCasters = undefined
      if (entry.shadows) {
        entry.shadows.dispose()
        entry.shadows = undefined
      }
      return
    }
    entry.shadowCasters = meshes
    void this.rebuildShadows(entry)
  }

  /**
   * Identity of the generator the current settings describe. The filter is
   * part of the key for the plain generator only — a CSM filters itself and
   * must not rebuild when the (then inert) filter select moves.
   */
  private shadowKeyFrom(v: SettingsValues): string {
    const mode = String(v.shadows ?? 'contact')
    const size = Number(v.shadowQuality ?? 1024)
    return mode === 'cascaded' ? `${mode}|${size}` : `${mode}|${size}|${String(v.shadowFilter ?? 'blurESM')}`
  }

  /** (Re)build the generator and restore the remembered render list. */
  private async rebuildShadows(entry: Registered): Promise<void> {
    const gen = await this.ensureShadows(entry)
    if (!gen) return
    gen.getShadowMap()?.renderList?.splice(0)
    entry.shadowCasters = (entry.shadowCasters ?? []).filter((m) => !m.isDisposed())
    for (const m of entry.shadowCasters) {
      gen.addShadowCaster(m, false)
      m.receiveShadows = true
    }
    this.onInvalidate?.()
  }

  private async ensureShadows(entry: Registered): Promise<ShadowGenerator | CascadedShadowGenerator | undefined> {
    if (entry.shadows) return entry.shadows
    const mode = String(this.values?.shadows ?? 'contact')
    if (mode !== 'dynamic' && mode !== 'cascaded') return undefined
    const key = entry.scene.lights.find((l): l is DirectionalLight => l instanceof DirectionalLight)
    if (!key) return undefined
    const size = Number(this.values?.shadowQuality ?? 1024)
    entry.shadowKey = this.shadowKeyFrom(this.values ?? {})
    try {
      if (mode === 'cascaded') {
        const [{ CascadedShadowGenerator }] = await Promise.all([
          import('@babylonjs/core/Lights/Shadows/cascadedShadowGenerator'),
          import('@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent'),
        ])
        if (entry.scene.isDisposed) return undefined
        // Bail with a human-readable reason instead of Babylon's internal
        // constructor edge on unsupported engines — it lands in the panel's
        // "why is this greyed out" line via Graphics.errors.
        if (!CascadedShadowGenerator.IsSupported) throw new Error('cascaded shadow maps need WebGL2')
        const csm = new CascadedShadowGenerator(size, key)
        csm.numCascades = 4
        csm.stabilizeCascades = true
        csm.autoCalcDepthBounds = true
        entry.shadows ??= csm
        entry.shadowIsCascaded = true
      } else {
        const [{ ShadowGenerator }] = await Promise.all([
          import('@babylonjs/core/Lights/Shadows/shadowGenerator'),
          import('@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent'),
        ])
        if (entry.scene.isDisposed) return undefined
        const gen = new ShadowGenerator(size, key)
        gen.forceBackFacesOnly = false
        entry.shadows ??= gen
        entry.shadowIsCascaded = false
      }
      this.applyShadowParams(entry)
      this.errors.delete('shadows')
      return entry.shadows
    } catch (err) {
      entry.shadows = undefined
      this.failed('shadows', err)
      return undefined
    }
  }

  /** Bias + filter + softness on the CURRENT generator (apply idempotently). */
  private applyShadowParams(entry: Registered): void {
    const gen = entry.shadows
    const v = this.values
    if (!gen || !v) return
    gen.bias = Number(v.shadowBias ?? 5) * 1e-5
    gen.normalBias = Number(v.shadowNormalBias ?? 10) * 1e-3
    if (entry.shadowIsCascaded) return // CSM filters itself (PCF + cascade blend)
    const sg = gen as ShadowGenerator
    const filter = String(v.shadowFilter ?? 'blurESM')
    const softness = Number(v.shadowSoftness ?? 40)
    // The use*ShadowMap setters no-op on equal values, so assigning all four
    // only recompiles the shader twice when the filter actually changes.
    sg.useExponentialShadowMap = filter === 'esm'
    sg.useBlurExponentialShadowMap = filter === 'blurESM'
    sg.usePercentageCloserFiltering = filter === 'pcf'
    sg.useContactHardeningShadow = filter === 'pcss'
    if (filter === 'blurESM') sg.blurScale = 1 + (softness / 100) * 3
    else if (filter === 'pcss') sg.contactHardeningLightSizeUVRatio = 0.01 + (softness / 100) * 0.49
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
      && !v.dithering
      && !(v.vignette && entry.kind !== 'flat')
    const ip = scene.imageProcessingConfiguration
    if (neutral) {
      ip.isEnabled = false
    } else {
      ip.exposure = brightness / 100
      ip.contrast = contrast / 100
      ip.toneMappingEnabled = v.toneMapping !== 'none'
      ip.toneMappingType = TONE_MAPPING_TYPES[String(v.toneMapping)] ?? ImageProcessingConfiguration.TONEMAPPING_STANDARD
      ip.ditheringEnabled = !!v.dithering
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

    // ---- fog is camera-distance atmosphere: viewer & studio only, never
    // cards/posters (a card render is framed to FILL its camera, so any fog
    // would just wash the whole poster out).
    const fogMode = FOG_MODES[String(v.fog ?? 'off')] ?? 0
    scene.fogMode = fogMode
    if (fogMode === 3) {
      const start = Number(v.fogStart ?? 2)
      scene.fogStart = start
      scene.fogEnd = Math.max(start + 0.01, Number(v.fogEnd ?? 40))
    } else if (fogMode !== 0) {
      scene.fogDensity = Number(v.fogDensity ?? 40) / 1000
    }
    if (fogMode !== 0) {
      const hex = String(v.fogColor ?? '#0B0B0C')
      scene.fogColor = Color3.FromHexString(HEX_COLOR.test(hex) ? hex : '#0B0B0C')
    }

    void this.applyPipelines(entry, v, camera)

    // ---- shadow mode / resolution / filter changes need a generator rebuild
    const shadowMode = String(v.shadows ?? 'contact')
    const shadowKey = this.shadowKeyFrom(v)
    if (entry.shadows && entry.shadowKey !== shadowKey) {
      entry.shadows.dispose()
      entry.shadows = undefined
      // rebuildShadows restores the remembered casters, so switching modes
      // no longer drops shadows until a model reload forces setShadowCasters.
      if ((shadowMode === 'dynamic' || shadowMode === 'cascaded') && entry.shadowCasters) void this.rebuildShadows(entry)
    } else if (entry.shadows) {
      this.applyShadowParams(entry)
    }
  }

  /** Create/update the on-demand pipelines (dynamic imports). */
  private async applyPipelines(entry: Registered, v: SettingsValues, camera: Camera): Promise<void> {
    // ---- main post pipeline (bloom / FXAA / sharpen / MSAA / grain / DoF / CA)
    const wantPipeline = !!v.bloom || !!v.fxaa || !!v.sharpen || v.upscaler === 'spatial'
      || !!v.grain || Number(v.msaa) > 1 || !!v.vignette || !!v.dof || !!v.chromaticAberration
    if (wantPipeline) {
      if (!entry.pipeline) {
        // depthRendererSceneComponent: depth of field samples the depth buffer,
        // and DepthOfFieldEffect lazily enables a depth renderer on its scene.
        const [{ DefaultRenderingPipeline }] = await Promise.all([
          import('@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline'),
          import('@babylonjs/core/Rendering/depthRendererSceneComponent'),
        ])
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
      p.depthOfFieldEnabled = !!v.dof
      if (v.dof) {
        p.depthOfField.fStop = Number(v.dofFStop ?? 1.4)
        p.depthOfField.focusDistance = Number(v.dofFocus ?? 2000)
        p.depthOfFieldBlurLevel = DOF_BLUR[String(v.dofQuality ?? 'medium')] ?? 1
      }
      p.chromaticAberrationEnabled = !!v.chromaticAberration
      if (v.chromaticAberration) p.chromaticAberration.aberrationAmount = Number(v.caAmount ?? 30)
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

    // ---- emissive glow layer (per-material emitters, not a screen threshold)
    if (v.glow && !entry.glow) {
      try {
        const [{ GlowLayer }] = await Promise.all([
          import('@babylonjs/core/Layers/glowLayer'),
          import('@babylonjs/core/Layers/effectLayerSceneComponent'),
        ])
        if (entry.scene.isDisposed) return
        entry.glow ??= new GlowLayer('form0-glow', entry.scene)
        // Helper planes (backdrop, contact shadow) would glow as flat cards.
        for (const m of entry.excludeFromGlow?.() ?? []) entry.glow.addExcludedMesh(m)
        this.errors.delete('glow')
      } catch (err) { entry.glow = undefined; this.failed('glow', err) }
    }
    if (entry.glow) {
      if (!v.glow) { entry.glow.dispose(); entry.glow = undefined } else {
        entry.glow.intensity = Number(v.glowIntensity ?? 60) / 100
      }
    }

    // ---- motion blur (camera/geometry velocity — needs the geometry buffer)
    if (v.motionBlur && !entry.motionBlur) {
      try {
        const [{ MotionBlurPostProcess }] = await Promise.all([
          import('@babylonjs/core/PostProcesses/motionBlurPostProcess'),
          import('@babylonjs/core/Rendering/geometryBufferRendererSceneComponent'),
          import('@babylonjs/core/Rendering/prePassRendererSceneComponent'),
          import('@babylonjs/core/Rendering/depthRendererSceneComponent'),
        ])
        if (entry.scene.isDisposed) return
        entry.motionBlur ??= new MotionBlurPostProcess('form0-mb', entry.scene, 1.0, camera)
        this.errors.delete('motionBlur')
      } catch (err) { entry.motionBlur = undefined; this.failed('motionBlur', err) }
    }
    if (entry.motionBlur) {
      if (!v.motionBlur) { entry.motionBlur.dispose(); entry.motionBlur = undefined } else {
        entry.motionBlur.motionStrength = Number(v.motionBlurStrength ?? 100) / 100
      }
    }

    // ---- screen-space curvature (ridge/valley inspection view; normals buffer)
    if (v.curvature && !entry.curvature) {
      try {
        const [{ ScreenSpaceCurvaturePostProcess }] = await Promise.all([
          import('@babylonjs/core/PostProcesses/screenSpaceCurvaturePostProcess'),
          import('@babylonjs/core/Rendering/geometryBufferRendererSceneComponent'),
          import('@babylonjs/core/Rendering/prePassRendererSceneComponent'),
        ])
        if (entry.scene.isDisposed) return
        entry.curvature ??= new ScreenSpaceCurvaturePostProcess('form0-curvature', entry.scene, 1.0, camera)
        this.errors.delete('curvature')
      } catch (err) { entry.curvature = undefined; this.failed('curvature', err) }
    }
    if (entry.curvature) {
      if (!v.curvature) { entry.curvature.dispose(); entry.curvature = undefined } else {
        const strength = 2 * (Number(v.curvatureStrength ?? 100) / 100)
        entry.curvature.ridge = strength
        entry.curvature.valley = strength
      }
    }
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
      e.pipeline?.dispose(); e.ssao?.dispose(); e.ssr?.dispose(); e.taa?.dispose()
      e.motionBlur?.dispose(); e.curvature?.dispose(); e.glow?.dispose(); e.shadows?.dispose()
    }
    this.scenes = []
  }
}

export const graphics = new Graphics()
