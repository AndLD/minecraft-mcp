import { z } from 'zod'
import { HUNTABLE_SPECIES_NAMES, goalForItem } from '../../skills/hunting/animal-catalog.js'
import type { HuntAnimalsSkill, HuntGoal } from '../../skills/hunting/hunt-animals-skill.js'
import { INVENTORY_FULL_KINDS } from '../../state/storage-policy.js'
import type { TaskLauncher } from '../task-launcher.js'
import { toolFail } from '../tool-result.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 25

const schema = z
  .object({
    item: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Hunt until the inventory has this many of an item: "beef", "porkchop", "mutton", "chicken", "rabbit", "leather", ' +
          '"feather", "wool", or a cooked meat such as "cooked_beef" (then the meat is cooked too).',
      ),
    species: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe(
        `Hunt these animals instead and stop after killing "count" of them. Huntable: ${HUNTABLE_SPECIES_NAMES.join(', ')}.`,
      ),
    count: z
      .number()
      .int()
      .min(1)
      .max(256)
      .default(1)
      .describe('How many of the item to collect, or how many animals to kill.'),
    radius: z
      .number()
      .min(4)
      .max(64)
      .default(24)
      .describe('How far to look for animals, in blocks.'),
    keep_breeders: z
      .boolean()
      .default(true)
      .describe(
        'Never hunt the last two adults of a species in view, so the herd can breed again.',
      ),
    allow_babies: z.boolean().default(false).describe('Also hunt baby animals.'),
    include_pens: z
      .boolean()
      .default(false)
      .describe(
        "Also hunt animals inside fenced pens (skipped by default: they are usually somebody's farm).",
      ),
    cook: z
      .boolean()
      .default(false)
      .describe('Cook the raw meat afterwards in a furnace (fuel is chosen automatically).'),
    time_limit_seconds: z
      .number()
      .int()
      .min(30)
      .max(1800)
      .default(300)
      .describe('Give up after this long.'),
    on_inventory_full: z
      .enum(INVENTORY_FULL_KINDS)
      .optional()
      .describe(
        'What to do when the inventory fills up: "offload_and_return" (take things to the chests by the storage rules, come back, carry on), "ask" (pause and wait for resume_task), or "stop". Defaults to the standing set_storage_policy, which defaults to ask.',
      ),
    deposit_cooked: z
      .boolean()
      .default(false)
      .describe(
        'After cooking, put the cooked meat into a container by the storage rules (the food rule, else any chest with room).',
      ),
    ...taskOptionsShape,
  })
  .refine((input) => (input.item === undefined) !== (input.species === undefined), {
    message: 'Give exactly one of item or species.',
  })

export class HuntAnimalsTool implements ToolDefinition<typeof schema> {
  readonly name = 'hunt_animals'
  readonly description =
    'Hunts livestock (cow, pig, sheep, chicken, rabbit, mooshroom): finds the nearest one, kills it in melee with the best weapon, ' +
    'picks up the drops, and repeats until the goal is met: "item" + "count" collects that many of an item (for example 10 ' +
    'cooked_beef), "species" + "count" kills that many animals. It never harms pets, animals with a name tag, saddled or ridden ' +
    'ones, babies, animals in fenced pens, or the last breeding pair of a species (each can be overridden by a parameter). ' +
    'Hostile mobs and low health are handled by reflexes, which pause the hunt and let it resume. Runs in the background: poll ' +
    'get_task_status when the reply has status "running". Fails with no_animals, protected, breeding_floor (tell the player ' +
    'the herd is at its minimum), inventory_full, time_limit, or unreachable; the message reports what was done and the ' +
    'animal counts before and after. Use list_huntable_animals first for big hunts.'
  readonly inputSchema = schema

  constructor(
    private readonly skill: HuntAnimalsSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof schema>, context: ToolContext) {
    let goal: HuntGoal
    let species: readonly string[]
    let cook = input.cook
    if (input.item !== undefined) {
      const resolved = goalForItem(input.item)
      if (resolved === undefined)
        return toolFail(
          `No huntable animal drops "${input.item}". Try beef, porkchop, mutton, chicken, rabbit, leather, feather, or wool (or cooked_beef and the like).`,
        )
      goal = { kind: 'items', item: resolved.raw, count: input.count }
      species = resolved.species
      cook = cook || resolved.cooked !== undefined
    } else {
      goal = { kind: 'animals', count: input.count }
      species = input.species ?? []
    }

    // A resumed hunt only has to finish what is missing.
    const progress = { done: 0 }
    const { wait_seconds: _wait, replace: _replace, ...base } = input
    const target = input.count
    return this.launcher.launch(
      {
        name: this.skill.name,
        description:
          input.item === undefined
            ? `Hunt ${String(input.count)} ${species.join(' / ')}`
            : `Hunt for ${String(input.count)} ${input.item}`,
        resume: {
          tool: this.name,
          get arguments() {
            return { ...base, count: Math.max(1, target - progress.done) }
          },
        },
        run: (ctx) =>
          this.skill.run(
            {
              species,
              goal,
              radius: input.radius,
              keepBreeders: input.keep_breeders,
              allowBabies: input.allow_babies,
              includePens: input.include_pens,
              cook,
              timeLimitMs: input.time_limit_seconds * 1000,
              onInventoryFull: input.on_inventory_full,
              depositCooked: input.deposit_cooked,
              onProgress: (done) => {
                progress.done = done
              },
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
