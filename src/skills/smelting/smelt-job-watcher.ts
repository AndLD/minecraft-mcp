import type { Clock } from '../../core/clock.port.js'
import { distanceBetween } from '../../core/position.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { SmeltJob, SmeltJobs } from '../../state/smelt-jobs.js'
import { STATIONS } from './stations.js'

/** A furnace farther than this from the bot is mentioned in the signal. */
export const FAR_FURNACE_BLOCKS = 64

export interface SmeltJobWatcherDeps {
  readonly jobs: SmeltJobs
  readonly clock: Clock
  readonly scheduler: Scheduler
  /** Where the bot is, for the distance in the signal. */
  readonly vitals: VitalsReader
  /** Puts an event into the agent's inbox (`wait_for_chat` returns it). */
  emit(type: string, message: string): void
}

const keyOf = (job: SmeltJob): string =>
  `${String(job.x)},${String(job.y)},${String(job.z)}@${String(job.startedAt)}`

/** `minecraft:the_nether` and `the_nether` are the same dimension. */
export const plain = (dimension: string): string => dimension.replace(/^minecraft:/, '')

/** When the furnace should be done: the items are smelted one after the other, each in the station's time. */
export const readyAt = (job: SmeltJob): number =>
  job.startedAt + job.count * STATIONS[job.station].msPerItem

/**
 * Tells the agent when a job that was left in a furnace should be done, so the bot can do other things meanwhile. It
 * only uses the clock: it does not open the furnace or walk anywhere. A job is announced once (`readyNotified` is
 * saved), a job that a `smelt` task is waiting for is not (that task ends by itself), and the timers are rebuilt
 * whenever the jobs change or a world is opened, so a restart brings the signal back for a job that finished while
 * the bot was away.
 */
export class SmeltJobWatcher {
  private readonly timers = new Map<string, () => void>()
  private stop: (() => void) | undefined

  constructor(private readonly deps: SmeltJobWatcherDeps) {}

  start(): void {
    if (this.stop !== undefined) return
    this.stop = this.deps.jobs.subscribe(() => {
      this.refresh()
    })
    this.refresh()
  }

  dispose(): void {
    this.stop?.()
    this.stop = undefined
    this.cancelAll()
  }

  private refresh(): void {
    const { jobs, clock, scheduler } = this.deps
    this.cancelAll()
    for (const job of jobs.all()) {
      if (!job.detached || job.readyNotified) continue
      const key = keyOf(job)
      const wait = Math.max(0, readyAt(job) - clock.now())
      this.timers.set(
        key,
        scheduler.after(wait, () => {
          this.timers.delete(key)
          this.announce(job)
        }),
      )
    }
  }

  private announce(job: SmeltJob): void {
    const { jobs, vitals } = this.deps
    const current = jobs.all().find((other) => keyOf(other) === keyOf(job))
    if (current === undefined || !current.detached || current.readyNotified) return
    const at = `${String(job.x)} ${String(job.y)} ${String(job.z)}`
    const where = this.whereIs(job, vitals.read())
    this.deps.emit(
      'smelt_ready',
      `The furnace at ${at} should be done: ${String(job.count)} ${job.item} into ${job.produced}${where}. Call smelt with collect: true to take it.`,
    )
    jobs.update(job, { readyNotified: true })
  }

  /** Mentions a furnace that is far away, or in another dimension. */
  private whereIs(job: SmeltJob, now: ReturnType<VitalsReader['read']>): string {
    if (now === undefined) return ''
    if (plain(now.dimension) !== plain(job.dimension))
      return ` (in the ${plain(job.dimension)}, and the bot is in the ${plain(now.dimension)})`
    const away = Math.round(distanceBetween(now.position, { x: job.x, y: job.y, z: job.z }))
    return away > FAR_FURNACE_BLOCKS ? ` (about ${String(away)} blocks away)` : ''
  }

  private cancelAll(): void {
    for (const cancel of this.timers.values()) cancel()
    this.timers.clear()
  }
}
