import { Engine } from '@babylonjs/core/Engines/engine'
import { Effect } from '@babylonjs/core/Materials/effect'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color4 } from '@babylonjs/core/Maths/math.color'

/**
 * One canvas, one Engine, one WebGL2 context for the whole session (03 §1).
 * Scenes are swapped via setActiveScene, never re-created per view.
 *
 * PERF (kestrel): the render loop is DEMAND-DRIVEN. A frame is drawn only if
 *  - something recently invalidated the picture (`kick()` — input, scroll,
 *    content arriving, route change), or
 *  - a registered animation source reports motion (live preview slots,
 *    playing model animation, spinners, scroll inertia).
 * Pure animation (no interaction) is capped at ANIM_FPS; interaction renders
 * uncapped. A static board/viewer/thread renders ZERO frames — previously
 * every scene re-rendered at full RAF rate forever, which pinned weak GPUs
 * at 100% for a still image.
 *
 * Adaptive resolution (spec PERF "adaptive degrade"): sustained slow frames
 * step the hardware scaling down (fewer pixels), sustained fast frames step
 * it back up to the device pixel ratio. Bounds: [0.7, devicePixelRatio<=2].
 */
// Pixel budget for the drawing buffer: devicePixelRatio alone means a 4K
// screen at DPR 2 rasterises ~33 Mpx on the FIRST frames, before the adaptive
// controller below has any measurements to react to.
const MAX_PIXELS = 2_600_000
const ANIM_FPS = 30
const KICK_MS = 300
const SLOW_MS = 45 // degrade when EMA exceeds this
const FAST_MS = 18 // restore when EMA stays below this
const RESTORE_FRAMES = 150

/** One-time context-creation options (settings with a `deferred` flag). */
export interface FormEngineOptions {
  /** WebGL power hint read from settings BEFORE the engine is created. */
  powerPreference?: 'default' | 'high-performance' | 'low-power'
}

/** Where the drawing-buffer size comes from (settings: Display & resolution). */
export interface ResolutionPolicy {
  mode: 'auto' | 'scale' | 'manual'
  /** percent of the device ratio, `scale` mode */
  scale: number
  /** snap the scale to a power of two */
  pow2: boolean
  width: number
  height: number
  /** derive height from the window aspect, `manual` mode */
  aspectLock: boolean
}

// Compiled GL programs are cached per engine by "vertex+fragment@defines", but
// `Effect.dispose()` DELETES the cache entry when the last material using it
// goes away. We dispose an AssetContainer after every poster render, every
// preview swap and every viewer navigation, so identical models recompiled
// their shaders every single time (measured with scripts/shaders.mjs: opening
// the same model three times = three compiles, zero cache hits).
// PersistentMode keeps the compiled programs alive for the session; the cache
// is bounded by the number of distinct define sets, not by models.
Effect.PersistentMode = true

export class FormEngine {
  readonly engine: Engine
  readonly uiScene: Scene
  private active: Scene
  private raf = 0
  private lost = false

  // demand-driven rendering
  private dirtyUntil = 0
  private animSources = new Set<() => boolean>()
  private lastRenderAt = 0
  // adaptive resolution
  private targetRatio: number
  private ratio: number
  private emaMs = 16
  private fastStreak = 0
  // perf introspection (tests / debugging)
  private renderCount = 0
  private lastMs = 0
  // settings-driven policy
  private policy: ResolutionPolicy = { mode: 'auto', scale: 100, pow2: false, width: 1920, height: 1080, aspectLock: true }
  private isMobile = /Mobi|Android/i.test(navigator.userAgent)
  private fpsLimit = 0            // 0 = uncapped
  private idleThrottle = true     // false = always draw (debugging)
  private adaptive = true

