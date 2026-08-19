import './style.css'
import { FormEngine } from './core/engine'
import { Router } from './core/router'
import { RelayPool } from './protocol/nostr'
import { BlossomClient } from './protocol/blossom'
import { parseModelEvent } from './protocol/events'
import { ThreadIndex, type ThreadMeta } from './protocol/thread-index'
import { Board } from './board/board'
import { ThreadView } from './board/threadView'
import { Viewer } from './viewer/viewer'
import { Studio } from './studio/studio'
import { AssetCache } from './core/assets'
import { publishModel, type PublishProgress } from './protocol/publish'
import { configureDraco } from './model/draco'
import { enforceOffline } from './model/offline'
import { DEFAULTS, theme } from './theme'
import { luminance } from './core/gfx'
import { loadNetworkConfig } from './protocol/storage'
import { DeletionService } from './protocol/deletion'
import { SettingsStore } from './settings/store'
import { SettingsPanel } from './settings/panel'
import { detectCapabilities } from './settings/capabilities'
import { applySettings } from './settings/apply'
import { graphics } from './render/graphics'
import { mixer } from './audio/mixer'
import { Legend } from './hud/legend'
import { NetworkPanel } from './hud/networkPanel'
import { ErrorSheet, ERRORS } from './hud/errorSheet'
import { attachAllDragNumbers } from './studio/dragNumber'
import { handoffContainer } from './core/sceneTransfer'

type Mode = 'boot' | 'board' | 'viewer' | 'studio' | 'thread'

function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement
}

