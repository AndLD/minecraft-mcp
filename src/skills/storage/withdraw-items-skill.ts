import type { ItemFacts } from '../../core/item-facts.port.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import { distanceBetween } from '../../core/position.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { ContainerEntry, ContainerIndex } from '../../state/container-index.js'
import type { ContainerVisitor } from './container-visitor.js'
import { isGroup, matchesSpec } from './item-matcher.js'

export interface WithdrawRequest {
  /** An item name, or a group such as `ores` (then everything known that matches). */
  readonly item: string
  /** How many; everything found when undefined. */
  readonly count: number | undefined
}

export interface WithdrawInput {
  readonly requests: readonly WithdrawRequest[]
  /** Take only from this container (id or label). */
  readonly container: string | undefined
}

export interface WithdrawOutput {
  readonly withdrawn: readonly ItemCount[]
  /** For requests with a count: what could not be found or did not fit. */
  readonly shortfall: readonly ItemCount[]
}

export interface WithdrawItemsDeps {
  readonly inventory: InventoryReader
  readonly vitals: VitalsReader
  readonly index: ContainerIndex
  readonly visitor: ContainerVisitor
  readonly facts: ItemFacts
}

/**
 * Takes items out of containers, nearest first, and reports what it got and what is missing. It reads what a
 * container really holds when it opens it (the index may be out of date). Protected containers are never touched.
 */
export class WithdrawItemsSkill implements Skill<WithdrawInput, WithdrawOutput> {
  readonly name = 'withdraw_items'

  constructor(private readonly deps: WithdrawItemsDeps) {}

  async run(input: WithdrawInput, context: SkillContext): Promise<SkillResult<WithdrawOutput>> {
    const { deps } = this
    let only: ContainerEntry | undefined
    if (input.container !== undefined) {
      only = deps.index.resolve(input.container)
      if (only === undefined)
        return err({
          reason: 'unknown_container',
          message: `There is no container "${input.container}". See list_containers.`,
        })
      if (only.protected)
        return err({
          reason: 'protected',
          message: `${deps.visitor.describe(only)} is protected, so nothing is taken from it.`,
        })
    }

    const withdrawn = new Map<string, number>()
    const shortfall: ItemCount[] = []
    let stoppedFull = false

    for (const request of input.requests) {
      for (const name of this.itemNames(request.item, only)) {
        if (context.signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })
        const wanted = request.count ?? Number.POSITIVE_INFINITY
        let got = 0
        for (const entry of this.candidates(name, only)) {
          if (got >= wanted) break
          const room = this.roomFor(name)
          if (room <= 0) {
            stoppedFull = true
            break
          }
          const visit = await deps.visitor.visit(entry, context, (session) =>
            session.withdraw(name, Math.min(wanted - got, room)),
          )
          if (!visit.ok) {
            if (visit.error.reason === 'aborted') return err(visit.error)
            continue // gone or unreachable: try the next container
          }
          got += visit.value
        }
        if (got > 0) withdrawn.set(name, (withdrawn.get(name) ?? 0) + got)
        if (request.count !== undefined && got < request.count)
          shortfall.push({ name, count: request.count - got })
        if (stoppedFull) break
      }
      if (stoppedFull) break
    }

    if (withdrawn.size === 0)
      return err({
        reason: stoppedFull ? 'inventory_full' : 'not_found',
        message: stoppedFull
          ? 'The inventory has no room for these items.'
          : `${input.requests.map((r) => r.item).join(', ')} is not in any known container that may be used. Try scan_containers, or check list_containers (protected containers are never used).`,
        detail: { shortfall },
      })
    return ok({
      withdrawn: [...withdrawn].map(([name, count]) => ({ name, count })),
      shortfall,
    })
  }

  /** The item names a request stands for: itself, or every known item of a group. */
  private itemNames(spec: string, only: ContainerEntry | undefined): string[] {
    if (!isGroup(spec)) return [spec]
    const names = new Set<string>()
    for (const entry of only === undefined ? this.deps.index.all() : [only]) {
      if (entry.protected) continue
      for (const stack of entry.contents)
        if (matchesSpec(spec, stack.name, this.deps.facts)) names.add(stack.name)
    }
    return [...names].sort()
  }

  /** Containers that held the item when last seen, nearest first. */
  private candidates(name: string, only: ContainerEntry | undefined): ContainerEntry[] {
    const from = this.deps.vitals.read()?.position
    const pool = only === undefined ? this.deps.index.all().filter((e) => !e.protected) : [only]
    return pool
      .filter((entry) => entry.contents.some((stack) => stack.name === name))
      .sort((a, b) =>
        from === undefined
          ? 0
          : distanceBetween(from, a.position) - distanceBetween(from, b.position),
      )
  }

  /** How many of the item the inventory can take (whole free slots only). */
  private roomFor(name: string): number {
    const snapshot = this.deps.inventory.snapshot()
    return snapshot === undefined ? 0 : snapshot.emptySlots * this.deps.facts.stackSize(name)
  }
}
