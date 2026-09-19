import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { DroppedItemScanner } from '../../core/dropped-items.port.js'
import type { EntityScanner } from '../../core/entity-scanner.port.js'
import type { Gaze } from '../../core/gaze.port.js'
import { countItems, describeItems } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import { distanceBetween } from '../../core/position.js'
import type { Position } from '../../core/position.types.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { EYE_HEIGHT } from '../../core/reach.js'
import { err, ok } from '../../core/result.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import { sleep } from '../../core/sleep.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { ContainerIndex } from '../../state/container-index.js'
import type { ItemDepositor } from '../storage/deposit-items-skill.js'
import type { WithdrawInput, WithdrawOutput } from '../storage/withdraw-items-skill.js'
import type { ItemRequest } from './handover.types.js'
import type { DropSpot } from './drop-spot.js'
import type { ItemThrower } from './item-thrower.js'
import { RequestPlanner } from './request-planner.js'
import type { ItemFacts } from '../../core/item-facts.port.js'

/** Close enough that the thrown items land at the player's feet. */
const APPROACH_RANGE = 2.5
/** How far from the drop the bot steps back so it does not pick its own items up again. */
const RETREAT_DISTANCE = 4
const VERIFY_MS = 8_000
const VERIFY_POLL_MS = 500

export interface GiveInput {
  readonly player: string
  readonly requests: readonly ItemRequest[]
  /** Look into the containers for what the bot does not carry. */
  readonly fetchFromStorage: boolean
  /** Leave tools, armor, food, and torches out of requests made by group. */
  readonly keepReserve: boolean
  /** `drop`: throw the items at the player's feet. `chest`: put them into a chest and say which. */
  readonly mode: 'drop' | 'chest'
  /** For chest mode: the container (id or label); by the storage rules when undefined. */
  readonly chest: string | undefined
}

export interface GiveOutput {
  readonly given: readonly ItemCount[]
  /** Asked for but not available anywhere the bot may look. */
  readonly shortfall: readonly ItemCount[]
  readonly mode: 'drop' | 'chest'
  /** Where the items went: the player's name, or the containers used. */
  readonly deliveredTo: string
  /** Drop mode: items still lying on the ground after a while (nobody picked them up). */
  readonly unclaimed: readonly ItemCount[]
}

export interface ItemWithdrawer {
  run(input: WithdrawInput, context: SkillContext): Promise<SkillResult<WithdrawOutput>>
}

export interface GiveItemsDeps {
  readonly inventory: InventoryReader
  readonly index: ContainerIndex
  readonly withdrawer: ItemWithdrawer
  readonly depositor: ItemDepositor
  readonly navigator: Navigator
  readonly entities: EntityScanner
  readonly blocks: BlockScanner
  readonly gaze: Gaze
  readonly thrower: ItemThrower
  readonly spot: DropSpot
  readonly drops: DroppedItemScanner
  readonly scheduler: Scheduler
  readonly vitals: VitalsReader
  readonly facts: ItemFacts
}

/**
 * Gives items to a player: works out what was meant, takes what the bot carries and fetches the rest from the
 * containers it may use, walks to the player, faces them, and throws the items at their feet (or puts them in a chest
 * for big amounts). It reports exactly what was given, what is missing, and what nobody picked up.
 */
export class GiveItemsSkill implements Skill<GiveInput, GiveOutput> {
  readonly name = 'give_items'
  private readonly planner: RequestPlanner

  constructor(private readonly deps: GiveItemsDeps) {
    this.planner = new RequestPlanner(deps.facts)
  }

  async run(input: GiveInput, context: SkillContext): Promise<SkillResult<GiveOutput>> {
    const { deps } = this
    const snapshot = deps.inventory.snapshot()
    if (snapshot === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })

    const planned = this.planner.plan(
      input.requests,
      this.availability(input.fetchFromStorage),
      input.keepReserve,
    )
    if (!planned.ok) return err({ ...planned.failure, detail: { ...planned.failure } })
    const { wanted, nothingOf } = planned.plan

