import { UNDO_CAP } from './types'

export interface Command {
  label: string
  undo(): void
  redo(): void
}

/**
 * Bounded command stack. New edits after undo drop the redo tail.
 * Prefer inverse commands (add/remove stamps) over full-store snapshots.
 */
export class History {
  private readonly stack: Command[] = []
  private head = -1

  constructor(readonly cap = UNDO_CAP) {}

  push(cmd: Command): void {
    if (this.head + 1 < this.stack.length) this.stack.length = this.head + 1
    this.stack.push(cmd)
    if (this.stack.length > this.cap) {
      this.stack.shift()
    }
    this.head = this.stack.length - 1
  }

  undo(): boolean {
    if (this.head < 0) return false
    this.stack[this.head].undo()
    this.head--
    return true
  }

  redo(): boolean {
    if (this.head + 1 >= this.stack.length) return false
    this.head++
    this.stack[this.head].redo()
    return true
  }

  get canUndo(): boolean { return this.head >= 0 }
  get canRedo(): boolean { return this.head + 1 < this.stack.length }
  get length(): number { return this.head + 1 }

  clear(): void {
    this.stack.length = 0
    this.head = -1
  }
}
