import {
  Engine,
  Scene,
  ArcRotateCamera,
  Vector3,
  HemisphericLight,
  Color4,
  Color3,
} from '@babylonjs/core'

/**
 * Single Babylon Engine + single WebGL2 context. The app owns exactly one
 * canvas and never creates per-card engines/canvases.
 */
export class FormEngine {
  readonly engine: Engine
  readonly uiScene: Scene
  private active: Scene | null = null
  private raf = 0
  readonly dpr: number
  private lost = false

  private constructor(canvas: HTMLCanvasElement, engine: Engine) {
    this.engine = engine
    this.dpr = Math.min(
      1.25,
      /Mobi|Android/i.test(navigator.userAgent) ? 1.1 : 1.25,
    )
    engine.setHardwareScalingLevel(1 / this.dpr)
    engine.enableOfflineSupport = false
    engine.performanceMonitor.enable()

    this.uiScene = new Scene(engine)
    this.uiScene.detachControl()
    this.uiScene.autoClear = false
    const cam = new ArcRotateCamera('ui-cam', -Math.PI / 2, Math.PI / 2, 8, Vector3.Zero(), this.uiScene)
    cam.mode = ArcRotateCamera.ORTHOGRAPHIC_CAMERA
    new HemisphericLight('ui-light', new Vector3(0, 1, 0), this.uiScene)

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.lost = true
    })
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false
    })
  }

  static async create(canvas: HTMLCanvasElement): Promise<FormEngine> {
    const engine = new Engine(
      canvas,
      true,
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
      true,
    )
    const form = new FormEngine(canvas, engine)
    form.start()
    return form
  }

  get activeScene(): Scene | null {
    return this.active
  }

  setActiveScene(scene: Scene | null): void {
    if (this.active === scene) return
    this.active = scene
    if (scene) {
      scene.autoClear = true
      scene.clearColor = Color4.FromColor3(Color3.FromHexString('#0B0B0C'), 1)
      scene.attachControl(true)
    }
  }

  resize(): void {
    this.engine.resize()
  }

  private start(): void {
    window.addEventListener('resize', this.resize)
    let last = 0
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop)
      if (this.lost || document.hidden) return
      if (t - last < 16) return
      last = t
      const scene = this.active ?? this.uiScene
      scene.render()
    }
    this.raf = requestAnimationFrame(loop)
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
    window.removeEventListener('resize', this.resize)
    this.uiScene.dispose()
    this.engine.dispose()
  }
}