    // 1. Fetch what the inventory lacks.
    if (input.fetchFromStorage) {
      const carried = countItems(snapshot)
      const fetch = wanted
        .map((item) => ({
          item: item.name,
          count: item.all ? undefined : Math.max(0, item.count - (carried.get(item.name) ?? 0)),
        }))
        .filter((request) => request.count === undefined || request.count > 0)
      if (fetch.length > 0) {
        context.progress('Fetching items from the containers')
        const fetched = await deps.withdrawer.run(
          { requests: fetch, container: undefined },
          context,
        )
        if (!fetched.ok && fetched.error.reason === 'aborted') return fetched
        // Any other failure just means there was less to fetch: the shortfall below says so.
      }
    }

    // 2. What can be given, and what is missing.
    const now = countItems(deps.inventory.snapshot())
    const give: ItemCount[] = []
    const shortfall: ItemCount[] = [...nothingOf]
    for (const item of wanted) {
      const have = now.get(item.name) ?? 0
      const count = item.all ? have : Math.min(item.count, have)
      if (count > 0) give.push({ name: item.name, count })
      if (!item.all && count < item.count)
        shortfall.push({ name: item.name, count: item.count - count })
    }
    if (give.length === 0)
      return err({
        reason: 'shortfall',
        message: `Nothing to give: missing ${describeItems(shortfall)}. It is not in the inventory${input.fetchFromStorage ? ' or in any container the bot may use' : ''}. Offer to gather, craft, or hunt it.`,
        detail: { shortfall },
      })

