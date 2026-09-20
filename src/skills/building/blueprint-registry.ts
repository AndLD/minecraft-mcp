import { z } from 'zod'
import type { BlueprintProvider } from './blueprint.types.js'

export interface BlueprintInfo {
  readonly name: string
  readonly description: string
  /** JSON schema of the parameters, for the agent. */
  readonly params: unknown
}

/** The shapes that can be built, by name. */
export class BlueprintRegistry {
  private readonly providers = new Map<string, BlueprintProvider>()

  register<Params>(provider: BlueprintProvider<Params>): this {
    this.providers.set(provider.name, provider)
    return this
  }

  get(name: string): BlueprintProvider | undefined {
    return this.providers.get(name)
  }

  names(): string[] {
    return [...this.providers.keys()].sort()
  }

  list(): BlueprintInfo[] {
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
