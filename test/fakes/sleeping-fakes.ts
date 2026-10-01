import type { BedAccess, BedFailure, BedState } from '../../src/core/bed.port.js'
import type { Gaze } from '../../src/core/gaze.port.js'
import type { PlaceFailure, Placer } from '../../src/core/placer.port.js'
import type { Position } from '../../src/core/position.types.js'
import { err, ok, type Result } from '../../src/core/result.js'
import type { SleepFailure, Sleeper } from '../../src/core/sleeper.port.js'

/** Lies down when asked; `onPoll` runs on every `isSleeping()` call so a test can end the night after a few looks. */
export class FakeSleeper implements Sleeper {
  sleeping = false
  failure: SleepFailure | undefined
  readonly slept: Position[] = []
  wakes = 0
  onPoll: () => void = () => undefined

  isSleeping(): boolean {
    this.onPoll()
    return this.sleeping
  }

  sleep(bed: Position): Promise<Result<void, SleepFailure>> {
    this.slept.push(bed)
    if (this.failure !== undefined) return Promise.resolve(err(this.failure))
    this.sleeping = true
    return Promise.resolve(ok(undefined))
  }

  wake(): Promise<void> {
    this.wakes += 1
    this.sleeping = false
    return Promise.resolve()
  }
}

/** What the server says when a bed is used, in order. */
export class FakeBedAccess implements BedAccess {
  lines: readonly string[] = ['Respawn point set']
  failure: BedFailure | undefined
  readonly used: Position[] = []

  stateAt(): BedState | undefined {
    return undefined
  }

  use(position: Position): Promise<Result<readonly string[], BedFailure>> {
    this.used.push(position)
    return Promise.resolve(this.failure === undefined ? ok(this.lines) : err(this.failure))
  }
}

export class RecordingGaze implements Gaze {
  readonly looked: Position[] = []
  lookAt(target: Position): Promise<void> {
    this.looked.push(target)
    return Promise.resolve()
  }
}

/** Puts the bed's two halves into a `set` callback (the test's world) when it is placed against the ground. */
export class BedPlacer implements Placer {
  readonly placed: { item: string; reference: Position; face: Position }[] = []
  failure: PlaceFailure | undefined
  /** Called with the item and the cell of the foot; a test uses it to make the bed appear (or not). */
  onPlace: (item: string, foot: Position) => void = () => undefined

  placeAt(): Promise<Result<void, PlaceFailure>> {
    return Promise.resolve(ok(undefined))
  }

  placeAgainst(
    item: string,
    reference: Position,
    face: Position,
  ): Promise<Result<void, PlaceFailure>> {
    this.placed.push({ item, reference, face })
    if (this.failure !== undefined) return Promise.resolve(err(this.failure))
    this.onPlace(item, { x: reference.x + face.x, y: reference.y + face.y, z: reference.z + face.z })
    return Promise.resolve(ok(undefined))
  }
}
