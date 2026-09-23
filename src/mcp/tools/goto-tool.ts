import { z } from 'zod'
import type { GoToSkill, GoToTarget } from '../../skills/movement/goto-skill.js'
import type { TaskLauncher } from '../task-launcher.js'
import { toolFail } from '../tool-result.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 30

const schema = z
  .object({
    x: z.number().optional().describe('Target X coordinate. Give x, y, and z together.'),
    y: z.number().optional().describe('Target Y coordinate (height).'),
    z: z.number().optional().describe('Target Z coordinate.'),
    player: z
      .string()
      .min(1)
      .optional()
      .describe('Go to this player instead (exact in-game name).'),
    block: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Go to the nearest block of this type instead, for example "oak_log" or "crafting_table".',
      ),
    max_distance: z
      .number()
      .min(1)
      .max(64)
      .default(32)
      .describe('For block targets: how far to search, in blocks (1-64).'),
    within: z
      .number()
      .min(0.5)
      .max(20)
      .default(2)
      .describe('Stop when within this many blocks of the target.'),
    close_doors: z
      .boolean()
      .default(true)
      .describe(
        'Close a wooden door, fence gate, or trapdoor behind the bot once it has walked through it (default true).',
      ),
    ...taskOptionsShape,
  })
  .refine(
    (input) => {
      const forms = [
        input.x !== undefined && input.y !== undefined && input.z !== undefined,
        input.player !== undefined,
        input.block !== undefined,
      ]
      return (
        forms.filter(Boolean).length === 1 &&
        [input.x, input.y, input.z].filter((v) => v !== undefined).length % 3 === 0
      )
    },
    { message: 'Give exactly one target: x, y and z together, or player, or block.' },
  )

export class GoToTool implements ToolDefinition<typeof schema> {
  readonly name = 'goto'
  readonly description =
    'Walks the bot to a target: coordinates (x, y, z), a player, or the nearest block of a type. It never digs or builds ' +
    'to get there and avoids lava. A closed wooden door, fence gate, or trapdoor in the way is opened, walked through, ' +
    'and (by default, see close_doors) closed again once behind the bot. A closed iron door or trapdoor is handled by ' +
    'the standing switch policy (set_switch_policy): "auto" (the default) finds and presses a nearby button, lever, or ' +
    'plate itself and restores a lever afterward; "ask" fails with iron_door_blocked, naming the switches found nearby, ' +
    'so you can tell the player and then call open_door or press_switch; "never" (and "ask" with nothing found nearby) ' +
    'fails with needs_switch. A wooden door that will not open after two tries fails with door_stuck. Long trips continue ' +
    'in the background: if the wait_seconds budget runs out the reply has status "running" and you poll get_task_status. ' +
    'Fails with a reason such as unreachable, stuck, timeout, target_not_found, block_not_found, door_stuck, needs_switch, ' +
    'or iron_door_blocked. Only one task runs at a time; pass replace=true to interrupt the current one.'
  readonly inputSchema = schema

  constructor(
    private readonly skill: GoToSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof schema>, context: ToolContext) {
    let target: GoToTarget
    let description: string
    if (input.player !== undefined) {
      target = { kind: 'player', name: input.player }
      description = `Go to player ${input.player}`
    } else if (input.block !== undefined) {
      target = { kind: 'block', name: input.block, maxDistance: input.max_distance }
      description = `Go to the nearest ${input.block}`
    } else if (input.x !== undefined && input.y !== undefined && input.z !== undefined) {
      target = { kind: 'position', position: { x: input.x, y: input.y, z: input.z } }
      description = `Go to ${String(input.x)}, ${String(input.y)}, ${String(input.z)}`
    } else {
      return toolFail('Give exactly one target: x, y and z together, or player, or block.')
    }

    return this.launcher.launch(
      {
        name: this.skill.name,
        description,
        resume: { tool: this.name, arguments: resumeArguments(input) },
        run: (ctx) =>
          this.skill.run({ target, within: input.within, closeDoors: input.close_doors }, ctx),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? DEFAULT_WAIT_SECONDS,
        signal: context.signal,
      },
    )
  }
}

/** What it takes to start the same trip again (without the wait and replace options). */
function resumeArguments(input: z.output<typeof schema>): Record<string, unknown> {
  const { wait_seconds: _wait, replace: _replace, ...rest } = input
  return rest
}
