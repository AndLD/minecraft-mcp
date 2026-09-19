/** Describes one persisted document: its file key, current version, defaults, and how to read old versions. */
export interface DocumentSchema<T> {
  /** File name without extension, for example `notes`. */
  readonly key: string
  readonly version: number
  initial(): T
  /** Validates stored data and migrates it from `storedVersion` to the current version. Undefined when unusable. */
  parse(data: unknown, storedVersion: number): T | undefined
}

export interface LoadedDocument<T> {
  readonly value: T
  /** Where the value came from. `initial` means there was nothing usable and the defaults are used. */
  readonly source: 'file' | 'backup' | 'initial'
  /** Set when something was wrong (a corrupt or unreadable file) and the agent should be told. */
  readonly warning: string | undefined
}

/** Persists small JSON documents. Writes are batched; call `flush()` before shutting down. */
export interface StateStore {
  load<T>(document: DocumentSchema<T>): Promise<LoadedDocument<T>>
  /** Schedules a write of the latest value. Does not wait. */
  save<T>(document: DocumentSchema<T>, value: T): void
  /** Writes everything scheduled and resolves when it is on disk. */
  flush(): Promise<void>
}
