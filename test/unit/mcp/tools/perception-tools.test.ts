import { describe, expect, it } from '@jest/globals'
import { FindBlocksTool } from '../../../../src/mcp/tools/find-blocks-tool.js'
import { GetInventoryTool } from '../../../../src/mcp/tools/get-inventory-tool.js'
import {
  GetNearbyEntitiesTool,
  MAX_LISTED_ENTITIES,
} from '../../../../src/mcp/tools/get-nearby-entities-tool.js'
import { GetPlayerPositionTool } from '../../../../src/mcp/tools/get-player-position-tool.js'
import { LookAroundTool } from '../../../../src/mcp/tools/look-around-tool.js'
import { BlockFinder } from '../../../../src/perception/block-finder.js'
import { SurroundingsDescriber } from '../../../../src/perception/surroundings.js'
import {
  FakeBlockScanner,
  FakeEntityScanner,
  FakeInventory,
  FakeVitals,
  buildVitals,
} from '../../../fakes/fake-ports.js'

const vitals = () => {
  const v = new FakeVitals()
  v.vitals = buildVitals({ timeOfDay: 0 })
  return v
}

describe('LookAroundTool', () => {
  it('describes the surroundings', () => {
    const tool = new LookAroundTool(
      new SurroundingsDescriber(new FakeBlockScanner(), new FakeEntityScanner(), vitals()),
    )

    expect(tool.execute({ radius: 8 })).toMatchObject({
      ok: true,
      data: { dimension: 'overworld', radius: 8 },
    })
  })

  it('fails when not connected', () => {
    const tool = new LookAroundTool(
      new SurroundingsDescriber(new FakeBlockScanner(), new FakeEntityScanner(), new FakeVitals()),
    )

    expect(tool.execute({ radius: 8 })).toEqual({
      ok: false,
      error: 'Not connected to a Minecraft world.',
    })
  })

  it('limits the radius', () => {
    const tool = new LookAroundTool(
      new SurroundingsDescriber(new FakeBlockScanner(), new FakeEntityScanner(), vitals()),
    )

    expect(tool.inputSchema.safeParse({ radius: 13 }).success).toBe(false)
    expect(tool.inputSchema.parse({})).toEqual({ radius: 8 })
  })
})

describe('FindBlocksTool', () => {
  it('lists blocks with rounded distances', () => {
    const scanner = new FakeBlockScanner()
    scanner.blocks = [{ name: 'oak_log', position: { x: 1, y: 64, z: 2 }, distance: 3.14159 }]

    const result = new FindBlocksTool(new BlockFinder(scanner)).execute({
      names: ['oak_log'],
      max_distance: 32,
      count: 10,
    })

    expect(result).toEqual({
      ok: true,
      data: {
        count: 1,
        blocks: [{ name: 'oak_log', position: { x: 1, y: 64, z: 2 }, distance: 3.1 }],
      },
    })
  })

  it('reports an empty result as success', () => {
    const result = new FindBlocksTool(new BlockFinder(new FakeBlockScanner())).execute({
      names: ['iron_ore'],
      max_distance: 32,
      count: 10,
    })

    expect(result).toEqual({ ok: true, data: { count: 0, blocks: [] } })
  })

  it('fails with suggestions for unknown names', () => {
    const scanner = new FakeBlockScanner()
    scanner.names = ['oak_log']

    const result = new FindBlocksTool(new BlockFinder(scanner)).execute({
      names: ['log'],
      max_distance: 32,
      count: 10,
    })

    expect(!result.ok && result.error).toContain('oak_log')
  })

  it('validates its arguments', () => {
    const tool = new FindBlocksTool(new BlockFinder(new FakeBlockScanner()))

    expect(tool.inputSchema.safeParse({ names: [] }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ names: ['stone'], count: 51 }).success).toBe(false)
    expect(tool.inputSchema.parse({ names: ['stone'] })).toEqual({
      names: ['stone'],
      max_distance: 32,
      count: 10,
    })
  })
})

