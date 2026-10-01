import { z } from 'zod'
import type { PlaceBedSkill } from '../../skills/sleeping/place-bed-skill.js'
import type { SetRespawnPointSkill } from '../../skills/sleeping/set-respawn-point-skill.js'
import {
  DEFAULT_STAY_SECONDS,
  MAX_STAY_SECONDS,
  type SleepSkill,
} from '../../skills/sleeping/sleep-skill.js'
import { BED_COLOURS } from '../../skills/sleeping/bed-table.js'
import type { BedRegistry } from '../../state/bed-registry.js'
import { SLEEP_POLICIES, type SleepPolicy } from '../../state/sleep-policy.js'
import type { StandingInstructions } from '../../state/standing-instructions.js'
import type { TaskLauncher } from '../task-launcher.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 55

const coordinate = (what: string) => z.number().int().describe(`${what} block coordinate.`)
const positionSchema = z.object({ x: coordinate('x'), y: coordinate('y'), z: coordinate('z') })

const NEVER_IN_NETHER =
  'It never works in the Nether or the End: a bed explodes there (wrong_dimension). '

const sleepSchema = z.object({
  bed: positionSchema
    .optional()
    .describe('One of the bed blocks. Omit to use the nearest known or visible bed.'),
  stay_seconds: z
    .number()
    .int()
    .min(5)
    .max(MAX_STAY_SECONDS)
    .optional()
    .describe(
      `How long to stay in bed waiting for the night to be skipped (default ${String(DEFAULT_STAY_SECONDS)}, max ${String(MAX_STAY_SECONDS)}).`,
    ),
  ...taskOptionsShape,
})

export class SleepTool implements ToolDefinition<typeof sleepSchema> {
  readonly name = 'sleep'
  readonly description =
    'Puts the bot to bed for the night: walks to the nearest known or visible bed (or the one given), lies down, and ' +
    'stays until morning, until something wakes it, or until stay_seconds pass. The bed becomes the respawn point. ' +
    'Only possible at night (about 12,540 to 23,460 ticks) or in a thunderstorm (not_night otherwise: use ' +
    'set_respawn_point by day), and refused while hostile mobs are within about 8 blocks (monsters_nearby). ' +
    'In multiplayer the night is skipped only when enough players sleep (sleepingPercentage, default 100%): the result ' +
    'says nightSkipped true or false, and when false tell the player that someone awake keeps the night going. ' +
    NEVER_IN_NETHER +
    'Other failures: no_bed (craft one and place_bed), not_a_bed, unreachable, occupied, obstructed, aborted.'
  readonly inputSchema = sleepSchema

  constructor(
    private readonly skill: SleepSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof sleepSchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: 'Sleep through the night',
        resume: { tool: this.name, arguments: input },
        run: (ctx) => this.skill.run({ bed: input.bed, staySeconds: input.stay_seconds }, ctx),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? DEFAULT_WAIT_SECONDS,
        signal: context.signal,
      },
    )
  }
}

const respawnSchema = z.object({
  bed: positionSchema
    .optional()
    .describe('One of the bed blocks. Omit to use the nearest known or visible bed.'),
  ...taskOptionsShape,
})

export class SetRespawnPointTool implements ToolDefinition<typeof respawnSchema> {
  readonly name = 'set_respawn_point'
  readonly description =
    "Makes a bed the bot's respawn point, so that after a death it wakes up there instead of at the far-away world " +
    'spawn (which also makes drop recovery quicker and safer). Works by day or night: it right-clicks the bed and only ' +
    'reports success when the game says "Respawn point set" (not_confirmed otherwise). ' +
    'The point holds only while the bed exists and is not obstructed. ' +
    NEVER_IN_NETHER +
    'Other failures: no_bed, not_a_bed, unreachable.'
  readonly inputSchema = respawnSchema

  constructor(
    private readonly skill: SetRespawnPointSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof respawnSchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: 'Set the respawn point at a bed',
        resume: { tool: this.name, arguments: input },
        run: (ctx) => this.skill.run({ bed: input.bed }, ctx),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? 30,
        signal: context.signal,
      },
    )
  }
}

