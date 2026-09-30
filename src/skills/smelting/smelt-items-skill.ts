import type { Clock } from '../../core/clock.port.js'
import type { FurnaceAccess, FurnaceSession } from '../../core/furnace.port.js'
import { countItems } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import type { Skill, SkillContext, SkillFailure, SkillResult } from '../../core/skill.types.js'
import { sleep } from '../../core/sleep.js'
import type { SmeltJob, SmeltJobs } from '../../state/smelt-jobs.js'
import type { ItemCrafter } from '../crafting/craft-item-skill.js'
import type { Workstations } from '../crafting/workstations.js'
import { chooseFuel } from './fuel.js'
import { SMELTABLE_ITEMS, SMELTING_TABLE } from './smelting-table.js'

const FURNACE = 'furnace'
/** A furnace smelts one item in 10 seconds. */
const SMELT_MS_PER_ITEM = 10_000
const TIMEOUT_SLACK_MS = 30_000
/** Nothing has moved in a furnace with an empty fuel slot for this long: the fuel is gone. */
const STALL_MS = 30_000
const STACK_SIZE = 64
/** Between two looks into the furnace the bot waits about half of what is left, within these limits. */
const MIN_POLL_MS = 5_000
const MAX_POLL_MS = 60_000
/** How close the bot stands to a furnace it goes back to. */
const FURNACE_REACH = 2.5

export interface SmeltInput {
  readonly item: string
  /** How many to smelt; everything carried when undefined. */
  readonly count: number | undefined
  /** Fuel to burn; chosen from the inventory when undefined. */
  readonly fuel: string | undefined
  /**
   * `until_done` (default) waits for everything to be smelted and collected; `start_only` loads the furnace and
   * returns, leaving the job for a later call.
   */
  readonly wait?: 'until_done' | 'start_only'
  /** Take what a waiting job has finished, without loading anything new. `item` may be empty to mean any job. */
  readonly collect?: boolean
}

export interface SmeltOutput {
  readonly item: string
  readonly produced: string
  readonly smelted: number
  readonly requested: number
  readonly fuel: string
  /** Items still cooking or waiting in the furnace (a job left for later); 0 when everything is collected. */
  readonly pending: number
  /** The furnace block. */
  readonly furnace: Position
}

/** What other skills (cooking after a hunt) need from smelting. */
export interface ItemSmelter {
  run(input: SmeltInput, context: SkillContext): Promise<SkillResult<SmeltOutput>>
}

export interface SmeltItemsDeps {
  readonly inventory: InventoryReader
  readonly furnaces: FurnaceAccess
  readonly workstations: Workstations
  /** Used to craft a furnace when there is none. */
  readonly crafter: ItemCrafter
  readonly clock: Clock
  readonly scheduler: Scheduler
  /** Walks back to a furnace that holds a job. */
  readonly navigator: Navigator
  /** Jobs left burning by a wait that was cut short. */
  readonly jobs: SmeltJobs
}

/** How a pass over the furnace ended. */
interface Drive {
  readonly smelted: number
  readonly failure?: SkillFailure
  /** The job stays in the furnace (a wait that was cut short, or a job left for later): nothing is taken back. */
  readonly leave: boolean
}

/**
 * Smelts items in a furnace: finds one (or places one, crafting it if needed), loads fuel and items, waits, and
 * collects the output. The wait does not stand over the furnace: the window is closed while the items cook, and the
 * furnace is looked into again after about half of what is left (5 to 60 seconds). A wait that is cut short (the
 * player spoke, `stop`) leaves the furnace burning and writes the job down (`SmeltJobs`); the next `smelt` of the
 * same item, or `collect`, picks it up. When a job ends for any other reason, whatever is left in the furnace goes
 * back into the inventory.
 */
export class SmeltItemsSkill implements Skill<SmeltInput, SmeltOutput>, ItemSmelter {
  readonly name = 'smelt'

  constructor(private readonly deps: SmeltItemsDeps) {}

