import type { Clock } from '../../core/clock.port.js'
import type { FurnaceAccess, FurnaceSession } from '../../core/furnace.port.js'
import { countItems } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Position } from '../../core/position.types.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { err, ok } from '../../core/result.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import type { Skill, SkillContext, SkillFailure, SkillResult } from '../../core/skill.types.js'
import { sleep } from '../../core/sleep.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { SmeltJob, SmeltJobs } from '../../state/smelt-jobs.js'
import type { ItemCrafter } from '../crafting/craft-item-skill.js'
import type { Workstations } from '../crafting/workstations.js'
import { chooseFuel, totalFuelCapacity } from './fuel.js'
import type { FuelFetcher } from './fuel-supply.js'
import { plain, readyAt } from './smelt-job-watcher.js'
import { SMELTABLE_ITEMS, SMELTING_TABLE } from './smelting-table.js'
import type { CampfireCooker } from './campfire-cook-skill.js'
import {
  CAMPFIRE,
  CAMPFIRE_BLOCKS,
  STATIONS,
  campfireCooks,
  stationSmelts,
  stationsFor,
  type AnyStation,
  type Station,
} from './stations.js'

const FURNACE = 'furnace'
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
  /**
   * Take fuel from storage (registered, unprotected containers) when the bag's fuel does not cover the job. Off by
   * default: the bot uses only what it carries.
   */
  readonly fuelFromStorage?: boolean
  /**
   * Which block smelts it: a `blast_furnace` (ores and raw metals) or a `smoker` (food) is twice as fast and makes the
   * fuel last twice as long; a `furnace` does everything. `auto` (the default) uses a blast furnace or a smoker that
   * stands nearby or is carried when it can smelt the item, and a furnace otherwise. A `campfire` cooks raw food on
   * the block with no fuel and no window (up to four at a time, 30 seconds each); `auto` uses one that stands nearby
   * when the bag has no fuel or the batch is small (up to 8) and no smoker is at hand.
   */
  readonly station?: 'auto' | AnyStation
}

export interface SmeltOutput {
  readonly item: string
  readonly produced: string
  readonly smelted: number
  readonly requested: number
  /** The block that smelted it. */
  readonly station: AnyStation
  /** The fuel the job started with. */
  readonly fuel: string
  /** Fuel taken out of storage for this job (`fuelFromStorage`), per kind. */
  readonly fuelFetched?: readonly ItemCount[]
  /** Fuel that was burned in this call (put in, less what was taken back out), by item: it may be several kinds. */
  readonly fuelUsed: readonly ItemCount[]
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
  /** Where the bot is (the dimension a job's furnace stands in). Without it every furnace is assumed reachable. */
  readonly vitals?: VitalsReader
  /** Takes fuel out of storage (`fuelFromStorage`). Without it the option does nothing. */
  readonly fuelSupply?: FuelFetcher
  /** Cooks food on a campfire. Without it a campfire is never chosen. */
  readonly campfire?: CampfireCooker
}

