import { GROUPS, SETTINGS, BY_ID, type SettingDef, type SettingsValues } from './schema'
import type { SettingsStore } from './store'
import type { Capabilities } from './capabilities'

export interface PanelHooks {
  onAction: (id: string) => void
  /** live readout under the resolution controls */
  readout: () => string
  /** runtime failures from the renderer, e.g. a pipeline this GPU refused */
  runtimeError?: (id: string) => string | null
}

const HEX_SAFE = /^#[0-9a-f]{6}$/i

const SWATCHES = [
  { hex: '#0B0B0C', title: 'dark' },
  { hex: '#1d1d22', title: 'graphite' },
  { hex: '#3a3a42', title: 'grey' },
  { hex: '#101820', title: 'navy' },
  { hex: '#ffffff', title: 'light' },
]

/**
 * The settings drawer: every setting in `schema.ts`, grouped, searchable,
 * with quality presets. Rows whose platform support is missing render greyed
 * out with the reason instead of pretending to work.
 *
 * Legacy ids (`#bg-swatches`, `.swatch[data-bg]`, `#bg-custom`, `#inertia`)
 * are preserved because the headless suites drive them.
 */
export class SettingsPanel {
  private root: HTMLElement
  private body!: HTMLElement
  private search = ''
  private rows = new Map<string, HTMLElement>()
  private collapsed = new Set<string>()

  constructor(
    private store: SettingsStore,
    private caps: Capabilities,
    private hooks: PanelHooks,
  ) {
    this.root = document.getElementById('settings-panel') as HTMLElement
    this.build()
    this.store.subscribe(() => this.refresh())
  }

  get isOpen(): boolean { return !this.root.hidden }
  open(): void { this.root.hidden = false; this.refresh() }
  close(): void { this.root.hidden = true }
  toggle(): void { this.root.hidden ? this.open() : this.close() }

  /** Replace a select's options at runtime (audio devices). */
  setOptions(id: string, options: { value: string; label: string }[]): void {
    const row = this.rows.get(id)
    const select = row?.querySelector('select')
    if (!select) return
    const current = String(this.store.get(id))
    select.innerHTML = ''
    for (const o of options) {
      const el = document.createElement('option')
      el.value = o.value
      el.textContent = o.label
      select.appendChild(el)
    }
    select.value = options.some((o) => o.value === current) ? current : options[0]?.value ?? 'default'
  }

  // ------------------------------------------------------------------ build

  private build(): void {
    this.root.innerHTML = ''
    this.root.classList.add('settings-drawer')

    const head = el('div', 'drawer-head')
    head.append(span('SETTINGS'))
    const close = document.createElement('button')
    close.id = 'btn-settings-close'
    close.className = 'hbtn small'
    close.title = 'close'
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>'
    close.addEventListener('click', () => this.close())
    head.append(close)
    this.root.append(head)

    const searchWrap = el('div', 'settings-search')
    const search = document.createElement('input')
    search.type = 'search'
    search.id = 'settings-search'
    search.placeholder = 'search settings'
    search.autocomplete = 'off'
    search.addEventListener('input', () => { this.search = search.value.trim().toLowerCase(); this.refresh() })
    searchWrap.append(search)
    this.root.append(searchWrap)

    this.body = el('div', 'settings-body')
    this.root.append(this.body)

    for (const group of GROUPS) {
      const section = el('section', 'settings-group')
      section.dataset.group = group.id

      const title = el('button', 'group-head')
      title.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${group.icon}"/></svg><span>${group.label}</span><i class="chev"></i>`
      title.addEventListener('click', () => {
        if (this.collapsed.has(group.id)) this.collapsed.delete(group.id)
        else this.collapsed.add(group.id)
        this.refresh()
      })
      section.append(title)

      const rows = el('div', 'group-rows')
      if (group.id === 'presets') rows.append(this.buildPresets())
      for (const def of SETTINGS.filter((s) => s.group === group.id)) {
        const row = this.buildRow(def)
        this.rows.set(def.id, row)
        rows.append(row)
      }
      if (group.id === 'display') rows.append(this.buildReadout())
      section.append(rows)
      this.body.append(section)
    }

    const foot = el('div', 'settings-foot')
    const reset = document.createElement('button')
    reset.className = 'settings-reset'
    reset.textContent = 'Reset all to defaults'
    reset.addEventListener('click', () => this.store.resetAll())
    foot.append(reset)
    this.body.append(foot)

    this.refresh()
  }

