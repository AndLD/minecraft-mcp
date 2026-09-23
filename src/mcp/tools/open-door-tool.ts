import { z } from 'zod'
import type { LookTarget } from '../../core/container.port.js'
import type { OpenDoorSkill } from '../../skills/movement/open-door-skill.js'
import type { TaskLauncher } from '../task-launcher.js'
import { toolFail } from '../tool-result.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { positionSchema, resolveLookedAtPosition } from './resolve-target-position.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 30

const schema = z.object({
  at: positionSchema
    .optional()
    .describe("The door, gate, or trapdoor to open. Omit to use for_player's look."),
  for_player: z
    .string()
    .min(1)
    .optional()
    .describe('Whose look to use when at is omitted. Defaults to the owner.'),
  walk_through: z
    .boolean()
    .default(true)
    .describe('Walk to just past the door once it is open (default true).'),
  restore: z
    .boolean()
    .default(true)
    .describe(
      'Close a wooden door again, or put a pressed lever back, once through (default true). Buttons and plates ' +
        'need no restoring: they time out or release by themselves.',
    ),
  ...taskOptionsShape,
})

export class OpenDoorTool implements ToolDefinition<typeof schema> {
  readonly name = 'open_door'
  readonly description =
    'Opens a door, gate, or trapdoor (by position, or the one the player is looking at) — wooden or iron. A wooden one ' +
    'is right-clicked directly. An iron one is opened by finding and pressing a nearby button, lever, or plate itself ' +
    '(the switch policy from set_switch_policy is not consulted: calling this tool is already the decision to try). By ' +
    'default walks the bot just past the door and, once through, closes a wooden door again or restores a lever ' +
    '(restore=false leaves it open or pressed). Fails with not_a_door, no_switches_found, door_did_not_open (with what ' +
    'was tried), or a navigation reason such as unreachable or stuck.'
  readonly inputSchema = schema

  constructor(
    private readonly skill: OpenDoorSkill,
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
        description: `Open the door at ${where(position)}`,
        resume: {
          tool: this.name,
          arguments: { at: position, walk_through: input.walk_through, restore: input.restore },
        },
        run: (ctx) =>
          this.skill.run(
            { position, walkThrough: input.walk_through, restore: input.restore },
            ctx,
          ),
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
