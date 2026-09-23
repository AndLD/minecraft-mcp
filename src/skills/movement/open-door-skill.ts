import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { DoorAccess } from '../../core/door.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import { classifyDoor } from './door-table.js'
import type { IronDoorOpener } from './iron-door-opener.js'
import type { SwitchKind } from './switch-table.js'

/** How close the bot gets to a wooden door before hand-opening it. */
const DOOR_REACH = 3

export interface OpenDoorInput {
  readonly position: Position
  /** Walk to just past the door once it is open. Default true. */
  readonly walkThrough: boolean
  /** Close a wooden door again, or restore a lever pressed to open an iron one. Default true. */
  readonly restore: boolean
}

export interface OpenDoorOutput {
  readonly name: string
  readonly wasOpen: boolean
  readonly walkedThrough: boolean
  readonly restored: boolean
  /** The button, lever, or plate used, for an iron door. */
  readonly switchUsed?: { readonly position: Position; readonly name: string; readonly kind: SwitchKind }
}

export interface OpenDoorSkillDeps {
  readonly blocks: BlockScanner
  readonly doors: DoorAccess
  readonly navigator: Navigator
  readonly opener: IronDoorOpener
  readonly vitals: VitalsReader
}

/**
 * Opens a wooden or iron door, gate, or trapdoor at a position. A wooden one is right-clicked directly; an
 * iron one is opened by finding and pressing a nearby button, lever, or plate (`IronDoorOpener`), regardless
 * of the standing `SwitchPolicy` — calling this tool is itself the player's (or agent's) decision to try.
 */
export class OpenDoorSkill implements Skill<OpenDoorInput, OpenDoorOutput> {
  readonly name = 'open_door'

  constructor(private readonly deps: OpenDoorSkillDeps) {}

  async run(input: OpenDoorInput, context: SkillContext): Promise<SkillResult<OpenDoorOutput>> {
    const name = this.deps.blocks.blockAt(input.position)
    const kind = name === undefined ? undefined : classifyDoor(name)
    if (name === undefined || kind === undefined) {
      return err({
        reason: 'not_a_door',
        message: `${describe(input.position)} is not a door, gate, or trapdoor.`,
      })
    }

    const before = this.deps.doors.stateAt(input.position)
    const wasOpen = before?.open === true
    let switchUsed: OpenDoorOutput['switchUsed']

    if (!wasOpen) {
      if (kind === 'iron') {
        const opened = await this.deps.opener.open(input.position, name, context.signal)
        if (!opened.ok) return err({ reason: opened.error.reason, message: opened.error.message })
        switchUsed = {
          position: opened.value.pressed.position,
          name: opened.value.pressed.name,
          kind: opened.value.pressed.kind,
        }
      } else {
        const walked = await this.deps.navigator.goToPosition(input.position, DOOR_REACH, {
          signal: context.signal,
          closeDoors: false,
        })
        if (!walked.ok) return err({ reason: walked.error.reason, message: walked.error.message })
        const toggled = await this.deps.doors.toggle(input.position, context.signal)
        if (!toggled.ok) return err({ reason: toggled.error.reason, message: toggled.error.message })
      }
    }

    let walkedThrough = false
    if (input.walkThrough) {
      const beyond = this.pointBeyond(input.position)
      const through = await this.deps.navigator.goToPosition(beyond, 0, {
        signal: context.signal,
        closeDoors: false,
      })
      if (!through.ok) {
        return err({
          reason: through.error.reason,
          message: `Opened the ${name}, but could not walk through: ${through.error.message}`,
        })
      }
      walkedThrough = true
    }

    let restored = false
    if (input.restore && !wasOpen) {
      if (kind === 'iron') {
        if (switchUsed?.kind === 'lever') {
          await this.deps.opener.restoreLever(switchUsed.position, context.signal)
          restored = true
        }
      } else {
        const closed = await this.deps.doors.toggle(input.position, context.signal)
        restored = closed.ok
      }
    }

    return ok({ name, wasOpen, walkedThrough, restored, switchUsed })
  }

  /** A point just past the door, continuing the line from where the bot stood before this call. */
  private pointBeyond(door: Position): Position {
    const from = this.deps.vitals.read()?.position
    if (from === undefined) return door
    return { x: Math.round(door.x * 2 - from.x), y: door.y, z: Math.round(door.z * 2 - from.z) }
  }
}

const describe = (position: Position): string =>
  `${String(position.x)}, ${String(position.y)}, ${String(position.z)}`
