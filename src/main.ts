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
import { loadNetworkConfig, loadSettings, saveSettings } from './protocol/storage'
import { Legend } from './hud/legend'
import { NetworkPanel } from './hud/networkPanel'
import { ErrorSheet, ERRORS } from './hud/errorSheet'

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
  const settings = await loadSettings()

  const board = new Board(engine, {
    onOpenModel: (meta) => router.go({ name: 'viewer', id: meta.eventId }),
    onOpenThread: (meta) => router.go({ name: 'thread', rootId: meta.refs.rootId ?? meta.eventId }),
  })
  // Card orientation is deterministic now (flat cameras sit at -Z, see
  // core/gfx.flatCamera) — no boot-time GPU probing, no guessing.
  const assets = new AssetCache(blossoms, board.scene)
  board.setAssets(assets)
  const viewer = new Viewer(engine)
  const studio = new Studio(engine)
  const threadView = new ThreadView(engine)
  threadView.setup(assets, index, (meta) => router.go({ name: 'viewer', id: meta.eventId }))

  // ---------- HUD modules (legend / network / errors) ----------
  const legend = new Legend()
  const networkPanel = new NetworkPanel(pool, blossoms)
  const errorSheet = new ErrorSheet()
  void legend.maybeShowFirstRun()

  // ---------- HTML HUD ----------
  const topbar = $('topbar')
  const viewerBar = $('viewer-bar')
  const drawer = $('meta-drawer')
  const studioBar = $('studio-bar')
  const studioFilename = $('studio-filename')
  const studioStatus = $('studio-status')
  const btnStudioImport = $('btn-studio-import') as HTMLButtonElement
  const btnStudioPublish = $('btn-studio-publish') as HTMLButtonElement
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
    if (on) loadingReasons.add(reason)
    else loadingReasons.delete(reason)
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
  // Every viewer navigation takes a ticket. A download/parse that finishes
  // after the user has moved on must not paint into the current view (that is
  // how two models ended up stacked in the single-model viewer).
  let viewerNav = 0

  const orderedRoots = (): ThreadMeta[] =>
    [...index.byId.values()]
      .filter((m) => m.role === 'root' && !m.tombstoned)
      .sort((a, b) => b.createdAt - a.createdAt) // newest post on top

  $('btn-home').addEventListener('click', () => router.go({ name: 'board' }))
  netDot.addEventListener('click', () => router.go({ name: 'network' }))
  $('btn-add').addEventListener('click', () => router.go({ name: 'studio' }))
  $('btn-shuffle').addEventListener('click', () => board.shuffle(orderedRoots()))

  // ---------- studio (import + publish) ----------
  function setStudioStatus(text: string, cls = ''): void {
    studioStatus.textContent = text
    studioStatus.className = 'studio-status ' + cls
  }

  async function pickStudioFile(): Promise<void> {
    fileInput.value = ''
    fileInput.accept = '.glb'
    fileInput.onchange = async () => {
      const file = fileInput.files?.[0]
      if (!file) return
      try {
        setStudioStatus('importing…', 'busy')
        const imported = await studio.importGLB(file)
        studioFilename.textContent = file.name
        btnStudioPublish.disabled = false
        setStudioStatus(`${imported.report.stats.meshes} mesh · ${(file.size / 1048576).toFixed(1)} MiB`)
      } catch (err) {
        setStudioStatus(err instanceof Error ? err.message : 'import failed', 'err')
      }
    }
    // File dialog must open from a trusted click.
    fileInput.click()
  }

  async function publishStudio(): Promise<void> {
    if (publishing) return
    const imported = studio.currentModel
    if (!imported) return
    publishing = true
    btnStudioPublish.disabled = true
    try {
      setStudioStatus('poster…', 'busy')
      const poster = await assets.renderPosterFor(imported.file)
      const onProgress = (p: PublishProgress) => {
        if (p.stage === 'blossom') setStudioStatus('upload…', 'busy')
        else if (p.stage === 'relay') setStudioStatus('nostr…', 'busy')
        else if (p.stage === 'done') setStudioStatus(`done · ${p.ok ?? 0}/${(p.ok ?? 0) + (p.failed ?? 0)}`, p.failed ? 'err' : 'ok')
        else if (p.stage === 'error') setStudioStatus(p.detail ?? 'failed', 'err')
      }
      const result = await publishModel(
        {
          model: imported.file,
          poster,
          tint: studio.tintColor,
          filename: imported.file.name,
          sourceFormat: 'glb',
          cameraCount: imported.report.stats.cameras,
          hasAnimation: imported.report.stats.animations > 0,
        },
        { relays: pool.relayUrls, blossoms: blossoms.servers, pool, onProgress: onProgress },
      )
      // Open the freshly published model.
      router.go({ name: 'viewer', id: result.eventId })
    } catch (err) {
      setStudioStatus(err instanceof Error ? err.message : 'publish failed', 'err')
      btnStudioPublish.disabled = false
    } finally {
      publishing = false
    }
  }

  btnStudioImport.addEventListener('click', () => void pickStudioFile())
  btnStudioPublish.addEventListener('click', () => void publishStudio())
  $('btn-close').addEventListener('click', () => router.go({ name: 'board' }))
  $('btn-prev').addEventListener('click', () => void stepViewer(-1))
  $('btn-next').addEventListener('click', () => void stepViewer(1))
  btnPlay.addEventListener('click', () => { viewer.toggleAnimation(); syncPlay() })
  $('btn-thread').addEventListener('click', () => {
    if (currentMeta) router.go({ name: 'thread', rootId: currentMeta.refs.rootId ?? currentMeta.eventId })
  })
  $('btn-download').addEventListener('click', () => void downloadCurrent())
  $('btn-meta').addEventListener('click', toggleDrawer)
  $('btn-meta-close').addEventListener('click', () => {
    drawer.hidden = true
    document.body.classList.remove('drawer-open')
  })

  // ---------- settings (HTML) ----------
  const settingsPanel = $('settings-panel')
  function applyBackground(hex: string): void {
    // HUD ink follows the backdrop so a light board is still readable
    document.body.dataset.theme = luminance(hex) < 0.5 ? 'dark' : 'light'
    board.setBackground(hex)
    viewer.setBackground(hex)
    studio.setBackground(hex)
    threadView.setBackground(hex)
    settings.background = hex
    void saveSettings(settings)
    document.querySelectorAll('#bg-swatches .swatch').forEach((el) => {
      el.classList.toggle('active', (el as HTMLElement).dataset.bg === hex)
    })
    ;(document.getElementById('bg-custom') as HTMLInputElement).value = hex
  }
  const inertiaSlider = document.getElementById('inertia') as HTMLInputElement
  inertiaSlider.addEventListener('input', () => {
    settings.inertia = Number(inertiaSlider.value) / 100
    board.setInertia(settings.inertia)
    void saveSettings(settings)
  })
  $('btn-settings').addEventListener('click', () => { settingsPanel.hidden = !settingsPanel.hidden })
  $('btn-settings-close').addEventListener('click', () => { settingsPanel.hidden = true })
  document.querySelectorAll('#bg-swatches .swatch').forEach((el) => {
    el.addEventListener('click', () => applyBackground((el as HTMLElement).dataset.bg!))
  })
  ;(document.getElementById('bg-custom') as HTMLInputElement).addEventListener('input', (e) => {
    applyBackground((e.target as HTMLInputElement).value)
  })
  applyBackground(settings.background || '#0B0B0C')
  if (inertiaSlider) {
    inertiaSlider.value = String(Math.round((settings.inertia ?? 0.7) * 100))
    board.setInertia(settings.inertia ?? 0.7)
  }

  function syncPlay(): void {
    // the button holds both icons; CSS swaps them (no glyph swapping)
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
    mk('A', -1) // auto / orbit
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

  // ---------- modes ----------
  let mode: Mode = 'boot'
  function setMode(next: Exclude<Mode, 'boot'>): void {
    if (mode === next) return
    mode = next
    if (next !== 'thread') threadView.detach()
    if (next !== 'viewer') {
      viewerNav++            // abandon any in-flight model load
      setLoading('model', false)
      viewer.clear()
    }
    studioBar.hidden = next !== 'studio'
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
    setMode('viewer')
    camDots.innerHTML = ''
    setLoading('model', true, 'loading model')
    try {
      const blob = await assets.getModel(meta)
      if (nav !== viewerNav) return
      // error sheet, not a toast: code + cause + concrete action (spec)
      if (!blob) { errorSheet.show(ERRORS.MODEL_DOWNLOAD(() => void openViewer(id))); return }
      await viewer.load(blob, meta)
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
    else if (route.name === 'studio') setMode('studio')
    else if (route.name === 'network') {
      setMode('board')
      networkPanel.open(() => { if (router.current.name === 'network') router.go({ name: 'board' }) })
    }
    if (route.name !== 'network' && networkPanel.isOpen) networkPanel.close()
  }
  router.subscribe(applyRoute)
  applyRoute()

  // ---------- network ----------
  setLoading('feed', true, 'connecting')
  pool.onEvent = (event) => {
    if (event.kind === 5) {
      for (const t of event.tags) if (t[0] === 'e') index.tombstone(t[1])
      return
    }
    const meta = parseModelEvent(event)
    if (!meta) return
    index.add(meta)
    setLoading('feed', false)
    board.setMetas(orderedRoots())
    for (const m of orderedRoots()) board.setReplyCount(m.eventId, index.childCount(m.eventId))
  }
  let warnedOffline = false
  pool.onState = () => {
    const states = [...pool.state.values()]
    const online = states.filter((s) => s === 'online').length
    const state = online === 0 ? 'none' : online < pool.relayUrls.length ? 'partial' : 'online'
    const color = { none: theme.muted, partial: theme.warning, online: theme.success }[state]
    netDot.style.background = color
    netDot.title = `${online}/${pool.relayUrls.length} relays`
    // E201 once ALL relays report offline (not during initial connecting)
    const allOffline = states.length >= pool.relayUrls.length && states.every((s) => s === 'offline')
    if (allOffline && !warnedOffline) {
      warnedOffline = true
      errorSheet.show(ERRORS.RELAYS_OFFLINE(() => router.go({ name: 'network' })))
    }
    if (online > 0) warnedOffline = false
  }

  pool.connect()

  // ---------- keyboard (viewer) ----------
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && errorSheet.isOpen) { errorSheet.hide(); return }
    if (e.key === 'Escape' && networkPanel.isOpen) { networkPanel.close(); return }
    if (mode === 'thread') {
      if (e.key === 'Escape') router.go({ name: 'board' })
      if (e.key === '0') threadView.fit()
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

  window.addEventListener('resize', () => { engine.resize(); board.resize(); threadView.resize() })

  ;(window as any).__form0 = { engine, pool, blossoms, index, board, viewer, studio, threadView, router, assets, legend, networkPanel, errorSheet }
}

boot().catch((err) => console.error(err))
