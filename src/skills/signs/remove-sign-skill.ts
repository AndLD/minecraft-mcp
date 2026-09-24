import type { AreaGuard } from '../../core/area-guard.port.js'
import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Digger } from '../../core/digger.port.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import { countItems } from '../../core/inventory-counts.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { SignAccess } from '../../core/sign.port.js'
import type { Skill, SkillContext, SkillFailure, SkillResult } from '../../core/skill.types.js'
import type { SignRegistry } from '../../state/sign-registry.js'
import type { DropCollector } from '../gathering/drop-collector.js'
import { isSignBlock, signItemOf, woodOfSign } from './sign-table.js'
import { joinSignText } from './sign-text.js'

const REMOVE_RANGE = 3

export interface RemoveSignInput {
  readonly position: Position
}

export interface RemoveSignOutput {
  readonly position: Position
  /** What the sign said (front, then back when it has text). */
  readonly text: readonly string[]
  /** The sign item is in the inventory again. */
  readonly pickedUp: boolean
  readonly item: string
}

export interface RemoveSignDeps {
  readonly blocks: BlockScanner
  readonly signs: SignAccess
  readonly navigator: Navigator
  readonly digger: Digger
  readonly drops: DropCollector
  readonly inventory: InventoryReader
  readonly guard: AreaGuard
  readonly registry: SignRegistry
}

const fail = (reason: string, message: string): SkillFailure => ({ reason, message })

/**
 * Takes down exactly one sign: breaks it and picks the item up. What to take down is decided before this skill runs
 * (the sign a player points at, a position, or the single match of a text), so there is no way to ask for "all signs".
 * Waxed signs can be broken: waxing only stops editing.
 */
export class RemoveSignSkill implements Skill<RemoveSignInput, RemoveSignOutput> {
  readonly name = 'remove_sign'

  constructor(private readonly deps: RemoveSignDeps) {}

  async run(input: RemoveSignInput, context: SkillContext): Promise<SkillResult<RemoveSignOutput>> {
    const { deps } = this
    const state = deps.signs.stateAt(input.position)
    if (state === undefined)
      return err(fail('not_a_sign', 'There is no sign at that place (or it is not loaded).'))
    const guarded = deps.guard.protectedAt(input.position)
    if (guarded !== undefined)
      return err(
        fail(
          'protected_area',
          `This sign is inside the protected area "${guarded.label}"; the bot leaves it alone.`,
        ),
      )

    const walked = await deps.navigator.goToPosition(input.position, REMOVE_RANGE, {
      signal: context.signal,
    })
    if (!walked.ok) {
      if (walked.error.reason === 'aborted') return err(fail('aborted', 'Cancelled.'))
      return err(fail('unreachable', `Could not walk to the sign: ${walked.error.message}`))
    }

    const item = signItemOf(woodOfSign(state.name))
    const before = countItems(deps.inventory.snapshot()).get(item) ?? 0
    const dug = await deps.digger.dig(input.position, context.signal)
    if (!dug.ok) {
      if (dug.error.reason === 'aborted') return err(fail('aborted', 'Cancelled.'))
      return err(fail('not_removed', `The sign could not be broken: ${dug.error.message}`))
    }
    if (isSignBlock(deps.blocks.blockAt(input.position) ?? ''))
      return err(fail('not_removed', 'The sign is still there after breaking it.'))
    deps.registry.remove(input.position)

    await deps.drops.collectNear(input.position, context.signal)
    const after = countItems(deps.inventory.snapshot()).get(item) ?? 0
    const text = [joinSignText(state.front), joinSignText(state.back)].filter((side) => side !== '')
    return ok({ position: input.position, text, pickedUp: after > before, item })
  }
}
