import {
  Scene,
  ArcRotateCamera,
  Vector3,
  HemisphericLight,
  Color3,
  Color4,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  LoadAssetContainerAsync,
  AbstractMesh,
  TransformNode,
} from '@babylonjs/core'
import '@babylonjs/loaders/glTF'
import { GLTF2Export } from '@babylonjs/serializers/glTF'
import * as GUI from '@babylonjs/gui'
import type { FormEngine } from '../core/engine'
import { theme, LIMITS } from '../theme'
import { buildTextMesh, ensureFontReady, type TextMeshResult } from './textMesh'
import { publishModel, type PublishStage } from '../protocol/publish'

export type StudioMode = 'import' | 'text'

export interface StudioPublishConfig {
  relays: string[]
  blossoms: string[]
}

export interface StudioCallbacks {
  onClose: () => void
  onPublished: (eventId: string, rootId: string) => void
  getConfig: () => StudioPublishConfig
  replyTo?: { rootId: string; parentId: string }
}

interface LoadedModel {
  container: Awaited<ReturnType<typeof LoadAssetContainerAsync>>
  root: TransformNode
  blob?: Blob
  name: string
  sourceFormat: 'glb' | 'gltf' | 'generated'
}

export class Studio {
  readonly scene: Scene
  private camera: ArcRotateCamera
  private ui: GUI.AdvancedDynamicTexture
  private mode: StudioMode = 'import'
  private current: LoadedModel | TextMeshResult | null = null
  private text = '/0'
  private textColor = theme.accent
  private publishBtn!: GUI.Button
  private closeBtn!: GUI.Button
  private modeImport!: GUI.Button
  private modeText!: GUI.Button
  private statusRing!: GUI.Ellipse
  private statusText!: GUI.TextBlock
  private publishing = false
  private inputEl: HTMLInputElement

  constructor(private engine: FormEngine, private cb: StudioCallbacks) {
    this.scene = new Scene(engine.engine)
    this.scene.clearColor = Color4.FromColor3(Color3.FromHexString(theme.background), 1)
    this.camera = new ArcRotateCamera('s-cam', -Math.PI / 2, Math.PI / 2.2, 8, Vector3.Zero(), this.scene)
    this.camera.attachControl(true)
    this.camera.wheelPrecision = 50
    this.camera.lowerRadiusLimit = 0.5
    this.camera.upperRadiusLimit = 40
    this.scene.activeCamera = this.camera
    new HemisphericLight('sl', new Vector3(0, 1, 0), this.scene)

    this.ui = GUI.AdvancedDynamicTexture.CreateFullscreenUI('studio-ui', true, this.scene, 1, true)
    this.inputEl = document.getElementById('file-input') as HTMLInputElement
    this.buildChrome()
    this.setMode('text')
  }

