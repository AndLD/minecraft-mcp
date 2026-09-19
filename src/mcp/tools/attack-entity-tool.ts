import { z } from 'zod'
import type { AttackEntitySkill, AttackInput } from '../../skills/hunting/attack-entity-skill.js'
import type { TaskLauncher } from '../task-launcher.js'
import { toolFail } from '../tool-result.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 20

const schema = z
  .object({
    entity_id: z
      .number()
      .int()
      .optional()
      .describe('The animal to attack, by id (from list_huntable_animals or get_nearby_entities).'),
    species: z
      .string()
      .min(1)
      .optional()
      .describe('Attack the nearest animal of this species instead, for example "cow".'),
    force: z
      .boolean()
      .default(false)
      .describe(
        'Attack even a pet, a named animal, a saddled or ridden one, or a species that is not livestock. Only when the player asks for exactly that.',
      ),
    radius: z.number().min(1).max(48).default(16).describe('For "species": how far to look.'),
    ...taskOptionsShape,
  })
  .refine((input) => (input.entity_id === undefined) !== (input.species === undefined), {
    message: 'Give exactly one of entity_id or species.',
  })

export class AttackEntityTool implements ToolDefinition<typeof schema> {
  readonly name = 'attack_entity'
  readonly description =
    'Kills one specific animal ("kill that cow"): chases it, hits it with the best weapon, and picks up the drops. Refuses ' +
    'pets, animals with a name tag, and saddled or ridden ones (and species that are not livestock) unless force is true. ' +
    'Fails with target_not_found, protected, or target_lost (it got away).'
  readonly inputSchema = schema

  constructor(
    private readonly skill: AttackEntitySkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof schema>, context: ToolContext) {
    let target: AttackInput['target']
    if (input.entity_id !== undefined) target = { kind: 'id', id: input.entity_id }
    else if (input.species !== undefined) target = { kind: 'nearest', species: input.species }
    else return toolFail('Give exactly one of entity_id or species.')

    return this.launcher.launch(
      {
        name: this.skill.name,
        description:
          target.kind === 'id'
            ? `Attack animal ${String(target.id)}`
            : `Attack the nearest ${target.species}`,
        run: (ctx) => this.skill.run({ target, force: input.force, radius: input.radius }, ctx),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? DEFAULT_WAIT_SECONDS,
        signal: context.signal,
      },
    )
  }
}
