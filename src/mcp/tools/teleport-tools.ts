import { z } from 'zod'
import type { TeleportSkill } from '../../skills/commands/teleport-skill.js'
import type { TaskLauncher } from '../task-launcher.js'
import { toolFail } from '../tool-result.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 20

const REQUEST_ONLY =
  'Only when the player asks for it ("teleport to me", "come here now"): never as a shortcut on your own, and never ' +
  'because walking looks slow. '
const REQUIREMENTS =
  'Needs cheats on and the bot to be an operator (the host types /op <bot name>): otherwise it fails with ' +
  'no_permission and the message says exactly what to enable, and you offer walking (goto) instead. get_status shows ' +
  'whether teleporting is available. Other failures: player_not_online, unknown_command, teleport_failed. '

const playerSchema = z.object({
  player: z
    .string()
    .min(1)
    .optional()
    .describe('Exact in-game name of the player to teleport to. Defaults to the configured owner.'),
  ...taskOptionsShape,
})

export class TeleportToPlayerTool implements ToolDefinition<typeof playerSchema> {
  readonly name = 'teleport_to_player'
  readonly description =
    'Teleports the bot to a player with the server command /tp, even across large distances, water, or dimensions. ' +
    REQUEST_ONLY +
    REQUIREMENTS +
    "The bot lands on the player's block and then steps to a safe spot next to them; the reply says where it stands."
  readonly inputSchema = playerSchema

  constructor(
    private readonly skill: TeleportSkill,
    private readonly launcher: TaskLauncher,
    private readonly owner: string | undefined,
  ) {}

  execute(input: z.output<typeof playerSchema>, context: ToolContext) {
    const player = input.player ?? this.owner
    if (player === undefined)
      return toolFail('Say which player to teleport to: no owner is configured.')
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Teleport to ${player}`,
        run: (ctx) => this.skill.run({ target: { kind: 'player', name: player } }, ctx),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? DEFAULT_WAIT_SECONDS,
        signal: context.signal,
      },
    )
  }
}

const positionSchema = z.object({
  x: z.number().describe('Block x coordinate.'),
  y: z.number().min(-64).max(320).describe('Block y coordinate (height, -64 to 320).'),
  z: z.number().describe('Block z coordinate.'),
  ...taskOptionsShape,
})

export class TeleportToPositionTool implements ToolDefinition<typeof positionSchema> {
  readonly name = 'teleport_to_position'
  readonly description =
    'Teleports the bot to coordinates in its current dimension with the server command /tp. The spot is not checked: ' +
    'make sure it is safe (not inside a wall, over lava, or high above ground) before asking. ' +
    REQUEST_ONLY +
    REQUIREMENTS

  readonly inputSchema = positionSchema

  constructor(
    private readonly skill: TeleportSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof positionSchema>, context: ToolContext) {
    const position = { x: input.x, y: input.y, z: input.z }
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Teleport to ${String(input.x)}, ${String(input.y)}, ${String(input.z)}`,
        run: (ctx) => this.skill.run({ target: { kind: 'position', position } }, ctx),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? DEFAULT_WAIT_SECONDS,
        signal: context.signal,
      },
    )
  }
}
