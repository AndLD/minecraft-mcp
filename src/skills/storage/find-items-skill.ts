import type { ItemFacts } from '../../core/item-facts.port.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { ContainerIndex } from '../../state/container-index.js'
import { matchesSpec } from './item-matcher.js'
import type { ItemScanner } from './scan-containers-skill.js'

export interface FindInput {
  /** An item name or a group. */
  readonly query: string
  /** When nothing is remembered, open the containers nearby (and the known ones) and look again. */
  readonly scanIfMissing: boolean
  readonly radius: number
}

export interface FoundInContainer {
  readonly container: string
  readonly label: string | null
  readonly position: { readonly x: number; readonly y: number; readonly z: number }
  readonly protected: boolean
  readonly items: readonly ItemCount[]
  /** When the container was last opened. */
  readonly seenAt: string | null
}

export interface FindOutput {
  readonly matches: readonly FoundInContainer[]
  readonly total: number
  readonly scanned: boolean
}

export interface FindItemsDeps {
  readonly index: ContainerIndex
  readonly scanner: ItemScanner
  readonly facts: ItemFacts
}

/** Says which containers hold an item: from memory first, and after a fresh look when memory has nothing. */
export class FindItemsSkill implements Skill<FindInput, FindOutput> {
  readonly name = 'find_items'

  constructor(private readonly deps: FindItemsDeps) {}

  async run(input: FindInput, context: SkillContext): Promise<SkillResult<FindOutput>> {
    let matches = this.search(input.query)
    let scanned = false
    if (matches.length === 0 && input.scanIfMissing) {
      context.progress('Not in memory: looking into the containers')
      const scan = await this.deps.scanner.run(
        { radius: input.radius, refreshKnown: true },
        context,
      )
      if (!scan.ok) return scan
      scanned = true
      matches = this.search(input.query)
    }
    return ok({
      matches,
      total: matches.reduce(
        (sum, match) => sum + match.items.reduce((s, item) => s + item.count, 0),
        0,
      ),
      scanned,
    })
  }

  private search(query: string): FoundInContainer[] {
    return this.deps.index
      .all()
      .map((entry) => ({
        container: entry.id,
        label: entry.label,
        position: entry.position,
        protected: entry.protected,
        items: entry.contents.filter((stack) => matchesSpec(query, stack.name, this.deps.facts)),
        seenAt: entry.seenAt,
      }))
      .filter((match) => match.items.length > 0)
  }
}
