import { z } from 'zod'
import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { LookTarget } from '../../core/container.port.js'
import { roundPosition } from '../../core/position.js'
import {
  isContainerBlock,
  type ContainerEntry,
  type ContainerIndex,
} from '../../state/container-index.js'
import type { StorageRules } from '../../state/storage-rules.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolDefinition } from '../tool.types.js'

const MAX_ITEMS_LISTED = 40
const NEAREST_RANGE = 16

/** How many storage rules send items to the container. */
const rulesOf = (id: string, rules: StorageRules): number =>
  rules.ordered().filter((rule) => rule.containerId === id).length

const view = (entry: ContainerEntry, rules: StorageRules) => ({
  id: entry.id,
  label: entry.label,
  block: entry.blockName,
  position: entry.position,
  protected: entry.protected,
  foundByScan: entry.auto,
  lastOpened: entry.seenAt,
  emptySlots: entry.emptySlots,
  totalSlots: entry.totalSlots,
  rules: rulesOf(entry.id, rules),
  items: [...entry.contents]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, MAX_ITEMS_LISTED),
})

const registerSchema = z
  .object({
    x: z.number().optional().describe('X of the chest. Give x, y, and z together.'),
    y: z.number().optional().describe('Y (height) of the chest.'),
    z: z.number().optional().describe('Z of the chest.'),
    looking_at: z
      .boolean()
      .optional()
      .describe('Register the container the player (the owner) is looking at right now.'),
    nearest: z.boolean().optional().describe('Register the container nearest to the bot.'),
    label: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe('A name for it, for example "home", "wood", or "tools". Labels are unique.'),
    protected: z
      .boolean()
      .optional()
      .describe('Mark it protected: the bot never takes from it or puts into it.'),
  })
  .refine(
    (input) => {
      const forms = [
        input.x !== undefined && input.y !== undefined && input.z !== undefined,
        input.looking_at === true,
        input.nearest === true,
      ]
      return (
        forms.filter(Boolean).length === 1 &&
        [input.x, input.y, input.z].filter((v) => v !== undefined).length % 3 === 0
      )
    },
    { message: 'Give exactly one target: x, y and z together, or looking_at, or nearest.' },
  )

export class RegisterContainerTool implements ToolDefinition<typeof registerSchema> {
  readonly name = 'register_container'
  readonly description =
    'Remembers a chest, barrel, or shulker box (a double chest is one container), optionally with a label. Point at it by ' +
    'coordinates, by "looking_at" (the chest the player looks at: ask them to look at it first), or by "nearest" to the bot. ' +
    'Registering a known one updates its label or protected flag. Saved per world. Fails when there is no container there.'
  readonly inputSchema = registerSchema

  constructor(
    private readonly index: ContainerIndex,
    private readonly rules: StorageRules,
    private readonly blocks: BlockScanner,
    private readonly look: LookTarget,
    private readonly owner: string | undefined,
  ) {}

  execute(input: z.output<typeof registerSchema>) {
    let found: { name: string; position: { x: number; y: number; z: number } } | undefined
    if (input.x !== undefined && input.y !== undefined && input.z !== undefined) {
      const name = this.blocks.blockAt({ x: input.x, y: input.y, z: input.z })
      if (name === undefined)
        return toolFail('That block is not loaded, so the bot cannot see what is there.')
      found = { name, position: { x: input.x, y: input.y, z: input.z } }
    } else if (input.looking_at === true) {
      if (this.owner === undefined)
        return toolFail('Nobody is set as the owner (MC_OWNER), so there is no player to look at.')
      const hit = this.look.blockLookedAt(this.owner)
      if (hit === undefined)
        return toolFail(
          `${this.owner} is not looking at any block within reach, or is out of the bot's view.`,
        )
      found = { name: hit.name, position: hit.position }
    } else {
      const names = [
        'chest',
        'trapped_chest',
        'barrel',
        ...this.blocks.knownBlockNames().filter((name) => name.endsWith('shulker_box')),
      ]
      const nearest = this.blocks.findBlocks({ names, maxDistance: NEAREST_RANGE, count: 1 })[0]
      if (nearest === undefined)
        return toolFail(
          `There is no chest, barrel, or shulker box within ${String(NEAREST_RANGE)} blocks.`,
        )
      found = { name: nearest.name, position: nearest.position }
    }
    if (!isContainerBlock(found.name)) return toolFail(`That is ${found.name}, not a container.`)

    const registered = this.index.register(found.position, found.name, {
      label: input.label,
      protected: input.protected,
    })
    return registered.ok
      ? toolOk({ container: view(registered.value, this.rules) })
      : toolFail(registered.error)
  }
}

const labelSchema = z.object({
  container: z.string().min(1).describe('The container id ("container-2") or its current label.'),
  label: z.string().max(40).optional().describe('The new label. An empty text removes the label.'),
  protected: z.boolean().optional().describe('Set or clear the protected flag.'),
})

export class LabelContainerTool implements ToolDefinition<typeof labelSchema> {
  readonly name = 'label_container'
  readonly description =
    'Renames a known container, or marks it protected (the bot never takes from it or puts into it) or not. Fails for an ' +
    'unknown container or a label that another container already has.'
  readonly inputSchema = labelSchema

  constructor(
    private readonly index: ContainerIndex,
    private readonly rules: StorageRules,
  ) {}

  execute(input: z.output<typeof labelSchema>) {
    const entry = this.index.resolve(input.container)
    if (entry === undefined)
      return toolFail(`There is no container "${input.container}". See list_containers.`)
    const amended = this.index.amend(entry.id, { label: input.label, protected: input.protected })
    return amended.ok
      ? toolOk({ container: view(amended.value, this.rules) })
      : toolFail(amended.error)
  }
}

const removeSchema = z.object({
  container: z.string().min(1).describe('The container id or label to forget.'),
})

export class RemoveContainerTool implements ToolDefinition<typeof removeSchema> {
  readonly name = 'remove_container'
  readonly description =
    'Makes the bot forget a container (the chest itself is not touched) together with its storage rules.'
  readonly inputSchema = removeSchema

  constructor(
    private readonly index: ContainerIndex,
    private readonly rules: StorageRules,
  ) {}

  execute(input: z.output<typeof removeSchema>) {
    const entry = this.index.resolve(input.container)
    if (entry === undefined)
      return toolFail(`There is no container "${input.container}". See list_containers.`)
    const removed = this.index.remove(entry.id)
    if (!removed.ok) return toolFail(removed.error)
    this.rules.removeForContainer(entry.id)
    return toolOk({ removed: entry.id })
  }
}

const listSchema = z.object({})

export class ListContainersTool implements ToolDefinition<typeof listSchema> {
  readonly name = 'list_containers'
  readonly description =
    'Lists the containers the bot remembers: id, label, position, whether protected, free slots, when it was last opened, ' +
    'and what was in it then (up to 40 stacks, biggest first). The contents are from the last time it was opened: use ' +
    'scan_containers to refresh them.'
  readonly inputSchema = listSchema

  constructor(
    private readonly index: ContainerIndex,
    private readonly rules: StorageRules,
  ) {}

  execute() {
    const list = this.index.list()
    if (!list.ok) return toolFail(list.error)
    return toolOk({
      count: list.value.length,
      containers: list.value.map((entry) => ({
        ...view(entry, this.rules),
        position: roundPosition(entry.position),
      })),
    })
  }
}
