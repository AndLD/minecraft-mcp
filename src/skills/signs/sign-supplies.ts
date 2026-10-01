import type { InventoryReader } from '../../core/inventory.port.js'
import type { SkillContext } from '../../core/skill.types.js'
import type { ContainerIndex } from '../../state/container-index.js'
import type { MaterialFetcher } from '../building/material-fetcher.js'
import type { SupplyCrafter } from '../construction/crafting-supplies.js'
import { DEFAULT_SIGN_WOOD, isSignItem, signItemOf } from './sign-table.js'

/** Finds a sign item for the bot: what it carries, then what the known chests hold, then a craft. */
export interface SignSupplier {
  /** The name of a sign item now in the inventory (of the wood asked for, or any), or undefined when none could be had. */
  ensure(wood: string | undefined, context: SkillContext): Promise<string | undefined>
}

export interface SignSuppliesDeps {
  readonly inventory: InventoryReader
  readonly index: ContainerIndex
  readonly fetcher: MaterialFetcher
  readonly crafter: SupplyCrafter
}

export class SignSupplies implements SignSupplier {
  constructor(private readonly deps: SignSuppliesDeps) {}

  async ensure(wood: string | undefined, context: SkillContext): Promise<string | undefined> {
    const carried = this.carried(wood)
    if (carried !== undefined) return carried

    // Known chests first: a sign someone already made costs no wood. Containers marked protected are never touched.
    const stored = this.deps.index
      .all()
      .filter((container) => !container.protected)
      .flatMap((container) => container.contents)
      .find((stack) => stack.count > 0 && this.wanted(stack.name, wood))
    if (stored !== undefined) {
      await this.deps.fetcher.fetch([{ name: stored.name, count: 1 }], context)
      const fetched = this.carried(wood)
      if (fetched !== undefined) return fetched
    }
    if (context.signal.aborted) return undefined

    // Three signs per craft from six planks and a stick; `craft` makes the planks and sticks itself.
    const made = await this.deps.crafter.craft(signItemOf(wood ?? DEFAULT_SIGN_WOOD), 1, context)
    return made ? this.carried(wood) : undefined
  }

  private wanted(name: string, wood: string | undefined): boolean {
    return wood === undefined ? isSignItem(name) : name === signItemOf(wood)
  }

  private carried(wood: string | undefined): string | undefined {
    return this.deps.inventory
      .snapshot()
      ?.stacks.find((stack) => stack.count > 0 && this.wanted(stack.name, wood))?.name
  }
}