  private buildChrome(): void {
    // Rail (left)
    const rail = new GUI.StackPanel('rail')
    rail.width = '56px'
    rail.height = 1
    rail.horizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_LEFT
    rail.verticalAlignment = GUI.Control.VERTICAL_ALIGNMENT_CENTER
    rail.spacing = 8
    rail.paddingLeft = '12px'
    this.ui.addControl(rail)

    this.modeImport = this.makeRailButton('import', '↑')
    this.modeImport.onPointerClickObservable.add(() => this.pickFile())
    rail.addControl(this.modeImport)

    this.modeText = this.makeRailButton('text', 'T')
    this.modeText.onPointerClickObservable.add(() => this.setMode('text'))
    rail.addControl(this.modeText)

    // Right column: close + publish
    const right = new GUI.StackPanel('right')
    right.width = '56px'
    right.isVertical = true
    right.horizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_RIGHT
    right.verticalAlignment = GUI.Control.VERTICAL_ALIGNMENT_TOP
    right.spacing = 8
    right.paddingTop = '16px'
    right.paddingRight = '12px'
    this.ui.addControl(right)

    this.closeBtn = GUI.Button.CreateSimpleButton('close', '')
    this.closeBtn.width = '44px'; this.closeBtn.height = '44px'
    this.closeBtn.color = 'transparent'; this.closeBtn.background = '#121213cc'
    this.closeBtn.cornerRadius = 22; this.closeBtn.thickness = 1
    const closeX = new GUI.TextBlock('x', '×')
    closeX.color = theme.ink; closeX.fontSize = 28
    this.closeBtn.addControl(closeX)
    this.closeBtn.onPointerClickObservable.add(() => this.cb.onClose())
    right.addControl(this.closeBtn)

    this.publishBtn = GUI.Button.CreateSimpleButton('pub', '')
    this.publishBtn.width = '48px'; this.publishBtn.height = '48px'
    this.publishBtn.color = 'transparent'; this.publishBtn.background = theme.accent
    this.publishBtn.cornerRadius = 24; this.publishBtn.thickness = 0
    const plus = new GUI.TextBlock('plus', '↑')
    plus.color = theme.background; plus.fontSize = 24; plus.fontWeight = 'bold'
    this.publishBtn.addControl(plus)
    this.publishBtn.onPointerClickObservable.add(() => void this.publish())
    right.addControl(this.publishBtn)

    // Bottom center status
    const status = new GUI.StackPanel('status')
    status.height = '48px'
    status.isVertical = false
    status.horizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_CENTER
    status.verticalAlignment = GUI.Control.VERTICAL_ALIGNMENT_BOTTOM
    status.spacing = 8
    status.paddingBottom = '20px'
    this.ui.addControl(status)
    this.statusRing = new GUI.Ellipse('ring')
    this.statusRing.width = '10px'; this.statusRing.height = '10px'
    this.statusRing.color = 'transparent'; this.statusRing.thickness = 0
    this.statusRing.background = theme.muted
    status.addControl(this.statusRing)
    this.statusText = new GUI.TextBlock('status-text', '')
    this.statusText.color = theme.muted
    this.statusText.fontSize = 12
    this.statusText.fontFamily = 'monospace'
    status.addControl(this.statusText)
  }

  private makeRailButton(_id: string, glyph: string): GUI.Button {
    const btn = GUI.Button.CreateSimpleButton('rb-' + _id, '')
    btn.width = '44px'; btn.height = '44px'
    btn.color = 'transparent'; btn.background = '#121213cc'
    btn.cornerRadius = 12; btn.thickness = 1
    const t = new GUI.TextBlock('g', glyph)
    t.color = theme.ink; t.fontSize = 18; t.fontFamily = 'monospace'
    btn.addControl(t)
    return btn
  }

  private setStatus(stage: PublishStage | 'idle', detail = ''): void {
    const map: Record<string, [string, string]> = {
      idle: [theme.muted, ''],
      hash: [theme.warning, 'hash'],
      blossom: [theme.warning, 'blossom'],
      nostr: [theme.warning, 'nostr'],
      done: [theme.success, 'done'],
      error: [theme.danger, detail || 'error'],
    }
    const [color, text] = map[stage] ?? map.idle
    this.statusRing.background = color
    this.statusText.text = text
  }

  private setMode(mode: StudioMode): void {
    this.mode = mode
    this.modeImport.alpha = mode === 'import' ? 1 : 0.5
    this.modeText.alpha = mode === 'text' ? 1 : 0.5
    if (mode === 'text') this.makeText()
  }

  private async makeText(): Promise<void> {
    await ensureFontReady()
    this.clearContent()
    const result = buildTextMesh(this.scene, this.text, this.textColor, 'center')
    this.current = result
    this.frameContent(result.width, result.height)
  }

  private clearContent(): void {
    if (!this.current) return
    if ('container' in this.current) {
      ;(this.current as LoadedModel).container.dispose()
    } else if ('mesh' in this.current) {
      ;(this.current as TextMeshResult).mesh.dispose(undefined, true)
    }
    this.current = null
  }

  private frameContent(w: number, h: number): void {
    const dist = Math.max(w, h, 3) * 1.6 + 2
    this.camera.radius = dist
    this.camera.target = Vector3.Zero()
  }

