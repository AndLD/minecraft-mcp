import { z } from 'zod'
import type { ExcavationProvider } from './excavation.types.js'

export interface ExcavationInfo {
  readonly name: string
  readonly description: string
  /** JSON schema of the parameters, for the agent. */
  readonly params: unknown
}

/** The shapes that can be dug, by name. */
export class ExcavationRegistry {
  private readonly providers = new Map<string, ExcavationProvider>()

  register<Params>(provider: ExcavationProvider<Params>): this {
    this.providers.set(provider.name, provider)
    return this
  }

  get(name: string): ExcavationProvider | undefined {
    return this.providers.get(name)
  }

  names(): string[] {
    return [...this.providers.keys()].sort()
  }

  list(): ExcavationInfo[] {
    return this.names().flatMap((name) => {
      const provider = this.providers.get(name)
      return provider === undefined
        ? []
        : [
            {
              name,
              description: provider.description,
              params: z.toJSONSchema(provider.params, { io: 'input' }),
            },
          ]
    })
  }
}
