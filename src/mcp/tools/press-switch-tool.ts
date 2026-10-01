import { z } from 'zod'
import type { LookTarget } from '../../core/container.port.js'
import type { PressSwitchSkill } from '../../skills/movement/press-switch-skill.js'
import type { TaskLauncher } from '../task-launcher.js'
import { toolFail } from '../tool-result.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { positionSchema, resolveLookedAtPosition } from './resolve-target-position.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 20

const schema = z.object({
  at: positionSchema
    .optional()
    .describe("The button, lever, or pressure plate to press. Omit to use for_player's look."),
  for_player: z
    .string()
    .min(1)
    .optional()
    .describe('Whose look to use when at is omitted. Defaults to the owner.'),
  ...taskOptionsShape,
})

export class PressSwitchTool implements ToolDefinition<typeof schema> {
  readonly name = 'press_switch'
  readonly description =
    'Walks to a button, lever, or pressure plate (by position, or the one the player is looking at) and presses it: a ' +
    'right click for a button or lever, or steps onto a plate. The result names the nearest door within 4 blocks and ' +
    'whether it is now open, if one was found. Fails with not_a_switch when the block at that position is none of those, ' +
    'or with a navigation reason (unreachable, stuck, timeout) when the bot cannot get there.'
  readonly inputSchema = schema

  constructor(
    private readonly skill: PressSwitchSkill,
    private readonly launcher: TaskLauncher,
    private readonly look: LookTarget,
    private readonly defaultPlayer: string | undefined,
  ) {}

  execute(input: z.output<typeof schema>, context: ToolContext) {
    const resolved = resolveLookedAtPosition(input.at, input.for_player, this.defaultPlayer, this.look)
    if (!resolved.ok) return toolFail(resolved.error)
    const position = resolved.value

    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Press the switch at ${where(position)}`,
        resume: { tool: this.name, arguments: { at: position } },
        run: (ctx) => this.skill.run({ position }, ctx),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? DEFAULT_WAIT_SECONDS,
        signal: context.signal,
      },
    )
  }
}

const where = (position: { x: number; y: number; z: number }): string =>
  `${String(position.x)}, ${String(position.y)}, ${String(position.z)}`