  async run(input: SmeltInput, context: SkillContext): Promise<SkillResult<SmeltOutput>> {
    const { deps } = this
    const wait = input.wait ?? 'until_done'
    if (input.collect === true) return this.collect(input.item, context)

    const produced = SMELTING_TABLE[input.item]
    if (produced === undefined)
      return err({
        reason: 'not_smeltable',
        message: `${input.item} cannot be smelted. Smeltable items include: ${SMELTABLE_ITEMS.slice(0, 12).join(', ')}, ...`,
      })

    // A job of the same item that was left in a furnace comes first.
    const waiting = deps.jobs.forItem(input.item)
    if (waiting !== undefined) return this.resume(waiting, wait, context)

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

    const holder = { session: opened.value }
    try {
      const busy = holder.session.contents()
      if (busy.input !== undefined && busy.input.name !== input.item)
        return err({
          reason: 'furnace_busy',
          message: `The furnace is already smelting ${busy.input.name}.`,
        })
      await holder.session.putFuel(fuel.item, fuel.amount)
      const job: SmeltJob = {
        x: furnace.value.x,
        y: furnace.value.y,
        z: furnace.value.z,
        item: input.item,
        produced,
        count: toSmelt,
        loaded: 0,
        collected: 0,
        fuel: fuel.item,
        startedAt: deps.clock.now(),
      }
      deps.jobs.put(job)
      return await this.finish(job, requested, holder, await this.drive(job, holder, wait, context))
    } catch (error) {
      await this.takeEverything(holder.session).catch(() => undefined)
      deps.jobs.remove(furnace.value)
      return err({
        reason: 'furnace_failed',
        message: `The furnace could not be used: ${error instanceof Error ? error.message : String(error)}`,
      })
    } finally {
      await holder.session.close()
    }
  }

  /** Takes what a waiting job has finished and lets it go on (or ends it when everything is done). */
  private async collect(item: string, context: SkillContext): Promise<SkillResult<SmeltOutput>> {
    const jobs = this.deps.jobs.all()
    const job = item === '' ? jobs[0] : this.deps.jobs.forItem(item)
    if (job === undefined)
      return err({
        reason: 'no_pending_job',
        message:
          item === ''
            ? 'No smelting job is waiting in a furnace.'
            : `No smelting job for ${item} is waiting in a furnace.`,
      })
    return this.resume(job, 'start_only', context)
  }

  /** Goes back to the furnace of a job that was left, and carries on from what it holds. */
  private async resume(
    job: SmeltJob,
    wait: 'until_done' | 'start_only',
    context: SkillContext,
  ): Promise<SkillResult<SmeltOutput>> {
    const { deps } = this
    const at = { x: job.x, y: job.y, z: job.z }
    const walked = await deps.navigator.goToPosition(at, FURNACE_REACH, { signal: context.signal })
    if (!walked.ok)
      return err({
        reason: walked.error.reason === 'aborted' ? 'aborted' : 'furnace_failed',
        message: `Could not get back to the furnace at ${String(job.x)} ${String(job.y)} ${String(job.z)}: ${walked.error.message}`,
      })
    const opened = await deps.furnaces.open(at)
    if (!opened.ok) {
      deps.jobs.remove(at)
      return err({
        reason: 'furnace_failed',
        message: `The furnace at ${String(job.x)} ${String(job.y)} ${String(job.z)} could not be opened, so its job was dropped: ${opened.error}`,
      })
    }
    const holder = { session: opened.value }
    try {
      return await this.finish(job, job.count, holder, await this.drive(job, holder, wait, context))
    } catch (error) {
      return err({
        reason: 'furnace_failed',
        message: `The furnace could not be used: ${error instanceof Error ? error.message : String(error)}`,
      })
    } finally {
      await holder.session.close()
    }
  }

