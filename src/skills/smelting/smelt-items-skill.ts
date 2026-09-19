import type { Clock } from '../../core/clock.port.js'
import type { FurnaceAccess, FurnaceSession } from '../../core/furnace.port.js'
import { countItems } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import { err, ok } from '../../core/result.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import type { Skill, SkillContext, SkillFailure, SkillResult } from '../../core/skill.types.js'
import { sleep } from '../../core/sleep.js'
import type { ItemCrafter } from '../crafting/craft-item-skill.js'
import type { Workstations } from '../crafting/workstations.js'
import { chooseFuel } from './fuel.js'
import { SMELTABLE_ITEMS, SMELTING_TABLE } from './smelting-table.js'

const FURNACE = 'furnace'
/** A furnace smelts one item in 10 seconds. */
const SMELT_MS_PER_ITEM = 10_000
const TIMEOUT_SLACK_MS = 30_000
const POLL_MS = 1_000
const STACK_SIZE = 64

export interface SmeltInput {
  readonly item: string
  /** How many to smelt; everything carried when undefined. */
  readonly count: number | undefined
  /** Fuel to burn; chosen from the inventory when undefined. */
  readonly fuel: string | undefined
}

export interface SmeltOutput {
  readonly item: string
  readonly produced: string
  readonly smelted: number
  readonly requested: number
  readonly fuel: string
}

export interface SmeltItemsDeps {
  readonly inventory: InventoryReader
  readonly furnaces: FurnaceAccess
  readonly workstations: Workstations
  /** Used to craft a furnace when there is none. */
  readonly crafter: ItemCrafter
  readonly clock: Clock
  readonly scheduler: Scheduler
}

/**
 * Smelts items in a furnace: finds one (or places one, crafting it if needed), loads fuel and items, waits, and
 * collects the output. Whatever is left in the furnace when it stops for any reason goes back into the inventory.
 */
export class SmeltItemsSkill implements Skill<SmeltInput, SmeltOutput> {
  readonly name = 'smelt'

  constructor(private readonly deps: SmeltItemsDeps) {}

  async run(input: SmeltInput, context: SkillContext): Promise<SkillResult<SmeltOutput>> {
    const { deps } = this
    const produced = SMELTING_TABLE[input.item]
    if (produced === undefined)
      return err({
        reason: 'not_smeltable',
        message: `${input.item} cannot be smelted. Smeltable items include: ${SMELTABLE_ITEMS.slice(0, 12).join(', ')}, ...`,
      })

    const ready = await this.ensureFurnace(context)
    if (!ready.ok) return ready

    const counts = countItems(deps.inventory.snapshot())
    const have = counts.get(input.item) ?? 0
    const requested = input.count ?? have
    if (have === 0 || have < requested)
      return err({
        reason: 'missing_items',
        message: `Cannot smelt ${String(requested)} ${input.item}: the bot has ${String(have)}.`,
      })

    const fuel = chooseFuel({
      inventory: counts,
      toSmelt: requested,
      reserved: { name: input.item, count: requested },
      preferred: input.fuel,
    })
    if (fuel === undefined)
      return err({
        reason: 'no_fuel',
        message:
          input.fuel === undefined
            ? 'The bot has no fuel (coal, charcoal, planks, logs, or sticks).'
            : `The bot has no usable ${input.fuel} to burn.`,
      })
    const toSmelt = Math.min(requested, fuel.capacity)

    const furnace = await deps.workstations.ensure(FURNACE, context)
    if (!furnace.ok) return furnace
    const opened = await deps.furnaces.open(furnace.value)
    if (!opened.ok) return err({ reason: 'furnace_failed', message: opened.error })

    const session = opened.value
    try {
      const outcome = await this.smelt(session, { ...input, produced, toSmelt, fuel }, context)
      await this.takeEverything(session)
      if (outcome.failure !== undefined)
        return err({
          ...outcome.failure,
          message: `${outcome.failure.message} Smelted ${String(outcome.smelted)} of ${String(toSmelt)} ${produced}.`,
        })
      return ok({
        item: input.item,
        produced,
        smelted: outcome.smelted,
        requested,
        fuel: fuel.item,
      })
    } catch (error) {
      await this.takeEverything(session).catch(() => undefined)
      return err({
        reason: 'furnace_failed',
        message: `The furnace could not be used: ${error instanceof Error ? error.message : String(error)}`,
      })
    } finally {
      await session.close()
    }
  }

  /** Makes sure a furnace stands nearby or is carried, crafting one when the bot has neither. */
  private async ensureFurnace(context: SkillContext): Promise<SkillResult<undefined>> {
    if (this.deps.workstations.available(FURNACE)) return ok(undefined)
    const crafted = await this.deps.crafter.run({ item: FURNACE, count: 1 }, context)
    return crafted.ok
      ? ok(undefined)
      : err({
          reason: crafted.error.reason === 'aborted' ? 'aborted' : 'no_furnace',
          message: `There is no furnace nearby or in the inventory, and one could not be crafted: ${crafted.error.message}`,
        })
  }

  private async smelt(
    session: FurnaceSession,
    job: {
      readonly item: string
      readonly produced: string
      readonly toSmelt: number
      readonly fuel: { readonly item: string; readonly amount: number }
    },
    context: SkillContext,
  ): Promise<{ smelted: number; failure?: SkillFailure }> {
    const { clock, scheduler } = this.deps
    const busy = session.contents()
    if (busy.input !== undefined && busy.input.name !== job.item)
      return {
        smelted: 0,
        failure: {
          reason: 'furnace_busy',
          message: `The furnace is already smelting ${busy.input.name}.`,
        },
      }

    const deadline = clock.now() + job.toSmelt * SMELT_MS_PER_ITEM + TIMEOUT_SLACK_MS
    await session.putFuel(job.fuel.item, job.fuel.amount)
    let loaded = 0
    let smelted = 0

    while (smelted < job.toSmelt) {
      if (context.signal.aborted)
        return { smelted, failure: { reason: 'aborted', message: 'Cancelled.' } }
      if (clock.now() > deadline)
        return { smelted, failure: { reason: 'timeout', message: 'The furnace took too long.' } }

      const contents = session.contents()
      if (contents.output !== undefined) {
        const taken = await session.takeOutput()
        if (taken?.name === job.produced) smelted += taken.count
        if (smelted >= job.toSmelt) break
      }
      if (loaded < job.toSmelt && session.contents().input === undefined) {
        const batch = Math.min(job.toSmelt - loaded, STACK_SIZE)
        await session.putInput(job.item, batch)
        loaded += batch
      }
      const now = session.contents()
      if (
        loaded >= job.toSmelt &&
        now.input !== undefined &&
        !now.burning &&
        now.fuel === undefined
      )
        return { smelted, failure: { reason: 'out_of_fuel', message: 'The fuel ran out.' } }

      context.progress(`Smelted ${String(smelted)} of ${String(job.toSmelt)} ${job.produced}`)
      await sleep(scheduler, POLL_MS, context.signal)
    }
    return { smelted }
  }

  /** Puts whatever is still in the furnace back into the inventory. */
  private async takeEverything(session: FurnaceSession): Promise<void> {
    await session.takeOutput()
    await session.takeInput()
    await session.takeFuel()
  }
}
