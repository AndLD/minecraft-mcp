import type { ConnectTarget } from '../../src/core/connection.port.js'
import type { DocumentSchema, LoadedDocument, StateStore } from '../../src/core/state-store.port.js'
import type { WorldFingerprint, WorldIdentifier } from '../../src/core/world-identifier.port.js'
import { DropRecords } from '../../src/state/drop-records.js'
import { InstructionLog } from '../../src/state/instruction-log.js'
import { NotesStore } from '../../src/state/notes-store.js'
import { SessionBriefingBuilder } from '../../src/state/session-briefing.js'
import { StandingInstructions } from '../../src/state/standing-instructions.js'
import { TaskJournal } from '../../src/state/task-journal.js'
import { WorldRegistry } from '../../src/state/world-registry.js'
import { WorldStateManager } from '../../src/state/world-state-manager.js'
import { TaskManager } from '../../src/tasks/task-manager.js'
import { FakeClock } from './fake-clock.js'
import { FakeLogger } from './fake-logger.js'
import { FakeScheduler } from './fake-scheduler.js'

/** A store that keeps documents in memory, in the same envelope the file store writes. */
export class InMemoryStateStore implements StateStore {
  readonly files = new Map<string, { version: number; data: unknown }>()
  flushCount = 0
  /** Set to a message to make the next loads report a warning (as after a corrupt file). */
  warnOnLoad: string | undefined

  load<T>(document: DocumentSchema<T>): Promise<LoadedDocument<T>> {
    const stored = this.files.get(document.key)
    const value = stored === undefined ? undefined : document.parse(stored.data, stored.version)
    return Promise.resolve({
      value: value ?? document.initial(),
      source: value === undefined ? 'initial' : 'file',
      warning: this.warnOnLoad,
    })
  }

  save<T>(document: DocumentSchema<T>, value: T): void {
    this.files.set(document.key, { version: document.version, data: structuredClone(value) })
  }

  flush(): Promise<void> {
    this.flushCount += 1
    return Promise.resolve()
  }

  /** The saved data of a document, for assertions. */
  data(key: string): unknown {
    return this.files.get(key)?.data
  }
}

export const SEED_A: WorldFingerprint = {
  seed: 'aaaa1111',
  worldName: 'Survival',
  spawn: { x: 48, y: 81, z: 32 },
}
export const SEED_B: WorldFingerprint = {
  seed: 'bbbb2222',
  worldName: 'Creative',
  spawn: { x: 0, y: 70, z: 0 },
}

export class FakeWorldIdentifier implements WorldIdentifier {
  fingerprint: WorldFingerprint = SEED_A
  failWith: Error | undefined
  readonly calls: { target: ConnectTarget; hint: string | undefined }[] = []

  identify(target: ConnectTarget, worldNameHint?: string): Promise<WorldFingerprint> {
    this.calls.push({ target, hint: worldNameHint })
    if (this.failWith !== undefined) return Promise.reject(this.failWith)
    return Promise.resolve(
      worldNameHint === undefined
        ? this.fingerprint
        : { ...this.fingerprint, worldName: worldNameHint },
    )
  }
}

/** Everything the persistent-state feature is made of, over in-memory stores and fake time. */
export function buildStateStack(
  initial: { rootStore?: InMemoryStateStore; profileStores?: Map<string, InMemoryStateStore> } = {},
) {
  const clock = new FakeClock(Date.UTC(2026, 8, 19, 12, 0, 0))
  const scheduler = new FakeScheduler(clock)
  const logger = new FakeLogger()
  const tasks = new TaskManager({ clock, scheduler, logger })
  const rootStore = initial.rootStore ?? new InMemoryStateStore()
  const profileStores = initial.profileStores ?? new Map<string, InMemoryStateStore>()
  const notes = new NotesStore(clock)
  const history = new InstructionLog(clock)
  const standing = new StandingInstructions()
  const journal = new TaskJournal(clock, tasks)
  const drops = new DropRecords(clock)
  const worldState = new WorldStateManager({
    registry: new WorldRegistry({ store: rootStore, clock }),
    storeForProfile: (profile) => {
      const existing = profileStores.get(profile)
      if (existing !== undefined) return existing
      const created = new InMemoryStateStore()
      profileStores.set(profile, created)
      return created
    },
    components: [notes, history, standing, journal, drops],
    logger,
  })
  const briefing = new SessionBriefingBuilder({
    clock,
    worldState,
    journal,
    notes,
    standing,
    history,
    drops,
  })
  return {
    clock,
    scheduler,
    logger,
    tasks,
    rootStore,
    profileStores,
    notes,
    history,
    standing,
    journal,
    worldState,
    briefing,
    drops,
  }
}