    // 3. Deliver.
    return input.mode === 'chest'
      ? this.toChest(input, give, shortfall, context)
      : this.toPlayer(input, give, shortfall, context)
  }

  private async toChest(
    input: GiveInput,
    give: readonly ItemCount[],
    shortfall: readonly ItemCount[],
    context: SkillContext,
  ): Promise<SkillResult<GiveOutput>> {
    const given: ItemCount[] = []
    const missing: ItemCount[] = [...shortfall]
    const places = new Set<string>()
    for (const item of give) {
      const deposited = await this.deps.depositor.run(
        {
          specs: [item.name],
          includeReserved: true,
          container: input.chest,
          count: item.count,
          maxDistance: 64,
        },
        context,
      )
      if (!deposited.ok) {
        if (deposited.error.reason === 'aborted') return deposited
        if (given.length === 0)
          return err({
            reason: deposited.error.reason,
            message: `Could not put the items in a chest: ${deposited.error.message}`,
          })
        missing.push(item)
        continue
      }
      for (const entry of deposited.value.deposited) {
        places.add(this.describeContainer(entry.container, entry.label))
        for (const moved of entry.items) given.push(moved)
      }
    }
    return ok({
      given,
      shortfall: missing,
      mode: 'chest',
      deliveredTo: `${[...places].join(', ')} (tell ${input.player} which chest)`,
      unclaimed: [],
    })
  }

  private async toPlayer(
    input: GiveInput,
    give: readonly ItemCount[],
    shortfall: readonly ItemCount[],
    context: SkillContext,
  ): Promise<SkillResult<GiveOutput>> {
    const { deps } = this
    const found = deps.entities.player(input.player)
    if (found === undefined)
      return err({ reason: 'player_not_online', message: `${input.player} is not online.` })
    if (found.position === undefined)
      return err({
        reason: 'player_not_visible',
        message: `${input.player} is online but out of the bot's view (far away, or in another dimension), so the bot cannot walk to them. Ask them to come closer.`,
      })

    context.progress(`Walking to ${input.player}`)
    const walked = await deps.navigator.goToPlayer(input.player, APPROACH_RANGE, {
      signal: context.signal,
    })
    if (!walked.ok)
      return err({
        reason:
          walked.error.reason === 'aborted'
            ? 'aborted'
            : walked.error.reason === 'target_not_found'
              ? 'player_not_visible'
              : 'unreachable',
        message: `Could not get to ${input.player}: ${walked.error.message}`,
      })

    const player = deps.entities.player(input.player)?.position ?? found.position
    const here = deps.vitals.read()?.position ?? walked.value
    const problem = deps.spot.problemAt(here)
    if (problem !== undefined)
      return err({
        reason: 'unsafe_drop_spot',
        message: `The bot will not drop the items here: ${problem}. Ask ${input.player} to come to solid ground, then try again.`,
      })

    await deps.gaze.lookAt({ x: player.x, y: player.y + EYE_HEIGHT - 0.5, z: player.z })
    context.progress(`Giving ${describeItems(give)}`)
    const thrown = await deps.thrower.throwAll(give, context.signal)
    if (context.signal.aborted && thrown.length === 0)
      return err({ reason: 'aborted', message: 'Cancelled.' })

    await this.retreat(here, player, context)
    const unclaimed = await this.unclaimed(thrown, here, context.signal)
    const missing = [...shortfall]
    for (const wanted of give) {
      const done = thrown.find((t) => t.name === wanted.name)?.count ?? 0
      if (done < wanted.count) missing.push({ name: wanted.name, count: wanted.count - done })
    }
    return ok({
      given: thrown,
      shortfall: missing,
      mode: 'drop',
      deliveredTo: input.player,
      unclaimed,
    })
  }

  /** Steps away from the drop, so the bot does not pick its own items up again. */
  private async retreat(from: Position, awayFrom: Position, context: SkillContext): Promise<void> {
    const dx = from.x - awayFrom.x
    const dz = from.z - awayFrom.z
    const length = Math.hypot(dx, dz) || 1
    const directions = [
      { x: dx / length, z: dz / length },
      { x: -dz / length, z: dx / length },
      { x: dz / length, z: -dx / length },
    ]
    for (const direction of directions) {
      const target = {
        x: from.x + direction.x * RETREAT_DISTANCE,
        y: from.y,
        z: from.z + direction.z * RETREAT_DISTANCE,
      }
      const moved = await this.deps.navigator.goToPosition(target, 1.5, { signal: context.signal })
      if (moved.ok || context.signal.aborted) return
    }
  }

  /** Waits a while and reports what still lies near the drop spot. */
  private async unclaimed(
    thrown: readonly ItemCount[],
    spot: Position,
    signal: AbortSignal,
  ): Promise<ItemCount[]> {
    const names = new Set(thrown.map((t) => t.name))
    const left = (): ItemCount[] => {
      const totals = new Map<string, number>()
      for (const drop of this.deps.drops.nearby(RETREAT_DISTANCE + 12)) {
        if (!names.has(drop.name) || distanceBetween(drop.position, spot) > 10) continue
        totals.set(drop.name, (totals.get(drop.name) ?? 0) + drop.count)
      }
      return [...totals].map(([name, count]) => ({ name, count }))
    }
    for (let waited = 0; waited < VERIFY_MS && left().length > 0; waited += VERIFY_POLL_MS) {
      if (signal.aborted) break
      await sleep(this.deps.scheduler, VERIFY_POLL_MS, signal)
    }
    return left()
  }

  /** What the bot may look for: carried items, and the contents of containers it is allowed to use. */
  private availability(fetch: boolean) {
    const stored = new Map<string, number>()
    if (fetch) {
      for (const entry of this.deps.index.all()) {
        if (entry.protected) continue
        for (const stack of entry.contents)
          stored.set(stack.name, (stored.get(stack.name) ?? 0) + stack.count)
      }
    }
    return { carried: countItems(this.deps.inventory.snapshot()), stored }
  }

  private describeContainer(id: string, label: string | null): string {
    const entry = this.deps.index.get(id)
    const where =
      entry === undefined
        ? ''
        : ` at ${String(entry.position.x)}, ${String(entry.position.y)}, ${String(entry.position.z)}`
    return `${label === null ? id : `"${label}"`}${where}`
  }
}
