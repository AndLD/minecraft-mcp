import { z } from 'zod'
import { countItems } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { DropItemsSkill } from '../../skills/handover/drop-items-skill.js'
import type { GiveItemsSkill } from '../../skills/handover/give-items-skill.js'
import type { ItemRequest } from '../../skills/handover/handover.types.js'
import type { ItemResolver } from '../../skills/handover/item-resolver.js'
import type { ContainerIndex } from '../../state/container-index.js'
import type { TaskLauncher } from '../task-launcher.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 40

const itemShape = z
  .object({
    item: z
      .string()
      .min(1)
      .describe(
        'What the player asked for, in their words: an item name ("iron_ingot"), a plural ("logs"), an everyday word ("cobble", "steak"), or a group ("food", "ores"). Ambiguous words such as "iron" or "wood" are answered with candidates: ask the player which.',
      ),
    count: z.number().int().min(1).max(4608).optional().describe('How many items.'),
    stacks: z
      .number()
      .int()
      .min(1)
      .max(72)
      .optional()
      .describe('How many full stacks (64 for most items, 16 for ender pearls, ...).'),
    all: z
      .boolean()
      .optional()
      .describe(
        'Everything the bot has of it (in the inventory, and in chests when fetching is allowed).',
      ),
  })
  .refine(
    (entry) =>
      [entry.count, entry.stacks, entry.all === true ? true : undefined].filter(
        (v) => v !== undefined,
      ).length <= 1,
    {
      message: 'Give only one of count, stacks, or all for each item.',
    },
  )

type ItemEntry = z.output<typeof itemShape>

const toRequest = (entry: ItemEntry): ItemRequest => ({
  item: entry.item,
  amount:
    entry.all === true
      ? { kind: 'all' }
      : entry.stacks !== undefined
        ? { kind: 'stacks', stacks: entry.stacks }
        : { kind: 'count', count: entry.count ?? 1 },
})

const giveSchema = z.object({
  items: z
    .array(itemShape)
    .min(1)
    .max(20)
    .describe('What to give. Each entry has one of count, stacks, or all (default: 1).'),
  player: z
    .string()
    .min(1)
    .optional()
    .describe('Who gets it (exact in-game name). Defaults to the owner.'),
  fetch_from_storage: z
    .boolean()
    .default(true)
    .describe(
      'Fetch what the bot does not carry from the containers it may use (never protected ones).',
    ),
  keep_reserve: z
    .boolean()
    .default(true)
    .describe(
      'Requests by group ("food", "tools") leave out the bot\'s own tools, armor, food, and torches. Naming an item exactly always gives it.',
    ),
  mode: z
    .enum(['drop', 'chest'])
    .default('drop')
    .describe(
      '"drop": walk to the player and throw the items at their feet. "chest": put them in a chest instead (for many stacks) and say which.',
    ),
  chest: z
    .string()
    .min(1)
    .optional()
    .describe('For chest mode: the container id or label. By the storage rules when omitted.'),
  ...taskOptionsShape,
})

export class GiveItemsTool implements ToolDefinition<typeof giveSchema> {
  readonly name = 'give_items'
  readonly description =
    'Gives items to a player: takes what the bot carries, fetches the rest from the chests it may use, walks to the player, ' +
    'faces them, and throws the items at their feet, then steps back and reports what nobody picked up. Large amounts can go ' +
    'into a chest instead (mode "chest"). Result: exactly what was given, what is still missing (shortfall: offer to gather, ' +
    'craft, or hunt it), and anything left on the ground. Fails with ambiguous (ask the player which item; the candidates are ' +
    'listed), unknown_item, shortfall (nothing available at all), player_not_online, player_not_visible (far away or in ' +
    'another dimension), unsafe_drop_spot, or unreachable. Runs in the background: poll get_task_status when the reply has ' +
    'status "running".'
  readonly inputSchema = giveSchema

  constructor(
    private readonly skill: GiveItemsSkill,
    private readonly launcher: TaskLauncher,
    private readonly owner: string | undefined,
  ) {}

  execute(input: z.output<typeof giveSchema>, context: ToolContext) {
    const player = input.player ?? this.owner
    if (player === undefined)
      return toolFail('Say who gets the items (player), or set MC_OWNER so there is a default.')
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Give ${input.items.map((i) => i.item).join(' / ')} to ${player}`,
        run: (ctx) =>
          this.skill.run(
            {
              player,
              requests: input.items.map(toRequest),
              fetchFromStorage: input.fetch_from_storage,
              keepReserve: input.keep_reserve,
              mode: input.mode,
              chest: input.chest,
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

const dropSchema = z.object({
  items: z
    .array(itemShape)
    .min(1)
    .max(20)
    .describe('What to throw away. Each entry has one of count, stacks, or all (default: 1).'),
  keep_reserve: z
    .boolean()
    .default(true)
    .describe(
      "Requests by group leave out the bot's tools, armor, food, and torches. Naming an item exactly always drops it.",
    ),
  ...taskOptionsShape,
})

export class DropItemsTool implements ToolDefinition<typeof dropSchema> {
  readonly name = 'drop_items'
  readonly description =
    'Throws items on the ground where the bot stands, for example to get rid of junk, then steps away so it does not pick ' +
    'them up again. To give items to a player use give_items instead. Result: what was dropped. Fails with nothing_to_drop, ' +
    'ambiguous, unknown_item, or unsafe_drop_spot.'
  readonly inputSchema = dropSchema

  constructor(
    private readonly skill: DropItemsSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof dropSchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Drop ${input.items.map((i) => i.item).join(' / ')}`,
        run: (ctx) =>
          this.skill.run(
            { requests: input.items.map(toRequest), keepReserve: input.keep_reserve },
            ctx,
          ),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? 20,
        signal: context.signal,
      },
    )
  }
}

const resolveSchema = z.object({
  item: z
    .string()
    .min(1)
    .describe(
      'The words the player used for the item, for example "iron", "cobble", "logs", or "food".',
    ),
})

export class ResolveItemTool implements ToolDefinition<typeof resolveSchema> {
  readonly name = 'resolve_item'
  readonly description =
    'Shows what item words mean: the concrete item name(s) they resolve to, or, when several things fit ("iron", "wood"), the ' +
    'candidates with how many the bot carries and has in chests, so you can ask the player which one. Read-only.'
  readonly inputSchema = resolveSchema

  constructor(
    private readonly resolver: ItemResolver,
    private readonly inventory: InventoryReader,
    private readonly index: ContainerIndex,
  ) {}

  execute(input: z.output<typeof resolveSchema>) {
    const snapshot = this.inventory.snapshot()
    if (snapshot === undefined) return toolFail('Not connected to a Minecraft world.')
    const stored = new Map<string, number>()
    for (const entry of this.index.all()) {
      if (entry.protected) continue
      for (const stack of entry.contents)
        stored.set(stack.name, (stored.get(stack.name) ?? 0) + stack.count)
    }
    const resolution = this.resolver.resolve(input.item, { carried: countItems(snapshot), stored })
    return toolOk({ phrase: input.item, ...resolution })
  }
}
