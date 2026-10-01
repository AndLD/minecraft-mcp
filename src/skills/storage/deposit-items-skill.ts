import type { ItemFacts } from '../../core/item-facts.port.js'
import { countItems } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import { distanceBetween } from '../../core/position.js'
import type { Position } from '../../core/position.types.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { ContainerEntry, ContainerIndex } from '../../state/container-index.js'
import type { ContainerSelector, StorageTarget } from './container-selector.js'
import type { ContainerVisitor } from './container-visitor.js'
import { isReserved, matchesAny } from './item-matcher.js'

const MAX_ROUNDS = 8

export interface DepositInput {
  /** Item names or groups to deposit; everything that is not reserved when undefined. */
  readonly specs: readonly string[] | undefined
  /** Also deposit tools, armor, food, torches, and buckets. */
  readonly includeReserved: boolean
  /** A container (id or label) to use instead of the rules. */
  readonly container: string | undefined
  /** How many, when a single exact item is named; everything carried otherwise. */
  readonly count: number | undefined
  /** Fallback containers farther than this are not used. */
  readonly maxDistance: number
}

export interface DepositOutput {
  readonly deposited: readonly {
    readonly container: string
    readonly label: string | null
    readonly items: readonly ItemCount[]
  }[]
  /** Items that no container could take. */
  readonly leftover: readonly ItemCount[]
}

/** What other skills (offloading a full inventory, delivering cooked food) need from depositing. */
export interface ItemDepositor {
  run(input: DepositInput, context: SkillContext): Promise<SkillResult<DepositOutput>>
}

export interface DepositItemsDeps {
  readonly inventory: InventoryReader
  readonly vitals: VitalsReader
  readonly index: ContainerIndex
  readonly selector: ContainerSelector
  readonly visitor: ContainerVisitor
  readonly facts: ItemFacts
}

/**
 * Puts items into containers: where a storage rule says, otherwise into any known container with room (nearest
 * first), otherwise into a container nobody registered yet (it is registered on the way). A container that is full
 * or gone is skipped and the rest go elsewhere. Protected containers are never used, and tools, armor, food, torches,
 * and buckets stay with the bot unless named.
 */
export class DepositItemsSkill implements Skill<DepositInput, DepositOutput>, ItemDepositor {
  readonly name = 'deposit_items'

  constructor(private readonly deps: DepositItemsDeps) {}

  async run(input: DepositInput, context: SkillContext): Promise<SkillResult<DepositOutput>> {
    const { deps } = this
    const snapshot = deps.inventory.snapshot()
    if (snapshot === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })

    let explicit: ContainerEntry | undefined
    if (input.container !== undefined) {
      explicit = deps.index.resolve(input.container)
      if (explicit === undefined)
        return err({
          reason: 'unknown_container',
          message: `There is no container "${input.container}". See list_containers.`,
        })
      if (explicit.protected)
        return err({
          reason: 'protected',
          message: `${deps.visitor.describe(explicit)} is protected, so nothing is put into it.`,
        })
    }

    const remaining = this.chosenItems(countItems(snapshot), input)
    if (remaining.size === 0)
      return err({
        reason: 'nothing_to_deposit',
        message:
          input.specs === undefined
            ? 'The bot carries nothing it may deposit (tools, armor, food, torches, and buckets are kept).'
            : `The bot carries none of ${input.specs.join(', ')}.`,
      })

    const exclude = new Set<string>()
    const deposited = new Map<string, { entry: ContainerEntry; items: Map<string, number> }>()
    const problems: string[] = []
    let unknown: { position: Position; blockName: string }[] | undefined

