import type { ItemFacts } from '../../core/item-facts.port.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { isReserved } from '../storage/item-matcher.js'
import type { ItemRequest } from './handover.types.js'
import { ItemResolver, type Availability, type Candidate } from './item-resolver.js'

export type PlanFailure =
  | {
      readonly reason: 'ambiguous'
      readonly message: string
      readonly candidates: readonly Candidate[]
    }
  | {
      readonly reason: 'unknown_item'
      readonly message: string
      readonly suggestions: readonly string[]
    }

export interface WantedItem extends ItemCount {
  /** Ask for everything there is (`count` is then what is carried and stored right now). */
  readonly all: boolean
}

export interface Plan {
  readonly wanted: readonly WantedItem[]
  /** Requests for a group that matched nothing on hand: nothing to give, reported as missing. */
  readonly nothingOf: readonly ItemCount[]
}

const describeCandidate = (c: Candidate): string =>
  `${c.item} (${String(c.carried)} carried, ${String(c.stored)} in chests)`

/**
 * Turns the player's requests into concrete amounts of concrete items: resolves the words, expands "stacks" and
 * "all", and leaves reserved items (tools, armor, food, torches) out of anything that was asked for by a group.
 */
export class RequestPlanner {
  private readonly resolver: ItemResolver

  constructor(private readonly facts: ItemFacts) {
    this.resolver = new ItemResolver(facts)
  }

  plan(
    requests: readonly ItemRequest[],
    have: Availability,
    keepReserve: boolean,
  ): { ok: true; plan: Plan } | { ok: false; failure: PlanFailure } {
    const wanted = new Map<string, WantedItem>()
    const nothingOf: ItemCount[] = []

    for (const request of requests) {
      const resolution = this.resolver.resolve(request.item, have)
      if (resolution.kind === 'unknown')
        return {
          ok: false,
          failure: {
            reason: 'unknown_item',
            message: `"${request.item}" is not an item.${resolution.suggestions.length > 0 ? ` Did you mean: ${resolution.suggestions.join(', ')}?` : ''}`,
            suggestions: resolution.suggestions,
          },
        }
      if (resolution.kind === 'ambiguous')
        return {
          ok: false,
          failure: {
            reason: 'ambiguous',
            message: `"${request.item}" could mean several things. Ask the player which: ${resolution.candidates.map(describeCandidate).join('; ')}.`,
            candidates: resolution.candidates,
          },
        }

      const byGroup = resolution.via === 'group'
      const names = resolution.items
        .filter((name) => !(byGroup && keepReserve && isReserved(name, this.facts)))
        .sort((a, b) => this.onHand(b, have) - this.onHand(a, have) || a.localeCompare(b)) // most available first
      if (names.length === 0) {
        nothingOf.push({ name: request.item, count: this.asCount(request, request.item, 0) })
        continue
      }
      let left = this.asCount(request, names[0] ?? request.item, 0)
      for (const name of names) {
        const all = request.amount.kind === 'all'
        const available = this.onHand(name, have)
        const share = all ? available : names.length === 1 ? left : Math.min(left, available)
        left = all ? 0 : left - share
        if (share <= 0 && !all) continue
        const existing = wanted.get(name)
        wanted.set(name, {
          name,
          count: (existing?.count ?? 0) + share,
          all: (existing?.all ?? false) || all,
        })
      }
      if (request.amount.kind !== 'all' && left > 0 && names.length > 1)
        nothingOf.push({ name: request.item, count: left }) // a group asked for more than there is
    }
    return { ok: true, plan: { wanted: [...wanted.values()], nothingOf } }
  }

  private onHand(name: string, have: Availability): number {
    return (have.carried.get(name) ?? 0) + (have.stored.get(name) ?? 0)
  }

  /** How many a request asks for, in items. `all` counts as 0 here (it is filled from what is on hand). */
  private asCount(request: ItemRequest, item: string, fallback: number): number {
    switch (request.amount.kind) {
      case 'count':
        return request.amount.count
      case 'stacks':
        return request.amount.stacks * this.facts.stackSize(item)
      case 'all':
        return fallback
    }
  }
}