  /** Turns how a pass ended into the result, taking the leftovers back unless the job stays in the furnace. */
  private async finish(
    job: SmeltJob,
    requested: number,
    holder: { session: FurnaceSession },
    outcome: Drive,
  ): Promise<SkillResult<SmeltOutput>> {
    const { jobs } = this.deps
    const furnace = { x: job.x, y: job.y, z: job.z }
    const collected = jobs.forItem(job.item)?.collected ?? job.count
    const done = (extra: { pending: number }): SmeltOutput => ({
      item: job.item,
      produced: job.produced,
      smelted: outcome.smelted,
      requested,
      fuel: job.fuel,
      furnace,
      ...extra,
    })
    if (outcome.failure === undefined && outcome.leave)
      return ok(done({ pending: Math.max(0, job.count - collected) }))
    if (outcome.failure !== undefined && outcome.leave)
      return err({
        ...outcome.failure,
        message: `${outcome.failure.message} ${String(outcome.smelted)} ${job.produced} collected so far; the rest is still in the furnace at ${String(job.x)} ${String(job.y)} ${String(job.z)}: call smelt again (or with collect) to go on.`,
        detail: { pending: Math.max(0, job.count - collected), furnace },
      })
    await this.takeEverything(holder.session)
    jobs.remove(furnace)
    if (outcome.failure !== undefined)
      return err({
        ...outcome.failure,
        message: `${outcome.failure.message} Smelted ${String(outcome.smelted)} of ${String(job.count)} ${job.produced}.`,
      })
    return ok(done({ pending: 0 }))
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

  /**
   * Looks into the furnace, takes the output, loads the next stack, and then closes the window and waits before
   * the next look. Returns when everything is collected, when the job must stop, or (`start_only`) after one look.
   */
  private async drive(
    job: SmeltJob,
    holder: { session: FurnaceSession },
    wait: 'until_done' | 'start_only',
    context: SkillContext,
  ): Promise<Drive> {
    const { clock, scheduler, jobs } = this.deps
    const furnace = { x: job.x, y: job.y, z: job.z }
    const state = { loaded: job.loaded, collected: job.collected }
    const before = state.collected
    const deadline =
      clock.now() + (job.count - state.collected) * SMELT_MS_PER_ITEM + TIMEOUT_SLACK_MS
    // Whether the furnace is burning cannot be trusted once the window has been closed and opened again (the flame
    // reads out while the last fuel item is burning; found by the e2e run), and the furnace takes a fuel item into
    // its burn queue the instant it starts burning, so an empty fuel slot proves nothing either. What does prove that
    // the fuel is gone is that nothing has moved for a long time: an item takes 10 seconds, so a furnace with an
    // empty fuel slot whose input and output have not changed for 30 seconds has stopped.
    let lastProgressAt = clock.now()
    let lastInput: number | undefined
    const so = (): number => state.collected - before

    for (;;) {
      const { session } = holder
      if (session.contents().output !== undefined) {
        const taken = await session.takeOutput()
        if (taken?.name === job.produced) {
          state.collected += taken.count
          lastProgressAt = clock.now()
          jobs.update(furnace, { collected: state.collected })
        }
      }
      if (state.collected >= job.count) return { smelted: so(), leave: false }
      if (state.loaded < job.count && session.contents().input === undefined) {
        const batch = Math.min(job.count - state.loaded, STACK_SIZE)
        await session.putInput(job.item, batch)
        state.loaded += batch
        jobs.update(furnace, { loaded: state.loaded })
      }
      const now = session.contents()
      if (now.input?.count !== lastInput) {
        lastInput = now.input?.count
        lastProgressAt = clock.now()
      }
      const stalled =
        state.loaded >= job.count &&
        now.input !== undefined &&
        !now.burning &&
        now.fuel === undefined &&
        clock.now() - lastProgressAt >= STALL_MS
      if (stalled)
        return {
          smelted: so(),
          leave: false,
          failure: { reason: 'out_of_fuel', message: 'The fuel ran out.' },
        }

      context.progress(`Smelted ${String(state.collected)} of ${String(job.count)} ${job.produced}`)
      if (wait === 'start_only') return { smelted: so(), leave: true }
      if (context.signal.aborted)
        return {
          smelted: so(),
          leave: true,
          failure: { reason: 'aborted', message: 'Cancelled.' },
        }
      if (clock.now() > deadline)
        return {
          smelted: so(),
          leave: false,
          failure: { reason: 'timeout', message: 'The furnace took too long.' },
        }

      // Do not stand looking into the furnace: close the window, wait, and look again.
      const remaining = (job.count - state.collected) * SMELT_MS_PER_ITEM
      await session.close()
      await sleep(
        scheduler,
        Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, remaining / 2)),
        context.signal,
      )
      const reopened = await this.deps.furnaces.open(furnace)
      if (!reopened.ok)
        return {
          smelted: so(),
          leave: true,
          failure: {
            reason: 'furnace_failed',
            message: `The furnace could not be opened again: ${reopened.error}.`,
          },
        }
      holder.session = reopened.value
    }
  }

  /** Puts whatever is still in the furnace back into the inventory. */
  private async takeEverything(session: FurnaceSession): Promise<void> {
    await session.takeOutput()
    await session.takeInput()
    await session.takeFuel()
  }
}
