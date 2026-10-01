import type { Navigator } from '../../core/navigator.port.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'

export interface FollowPlayerInput {
  readonly player: string
  /** Keep about this many blocks away. */
  readonly distance: number
}

/** Follows until cancelled; it only ends by itself if the player is lost. */
export class FollowPlayerSkill implements Skill<
  FollowPlayerInput,
  { readonly stoppedFollowing: string }
> {
  readonly name = 'follow_player'

  constructor(private readonly navigator: Navigator) {}

  async run(
    input: FollowPlayerInput,
    context: SkillContext,
  ): Promise<SkillResult<{ readonly stoppedFollowing: string }>> {
    context.progress(`Following ${input.player}`)
    const result = await this.navigator.follow(input.player, input.distance, {
      signal: context.signal,
    })
    return result.ok ? ok({ stoppedFollowing: input.player }) : err(result.error)
  }
}
