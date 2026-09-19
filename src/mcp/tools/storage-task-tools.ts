import { z } from 'zod'
import type { DepositItemsSkill } from '../../skills/storage/deposit-items-skill.js'
import type { FindItemsSkill } from '../../skills/storage/find-items-skill.js'
import type { ScanContainersSkill } from '../../skills/storage/scan-containers-skill.js'
import type { WithdrawItemsSkill } from '../../skills/storage/withdraw-items-skill.js'
import type { TaskLauncher } from '../task-launcher.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 30

const depositSchema = z.object({
  items: z
    .array(z.string().min(1))
    .max(30)
    .optional()
    .describe(
      'Item names and/or groups (logs, ores, ingots, food, tools, blocks, ...) to deposit. Omit to deposit everything the bot may part with.',
    ),
  container: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Put everything into this container (id or label) instead of following the storage rules.',
    ),
  count: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('How many, when a single exact item is named. Everything carried otherwise.'),
  include_reserved: z
    .boolean()
    .default(false)
    .describe(
      'Also deposit tools, weapons, armor, food, torches, and buckets, which the bot normally keeps.',
    ),
  max_distance: z
    .number()
    .min(1)
    .max(128)
    .default(64)
    .describe('Containers without a matching rule are only used within this many blocks.'),
  ...taskOptionsShape,
})

export class DepositItemsTool implements ToolDefinition<typeof depositSchema> {
  readonly name = 'deposit_items'
  readonly description =
    'Walks to containers and puts items in: into the container a storage rule names for each kind of item, otherwise into ' +
    'the nearest known container with room, otherwise into a chest nearby that nobody registered yet (it gets registered). ' +
    'Full or vanished containers are skipped. Protected containers are never used. Tools, weapons, armor, food, torches, ' +
    'and buckets stay with the bot unless named exactly or include_reserved is set. Result: what went where, and what ' +
    'did not fit. Fails with nothing_to_deposit, no_storage_space, unknown_container, or protected.'
  readonly inputSchema = depositSchema

  constructor(
    private readonly skill: DepositItemsSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof depositSchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description:
          input.items === undefined ? 'Deposit items' : `Deposit ${input.items.join(' / ')}`,
        run: (ctx) =>
          this.skill.run(
            {
              specs: input.items,
              includeReserved: input.include_reserved,
              container: input.container,
              count: input.count,
              maxDistance: input.max_distance,
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

const withdrawSchema = z.object({
  items: z
    .array(
      z.object({
        item: z
          .string()
          .min(1)
          .describe(
            'An item name, or a group such as "ores" (then everything known that matches).',
          ),
        count: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('How many. Everything found when omitted.'),
      }),
    )
    .min(1)
    .max(20)
    .describe('What to take out.'),
  container: z.string().min(1).optional().describe('Take only from this container (id or label).'),
  ...taskOptionsShape,
})

export class WithdrawItemsTool implements ToolDefinition<typeof withdrawSchema> {
  readonly name = 'withdraw_items'
  readonly description =
    'Walks to the containers that held the items (nearest first; the memory comes from find_items or scan_containers), opens ' +
    'them, and takes the items out. It reads what a container really holds when it opens it. Protected containers are ' +
    'never touched. Result: what was taken, and for requests with a count what is still missing. Fails with not_found ' +
    '(scan first), inventory_full, unknown_container, or protected.'
  readonly inputSchema = withdrawSchema

  constructor(
    private readonly skill: WithdrawItemsSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof withdrawSchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Withdraw ${input.items.map((i) => i.item).join(' / ')}`,
        run: (ctx) =>
          this.skill.run(
            {
              requests: input.items.map((i) => ({ item: i.item, count: i.count })),
              container: input.container,
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

const findSchema = z.object({
  item: z.string().min(1).describe('An item name or a group, for example "iron_ingot" or "ores".'),
  scan_if_missing: z
    .boolean()
    .default(true)
    .describe(
      'When the memory has nothing, open the known containers and the ones nearby, and look again.',
    ),
  radius: z
    .number()
    .min(4)
    .max(64)
    .default(24)
    .describe('How far to look for unregistered containers when scanning.'),
  ...taskOptionsShape,
})

export class FindItemsTool implements ToolDefinition<typeof findSchema> {
  readonly name = 'find_items'
  readonly description =
    'Says which containers hold an item (or a group): from memory first, and after opening the containers when memory has ' +
    'nothing. Result: per container its id, label, position, protected flag, the matching stacks, and when it was last ' +
    'opened, plus the total. Use it to answer "where are my iron ingots?" and before withdraw_items.'
  readonly inputSchema = findSchema

  constructor(
    private readonly skill: FindItemsSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof findSchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Find ${input.item} in the containers`,
        run: (ctx) =>
          this.skill.run(
            { query: input.item, scanIfMissing: input.scan_if_missing, radius: input.radius },
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

const scanSchema = z.object({
  radius: z
    .number()
    .min(4)
    .max(64)
    .default(24)
    .describe('Also register containers found within this many blocks.'),
  refresh_known: z
    .boolean()
    .default(true)
    .describe('Open the containers already known to refresh what is in them.'),
  ...taskOptionsShape,
})

export class ScanContainersTool implements ToolDefinition<typeof scanSchema> {
  readonly name = 'scan_containers'
  readonly description =
    'Opens containers one after another (nearest first) to refresh what the bot remembers about them, and registers ' +
    'chests, barrels, and shulker boxes it did not know within the radius. It only looks, it takes nothing. Containers ' +
    'that are gone are forgotten. Result: how many were opened, found, and missing, and a summary per container.'
  readonly inputSchema = scanSchema

  constructor(
    private readonly skill: ScanContainersSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof scanSchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: 'Scan containers',
        run: (ctx) =>
          this.skill.run({ radius: input.radius, refreshKnown: input.refresh_known }, ctx),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? DEFAULT_WAIT_SECONDS,
        signal: context.signal,
      },
    )
  }
}