describe('GetNearbyEntitiesTool', () => {
  const at = { x: 1.26, y: 64, z: 0 }

  it('lists entities with rounded positions and distances', () => {
    const entities = new FakeEntityScanner()
    entities.entities = [
      { id: 1, category: 'hostile', name: 'zombie', position: at, distance: 3.14 },
      { id: 2, category: 'animal', name: 'cow', position: at, distance: 5 },
    ]

    const result = new GetNearbyEntitiesTool(entities, vitals()).execute({ radius: 16 })

    expect(result).toEqual({
      ok: true,
      data: {
        total: 2,
        entities: [
          {
            id: 1,
            category: 'hostile',
            name: 'zombie',
            position: { x: 1.3, y: 64, z: 0 },
            distance: 3.1,
          },
          {
            id: 2,
            category: 'animal',
            name: 'cow',
            position: { x: 1.3, y: 64, z: 0 },
            distance: 5,
          },
        ],
      },
    })
  })

  it('filters by category and radius', () => {
    const entities = new FakeEntityScanner()
    entities.entities = [
      { id: 1, category: 'hostile', name: 'zombie', position: at, distance: 3 },
      { id: 2, category: 'animal', name: 'cow', position: at, distance: 5 },
      { id: 3, category: 'animal', name: 'pig', position: at, distance: 50 },
    ]
    const tool = new GetNearbyEntitiesTool(entities, vitals())

    expect(tool.execute({ radius: 16, category: 'animal' })).toMatchObject({
      data: { total: 1, entities: [{ name: 'cow' }] },
    })
  })

  it('caps the list but reports the total', () => {
    const entities = new FakeEntityScanner()
    entities.entities = Array.from({ length: MAX_LISTED_ENTITIES + 5 }, (_, i) => ({
      id: i,
      category: 'animal',
      name: 'cow',
      position: at,
      distance: i,
    }))

    const result = new GetNearbyEntitiesTool(entities, vitals()).execute({ radius: 64 })

    expect(result).toMatchObject({ ok: true, data: { total: MAX_LISTED_ENTITIES + 5 } })
    expect(result.ok && (result.data as { entities: unknown[] }).entities).toHaveLength(
      MAX_LISTED_ENTITIES,
    )
  })

  it('fails when not connected', () => {
    expect(
      new GetNearbyEntitiesTool(new FakeEntityScanner(), new FakeVitals()).execute({ radius: 16 }),
    ).toEqual({
      ok: false,
      error: 'Not connected to a Minecraft world.',
    })
  })
})

describe('GetPlayerPositionTool', () => {
  it('reports a visible player', () => {
    const entities = new FakeEntityScanner()
    entities.players.set('andrey_knight', {
      name: 'Andrey_Knight',
      online: true,
      position: { x: 1.26, y: 64, z: 3 },
      distance: 12.34,
    })

    const result = new GetPlayerPositionTool(entities, 'Andrey_Knight').execute({})

    expect(result).toEqual({
      ok: true,
      data: {
        player: 'Andrey_Knight',
        visible: true,
        position: { x: 1.3, y: 64, z: 3 },
        distance: 12.3,
      },
    })
  })

  it('reports an online player who is out of view', () => {
    const entities = new FakeEntityScanner()
    entities.players.set('alex', {
      name: 'Alex',
      online: true,
      position: undefined,
      distance: undefined,
    })

    expect(new GetPlayerPositionTool(entities, undefined).execute({ player: 'Alex' })).toEqual({
      ok: true,
      data: { player: 'Alex', visible: false, position: null, distance: null },
    })
  })

  it('fails for an unknown player, and when no player is given or configured', () => {
    const tool = new GetPlayerPositionTool(new FakeEntityScanner(), undefined)

    expect(tool.execute({ player: 'Nobody' })).toEqual({
      ok: false,
      error: 'Nobody is not online (or the bot is not connected).',
    })
    expect(tool.execute({})).toEqual({
      ok: false,
      error: 'Say which player: no owner is configured.',
    })
  })
})

describe('GetInventoryTool', () => {
  it('totals items across stacks, most first, with free slots and the held item', () => {
    const inventory = new FakeInventory()
    inventory.value = {
      stacks: [
        { name: 'stick', count: 4 },
        { name: 'cobblestone', count: 64 },
        { name: 'cobblestone', count: 20 },
        { name: 'apple', count: 4 },
      ],
      emptySlots: 32,
      heldItem: 'stick',
    }

    expect(new GetInventoryTool(inventory).execute()).toEqual({
      ok: true,
      data: {
        items: [
          { name: 'cobblestone', count: 84 },
          { name: 'apple', count: 4 },
          { name: 'stick', count: 4 },
        ],
        stacks: 4,
        emptySlots: 32,
        heldItem: 'stick',
      },
    })
  })

  it('reports an empty inventory with nothing in hand', () => {
    const inventory = new FakeInventory()
    inventory.value = { stacks: [], emptySlots: 36, heldItem: undefined }

    expect(new GetInventoryTool(inventory).execute()).toEqual({
      ok: true,
      data: { items: [], stacks: 0, emptySlots: 36, heldItem: null },
    })
  })

  it('fails when not connected', () => {
    expect(new GetInventoryTool(new FakeInventory()).execute()).toEqual({
      ok: false,
      error: 'Not connected to a Minecraft world.',
    })
  })
})
