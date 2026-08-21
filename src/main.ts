import './style.css'
import './studio/exportReview.css'
import { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine'
import { AudioEngine } from '@babylonjs/core/Audio/audioEngine'
import { FormEngine } from './core/engine'
import { Router, type Route } from './core/router'
import { RelayPool } from './protocol/nostr'
import { BlossomClient } from './protocol/blossom'
import { parseModelEvent } from './protocol/events'
import { ThreadIndex, matchesSearchQuery, type ThreadMeta } from './protocol/thread-index'
import { Board } from './board/board'
import { ThreadView } from './board/threadView'
import { Viewer } from './viewer/viewer'
import { Studio } from './studio/studio'
import { AssetCache } from './core/assets'
import { publishModel, type PublishProgress } from './protocol/publish'
import { isAbortError } from './protocol/hash'
import { configureDraco } from './model/draco'
import { validateGLB } from './model/limits'
import { enforceOffline } from './model/offline'
import { DEFAULTS, LIMITS, POSTER_W, POSTER_H, theme } from './theme'
import { drawPosterPixels } from './model/poster'
import { luminance } from './core/gfx'
import { listOwnedPosts, loadNetworkConfig, markOwnedPostTombstoned, ownedToMeta } from './protocol/storage'
import { DeletionService } from './protocol/deletion'
import { SettingsStore } from './settings/store'
import { SettingsPanel } from './settings/panel'
import { detectCapabilities } from './settings/capabilities'
import { applySettings } from './settings/apply'
import { graphics } from './render/graphics'
import { mixer } from './audio/mixer'
import { Legend } from './hud/legend'
import { NetworkPanel } from './hud/networkPanel'
import { ErrorSheet, ERRORS, bindCopyButton } from './hud/errorSheet'
import { attachAllDragNumbers } from './studio/dragNumber'
import { transfers, formatRate, formatBytes, formatDirStats, type TransferStats } from './core/transfer'
import { handoffContainer } from './core/sceneTransfer'
import { bindPaintHud } from './studio/paintHud'
import { formatCount, formatSize, modelNameForPublish, modelWarnings, sizeHeatColor } from './studio/modelInfo'
import type { ImportedModel } from './studio/studio'
import { bindLibraryHud } from './studio/library/hud'
import { exportBreakdown, inspectGLB, type GLBExportInfo } from './studio/exportInfo'
import { compressGLB, type CompressReport } from './model/compressGlb'
import { configureDracoEncoder, dracoCodec, dracoEncoderReady } from './model/dracoEncode'
import { webpCodec, webpEncoderSupported } from './model/webpEncode'

type Mode = 'boot' | 'board' | 'viewer' | 'studio' | 'thread'

function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement
}

