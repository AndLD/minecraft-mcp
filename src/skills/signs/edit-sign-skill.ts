import type { AreaGuard } from '../../core/area-guard.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import type { SignAccess, SignSide } from '../../core/sign.port.js'
import type { Skill, SkillContext, SkillFailure, SkillResult } from '../../core/skill.types.js'
import { sleep } from '../../core/sleep.js'
import type { SignRegistry } from '../../state/sign-registry.js'
import { sameSignText } from './sign-text.js'

const CONFIRM_TRIES = 6
const CONFIRM_MS = 300
/** The editor opens only for a player who is near the sign. */
const EDIT_RANGE = 3

export interface EditSignInput {
  readonly position: Position
  /** Exactly four lines. */
  readonly lines: readonly string[]
  readonly side: SignSide
}

export interface EditSignOutput {
  readonly position: Position
  readonly side: SignSide
  readonly lines: readonly string[]
  /** What the side said before. */
  readonly previous: readonly string[]
}

export interface EditSignDeps {
  readonly signs: SignAccess
  readonly navigator: Navigator
  readonly guard: AreaGuard
  readonly registry: SignRegistry
  readonly scheduler: Scheduler
}

const fail = (reason: string, message: string, detail?: Record<string, unknown>): SkillFailure =>
  detail === undefined ? { reason, message } : { reason, message, detail }

/** Replaces the text of one side of a sign that is not waxed (a waxed sign is refused, and can still be taken down). */
export class EditSignSkill implements Skill<EditSignInput, EditSignOutput> {
  readonly name = 'edit_sign'

  constructor(private readonly deps: EditSignDeps) {}

  async run(input: EditSignInput, context: SkillContext): Promise<SkillResult<EditSignOutput>> {
    const { deps } = this
    const state = deps.signs.stateAt(input.position)
    if (state === undefined)
      return err(fail('not_a_sign', 'There is no sign at that place (or it is not loaded).'))
    if (state.waxed)
      return err(
        fail(
          'waxed',
          'This sign is waxed, so its text cannot be changed. It can be taken down with remove_sign if the player asks for that.',
        ),
      )
    const guarded = deps.guard.protectedAt(input.position)
    if (guarded !== undefined)
      return err(
        fail(
          'protected_area',
          `This sign is inside the protected area "${guarded.label}"; the bot leaves it alone.`,
        ),
      )

    const walked = await deps.navigator.goToPosition(input.position, EDIT_RANGE, {
      signal: context.signal,
    })
    if (!walked.ok) {
      if (walked.error.reason === 'aborted') return err(fail('aborted', 'Cancelled.'))
      return err(fail('unreachable', `Could not walk to the sign: ${walked.error.message}`))
    }

    const written = await deps.signs.write(
      input.position,
      input.side,
      input.lines,
      true,
      context.signal,
    )
    if (!written.ok)
      return err(
        fail(
          written.error.reason === 'not_editable' ? 'not_editable' : 'text_not_written',
          `The text was not changed: ${written.error.message}`,
          { position: input.position },
        ),
      )
    const previous = input.side === 'front' ? state.front : state.back
    for (let attempt = 0; attempt < CONFIRM_TRIES; attempt += 1) {
      const now = deps.signs.stateAt(input.position)
      if (
        now !== undefined &&
        sameSignText(input.side === 'front' ? now.front : now.back, input.lines)
      ) {
        deps.registry.retext(input.position, input.side, input.lines)
        return ok({ position: input.position, side: input.side, lines: input.lines, previous })
      }
      await sleep(deps.scheduler, CONFIRM_MS, context.signal)
    }
    return err(
      fail(
        'text_not_confirmed',
        'The text was sent but the server does not show it on the sign. Read it with read_signs.',
        { position: input.position },
      ),
    )
  }
}
