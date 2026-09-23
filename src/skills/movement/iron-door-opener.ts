import type { DoorAccess } from '../../core/door.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Position } from '../../core/position.types.js'
import { err, ok, type Result } from '../../core/result.js'
import type { SwitchAccess } from '../../core/switch.port.js'
import type { SwitchFinder, SwitchCandidate } from './switch-finder.js'

/** Candidate switches tried before giving up on this door. */
const MAX_CANDIDATES = 4
/** How many times the whole ranked list is tried, in case an early one needed a second attempt. */
const MAX_ROUNDS = 2
/** How close the bot gets to a button or lever before clicking it. */
const SWITCH_REACH = 3

export type IronDoorOpenReason = 'no_switches_found' | 'door_did_not_open' | 'aborted'

export interface IronDoorOpenFailure {
  readonly reason: IronDoorOpenReason
  readonly message: string
  readonly tried: readonly SwitchCandidate[]
}

export interface IronDoorOpenSuccess {
  /** The switch that made the door open. */
  readonly pressed: SwitchCandidate
}

const where = (position: Position): string =>
  `${String(position.x)}, ${String(position.y)}, ${String(position.z)}`

/**
 * Finds a button, lever, or plate that can be found by where it is (never by the wiring behind it, which is
 * invisible), and gets an iron door open: press the best-ranked candidate, check the door, and try the next one
 * if it did not work — a ranked guess that is verified, not a certainty.
 */
export class IronDoorOpener {
  constructor(
    private readonly finder: SwitchFinder,
    private readonly switches: SwitchAccess,
    private readonly doors: DoorAccess,
    /** Only for walking to a candidate switch; never the navigator this opener is itself wired into. */
    private readonly navigator: Navigator,
  ) {}

  async open(
    doorPosition: Position,
    doorName: string,
    signal: AbortSignal,
  ): Promise<Result<IronDoorOpenSuccess, IronDoorOpenFailure>> {
    const candidates = this.finder.near(doorPosition).slice(0, MAX_CANDIDATES)
    if (candidates.length === 0) {
      return err({
        reason: 'no_switches_found',
        message: `No button, lever, or plate found near the ${doorName} at ${where(doorPosition)}.`,
        tried: [],
      })
    }
    const tried: SwitchCandidate[] = []
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      for (const candidate of candidates) {
        if (signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.', tried })
        tried.push(candidate)
        const pressed = await this.press(candidate, signal)
        if (!pressed.ok) continue
        if (this.doors.stateAt(doorPosition)?.open === true) return ok({ pressed: candidate })
      }
    }
    return err({
      reason: 'door_did_not_open',
      message: `The ${doorName} at ${where(doorPosition)} did not open after trying ${String(tried.length)} switch(es).`,
      tried,
    })
  }

  /** Restores a lever that was pressed to open a door, back to how it was found. */
  async restoreLever(position: Position, signal: AbortSignal): Promise<void> {
    await this.switches.press(position, signal)
  }

  private async press(candidate: SwitchCandidate, signal: AbortSignal): Promise<Result<void>> {
    if (candidate.kind === 'plate') {
      // Standing on the plate is what powers it; nothing else to click.
      const walked = await this.navigator.goToPosition(candidate.position, 0, {
        signal,
        closeDoors: false,
      })
      return walked.ok ? ok(undefined) : err(walked.error.message)
    }
    const walked = await this.navigator.goToPosition(candidate.position, SWITCH_REACH, {
      signal,
      closeDoors: false,
    })
    if (!walked.ok) return err(walked.error.message)
    const pressed = await this.switches.press(candidate.position, signal)
    return pressed.ok ? ok(undefined) : err(pressed.error.message)
  }
}
