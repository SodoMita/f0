import { Engine } from '@babylonjs/core/Engines/engine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color4 } from '@babylonjs/core/Maths/math.color'

/** A view tells the engine whether it still needs frames. */
export type ActivityProbe = () => boolean

// Render budget. The board is a mostly-static document: drawing it 60x a
// second burns battery for nothing. We draw on demand and keep a slow
// heartbeat as a self-healing net for any state change nobody flagged.
const IDLE_HEARTBEAT_MS = 400
// Pixel budget for the drawing buffer. devicePixelRatio alone means a 4K
// screen at DPR 2 renders 33 Mpx; that is the single biggest fill-rate cost.
const MAX_PIXELS = 2_600_000

/**
 * One canvas, one Engine, one WebGL2 context for the whole session (03 §1).
 * Scenes are swapped via setActiveScene, never re-created per view.
 */
export class FormEngine {
  readonly engine: Engine
  readonly uiScene: Scene
  private active: Scene
  private raf = 0
  private lost = false
  private activity: ActivityProbe | null = null
  private dirtyFrames = 3
  private lastRenderAt = 0
  private renderedFrames = 0
  private skippedFrames = 0

  private constructor(canvas: HTMLCanvasElement, engine: Engine) {
    this.engine = engine
    engine.enableOfflineSupport = false
    engine.setDepthFunctionToLessOrEqual()
    this.applyScaling()

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
    canvas.addEventListener('webglcontextrestored', () => { this.lost = false; this.invalidate(4) })
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.invalidate(3) })
  }

  /**
   * Hardware scaling from devicePixelRatio, clamped by a pixel budget so
   * large HiDPI displays don't quietly quadruple the fill rate. (Scaling
   * level is CSS px per device px, so >1 means render smaller.)
   */
  applyScaling(): void {
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    const canvas = this.engine.getRenderingCanvas()
    const cssW = canvas?.clientWidth || window.innerWidth || 1280
    const cssH = canvas?.clientHeight || window.innerHeight || 800
    const wanted = cssW * cssH * ratio * ratio
    const budgeted = wanted > MAX_PIXELS ? ratio * Math.sqrt(MAX_PIXELS / wanted) : ratio
    const level = 1 / Math.max(0.75, budgeted)
    if (Math.abs(level - this.engine.getHardwareScalingLevel()) > 0.001) {
      this.engine.setHardwareScalingLevel(level)
    }
  }

  static create(canvas: HTMLCanvasElement): FormEngine {
    const isMobile = /Mobi|Android/i.test(navigator.userAgent)
    const engine = new Engine(
      canvas, !isMobile, // MSAA off on phones: DPR supersampling already covers it
      {
        antialias: !isMobile,
        stencil: false,
        depth: true,
        alpha: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: 'default',
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

  /** Frames drawn / skipped since boot — scripts/perf.mjs reads these. */
  get renderStats(): { rendered: number; skipped: number } {
    return { rendered: this.renderedFrames, skipped: this.skippedFrames }
  }

  /** Draw the next `frames` frames (call after any one-off visual change). */
  invalidate(frames = 2): void {
    if (frames > this.dirtyFrames) this.dirtyFrames = frames
  }

  setActiveScene(scene: Scene, activity: ActivityProbe | null = null): void {
    if (this.active === scene) { this.activity = activity; this.invalidate(3); return }
    // onPointerObservable only fires after Scene.attachControl() — without
    // this, nothing on the board is clickable.
    this.active.detachControl()
    this.active = scene
    this.activity = activity
    // NOTE: do not touch scene.clearColor here — the settings panel controls
    // the background and each scene owns its clearColor.
    scene.autoClear = true
    scene.attachControl()
    this.invalidate(3)
  }

  resize(): void {
    this.applyScaling()
    this.engine.resize()
    this.invalidate(3)
  }

  private start(): void {
    const loop = () => {
      this.raf = requestAnimationFrame(loop)
      if (this.lost || document.hidden) return
      const now = performance.now()
      const wants = this.dirtyFrames > 0 || (this.activity ? this.activity() : true)
      if (!wants && now - this.lastRenderAt < IDLE_HEARTBEAT_MS) { this.skippedFrames++; return }
      if (this.dirtyFrames > 0) this.dirtyFrames--
      this.lastRenderAt = now
      this.renderedFrames++
      this.active.render()
    }
    this.raf = requestAnimationFrame(loop)
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
    this.uiScene.dispose()
    this.engine.dispose()
  }
}
