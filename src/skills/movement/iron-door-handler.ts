import type { NavigationFailure } from '../../core/navigator.port.js'
import type { Position } from '../../core/position.types.js'
import { err, ok, type Result } from '../../core/result.js'
import type { SwitchPolicy } from '../../state/switch-policy.js'
import type { IronDoorOpener } from './iron-door-opener.js'
import type { SwitchCandidate, SwitchFinder } from './switch-finder.js'

export interface IronDoorOpenOutcome {
  /** The switch to restore afterwards (a lever, pressed open), once the trip has gone through. */
  readonly leverToRestore?: Position
}

/** What `DoorOpeningNavigator` asks when it finds a closed iron door in the way. */
export interface IronDoorHandler {
  open(
    doorPosition: Position,
    doorName: string,
    signal: AbortSignal,
  ): Promise<Result<IronDoorOpenOutcome, NavigationFailure>>
  /** Restores a lever that `open` pressed, back to how it was found. */
  restoreLever(position: Position, signal: AbortSignal): Promise<void>
}

const where = (position: Position): string =>
  `${String(position.x)}, ${String(position.y)}, ${String(position.z)}`

const describeCandidates = (candidates: readonly SwitchCandidate[]): string =>
  candidates.map((c) => `${c.kind} ${c.name} at ${where(c.position)}`).join('; ')

/**
 * Applies the player's standing `SwitchPolicy` to an iron door met while walking: `never` refuses outright,
 * `ask` reports the switches found and waits for the player, `auto` presses them itself via `IronDoorOpener`.
 */
export class PolicyIronDoorHandler implements IronDoorHandler {
  constructor(
    private readonly policy: SwitchPolicy,
    private readonly finder: SwitchFinder,
    private readonly opener: IronDoorOpener,
  ) {}

  async open(
    doorPosition: Position,
    doorName: string,
    signal: AbortSignal,
  ): Promise<Result<IronDoorOpenOutcome, NavigationFailure>> {
    const mode = this.policy.get()
    if (mode === 'never') return err(needsSwitch(doorPosition, doorName))

    const candidates = this.finder.near(doorPosition)
    if (mode === 'ask') {
      if (candidates.length === 0) return err(needsSwitch(doorPosition, doorName))
      return err({
        reason: 'iron_door_blocked',
        message:
          `An iron ${doorName} at ${where(doorPosition)} blocks the way. Switches nearby: ` +
          `${describeCandidates(candidates)}. Ask the player, then call open_door or press_switch.`,
      })
    }

    // auto
    const opened = await this.opener.open(doorPosition, doorName, signal)
    if (!opened.ok) {
      return err({
        reason: 'needs_switch',
        message: `${opened.error.message} (policy is auto, but it could not be opened.)`,
      })
    }
    return ok({
      leverToRestore: opened.value.pressed.kind === 'lever' ? opened.value.pressed.position : undefined,
    })
  }

  async restoreLever(position: Position, signal: AbortSignal): Promise<void> {
    await this.opener.restoreLever(position, signal)
  }
}

const needsSwitch = (doorPosition: Position, doorName: string): NavigationFailure => ({
  reason: 'needs_switch',
  message: `An iron ${doorName} at ${where(doorPosition)} blocks the way; it needs a switch to open.`,
})