const placeSchema = z.object({
  at: positionSchema
    .optional()
    .describe(
      'The cell for the foot end of the bed; allowed inside protected areas. Omit to let the bot choose a spot near it.',
    ),
  colour: z
    .enum(BED_COLOURS)
    .optional()
    .describe('Which bed to place, for example red. Any bed carried when omitted.'),
  ...taskOptionsShape,
})

export class PlaceBedTool implements ToolDefinition<typeof placeSchema> {
  readonly name = 'place_bed'
  readonly description =
    'Puts a bed from the inventory on the ground: a bed is two blocks in a row, so it looks within 6 blocks of the bot ' +
    '(stand inside the house to put it in the house) for a free spot with solid ground and free air above, preferring ' +
    'spots against walls or in a corner and not beside a door, outside protected areas, and remembers the bed. With at ' +
    '(the foot cell) the bed goes exactly there, also inside a protected area, because you named the place. Beds are made ' +
    'with craft (for example white_bed: three wool and three planks): it does not craft or fetch one. ' +
    NEVER_IN_NETHER +
    'Failures: no_bed_item, no_space, unreachable, not_placed.'
  readonly inputSchema = placeSchema

  constructor(
    private readonly skill: PlaceBedSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof placeSchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: 'Place a bed',
        run: (ctx) => this.skill.run({ at: input.at, colour: input.colour }, ctx),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? 30,
        signal: context.signal,
      },
    )
  }
}

const noInput = z.object({})

export class ListBedsTool implements ToolDefinition<typeof noInput> {
  readonly name = 'list_beds'
  readonly description =
    'Lists the beds the bot knows in this world (placed by it, slept in, or used to set the respawn point), and which ' +
    'one is the respawn point. A bed that was found destroyed or that the bot did not respawn at is marked intact: ' +
    'false. Read-only.'
  readonly inputSchema = noInput

  constructor(private readonly registry: BedRegistry) {}

  execute() {
    const beds = this.registry.all().map((bed) => ({
      id: bed.id,
      position: { x: bed.x, y: bed.y, z: bed.z },
      colour: bed.colour,
      respawnPoint: bed.respawn,
      intact: bed.intact,
      respawnSetAt: bed.setAt,
    }))
    return toolOk({ beds, respawnPoint: beds.find((bed) => bed.respawnPoint) ?? null })
  }
}

const policySchema = z.object({
  policy: z
    .enum(SLEEP_POLICIES)
    .describe(
      '"ask": at nightfall you get a needs_decision event and ask the player (the default). "when_idle": the bot goes to bed by itself at night when no task is running and no threat is near. "never": no night prompts at all.',
    ),
})

const STANDING_TEXT: Record<'when_idle' | 'never', string> = {
  when_idle: 'At night, when the bot is idle and a bed is known, it goes to bed by itself.',
  never: 'The bot never goes to bed by itself and does not ask about sleeping at night.',
}

export class SetSleepPolicyTool implements ToolDefinition<typeof policySchema> {
  readonly name = 'set_sleep_policy'
  readonly description =
    'Saves what the bot does at nightfall as a standing rule for this world: "ask" (default: you ask the player), ' +
    '"when_idle" (it goes to bed by itself when it has nothing to do, no round trip), or "never". Set it when the ' +
    'player says something like "sleep whenever it gets dark". Nothing here ever forces the player to sleep. It ' +
    'survives restarts and appears in the session briefing. Fails when no world is active.'
  readonly inputSchema = policySchema

  constructor(
    private readonly policy: SleepPolicy,
    private readonly standing: StandingInstructions,
  ) {}

  execute(input: z.output<typeof policySchema>) {
    const saved = this.policy.set(input.policy)
    if (!saved.ok) return toolFail(saved.error)
    if (input.policy === 'ask') this.standing.remove('sleep_policy')
    else this.standing.set('sleep_policy', STANDING_TEXT[input.policy])
    return toolOk({ policy: input.policy })
  }
}
