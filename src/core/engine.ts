import { Engine } from '@babylonjs/core/Engines/engine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color4 } from '@babylonjs/core/Maths/math.color'

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

  private constructor(canvas: HTMLCanvasElement, engine: Engine) {
    this.engine = engine
    // Render at the DEVICE pixel ratio (capped). The old code pinned this to
    // 1.0 on phones / 1.25 on desktop, so on any HiDPI screen the canvas was
    // upscaled by the browser and everything Babylon drew — cards, reply
    // badges, thread nodes — came out soft.
    const isMobile = /Mobi|Android/i.test(navigator.userAgent)
    const ratio = Math.min(window.devicePixelRatio || 1, isMobile ? 2 : 2)
    engine.setHardwareScalingLevel(1 / Math.max(1, ratio))
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
    canvas.addEventListener('webglcontextrestored', () => { this.lost = false })
  }

  static create(canvas: HTMLCanvasElement): FormEngine {
    const engine = new Engine(
      canvas, true,
      {
        antialias: true,
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
  }

  resize(): void { this.engine.resize() }

  private start(): void {
    const loop = () => {
      this.raf = requestAnimationFrame(loop)
      if (this.lost || document.hidden) return
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
