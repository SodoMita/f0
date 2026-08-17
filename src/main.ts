import { FormEngine } from './core/engine'
import { Router } from './core/router'
import { RelayPool } from './protocol/nostr'
import { BlossomClient } from './protocol/blossom'
import { parseModelEvent } from './protocol/events'
import { ThreadIndex, type ThreadMeta } from './protocol/thread-index'
import { Board } from './board/board'
import { Viewer } from './viewer/viewer'
import { Studio, type StudioPublishConfig } from './studio/studio'
import { AssetCache } from './core/assets'
import { Topbar } from './gui/topbar'
import * as GUI from '@babylonjs/gui'
import { DEFAULTS } from './theme'
import { loadNetworkConfig, saveNetworkConfig } from './protocol/storage'

type Mode = 'board' | 'viewer' | 'studio'

async function boot(): Promise<void> {
  const canvas = document.getElementById('engine') as HTMLCanvasElement
  const ime = document.getElementById('ime-input') as HTMLTextAreaElement

  let engine: FormEngine
  try {
    engine = await FormEngine.create(canvas)
  } catch (err) {
    const fatal = document.getElementById('fatal')!
    fatal.hidden = false
    document.getElementById('fatal-text')!.textContent = 'WebGL unavailable.'
    document.getElementById('fatal-reload')!.addEventListener('click', () => location.reload())
    throw err
  }

  const router = new Router()
  const pool = new RelayPool()
  const blossoms = new BlossomClient([...DEFAULTS.blossoms])
  const index = new ThreadIndex()

  const cfg = await loadNetworkConfig()
  const config: StudioPublishConfig = {
    relays: cfg.relays?.length ? cfg.relays : [...DEFAULTS.relays],
    blossoms: cfg.blossoms?.length ? cfg.blossoms : [...DEFAULTS.blossoms],
  }
  pool.setRelays(config.relays)
  blossoms.setServers(config.blossoms)
  pool.connect()

  let threadRootId: string | null = null

  const board = new Board(engine, {
    onOpenModel: (meta) => router.go({ name: 'viewer', id: meta.eventId, fromThread: threadRootId ?? undefined }),
    onOpenThread: (meta) => router.go({ name: 'thread', rootId: meta.refs.rootId ?? meta.eventId }),
    onReply: (meta) => openStudio(meta.refs.rootId ?? meta.eventId, meta.eventId),
  })
  const assets = new AssetCache(blossoms, board.scene)
  const viewer = new Viewer(engine)

  let studio: Studio | null = null

  const ui = GUI.AdvancedDynamicTexture.CreateFullscreenUI('ui', true, board.scene, 1, true)

  const topbar = new Topbar(ui, {
    onAdd: () => openStudio(),
    onShuffle: () => board.shuffle(visibleModels()),
    onNetwork: () => router.go({ name: 'network' }),
    onHome: () => router.go({ name: 'board' }),
  })

  function visibleModels(): ThreadMeta[] {
    if (threadRootId) {
      const flat = index.flatten(threadRootId)
      return flat.length ? flat : [index.byId.get(threadRootId)].filter(Boolean) as ThreadMeta[]
    }
    return [...index.byId.values()].filter((m) => m.role === 'root')
  }

  function refreshBoard(): void {
    board.setMetas(visibleModels())
    for (const m of visibleModels()) {
      if (m.thumbUrl) {
        assets.getPoster(m).then((tex) => { if (tex) board.setPoster(m.eventId, tex) })
      }
    }
  }

  function openStudio(rootId?: string, parentId?: string): void {
    if (studio) return
    const replyTo = rootId && parentId ? { rootId, parentId } : undefined
    studio = new Studio(engine, {
      replyTo,
      onClose: () => {
        studio?.dispose()
        studio = null
        // Return to where we were.
        router.back()
      },
      onPublished: (eventId, rootId) => {
        studio?.dispose()
        studio = null
        if (rootId && rootId !== eventId) {
          router.go({ name: 'thread', rootId, focusId: eventId })
        } else {
          router.go({ name: 'viewer', id: eventId })
        }
      },
      getConfig: () => config,
    })
    setMode('studio')
  }

  window.addEventListener('resize', () => {
    engine.resize()
    board.resize()
  })

  let current: Mode = 'board'
  function setMode(mode: Mode): void {
    if (mode === current && mode !== 'studio') return
    current = mode
    if (mode === 'board') {
      engine.setActiveScene(board.scene)
      topbar.setVisible(true)
      board.attach()
      refreshBoard()
    } else if (mode === 'viewer') {
      engine.setActiveScene(viewer.scene)
      topbar.setVisible(false)
    } else {
      engine.setActiveScene(studio!.scene)
      topbar.setVisible(false)
    }
  }

  async function openViewer(id?: string, fromThread?: string): Promise<void> {
    if (!id) { setMode('board'); return }
    const meta = index.byId.get(id)
    if (!meta) { setMode('board'); return }
    setMode('viewer')
    const blob = await assets.getModel(meta)
    if (blob) {
      try { await viewer.load(blob, meta) } catch { /* error mark */ }
    }
  }

  function applyRoute(route = router.current): void {
    if (route.name === 'board') {
      threadRootId = null
      setMode('board')
    } else if (route.name === 'thread') {
      threadRootId = route.rootId
      setMode('board')
      if (route.focusId) void openViewer(route.focusId, route.rootId)
    } else if (route.name === 'viewer') {
      void openViewer(route.id, route.fromThread)
    } else if (route.name === 'studio') {
      openStudio()
    } else if (route.name === 'network') {
      threadRootId = null
      setMode('board')
    }
  }
  router.subscribe(applyRoute)
  applyRoute()

  pool.onEvent = (event) => {
    if (event.kind === 5) {
      for (const t of event.tags) if (t[0] === 'e') index.tombstone(t[1])
      refreshBoard()
      return
    }
    const meta = parseModelEvent(event)
    if (!meta) return
    index.add(meta)
    // Update board if this event belongs to the visible thread or is a root.
    if (!threadRootId && meta.role === 'root') refreshBoard()
    else if (threadRootId && (meta.refs.rootId === threadRootId || meta.eventId === threadRootId)) refreshBoard()
    if (meta.thumbUrl) assets.getPoster(meta).then((tex) => { if (tex) board.setPoster(meta.eventId, tex) })
  }
  pool.onState = () => {
    const online = [...pool.state.values()].filter((s) => s === 'online').length
    topbar.setNetworkState(online === 0 ? 'connecting' : online < pool.relayUrls.length ? 'partial' : 'online')
  }
  setTimeout(() => pool.subscribeBoard(), 200)

  // IME text input for Studio text mode. The hidden textarea captures the
  // composition and feeds typed text to the studio when it is active.
  ime.addEventListener('input', () => {
    if (studio && current === 'studio') studio.setText(ime.value)
  })
  canvas.addEventListener('pointerdown', () => {
    if (studio && current === 'studio') { ime.focus({ preventScroll: true }) }
  })

  void saveNetworkConfig(config)
  ;(window as any).__form0 = { engine, pool, blossoms, index, board, viewer, router, config }
}

boot().catch((err) => console.error(err))
