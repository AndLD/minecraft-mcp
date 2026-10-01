import type { ItemFacts } from '../../core/item-facts.port.js'
import { distanceBetween } from '../../core/position.js'
import type { Position } from '../../core/position.types.js'
import type { ContainerEntry, ContainerIndex } from '../../state/container-index.js'
import type { StorageRules } from '../../state/storage-rules.js'
import { matchesAny } from './item-matcher.js'

export type StorageTarget =
  | { readonly kind: 'known'; readonly entry: ContainerEntry }
  /** A chest nobody registered; the caller registers it when it uses it. */
  | { readonly kind: 'unknown'; readonly position: Position; readonly blockName: string }

export interface SelectionContext {
  /** Where the bot is, for "nearest first". */
  readonly from: Position
  /** Fallback containers farther than this are not used. Rule targets are used wherever they are. */
  readonly maxDistance: number
  /** Container ids that are full or failed during this job. */
  readonly exclude: ReadonlySet<string>
  /** Containers found nearby that are not in the index. */
  readonly unknown: readonly { readonly position: Position; readonly blockName: string }[]
}

const hasSpace = (entry: ContainerEntry): boolean =>
  entry.emptySlots === null || entry.emptySlots > 0

/**
 * Chooses where an item goes: the first storage rule that matches it (highest priority first), otherwise any known
 * container with room (nearest first), otherwise a nearby container nobody registered yet. Protected containers are
 * never chosen. The strategy sits behind this class so it can be swapped without touching the skills.
 */
export class ContainerSelector {
  constructor(
    private readonly index: ContainerIndex,
    private readonly rules: StorageRules,
    private readonly facts: ItemFacts,
  ) {}

  /** The container the storage rules name for an item (highest priority first), or undefined when no rule applies. */
  ruled(item: string, exclude: ReadonlySet<string> = new Set()): ContainerEntry | undefined {
    for (const rule of this.rules.ordered()) {
      if (!matchesAny(rule.specs, item, this.facts)) continue
      const entry = this.index.get(rule.containerId)
      if (entry !== undefined && !entry.protected && !exclude.has(entry.id)) return entry
    }
    return undefined
  }

  select(item: string, context: SelectionContext): StorageTarget | undefined {
    const ruled = this.ruled(item, context.exclude)
    if (ruled !== undefined) return { kind: 'known', entry: ruled }

    const known = this.index
      .all()
      .filter((entry) => !entry.protected && !context.exclude.has(entry.id) && hasSpace(entry))
      .map((entry) => ({ entry, distance: distanceBetween(context.from, entry.position) }))
      .filter((candidate) => candidate.distance <= context.maxDistance)
      .sort((a, b) => a.distance - b.distance)[0]
    if (known !== undefined) return { kind: 'known', entry: known.entry }

    const unknown = context.unknown
      .filter((candidate) => this.index.at(candidate.position) === undefined)
      .map((candidate) => ({
        candidate,
        distance: distanceBetween(context.from, candidate.position),
      }))
      .filter((candidate) => candidate.distance <= context.maxDistance)
      .sort((a, b) => a.distance - b.distance)[0]
    return unknown === undefined ? undefined : { kind: 'unknown', ...unknown.candidate }
  }
}
