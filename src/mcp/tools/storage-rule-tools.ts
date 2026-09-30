import { z } from 'zod'
import type { ItemFacts } from '../../core/item-facts.port.js'
import { ITEM_GROUP_NAMES, unknownSpecs } from '../../skills/storage/item-matcher.js'
import type { ContainerIndex } from '../../state/container-index.js'
import type { StorageRules } from '../../state/storage-rules.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolDefinition } from '../tool.types.js'

const groups = ITEM_GROUP_NAMES.map((name) => `"${name}"`).join(', ')

const setSchema = z.object({
  container: z.string().min(1).describe('The container id or label the items should go into.'),
  items: z
    .array(z.string().min(1))
    .min(1)
    .max(30)
    .describe(
      `What goes there: exact item names ("cobblestone") and/or groups (${groups}). "*" matches everything (a catch-all).`,
    ),
  priority: z
    .number()
    .int()
    .min(-100)
    .max(100)
    .default(0)
    .describe('Higher wins when several rules match an item. Give a catch-all a low priority.'),
})

export class SetStorageRuleTool implements ToolDefinition<typeof setSchema> {
  readonly name = 'set_storage_rule'
  readonly description =
    'Saves a rule "these kinds of items go into that container", for deposit_items and for offloading a full inventory. ' +
    'Example: stone and cobblestone into "stone", the group "ores" and "ingots" into "metal", "*" (priority -10) into ' +
    '"misc". The rule with the highest priority that matches an item wins; without a matching rule items go to any ' +
    'container with room. Saved per world. Fails for an unknown container or an item name that does not exist.'
  readonly inputSchema = setSchema

  constructor(
    private readonly index: ContainerIndex,
    private readonly rules: StorageRules,
    private readonly facts: ItemFacts,
  ) {}

  execute(input: z.output<typeof setSchema>) {
    const container = this.index.resolve(input.container)
    if (container === undefined)
      return toolFail(
        `There is no container "${input.container}". Register it first (register_container).`,
      )
    const unknown = unknownSpecs(input.items, this.facts)
    if (unknown.length > 0)
      return toolFail(`Not an item or group: ${unknown.join(', ')}. Groups: ${groups}.`)
    const added = this.rules.add(container.id, input.items, input.priority)
    return added.ok
      ? toolOk({ rule: added.value, container: container.label ?? container.id })
      : toolFail(added.error)
  }
}

const listSchema = z.object({})

export class ListStorageRulesTool implements ToolDefinition<typeof listSchema> {
  readonly name = 'list_storage_rules'
  readonly description =
    'Lists the storage rules (id, container, items or groups, priority), highest priority first.'
  readonly inputSchema = listSchema

  constructor(
    private readonly index: ContainerIndex,
    private readonly rules: StorageRules,
  ) {}

  execute() {
    const list = this.rules.list()
    if (!list.ok) return toolFail(list.error)
    return toolOk({
      count: list.value.length,
      rules: this.rules.ordered().map((rule) => ({
        ...rule,
        containerLabel: this.index.get(rule.containerId)?.label ?? null,
      })),
    })
  }
}

const removeSchema = z.object({
  rule: z.string().min(1).describe('The rule id, for example "rule-2".'),
})

export class RemoveStorageRuleTool implements ToolDefinition<typeof removeSchema> {
  readonly name = 'remove_storage_rule'
  readonly description =
    'Removes one storage rule by its id (see list_storage_rules); the containers and the items in them are not touched, ' +
    'only the instruction for where such items go. Fails when there is no rule with that id.'
  readonly inputSchema = removeSchema

  constructor(private readonly rules: StorageRules) {}

  execute(input: z.output<typeof removeSchema>) {
    const removed = this.rules.remove(input.rule)
    return removed.ok ? toolOk({ removed: removed.value }) : toolFail(removed.error)
  }
}
