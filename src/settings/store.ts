import { get, put } from '../protocol/storage'
import { defaults, PRESETS, PRESET_KEYS, type SettingsValues } from './schema'

const KEY = 'default'
const STORE = 'settings' as const

/**
 * Settings state: one flat record, persisted to IndexedDB, with change
 * notifications. Legacy keys (`background`, `inertia`) are preserved so older
 * saved settings keep working.
 */
export class SettingsStore {
  private values: SettingsValues = defaults()
  private listeners = new Set<(v: SettingsValues, changed: string[]) => void>()

  get all(): SettingsValues { return this.values }
  get<T = string | number | boolean>(id: string): T { return this.values[id] as T }
  num(id: string): number { return Number(this.values[id]) }
  bool(id: string): boolean { return !!this.values[id] }
  str(id: string): string { return String(this.values[id]) }

  async load(): Promise<SettingsValues> {
    const saved = await get<Record<string, unknown>>(STORE, KEY)
    if (!saved) {
      // Fresh install: start at Medium. It is the preset that runs on the
      // widest range of devices, and adaptive resolution covers the rest.
      this.values = { ...defaults(), ...PRESETS.medium, preset: 'medium' }
      return this.values
    }
    if (saved && typeof saved === 'object') {
      const merged = { ...defaults() }
      for (const [k, v] of Object.entries(saved)) {
        if (v === null || v === undefined) continue
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') merged[k] = v
      }
      // legacy: inertia used to be stored 0..1
      if (typeof saved.inertia === 'number' && saved.inertia <= 1) merged.inertia = Math.round(saved.inertia * 100)
      this.values = merged
    }
    return this.values
  }

  subscribe(fn: (v: SettingsValues, changed: string[]) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Apply a patch. `fromPreset` keeps the preset selector from flipping to Custom. */
  set(patch: SettingsValues, fromPreset = false): void {
    const changed: string[] = []
    for (const [k, v] of Object.entries(patch)) {
      if (this.values[k] === v) continue
      this.values[k] = v
      changed.push(k)
    }
    if (!changed.length) return
    if (!fromPreset && changed.some((k) => PRESET_KEYS.includes(k)) && this.values.preset !== 'custom') {
      this.values.preset = 'custom'
      changed.push('preset')
    }
    void put(STORE, KEY, this.values)
    for (const fn of this.listeners) fn(this.values, changed)
  }

  applyPreset(name: string): void {
    const preset = PRESETS[name]
    if (!preset) return
    this.set({ ...preset, preset: name }, true)
  }

  resetAll(): void {
    this.values = defaults()
    void put(STORE, KEY, this.values)
    for (const fn of this.listeners) fn(this.values, Object.keys(this.values))
  }
}
