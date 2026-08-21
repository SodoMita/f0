import type { FormEngine } from '../core/engine'
import type { Board } from '../board/board'
import type { Viewer } from '../viewer/viewer'
import type { ThreadView } from '../board/threadView'
import type { Studio } from '../studio/studio'
import type { AssetCache } from '../core/assets'
import { graphics } from '../render/graphics'
import { mixer } from '../audio/mixer'
import { setLimitOverrides } from '../model/limits'
import type { SettingsValues } from './schema'

export interface Wiring {
  engine: FormEngine
  board: Board
  viewer: Viewer
  threadView: ThreadView
  studio: Studio
  assets: AssetCache
  applyBackground: (hex: string) => void
}

/**
 * The one place that turns settings values into engine/scene/audio state.
 * `changed` lets us skip expensive work when a single slider moved.
 */
export function applySettings(w: Wiring, v: SettingsValues, changed: string[] | null = null): void {
  const touched = (...ids: string[]) => !changed || ids.some((id) => changed.includes(id))

  // ---------------------------------------------------------- display
  if (touched('resolutionMode', 'renderScale', 'renderScalePow2', 'resolutionWidth', 'resolutionHeight', 'aspectLock', 'upscaler', 'upscalerMode')) {
    const upscale = v.upscaler === 'spatial'
      ? ({ ultraQuality: 77, quality: 67, balanced: 59, performance: 50, ultraPerformance: 33 } as Record<string, number>)[String(v.upscalerMode ?? 'quality')] ?? 67
      : 100
    const mode = String(v.resolutionMode ?? 'auto') as 'auto' | 'scale' | 'manual'
    w.engine.setResolutionPolicy({
      // the spatial upscaler IS a render-scale reduction plus sharpening
      mode: upscale !== 100 && mode === 'auto' ? 'scale' : mode,
      scale: upscale !== 100 ? upscale : Number(v.renderScale ?? 100),
      pow2: !!v.renderScalePow2,
      width: Number(v.resolutionWidth ?? 1920),
      height: Number(v.resolutionHeight ?? 1080),
      aspectLock: !!v.aspectLock,
    })
    // setResolutionPolicy() fires the engine's viewport notification, which is
    // what re-measures board / thread / viewer / studio (AMENDMENT 79). It
    // used to be re-measured here, which missed the viewer and the studio.
  }
  if (touched('displayMode')) {
    const wantFull = v.displayMode === 'fullscreen'
    const isFull = !!document.fullscreenElement
    if (wantFull && !isFull) void document.documentElement.requestFullscreen?.().catch(() => undefined)
    if (!wantFull && isFull) void document.exitFullscreen?.().catch(() => undefined)
  }

  // -------------------------------------------------------- framerate
  if (touched('fpsUncapped', 'fpsLimit')) {
    w.engine.setFpsLimit(v.fpsUncapped ? 0 : Number(v.fpsLimit ?? 60))
  }
  if (touched('idleThrottle')) w.engine.setIdleThrottle(!!v.idleThrottle)
  if (touched('adaptiveResolution')) w.engine.setAdaptiveResolution(!!v.adaptiveResolution)

  // --------------------------------------------- graphics pipelines
  graphics.apply(v)

  // the model outline is viewer-side (it owns the HighlightLayer)
  if (touched('highlight', 'highlightColor')) {
    void w.viewer.setHighlight(!!v.highlight, String(v.highlightColor ?? '#FF5C35'))
  }

  // ---------------------------------------------------------- limits
  if (touched('textureQuality')) {
    const cap = Number(v.textureQuality ?? 0)
    setLimitOverrides({ textureSide: cap > 0 ? cap : undefined })
  }

  // --------------------------------------------------------- shadows
  if (touched('shadows', 'contactShadowStrength')) {
    const strength = v.shadows === 'off' ? 0 : Number(v.contactShadowStrength ?? 55) / 100
    w.board.setContactShadows(strength)
    w.viewer.setContactShadows(strength)
  }

  // ---------------------------------------------------------- camera
  if (touched('fov', 'nearClip', 'farClip', 'cameraInertia', 'invertY')) {
    w.viewer.setCameraSettings({
      fov: Number(v.fov ?? 46),
      near: Number(v.nearClip ?? 0.01),
      far: Number(v.farClip ?? 2000),
      inertia: Number(v.cameraInertia ?? 70) / 100,
      invertY: !!v.invertY,
    })
  }

  // ---------------------------------------------------------- memory
  if (touched('modelRamBudget', 'textureBudget')) {
    w.assets.setBudgets({ modelRamMiB: Number(v.modelRamBudget ?? 48), textures: Number(v.textureBudget ?? 32) })
  }
  if (touched('livePreviews')) {
    // ONE budget, two viewports: board and thread each cap at the setting,
    // but only the ACTIVE route renders, its slots are created lazily and
    // the thread pool prunes its RTTs on detach — so the effective cost is
    // a single pool's worth, not two permanent allocations.
    const slots = Number(v.livePreviews ?? 5)
    w.board.setLivePreviewSlots(slots)
    // the thread map gets a small share of the same budget
    w.threadView.setLivePreviewSlots(Math.max(0, Math.min(3, slots)))
  }
  if (touched('previewWidth')) {
    // Width is the only knob the user sees; height is locked to the poster
    // aspect (5:8 = 0.625) so previews never stretch the model. The flag is
    // `deferred` — newly-rendered slots pick it up; existing ones are
    // resized in place by setPreviewSize.
    const width = Math.max(32, Math.round(Number(v.previewWidth ?? 448)))
    w.board.setPreviewSize(width)
    w.threadView.setPreviewSize(width)
  }
  if (touched('prefetch', 'keepOffscreen')) {
    w.board.setPrefetch(v.keepOffscreen ? 4 : Number(v.prefetch ?? 100) / 100)
  }

  // ----------------------------------------------------------- audio
  mixer.apply(v)

  // ------------------------------------------------------- interface
  if (touched('background')) w.applyBackground(String(v.background ?? '#0B0B0C'))
  if (touched('inertia')) w.board.setInertia(Number(v.inertia ?? 70) / 100)
  if (touched('autoplayAnimations')) {
    // One preference, two viewports: board cards and thread nodes both start
    // paused when autoplay is off (user-started plays keep playing).
    w.board.setAutoplay(!!v.autoplayAnimations)
    w.threadView.setAutoplay(!!v.autoplayAnimations)
  }
  if (touched('direct3D')) {
    // One toggle, two viewports: board cards and thread nodes both swap
    // poster/RTT rendering for real 3D models in the visible scene.
    w.board.setDirect3D(!!v.direct3D)
    w.threadView.setDirect3D(!!v.direct3D)
  }
  if (touched('reduceMotion')) {
    document.body.classList.toggle('reduce-motion', !!v.reduceMotion)
  }
  if (touched('showFps')) document.body.classList.toggle('show-perf', !!v.showFps)

  // ----------------------------------------------------------- studio
  // Selection outline: live-applied, persisted through the normal schema
  // pipeline so a quality preset can carry its own colour + thickness.
  if (touched('selectionHighlight', 'selectionHighlightColor', 'selectionHighlightThickness')) {
    w.studio.setSelectionHighlight(
      !!v.selectionHighlight,
      String(v.selectionHighlightColor ?? '#FFFFFF'),
      Number(v.selectionHighlightThickness ?? 2),
    )
  }

  w.engine.kick()
}
