import type { BedAccess } from '../../core/bed.port.js'
import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { Sleeper } from '../../core/sleeper.port.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { BedRegistry } from '../../state/bed-registry.js'
import type { BedFinder } from './bed-finder.js'
import { bedsExplode, colourOfBed, isBedName } from './bed-table.js'

const REACH = 2
const CONFIRMATION = /respawn point set|spawn point set/i

export interface SetRespawnPointInput {
  readonly bed: Position | undefined
}

export interface SetRespawnPointOutput {
  readonly bed: Position
  readonly colour: string
  readonly message: string
}

export interface SetRespawnPointDeps {
  readonly vitals: VitalsReader
  readonly blocks: BlockScanner
  readonly navigator: Navigator
  readonly beds: BedAccess
  readonly sleeper: Sleeper
  readonly finder: BedFinder
  readonly registry: BedRegistry
}

/**
 * Makes a bed the respawn point by right-clicking it (by day this only sets the point; at night it also lies the bot
 * down, and it gets straight up again). It only counts as set when the game says so ("Respawn point set").
 */
export class SetRespawnPointSkill implements Skill<SetRespawnPointInput, SetRespawnPointOutput> {
  readonly name = 'set_respawn_point'

  constructor(private readonly deps: SetRespawnPointDeps) {}

  async run(
    input: SetRespawnPointInput,
    context: SkillContext,
  ): Promise<SkillResult<SetRespawnPointOutput>> {
    const { deps } = this
    const vitals = deps.vitals.read()
    if (vitals === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })
    if (bedsExplode(vitals.dimension))
      return err({
        reason: 'wrong_dimension',
        message: `A bed explodes in the Nether and the End, so the bot never uses one there (it is in ${vitals.dimension}).`,
      })

    let position = input.bed
    let colour =
      position === undefined ? undefined : colourOfBed(deps.blocks.blockAt(position) ?? '')
    if (position !== undefined) {
      if (!isBedName(deps.blocks.blockAt(position)))
        return err({ reason: 'not_a_bed', message: 'There is no bed at that position.' })
    } else {
      const nearest = deps.finder.candidates(vitals.position)[0]
      if (nearest === undefined)
        return err({
          reason: 'no_bed',
          message:
            'No bed is known or visible within 32 blocks. Craft one (three wool and three planks) and use place_bed.',
        })
      position = nearest.position
      colour = nearest.colour
    }

    context.progress('Walking to the bed')
    const walked = await deps.navigator.goToPosition(position, REACH, { signal: context.signal })
    if (!walked.ok) {
      if (walked.error.reason === 'aborted')
        return err({ reason: 'aborted', message: 'Cancelled.' })
      return err({
        reason: 'unreachable',
        message: `Could not walk to the bed: ${walked.error.message}`,
      })
    }

    const used = await deps.beds.use(position, context.signal)
    // At night the click lies the bot down; the respawn point is set either way.
    await deps.sleeper.wake()
    if (context.signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })
    if (!used.ok) return err({ reason: used.error.reason, message: used.error.message })

    if (!used.value.some((line) => CONFIRMATION.test(line)))
      return err({
        reason: 'not_confirmed',
        message: `The game did not say "Respawn point set" (it said: ${used.value.length === 0 ? 'nothing' : used.value.join(' | ')}). The bed may be obstructed or someone else's, so the respawn point was not changed.`,
        detail: { lines: used.value },
      })
    const wanted = colour ?? 'red'
    deps.registry.setRespawn(position, wanted)
    return ok({
      bed: position,
      colour: wanted,
      message: 'Respawn point set: the bot wakes up at this bed after a death.',
    })
  }
}
