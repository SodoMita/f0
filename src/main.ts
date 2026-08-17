import './style.css'
import { FormEngine } from './core/engine'
import { Router } from './core/router'
import { RelayPool } from './protocol/nostr'
import { BlossomClient } from './protocol/blossom'
import { parseModelEvent } from './protocol/events'
import { ThreadIndex, type ThreadMeta } from './protocol/thread-index'
import { Board } from './board/board'
import { detectCardFlipsOnBoard, setGlobalFlips } from './board/cardMaterial'
import { ThreadView } from './board/threadView'
import { Viewer } from './viewer/viewer'
import { Studio } from './studio/studio'
import { AssetCache } from './core/assets'
import { configureDraco } from './model/draco'
import { enforceOffline } from './model/offline'
import { DEFAULTS, theme } from './theme'
import { loadNetworkConfig, loadSettings, saveSettings } from './protocol/storage'

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
  // Calibrate the horizontal orientation of the card pipeline per texture
  // kind for THIS driver (left-right mirroring differs per GPU/kind). The
  // probe is anchored to the real board (empty at boot, relays connect later)
  // so it measures the exact framebuffer the user sees.
  const flips = await detectCardFlipsOnBoard(engine.engine, board.scene)
  setGlobalFlips(flips)
  const assets = new AssetCache(blossoms, board.scene)
  board.setAssets(assets)
  const viewer = new Viewer(engine)
  const studio = new Studio(engine)
  const threadView = new ThreadView(engine)
  threadView.setup(assets, index, (meta) => router.go({ name: 'viewer', id: meta.eventId }))

  // ---------- HTML HUD ----------
  const topbar = $('topbar')
  const viewerBar = $('viewer-bar')
  const drawer = $('meta-drawer')
  const netDot = $('net-dot')
  const btnPlay = $('btn-play') as HTMLButtonElement
  const camDots = $('cam-dots')
  const metaText = $('meta-text')
  const toast = $('toast')

  let toastTimer = 0
  function showToast(msg: string): void {
    toast.textContent = msg
    toast.hidden = false
    clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => { toast.hidden = true }, 3200)
  }

  let currentMeta: ThreadMeta | null = null

  const orderedRoots = (): ThreadMeta[] =>
    [...index.byId.values()]
      .filter((m) => m.role === 'root' && !m.tombstoned)
      .sort((a, b) => b.createdAt - a.createdAt) // newest post on top

  $('btn-home').addEventListener('click', () => router.go({ name: 'board' }))
  $('btn-add').addEventListener('click', () => router.go({ name: 'studio' }))
  $('btn-shuffle').addEventListener('click', () => board.shuffle(orderedRoots()))
  $('btn-close').addEventListener('click', () => router.go({ name: 'board' }))
  $('btn-prev').addEventListener('click', () => void stepViewer(-1))
  $('btn-next').addEventListener('click', () => void stepViewer(1))
  btnPlay.addEventListener('click', () => { viewer.toggleAnimation(); syncPlay() })
  $('btn-thread').addEventListener('click', () => {
    if (currentMeta) router.go({ name: 'thread', rootId: currentMeta.refs.rootId ?? currentMeta.eventId })
  })
  $('btn-download').addEventListener('click', () => void downloadCurrent())
  $('btn-meta').addEventListener('click', toggleDrawer)
  $('btn-meta-close').addEventListener('click', () => { drawer.hidden = true })

  // ---------- settings (HTML) ----------
  const settingsPanel = $('settings-panel')
  function applyBackground(hex: string): void {
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
    btnPlay.textContent = viewer.isPlaying() ? '⏸' : '▶'
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
    if (next === 'board') {
      engine.setActiveScene(board.scene)
      topbar.hidden = false
      viewerBar.hidden = true
      drawer.hidden = true
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
      viewer.detach()
      studio.detach()
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
    currentMeta = meta
    setMode('viewer')
    const blob = await assets.getModel(meta)
    if (blob) {
      try {
        await viewer.load(blob, meta)
        renderCamDots()
        syncPlay()
      } catch {
        showToast('model failed to load')
      }
    } else {
      showToast('model download failed')
    }
  }

  function applyRoute(route = router.current): void {
    if (route.name === 'board') setMode('board')
    else if (route.name === 'thread') {
      setMode('thread')
      void threadView.open(route.rootId)
    }
    else if (route.name === 'viewer') void openViewer(route.id)
    else if (route.name === 'studio') setMode('studio')
    else if (route.name === 'network') setMode('board')
  }
  router.subscribe(applyRoute)
  applyRoute()

  // ---------- network ----------
  pool.onEvent = (event) => {
    if (event.kind === 5) {
      for (const t of event.tags) if (t[0] === 'e') index.tombstone(t[1])
      return
    }
    const meta = parseModelEvent(event)
    if (!meta) return
    index.add(meta)
    board.setMetas(orderedRoots())
    for (const m of orderedRoots()) board.setReplyCount(m.eventId, index.childCount(m.eventId))
  }
  pool.onState = () => {
    const states = [...pool.state.values()]
    const online = states.filter((s) => s === 'online').length
    const state = online === 0 ? 'none' : online < pool.relayUrls.length ? 'partial' : 'online'
    const color = { none: theme.muted, partial: theme.warning, online: theme.success }[state]
    netDot.style.background = color
    netDot.title = `${online}/${pool.relayUrls.length} relays`
  }

  pool.connect()

  // ---------- keyboard (viewer) ----------
  window.addEventListener('keydown', (e) => {
    if (mode === 'thread') {
      if (e.key === 'Escape') router.go({ name: 'board' })
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

  window.addEventListener('resize', () => { engine.resize(); board.resize() })

  ;(window as any).__form0 = { engine, pool, blossoms, index, board, viewer, studio, threadView, router, assets, flips }
}

boot().catch((err) => console.error(err))