/** A campfire is chosen by itself for a batch this small even when the bag has fuel: it saves the coal. */
const SMALL_CAMPFIRE_BATCH = 8

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

    const chosen = this.chooseStation(input)
    if (!chosen.ok) return chosen
    if (chosen.value === CAMPFIRE) return this.cookOnCampfire(input, produced, context)
    const station = chosen.value
    const speed = STATIONS[station].speed
    const ready = await this.ensureStation(station, context)
    if (!ready.ok) return ready

    let counts = countItems(deps.inventory.snapshot())
    const have = counts.get(input.item) ?? 0
    const requested = input.count ?? have
    if (have === 0 || have < requested)
      return err({
        reason: 'missing_items',
        message: `Cannot smelt ${String(requested)} ${input.item}: the bot has ${String(have)}.`,
      })

    // With `fuelFromStorage`, what the bag's fuel does not cover is taken out of storage before the furnace is used.
    let fetched: ItemCount[] = []
    if (input.fuelFromStorage === true && deps.fuelSupply !== undefined) {
      const capacity = totalFuelCapacity({
        inventory: counts,
        reserved: { name: input.item, count: requested },
        preferred: input.fuel,
        speed,
      })
      if (capacity < requested) {
        context.progress(
          `Fetching fuel from storage for ${String(requested - capacity)} more items`,
        )
        fetched = await deps.fuelSupply.fetch(requested - capacity, input.fuel, context, speed)
        counts = countItems(deps.inventory.snapshot())
      }
    }

    const fuel = chooseFuel({
      inventory: counts,
      toSmelt: requested,
      reserved: { name: input.item, count: requested },
      preferred: input.fuel,
      speed,
    })
    if (fuel === undefined)
      return err({
        reason: 'no_fuel',
        message:
          input.fuel === undefined
            ? 'The bot has no fuel (coal, charcoal, planks, logs, or sticks).'
            : `The bot has no usable ${input.fuel} to burn.`,
      })
    // All the fuel in the bag counts, not just the first kind: the rest is put in at the looks as the job goes on.
    const toSmelt = Math.min(
      requested,
      Math.max(
        fuel.capacity,
        totalFuelCapacity({
          inventory: counts,
          reserved: { name: input.item, count: requested },
          preferred: input.fuel,
          speed,
        }),
      ),
    )

    const furnace = await deps.workstations.ensure(STATIONS[station].block, context)
    if (!furnace.ok) return furnace
    const opened = await deps.furnaces.open(furnace.value)
    if (!opened.ok) return err({ reason: 'furnace_failed', message: opened.error })

    const holder = { session: opened.value }
    try {
      const busy = holder.session.contents()
      if (busy.input !== undefined && busy.input.name !== input.item)
        return err({
          reason: 'furnace_busy',
          message: `The ${station.replace('_', ' ')} is already smelting ${busy.input.name}.`,
        })
      await holder.session.putFuel(fuel.item, fuel.amount)
      const used = new Map<string, number>([[fuel.item, fuel.amount]])
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
        station,
        dimension: plain(deps.vitals?.read()?.dimension ?? 'overworld'),
        detached: false,
        readyNotified: false,
      }
      deps.jobs.put(job)
      const outcome = await this.drive(job, holder, wait, used, context)
      return await this.finish(job, requested, holder, outcome, used, fetched)
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

  /** Cooks on a campfire: no furnace, fuel, or job record (the food pops out of the fire by itself). */
  private async cookOnCampfire(
    input: SmeltInput,
    produced: string,
    context: SkillContext,
  ): Promise<SkillResult<SmeltOutput>> {
    const cooker = this.deps.campfire
    if (cooker === undefined)
      return err({ reason: 'no_campfire', message: 'Cooking on a campfire is not available.' })
    const cooked = await cooker.cook({ item: input.item, produced, count: input.count }, context)
    if (!cooked.ok) return cooked
    return ok({
      item: input.item,
      produced,
      smelted: cooked.value.cooked,
      requested: input.count ?? cooked.value.cooked,
      station: CAMPFIRE,
      fuel: 'none',
      fuelUsed: [],
      pending: 0,
      furnace: cooked.value.fire,
    })
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
    const here = deps.vitals?.read()?.dimension
    if (here !== undefined && plain(here) !== plain(job.dimension))
      return err({
        reason: 'furnace_far',
        message: `The furnace at ${String(job.x)} ${String(job.y)} ${String(job.z)} is in the ${plain(job.dimension)}, and the bot is in the ${plain(here)}. Go back there to collect it; the job is kept.`,
        detail: { furnace: at, dimension: job.dimension },
      })
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
    // A task waits for this job from here on: no ready signal is needed until it is left again.
    deps.jobs.update(at, { detached: false })
    const holder = { session: opened.value }
    try {
      const used = new Map<string, number>()
      const outcome = await this.drive(job, holder, wait, used, context)
      return await this.finish(job, job.count, holder, outcome, used)
    } catch (error) {
      deps.jobs.update(at, { detached: true })
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
    used: Map<string, number>,
    fetched: readonly ItemCount[] = [],
  ): Promise<SkillResult<SmeltOutput>> {
    const { jobs, clock } = this.deps
    const furnace = { x: job.x, y: job.y, z: job.z }
    const collected = jobs.forItem(job.item)?.collected ?? job.count
    const burned = (): ItemCount[] =>
      [...used].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count }))
    const done = (extra: { pending: number }): SmeltOutput => ({
      item: job.item,
      produced: job.produced,
      smelted: outcome.smelted,
      requested,
      fuel: job.fuel,
      station: job.station,
      fuelUsed: burned(),
      ...(fetched.length === 0 ? {} : { fuelFetched: fetched }),
      furnace,
      ...extra,
    })
    if (outcome.leave) {
      // Left in the furnace: from here on the ready signal watches it. When the estimate is already past and items
      // remain, something is wrong (fuel, most likely), so the signal is not sent again.
      jobs.update(furnace, { detached: true, readyNotified: readyAt(job) <= clock.now() })
    }
    if (outcome.failure === undefined && outcome.leave)
      return ok(done({ pending: Math.max(0, job.count - collected) }))
    if (outcome.failure !== undefined && outcome.leave)
      return err({
        ...outcome.failure,
        message: `${outcome.failure.message} ${String(outcome.smelted)} ${job.produced} collected so far; the rest is still in the furnace at ${String(job.x)} ${String(job.y)} ${String(job.z)}: call smelt again (or with collect) to go on.`,
        detail: { pending: Math.max(0, job.count - collected), furnace },
      })
    const back = await this.takeEverything(holder.session)
    if (back !== undefined) used.set(back.name, (used.get(back.name) ?? 0) - back.count)
    jobs.remove(furnace)
    if (outcome.failure !== undefined)
      return err({
        ...outcome.failure,
        message: `${outcome.failure.message} Smelted ${String(outcome.smelted)} of ${String(job.count)} ${job.produced}.`,
      })
    return ok(done({ pending: 0 }))
  }

  /**
   * The block to smelt in. `auto` takes a blast furnace or a smoker that stands nearby or is carried when it can smelt
   * the item (twice as fast); then, for food, a campfire that stands nearby when the bag has no usable fuel or the
   * batch is small; otherwise a furnace. A station that is asked for by name must be able to smelt the item and must
   * be there: a blast furnace, a smoker, and a campfire are not crafted on the way (a furnace is).
   */
  private chooseStation(input: SmeltInput): SkillResult<AnyStation> {
    const { workstations, campfire } = this.deps
    const item = input.item
    const wanted = input.station ?? 'auto'
    const campfireStands =
      campfire !== undefined && workstations.nearestOf(CAMPFIRE_BLOCKS) !== undefined
    if (wanted === 'auto') {
      const fast = stationsFor(item).find(
        (station) => station !== 'furnace' && workstations.available(STATIONS[station].block),
      )
      if (fast !== undefined) return ok(fast)
      if (campfireStands && campfireCooks(item) && this.campfireFits(input)) return ok(CAMPFIRE)
      return ok('furnace')
    }
    if (wanted === CAMPFIRE) {
      if (!campfireCooks(item))
        return err({
          reason: 'wrong_station',
          message: `A campfire only cooks raw food (beef, porkchop, mutton, chicken, rabbit, cod, salmon, potato), not ${item}. Use a furnace.`,
        })
      if (!campfireStands)
        return err({
          reason: 'no_campfire',
          message:
            'There is no campfire nearby. A campfire is made from 3 sticks, 1 coal or charcoal, and 3 logs. Use a furnace, or make one first.',
        })
      return ok(CAMPFIRE)
    }
    if (!stationSmelts(wanted, item))
      return err({
        reason: 'wrong_station',
        message:
          wanted === 'smoker'
            ? `A smoker only cooks food (and dries kelp), not ${item}. Use a furnace.`
            : `A blast furnace only smelts ores and raw metals, not ${item}. Use a furnace.`,
      })
    if (wanted !== 'furnace' && !workstations.available(STATIONS[wanted].block))
      return err({
        reason: `no_${wanted}`,
        message: `There is no ${wanted.replace('_', ' ')} nearby and none in the inventory. ${
          wanted === 'smoker'
            ? 'A smoker is made from a furnace and 4 logs.'
            : 'A blast furnace is made from 5 iron ingots, a furnace, and 3 smooth stone.'
        } Use a furnace, or craft one first.`,
      })
    return ok(wanted)
  }

  /** Whether a campfire is the sensible block for this batch: a small one, or the bag has no fuel for it. */
  private campfireFits(input: SmeltInput): boolean {
    const counts = countItems(this.deps.inventory.snapshot())
    const requested = input.count ?? counts.get(input.item) ?? 0
    if (requested <= SMALL_CAMPFIRE_BATCH) return true
    return (
      chooseFuel({
        inventory: counts,
        toSmelt: requested,
        reserved: { name: input.item, count: requested },
        preferred: input.fuel,
        speed: 1,
      }) === undefined
    )
  }

  /** Makes sure the station stands nearby or is carried; only a furnace is crafted when the bot has neither. */
  private async ensureStation(
    station: Station,
    context: SkillContext,
  ): Promise<SkillResult<undefined>> {
    if (station !== 'furnace' || this.deps.workstations.available(FURNACE)) return ok(undefined)
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
    used: Map<string, number>,
    context: SkillContext,
  ): Promise<Drive> {
    const { clock, scheduler, jobs } = this.deps
    const msPerItem = STATIONS[job.station].msPerItem
    const furnace = { x: job.x, y: job.y, z: job.z }
    const state = { loaded: job.loaded, collected: job.collected }
    const before = state.collected
    const deadline = clock.now() + (job.count - state.collected) * msPerItem + TIMEOUT_SLACK_MS
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
      await this.topUpFuel(session, job, state, used)
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
      const remaining = (job.count - state.collected) * msPerItem
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

  /**
   * Puts more fuel in when the fuel slot is empty and items are still to cook, from what the bot carries: the same
   * kind the job started with while there is some, otherwise by the usual order. An empty slot proves nothing about
   * the flame (the furnace takes a fuel item into its burn queue at once), but a spare item put in is not lost:
   * whatever is unused comes back out when the job ends. The job is limited by the fuel in the bag, not by the first
   * load, so a big job runs in stages.
   */
  private async topUpFuel(
    session: FurnaceSession,
    job: SmeltJob,
    state: { loaded: number; collected: number },
    used: Map<string, number>,
  ): Promise<void> {
    const left = job.count - state.collected
    if (left <= 0 || state.loaded === 0 || session.contents().fuel !== undefined) return
    const inventory = countItems(this.deps.inventory.snapshot())
    const notLoaded = job.count - state.loaded
    const options = {
      inventory,
      toSmelt: left,
      reserved: notLoaded > 0 ? { name: job.item, count: notLoaded } : undefined,
      speed: STATIONS[job.station].speed,
    }
    const choice = chooseFuel({ ...options, preferred: job.fuel }) ?? chooseFuel(options)
    if (choice === undefined) return
    const amount = Math.min(choice.amount, STACK_SIZE)
    await session.putFuel(choice.item, amount)
    used.set(choice.item, (used.get(choice.item) ?? 0) + amount)
  }

  /** Puts whatever is still in the furnace back into the inventory. Returns the fuel that came back. */
  private async takeEverything(session: FurnaceSession): Promise<ItemCount | undefined> {
    await session.takeOutput()
    await session.takeInput()
    const fuel = await session.takeFuel()
    return fuel === undefined ? undefined : { name: fuel.name, count: fuel.count }
  }
}
