import { describe, expect, it } from '@jest/globals'
import {
  defaultSignatures,
  DesertTempleSignature,
  DungeonSignature,
  JungleTempleSignature,
  MineshaftSignature,
  PillagerOutpostSignature,
  RuinedPortalSignature,
  StrongholdSignature,
  VillageSignature,
} from '../../../../src/skills/discovery/structure-signatures.js'
import { StructureScanner } from '../../../../src/skills/discovery/structure-scanner.js'
import type { StructureSignature } from '../../../../src/skills/discovery/structure-signature.types.js'
import { DiscoveryWorld } from '../../../fakes/discovery-fakes.js'

const detect = (signature: StructureSignature, world: DiscoveryWorld, radius = 48) =>
  signature.detect({ blocks: world, entities: world, radius })

/** Puts the same block in `count` cells along a row. */
const row = (world: DiscoveryWorld, name: string, count: number, x = 10, z = 10) => {
  for (let i = 0; i < count; i += 1) world.put(x + i, 64, z, name)
  return world
}

describe('VillageSignature', () => {
  it('recognizes a bell with villagers around it', () => {
    const world = new DiscoveryWorld().put(20, 64, 5, 'bell').mob('villager', 22, 5)

    expect(detect(new VillageSignature(), world)).toMatchObject({
      kind: 'village',
      position: { x: 20, y: 64, z: 5 },
    })
  })

  it('recognizes a bell with a road, and a bell with hay', () => {
    expect(
      detect(
        new VillageSignature(),
        row(new DiscoveryWorld().put(0, 64, 5, 'bell'), 'dirt_path', 3),
      ),
    ).not.toBeNull()
    expect(
      detect(
        new VillageSignature(),
        new DiscoveryWorld().put(0, 64, 5, 'bell').put(3, 64, 3, 'hay_block'),
      ),
    ).not.toBeNull()
  })

  it('recognizes villagers with houses when the bell is out of view', () => {
    const world = new DiscoveryWorld()
      .mob('villager', 30, 0)
      .mob('villager', 32, 2)
      .put(28, 64, 0, 'hay_block')

    expect(detect(new VillageSignature(), world)).toMatchObject({ position: { x: 30 } })
  })

  it('counts doors of any village wood as houses', () => {
    const world = new DiscoveryWorld().mob('villager', 30, 0).mob('villager', 32, 2)
    world.put(20, 64, 0, 'spruce_door').put(24, 64, 0, 'acacia_door')

    expect(detect(new VillageSignature(), world)).not.toBeNull()
  })

  it('ignores a lone bell, one villager, and two villagers with nothing else', () => {
    expect(detect(new VillageSignature(), new DiscoveryWorld().put(20, 64, 5, 'bell'))).toBeNull()
    expect(detect(new VillageSignature(), new DiscoveryWorld().mob('villager', 5, 5))).toBeNull()
    expect(
      detect(
        new VillageSignature(),
        new DiscoveryWorld().mob('villager', 5, 5).mob('villager', 6, 6),
      ),
    ).toBeNull()
  })

  it('ignores what is beyond the radius', () => {
    const world = new DiscoveryWorld().put(100, 64, 5, 'bell').mob('villager', 100, 6)

    expect(detect(new VillageSignature(), world, 48)).toBeNull()
  })
})

describe('DesertTempleSignature', () => {
  it('recognizes chiseled sandstone over a TNT chamber', () => {
    const world = new DiscoveryWorld().put(30, 66, 30, 'chiseled_sandstone').put(30, 50, 30, 'tnt')

    expect(detect(new DesertTempleSignature(), world)).toMatchObject({
      kind: 'desert_temple',
      position: { x: 30, y: 66, z: 30 },
    })
  })

  it('recognizes the orange and blue terracotta floor without the chamber', () => {
    const world = new DiscoveryWorld()
      .put(30, 66, 30, 'chiseled_sandstone')
      .put(31, 64, 30, 'orange_terracotta')
      .put(32, 64, 30, 'blue_terracotta')

    expect(detect(new DesertTempleSignature(), world)).not.toBeNull()
  })

  it('ignores near misses: TNT alone, sandstone alone, one colour of terracotta', () => {
    expect(
      detect(new DesertTempleSignature(), new DiscoveryWorld().put(5, 60, 5, 'tnt')),
    ).toBeNull()
    expect(
      detect(new DesertTempleSignature(), new DiscoveryWorld().put(5, 64, 5, 'chiseled_sandstone')),
    ).toBeNull()
    expect(
      detect(
        new DesertTempleSignature(),
        new DiscoveryWorld().put(5, 64, 5, 'chiseled_sandstone').put(6, 64, 5, 'orange_terracotta'),
      ),
    ).toBeNull()
  })
})

describe('JungleTempleSignature', () => {
  it('recognizes a cluster of mossy cobblestone with a trap', () => {
    const world = row(new DiscoveryWorld(), 'mossy_cobblestone', 10).put(
      12,
      62,
      12,
      'tripwire_hook',
    )

    expect(detect(new JungleTempleSignature(), world)).toMatchObject({
      kind: 'jungle_temple',
      detail: 'mossy cobblestone with a tripwire hook',
    })
  })

  it('ignores a few mossy blocks, and a moss room with no trap', () => {
    expect(
      detect(
        new JungleTempleSignature(),
        row(new DiscoveryWorld(), 'mossy_cobblestone', 7).put(1, 62, 1, 'dispenser'),
      ),
    ).toBeNull()
    expect(
      detect(new JungleTempleSignature(), row(new DiscoveryWorld(), 'mossy_cobblestone', 12)),
    ).toBeNull()
  })
})