  private buildPresets(): HTMLElement {
    const row = el('div', 'preset-row')
    for (const p of ['low', 'medium', 'high', 'ultra']) {
      const b = document.createElement('button')
      b.className = 'preset-btn'
      b.dataset.preset = p
      b.textContent = p
      b.addEventListener('click', () => this.store.applyPreset(p))
      row.append(b)
    }
    return row
  }

  private buildReadout(): HTMLElement {
    const row = el('div', 'settings-readout')
    row.id = 'resolution-readout'
    return row
  }

  private buildRow(def: SettingDef): HTMLElement {
    const row = el('div', 'setting')
    row.dataset.id = def.id
    const label = el('label', 'setting-name')
    label.textContent = def.label
    row.append(label)

    const control = el('div', 'setting-control')
    row.append(control)

    const commit = (value: string | number | boolean) => this.store.set({ [def.id]: value })

    switch (def.kind) {
      case 'toggle': {
        const input = document.createElement('input')
        input.type = 'checkbox'
        input.className = 'sw'
        input.id = `set-${def.id}`
        input.addEventListener('change', () => commit(input.checked))
        control.append(input)
        const track = el('label', 'sw-track')
        track.setAttribute('for', input.id)
        control.append(track)
        break
      }
      case 'select': {
        const select = document.createElement('select')
        select.id = `set-${def.id}`
        for (const o of def.options ?? []) {
          const opt = document.createElement('option')
          opt.value = o.value
          opt.textContent = o.label
          select.appendChild(opt)
        }
        select.addEventListener('change', () => commit(select.value))
        control.append(select)
        break
      }
      case 'slider': {
        const input = document.createElement('input')
        input.type = 'range'
        input.id = def.id === 'inertia' ? 'inertia' : `set-${def.id}`
        input.min = String(def.min ?? 0)
        input.max = String(def.max ?? 100)
        input.step = String(def.step ?? 1)
        const num = document.createElement('input')
        num.type = 'number'
        num.className = 'num'
        num.min = input.min; num.max = input.max; num.step = input.step
        const sync = (value: number) => { input.value = String(value); num.value = String(value); commit(value) }
        input.addEventListener('input', () => sync(Number(input.value)))
        num.addEventListener('change', () => sync(clamp(Number(num.value), def)))
        control.append(input, num)
        if (def.unit) control.append(span(def.unit, 'unit'))
        break
      }
      case 'number': {
        const num = document.createElement('input')
        num.type = 'number'
        num.className = 'num wide'
        num.id = `set-${def.id}`
        num.min = String(def.min ?? 0)
        num.max = String(def.max ?? Number.MAX_SAFE_INTEGER)
        num.step = String(def.step ?? 1)
        num.addEventListener('change', () => commit(clamp(Number(num.value), def)))
        control.append(num)
        if (def.unit) control.append(span(def.unit, 'unit'))
        break
      }
      case 'swatches': {
        const wrap = el('div', 'swatches')
        wrap.id = 'bg-swatches'
        for (const s of SWATCHES) {
          const b = document.createElement('button')
          b.className = 'swatch'
          b.dataset.bg = s.hex
          b.title = s.title
          b.style.background = s.hex
          b.addEventListener('click', () => commit(s.hex))
          wrap.append(b)
        }
        const custom = document.createElement('input')
        custom.type = 'color'
        custom.id = 'bg-custom'
        custom.addEventListener('input', () => commit(custom.value))
        wrap.append(custom)
        control.append(wrap)
        break
      }
      case 'action': {
        const b = document.createElement('button')
        b.className = 'setting-action'
        b.id = `set-${def.id}`
        b.textContent = 'Run'
        b.addEventListener('click', () => this.hooks.onAction(def.id))
        control.append(b)
        break
      }
      case 'info': {
        control.append(span('—', 'info-value'))
        break
      }
      case 'color': {
        const input = document.createElement('input')
        input.type = 'color'
        input.id = `set-${def.id}`
        input.value = HEX_SAFE.test(this.store.str(def.id)) ? this.store.str(def.id) : String(def.default ?? '#000000')
        input.addEventListener('input', () => commit(input.value))
        control.append(input)
        break
      }
    }

    if (def.hint) {
      const hint = el('p', 'setting-hint')
      hint.textContent = def.hint
      row.append(hint)
    }
    const why = el('p', 'setting-why')
    row.append(why)
    return row
  }

