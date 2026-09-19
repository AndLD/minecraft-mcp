import { z } from 'zod'
import type { InventoryReader } from '../../core/inventory.port.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolDefinition } from '../tool.types.js'

const schema = z.object({})

export class GetInventoryTool implements ToolDefinition<typeof schema> {
  readonly name = 'get_inventory'
  readonly description =
    'Lists what the bot carries: total count per item (across stacks), the number of free slots (of 36), and the item ' +
    'in hand. Fails when not connected.'
  readonly inputSchema = schema

  constructor(private readonly inventory: InventoryReader) {}

  execute() {
    const snapshot = this.inventory.snapshot()
    if (snapshot === undefined) return toolFail('Not connected to a Minecraft world.')

    const totals = new Map<string, number>()
    for (const stack of snapshot.stacks)
      totals.set(stack.name, (totals.get(stack.name) ?? 0) + stack.count)
    const items = [...totals.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    return toolOk({
      items,
      stacks: snapshot.stacks.length,
      emptySlots: snapshot.emptySlots,
      heldItem: snapshot.heldItem ?? null,
    })
  }
}
