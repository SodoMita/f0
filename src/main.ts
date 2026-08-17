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
import { loadNetworkConfig, loadSettings, saveSettings, listOwnedPosts, type OwnedPostRecord } from './protocol/storage'
import { hexToBytes } from './util/hex'
import { DELETE_KIND } from './theme'
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
  threadView.setup(
    assets, index,
    (meta) => router.go({ name: 'viewer', id: meta.eventId }),
    // reply pill on a thread node -> studio compose, replying to THAT node
    (meta) => {
      const rootId = meta.refs.rootId ?? meta.eventId
      router.go({ name: 'studio', rootId, parentId: meta.eventId })
    },
  )

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
  const studioEditor = $('studio-editor')
  const studioText = $('studio-text') as HTMLInputElement
  const studioAlign = $('studio-align') as HTMLButtonElement
  const camAlpha = $('cam-alpha') as HTMLInputElement
  const camBeta = $('cam-beta') as HTMLInputElement
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
    fileInput.accept = '.glb'
    fileInput.multiple = false
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0]
      // Restore the shared input to its neutral state.
      fileInput.accept = prevAccept
      fileInput.multiple = prevMultiple
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
    }, { once: true })
    // File dialog must open from a trusted click.
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
      // registered as owned immediately (publishModel saved the record)
      void listOwnedPosts().then((list) => {
        for (const rec of list) owned.set(rec.eventId, rec)
      })
      // Open the freshly published model.
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

  // ---- Studio text + camera settings ----
  const ALIGN_CYCLE: Array<'left' | 'center' | 'right'> = ['left', 'center', 'right']
  let alignIdx = 1
  function refreshCameraSliders(): void {
    const c = studio.getCameraState()
    camAlpha.value = String(c.alpha)
    camBeta.value = String(c.beta)
    camRadius.value = String(c.radius)
  }
  let textTimer = 0
  studioText.addEventListener('input', () => {
    studio.setText(studioText.value)
    btnStudioPublish.disabled = !studio.hasContent()
    clearTimeout(textTimer)
    textTimer = window.setTimeout(() => { studio.rebuildText(); refreshCameraSliders() }, 120)
  })
  studioAlign.addEventListener('click', () => {
    alignIdx = (alignIdx + 1) % ALIGN_CYCLE.length
    studio.setTextAlign(ALIGN_CYCLE[alignIdx])
    studioAlign.textContent = ALIGN_CYCLE[alignIdx][0].toUpperCase()
    studio.rebuildText()
  })
  for (const [el, key] of [[camAlpha, 'alpha'], [camBeta, 'beta'], [camRadius, 'radius']] as const) {
    el.addEventListener('input', () => studio.setCameraState({ [key]: Number(el.value) }))
  }
  document.querySelector<HTMLButtonElement>('[data-cam=frame]')?.addEventListener('click', () => {
    studio.frameCamera(); refreshCameraSliders()
  })
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

  // ---------- deletion (owned posts only) ----------
  // ownedPosts holds the per-post signing secret; only those posts can emit
  // a valid kind-5 (relays check the pubkey). The button stays hidden for
  // everything else — wordless UI shows no dead controls.
  const owned = new Map<string, OwnedPostRecord>()
  void listOwnedPosts().then((list) => {
    for (const rec of list) owned.set(rec.eventId, rec)
    syncDeleteButton()
  })
  const vbtnDelete = $('vbtn-delete')
  function syncDeleteButton(): void {
    vbtnDelete.hidden = !(currentMeta && owned.has(currentMeta.eventId))
  }
  let deleting = false
  $('btn-delete').addEventListener('click', () => {
    if (!currentMeta || deleting) return
    const rec = owned.get(currentMeta.eventId)
    if (!rec) return
    errorSheet.show({
      code: 'D001',
      cause: 'Delete this post? A kind-5 tombstone is published to your relays. Servers may keep the bytes; deletion hides, it does not destroy (spec SECURITY).',
      action: 'delete post',
      onAction: () => { void doDelete(rec) },
    })
  })
  async function doDelete(rec: OwnedPostRecord): Promise<void> {
    deleting = true
    try {
      const { ok, failed } = await pool.publish(
        {
          kind: DELETE_KIND,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['e', rec.eventId]],
          content: '',
        },
        hexToBytes(rec.secretKey),
      )
      // local tombstone immediately — the feed must not wait for the relays
      index.tombstone(rec.eventId)
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
    studioEditor.hidden = next !== 'studio'
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
    setLoading('model', true, 'loading model')
    try {
      const bytes = await assets.getModelBytes(meta)
      if (nav !== viewerNav) return
      // error sheet, not a toast: code + cause + concrete action (spec)
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
      // Fresh composer each time (drop the previous import/text).
      studio.clearModel()
      studioFilename.textContent = ''
      studioText.value = '/0'
      studio.setText('/0')
      studio.setTextAlign('center')
      studioAlign.textContent = 'C'
      studio.rebuildText()
      btnStudioPublish.disabled = false
      setStudioStatus(studioReply ? 'replying…' : '')
      refreshCameraSliders()
    }
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

  // Relay bursts arrive dozens of events at a time. Coalesce them into one
  // board refresh per frame instead of one full re-sort + re-layout +
  // badge-repaint-per-root per event.
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
      for (const t of event.tags) if (t[0] === 'e') index.tombstone(t[1])
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
