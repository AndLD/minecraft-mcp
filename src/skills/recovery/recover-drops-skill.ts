import type { Clock } from '../../core/clock.port.js'
import type { Combatant, GearReport } from '../../core/combatant.port.js'
import type { DroppedItem } from '../../core/dropped-items.port.js'
import { countItems, gained } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import { distanceBetween, roundPosition } from '../../core/position.js'
import type { Position } from '../../core/position.types.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { err, ok } from '../../core/result.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import type { Skill, SkillContext, SkillFailure, SkillResult } from '../../core/skill.types.js'
import { sleep } from '../../core/sleep.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { DropRecord, DropRecords, DropStatus } from '../../state/drop-records.js'
import type { DropCollector } from '../gathering/drop-collector.js'
import type { DropIgnoreList } from './drop-ignore-list.js'
import type { HazardAssessor } from './hazard-assessor.js'
import { mergeCounts, subtractCounts, totalOf } from './item-counts.js'
import { checkDeadline } from './recovery-timing.js'

/** How close the bot gets before it looks at the spot again for hazards and mobs. */
const STAGING_RANGE = 6
/** Items within this many blocks of the spot belong to it (drops scatter). */
const SPOT_RADIUS = 12
const SWEEP_REACH = 20
const MAX_SWEEPS = 4
const SWEEP_PAUSE_MS = 1_000

export const TRY_CAREFULLY = 'try_carefully'
export const ABANDON = 'abandon'

export interface RecoverInput {
  /** A record id; the newest recoverable one when undefined. */
  readonly record: string | undefined
  /** Attempts one record may have had before the bot refuses to go again without being told to. */
  readonly maxAttempts: number
}

export interface RecoverOutput {
  readonly record: string
  readonly kind: DropRecord['kind']
  readonly position: Position
  readonly status: DropStatus
  /** What the inventory gained in this attempt. */
  readonly recovered: readonly ItemCount[]
  /** Death drops: what is still missing overall. */
  readonly missing: readonly ItemCount[]
  /** Armor, weapon, and shield put on after the pickup. */
  readonly gear: GearReport | undefined
}

export interface ItemRecoverer {
  run(input: RecoverInput, context: SkillContext): Promise<SkillResult<RecoverOutput>>
}

export interface RecoverDropsDeps {
  readonly records: DropRecords
  readonly inventory: InventoryReader
  readonly vitals: VitalsReader
  readonly navigator: Navigator
  readonly collector: DropCollector
  readonly hazards: HazardAssessor
  readonly combatant: Combatant
  readonly ignore: DropIgnoreList
  readonly clock: Clock
  readonly scheduler: Scheduler
}

const where = (position: Position): string => {
  const rounded = roundPosition(position)
  return `${String(Math.round(rounded.x))}, ${String(Math.round(rounded.y))}, ${String(Math.round(rounded.z))}`
}

/**
 * Fetches items lying where the bot died, or where it dropped something for a player that nobody took. It refuses
 * when the items would vanish before it gets there, looks at the spot for danger from a distance and asks the player
 * when there is any, picks up everything that scattered, puts armor, weapon, and shield on, and says what is still
 * missing. A record can only be tried a limited number of times, so a deadly spot cannot cause a loop of deaths.
 */
export class RecoverDropsSkill implements Skill<RecoverInput, RecoverOutput>, ItemRecoverer {
  readonly name = 'recover_drops'

  constructor(private readonly deps: RecoverDropsDeps) {}

  async run(input: RecoverInput, context: SkillContext): Promise<SkillResult<RecoverOutput>> {
    const { deps } = this
    const snapshot = deps.inventory.snapshot()
    const here = deps.vitals.read()
    if (snapshot === undefined || here === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })

    const record = this.pick(input.record)
    if (!record.ok) return record
    const target = record.value

    const refusal = this.refuse(target, input.maxAttempts, here.dimension, here.position)
    if (refusal !== undefined) return err(refusal)

