import type { Clock } from '../core/clock.port.js'
import { DROP_DESPAWN_MS, type DropRecords } from './drop-records.js'
import type { InstructionLog } from './instruction-log.js'
import type { NotesStore } from './notes-store.js'
import type { SmeltJobs } from './smelt-jobs.js'
import type { StandingInstructions } from './standing-instructions.js'
import type { TaskJournal } from './task-journal.js'
import type { WorldStateManager } from './world-state-manager.js'

export interface SessionBriefing {
  readonly world: {
    readonly profile: string | null
    /** How the world was identified, or why it was not. */
    readonly status: string
    readonly candidates?: readonly string[]
  }
  /** The last time this world was joined before now. */
  readonly previousSession: { readonly at: string; readonly minutesAgo: number } | null
  readonly interruptedTasks: readonly {
    readonly id: string
    readonly description: string
    readonly progress: string | null
    readonly resumable: boolean
    readonly startedAt: string
  }[]
  /** Dropped items that can still be fetched: where the bot died, or items nobody picked up. */
  readonly pendingDrops: readonly {
    readonly id: string
    readonly kind: string
    readonly status: string
    readonly position: { readonly x: number; readonly y: number; readonly z: number }
    readonly dimension: string
    readonly secondsLeft: number
  }[]
  /** Smelting jobs left burning in a furnace: what waits there and how far it is. */
  readonly smeltJobs: readonly {
    readonly item: string
    readonly produced: string
    readonly furnace: { readonly x: number; readonly y: number; readonly z: number }
    readonly count: number
    readonly collected: number
  }[]
  readonly standingInstructions: Readonly<Record<string, string>>
  readonly notes: readonly {
    readonly id: string
    readonly text: string
    readonly tags: readonly string[]
  }[]
  readonly recentHistory: readonly {
    readonly at: string
    readonly kind: string
    readonly text: string
  }[]
  readonly warnings: readonly string[]
  /** What the agent should do first. */
  readonly nextSteps: readonly string[]
}

const NOTE_LIMIT = 15
const HISTORY_LIMIT = 10

export interface SessionBriefingBuilderOptions {
  readonly clock: Clock
  readonly worldState: WorldStateManager
  readonly journal: TaskJournal
  readonly notes: NotesStore
  readonly standing: StandingInstructions
  readonly history: InstructionLog
  readonly drops: DropRecords
  readonly smeltJobs: SmeltJobs
}

/** Summarizes what the bot remembers about this world, so the agent can pick up where the last session ended. */
export class SessionBriefingBuilder {
  constructor(private readonly deps: SessionBriefingBuilderOptions) {}

  build(): SessionBriefing {
    const { worldState, journal, notes, standing, history, drops, clock, smeltJobs } = this.deps
    const opened = worldState.lastOpen
    const nextSteps: string[] = []

    if (opened === undefined) {
      return {
        world: { profile: null, status: 'not_connected' },
        previousSession: null,
        interruptedTasks: [],
        pendingDrops: [],
        smeltJobs: [],
        standingInstructions: {},
        notes: [],
        recentHistory: [],
        warnings: [],
        nextSteps: ['Connect to the world first.'],
      }
    }

    const resolution = opened.resolution
    let status: string
    let candidates: readonly string[] | undefined
    switch (resolution.kind) {
      case 'matched':
        status = 'recognized: this is a world the bot has been in before'
        break
      case 'created':
        status = resolution.named
          ? 'new profile created with the given name'
          : 'new world: a profile was created for it'
        break
      case 'named':
        status = resolution.rebound
          ? 'profile chosen by name (the world looks different from what it remembered)'
          : 'profile chosen by name'
        break
      case 'needs_name':
        status = `not identified: ${resolution.reason}`
        nextSteps.push(
          'Ask the player what to call this world, then call set_world_profile. Until then nothing is saved.',
        )
        break
      case 'ambiguous':
        status = 'not identified: several remembered worlds fit equally well'
        candidates = resolution.candidates
        nextSteps.push(
          `Ask the player which world this is (${resolution.candidates.join(', ')}), then call set_world_profile.`,
        )
        break
      case 'invalid_name':
        status = `the profile name "${resolution.name}" is not usable`
        nextSteps.push('Call set_world_profile with a name that has letters or digits.')
        break
    }

    const interrupted = journal.interrupted()
    if (interrupted.length > 0) {
      nextSteps.push(
        'Tell the player about the interrupted tasks and ask before resuming (resume_interrupted_task) or dropping them (discard_interrupted_task).',
      )
    }
    const pendingDrops = drops.recoverable().map((record) => ({
      id: record.id,
      kind: record.kind,
      status: record.status,
      position: record.position,
      dimension: record.dimension,
      secondsLeft: Math.max(0, Math.round((record.at + DROP_DESPAWN_MS - clock.now()) / 1000)),
    }))
    if (pendingDrops.length > 0)
      nextSteps.push(
        'Some dropped items can still be fetched (pendingDrops). Tell the player where they lie and ask whether to fetch them now (recover_drops); they vanish 5 minutes after the drop.',
      )
    const waitingJobs = smeltJobs.all().map((job) => ({
      item: job.item,
      produced: job.produced,
      furnace: { x: job.x, y: job.y, z: job.z },
      count: job.count,
      collected: job.collected,
    }))
    if (waitingJobs.length > 0)
      nextSteps.push(
        'A furnace still holds a smelting job (smeltJobs). Tell the player, and collect it with smelt (collect: true) when it fits.',
      )
    const previous = opened.previousSessionAt
    const listedNotes = notes.latest(NOTE_LIMIT)
    if (listedNotes.length > 0)
      nextSteps.push('Read the notes: they hold plans and preferences from earlier sessions.')

    return {
      world: {
        profile: opened.profile ?? null,
        status,
        ...(candidates === undefined ? {} : { candidates }),
      },
      previousSession:
        previous === null
          ? null
          : {
              at: previous,
              minutesAgo: Math.max(0, Math.round((clock.now() - Date.parse(previous)) / 60_000)),
            },
      interruptedTasks: interrupted.map((job) => ({
        id: job.id,
        description: job.description,
        progress: job.progress,
        resumable: job.resume !== null,
        startedAt: job.startedAt,
      })),
      pendingDrops,
      smeltJobs: waitingJobs,
      standingInstructions: standing.all(),
      notes: listedNotes.map((note) => ({ id: note.id, text: note.text, tags: note.tags })),
      recentHistory: history.recent(HISTORY_LIMIT),
      warnings: opened.warnings,
      nextSteps,
    }
  }
}
