import type { z } from 'zod'
import type { DocumentSchema } from '../core/state-store.port.js'

export interface DefineDocumentOptions<T> {
  readonly key: string
  readonly version: number
  readonly schema: z.ZodType<T>
  readonly initial: () => T
  /** `migrations[n]` turns version `n` data into version `n + 1` data. */
  readonly migrations?: Readonly<Record<number, (data: unknown) => unknown>>
}

/** Builds a `DocumentSchema` from a zod schema, with versioned migrations. */
export function defineDocument<T>(options: DefineDocumentOptions<T>): DocumentSchema<T> {
  return {
    key: options.key,
    version: options.version,
    initial: options.initial,
    parse(data, storedVersion) {
      if (!Number.isInteger(storedVersion) || storedVersion < 1 || storedVersion > options.version)
        return undefined
      let current = data
      for (let version = storedVersion; version < options.version; version += 1) {
        const migrate = options.migrations?.[version]
        if (migrate === undefined) return undefined
        try {
          current = migrate(current)
        } catch {
          return undefined
        }
      }
      const parsed = options.schema.safeParse(current)
      return parsed.success ? parsed.data : undefined
    },
  }
}