describe('PillagerOutpostSignature', () => {
  it('recognizes pillagers by dark oak towers', () => {
    const world = row(new DiscoveryWorld(), 'dark_oak_log', 4).mob('pillager', 12, 12)

    expect(detect(new PillagerOutpostSignature(), world)).toMatchObject({
      kind: 'pillager_outpost',
    })
  })

  it('ignores a pillager with no tower, and a tower with no pillager', () => {
    expect(
      detect(new PillagerOutpostSignature(), new DiscoveryWorld().mob('pillager', 5, 5)),
    ).toBeNull()
    expect(
      detect(new PillagerOutpostSignature(), row(new DiscoveryWorld(), 'dark_oak_log', 6)),
    ).toBeNull()
    expect(
      detect(
        new PillagerOutpostSignature(),
        row(new DiscoveryWorld(), 'dark_oak_log', 3).mob('pillager', 5, 5),
      ),
    ).toBeNull()
  })
})

describe('MineshaftSignature', () => {
  const frame = () => row(row(new DiscoveryWorld(), 'oak_fence', 2), 'oak_planks', 3, 10, 12)

  it.each([
    ['cobwebs', (w: DiscoveryWorld) => w.put(0, 40, 0, 'cobweb')],
    ['rails', (w: DiscoveryWorld) => row(w, 'rail', 2, 0, 20)],
  ])('recognizes fences and planks with %s', (_what, add) => {
    expect(detect(new MineshaftSignature(), add(frame()))).toMatchObject({ kind: 'mineshaft' })
  })

  it('recognizes fences and planks with a chest minecart', () => {
    expect(detect(new MineshaftSignature(), frame().mob('chest_minecart', 4, 4))).not.toBeNull()
  })

  it('ignores a fence and planks with nothing underground about them', () => {
    expect(detect(new MineshaftSignature(), frame())).toBeNull()
    expect(
      detect(
        new MineshaftSignature(),
        row(new DiscoveryWorld(), 'oak_fence', 2).put(0, 40, 0, 'cobweb'),
      ),
    ).toBeNull()
  })
})

describe('RuinedPortalSignature', () => {
  it('recognizes crying obsidian among netherrack, magma, or gold', () => {
    for (const around of ['netherrack', 'magma_block', 'gold_block']) {
      const world = new DiscoveryWorld().put(9, 64, 9, 'crying_obsidian').put(10, 64, 9, around)
      expect(detect(new RuinedPortalSignature(), world)).toMatchObject({ kind: 'ruined_portal' })
    }
  })

  it('ignores plain obsidian, crying obsidian alone, and a portal that works', () => {
    const portal = new DiscoveryWorld()
      .put(9, 64, 9, 'crying_obsidian')
      .put(10, 64, 9, 'netherrack')
      .put(11, 64, 9, 'nether_portal')
    expect(detect(new RuinedPortalSignature(), portal)).toBeNull()
    expect(
      detect(new RuinedPortalSignature(), new DiscoveryWorld().put(9, 64, 9, 'crying_obsidian')),
    ).toBeNull()
    expect(
      detect(
        new RuinedPortalSignature(),
        new DiscoveryWorld().put(9, 64, 9, 'obsidian').put(10, 64, 9, 'netherrack'),
      ),
    ).toBeNull()
  })
})

describe('DungeonSignature and StrongholdSignature', () => {
  it('recognizes a spawner in a mossy cobblestone room', () => {
    const world = row(new DiscoveryWorld(), 'mossy_cobblestone', 4).put(12, 40, 12, 'spawner')

    expect(detect(new DungeonSignature(), world)).toMatchObject({
      kind: 'dungeon',
      position: { x: 12, y: 40, z: 12 },
    })
  })

  it('ignores a spawner without the room, and a room without the spawner', () => {
    expect(detect(new DungeonSignature(), new DiscoveryWorld().put(1, 40, 1, 'spawner'))).toBeNull()
    expect(
      detect(new DungeonSignature(), row(new DiscoveryWorld(), 'mossy_cobblestone', 8)),
    ).toBeNull()
  })

  it('recognizes an end portal frame', () => {
    expect(
      detect(new StrongholdSignature(), new DiscoveryWorld().put(4, 20, 4, 'end_portal_frame')),
    ).toMatchObject({ kind: 'stronghold', position: { y: 20 } })
    expect(detect(new StrongholdSignature(), new DiscoveryWorld())).toBeNull()
  })
})

describe('StructureScanner', () => {
  it('runs every signature and reports each structure in view', () => {
    const world = new DiscoveryWorld()
      .put(4, 20, 4, 'end_portal_frame')
      .put(20, 64, 5, 'bell')
      .mob('villager', 22, 5)
    const scanner = new StructureScanner(world, world, defaultSignatures())

    expect(scanner.scan().map((hit) => hit.kind)).toEqual(['village', 'stronghold'])
  })

  it('can be limited to some kinds, and to a smaller radius', () => {
    const world = new DiscoveryWorld().put(4, 20, 4, 'end_portal_frame').put(40, 20, 4, 'spawner')
    const scanner = new StructureScanner(world, world, defaultSignatures())

    expect(scanner.scan(48, ['stronghold']).map((hit) => hit.kind)).toEqual(['stronghold'])
    expect(scanner.scan(2)).toEqual([])
  })
})
