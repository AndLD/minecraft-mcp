import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { DoorAccess } from '../../core/door.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import { distanceBetween } from '../../core/position.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { SwitchAccess } from '../../core/switch.port.js'
import { classifyDoor } from './door-table.js'
import { classifySwitch, type SwitchKind } from './switch-table.js'

/** How close the bot gets to a button or lever before clicking it. */
const SWITCH_REACH = 3
/** How far away a door still counts as "the door beside" the switch. */
const DOOR_SEARCH_RADIUS = 4
/** `BlockScanner.findBlocks` only searches from the bot; see `SwitchFinder` for why this margin is needed. */
const BOT_SEARCH_MARGIN = 8

export interface PressSwitchInput {
  readonly position: Position
}

export interface PressSwitchOutput {
  readonly pressed: { readonly position: Position; readonly name: string; readonly kind: SwitchKind }
  /** The nearest door within reach, and whether it is now open, if one was found. */
  readonly door?: { readonly position: Position; readonly name: string; readonly open: boolean }
}

export interface PressSwitchSkillDeps {
  readonly blocks: BlockScanner
  readonly switches: SwitchAccess
  readonly doors: DoorAccess
  readonly navigator: Navigator
}

/** Walks to a button, lever, or pressure plate and presses it, then reports what happened to the nearest door. */
export class PressSwitchSkill implements Skill<PressSwitchInput, PressSwitchOutput> {
  readonly name = 'press_switch'

  constructor(private readonly deps: PressSwitchSkillDeps) {}

  async run(input: PressSwitchInput, context: SkillContext): Promise<SkillResult<PressSwitchOutput>> {
    const name = this.deps.blocks.blockAt(input.position)
    const kind = name === undefined ? undefined : classifySwitch(name)
    if (name === undefined || kind === undefined) {
      return err({
        reason: 'not_a_switch',
        message: `${describe(input.position)} is not a button, lever, or pressure plate.`,
      })
    }

    const walked = await this.deps.navigator.goToPosition(
      input.position,
      kind === 'plate' ? 0 : SWITCH_REACH,
      { signal: context.signal, closeDoors: false },
    )
    if (!walked.ok) return err({ reason: walked.error.reason, message: walked.error.message })

    if (kind !== 'plate') {
      const pressed = await this.deps.switches.press(input.position, context.signal)
      if (!pressed.ok) return err({ reason: pressed.error.reason, message: pressed.error.message })
    }

    return ok({ pressed: { position: input.position, name, kind }, door: this.nearestDoor(input.position) })
  }

  private nearestDoor(position: Position): PressSwitchOutput['door'] {
    const names = this.deps.blocks.knownBlockNames().filter((name) => classifyDoor(name) !== undefined)
    if (names.length === 0) return undefined
    const found = this.deps.blocks.findBlocks({
      names,
      maxDistance: DOOR_SEARCH_RADIUS + BOT_SEARCH_MARGIN,
      count: 20,
    })
    let nearest: { position: Position; distance: number } | undefined
    for (const info of found) {
      const distance = distanceBetween(info.position, position)
      if (distance > DOOR_SEARCH_RADIUS) continue
      if (nearest === undefined || distance < nearest.distance) nearest = { position: info.position, distance }
    }
    if (nearest === undefined) return undefined
    const state = this.deps.doors.stateAt(nearest.position)
    return state === undefined ? undefined : { position: nearest.position, name: state.name, open: state.open }
  }
}

const describe = (position: Position): string =>
  `${String(position.x)}, ${String(position.y)}, ${String(position.z)}`
