import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { Logger } from '../core/logger.js'
import type { Scheduler } from '../core/scheduler.port.js'
import type { DocumentSchema, LoadedDocument, StateStore } from '../core/state-store.port.js'

export interface FileStateStoreOptions {
  /** Directory that holds this store's files. */
  readonly directory: string
  readonly scheduler: Scheduler
  readonly logger: Logger
  /** How long to wait after a save before writing, so bursts become one write. */
  readonly debounceMs?: number
}

const envelopeSchema = z.object({ version: z.number(), data: z.unknown() })
const DEFAULT_DEBOUNCE_MS = 500

interface PendingWrite {
  readonly document: DocumentSchema<unknown>
  readonly value: unknown
}

type ReadOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' }

/**
 * Stores each document as `<key>.json` in a directory: `{ "version": n, "data": ... }`.
 * Writes are atomic (temp file, then rename), keep the previous copy as `<key>.json.bak`, and are batched.
 * A corrupt file is set aside as `<key>.json.corrupt` and the backup (or the defaults) is used instead.
 */
export class FileStateStore implements StateStore {
  private readonly directory: string
  private readonly scheduler: Scheduler
  private readonly logger: Logger
  private readonly debounceMs: number
  private pending = new Map<string, PendingWrite>()
  private cancelTimer: (() => void) | undefined
  private writing: Promise<void> = Promise.resolve()

  constructor(options: FileStateStoreOptions) {
    this.directory = options.directory
    this.scheduler = options.scheduler
    this.logger = options.logger
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  }

  async load<T>(document: DocumentSchema<T>): Promise<LoadedDocument<T>> {
    const file = this.fileFor(document.key)
    const main = await this.read(file, document)
    if (main.kind === 'ok') return { value: main.value, source: 'file', warning: undefined }

    if (main.kind === 'invalid') await this.setAside(file)
    const backup = await this.read(`${file}.bak`, document)
    if (backup.kind === 'ok') {
      return {
        value: backup.value,
        source: 'backup',
        warning: `${document.key}.json could not be read; the previous copy was restored (the bad file is kept as ${document.key}.json.corrupt).`,
      }
    }
    const damaged = main.kind === 'invalid' || backup.kind === 'invalid'
    return {
      value: document.initial(),
      source: 'initial',
      warning: damaged
        ? `${document.key}.json could not be read and has no usable backup; starting empty (the bad file is kept as ${document.key}.json.corrupt).`
        : undefined,
    }
  }

  save<T>(document: DocumentSchema<T>, value: T): void {
    this.pending.set(document.key, { document, value })
    this.cancelTimer ??= this.scheduler.after(this.debounceMs, () => {
      this.cancelTimer = undefined
      void this.flush()
    })
  }

  flush(): Promise<void> {
    this.cancelTimer?.()
    this.cancelTimer = undefined
    const batch = [...this.pending.values()]
    this.pending = new Map()
    this.writing = this.writing.then(async () => {
      for (const write of batch) await this.write(write)
    })
    return this.writing
  }

  private fileFor(key: string): string {
    return path.join(this.directory, `${key}.json`)
  }

  private async read<T>(file: string, document: DocumentSchema<T>): Promise<ReadOutcome<T>> {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (isMissing(error)) return { kind: 'missing' }
      this.logger.warn('Could not read a state file', { file, error })
      return { kind: 'invalid' }
    }
    try {
      const envelope = envelopeSchema.safeParse(JSON.parse(text))
      if (!envelope.success) return { kind: 'invalid' }
      const value = document.parse(envelope.data.data, envelope.data.version)
      return value === undefined ? { kind: 'invalid' } : { kind: 'ok', value }
    } catch {
      return { kind: 'invalid' }
    }
  }

  private async setAside(file: string): Promise<void> {
    try {
      await rename(file, `${file}.corrupt`)
    } catch (error) {
      this.logger.warn('Could not set a corrupt state file aside', { file, error })
    }
  }

  private async write(write: PendingWrite): Promise<void> {
    const file = this.fileFor(write.document.key)
    try {
      await mkdir(this.directory, { recursive: true })
      const temporary = `${file}.tmp`
      await writeFile(
        temporary,
        JSON.stringify({ version: write.document.version, data: write.value }, null, 2),
      )
      try {
        await copyFile(file, `${file}.bak`)
      } catch (error) {
        if (!isMissing(error)) throw error
      }
      await rename(temporary, file)
    } catch (error) {
      this.logger.error('Could not save state', { file, error })
    }
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
