import type { Clock } from '../core/clock.port.js'
import type { TaskSnapshot } from '../tasks/task.types.js'

const iso = (epochMs: number): string => new Date(epochMs).toISOString()

/** The agent-facing description of a task. */
export function taskView(snapshot: TaskSnapshot, clock: Clock): Record<string, unknown> {
  const end = snapshot.finishedAt ?? clock.now()
  return {
    taskId: snapshot.id,
    name: snapshot.name,
    description: snapshot.description,
    status: snapshot.status,
    progress: snapshot.progress ?? null,
    result: snapshot.result ?? null,
    failure: snapshot.failure ?? null,
    cancelReason: snapshot.cancelReason ?? null,
    startedAt: iso(snapshot.startedAt),
    finishedAt: snapshot.finishedAt === undefined ? null : iso(snapshot.finishedAt),
    elapsedSeconds: Math.round((end - snapshot.startedAt) / 100) / 10,
  }
}
