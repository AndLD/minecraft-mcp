import { z } from 'zod'
import type { FarmLayoutProvider } from './farm-layout.types.js'

export interface FarmLayoutInfo {
  readonly kind: string
  readonly description: string
  /** JSON schema of the parameters, for the agent. */
  readonly params: unknown
}

/** The farm components `build_farm` can lay out, by kind. */
export class FarmLayoutRegistry {
  private readonly providers = new Map<string, FarmLayoutProvider>()

  register<Params>(provider: FarmLayoutProvider<Params>): this {
    this.providers.set(provider.kind, provider)
    return this
  }

  get(kind: string): FarmLayoutProvider | undefined {
    return this.providers.get(kind)
  }

  kinds(): string[] {
    return [...this.providers.keys()].sort()
  }

  list(): FarmLayoutInfo[] {
    return this.kinds().flatMap((kind) => {
      const provider = this.providers.get(kind)
      return provider === undefined
        ? []
        : [
            {
              kind,
              description: provider.description,
              params: z.toJSONSchema(provider.params, { io: 'input' }),
            },
          ]
    })
  }
}
