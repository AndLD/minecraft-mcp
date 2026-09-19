import { z } from 'zod'
import type { Clock } from '../core/clock.port.js'
import { err, ok, type Result } from '../core/result.js'
import type { StateStore } from '../core/state-store.port.js'
import type { TaskEvent, TaskSnapshot } from '../tasks/task.types.js'
import { defineDocument } from './define-document.js'
import type { ProfileScoped } from './profile-scoped.types.js'

const JOB_STATUSES = [
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'resumed',
  'discarded',
] as const

const jobSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  status: z.enum(JOB_STATUSES),
  progress: z.string().nullable(),
  failure: z.object({ reason: z.string(), message: z.string() }).nullable(),
  resume: z.object({ tool: z.string(), arguments: z.record(z.string(), z.unknown()) }).nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
})

export type Job = z.infer<typeof jobSchema>

const journalDocument = defineDocument({
  key: 'journal',
  version: 1,
  schema: z.object({ jobs: z.array(jobSchema), nextId: z.number().int() }),
  initial: () => ({ jobs: [] as Job[], nextId: 1 }),
})

export const MAX_JOBS = 50
const NOT_ACTIVE = 'No world is active, so there is no task journal. Connect to a world first.'

export interface TaskEventSource {
  onEvent(listener: (event: TaskEvent) => void): () => void
}

/**
 * Remembers what the bot was doing. Jobs still `running` when a world is reopened (the server was killed), or
 * cancelled by a disconnect or shutdown, are `interrupted`: the agent offers them for resuming, never resumes on its own.
 */
export class TaskJournal implements ProfileScoped {
  private store: StateStore | undefined
  private jobs: Job[] = []
  private nextId = 1
  private readonly jobIds = new Map<string, string>()

  constructor(
    private readonly clock: Clock,
    tasks: TaskEventSource,
  ) {
    tasks.onEvent((event) => {
      this.handle(event)
    })
  }

  async attach(store: StateStore): Promise<readonly string[]> {
    const loaded = await store.load(journalDocument)
    this.store = store
    this.nextId = loaded.value.nextId
    const now = this.now()
    this.jobs = loaded.value.jobs.map((job) =>
      job.status === 'running' ? { ...job, status: 'interrupted' as const, finishedAt: now } : job,
    )
    if (this.jobs.some((job, index) => job !== loaded.value.jobs[index])) this.persist()
    return loaded.warning === undefined ? [] : [loaded.warning]
  }

  detach(): void {
    this.store = undefined
    this.jobs = []
    this.jobIds.clear()
  }

  interrupted(): readonly Job[] {
    return this.jobs.filter((job) => job.status === 'interrupted')
  }

  /** The latest jobs, newest first. */
  recent(limit: number): readonly Job[] {
    return [...this.jobs].reverse().slice(0, limit)
  }

  get(id: string): Job | undefined {
    return this.jobs.find((job) => job.id === id)
  }

  /** Marks an interrupted job as taken up again (a new job records the rerun). */
  markResumed(id: string): Result<Job> {
    return this.transition(id, 'resumed')
  }

  discard(id: string): Result<Job> {
    return this.transition(id, 'discarded')
  }

  private transition(id: string, status: 'resumed' | 'discarded'): Result<Job> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    const job = this.get(id)
    if (job === undefined) return err(`There is no job ${id}.`)
    if (job.status !== 'interrupted') return err(`Job ${id} is ${job.status}, not interrupted.`)
    const updated: Job = { ...job, status }
    this.jobs = this.jobs.map((j) => (j.id === id ? updated : j))
    this.persist()
    return ok(updated)
  }

  private handle(event: TaskEvent): void {
    if (this.store === undefined) return
    const { snapshot } = event
    if (event.type === 'started') {
      const id = `job-${String(this.nextId)}`
      this.nextId += 1
      this.jobIds.set(snapshot.id, id)
      this.jobs.push({
        id,
        name: snapshot.name,
        description: snapshot.description,
        status: 'running',
        progress: null,
        failure: null,
        resume:
          snapshot.resume === undefined
            ? null
            : { tool: snapshot.resume.tool, arguments: { ...snapshot.resume.arguments } },
        startedAt: new Date(snapshot.startedAt).toISOString(),
        finishedAt: null,
      })
      this.trim()
    } else {
      const id = this.jobIds.get(snapshot.id)
      if (id === undefined) return
      this.jobs = this.jobs.map((job) => (job.id === id ? this.update(job, event) : job))
      if (event.type === 'finished') this.jobIds.delete(snapshot.id)
    }
    this.persist()
  }

  private update(job: Job, event: TaskEvent): Job {
    const { snapshot } = event
    if (event.type === 'progress') return { ...job, progress: snapshot.progress ?? null }
    return {
      ...job,
      status: statusOf(snapshot),
      progress: snapshot.progress ?? job.progress,
      failure: snapshot.failure ?? null,
      finishedAt: new Date(snapshot.finishedAt ?? this.clock.now()).toISOString(),
    }
  }

  /** Keeps at most MAX_JOBS, dropping the oldest jobs that are over (never an interrupted one). */
  private trim(): void {
    let excess = this.jobs.length - MAX_JOBS
    if (excess <= 0) return
    this.jobs = this.jobs.filter((job) => {
      if (excess > 0 && job.status !== 'interrupted' && job.status !== 'running') {
        excess -= 1
        return false
      }
      return true
    })
  }

  private now(): string {
    return new Date(this.clock.now()).toISOString()
  }

  private persist(): void {
    this.store?.save(journalDocument, { jobs: this.jobs, nextId: this.nextId })
  }
}

function statusOf(snapshot: TaskSnapshot): Job['status'] {
  switch (snapshot.status) {
    case 'succeeded':
      return 'succeeded'
    case 'failed':
      return 'failed'
    case 'running':
      return 'running'
    case 'cancelled':
      return snapshot.cancelReason === 'disconnected' || snapshot.cancelReason === 'shutdown'
        ? 'interrupted'
        : 'cancelled'
  }
}