    const before = countItems(snapshot)
    deps.records.update(target.id, { status: 'recovering', attempts: target.attempts + 1 })
    try {
      return await this.attempt(target, before, context)
    } finally {
      this.settle(target.id, before)
    }
  }

  private pick(id: string | undefined): SkillResult<DropRecord> {
    const { records } = this.deps
    records.expireStale()
    if (id === undefined) {
      const newest = records.recoverable()[0]
      return newest === undefined
        ? err({
            reason: 'no_record',
            message:
              'There is nothing to recover: no death or unclaimed drop is on record (or it has already despawned).',
          })
        : ok(newest)
    }
    const found = records.get(id)
    if (found === undefined)
      return err({ reason: 'no_record', message: `There is no drop record "${id}".` })
    return ok(found)
  }

  /** The reasons not to go at all. */
  private refuse(
    record: DropRecord,
    maxAttempts: number,
    dimension: string,
    from: Position,
  ): SkillFailure | undefined {
    const spot = where(record.position)
    const detail = { record: record.id, position: record.position, dimension: record.dimension }
    switch (record.status) {
      case 'recovering':
        return {
          reason: 'already_recovering',
          message: `${record.id} is already being recovered.`,
          detail,
        }
      case 'expired':
        return {
          reason: 'expired',
          message: `The items at ${spot} despawned (dropped items vanish after 5 minutes).`,
          detail,
        }
      case 'recovered':
      case 'gone':
        return {
          reason: 'nothing_left',
          message: `${record.id} needs no recovery (${record.status}).`,
          detail,
        }
      default:
    }
    if (record.attempts >= maxAttempts)
      return {
        reason: 'max_attempts',
        message: `The bot already tried ${String(record.attempts)} time(s) to recover ${record.id} at ${spot}, and will not go again on its own. Ask the player, then call recover_drops with a higher max_attempts.`,
        detail,
      }
    if (record.dimension !== dimension)
      return {
        reason: 'wrong_dimension',
        message: `The items lie at ${spot} in ${record.dimension}, but the bot is in ${dimension} and cannot cross dimensions on its own.`,
        detail,
      }
    const deadline = checkDeadline({
      at: record.at,
      now: this.deps.clock.now(),
      distance: distanceBetween(from, record.position),
    })
    if (deadline.ok) return undefined
    if (deadline.reason === 'expired') {
      this.deps.records.update(record.id, { status: 'expired' })
      return {
        reason: 'expired',
        message: `The items at ${spot} despawned (dropped items vanish after 5 minutes).`,
        detail,
      }
    }
    return {
      reason: 'too_far',
      message: `The bot needs about ${String(deadline.etaSeconds)} s to reach ${spot}, but the items vanish in ${String(deadline.secondsLeft)} s. It will not try; tell the player the coordinates.`,
      detail: { ...detail, etaSeconds: deadline.etaSeconds, secondsLeft: deadline.secondsLeft },
    }
  }

  private async attempt(
    record: DropRecord,
    before: ReadonlyMap<string, number>,
    context: SkillContext,
  ): Promise<SkillResult<RecoverOutput>> {
    const { deps } = this
    const spot = record.position
    const detail = { record: record.id, position: spot, dimension: record.dimension }

    context.progress(`Walking towards ${where(spot)}`)
    const staged = await deps.navigator.goToPosition(spot, STAGING_RANGE, {
      signal: context.signal,
    })
    if (!staged.ok) {
      return err({
        reason: staged.error.reason === 'aborted' ? 'aborted' : 'unreachable',
        message: `Could not get near ${where(spot)}: ${staged.error.message}`,
        detail,
      })
    }

    const hazards = deps.hazards.assess(spot)
    if (hazards.length > 0) {
      const answer = await this.askAboutHazards(record, hazards, context)
      if (answer !== TRY_CAREFULLY) {
        deps.records.update(record.id, {
          status: 'abandoned',
          note: `Not recovered: ${hazards.join('; ')}.`,
        })
        return err({
          reason: context.signal.aborted ? 'aborted' : 'abandoned',
          message: `Recovery of ${record.id} was called off (${hazards.join('; ')}). The items lie at ${where(spot)}.`,
          detail: { ...detail, hazards },
        })
      }
    }

    context.progress('Collecting the items')
    const names = record.kind === 'unclaimed' ? record.lost.map((item) => item.name) : undefined
    const arrived = await deps.navigator.goToPosition(spot, 2, { signal: context.signal })
    if (!arrived.ok && arrived.error.reason === 'aborted')
      return err({ reason: 'aborted', message: 'Cancelled.', detail })
    await this.sweep(spot, names, context.signal)
    if (context.signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.', detail })

    const gainedNow = gained(before, countItems(deps.inventory.snapshot()))
    const left = this.onTheGround(spot, names)
    const gear = gainedNow.length > 0 ? await deps.combatant.equipBestGear() : undefined
    return this.conclude(record, gainedNow, left, gear, detail)
  }

  private conclude(
    record: DropRecord,
    gainedNow: readonly ItemCount[],
    left: readonly DroppedItem[],
    gear: GearReport | undefined,
    detail: Record<string, unknown>,
  ): SkillResult<RecoverOutput> {
    const { deps } = this
    const recovered = mergeCounts(record.recovered, gainedNow)
    const missing = record.kind === 'death' ? subtractCounts(record.lost, recovered) : []
    const full = deps.inventory.snapshot()?.emptySlots === 0
    let status: DropStatus
    if (record.kind === 'death')
      status = missing.length === 0 ? 'recovered' : totalOf(recovered) > 0 ? 'partial' : 'pending'
    else if (left.length > 0) status = gainedNow.length > 0 ? 'partial' : 'pending'
    else status = gainedNow.length > 0 ? 'recovered' : 'gone'
    deps.records.update(record.id, { status, recovered })

    if (gainedNow.length === 0 && left.length > 0)
      return err({
        reason: full ? 'inventory_full' : 'unreachable',
        message: full
          ? `The inventory is full, so the items at ${where(record.position)} stay where they are. Free some space (deposit_items or drop_items) and call recover_drops again.`
          : `Could not pick up the items at ${where(record.position)}: they are out of reach.`,
        detail,
      })
    if (gainedNow.length === 0 && record.kind === 'death')
      return err({
        reason: 'nothing_found',
        message: `No items were found at ${where(record.position)}. They may have despawned, fallen somewhere else, or been taken.`,
        detail,
      })
    return ok({
      record: record.id,
      kind: record.kind,
      position: record.position,
      status,
      recovered: gainedNow,
      missing,
      gear,
    })
  }

  private async askAboutHazards(
    record: DropRecord,
    hazards: readonly string[],
    context: SkillContext,
  ): Promise<string | undefined> {
    if (context.ask === undefined) return ABANDON
    return context.ask({
      message:
        `The place where ${record.id} lies (${where(record.position)}) looks dangerous: ${hazards.join('; ')}. ` +
        `Should the bot try carefully (it never walks into lava or the void, so what lies there stays there), or leave the items and keep the coordinates?`,
      options: [TRY_CAREFULLY, ABANDON],
    })
  }

  /** Items that belong to the spot and are not junk the bot dropped on purpose. */
  private onTheGround(spot: Position, names: readonly string[] | undefined): DroppedItem[] {
    return [...this.deps.collector.matching(this.filter(spot, names))]
  }

  private filter(spot: Position, names: readonly string[] | undefined) {
    return {
      names,
      maxDistance: SWEEP_REACH,
      accept: (item: DroppedItem) =>
        distanceBetween(item.position, spot) <= SPOT_RADIUS && !this.deps.ignore.isIgnored(item),
    }
  }

  private async sweep(
    spot: Position,
    names: readonly string[] | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const { deps } = this
    const carried = (): number => totalOf([...countItems(deps.inventory.snapshot())].map(toCount))
    let idle = 0
    for (let round = 0; round < MAX_SWEEPS; round += 1) {
      const filter = this.filter(spot, names)
      const start = carried()
      await deps.collector.collect(filter, signal)
      if (signal.aborted || deps.collector.matching(filter).length === 0) return
      idle = carried() > start ? 0 : idle + 1
      if (idle >= 2) return
      await sleep(deps.scheduler, SWEEP_PAUSE_MS, signal)
    }
  }

  /** Whatever ends the attempt (an abort, a crash), the record must not stay "recovering". */
  private settle(id: string, before: ReadonlyMap<string, number>): void {
    const { records, inventory } = this.deps
    const current = records.get(id)
    if (current?.status !== 'recovering') return
    const recovered = mergeCounts(
      current.recovered,
      gained(before, countItems(inventory.snapshot())),
    )
    records.update(id, { status: totalOf(recovered) > 0 ? 'partial' : 'pending', recovered })
  }
}

const toCount = ([name, count]: [string, number]): ItemCount => ({ name, count })