    for (let round = 0; round < MAX_ROUNDS && remaining.size > 0; round += 1) {
      if (context.signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })
      const here = deps.vitals.read()?.position
      if (here === undefined)
        return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })
      unknown ??= deps.visitor.unknownNear(input.maxDistance)

      // Who takes what this round.
      const groups = new Map<string, { target: StorageTarget; items: string[] }>()
      for (const item of remaining.keys()) {
        let target: StorageTarget | undefined
        if (explicit !== undefined)
          target = exclude.has(explicit.id) ? undefined : { kind: 'known', entry: explicit }
        else
          target = deps.selector.select(item, {
            from: here,
            maxDistance: input.maxDistance,
            exclude,
            unknown,
          })
        if (target === undefined) continue
        const key =
          target.kind === 'known'
            ? target.entry.id
            : `${String(target.position.x)},${String(target.position.y)},${String(target.position.z)}`
        const group = groups.get(key) ?? { target, items: [] }
        group.items.push(item)
        groups.set(key, group)
      }
      if (groups.size === 0) break

      const ordered = [...groups.values()]
        .map((group) => ({ group, distance: distanceBetween(here, targetPosition(group.target)) }))
        .sort((a, b) => a.distance - b.distance)
      for (const { group } of ordered) {
        const entry = this.entryFor(group.target)
        if (entry === undefined) continue
        const visit = await deps.visitor.visit(entry, context, async (session) => {
          const moved = new Map<string, number>()
          for (const item of group.items) {
            const wanted = remaining.get(item) ?? 0
            const done = await session.deposit(
              item,
              wanted >= (countItems(deps.inventory.snapshot()).get(item) ?? 0) ? undefined : wanted,
            )
            if (done > 0) moved.set(item, done)
            remaining.set(item, wanted - done)
            if (wanted - done > 0) exclude.add(entry.id) // no room for the rest of it here
          }
          return moved
        })
        if (!visit.ok) {
          if (visit.error.reason === 'aborted') return err(visit.error)
          exclude.add(entry.id)
          problems.push(visit.error.message)
          continue
        }
        const record = deposited.get(entry.id) ?? { entry, items: new Map<string, number>() }
        for (const [item, count] of visit.value)
          record.items.set(item, (record.items.get(item) ?? 0) + count)
        if (visit.value.size > 0) deposited.set(entry.id, record)
        for (const [item, count] of remaining) if (count <= 0) remaining.delete(item)
      }
    }

    const leftover = [...remaining]
      .filter(([, count]) => count > 0)
      .map(([name, count]) => ({ name, count }))
    if (deposited.size === 0)
      return err({
        reason: 'no_storage_space',
        message:
          `Nothing could be deposited: no container with room (${leftover.map((i) => `${String(i.count)} ${i.name}`).join(', ')} left).` +
          (problems.length > 0 ? ` ${problems.join(' ')}` : ''),
        detail: { leftover },
      })
    return ok({
      deposited: [...deposited.values()].map(({ entry, items }) => ({
        container: entry.id,
        label: entry.label,
        items: [...items].map(([name, count]) => ({ name, count })),
      })),
      leftover,
    })
  }

  /** What to deposit: the matching stacks of the inventory, without the reserved ones unless named. */
  private chosenItems(
    counts: ReadonlyMap<string, number>,
    input: DepositInput,
  ): Map<string, number> {
    const { facts } = this.deps
    const chosen = new Map<string, number>()
    for (const [name, total] of counts) {
      const reserved = isReserved(name, facts)
      const wanted =
        input.specs === undefined
          ? input.includeReserved || !reserved
          : matchesAny(input.specs, name, facts) &&
            (input.includeReserved || !reserved || input.specs.includes(name))
      if (wanted) chosen.set(name, total)
    }
    if (input.count !== undefined && chosen.size === 1) {
      for (const [name, total] of chosen) chosen.set(name, Math.min(total, input.count))
    }
    return chosen
  }

  /** The index entry for a target, registering a container nobody knew. */
  private entryFor(target: StorageTarget): ContainerEntry | undefined {
    if (target.kind === 'known') return target.entry
    const registered = this.deps.index.register(target.position, target.blockName, { auto: true })
    return registered.ok ? registered.value : undefined
  }
}

const targetPosition = (target: StorageTarget): Position =>
  target.kind === 'known' ? target.entry.position : target.position
