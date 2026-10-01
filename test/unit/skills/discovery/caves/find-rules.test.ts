import { describe, expect, it } from '@jest/globals'
import {
  FindDetector,
  resolveFind,
  VALUABLE_BLOCKS,
} from '../../../../../src/skills/discovery/caves/find-rules.js'
import { CaveWorld } from '../../../../fakes/cave-fakes.js'

const at = (x: number, y: number, z: number) => ({ x, y, z })
const known = new CaveWorld().knownBlockNames()

describe('resolveFind', () => {
  it('defaults to the valuable ores the game has', () => {
    const wish = resolveFind(undefined, known)

    expect(wish).toMatchObject({ ok: true })
    expect(wish.ok && wish.blocks).toEqual(['diamond_ore', 'deepslate_diamond_ore', 'gold_ore'])
    expect(VALUABLE_BLOCKS).toContain('ancient_debris')
    expect(resolveFind([], known)).toEqual(resolveFind(undefined, known))
  })

  it('adds the deepslate kind of a named ore', () => {
    const wish = resolveFind(['Iron Ore'], known)

    expect(wish.ok && wish.blocks).toEqual(['iron_ore', 'deepslate_iron_ore'])
  })

  it('covers every ore with "ores", and the defaults with "valuables"', () => {
    const ores = resolveFind(['ores'], known)
    const valuable = resolveFind(['valuables', 'coal_ore'], known)

    expect(ores.ok && ores.blocks).toEqual(
      expect.arrayContaining(['coal_ore', 'iron_ore', 'gold_ore']),
    )
    expect(ores.ok && ores.blocks).not.toContain('stone')
    expect(valuable.ok && valuable.blocks).toEqual(
      expect.arrayContaining(['diamond_ore', 'coal_ore', 'deepslate_coal_ore'].slice(0, 2)),
    )
  })

  it('names blocks that do not exist, with suggestions', () => {
    const wish = resolveFind(['diamnd'], known)

    expect(wish).toMatchObject({ ok: false, message: expect.stringContaining('diamnd') })
  })
})

describe('FindDetector', () => {
  const cave = () => {
    const world = new CaveWorld().carve(at(0, 60, 0), at(10, 61, 0))
    world.bot = at(0, 60, 0)
    return world
  }

  it('reports an ore in the cave wall, and not one buried in rock', () => {
    const world = cave()
    world.setBlock(at(5, 60, 1), 'diamond_ore') // beside the corridor: it has an open face
    world.setBlock(at(5, 60, 5), 'diamond_ore') // in solid rock
    const seen = new FindDetector(world).detect(24, ['diamond_ore'])

    expect(seen).toMatchObject([
      { kind: 'ore', name: 'diamond_ore', position: at(5, 60, 1), count: 1 },
    ])
  })

  it('joins touching blocks into one vein and keeps separate veins apart', () => {
    const world = cave()
    for (const z of [1, 2, 3]) world.setBlock(at(2, 60, z), 'diamond_ore')
    world.setBlock(at(2, 61, 1), 'diamond_ore')
    world.setBlock(at(9, 60, 1), 'diamond_ore')
    world.bot = at(0, 60, 0)

    const seen = new FindDetector(world).detect(24, ['diamond_ore'])

    expect(seen.map((find) => find.count)).toEqual([2, 1]) // the blocks buried behind the wall are not in view
    expect(seen[0]?.cells).toHaveLength(2)
  })

  it('always reports spawners and geodes, even with nothing to find', () => {
    const world = cave()
    world.setBlock(at(6, 60, 1), 'spawner')
    world.setBlock(at(8, 61, 1), 'budding_amethyst')

    const seen = new FindDetector(world).detect(24, [])

    expect(seen.map((find) => find.kind)).toEqual(['spawner', 'geode'])
  })

  it('ignores what is out of range', () => {
    const world = cave()
    world.setBlock(at(9, 60, 1), 'diamond_ore')

    expect(new FindDetector(world).detect(3, ['diamond_ore'])).toEqual([])
  })
})