async function boot(): Promise<void> {
  enforceOffline()
  configureDraco()

  const canvas = $('engine') as HTMLCanvasElement
  let engine: FormEngine
  try {
    engine = FormEngine.create(canvas)
  } catch {
    const fatal = $('fatal')
    fatal.hidden = false
    $('fatal-text').textContent = 'WebGL unavailable.'
    $('fatal-reload').addEventListener('click', () => location.reload())
    return
  }

  const router = new Router()
  const pool = new RelayPool()
  const blossoms = new BlossomClient([...DEFAULTS.blossoms])
  const index = new ThreadIndex()

  const cfg = await loadNetworkConfig()
  if (cfg.relays?.length) pool.setRelays(cfg.relays)
  if (cfg.blossoms?.length) blossoms.setServers(cfg.blossoms)
  const settings = new SettingsStore()
  await settings.load()

  const board = new Board(engine, {
    onOpenModel: (meta) => router.go({ name: 'viewer', id: meta.eventId }),
    onOpenThread: (meta) => router.go({ name: 'thread', rootId: meta.refs.rootId ?? meta.eventId }),
  })
  const assets = new AssetCache(blossoms, board.scene)
  board.setAssets(assets)
  const viewer = new Viewer(engine)
  const studio = new Studio(engine)
  const threadView = new ThreadView(engine)
  threadView.setup(
    assets, index,
    (meta) => router.go({ name: 'viewer', id: meta.eventId }),
    (meta) => {
      const rootId = meta.refs.rootId ?? meta.eventId
      router.go({ name: 'studio', rootId, parentId: meta.eventId })
    },
  )

  const legend = new Legend()
  const networkPanel = new NetworkPanel(pool, blossoms)
  const errorSheet = new ErrorSheet()
  void legend.maybeShowFirstRun()

  // ---------- HTML HUD ----------
  const topbar = $('topbar')
  const threadZoom = $('thread-zoom')
  const viewerBar = $('viewer-bar')
  const drawer = $('meta-drawer')
  const studioEl = $('studio')
  const studioFilename = $('studio-filename')
  const studioStatus = $('studio-status')
  const btnStudioImport = $('btn-studio-import') as HTMLButtonElement
  const btnStudioPublish = $('btn-studio-publish') as HTMLButtonElement
  const studioText = $('studio-text') as HTMLTextAreaElement
  const studioAlign = $('studio-align') as HTMLButtonElement
  const studioColor = $('studio-color') as HTMLInputElement
  const textScale = $('text-scale') as HTMLInputElement
  const textTracking = $('text-tracking') as HTMLInputElement
  const textLeading = $('text-leading') as HTMLInputElement
  const textExtrude = $('text-extrude') as HTMLInputElement
  const textBudget = $('text-budget')
  const symbolGrid = $('symbol-grid')
  const camTarget = (['cam-tx','cam-ty','cam-tz'] as const).map((id) => $(id) as HTMLInputElement)
  const camYaw = $('cam-yaw') as HTMLInputElement
  const camPitch = $('cam-pitch') as HTMLInputElement
  const camFov = $('cam-fov') as HTMLInputElement
  const camRadius = $('cam-radius') as HTMLInputElement
  const fileInput = $('file-input') as HTMLInputElement
  let publishing = false
  const netDot = $('net-dot')
  const btnPlay = $('btn-play') as HTMLButtonElement
  const camDots = $('cam-dots')
  const metaText = $('meta-text')
  const toast = $('toast')

  // ---------- loading ring ----------
  const loading = $('loading')
  const loadingLabel = $('loading-label')
  const loadingReasons = new Set<string>()
  function setLoading(reason: string, on: boolean, label = ''): void {
    if (on === loadingReasons.has(reason)) return
    if (on) loadingReasons.add(reason)
    else loadingReasons.delete(reason)
    engine.kick()
    loading.hidden = loadingReasons.size === 0
    if (!loading.hidden) loadingLabel.textContent = label || reason
  }
  ;(window as any).__loading = loadingReasons

  let toastTimer = 0
  function showToast(msg: string): void {
    toast.textContent = msg
    toast.hidden = false
    clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => { toast.hidden = true }, 3200)
  }

  let currentMeta: ThreadMeta | null = null
  let studioReply: { rootId: string; parentId: string } | null = null
  let viewerNav = 0

  const orderedRoots = (): ThreadMeta[] =>
    [...index.byId.values()]
      .filter((m) => m.role === 'root' && !m.tombstoned)
      .sort((a, b) => b.createdAt - a.createdAt)

  $('btn-home').addEventListener('click', () => router.go({ name: 'board' }))
  $('btn-studio-close')?.addEventListener('click', () => router.go({ name: 'board' }))
  netDot.addEventListener('click', () => router.go({ name: 'network' }))
  $('btn-add').addEventListener('click', () => router.go({ name: 'studio' }))
  $('btn-shuffle').addEventListener('click', () => { board.shuffle(orderedRoots()); engine.kick() })

  // ---------- studio (import + publish) ----------
  function setStudioStatus(text: string, cls = ''): void {
    studioStatus.textContent = text
    studioStatus.className = 'studio-status ' + cls
  }

  async function pickStudioFile(): Promise<void> {
    fileInput.value = ''
    const prevAccept = fileInput.accept
    const prevMultiple = fileInput.multiple
    fileInput.accept = '.glb,.gltf,.obj,.mtl,.bin,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tga,.ktx2'
    fileInput.multiple = true
    fileInput.addEventListener('change', async () => {
      const picked = fileInput.files ? Array.from(fileInput.files) : []
      fileInput.accept = prevAccept
      fileInput.multiple = prevMultiple
      if (!picked.length) return
      try {
        setStudioStatus('importing…', 'busy')
        const imported = await studio.importFiles(picked)
        const label = picked.length === 1 ? picked[0].name : `${picked.length} files`
        studioFilename.textContent = label
        btnStudioPublish.disabled = false
        setStudioStatus(`${imported.report.stats.meshes} mesh · ${(imported.file.size / 1048576).toFixed(1)} MiB`)
      } catch (err) {
        setStudioStatus(err instanceof Error ? err.message : 'import failed', 'err')
      }
    }, { once: true })
    fileInput.click()
  }

  async function publishStudio(): Promise<void> {
    if (publishing) return
    if (!studio.hasContent()) return
    publishing = true
    btnStudioPublish.disabled = true
    try {
      setStudioStatus('export…', 'busy')
      const content = await studio.getContentForPublish()
      setStudioStatus('poster…', 'busy')
      const { blob: poster, blank } = await assets.renderPosterFor(content.blob, studio.tintColor)
      if (blank) setStudioStatus('poster placeholder', 'busy')
      const onProgress = (p: PublishProgress) => {
        if (p.stage === 'blossom') setStudioStatus('upload…', 'busy')
        else if (p.stage === 'relay') setStudioStatus('nostr…', 'busy')
        else if (p.stage === 'done') setStudioStatus(`done · ${p.ok ?? 0}/${(p.ok ?? 0) + (p.failed ?? 0)}`, p.failed ? 'err' : 'ok')
        else if (p.stage === 'error') setStudioStatus(p.detail ?? 'failed', 'err')
      }
      const result = await publishModel(
        {
          model: content.blob,
          poster,
          tint: studio.tintColor,
          filename: content.filename,
          sourceFormat: content.sourceFormat,
          role: studioReply ? 'reply' : 'root',
          rootId: studioReply?.rootId,
          parentId: studioReply?.parentId,
        },
        { relays: pool.relayUrls, blossoms: blossoms.servers, pool, onProgress: onProgress },
      )
      void deletion.refresh().then(syncDeleteButton)
      // The new post enters the index via the relay echo. Routing to its
      // viewer immediately races that echo: openViewer bails to the board
      // when the meta is not in the index yet (publish -> board flash +
      // delete button never armed). Wait briefly for the echo instead.
      const t0 = performance.now()
      while (!index.byId.has(result.eventId) && performance.now() - t0 < 8000) {
        await new Promise((r) => setTimeout(r, 40))
      }
      if (studioReply) router.go({ name: 'thread', rootId: studioReply.rootId, focusId: result.eventId })
      else router.go({ name: 'viewer', id: result.eventId })
      studioReply = null
    } catch (err) {
      setStudioStatus(err instanceof Error ? err.message : 'publish failed', 'err')
      btnStudioPublish.disabled = false
    } finally {
      publishing = false
    }
  }

  btnStudioImport.addEventListener('click', () => void pickStudioFile())
  btnStudioPublish.addEventListener('click', () => void publishStudio())

  // ---- Studio transform toolbar ----
  let freeCamOn = false
  document.querySelectorAll<HTMLButtonElement>('[data-xform]').forEach((b) =>
    b.addEventListener('click', () => {
      const mode = b.dataset.xform as 'position' | 'rotation' | 'scale'
      studio.setTransformMode(mode)
      document.querySelectorAll<HTMLButtonElement>('[data-xform]').forEach((x) => x.classList.toggle('active', x === b))
      refreshCameraControls()
    }))
  const toolDelete = $('tool-delete') as HTMLButtonElement
  toolDelete?.addEventListener('click', () => studio.deleteSelection())
  const toolFree = $('tool-freecam') as HTMLButtonElement
  toolFree?.addEventListener('click', () => {
    freeCamOn = !freeCamOn
    studio.setCameraState({ projection: freeCamOn ? 'free' : 'perspective' })
    refreshCameraControls()
  })

  // ---- Studio tabs ----
  type StudioTab = 'upload' | 'type' | 'paint' | 'symbols'
  function setStudioTab(tab: StudioTab): void {
    document.querySelectorAll<HTMLButtonElement>('.rail-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tab)
    })
    document.querySelectorAll<HTMLElement>('.studio-panel').forEach((p) => {
      p.hidden = p.dataset.panel !== tab
    })
    if (tab === 'type' && !studio.text) {
      studio.setText('/0'); studio.rebuildText()
      // seeding text IS content: publish must enable (it only listened to
      // the textarea's input event, so the seeded '/0' left it dead)
      btnStudioPublish.disabled = !studio.hasContent()
    }
    studio.kick(120)
  }
  document.querySelectorAll<HTMLButtonElement>('.rail-btn').forEach((b) =>
    b.addEventListener('click', () => setStudioTab(b.dataset.tab as StudioTab)),
  )
  const SYMBOLS = ['■','●','▲','◆','★','♥','♦','♣']
  if (symbolGrid) SYMBOLS.forEach((g, i) => {
    const b = document.createElement('button')
    b.textContent = g
    b.title = `symbol ${i}`
    b.addEventListener('click', () => { studioText.value = g; studio.setText(g); studio.rebuildText(); updateTextBudget() })
    symbolGrid.appendChild(b)
  })

  // ---- Studio text + camera settings ----
  const ALIGN_CYCLE: Array<'left' | 'center' | 'right'> = ['left', 'center', 'right']
  let alignIdx = 1
  function updateTextBudget(): void {
    if (!textBudget) return
    const m = studio.scene.meshes.find((x) => x.name === 'studio-text')
    const tris = m ? m.getTotalIndices() / 2 : 0
    const lines = studioText.value.split('\n').length
    textBudget.textContent = `${studioText.value.length} chars · ${lines} lines · ${tris} tris`
  }

  function refreshCameraControls(): void {
    const c = studio.getCameraState()
    c.target.forEach((v, i) => { if (camTarget[i]) camTarget[i].value = v.toFixed(2) })
    if (camYaw) camYaw.value = c.rotationDeg[1].toFixed(1)
    if (camPitch) camPitch.value = c.rotationDeg[2].toFixed(1)
    if (camFov) camFov.value = c.fovDeg.toFixed(0)
    if (camRadius) camRadius.value = c.radius.toFixed(2)
    document.querySelector<HTMLButtonElement>('#tool-freecam')?.classList.toggle('active', c.projection === 'free')
    refreshCameraList()
  }

  function refreshCameraList(): void {
    const list = document.getElementById('cam-list') as HTMLElement | null
    if (!list) return
    list.innerHTML = ''
    const cams = studio.getCameras()
    const active = studio.getActiveCameraIndex()
    cams.forEach((_, i) => {
      const row = document.createElement('div')
      row.className = 'cam-row' + (i === active ? ' active' : '')
      const sel = document.createElement('button')
      sel.className = 'hbtn small'
      sel.textContent = String(i + 1)
      sel.title = `edit camera ${i + 1}`
      sel.addEventListener('click', () => { studio.selectCamera(i); refreshCameraControls() })
      const del = document.createElement('button')
      del.className = 'hbtn small danger'
      del.innerHTML = '×'
      del.title = 'remove'
      del.addEventListener('click', (e) => { e.stopPropagation(); studio.removeCamera(i); refreshCameraControls() })
      row.append(sel, del)
      list.append(row)
    })
    if (cams.length === 0) {
      const empty = document.createElement('span')
      empty.className = 'hint'
      empty.textContent = 'no cams'
      list.append(empty)
    }
  }

  let textTimer = 0
  const scheduleRebuild = () => {
    clearTimeout(textTimer)
    textTimer = window.setTimeout(() => { studio.rebuildText(); refreshCameraControls(); updateTextBudget() }, 90)
  }

  studioText.addEventListener('input', () => {
    studio.setText(studioText.value)
    btnStudioPublish.disabled = !studio.hasContent()
    scheduleRebuild()
  })

  studioColor.addEventListener('input', () => {
    studio.setTintColor(studioColor.value)
    if (studio.currentModel === null) studio.rebuildText()
  })

  studioAlign.addEventListener('click', () => {
    alignIdx = (alignIdx + 1) % ALIGN_CYCLE.length
    studio.setTextAlign(ALIGN_CYCLE[alignIdx])
    studioAlign.textContent = ALIGN_CYCLE[alignIdx][0].toUpperCase()
    studio.rebuildText()
  })

  const num = (el: HTMLInputElement) => {
    const v = parseFloat(el.value)
    return Number.isFinite(v) ? v : 0
  }

  // text numeric settings: draggable numbers
  textScale.addEventListener('input', () => { studio.setTextScale(num(textScale)); scheduleRebuild() })
  textTracking.addEventListener('input', () => { studio.setTextLetterSpacing(num(textTracking)); scheduleRebuild() })
  textLeading.addEventListener('input', () => { studio.setTextLineSpacing(num(textLeading)); scheduleRebuild() })
  textExtrude.addEventListener('input', () => { studio.setTextDepth(num(textExtrude)); scheduleRebuild() })

  textScale.addEventListener('change', () => { studio.setTextScale(num(textScale)); scheduleRebuild() })
  textTracking.addEventListener('change', () => { studio.setTextLetterSpacing(num(textTracking)); scheduleRebuild() })
  textLeading.addEventListener('change', () => { studio.setTextLineSpacing(num(textLeading)); scheduleRebuild() })
  textExtrude.addEventListener('change', () => { studio.setTextDepth(num(textExtrude)); scheduleRebuild() })

  // camera numeric inputs - no limits, draggable
  camTarget.forEach((el, i) => {
    const handler = () => {
      const t = studio.getCameraState().target.slice() as [number, number, number]
      t[i] = num(el); studio.setCameraState({ target: t }); refreshCameraControls()
    }
    el.addEventListener('input', handler)
    el.addEventListener('change', handler)
  })
  const handleCamRot = () => {
    const y = num(camYaw)
    const p = num(camPitch)
    studio.setCameraState({ rotationDeg: [0, y, p] })
    refreshCameraControls()
  }
  camYaw?.addEventListener('input', handleCamRot)
  camYaw?.addEventListener('change', handleCamRot)
  camPitch?.addEventListener('input', handleCamRot)
  camPitch?.addEventListener('change', handleCamRot)

  camFov.addEventListener('input', () => studio.setCameraState({ fovDeg: num(camFov) }))
  camFov.addEventListener('change', () => { studio.setCameraState({ fovDeg: num(camFov) }); refreshCameraControls() })
  camRadius.addEventListener('input', () => studio.setCameraState({ radius: num(camRadius) }))
  camRadius.addEventListener('change', () => { studio.setCameraState({ radius: num(camRadius) }); refreshCameraControls() })

  document.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach((b) =>
    b.addEventListener('click', () => {
      const m = b.dataset.cam
      if (m === 'frame') studio.frameCamera()
      else if (m === 'persp' || m === 'ortho') studio.setCameraState({ projection: m as 'perspective' | 'ortho' })
      else if (m === 'front') studio.setCameraState({ rotationDeg: [0, 0, 0] })
      else if (m === 'top') studio.setCameraState({ rotationDeg: [0, 0, 89.9] })
      else if (m === 'side') studio.setCameraState({ rotationDeg: [0, 90, 0] })
      else if (m === 'origin') studio.lookAtSelectedOrigin()
      else if (m === 'center') studio.lookAtSelectedCenter()
      else if (m === 'fit-sel') studio.fitSelected()
      refreshCameraControls()
    }))

  $('cam-add')?.addEventListener('click', () => {
    const idx = studio.addCamera()
    studio.selectCamera(idx)
    refreshCameraControls()
    setStudioStatus(`cam ${idx + 1} added`, 'ok')
  })

  const foldBtn = $('btn-studio-fold') as HTMLButtonElement | null
  const inspector = document.querySelector('.studio-inspector') as HTMLElement | null
  const resizeHandle = $('studio-resize-handle') as HTMLElement | null

  let savedInspectorHeight = 240

  const toggleFold = () => {
    if (!inspector) return
    const willCollapse = !inspector.classList.contains('collapsed')
    inspector.classList.toggle('collapsed', willCollapse)
    document.body.classList.toggle('studio-collapsed', willCollapse)
    foldBtn?.classList.toggle('active', willCollapse)
    if (foldBtn) foldBtn.textContent = willCollapse ? '▴' : '▾'
    if (!willCollapse) {
      const h = savedInspectorHeight || 240
      inspector.style.setProperty('--inspector-h', `${h}px`)
      inspector.style.height = `${h}px`
      inspector.style.maxHeight = `${h}px`
    }
    studio.kick(200)
  }
  foldBtn?.addEventListener('click', toggleFold)
  $('studio-fold-handle')?.addEventListener('click', toggleFold)

  // Interactive vertical resizing of studio inspector in portrait/mobile
  let isResizing = false
  let resizeStartY = 0
  let resizeStartH = 0
  let resizeMoved = false

  const startResize = (e: PointerEvent) => {
    if (e.button !== 0 || !inspector) return
    isResizing = true
    resizeMoved = false
    resizeStartY = e.clientY
    const rect = inspector.getBoundingClientRect()
    resizeStartH = rect.height
    inspector.classList.add('resizing')
    try { resizeHandle?.setPointerCapture(e.pointerId) } catch {}
    e.preventDefault()
  }

  const doResize = (e: PointerEvent) => {
    if (!isResizing || !inspector) return
    const dy = resizeStartY - e.clientY // dragging up increases inspector height
    if (Math.abs(dy) > 3) resizeMoved = true
    const maxH = Math.max(140, window.innerHeight - 150)
    const minH = 48
    const newH = Math.max(minH, Math.min(maxH, resizeStartH + dy))
    savedInspectorHeight = newH
    inspector.style.setProperty('--inspector-h', `${newH}px`)
    inspector.style.height = `${newH}px`
    inspector.style.maxHeight = `${newH}px`
    if (inspector.classList.contains('collapsed')) {
      inspector.classList.remove('collapsed')
      document.body.classList.remove('studio-collapsed')
      if (foldBtn) foldBtn.textContent = '▾'
      foldBtn?.classList.remove('active')
    }
    studio.kick(80)
  }

  const endResize = (e: PointerEvent) => {
    if (!isResizing) return
    isResizing = false
    inspector?.classList.remove('resizing')
    try { resizeHandle?.releasePointerCapture(e.pointerId) } catch {}
    if (!resizeMoved) {
      toggleFold()
    } else if (inspector) {
      const h = inspector.getBoundingClientRect().height
      if (h < 60) {
        toggleFold()
      }
    }
  }

  resizeHandle?.addEventListener('pointerdown', startResize)
  resizeHandle?.addEventListener('pointermove', doResize)
  resizeHandle?.addEventListener('pointerup', endResize)
  resizeHandle?.addEventListener('pointercancel', endResize)

  // make all number inputs draggable (Blender-like)
  attachAllDragNumbers(document.body)

  $('btn-close').addEventListener('click', () => router.go({ name: 'board' }))
  $('btn-prev').addEventListener('click', () => void stepViewer(-1))
  $('btn-next').addEventListener('click', () => void stepViewer(1))
  btnPlay.addEventListener('click', () => { viewer.toggleAnimation(); syncPlay() })
  $('btn-thread').addEventListener('click', () => {
    if (currentMeta) router.go({ name: 'thread', rootId: currentMeta.refs.rootId ?? currentMeta.eventId })
  })
  $('btn-reply').addEventListener('click', () => {
    if (currentMeta) {
      const rootId = currentMeta.refs.rootId ?? currentMeta.eventId
      router.go({ name: 'studio', rootId, parentId: currentMeta.eventId })
    }
  })
  $('btn-download').addEventListener('click', () => void downloadCurrent())

  const deletion = new DeletionService(pool)
  void deletion.refresh().then(syncDeleteButton)
  const vbtnDelete = $('vbtn-delete')
  function syncDeleteButton(): void {
    vbtnDelete.hidden = !deletion.canDelete(currentMeta?.eventId)
  }
  let deleting = false
  $('btn-delete').addEventListener('click', () => {
    if (!currentMeta || deleting || !deletion.canDelete(currentMeta.eventId)) return
    const id = currentMeta.eventId
    errorSheet.show({
      code: 'D001',
      cause: 'Delete this post? A kind-5 tombstone is published to your relays. Servers may keep the bytes; deletion hides, it does not destroy (spec SECURITY).',
      action: 'delete post',
      onAction: () => { void doDelete(id) },
    })
  })
  async function doDelete(id: string): Promise<void> {
    deleting = true
    try {
      const { ok, failed } = await deletion.delete(id)
      index.tombstone(id)
      board.setMetas(orderedRoots())
      showToast(ok.length ? `deleted · ${ok.length}/${ok.length + failed.length} relays` : 'delete failed on all relays')
      if (ok.length) router.go({ name: 'board' })
    } catch {
      showToast('delete failed')
    } finally {
      deleting = false
    }
  }
  $('btn-meta').addEventListener('click', toggleDrawer)
  $('btn-meta-close').addEventListener('click', () => {
    drawer.hidden = true
    document.body.classList.remove('drawer-open')
  })

  const caps = detectCapabilities(engine.engine._gl as WebGL2RenderingContext | null)
  function applyBackground(hex: string): void {
    document.body.dataset.theme = luminance(hex) < 0.5 ? 'dark' : 'light'
    board.setBackground(hex)
    viewer.setBackground(hex)
    studio.setBackground(hex)
    threadView.setBackground(hex)
  }

  const wiring = { engine, board, viewer, threadView, studio, assets, applyBackground }
  graphics.onInvalidate = () => engine.kick()
  graphics.onError = () => settingsPanel?.refresh()
  graphics.register(board.scene, 'flat')
  graphics.register(threadView.scene, 'flat')
  graphics.register(viewer.scene, 'viewer', () => viewer.scene.activeCamera)
  graphics.register(studio.scene, 'studio', () => studio.scene.activeCamera)
  for (const offscreen of assets.offscreenScenes()) graphics.register(offscreen, 'offscreen')
  graphics.register(board.previewScene, 'offscreen')
  graphics.register(threadView.previewScene, 'offscreen')

  let settingsPanel: SettingsPanel | undefined
  settingsPanel = new SettingsPanel(settings, caps, {
    onAction: (id) => void runSettingsAction(id),
    runtimeError: (id) => graphics.errors.get(id) ?? null,
    readout: () => {
      const b = engine.bufferSize
      const css = `${Math.round(window.innerWidth)}×${Math.round(window.innerHeight)} css`
      return `${b.width}×${b.height} drawing buffer · ${css} · scale ${b.ratio}× · ${caps.renderer.slice(0, 42)}`
    },
  })

  async function runSettingsAction(id: string): Promise<void> {
    if (id === 'clearCache') {
      await assets.clearCaches()
      showToast('caches cleared — reload to refetch')
    } else if (id === 'calibration') {
      toggleCalibration()
    }
  }

  let calibrationEl: HTMLElement | null = null
  function toggleCalibration(): void {
    if (calibrationEl) { calibrationEl.remove(); calibrationEl = null; return }
    const wrap = document.createElement('div')
    wrap.id = 'calibration'
    wrap.className = 'hud'
    const ramp = document.createElement('div')
    ramp.className = 'cal-ramp'
    for (let i = 0; i <= 20; i++) {
      const c = document.createElement('i')
      const l = Math.round((i / 20) * 255)
      c.style.background = `rgb(${l},${l},${l})`
      ramp.append(c)
    }
    const dark = document.createElement('div')
    dark.className = 'cal-bars dark'
    for (let i = 0; i < 6; i++) {
      const c = document.createElement('i')
      c.style.background = `rgb(${i * 3},${i * 3},${i * 3})`
      c.textContent = String(i * 3)
      dark.append(c)
    }
    const light = document.createElement('div')
    light.className = 'cal-bars light'
    for (let i = 0; i < 6; i++) {
      const l = 255 - i * 3
      const c = document.createElement('i')
      c.style.background = `rgb(${l},${l},${l})`
      c.textContent = String(l)
      light.append(c)
    }
    const note = document.createElement('p')
    note.textContent = 'Raise brightness until the darkest bar on the left is just visible, then lower it until the brightest bars on the right stay distinct. Click to close.'
    wrap.append(ramp, dark, light, note)
    wrap.addEventListener('click', () => toggleCalibration())
    document.body.append(wrap)
    calibrationEl = wrap
  }

  const perfOverlay = document.createElement('div')
  perfOverlay.id = 'perf-overlay'
  perfOverlay.className = 'hud'
  document.body.append(perfOverlay)
  setInterval(() => {
    if (!document.body.classList.contains('show-perf')) return
    const st = engine.perfStats()
    const b = engine.bufferSize
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
    perfOverlay.textContent = [
      `${b.width}×${b.height} @${b.ratio}×`,
      `frame ${st.emaMs.toFixed(1)} ms`,
      `renders ${st.renders}`,
      heap ? `heap ${(heap.usedJSHeapSize / 1048576).toFixed(0)} MB` : '',
      `live ${board.previewPool.activeCount}`,
    ].filter(Boolean).join('   ')
  }, 500)

  settings.subscribe((values, changed) => {
    applySettings(wiring, values, changed)
    settingsPanel.refresh()
  })
  applySettings(wiring, settings.all, null)

  mixer.onDevices = () => {
    settingsPanel.setOptions('audioOutput', [
      { value: 'default', label: 'System default' },
      ...mixer.outputs.map((d) => ({ value: d.id, label: d.label })),
    ])
    settingsPanel.setOptions('audioInput', [
      { value: 'default', label: 'System default' },
      ...mixer.inputs.map((d) => ({ value: d.id, label: d.label })),
    ])
  }
  void mixer.refreshDevices()
  window.addEventListener('pointerdown', () => mixer.resume(), { once: true, passive: true })
  navigator.mediaDevices?.addEventListener?.('devicechange', () => void mixer.refreshDevices())

  $('btn-settings').addEventListener('click', () => settingsPanel.toggle())
  $('btn-tzoom-in').addEventListener('click', () => threadView.zoomBy(1.25))
  $('btn-tzoom-out').addEventListener('click', () => threadView.zoomBy(1 / 1.25))
  $('btn-tfit').addEventListener('click', () => threadView.fit())

  function syncPlay(): void {
    btnPlay.classList.toggle('playing', viewer.isPlaying())
  }

  function renderCamDots(): void {
    camDots.innerHTML = ''
    const mk = (label: string, idx: number) => {
      const b = document.createElement('button')
      b.className = 'cam-dot' + (viewer.camIndex === idx ? ' active' : '')
      b.textContent = label
      b.addEventListener('click', () => { viewer.applyCamera(idx); renderCamDots() })
      camDots.appendChild(b)
    }
    mk('A', -1)
    for (let i = 0; i < viewer.cameraCount; i++) mk(String(i + 1), i)
  }

  async function stepViewer(dir: number): Promise<void> {
    if (!currentMeta) return
    const roots = orderedRoots()
    const at = roots.findIndex((m) => m.eventId === currentMeta!.eventId)
    if (at < 0) return
    const next = roots[(at + dir + roots.length) % roots.length]
    router.go({ name: 'viewer', id: next.eventId })
  }

  async function downloadCurrent(): Promise<void> {
    if (!currentMeta) return
    const blob = await assets.getModel(currentMeta)
    if (!blob) { showToast('download failed'); return }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = currentMeta.filename || currentMeta.eventId + '.glb'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  }

  function toggleDrawer(): void {
    drawer.hidden = !drawer.hidden
    document.body.classList.toggle('drawer-open', !drawer.hidden)
    if (!drawer.hidden && currentMeta) fillDrawer(currentMeta)
  }

  function fillDrawer(meta: ThreadMeta): void {
    const s = viewer.stats()
    const lines = [
      `id            ${meta.eventId}`,
      `pubkey        ${meta.pubkey}`,
      `created_at    ${new Date(meta.createdAt * 1000).toISOString()}`,
      `sha256        ${meta.sha256}`,
      `bytes         ${meta.size}`,
      `mime          ${meta.mime}`,
      `role          ${meta.role}`,
      meta.refs.rootId ? `root          ${meta.refs.rootId}` : null,
      meta.refs.parentId ? `parent        ${meta.refs.parentId}` : null,
      meta.filename ? `filename      ${meta.filename}` : null,
      meta.sourceFormat ? `source-format ${meta.sourceFormat}` : null,
      '',
      `meshes        ${s.meshes}`,
      `vertices      ${s.vertices}`,
      `animations    ${s.animations}`,
      `cameras       ${s.cameras}`,
      '',
      ...meta.urls.map((u, i) => `url[${i}]        ${u}`),
    ]
    metaText.textContent = lines.filter((l): l is string => l !== null).join('\n')
  }

  let mode: Mode = 'boot'
  function setMode(next: Exclude<Mode, 'boot'>): void {
    if (mode === next) return
    mode = next
    if (next !== 'thread') threadView.detach()
    if (next !== 'viewer') {
      viewerNav++
      setLoading('model', false)
      viewer.clear()
    }
    studioEl.hidden = next !== 'studio'
    threadZoom.hidden = next !== 'thread'
    if (next === 'board') {
      engine.setActiveScene(board.scene)
      topbar.hidden = false
      viewerBar.hidden = true
      drawer.hidden = true
      document.body.classList.remove('drawer-open')
      viewer.detach()
      studio.detach()
    } else if (next === 'viewer') {
      engine.setActiveScene(viewer.scene)
      topbar.hidden = false
      viewerBar.hidden = false
      viewer.attach()
      studio.detach()
    } else if (next === 'thread') {
      engine.setActiveScene(threadView.scene)
      topbar.hidden = false
      viewerBar.hidden = true
      drawer.hidden = true
      document.body.classList.remove('drawer-open')
      viewer.detach()
      studio.detach()
      threadView.attach()
    } else {
      engine.setActiveScene(studio.scene)
      topbar.hidden = false
      viewerBar.hidden = true
      viewer.detach()
      studio.attach()
    }
  }

  async function openViewer(id?: string): Promise<void> {
    if (!id) { setMode('board'); return }
    const meta = index.byId.get(id)
    if (!meta) { setMode('board'); return }
    const nav = ++viewerNav
    currentMeta = meta
    syncDeleteButton()
    setMode('viewer')
    camDots.innerHTML = ''
    // Try to hand off the live preview pool's parsed container BEFORE the
    // loading indicator. If the post is currently animating on a card, the
    // pool already has the GLB parsed in previewScene; cloning it into
    // viewer.scene is far cheaper than re-parsing and avoids the
    // "loading model" flash on what was already on screen.
    const live = board.previewPool.acquire(id)
    if (live) {
      try {
        const container = handoffContainer(live.container, board.previewPool.scene, viewer.scene, live.offset, 'viewer')
        // At this point the clones live in viewer.scene and the source
        // container is disposed. ANY return below this point MUST commit
        // (otherwise the preview slot stays bound to a now-empty source).
        if (nav !== viewerNav) {
          // The user navigated away while we were cloning (unlikely but
          // possible across async boundaries). The viewer is about to be
          // cleared by the next setMode anyway; just commit to release the
          // preview slot and let the viewer tear-down dispose the clones.
          live.commit()
          return
        }
        viewer.loadFromContainer(container, meta)
        if (nav !== viewerNav) {
          live.commit()
          return
        }
        renderCamDots()
        syncPlay()
        live.commit()
        return
      } catch (err) {
        // Hand-off failed (e.g. parse result lost a mesh). Rollback the
        // reservation so the slot is back to live-animating, then fall
        // through to the bytes path — the user still gets a working
        // viewer (with a re-parse).
        console.warn('viewer handoff failed, falling back to parse:', err)
        live.rollback()
      }
    }
    setLoading('model', true, 'loading model')
    try {
      const bytes = await assets.getModelBytes(meta)
      if (nav !== viewerNav) return
      if (!bytes) { errorSheet.show(ERRORS.MODEL_DOWNLOAD(() => void openViewer(id))); return }
      await viewer.load(bytes, meta)
      if (nav !== viewerNav) return
      renderCamDots()
      syncPlay()
    } catch {
      if (nav === viewerNav) errorSheet.show(ERRORS.MODEL_PARSE(() => router.go({ name: 'board' })))
    } finally {
      if (nav === viewerNav) setLoading('model', false)
    }
  }

  function applyRoute(route = router.current): void {
    if (route.name === 'board') setMode('board')
    else if (route.name === 'thread') {
      setMode('thread')
      setLoading('thread', true, 'building thread')
      void threadView.open(route.rootId).finally(() => setLoading('thread', false))
    }
    else if (route.name === 'viewer') void openViewer(route.id)
    else if (route.name === 'studio') {
      studioReply = route.rootId && route.parentId ? { rootId: route.rootId, parentId: route.parentId } : null
      setMode('studio')
      studio.clearModel()
      studioFilename.textContent = ''
      // Upload tab first: the import drop zone must be visible immediately.
      // (Opening on TYPE hid "choose model" behind a tab switch; the text
      // tab still seeds '/0' the first time it is opened.)
      setStudioTab('upload')
      studioText.value = ''
      studio.setText('')
      btnStudioPublish.disabled = true
      // reset text settings UI to defaults
      const opts = studio.textOptions
      ;(document.getElementById('text-scale') as HTMLInputElement).value = String(opts.scale)
      ;(document.getElementById('text-tracking') as HTMLInputElement).value = String(opts.letterSpacing)
      ;(document.getElementById('text-leading') as HTMLInputElement).value = String(opts.lineSpacing)
      ;(document.getElementById('text-extrude') as HTMLInputElement).value = String(opts.depth)
      setStudioStatus(studioReply ? 'replying…' : '')
      refreshCameraControls()
      updateTextBudget()
    }
    else if (route.name === 'network') {
      setMode('board')
      networkPanel.open(() => { if (router.current.name === 'network') router.go({ name: 'board' }) })
    }
    if (route.name !== 'network' && networkPanel.isOpen) networkPanel.close()
  }
  router.subscribe(applyRoute)
  applyRoute()

  setLoading('feed', true, 'connecting')

  let refreshQueued = false
  function refreshBoard(): void {
    if (refreshQueued) return
    refreshQueued = true
    requestAnimationFrame(() => {
      refreshQueued = false
      const roots = orderedRoots()
      board.setMetas(roots)
      for (const m of roots) board.setReplyCount(m.eventId, index.childCount(m.eventId))
    })
  }

  pool.onEvent = (event) => {
    if (event.kind === 5) {
      for (const t of event.tags) {
        if (t[0] !== 'e') continue
        const target = index.byId.get(t[1])
        if (target && target.pubkey === event.pubkey) index.tombstone(t[1])
      }
      refreshBoard()
      return
    }
    const meta = parseModelEvent(event)
    if (!meta) return
    index.add(meta)
    setLoading('feed', false)
    refreshBoard()
  }
  let warnedOffline = false
  pool.onState = () => {
    const states = [...pool.state.values()]
    const online = states.filter((s) => s === 'online').length
    const state = online === 0 ? 'none' : online < pool.relayUrls.length ? 'partial' : 'online'
    const color = { none: theme.muted, partial: theme.warning, online: theme.success }[state]
    netDot.style.background = color
    netDot.title = `${online}/${pool.relayUrls.length} relays`
    const allOffline = states.length >= pool.relayUrls.length && states.every((s) => s === 'offline')
    if (allOffline && !warnedOffline) {
      warnedOffline = true
      errorSheet.show(ERRORS.RELAYS_OFFLINE(() => router.go({ name: 'network' })))
    }
    if (online > 0) warnedOffline = false
  }

  pool.connect()

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && errorSheet.isOpen) { errorSheet.hide(); return }
    if (e.key === 'Escape' && networkPanel.isOpen) { networkPanel.close(); return }
    // Typing guard: while focus is in an editable control (settings inputs,
    // the studio textarea, a search box…), game hotkeys must NOT fire —
    // arrow keys were switching models while the user edited the preview
    // width in settings. The editable control handles its own keys.
    const target = e.target as HTMLElement | null
    const tag = (target?.tagName ?? '').toUpperCase()
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable === true) return
    if (mode === 'thread') {
      if (e.key === 'Escape') router.go({ name: 'board' })
      if (e.key === '0') threadView.fit()
      if (e.key === '+' || e.key === '=') threadView.zoomBy(1.25)
      if (e.key === '-' || e.key === '_') threadView.zoomBy(1 / 1.25)
      return
    }
    if (mode === 'studio') {
      const tag = (document.activeElement?.tagName || '').toUpperCase()
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA'
      if (!isInput) {
        if (e.key === 'w' || e.key === 'W') {
          studio.setTransformMode('position')
          document.querySelectorAll<HTMLButtonElement>('[data-xform]').forEach((x) => x.classList.toggle('active', x.dataset.xform === 'position'))
        } else if (e.key === 'e' || e.key === 'E') {
          studio.setTransformMode('rotation')
          document.querySelectorAll<HTMLButtonElement>('[data-xform]').forEach((x) => x.classList.toggle('active', x.dataset.xform === 'rotation'))
        } else if (e.key === 'r' || e.key === 'R') {
          studio.setTransformMode('scale')
          document.querySelectorAll<HTMLButtonElement>('[data-xform]').forEach((x) => x.classList.toggle('active', x.dataset.xform === 'scale'))
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          studio.deleteSelection()
        } else if (e.key === 'Escape') {
          if (studio.selected) studio.select(null)
          else router.go({ name: 'board' })
        }
      }
      return
    }
    if (mode !== 'viewer') return
    switch (e.key) {
      case 'Escape': router.go({ name: 'board' }); break
      case 'ArrowLeft': void stepViewer(-1); break
      case 'ArrowRight': void stepViewer(1); break
      case 'c': case 'C': viewer.cycleCamera(); renderCamDots(); break
      case 'a': case 'A': viewer.toggleAnimation(); syncPlay(); break
      case 'm': case 'M': toggleDrawer(); break
      case 't': case 'T':
        if (currentMeta) router.go({ name: 'thread', rootId: currentMeta.refs.rootId ?? currentMeta.eventId })
        break
    }
  })

  window.addEventListener('resize', () => { engine.resize(); board.resize(); threadView.resize(); viewer.resize() })

  ;(window as any).__form0 = {
    engine, pool, blossoms, index, board, viewer, studio, threadView, router, assets,
    legend, networkPanel, errorSheet, settings, settingsPanel, graphics, mixer, caps,
  }
}

boot().catch((err) => console.error(err))