  // ---------------------------------------------------------------- refresh

  refresh(): void {
    if (this.root.hidden) return
    const v = this.store.all

    for (const p of this.root.querySelectorAll<HTMLElement>('.preset-btn')) {
      p.classList.toggle('active', p.dataset.preset === v.preset)
    }

    for (const def of SETTINGS) {
      const row = this.rows.get(def.id)
      if (!row) continue
      const reason = def.unavailable?.(this.caps) ?? this.hooks.runtimeError?.(def.id) ?? null
      const hiddenByCondition = def.showIf ? !def.showIf(v) : false
      const matchesSearch = !this.search
        || def.label.toLowerCase().includes(this.search)
        || def.id.toLowerCase().includes(this.search)
        || (def.hint ?? '').toLowerCase().includes(this.search)
      row.hidden = hiddenByCondition || !matchesSearch
      row.classList.toggle('unavailable', !!reason)
      const why = row.querySelector<HTMLElement>('.setting-why')
      if (why) { why.textContent = reason ?? ''; why.hidden = !reason }

      const value = v[def.id]
      const input = row.querySelector<HTMLInputElement>('input.sw')
      if (input) input.checked = !!value
      const select = row.querySelector<HTMLSelectElement>('select')
      if (select && value !== undefined) select.value = String(value)
      const range = row.querySelector<HTMLInputElement>('input[type=range]')
      if (range && value !== undefined) range.value = String(value)
      const num = row.querySelector<HTMLInputElement>('input.num')
      if (num && value !== undefined) num.value = String(value)
      const color = row.querySelector<HTMLInputElement>('#bg-custom')
      if (color && typeof value === 'string') color.value = value
      if (def.kind === 'color') {
        const picker = row.querySelector<HTMLInputElement>('input[type=color]')
        if (picker && typeof value === 'string' && HEX_SAFE.test(value)) picker.value = value
      }
      for (const sw of row.querySelectorAll<HTMLElement>('.swatch')) {
        sw.classList.toggle('active', sw.dataset.bg === value)
      }
      for (const control of row.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button')) {
        control.disabled = !!reason
      }
      if (def.kind === 'info') {
        const out = row.querySelector<HTMLElement>('.info-value')
        if (out) out.textContent = this.infoValue(def.id)
      }
      if (def.deferred) row.classList.add('deferred')
    }

    for (const group of GROUPS) {
      const section = this.body.querySelector<HTMLElement>(`[data-group="${group.id}"]`)
      if (!section) continue
      const rows = [...section.querySelectorAll<HTMLElement>('.setting')]
      const anyVisible = rows.some((r) => !r.hidden) || group.id === 'presets'
      section.hidden = !anyVisible
      section.classList.toggle('collapsed', this.collapsed.has(group.id) && !this.search)
    }

    const readout = this.root.querySelector<HTMLElement>('#resolution-readout')
    if (readout) readout.textContent = this.hooks.readout()
  }

  private infoValue(id: string): string {
    switch (id) {
      case 'hdr': return this.caps.hdrDisplay ? 'display reports HDR capability' : 'display reports SDR'
      case 'vsync': return 'always on (rAF)'
      case 'vramInfo': return this.caps.deviceMemoryGB ? `${this.caps.deviceMemoryGB} GB device memory reported` : 'not exposed'
      case 'rayTracing': case 'dlss': case 'fsr': case 'xess': case 'frameGen': return 'unavailable'
      default: return '—'
    }
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = cls
  return node
}
function span(text: string, cls = ''): HTMLSpanElement {
  const s = document.createElement('span')
  s.textContent = text
  if (cls) s.className = cls
  return s
}
function clamp(value: number, def: SettingDef): number {
  if (!Number.isFinite(value)) return Number(def.default ?? 0)
  const min = def.min ?? Number.NEGATIVE_INFINITY
  const max = def.max ?? Number.POSITIVE_INFINITY
  return Math.min(max, Math.max(min, value))
}

export { BY_ID }
export type { SettingsValues }
