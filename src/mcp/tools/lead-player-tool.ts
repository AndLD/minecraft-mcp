import { z } from 'zod'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { LeadPlayerSkill } from '../../skills/movement/lead-player-skill.js'
import type { LeadTargetResolver } from '../../skills/movement/lead-target.js'
import type { TaskLauncher } from '../task-launcher.js'
import { toolFail } from '../tool-result.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 55

const schema = z
  .object({
    target: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Where to lead: a landmark ("home"), a structure the bot has found ("village", "desert_temple"), a biome it has found, a registered chest or farm label. Or give x, y, and z.',
      ),
    x: z.number().optional().describe('X coordinate. Give x, y, and z together.'),
    y: z.number().optional().describe('Y coordinate.'),
    z: z.number().optional().describe('Z coordinate.'),
    lead_distance: z
      .number()
      .int()
      .min(5)
      .max(16)
      .default(8)
      .describe('The bot never gets farther than this from the player (5-16, default 8).'),
    arrive_within: z
      .number()
      .min(2)
      .max(30)
      .default(8)
      .describe('Stop this close to the destination (2-30, default 8).'),
    for_player: z.string().min(1).optional().describe('The player to lead (default: the owner).'),
    ...taskOptionsShape,
  })
  .refine(
    (input) => {
      const coordinates = [input.x, input.y, input.z].filter((value) => value !== undefined).length
      return coordinates === 3
        ? input.target === undefined
        : coordinates === 0 && input.target !== undefined
    },
    { message: 'Give either target, or x, y, and z together (not both).' },
  )

export class LeadPlayerTool implements ToolDefinition<typeof schema> {
  readonly name = 'lead_player'
  readonly description =
    'Leads a player to a place ("come to me and lead me to the village"). The bot first comes to the player, then walks ' +
    'towards the destination in short legs and never gets farther from the player than lead_distance: when the player ' +
    'falls behind it stops, turns to face them, and calls them to follow (about every 10 seconds); it goes on when they ' +
    'are close again (60% of lead_distance), and if they walk off it goes back to them. At the destination it says where ' +
    'they are and the task succeeds. Walks only: it never digs or builds and avoids lava. Fails with unknown target ' +
    '(nothing is known by that name: find the structure first with explore_for_structure or set_landmark), ' +
    'player_offline, player_lost (out of view for a minute: ask where they went), player_not_following (no follower for ' +
    '10 minutes), unreachable, or aborted (the stop command or cancel_task). After a reflex made the bot flee, ask the ' +
    'player before leading again. Long trips continue in the background: poll get_task_status. Only one task runs at a ' +
    'time; pass replace=true to interrupt the current one.'
  readonly inputSchema = schema

  constructor(
    private readonly skill: LeadPlayerSkill,
    private readonly launcher: TaskLauncher,
    private readonly targets: LeadTargetResolver,
    private readonly vitals: VitalsReader,
    private readonly owner: string | undefined,
  ) {}

  execute(input: z.output<typeof schema>, context: ToolContext) {
    const player = input.for_player ?? this.owner
    if (player === undefined)
      return toolFail('Say which player: no owner is configured, and none was given as for_player.')

    let destination: { label: string; position: { x: number; y: number; z: number } }
    if (input.x !== undefined && input.y !== undefined && input.z !== undefined) {
      const position = { x: input.x, y: input.y, z: input.z }
      destination = {
        label: `${String(Math.round(input.x))}, ${String(Math.round(input.y))}, ${String(Math.round(input.z))}`,
        position,
      }
    } else {
      const resolved = this.targets.resolve(input.target ?? '')
      if (!resolved.ok) return toolFail(`unknown target: ${resolved.error}`)
      if (
        (resolved.value.source === 'structure' || resolved.value.source === 'biome') &&
        /nether|end/i.test(this.vitals.read()?.dimension ?? '')
      )
        return toolFail(
          `${resolved.value.label} is in the Overworld, and the bot is not there (wrong_dimension).`,
        )
      destination = { label: resolved.value.label, position: resolved.value.position }
    }

    const { wait_seconds: _wait, replace: _replace, ...resume } = input
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Lead ${player} to ${destination.label}`,
        resume: { tool: this.name, arguments: resume },
        run: (ctx) =>
          this.skill.run(
            {
              player,
              destination,
              leadDistance: input.lead_distance,
              arriveWithin: input.arrive_within,
            },
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