async function boot(): Promise<void> {
  enforceOffline()
  configureDraco()
  configureDracoEncoder() // local wasm URLs only; no cdn.babylonjs.com

  // Settings BEFORE the engine: the GPU power preference is a context-creation
  // option, so boot is the only place it can take effect (settings: deferred).
  const settings = new SettingsStore()
  await settings.load()

  // Route post audio (MSFT_audio_emitter Sounds created by the GLB loader)
  // through the app mixer: Babylon builds every Sound on a page-wide
  // AudioEngine singleton — point it at OUR AudioContext + master bus so
  // master volume and mute-on-blur apply to model sound too. Must exist
  // BEFORE the first GLB with audio is parsed, or decode is skipped.
  try {
    const ctx = mixer.ensureContext()
    if (ctx) {
      // AudioEngine's `audioDestination` is only ever used as a connect()
      // target (masterGain.connect(dest)), so our master GainNode works at
      // runtime despite the narrower .d.ts type.
      const dest = mixer.masterOutput() as AudioDestinationNode | null
      AbstractEngine.audioEngine = new AudioEngine(null, ctx, dest)
    }
  } catch {
    // audio unavailable — posts stay silent, nothing else breaks
  }

  const canvas = $('engine') as HTMLCanvasElement
  let engine: FormEngine
  try {
    engine = FormEngine.create(canvas, { powerPreference: settings.get('powerPreference') as 'default' | 'high-performance' | 'low-power' })
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

  const board = new Board(engine, {
    onOpenModel: (meta) => router.go({ name: 'viewer', id: meta.eventId }),
    onOpenThread: (meta) => router.go({ name: 'thread', rootId: meta.refs.rootId ?? meta.eventId }),
  })
  const assets = new AssetCache(blossoms, board.scene)
  board.setAssets(assets)
  const viewer = new Viewer(engine)
  const studio = new Studio(engine)
  const threadView = new ThreadView(engine, board.live)
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
  const symbolColor = $('symbol-color') as HTMLInputElement
  const textScale = $('text-scale') as HTMLInputElement
  const textTracking = $('text-tracking') as HTMLInputElement
  const textLeading = $('text-leading') as HTMLInputElement
  const textExtrude = $('text-extrude') as HTMLInputElement
  const textBudget = $('text-budget')
  const camTarget = (['cam-tx','cam-ty','cam-tz'] as const).map((id) => $(id) as HTMLInputElement)
  const camYaw = $('cam-yaw') as HTMLInputElement
  const camPitch = $('cam-pitch') as HTMLInputElement
  const camFov = $('cam-fov') as HTMLInputElement
  const camRadius = $('cam-radius') as HTMLInputElement
  const fileInput = $('file-input') as HTMLInputElement
  let publishing = false
  let publishAbort: AbortController | null = null
  // A review is a frozen export snapshot. It is invalidated by every Studio
  // edit, so preview/download/publish cannot disagree about the bytes.
  // `pristineExport` is that snapshot BEFORE codecs; a codec choice always
  // re-derives from the same pristine bytes, so switching back and forth is
  // deterministic and the reviewed/downloaded/published bytes stay identical.
  type ExportSnapshot = { blob: Blob; filename: string; sourceFormat: 'glb' | 'gltf' | 'obj' | 'generated' }
  let reviewedExport: ExportSnapshot | null = null
  let pristineExport: (ExportSnapshot & { info: GLBExportInfo }) | null = null
  const exportReview = $('export-review')
  const exportSummary = $('export-summary')
  const exportMeter = $('export-meter').firstElementChild as HTMLElement
  const exportBreakdownEl = $('export-breakdown')
  const exportExtensions = $('export-extensions')
  const exportState = $('export-state')
  const exportCodecs = $('export-codecs')
  const exportCodecSettings = $('export-codec-settings')
  const dracoQualityRow = $('draco-quality-row')
  const dracoQuality = $('draco-quality')
  const webpQualityRow = $('webp-quality-row')
  const webpQuality = $('webp-quality') as HTMLInputElement
  const webpQualityLabel = $('webp-quality-label')
  const exportPreview = $('export-preview')
  const exportPreviewRaw = $('export-preview-raw') as HTMLCanvasElement
  const exportPreviewCodec = $('export-preview-codec') as HTMLCanvasElement
  const exportPreviewCodecLabel = $('export-preview-codec-label')
  const exportPreviewDiff = $('export-preview-diff')
  const exportCodecNote = $('export-codec-note')
  const codecGeometry = $('codec-geometry')
  const codecTexture = $('codec-texture')
  const btnExportPublish = $('btn-export-publish') as HTMLButtonElement
  const btnExportDownload = $('btn-export-download') as HTMLButtonElement
  // Codec availability is probed once; controls appear only when the local
  // encoder really works (never advertise a non-working codec control).
  const codecChoice = { geometry: 'none' as 'none' | 'draco', texture: 'none' as 'none' | 'webp' }
  let dracoOn: boolean | null = null
  let webpOn: boolean | null = null
  let exportCodecBusy = false
  let exportCodecToken = 0
  // Choices/settings clicked while a derive is running are queued (same
  // pattern as the studio preview) — a busy pass must never swallow a click.
  let exportCodecQueued = false
  // Fine settings (SPEC AMENDMENT 85): both codecs are LOSSY, so the review
  // renders the compressed bytes next to the raw export and exposes quality.
  const DRACO_PRESETS = {
    high: { POSITION: 14, NORMAL: 10, TANGENT: 12, TEX_COORD: 12, COLOR: 8, GENERIC: 12 },
    balanced: { POSITION: 12, NORMAL: 9, TANGENT: 10, TEX_COORD: 11, COLOR: 8, GENERIC: 11 },
    small: { POSITION: 10, NORMAL: 8, TANGENT: 8, TEX_COORD: 9, COLOR: 6, GENERIC: 9 },
  } as const
  type DracoPreset = keyof typeof DRACO_PRESETS
  let dracoPreset: DracoPreset = 'balanced'
  // Card-rendered preview of the CURRENT pristine export (raw baseline).
  let rawPreview: { pixels: Uint8Array; width: number; height: number } | null = null
  const netDot = $('net-dot')
  let relaysOnline = 0
  const btn3d = $('btn-3d') as HTMLButtonElement
  const btnPlay = $('btn-play') as HTMLButtonElement
  const camDots = $('cam-dots')
  const animRail = $('anim-rail')
  const animTrack = $('anim-track') as HTMLSelectElement
  const animTimeline = $('anim-timeline') as HTMLInputElement
  const animFrame = $('anim-frame')
  const animDir = $('anim-dir') as HTMLButtonElement
  const animStepped = $('anim-stepped') as HTMLButtonElement
  const animSpeed = $('anim-speed') as HTMLInputElement
  const metaText = $('meta-text')
  const toast = $('toast')

  // ---------- loading ring ----------
  const loading = $('loading')
  const loadingLabel = $('loading-label')
  const loadingRate = $('loading-rate')
  const loadingBar = $('loading-bar')
  const loadingBarFill = loadingBar.firstElementChild as HTMLElement
  const loadingReasons = new Set<string>()
  function setLoading(reason: string, on: boolean, label = ''): void {
    if (on === loadingReasons.has(reason)) return
    if (on) loadingReasons.add(reason)
    else loadingReasons.delete(reason)
    engine.kick()
    loading.hidden = loadingReasons.size === 0
    if (!loading.hidden) loadingLabel.textContent = label || reason
    if (loading.hidden) { loadingRate.hidden = true; loadingBar.hidden = true }
    else paintTransfers(transfers.stats())
  }
  ;(window as any).__loading = loadingReasons

  // ---------- live transfer readouts ----------
  // One meter feeds three surfaces: the loading overlay (speed + progress
  // bar), the topbar readout next to the network button, and the network
  // panel's TRAFFIC rows. A spinner alone can't tell "downloading a 40 MiB
  // model at 300 KiB/s" from "hung"; the byte rate can.
  const netRate = $('net-rate')
  const netDown = $('net-down')
  const netUp = $('net-up')

  function paintTransfers(s: TransferStats): void {
    // The "primary" transfer drives the single-value surfaces (topbar
    // readout, progress bar): whichever active direction is moving the most
    // bytes. Picking a fixed direction made the bar disagree with the line
    // above it whenever a publish overlapped a poster fetch.
    const primary = !s.up.active ? s.down
      : !s.down.active ? s.up
      : s.up.total > s.down.total ? s.up : s.down
    const primaryArrow = primary === s.up ? '↑' : '↓'

    // --- topbar: compact, one direction at a time
    const compact = s.active ? `${primaryArrow} ${formatRate(primary.bps)}` : ''
    netRate.textContent = compact
    netRate.hidden = compact === ''
    netRate.classList.toggle('up', primaryArrow === '↑')
    netDot.classList.toggle('busy', s.active)
    netDot.title = `${relaysOnline}/${pool.relayUrls.length} relays` + (compact ? ` · ${compact}` : '')

    // --- loading overlay: full detail + a determinate bar when size is known
    if (!loading.hidden) {
      const lines: string[] = []
      if (s.down.active) lines.push(formatDirStats('↓', s.down))
      if (s.up.active) lines.push(formatDirStats('↑', s.up))
      loadingRate.textContent = lines.join('\n')
      loadingRate.hidden = lines.length === 0
      const pct = primary.total > 0 ? Math.min(100, (primary.bytes / primary.total) * 100) : 0
      loadingBar.hidden = !(primary.active && primary.total > 0)
      if (!loadingBar.hidden) loadingBarFill.style.width = pct.toFixed(1) + '%'
    }

    // --- studio: publishing shows the live upload rate, not a bare 'upload…'
    if (publishing && s.up.active) {
      const pct = s.up.total > 0 ? ` · ${Math.min(100, Math.round((s.up.bytes / s.up.total) * 100))}%` : ''
      setStudioStatus(`↑ ${formatRate(s.up.bps)}${pct}`, 'busy')
    }

    // --- network panel: persistent rows, so 'idle' is a real state, and
    // an idle row still reports what this session has moved.
    const idle = (moved: number) => moved > 0 ? `idle · ${formatBytes(moved)} this session` : 'idle'
    netDown.textContent = s.down.active ? formatDirStats('', s.down) : idle(s.session.down)
    netUp.textContent = s.up.active ? formatDirStats('', s.up) : idle(s.session.up)
    netDown.parentElement?.classList.toggle('live', s.down.active > 0)
    netUp.parentElement?.classList.toggle('live', s.up.active > 0)
  }
  transfers.subscribe(paintTransfers)

  const toastText = $('toast-text')
  bindCopyButton($('btn-toast-copy'), () => toastText.textContent ?? '')
  let toastTimer = 0
  function showToast(msg: string): void {
    toastText.textContent = msg
    toast.hidden = false
    clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => { toast.hidden = true }, 3200)
  }

  let currentMeta: ThreadMeta | null = null
  let studioReply: { rootId: string; parentId: string } | null = null
  let viewerNav = 0

  const orderedRoots = (): ThreadMeta[] =>
    [...index.byId.values()]
      .filter((m) => m.role === 'root' && !m.tombstoned && !m.hashFailed)
      .filter((m) => matchesSearch(m))
      .sort((a, b) => b.createdAt - a.createdAt)

  // Search by name OR content (AMENDMENT 70). Matching is a case-insensitive
  // substring across the published filename, its base name (extension
  // stripped), the post's `content` (the model name, AMENDMENT 66) and the
  // event id — see matchesSearchQuery in thread-index.ts.
  let searchQuery = ''
  function matchesSearch(m: ThreadMeta): boolean {
    return matchesSearchQuery(m, searchQuery)
  }

  assets.onHashFailed = (meta) => {
    index.rejectHash(meta.eventId)
    refreshBoard()
    threadView.dropNode(meta.eventId)
    const route = router.current
    if (route.name === 'thread' && route.rootId === meta.eventId) {
      router.go({ name: 'board' })
    }
    if (currentMeta?.eventId === meta.eventId) {
      errorSheet.show(ERRORS.MODEL_DOWNLOAD(() => retryModel(meta.eventId), assets.failureDetail(meta.eventId)))
      router.go({ name: 'board' })
    }
  }

  $('btn-home').addEventListener('click', () => router.go({ name: 'board' }))
  $('btn-studio-close')?.addEventListener('click', () => router.go({ name: 'board' }))
  netDot.addEventListener('click', () => router.go({ name: 'network' }))
  $('btn-add').addEventListener('click', () => router.go({ name: 'studio' }))

  // ---------- search models by name or content ----------
  // A small overlay menu (like the network panel) that filters the board.
  // It is an overlay: opening it keeps whatever view is behind it mounted,
  // and closing returns to that view.
  const searchPanel = $('search-panel')
  const searchInput = $('search-input') as HTMLInputElement
  const searchBtn = $('btn-search')
  const searchHint = $('search-hint')
  let searchOpen = false
  function setSearchOpen(open: boolean): void {
    if (searchOpen === open) return
    searchOpen = open
    searchPanel.hidden = !open
    if (open) {
      searchInput.focus()
      searchInput.select()
    }
  }
  // NIP-50 fallback: after the instant local filter, also ask nostr.band for
  // models we don't have yet (unloaded remote models). Debounced so a typed
  // string doesn't fire a REQ per keystroke; superseded queries are dropped.
  let searchTimer = 0
  let searchToken = 0
  function setSearchQuery(q: string): void {
    q = q.trim()
    if (q === searchQuery) return
    searchQuery = q
    // Reflect the filter in the hint + the button (accent = board filtered).
    searchBtn.classList.toggle('active', searchQuery !== '')
    const total = orderedRoots()
    searchHint.textContent = searchQuery
      ? `${total.length} model${total.length === 1 ? '' : 's'} shown for “${searchQuery}”`
      : 'Type to filter the board by name or content.'
    refreshBoard()
    clearTimeout(searchTimer)
    const token = ++searchToken
    if (searchQuery.length >= 3) {
      searchTimer = window.setTimeout(() => {
        if (token !== searchToken) return
        pool.search(searchQuery)
      }, 400)
    } else {
      pool.cancelSearch()
    }
  }
  searchBtn.addEventListener('click', () => {
    if (searchOpen) { setSearchOpen(false); return }
    setSearchOpen(true)
  })
  $('btn-search-close').addEventListener('click', () => setSearchOpen(false))
  searchInput.addEventListener('input', () => setSearchQuery(searchInput.value))
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); setSearchOpen(false) }
    if (e.key === 'Enter') { searchInput.blur() }
  })
  $('btn-shuffle').addEventListener('click', () => { board.shuffle(orderedRoots()); engine.kick() })

  // ---------- 3D models toggle ----------
  // The topbar cube button flips the same setting that lives in the settings
  // panel (Interface → "Show posts as 3D models"), so the two stay in sync
  // and the choice persists. applySettings drives board/thread re-render.
  btn3d.addEventListener('click', () => {
    settings.set({ direct3D: !settings.bool('direct3D') })
  })

  // ---------- studio (import + publish) ----------
  function setStudioStatus(text: string, cls = ''): void {
    studioStatus.textContent = text
    studioStatus.className = 'studio-status ' + cls
  }

  // ---------- studio model info (AMENDMENT 66) ----------
  // The upload tab card shows the imported model's name, format, safety-scan
  // stats (size, vertices, triangles, meshes, materials, …) and the
  // big/near-limit warnings. The size number + meter run green -> red toward
  // the 20 MiB hard limit (sizeHeatColor).
  const modelInfoEl = $('model-info')
  const miRows = $('mi-rows')
  const miMeterFill = $('mi-meter-fill')
  const miWarnings = $('mi-warnings')

  function fillModelInfo(model: ImportedModel | null): void {
    modelInfoEl.hidden = model === null
    if (!model) return
    miRows.innerHTML = ''
    const s = model.report.stats
    const sizeLabel = formatSize(model.bytes.length)
    const add = (key: string, value: string, color?: string, title?: string): void => {
      const k = document.createElement('span')
      k.className = 'mi-k'
      k.textContent = key
      const v = document.createElement('span')
      v.className = 'mi-v'
      v.textContent = value
      if (color) v.style.color = color
      if (title) v.title = title
      miRows.append(k, v)
    }
    add('name', modelNameForPublish(model.file.name) || model.file.name)
    add('format', model.sourceFormat === 'glb' ? 'glb · pass-through' : `${model.sourceFormat} → glb`)
    add('size', sizeLabel, sizeHeatColor(model.bytes.length), `${formatCount(model.bytes.length)} bytes`)
    add('vertices', formatCount(s.vertices))
    add('triangles', formatCount(Math.floor(s.indices / 3)))
    add('meshes', s.primitives && s.primitives !== s.meshes ? `${formatCount(s.meshes)} · ${formatCount(s.primitives)} parts` : formatCount(s.meshes))
    if (s.materials) add('materials', formatCount(s.materials))
    if (s.textures) add('textures', formatCount(s.textures))
    if (s.decodedPixels) add('tex memory', formatSize(s.decodedPixels))
    if (s.cameras) add('cameras', formatCount(s.cameras))
    if (s.lights) add('lights', formatCount(s.lights))
    if (s.skins) add('skins', formatCount(s.skins))
    if (s.animations) add('animations', `${formatCount(s.animations)} · ${formatCount(s.keyframes)} keys`)
    const heat = sizeHeatColor(model.bytes.length)
    miMeterFill.style.width = `${Math.min(100, (model.bytes.length / LIMITS.modelBytesHard) * 100).toFixed(1)}%`
    miMeterFill.style.background = heat
    const warnings = modelWarnings(model.bytes.length, s)
    miWarnings.hidden = warnings.length === 0
    miWarnings.innerHTML = ''
    for (const w of warnings) {
      const li = document.createElement('li')
      li.textContent = w
      miWarnings.append(li)
    }
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
        fillModelInfo(imported)
        // Big or near-limit models (AMENDMENT 66) surface here as amber; the
        // red reasons are the models the safety scan refused outright.
        const warnCount = modelWarnings(imported.bytes.length, imported.report.stats).length
        const brief = `${imported.report.stats.meshes} mesh · ${formatCount(imported.report.stats.vertices)} verts`
        setStudioStatus(warnCount ? `${warnCount} warning${warnCount === 1 ? '' : 's'} · ${brief}` : brief, warnCount ? 'busy' : 'ok')
      } catch (err) {
        fillModelInfo(null)
        setStudioStatus('')
        errorSheet.show(ERRORS.STUDIO_IMPORT(err instanceof Error ? err.message : 'import failed'))
      }
    }, { once: true })
    fileInput.click()
  }

  function setPublishButton(busy: boolean): void {
    studioEl.classList.toggle('publishing', busy)
    if (busy) {
      btnStudioPublish.textContent = 'cancel'
      btnStudioPublish.classList.add('danger')
      btnStudioPublish.classList.remove('primary')
      btnStudioPublish.disabled = false
      btnStudioPublish.title = 'cancel upload'
    } else {
      btnStudioPublish.textContent = 'publish'
      btnStudioPublish.classList.remove('danger')
      btnStudioPublish.classList.add('primary')
      btnStudioPublish.disabled = !studio.hasContent()
      btnStudioPublish.title = 'publish'
    }
  }

  function cancelPublish(): void {
    if (!publishing) return
    publishAbort?.abort()
  }

  async function publishStudio(snapshot: typeof reviewedExport = reviewedExport): Promise<void> {
    if (publishing) { cancelPublish(); return }
    if (!studio.hasContent() || !snapshot) return
    publishing = true
    publishAbort = new AbortController()
    const signal = publishAbort.signal
    // Freeze BEFORE export: gizmo/paint edits during serialize used to
    // tear the GLB so the hashed snapshot and the uploaded body diverged.
    studio.setFrozen(true)
    setPublishButton(true)
    try {
      // The review has already generated and validated this immutable blob.
      // Never serialize again here: the reviewed/downloaded/uploaded bytes
      // must stay identical.
      const content = snapshot
      setStudioStatus(`upload ${formatSize(content.blob.size)}…`, 'busy')
      if (signal.aborted) throw Object.assign(new Error('upload aborted'), { name: 'AbortError' })
      // Format v4: the studio generates NO poster at all — every client
      // renders cards locally from the model at the event's `dim`. The event
      // just declares the default render size; nothing is rendered here.
      const onProgress = (p: PublishProgress) => {
        if (signal.aborted) return
        if (p.stage === 'blossom') setStudioStatus('upload…', 'busy')
        else if (p.stage === 'relay') setStudioStatus('nostr…', 'busy')
        // Partial relay failure is a warning (amber), not an error: the post
        // still went out and we navigate to it right after.
        else if (p.stage === 'done') setStudioStatus(`done · ${p.ok ?? 0}/${(p.ok ?? 0) + (p.failed ?? 0)}`, p.failed ? 'busy' : 'ok')
        else if (p.stage === 'error') errorSheet.show(ERRORS.STUDIO_PUBLISH(p.detail ?? 'publish failed'))
      }
      const result = await publishModel(
        {
          model: content.blob,
          // the author's chosen card size (full-page preview), else default
          width: previewDim.width,
          height: previewDim.height,
          tint: studio.tintColor,
          filename: content.filename,
          // the model name fills the nostr event's `content` (NIP-50 finds it)
          name: modelNameForPublish(content.filename, studio.hasModel() ? '' : studio.text),
          sourceFormat: content.sourceFormat,
          role: studioReply ? 'reply' : 'root',
          rootId: studioReply?.rootId,
          parentId: studioReply?.parentId,
        },
        { relays: pool.relayUrls, blossoms: blossoms.servers, pool, onProgress, signal },
      )
      void deletion.refresh().then(syncDeleteButton)
      // AMENDMENT 71/72: seed the verified model caches BEFORE the post can
      // be fetched by anything. The relay echo and the board's preview pool
      // can both start fetching the fresh post within milliseconds of the
      // publish — if seeding runs first, those fetches hit the local cache
      // and never touch the network. That matters: a seconds-old blob can
      // still be settling on the CDN, and one bad first fetch used to mark
      // the post hashFailed for the REST OF THE SESSION (E101 on every
      // later tap — "uploaded bush, always fails to load"). Own posts now
      // never race their own upload at all.
      if (result.sha256 && result.bytes) {
        try { await assets.seedModelBytes(result.sha256, result.bytes) } catch { /* replica fallback */ }
      }
      // AMENDMENT 70: self-index the event we just signed. The post must be
      // on the board and searchable by name/content IMMEDIATELY — the relay
      // echo is no longer a dependency (echoes can lag or never arrive, and
      // the NIP-50 fallback cannot see posts a relay index hasn't ingested
      // yet). The echo, when it comes, re-adds the same meta harmlessly.
      if (result.event) {
        const own = parseModelEvent(result.event)
        if (own) { index.add(own); refreshBoard() }
      }
      if (studioReply) router.go({ name: 'thread', rootId: studioReply.rootId, focusId: result.eventId })
      else router.go({ name: 'viewer', id: result.eventId })
      studioReply = null
    } catch (err) {
      if (isAbortError(err)) setStudioStatus('cancelled')
      else {
        setStudioStatus('')
        errorSheet.show(ERRORS.STUDIO_PUBLISH(err instanceof Error ? err.message : 'publish failed'))
      }
    } finally {
      publishing = false
      publishAbort = null
      studio.setFrozen(false)
      setPublishButton(false)
    }
  }

  function renderExportInfo(info: GLBExportInfo): void {
    exportSummary.innerHTML = `<span>file size</span><b>${formatSize(info.bytes)} / ${formatSize(LIMITS.modelBytesHard)}</b><span>scene</span><b>${info.meshes} meshes · ${formatCount(info.triangles)} triangles</b><span>content</span><b>${info.textures} textures · ${info.animations} animations</b>`
    const pct = Math.min(100, (info.bytes / LIMITS.modelBytesHard) * 100)
    exportMeter.style.width = `${pct.toFixed(1)}%`
    exportMeter.style.background = sizeHeatColor(info.bytes)
    exportBreakdownEl.textContent = exportBreakdown(info)
    exportExtensions.textContent = info.extensions.length ? `extensions: ${info.extensions.join(', ')}` : 'extensions: none'
  }

  function codecNote(report: CompressReport | null, before?: GLBExportInfo, after?: GLBExportInfo): string {
    if (!report) return ''
    const parts: string[] = []
    const b = DRACO_PRESETS[dracoPreset]
    if (report.draco.prims) parts.push(`draco ${report.draco.prims} mesh${report.draco.prims === 1 ? '' : 'es'} ${formatSize(report.draco.bytesBefore)} → ${formatSize(report.draco.bytesAfter)} · pos ${b.POSITION}/nrm ${b.NORMAL}/uv ${b.TEX_COORD}/col ${b.COLOR} bits`)
    if (report.webp.images) parts.push(`webp ${report.webp.images} texture${report.webp.images === 1 ? '' : 's'} q${Math.round(webpQuality.valueAsNumber)}% ${formatSize(report.webp.bytesBefore)} → ${formatSize(report.webp.bytesAfter)}`)
    if (before && after && !report.keptOriginal) parts.push(`file ${formatSize(before.bytes)} → ${formatSize(after.bytes)} · −${Math.round((1 - after.bytes / before.bytes) * 100)}%`)
    const reasons = [...new Set([...report.draco.reasons, ...report.webp.reasons])]
    if (reasons.length) parts.push(`kept raw: ${reasons.join(' · ')}`)
    return parts.join(' · ')
  }

  function syncCodecButtons(): void {
    // An option shows only when its encoder works; an unavailable selection
    // resets to none. Fine settings show only while their codec is active.
    const sync = (group: HTMLElement, available: boolean, current: string): string => {
      for (const btn of Array.from(group.querySelectorAll<HTMLButtonElement>('button[data-v]'))) {
        const v = btn.dataset.v ?? 'none'
        btn.hidden = v !== 'none' && !available
        btn.classList.toggle('on', v === current)
      }
      return current !== 'none' && !available ? 'none' : current
    }
    codecChoice.geometry = sync(codecGeometry, dracoOn === true, codecChoice.geometry) as typeof codecChoice.geometry
    codecChoice.texture = sync(codecTexture, webpOn === true, codecChoice.texture) as typeof codecChoice.texture
    for (const btn of Array.from(dracoQuality.querySelectorAll<HTMLButtonElement>("button[data-v]"))) btn.classList.toggle("on", btn.dataset.v === dracoPreset)
    exportCodecs.hidden = !(dracoOn === true || webpOn === true)
    dracoQualityRow.hidden = !(codecChoice.geometry === 'draco' && dracoOn === true)
    webpQualityRow.hidden = !(codecChoice.texture === 'webp' && webpOn === true)
    exportCodecSettings.hidden = dracoQualityRow.hidden && webpQualityRow.hidden
  }

  function setExportCodecBusy(busy: boolean): void {
    exportCodecBusy = busy
    // Controls stay clickable (a click while busy queues); only the
    // byte-consuming actions lock during a derive.
    exportCodecs.classList.toggle('busy', busy)
    exportCodecSettings.classList.toggle('busy', busy)
    btnExportDownload.disabled = busy
    btnExportPublish.disabled = busy || !reviewedExport
  }

  function refreshCodecOffering(): void {
    if (dracoOn === null) void dracoEncoderReady().then((ok) => { dracoOn = ok; syncCodecButtons() })
    if (webpOn === null) void webpEncoderSupported().then((ok) => { webpOn = ok; syncCodecButtons() })
    syncCodecButtons()
  }

  /** Mean per-channel pixel difference (0..255) between two card renders. */
  function meanPixelDiff(a: Uint8Array, b: Uint8Array): number {
    const n = Math.min(a.length, b.length)
    if (!n) return Number.NaN
    let sum = 0
    for (let i = 0; i < n; i += 4) sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
    return sum / (n / 4) / 3
  }

  /** The lossy preview (AMENDMENT 85): the exact reviewed bytes through the
   * board's card pipeline beside the raw export. Tokenled so a slow render
   * from an older codec pass cannot overwrite newer UI. Best-effort — the
   * sizes/note stay authoritative. */
  async function renderExportPreview(token: number, blob: Blob, label: string): Promise<void> {
    const render = async (b: Blob) => {
      const r = await assets.renderPosterFor(b, previewDim.width, previewDim.height)
      return { pixels: r.pixels, width: r.width, height: r.height }
    }
    try { rawPreview ??= await render(pristineExport!.blob) } catch { /* diff line just goes quiet */ }
    if (token !== exportCodecToken) return
    if (rawPreview) drawPosterPixels(exportPreviewRaw, rawPreview.pixels, rawPreview.width, rawPreview.height)
    let frame: Awaited<ReturnType<typeof render>> | null = null
    try { frame = await render(blob) } catch { /* best-effort */ }
    if (token !== exportCodecToken) return
    exportPreviewCodecLabel.textContent = label
    exportPreview.hidden = false
    if (!frame) { exportPreviewDiff.textContent = 'preview unavailable'; return }
    drawPosterPixels(exportPreviewCodec, frame.pixels, frame.width, frame.height)
    const d = rawPreview && rawPreview.width === frame.width && rawPreview.height === frame.height ? meanPixelDiff(rawPreview.pixels, frame.pixels) : Number.NaN
    exportPreviewDiff.textContent = d === 0 ? 'identical pixels'
      : Number.isFinite(d) ? `mean pixel difference ${d.toFixed(1)} / 255 (lossy preview of the exact bytes)`
      : ''
  }

  /** Re-derive the reviewed export from the PRISTINE bytes with the current
   * codec choice + fine settings; re-validated before it can be published. */
  async function applyCodecs(): Promise<void> {
    if (!pristineExport) return
    const token = ++exportCodecToken
    const fallback = (): void => {
      reviewedExport = { blob: pristineExport!.blob, filename: pristineExport!.filename, sourceFormat: pristineExport!.sourceFormat }
      renderExportInfo(pristineExport!.info)
      exportState.textContent = 'validated · exact bytes'
      exportCodecNote.textContent = codecNote(null)
      exportPreview.hidden = true
      setExportCodecBusy(false)
      btnExportPublish.disabled = false
    }
    const wantDraco = codecChoice.geometry === 'draco' && dracoOn === true
    const wantWebp = codecChoice.texture === 'webp' && webpOn === true
    if (!wantDraco && !wantWebp) { fallback(); return }
    setExportCodecBusy(true)
    exportState.textContent = 'encoding…'
    exportCodecNote.textContent = ''
    exportPreviewDiff.textContent = 'rendering preview…'
    exportPreview.hidden = false
    try {
      const src = new Uint8Array(await pristineExport.blob.arrayBuffer())
      const { bytes: out, report } = await compressGLB(src, {
        draco: wantDraco ? dracoCodec : undefined,
        dracoOptions: wantDraco ? { quantizationBits: { ...DRACO_PRESETS[dracoPreset] } } : undefined,
        webp: wantWebp ? webpCodec : undefined,
        webpQuality: webpQuality.valueAsNumber / 100,
      })
      if (token !== exportCodecToken) return
      if (report.keptOriginal) {
        fallback() // nothing shrank — keep the exact serializer bytes
        exportCodecNote.textContent = codecNote(report)
        return
      }
      const verdict = validateGLB(out)
      if (!verdict.ok) throw new Error(verdict.reason)
      reviewedExport = { blob: new Blob([out.buffer as ArrayBuffer], { type: 'model/gltf-binary' }), filename: pristineExport.filename, sourceFormat: pristineExport.sourceFormat }
      const info = inspectGLB(out)
      renderExportInfo(info)
      exportState.textContent = 'validated · exact bytes'
      exportCodecNote.textContent = codecNote(report, pristineExport.info, info)
      btnExportPublish.disabled = false
      setStudioStatus(`${formatSize(info.bytes)} · reviewed`, 'ok')
      const label = [wantDraco ? 'draco' : null, wantWebp ? 'webp' : null].filter(Boolean).join('+')
      await renderExportPreview(token, reviewedExport.blob, label)
    } catch (err) {
      if (token !== exportCodecToken) return
      fallback()
      exportState.textContent = 'codec failed · original kept'
      exportCodecNote.textContent = err instanceof Error ? err.message : 'codec failed'
    } finally {
      if (token === exportCodecToken) {
        setExportCodecBusy(false)
        if (exportCodecQueued) {
          exportCodecQueued = false
          void applyCodecs()
        }
      }
    }
  }

  async function openExportReview(): Promise<void> {
    if (publishing || !studio.hasContent()) return
    try {
      btnStudioPublish.disabled = true
      setStudioStatus('exporting…', 'busy')
      // Freeze the editing scene while the serializer takes its snapshot.
      studio.setFrozen(true)
      const content = await studio.getContentForPublish()
      const bytes = new Uint8Array(await content.blob.arrayBuffer())
      const report = validateGLB(bytes)
      if (!report.ok) throw new Error(report.reason)
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'model/gltf-binary' })
      const info = inspectGLB(bytes)
      pristineExport = { blob, filename: content.filename, sourceFormat: content.sourceFormat, info }
      reviewedExport = { blob, filename: content.filename, sourceFormat: content.sourceFormat }
      rawPreview = null // new export: the raw baseline must re-render
      renderExportInfo(info)
      exportState.textContent = 'validated · exact bytes'
      exportCodecNote.textContent = ''
      exportPreview.hidden = true
      exportPreviewDiff.textContent = ''
      btnExportPublish.disabled = false
      exportReview.hidden = false
      refreshCodecOffering()
      void applyCodecs()
      setStudioStatus(`${formatSize(info.bytes)} · reviewed`, 'ok')
    } catch (err) {
      reviewedExport = null
      pristineExport = null
      setStudioStatus('')
      errorSheet.show(ERRORS.STUDIO_PUBLISH(err instanceof Error ? err.message : 'export failed'))
    } finally {
      studio.setFrozen(false)
      if (!publishing) btnStudioPublish.disabled = !studio.hasContent()
    }
  }

  function closeExportReview(): void { exportReview.hidden = true }

  function downloadReviewedExport(): void {
    if (!reviewedExport) return
    const url = URL.createObjectURL(reviewedExport.blob)
    const a = document.createElement('a')
    a.href = url
    a.download = reviewedExport.filename.replace(/\.[^.]+$/, '') + '.glb'
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 4000)
  }

  btnStudioImport.addEventListener('click', () => { if (!publishing) void pickStudioFile() })
  // While publishing the button is relabeled "cancel" — that click must
  // ABORT, not open a review (the review flow had swallowed it and a
  // mid-upload cancel did nothing).
  btnStudioPublish.addEventListener('click', () => {
    if (publishing) { cancelPublish(); return }
    void openExportReview()
  })
  $('btn-export-close').addEventListener('click', closeExportReview)
  $('btn-export-download').addEventListener('click', downloadReviewedExport)
  btnExportPublish.addEventListener('click', () => { if (reviewedExport) { closeExportReview(); void publishStudio(reviewedExport) } })
  const requestCodecApply = (): void => {
    if (exportCodecBusy) exportCodecQueued = true
    else void applyCodecs()
  }
  const bindCodecGroup = (group: HTMLElement, apply: (value: string) => void): void => {
    group.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-v]') as HTMLButtonElement | null
      if (!btn || btn.hidden) return
      apply(btn.dataset.v ?? 'none')
    })
  }
  bindCodecGroup(codecGeometry, (value) => {
    if (value === codecChoice.geometry || (value !== 'none' && value !== 'draco')) return
    codecChoice.geometry = value
    syncCodecButtons()
    requestCodecApply()
  })
  bindCodecGroup(codecTexture, (value) => {
    if (value === codecChoice.texture || (value !== 'none' && value !== 'webp')) return
    codecChoice.texture = value
    syncCodecButtons()
    requestCodecApply()
  })
  // Draco quantization preset: a lossy dial, so it re-derives + re-previews.
  dracoQuality.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-v]') as HTMLButtonElement | null
    if (!btn) return
    const value = btn.dataset.v as DracoPreset
    if (!value || !(value in DRACO_PRESETS) || value === dracoPreset) return
    dracoPreset = value
    syncCodecButtons()
    if (codecChoice.geometry === 'draco') requestCodecApply()
  })
  webpQuality.addEventListener('input', () => {
    webpQualityLabel.textContent = `${webpQuality.valueAsNumber}%`
  })
  webpQuality.addEventListener('change', () => {
    if (codecChoice.texture === 'webp') requestCodecApply()
  })

  // Remove every studio addition (text, paint, cameras, mesh moves): the
  // studio reloads the model from its pristine imported bytes, so publishing
  // is byte-identical to the import again (AMENDMENT 66).
  $('btn-studio-reset').addEventListener('click', () => {
    if (publishing) return
    setStudioStatus('resetting…', 'busy')
    void studio.resetAdditions().then((ok) => {
      if (!ok) { setStudioStatus(''); return }
      studioText.value = '' // a pending debounced rebuild is a no-op on empty text
      btnStudioPublish.disabled = !studio.hasContent()
      fillModelInfo(studio.currentModel)
      refreshCameraControls()
      updateTextBudget()
      setStudioStatus('additions removed · original bytes')
      studio.kick(500)
    }).catch((err) => {
      setStudioStatus('')
      errorSheet.show(ERRORS.STUDIO_IMPORT(err instanceof Error ? err.message : 'reset failed'))
    })
  })

  // ---- Studio card preview (format v4) ----
  // The card IS a local render, so the studio can show the exact card the
  // post will get: a corner preview (click to hide / ◱ pill to reveal) and a
  // full page with a resizable canvas whose size becomes the event's `dim`.
  const previewPanel = $('studio-preview') as HTMLDivElement | null
  const previewCanvas = $('studio-preview-canvas') as HTMLCanvasElement | null
  const btnPreviewReveal = $('btn-preview-reveal') as HTMLButtonElement | null
  const btnPreviewFull = $('btn-preview-full') as HTMLButtonElement | null
  const previewPageEl = $('preview-page') as HTMLDivElement | null
  const previewPageCanvas = $('preview-canvas') as HTMLCanvasElement | null
  const previewFrameEl = $('preview-frame') as HTMLDivElement | null
  const previewResizeEl = $('preview-resize') as HTMLDivElement | null
  const previewSizeLabel = $('preview-size-label') as HTMLSpanElement | null
  const btnPreviewReset = $('btn-preview-reset') as HTMLButtonElement | null
  const btnPreviewClose = $('btn-preview-close') as HTMLButtonElement | null

  let previewDim = { width: POSTER_W, height: POSTER_H }
  let previewHidden = false
  let previewTimer = 0
  let previewBusy = false
  let previewQueued = false
  let previewFrame: { pixels: Uint8Array; width: number; height: number } | null = null

  try { previewHidden = localStorage.getItem('f0:preview-hidden') === '1' } catch { /* private mode */ }

  function syncPreviewVisibility(): void {
    if (!previewPanel || !btnPreviewReveal) return
    const has = studio.hasContent()
    previewPanel.hidden = previewHidden || !has
    btnPreviewReveal.hidden = !previewHidden || !has
  }

  function drawPreviewFrame(target: HTMLCanvasElement | null, frame: { pixels: Uint8Array; width: number; height: number }): void {
    if (!target) return
    drawPosterPixels(target, frame.pixels, frame.width, frame.height)
  }

  /** Render the CURRENT studio content as a card at `dim` and paint both
   *  surfaces (corner + full page). Debounced callers only. */
  async function renderStudioPreview(): Promise<void> {
    if (publishing || !studio.hasContent()) { syncPreviewVisibility(); return }
    previewBusy = true
    try {
      const content = await studio.getContentForPublish()
      const r = await assets.renderPosterFor(content.blob, previewDim.width, previewDim.height)
      previewFrame = { pixels: r.pixels, width: r.width, height: r.height }
      drawPreviewFrame(previewCanvas, previewFrame)
      if (previewPageEl && !previewPageEl.hidden) {
        drawPreviewFrame(previewPageCanvas, previewFrame)
        applyPreviewFrameSize(previewDim.width, previewDim.height)
      }
    } catch {
      /* render failed (limits, blank…) — keep the last preview */
    } finally {
      previewBusy = false
      if (previewQueued) { previewQueued = false; void renderStudioPreview() }
    }
  }

  function scheduleStudioPreview(delay = 600): void {
    syncPreviewVisibility()
    window.clearTimeout(previewTimer)
    previewTimer = window.setTimeout(() => {
      if (previewBusy) { previewQueued = true; return }
      void renderStudioPreview()
    }, delay)
  }
  studio.onDirty = () => {
    // Any edit makes a previously reviewed export stale. Keep the old blob
    // private; it can no longer be published from the UI.
    reviewedExport = null
    pristineExport = null
    rawPreview = null
    exportCodecToken++ // an in-flight codec pass may not land anymore
    exportCodecQueued = false
    setExportCodecBusy(false)
    if (!exportReview.hidden) closeExportReview()
    scheduleStudioPreview()
  }

  previewCanvas?.addEventListener('click', () => {
    previewHidden = true
    try { localStorage.setItem('f0:preview-hidden', '1') } catch { /* private mode */ }
    syncPreviewVisibility()
  })
  btnPreviewReveal?.addEventListener('click', () => {
    previewHidden = false
    try { localStorage.setItem('f0:preview-hidden', '0') } catch { /* private mode */ }
    syncPreviewVisibility()
    scheduleStudioPreview(0)
  })

  function applyPreviewFrameSize(w: number, h: number): void {
    if (!previewFrameEl || !previewPageCanvas) return
    // CSS size: the canvas keeps its bitmap until the next render replaces
    // it — during a drag the last bitmap is simply stretched (instant
    // feedback), and the release re-renders at the true resolution.
    previewFrameEl.style.width = `${w}px`
    previewFrameEl.style.height = `${h}px`
    previewPageCanvas.style.width = `${w}px`
    previewPageCanvas.style.height = `${h}px`
    if (previewSizeLabel) previewSizeLabel.textContent = `${w} × ${h}`
  }

  function clampPreviewDim(w: number, h: number): { width: number; height: number } {
    // Same bounds the format enforces (parsePosterDim): a card, not a sliver.
    const cw = Math.max(LIMITS.posterDimMin, Math.min(LIMITS.posterDimMax, Math.round(w)))
    const ch = Math.max(LIMITS.posterDimMin, Math.min(LIMITS.posterDimMax, Math.round(h)))
    const aspect = cw / ch
    if (aspect > LIMITS.posterAspectMax) return { width: cw, height: Math.round(cw / LIMITS.posterAspectMax) }
    if (aspect < LIMITS.posterAspectMin) return { width: Math.round(ch * LIMITS.posterAspectMin), height: ch }
    return { width: cw, height: ch }
  }

  function openPreviewPage(): void {
    if (!previewPageEl) return
    previewPageEl.hidden = false
    if (previewFrame) {
      drawPreviewFrame(previewPageCanvas, previewFrame)
      applyPreviewFrameSize(previewFrame.width, previewFrame.height)
      previewDim = { width: previewFrame.width, height: previewFrame.height }
    } else {
      applyPreviewFrameSize(previewDim.width, previewDim.height)
      scheduleStudioPreview(0)
    }
  }

  function closePreviewPage(): void {
    if (!previewPageEl) return
    previewPageEl.hidden = true
    previewPageEl.classList.remove('resizing')
  }
  btnPreviewFull?.addEventListener('click', openPreviewPage)
  btnPreviewClose?.addEventListener('click', closePreviewPage)
  btnPreviewReset?.addEventListener('click', () => {
    previewDim = { width: POSTER_W, height: POSTER_H }
    applyPreviewFrameSize(previewDim.width, previewDim.height)
    scheduleStudioPreview(0)
  })

  // Resizable canvas: pointer drag on the corner handle. The frame follows
  // the pointer (CSS only); the release commits the size, re-renders the
  // card at that resolution and stamps it into `previewDim` (= `dim`).
  previewResizeEl?.addEventListener('pointerdown', (e) => {
    if (!previewFrameEl || !previewPageEl) return
    e.preventDefault()
    previewResizeEl.setPointerCapture(e.pointerId)
    previewPageEl.classList.add('resizing')
    const start = { x: e.clientX, y: e.clientY, w: previewDim.width, h: previewDim.height }
    const move = (ev: PointerEvent) => {
      const next = clampPreviewDim(start.w + (ev.clientX - start.x), start.h + (ev.clientY - start.y))
      previewDim = next
      applyPreviewFrameSize(next.width, next.height)
    }
    const up = (ev: PointerEvent) => {
      previewResizeEl.removeEventListener('pointermove', move)
      previewResizeEl.removeEventListener('pointerup', up)
      previewResizeEl.removeEventListener('pointercancel', up)
      previewPageEl.classList.remove('resizing')
      move(ev)
      scheduleStudioPreview(150)
    }
    previewResizeEl.addEventListener('pointermove', move)
    previewResizeEl.addEventListener('pointerup', up)
    previewResizeEl.addEventListener('pointercancel', up)
  })

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
    studio.setPaintMode(tab === 'paint')
    // Empty text field = NO text (AMEND 66/69): the type tab never seeds
    // '/0', so a blank field adds nothing and publish stays disabled until
    // the player actually adds content (text, model, symbols or paint).
    if (tab === 'paint' || tab === 'type') btnStudioPublish.disabled = !studio.hasContent()
    studio.kick(120)
  }
  document.querySelectorAll<HTMLButtonElement>('.rail-btn').forEach((b) =>
    b.addEventListener('click', () => setStudioTab(b.dataset.tab as StudioTab)),
  )
  bindLibraryHud(studio, () => {
    if (!publishing) btnStudioPublish.disabled = !studio.hasContent()
    setStudioStatus(studio.libraryCount ? `${studio.libraryCount} pieces` : '')
  }, (msg) => {
    // The symbols tab must not fail silently: placement errors (Draco/CSP,
    // fetch, validation) surface in the error sheet AND the studio status
    // line, exactly like import errors do (AMENDMENT 68, corrected
    // 2026-08-20).
    setStudioStatus(msg, 'err')
    errorSheet.show(ERRORS.STUDIO_IMPORT(msg))
    // The symbols tab has its OWN tint picker (AMENDMENT 69): the next
    // placed symbol takes the symbols tab's object tint, not the text
    // tab's color. Both pickers mirror a selected item's color on select.
  }, () => symbolColor.value)

  // ---- Studio text + camera settings ----
  const ALIGN_CYCLE: Array<'left' | 'center' | 'right'> = ['left', 'center', 'right']
  let alignIdx = 1
  function updateTextBudget(): void {
    if (!textBudget) return
    const m = studio.scene.meshes.find((x) => x.name === 'studio-text')
    const tris = m ? m.getTotalIndices() / 2 : 0
    const lines = studioText.value ? studioText.value.split('\n').length : 0
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

  // Selecting a symbol or the text mesh shows its own color in BOTH pickers
  // (AMENDMENT 68 corrected 2026-08-21 + AMENDMENT 69): each item keeps an
  // independent color, and whichever tab is open shows the truth.
  studio.onSelect = () => {
    // Only symbols and the text mesh have their own color; an imported
    // model's selection leaves the pickers alone (AMENDMENT 68 corrected
    // 2026-08-21).
    const c = studio.getSelectedColor()
    if (c !== null) {
      studioColor.value = c
      symbolColor.value = c
    }
  }

  studioColor.addEventListener('input', () => {
    if (studio.selected) {
      // Repaint only the selected symbol / text, not every placed piece.
      // setSelectedColor rebuilds the text mesh itself (color is baked in).
      studio.setSelectedColor(studioColor.value)
    } else {
      // No selection: the picker sets the color of the NEXT placement.
      studio.setTintColor(studioColor.value)
    }
  })

  // Object tint on the symbols tab (AMENDMENT 69): same selection-aware
  // behavior as the text color, scoped to the symbols tab's picker.
  symbolColor.addEventListener('input', () => {
    if (studio.selected) {
      studio.setSelectedColor(symbolColor.value)
    } else {
      studio.setTintColor(symbolColor.value)
    }
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

  const paintHud = bindPaintHud(studio, () => {
    studio.touched() // paint additions are observable (paint.count), not sticky
    if (!publishing) btnStudioPublish.disabled = !studio.hasContent()
  })
  void paintHud

  $('btn-close').addEventListener('click', () => router.go({ name: 'board' }))
  $('btn-prev').addEventListener('click', () => void stepViewer(-1))
  $('btn-next').addEventListener('click', () => void stepViewer(1))
  btnPlay.addEventListener('click', () => { viewer.toggleAnimation(); syncPlay() })

  // ---------- animation rail (tracks / timeline / stepped / dir / speed) ----------
  // While the user drags the timeline the animator must not fight the thumb:
  // scrubbing pauses playback and every input event seeks + repaints.
  animTrack.addEventListener('change', () => {
    viewer.animator.setTrack(animTrack.selectedIndex)
    engine.kick()
    syncAnimRail()
  })
  animTimeline.addEventListener('input', () => {
    viewer.animator.pause()
    viewer.animator.seek(parseFloat(animTimeline.value))
    engine.kick()
    syncPlay()
  })
  animDir.addEventListener('click', () => {
    viewer.animator.setDirection(!viewer.animator.forward)
    syncAnimRail()
  })
  animStepped.addEventListener('click', () => {
    viewer.animator.setStepped(!viewer.animator.stepped)
    engine.kick()
    syncAnimRail()
  })
  animSpeed.addEventListener('input', () => {
    viewer.animator.setSpeed(parseFloat(animSpeed.value) || 1)
  })
  // Playback → HUD: the animator reports every cursor move (tick or seek);
  // mirror it into the range thumb + frame readout unless the user is the
  // one holding the thumb.
  let timelineHeld = false
  animTimeline.addEventListener('pointerdown', () => { timelineHeld = true })
  window.addEventListener('pointerup', () => { timelineHeld = false })
  viewer.animator.onFrame = (f) => {
    const r = viewer.animator.range()
    if (!r) return
    if (!timelineHeld) animTimeline.value = String(f)
    animFrame.textContent = `${Math.round(f - r.from)} / ${Math.round(r.to - r.from)}`
  }

  /** Rebuild the rail for the current model (or hide it when trackless). */
  function syncAnimRail(): void {
    const a = viewer.animator
    animRail.hidden = a.count === 0
    if (a.count === 0) return
    if (animTrack.options.length !== a.count) {
      animTrack.innerHTML = ''
      a.names.forEach((name, i) => {
        const o = document.createElement('option')
        o.value = String(i)
        o.textContent = name
        animTrack.appendChild(o)
      })
    }
    animTrack.selectedIndex = a.index
    const r = a.range()
    if (r) {
      animTimeline.min = String(r.from)
      animTimeline.max = String(r.to)
      animTimeline.value = String(a.frame)
      animFrame.textContent = `${Math.round(a.frame - r.from)} / ${Math.round(r.to - r.from)}`
    }
    animDir.classList.toggle('reverse', !a.forward)
    animDir.title = a.forward ? 'direction: forward (click for reverse)' : 'direction: reverse (click for forward)'
    animStepped.classList.toggle('active', a.stepped)
    // Don't overwrite the field while the user is editing it (number inputs
    // can hold transient states like "1." mid-typing).
    if (document.activeElement !== animSpeed) animSpeed.value = String(a.speed)
    syncPlay()
  }
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
      // AMENDMENT 70: the owned-post record must remember the tombstone,
      // otherwise the next boot restores the deleted post from storage.
      void markOwnedPostTombstoned(id)
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
  graphics.register(viewer.scene, 'viewer', () => viewer.scene.activeCamera, { excludeFromGlow: () => viewer.overlayMeshes })
  graphics.register(studio.scene, 'studio', () => studio.scene.activeCamera)
  for (const offscreen of assets.offscreenScenes()) graphics.register(offscreen, 'offscreen')
  graphics.register(board.previewScene, 'offscreen')

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
    btn3d.classList.toggle('active', settings.bool('direct3D'))
    settingsPanel.refresh()
  })
  applySettings(wiring, settings.all, null)
  btn3d.classList.toggle('active', settings.bool('direct3D'))

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
      meta.name ? `name          ${meta.name}` : null,
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
    if (mode === 'studio' && next !== 'studio' && publishing) cancelPublish()
    mode = next
    if (next !== 'thread') threadView.detach()
    if (next !== 'viewer') {
      viewerNav++
      setLoading('model', false)
      viewer.clear()
    }
    studioEl.hidden = next !== 'studio'
    threadZoom.hidden = next !== 'thread'
    document.body.dataset.mode = next
    board.setInteractive(next === 'board')
    if (next !== 'board') setSearchOpen(false)
    if (next === 'studio' || next === 'viewer') assets.setPaused(true)
    if (next === 'board') {
      board.live.activate('board')
      engine.setActiveScene(board.scene)
      topbar.hidden = false
      viewerBar.hidden = true
      drawer.hidden = true
      document.body.classList.remove('drawer-open')
      viewer.detach()
      studio.detach()
      board.resumeLive()
    } else if (next === 'viewer') {
      board.live.activate('viewer')
      engine.setActiveScene(viewer.scene)
      topbar.hidden = false
      viewerBar.hidden = false
      viewer.attach()
      studio.detach()
    } else if (next === 'thread') {
      board.live.activate('thread')
      engine.setActiveScene(threadView.scene)
      topbar.hidden = false
      viewerBar.hidden = true
      drawer.hidden = true
      document.body.classList.remove('drawer-open')
      viewer.detach()
      studio.detach()
      threadView.attach()
    } else {
      board.live.activate('idle')
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
    if (!meta || meta.hashFailed || assets.isHashFailed(id)) {
      if (meta?.hashFailed || assets.isHashFailed(id ?? '')) {
        errorSheet.show(ERRORS.MODEL_DOWNLOAD(() => retryModel(id), assets.failureDetail(id)))
      }
      setMode('board')
      return
    }
    const nav = ++viewerNav
    currentMeta = meta
    syncDeleteButton()
    setMode('viewer')
    camDots.innerHTML = ''
    animRail.hidden = true
    animTrack.innerHTML = ''
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
        syncAnimRail()
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
      let bytes: Uint8Array | undefined
      try {
        bytes = await assets.getModelBytes(meta)
      } catch {
        // download/verify failure — falls through to the E101 sheet below
      }
      if (nav !== viewerNav) return
      if (!bytes) {
        errorSheet.show(ERRORS.MODEL_DOWNLOAD(() => retryModel(id), assets.failureDetail(id)))
        return
      }
      await viewer.load(bytes, meta)
      if (nav !== viewerNav) return
      renderCamDots()
      syncAnimRail()
    } catch {
      if (nav === viewerNav) errorSheet.show(ERRORS.MODEL_PARSE(() => router.go({ name: 'board' })))
    } finally {
      if (nav === viewerNav) setLoading('model', false)
    }
  }

  // AMENDMENT 72: a failed fetch marks the post hashFailed and the board
  // drops its card, but that failure can be TRANSIENT (a fresh blob racing
  // its own upload on the CDN). Retry must actually retry: clear the marks,
  // re-list the card, and re-attempt the download — instead of replaying
  // E101 on every tap forever. Own posts typically do not even need the
  // network: the publish already seeded their verified bytes locally.
  function retryModel(id: string): void {
    assets.unfail(id)
    index.unrejectHash(id)
    refreshBoard()
    void openViewer(id)
  }

  // The network panel is an OVERLAY, not a page. `#/network` used to force
  // setMode('board'), so opening it from the viewer/thread/studio tore that
  // view down and closing it dumped you on the board. Now the view behind it
  // is left alone and closing returns to the route it was opened from.
  let networkReturn: Route | null = null
  // Leaving #/network only rewrites the hash — the view underneath was never
  // replaced, so re-applying the route would be destructive (applying
  // 'studio' clears the imported model; 'viewer'/'thread' would reload).
  let skipNextApply = false

  function applyRoute(route = router.current): void {
    if (skipNextApply) {
      skipNextApply = false
      if (networkPanel.isOpen) networkPanel.close()
      return
    }
    if (route.name !== 'network') networkReturn = route
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
      fillModelInfo(null)
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
      // fresh post: the card goes back to the default size (the author may
      // pick another on the full-page preview before publishing)
      previewDim = { width: POSTER_W, height: POSTER_H }
      closePreviewPage()
      syncPreviewVisibility()
      scheduleStudioPreview(0)
    }
    else if (route.name === 'network') {
      // Keep whatever is on screen; only a cold boot straight into
      // #/network has nothing behind the panel.
      if (mode === 'boot') setMode('board')
      networkPanel.open(() => {
        if (router.current.name !== 'network') return
        skipNextApply = true
        router.go(networkReturn ?? { name: 'board' })
      })
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
      // Keep the "shown N models" hint live while a query is active: NIP-50
      // results and restored/self-indexed posts stream in after the first
      // keystroke, so the count would otherwise sit stale.
      if (searchQuery) {
        searchHint.textContent = `${roots.length} model${roots.length === 1 ? '' : 's'} shown for “${searchQuery}”`
      }
    })
  }

  pool.onEvent = (event) => {
    if (event.kind === 5) {
      for (const t of event.tags) {
        if (t[0] !== 'e') continue
        const target = index.byId.get(t[1])
        if (target && target.pubkey === event.pubkey) {
          index.tombstone(t[1])
          // AMENDMENT 70: an own deletion (echoed here, or made in another
          // tab) must persist on the owned-post record or boot restore
          // resurrects the post.
          if (deletion.owned.has(t[1])) void markOwnedPostTombstoned(t[1])
        }
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
    // The dot is a pseudo-element now (the button itself is a 42px hit
    // target), so the state colour travels through a custom property.
    relaysOnline = online
    netDot.style.setProperty('--dot', color)
    paintTransfers(transfers.stats())
    const allOffline = states.length >= pool.relayUrls.length && states.every((s) => s === 'offline')
    if (allOffline && !warnedOffline) {
      warnedOffline = true
      errorSheet.show(ERRORS.RELAYS_OFFLINE(() => router.go({ name: 'network' })))
    }
    if (online > 0) warnedOffline = false
  }

  // AMENDMENT 70: rebuild this browser's OWN posts from storage at boot. The
  // live feed only carries a recent window (14 days / limit), so without
  // this your posts can drop off the board and out of search entirely even
  // though they still live on the relays. Tombstoned (deleted) records stay
  // out, and records older than the snapshot (no meta) rely on the feed.
  void listOwnedPosts().then((records) => {
    let restored = 0
    for (const rec of records) {
      if (rec.tombstoned || index.byId.has(rec.eventId)) continue
      const meta = ownedToMeta(rec)
      if (!meta) continue
      index.add(meta)
      restored++
    }
    if (restored) { setLoading('feed', false); refreshBoard() }
  })

  pool.connect()

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && previewPageEl && !previewPageEl.hidden) { closePreviewPage(); return }
    if (e.key === 'Escape' && errorSheet.isOpen) { errorSheet.hide(); return }
    if (e.key === 'Escape' && networkPanel.isOpen) { networkPanel.close(); return }
    if (e.key === 'Escape' && searchOpen) { setSearchOpen(false); return }
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
      if (publishing && e.key === 'Escape') { cancelPublish(); return }
      // Global typing guard already returned for INPUT/TEXTAREA (AMEND 53).
      if (studio.isFrozen) {
        if (e.key === 'Escape') router.go({ name: 'board' })
        return
      }
      if (studio.isPaintMode) {
        if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && e.shiftKey) { studio.paint.redo(); e.preventDefault(); return }
        if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) { studio.paint.undo(); e.preventDefault(); return }
        if (e.key === 'y' && (e.ctrlKey || e.metaKey)) { studio.paint.redo(); e.preventDefault(); return }
        if (e.key === 'z' || e.key === 'Z') { e.shiftKey ? studio.paint.redo() : studio.paint.undo(); e.preventDefault(); return }
        if (e.key === 'b' || e.key === 'B') { studio.paint.setTool('brush'); return }
        if (e.key === 'x' || e.key === 'X') { studio.paint.setTool('eraser'); return }
        if (e.key === 'v' || e.key === 'V') { studio.paint.setTool('select'); return }
      }
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
      return
    }
    if (mode !== 'viewer') return
    switch (e.key) {
      case 'Escape': router.go({ name: 'board' }); break
      case 'ArrowLeft': void stepViewer(-1); break
      case 'ArrowRight': void stepViewer(1); break
      case 'c': case 'C': viewer.cycleCamera(); renderCamDots(); break
      case 'a': case 'A': viewer.toggleAnimation(); syncPlay(); break
      // frame stepping (pauses playback; wraps around the clip)
      case ',': case '<': viewer.animator.step(-1); engine.kick(); syncPlay(); break
      case '.': case '>': viewer.animator.step(1); engine.kick(); syncPlay(); break
      case 'm': case 'M': toggleDrawer(); break
      case 't': case 'T':
        if (currentMeta) router.go({ name: 'thread', rootId: currentMeta.refs.rootId ?? currentMeta.eventId })
        break
    }
  })

  // The engine re-derives the drawing buffer (device pixel ratio + pixel
  // budget both move with a zoom / screen change) and then tells the views to
  // re-measure. Subscribing to the engine rather than to `resize` alone means
  // a page zoom, a DPI change with no resize event, and a resolution-policy
  // change all take the SAME path — a view can no longer be left behind
  // holding a frustum for a buffer that no longer exists. (AMENDMENT 79)
  engine.onViewportChange(() => {
    board.resize()
    threadView.resize()
    viewer.resize()
    studio.resize()
  })
  window.addEventListener('resize', () => { engine.resize() })

  ;(window as any).__form0 = {
    engine, pool, blossoms, index, board, viewer, studio, threadView, router, assets,
    legend, networkPanel, errorSheet, settings, settingsPanel, graphics, mixer, caps,
    // transfer meter: lets scripts/loading-shot.mjs fake a slow transfer and
    // capture the speed readouts without waiting for a real 40 MiB model
    transfers, setLoading,
    // search: tests drive the filter + inspect state
    setSearchQuery, search: () => searchQuery, setSearchOpen,
    // publish: tests drive cancel + inspect the frozen snapshot
    cancelPublish, isPublishing: () => publishing,
    // which view is actually on screen (the network panel is an overlay, so
    // the route alone no longer tells you) — scripts/network-panel.mjs
    __mode: () => mode,
    // animation rail: lets tests load a multi-track GLB straight into the
    // viewer and rebuild the HUD without a full openViewer round-trip
    syncAnimRail,
  }
}

boot().catch((err) => console.error(err))
