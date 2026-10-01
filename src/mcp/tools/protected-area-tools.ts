import { z } from 'zod'
import type { ProtectedAreas } from '../../state/protected-areas.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolDefinition } from '../tool.types.js'

const cornerShape = {
  x1: z.number().describe('X of one corner of the box.'),
  y1: z.number().describe('Y (height) of one corner.'),
  z1: z.number().describe('Z of one corner.'),
  x2: z.number().describe('X of the opposite corner.'),
  y2: z.number().describe('Y of the opposite corner.'),
  z2: z.number().describe('Z of the opposite corner.'),
}

const protectSchema = z.object({
  label: z
    .string()
    .min(1)
    .describe('A name for the area, for example "my house" or "Andrey\'s farm".'),
  ...cornerShape,
})

export class ProtectAreaTool implements ToolDefinition<typeof protectSchema> {
  readonly name = 'protect_area'
  readonly description =
    'Marks the box between two opposite corners (both included) as protected: collect_block will never break blocks inside it. ' +
    'Use it for the player builds, farms, and anything else that must stay intact. Saved per world. Fails when no world is active.'
  readonly inputSchema = protectSchema

  constructor(private readonly areas: ProtectedAreas) {}

  execute(input: z.output<typeof protectSchema>) {
    const added = this.areas.add(
      input.label,
      { x: input.x1, y: input.y1, z: input.z1 },
      { x: input.x2, y: input.y2, z: input.z2 },
    )
    return added.ok ? toolOk({ area: added.value }) : toolFail(added.error)
  }
}

const unprotectSchema = z.object({
  id: z.string().min(1).describe('The area id, for example "area-2" (see list_protected_areas).'),
})

export class UnprotectAreaTool implements ToolDefinition<typeof unprotectSchema> {
  readonly name = 'unprotect_area'
  readonly description =
    'Removes a protected area, so the bot may dig there again. Only when the player asks.'
  readonly inputSchema = unprotectSchema

  constructor(private readonly areas: ProtectedAreas) {}

  execute(input: z.output<typeof unprotectSchema>) {
    const removed = this.areas.remove(input.id)
    return removed.ok ? toolOk({ removed: removed.value }) : toolFail(removed.error)
  }
}

const listSchema = z.object({})

export class ListProtectedAreasTool implements ToolDefinition<typeof listSchema> {
  readonly name = 'list_protected_areas'
  readonly description = 'Lists the areas where the bot never digs (id, label, corners).'
  readonly inputSchema = listSchema

  constructor(private readonly areas: ProtectedAreas) {}

  execute() {
    const list = this.areas.list()
    return list.ok ? toolOk({ count: list.value.length, areas: list.value }) : toolFail(list.error)
  }
}