  private constructor(canvas: HTMLCanvasElement, engine: Engine) {
    this.engine = engine
    // Render at the DEVICE pixel ratio (capped). The old code pinned this to
    // 1.0 on phones / 1.25 on desktop, so on any HiDPI screen the canvas was
    // upscaled by the browser and everything Babylon drew — cards, reply
    // badges, thread nodes — came out soft.
    const isMobile = /Mobi|Android/i.test(navigator.userAgent)
    this.targetRatio = FormEngine.budgetedRatio(canvas, isMobile)
    this.ratio = this.targetRatio
    engine.setHardwareScalingLevel(1 / this.ratio)
    engine.enableOfflineSupport = false
    engine.setDepthFunctionToLessOrEqual()

    this.uiScene = new Scene(engine)
    this.uiScene.detachControl()
    this.uiScene.autoClear = false
    this.uiScene.clearColor = Color4.FromHexString('#0B0B0CFF')
    const cam = new ArcRotateCamera('ui-cam', Math.PI / 2, Math.PI / 2, 8, Vector3.Zero(), this.uiScene)
    cam.mode = ArcRotateCamera.ORTHOGRAPHIC_CAMERA
    cam.detachControl()
    new HemisphericLight('ui-light', new Vector3(0, 1, 0), this.uiScene)
    this.active = this.uiScene

    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true })
    canvas.addEventListener('webglcontextrestored', () => { this.lost = false; this.kick() })

    // Any user input may change the picture: grant a short uncapped render
    // window. Passive listeners; kick() is just two number writes.
    const kick = () => this.kick()
    for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'touchstart', 'touchmove'] as const) {
      window.addEventListener(ev, kick, { passive: true, capture: true })
    }
    window.addEventListener('resize', kick, { passive: true })
    document.addEventListener('visibilitychange', kick)
  }

  static create(canvas: HTMLCanvasElement, opts: FormEngineOptions = {}): FormEngine {
    // 'default' maps to undefined = let the browser pick (the honest WebGL
    // reading of that preference); an omitted option keeps the historic
    // 'high-performance' boot behaviour.
    const powerPreference: GPUPowerPreference | undefined =
      opts.powerPreference === 'default' ? undefined
        : opts.powerPreference === 'low-power' ? 'low-power'
          : 'high-performance'
    const engine = new Engine(
      canvas, true,
      {
        antialias: true,
        stencil: false,
        depth: true,
        alpha: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference,
        audioEngine: false,
        doNotHandleContextLost: false,
      },
      false,
    )
    const form = new FormEngine(canvas, engine)
    form.start()
    return form
  }

  get activeScene(): Scene { return this.active }

  /**
   * devicePixelRatio, clamped so the drawing buffer stays inside MAX_PIXELS.
   * The adaptive controller then moves within [0.7, targetRatio].
   */
  static budgetedRatio(canvas: HTMLCanvasElement, isMobile: boolean): number {
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, isMobile ? 2 : 2))
    const cssW = canvas.clientWidth || window.innerWidth || 1280
    const cssH = canvas.clientHeight || window.innerHeight || 800
    const wanted = cssW * cssH * dpr * dpr
    return wanted > MAX_PIXELS ? Math.max(0.75, dpr * Math.sqrt(MAX_PIXELS / wanted)) : dpr
  }

  /**
   * Alias for `kick()` kept because a lot of call sites read better as "this
   * changed, please redraw". Same primitive, no second mechanism.
   */
  invalidate(_frames = 2): void { this.kick() }

  /**
   * Resolution policy from the settings panel.
   *  auto   — device pixel ratio, clamped by the pixel budget, adaptive.
   *  scale  — a percentage of that (optionally snapped to a power of two).
   *  manual — an exact drawing-buffer size in pixels; CSS still stretches the
   *           canvas to the window, so this is a true render resolution.
   */
  setResolutionPolicy(policy: Partial<ResolutionPolicy>): void {
    this.policy = { ...this.policy, ...policy }
    this.applyResolution()
    this.kick()
  }

  setFpsLimit(fps: number): void { this.fpsLimit = Math.max(0, fps) }
  setIdleThrottle(on: boolean): void { this.idleThrottle = on; this.kick() }
  setAdaptiveResolution(on: boolean): void {
    this.adaptive = on
    if (!on && this.ratio !== this.targetRatio) {
      this.ratio = this.targetRatio
      this.engine.setHardwareScalingLevel(1 / this.ratio)
    }
    this.kick()
  }

  /** Current drawing-buffer size, for the settings readout. */
  get bufferSize(): { width: number; height: number; ratio: number } {
    return { width: this.engine.getRenderWidth(), height: this.engine.getRenderHeight(), ratio: +this.ratio.toFixed(2) }
  }

  private applyResolution(): void {
    const canvas = this.engine.getRenderingCanvas()
    if (!canvas) return
    const p = this.policy
    if (p.mode === 'manual') {
      const w = Math.max(2, Math.round(p.width))
      const aspect = (canvas.clientHeight || window.innerHeight || 1) / (canvas.clientWidth || window.innerWidth || 1)
      const h = Math.max(2, Math.round(p.aspectLock ? w * aspect : p.height))
      this.engine.setSize(w, h)
      this.ratio = 1
      this.targetRatio = 1
      return
    }
    const budget = FormEngine.budgetedRatio(canvas, this.isMobile)
    let ratio = budget
    if (p.mode === 'scale') {
      const factor = Math.max(0.05, p.scale / 100)
      ratio = p.pow2
        ? budget * Math.pow(2, Math.round(Math.log2(factor)))
        : budget * factor
    }
    this.targetRatio = Math.max(0.1, ratio)
    this.ratio = this.targetRatio
    this.engine.setHardwareScalingLevel(1 / this.ratio)
    this.engine.resize()
  }

  /** Invalidate the picture: render (uncapped) for the next `ms` window. */
  kick(ms = KICK_MS): void {
    const until = performance.now() + ms
    if (until > this.dirtyUntil) this.dirtyUntil = until
  }

  /**
   * Register an animation source. While `isAnimating()` returns true and its
   * scene is active, frames keep rendering (capped at ANIM_FPS). Returns an
   * unsubscribe function.
   */
  addAnimationSource(isAnimating: () => boolean): () => void {
    this.animSources.add(isAnimating)
    return () => this.animSources.delete(isAnimating)
  }

  setActiveScene(scene: Scene): void {
    if (this.active === scene) return
    // onPointerObservable only fires after Scene.attachControl() — without
    // this, nothing on the board is clickable.
    this.active.detachControl()
    this.active = scene
    // NOTE: do not touch scene.clearColor here — the settings panel controls
    // the background and each scene owns its clearColor.
    scene.autoClear = true
    scene.attachControl()
    this.kick()
  }

  resize(): void {
    if (this.policy.mode === 'manual') this.applyResolution()
    else { this.engine.resize(); this.kick() }
    this.kick()
  }

  /** Perf introspection for tests: renders so far, last frame ms, EMA, scale. */
  perfStats(): { renders: number; lastMs: number; emaMs: number; ratio: number; targetRatio: number } {
    return {
      renders: this.renderCount,
      lastMs: +this.lastMs.toFixed(2),
      emaMs: +this.emaMs.toFixed(2),
      ratio: +this.ratio.toFixed(2),
      targetRatio: this.targetRatio,
    }
  }

  private wantsFrame(now: number): boolean {
    if (this.fpsLimit > 0 && now - this.lastRenderAt < 1000 / this.fpsLimit - 0.5) return false
    if (!this.idleThrottle) return true    // debugging: draw every frame
    if (now < this.dirtyUntil) return true // interaction: uncapped
    let animating = false
    for (const src of this.animSources) {
      if (src()) { animating = true; break }
    }
    if (!animating) return false
    return now - this.lastRenderAt >= 1000 / ANIM_FPS - 1 // animation: capped
  }

  /** Sustained slow frames -> fewer pixels; sustained fast frames -> restore. */
  private adaptResolution(): void {
    if (!this.adaptive || this.policy.mode === 'manual') return
    if (this.emaMs > SLOW_MS && this.ratio > 0.7) {
      this.ratio = Math.max(0.7, this.ratio * 0.85)
      this.engine.setHardwareScalingLevel(1 / this.ratio)
      this.emaMs = SLOW_MS * 0.8 // give the new scale time to prove itself
      this.fastStreak = 0
      this.engine.onResizeObservable.notifyObservers(this.engine)
    } else if (this.emaMs < FAST_MS && this.ratio < this.targetRatio) {
      if (++this.fastStreak >= RESTORE_FRAMES) {
        this.ratio = Math.min(this.targetRatio, this.ratio / 0.85)
        this.engine.setHardwareScalingLevel(1 / this.ratio)
        this.fastStreak = 0
        this.engine.onResizeObservable.notifyObservers(this.engine)
      }
    } else {
      this.fastStreak = 0
    }
  }

  private start(): void {
    const loop = () => {
      this.raf = requestAnimationFrame(loop)
      if (this.lost || document.hidden) return
      const now = performance.now()
      if (!this.wantsFrame(now)) return
      // Frame cost = time between CONSECUTIVE frames while we are rendering
      // continuously, not the duration of the render() call. render() only
      // submits work; measuring it returns ~0.5 ms even when the GPU needs
      // 150 ms, so the adaptive controller could never trigger.
      const gap = now - this.lastRenderAt
      this.lastRenderAt = now
      this.active.render()
      const submitMs = performance.now() - now
      this.lastMs = submitMs
      if (gap < 250) this.emaMs = this.emaMs * 0.9 + Math.min(gap, submitMs > gap ? submitMs : gap) * 0.1
      this.renderCount++
      this.adaptResolution()
    }
    this.raf = requestAnimationFrame(loop)
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
    this.uiScene.dispose()
    this.engine.dispose()
  }
}
