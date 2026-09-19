import { z } from 'zod'
import type { FollowPlayerSkill } from '../../skills/movement/follow-player-skill.js'
import type { TaskLauncher } from '../task-launcher.js'
import { toolFail } from '../tool-result.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 2

const schema = z.object({
  player: z
    .string()
    .min(1)
    .optional()
    .describe('Exact in-game name. Defaults to the configured owner.'),
  distance: z
    .number()
    .min(1)
    .max(10)
    .default(3)
    .describe('Keep about this many blocks away (1-10).'),
  ...taskOptionsShape,
})

export class FollowPlayerTool implements ToolDefinition<typeof schema> {
  readonly name = 'follow_player'
  readonly description =
    'Follows a player around until told to stop (call stop or cancel_task). The reply comes back quickly with status ' +
    '"running" once following has started. Fails if the player is not in view (out of view distance) or is lost for ' +
    'more than about 10 seconds. Only one task runs at a time; pass replace=true to interrupt the current one.'
  readonly inputSchema = schema

  constructor(
    private readonly skill: FollowPlayerSkill,
    private readonly launcher: TaskLauncher,
    private readonly defaultPlayer: string | undefined,
  ) {}

  execute(input: z.output<typeof schema>, context: ToolContext) {
    const player = input.player ?? this.defaultPlayer
    if (player === undefined) return toolFail('Say which player to follow: no owner is configured.')
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Follow ${player}`,
        run: (ctx) => this.skill.run({ player, distance: input.distance }, ctx),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? DEFAULT_WAIT_SECONDS,
        signal: context.signal,
      },
    )
  }
}
