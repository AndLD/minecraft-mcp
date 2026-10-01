import { z } from 'zod'
import type { StateStore } from '../core/state-store.port.js'
import { defineDocument } from './define-document.js'
import type { ProfileScoped } from './profile-scoped.types.js'

const jobSchema = z.object({
  /** The furnace block. */
  x: z.number(),
  y: z.number(),
  z: z.number(),
  item: z.string(),
  produced: z.string(),
  /** How many items the job smelts in all. */
  count: z.number().int().min(1),
  /** How many of them have been put into the furnace so far (a stack at a time). */
  loaded: z.number().int().min(0),
  /** How many finished items the bot has taken out. */
  collected: z.number().int().min(0),
  fuel: z.string(),
  /** Epoch milliseconds of the start. */
  startedAt: z.number(),
  /** Which block smelts it: a furnace, or a blast furnace or a smoker (twice as fast). */
  station: z.enum(['furnace', 'blast_furnace', 'smoker']).default('furnace'),
  /** The dimension the furnace stands in, so a job in another one is known to be out of reach. */
  dimension: z.string().default('overworld'),
  /** No smelt task is waiting for this job: it was started with `start_only` or its wait was cut short. */
  detached: z.boolean().default(false),
  /** The `smelt_ready` signal for this job has been sent. */
  readyNotified: z.boolean().default(false),
})

export type SmeltJob = z.output<typeof jobSchema>

const smeltJobsDocument = defineDocument({
  key: 'smelt-jobs',
  version: 1,
  schema: z.object({ jobs: z.array(jobSchema) }),
  initial: (): { jobs: SmeltJob[] } => ({ jobs: [] }),
})

const sameFurnace = (a: SmeltJob, b: { x: number; y: number; z: number }): boolean =>
  a.x === b.x && a.y === b.y && a.z === b.z

/**
 * Smelting jobs that were left burning: a wait that was cut short (the player spoke, `stop`, a reflex) does not
 * take the items out of the furnace, so the job is written down here and picked up by the next `smelt`. Saved per
 * world; without one it lives in memory for the session.
 */
export class SmeltJobs implements ProfileScoped {
  private store: StateStore | undefined
  private jobs: SmeltJob[] = []
  private readonly listeners = new Set<() => void>()

  async attach(store: StateStore): Promise<readonly string[]> {
    const loaded = await store.load(smeltJobsDocument)
    this.store = store
    this.jobs = [...loaded.value.jobs]
    this.changed()
    return loaded.warning === undefined ? [] : [loaded.warning]
  }

  detach(): void {
    this.store = undefined
    this.jobs = []
    this.changed()
  }

  /** Calls `listener` after every change to the jobs, and after a world is opened or closed. Returns how to stop. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  all(): readonly SmeltJob[] {
    return this.jobs
  }

  forItem(item: string): SmeltJob | undefined {
    return this.jobs.find((job) => job.item === item)
  }

  /** Records a job, replacing any job in the same furnace. */
  put(job: SmeltJob): void {
    this.jobs = [...this.jobs.filter((other) => !sameFurnace(other, job)), job]
    this.save()
  }

  update(furnace: { x: number; y: number; z: number }, patch: Partial<SmeltJob>): void {
    this.jobs = this.jobs.map((job) => (sameFurnace(job, furnace) ? { ...job, ...patch } : job))
    this.save()
  }

  remove(furnace: { x: number; y: number; z: number }): void {
    this.jobs = this.jobs.filter((job) => !sameFurnace(job, furnace))
    this.save()
  }

  private save(): void {
    this.store?.save(smeltJobsDocument, { jobs: this.jobs })
    this.changed()
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
