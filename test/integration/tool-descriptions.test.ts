import { afterEach, describe, expect, it } from '@jest/globals'
import { createHarness, type Harness } from './support/app-harness.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.close().catch(() => undefined)
  harness = undefined
})

interface Schema {
  readonly properties?: Record<string, Schema>
  readonly description?: string
  readonly items?: Schema
  readonly anyOf?: readonly Schema[]
}

/** The paths of object properties (nested ones too) that have no description. */
function undescribed(schema: Schema, prefix = ''): string[] {
  const missing: string[] = []
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const path = `${prefix}${name}`
    const nested = property.items ?? property
    const hasDescription = (property.description ?? '').trim() !== ''
    // A plain coordinate or corner object is explained by the property that holds it.
    if (!hasDescription && property.properties === undefined && nested.properties === undefined)
      missing.push(path)
    if (property.properties !== undefined) missing.push(...undescribed(property, `${path}.`))
    else if (property.items?.properties !== undefined)
      missing.push(...undescribed(property.items, `${path}[].`))
  }
  return missing
}

describe('the tool surface as the agent sees it', () => {
  it('every tool has a description written for an agent, and every argument is explained', async () => {
    const h = await createHarness()
    harness = h

    const { tools } = await h.client.listTools()

    expect(tools.length).toBeGreaterThan(100)
    const problems: string[] = []
    for (const tool of tools) {
      const description = (tool.description ?? '').trim()
      if (!/^[a-z_]+$/.test(tool.name)) problems.push(`${tool.name}: the name is not snake_case`)
      if (description.length < 40) problems.push(`${tool.name}: the description is too short`)
      if (description.length > 2_600)
        problems.push(`${tool.name}: the description is over 2600 characters`)
      const missing = undescribed(tool.inputSchema)
      if (missing.length > 0)
        problems.push(`${tool.name}: no description for ${missing.join(', ')}`)
    }
    expect(problems).toEqual([])
  })
})