  private pickFile(): void {
    this.inputEl.value = ''
    this.inputEl.onchange = () => {
      const file = this.inputEl.files?.[0]
      if (file) void this.loadFile(file)
    }
    this.inputEl.click()
  }

  private async loadFile(file: File): Promise<void> {
    if (file.size > LIMITS.modelBytesHard) {
      this.setStatus('error', '> 20 MiB')
      return
    }
    this.setStatus('hash')
    const url = URL.createObjectURL(file)
    try {
      const container = await LoadAssetContainerAsync(url, this.scene)
      let verts = 0
      container.meshes.forEach((m) => { verts += (m as AbstractMesh).getTotalVertices?.() ?? 0 })
      if (verts > LIMITS.vertices) {
        container.dispose()
        URL.revokeObjectURL(url)
        this.setStatus('error', 'too complex')
        return
      }
      container.addAllToScene()
      this.clearContent()
      const ext = file.name.toLowerCase().endsWith('.glb') ? 'glb' : 'gltf'
      const root = container.meshes[0] ?? new TransformNode('root', this.scene)
      this.current = { container, root, blob: file, name: file.name, sourceFormat: ext }
      this.mode = 'import'
      // Frame using bounding info.
      const box = container.meshes.reduce(
        (acc, m) => {
          const bi = (m as AbstractMesh).getBoundingInfo?.()
          if (!bi) return acc
          acc.minimum.minimizeInPlace(bi.boundingBox.minimumWorld)
          acc.maximum.maximizeInPlace(bi.boundingBox.maximumWorld)
          return acc
        },
        { minimum: new Vector3(Infinity, Infinity, Infinity), maximum: new Vector3(-Infinity, -Infinity, -Infinity) },
      )
      const size = box.maximum.subtract(box.minimum)
      this.frameContent(Math.max(size.x, size.z), size.y)
      this.setStatus('idle')
    } catch (err) {
      console.error(err)
      this.setStatus('error', 'load failed')
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  private async exportGLB(): Promise<{ blob: Blob; name: string }> {
    if (this.current && 'container' in (this.current as object)) {
      const loaded = this.current as LoadedModel
      if (loaded.blob && loaded.sourceFormat === 'glb') {
        return { blob: loaded.blob, name: loaded.name }
      }
      const res = await GLTF2Export.GLBAsync(this.scene, (loaded.name || 'model').replace(/\.[^.]+$/, ''))
      const file = Object.values(res.files)[0]
      const blob = file instanceof Blob ? file : new Blob([file], { type: 'model/gltf-binary' })
      return { blob, name: (loaded.name || 'model').replace(/\.[^.]+$/, '') + '.glb' }
    }
    const res = await GLTF2Export.GLBAsync(this.scene, 'text')
    const file = Object.values(res.files)[0]
    const blob = file instanceof Blob ? file : new Blob([file], { type: 'model/gltf-binary' })
    return { blob, name: 'text.glb' }
  }

  private async publish(): Promise<void> {
    if (this.publishing) return
    this.publishing = true
    this.publishBtn.isEnabled = false
    try {
      const { blob, name } = await this.exportGLB()
      const config = this.cb.getConfig()
      const result = await publishModel({
        blob,
        relays: config.relays,
        blossoms: config.blossoms,
        tint: this.textColor,
        filename: name,
        sourceFormat: (this.current as LoadedModel)?.sourceFormat ?? 'generated',
        replyTo: this.cb.replyTo
          ? { rootId: this.cb.replyTo.rootId, parentId: this.cb.replyTo.parentId }
          : undefined,
        onProgress: (stage, detail) => this.setStatus(stage, detail),
      })
      this.cb.onPublished(result.eventId, this.cb.replyTo?.rootId ?? result.eventId)
    } catch (err) {
      console.error(err)
      this.setStatus('error', err instanceof Error ? err.message.slice(0, 40) : 'failed')
    } finally {
      this.publishing = false
      this.publishBtn.isEnabled = true
    }
  }

  setText(text: string): void {
    this.text = text
    if (this.mode === 'text') void this.makeText()
  }

  dispose(): void {
    this.clearContent()
    this.ui.dispose()
    this.scene.dispose()
  }
}
