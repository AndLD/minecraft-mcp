import { beforeEach, describe, expect, it } from '@jest/globals'
import { HazardRule } from '../../../../../src/skills/construction/hazard-rule.js'
import type { SeenFind } from '../../../../../src/skills/discovery/caves/find-rules.js'
import { VeinMiner } from '../../../../../src/skills/discovery/caves/vein-miner.js'
import { CaveWorld } from '../../../../fakes/cave-fakes.js'

const at = (x: number, y: number, z: number) => ({ x, y, z })
const signal = new AbortController().signal

describe('VeinMiner', () => {
  let world: CaveWorld
  let miner: VeinMiner

  const vein = (...cells: ReturnType<typeof at>[]): SeenFind => ({
    kind: 'ore',
    name: 'diamond_ore',
    position: cells[0] ?? at(0, 0, 0),
    count: cells.length,
    cells,
  })

  beforeEach(() => {
    world = new CaveWorld().carve(at(0, 60, 0), at(10, 61, 0))
    for (const z of [1, 2, 3]) world.setBlock(at(4, 60, z), 'diamond_ore')
    miner = new VeinMiner({
      navigator: world,
      digger: world,
      blocks: world,
      hazards: new HazardRule(world),
      areas: world,
    })
  })

  it('digs the whole vein, including blocks joined to the ones that were seen', async () => {
    const outcome = await miner.mine(vein(at(4, 60, 1)), at(0, 60, 0), signal)

    expect(outcome).toEqual({ kind: 'mined', count: 3 })
    expect(world.nameAt(at(4, 60, 3))).toBe('air')
    expect(world.carried.get('diamond_ore')).toBe(3)
  })

  it('leaves a vein beside lava or water alone', async () => {
    world.setBlock(at(5, 60, 2), 'lava')

    expect(await miner.mine(vein(at(4, 60, 1)), at(0, 60, 0), signal)).toEqual({
      kind: 'skipped',
      reason: 'hazard',
      count: 0,
    })
    expect(world.nameAt(at(4, 60, 1))).toBe('diamond_ore')
  })

  it('leaves a vein in a protected area alone', async () => {
    world.protectedBoxes.push({ label: 'base', contains: (p) => p.x === 4 })

    expect(await miner.mine(vein(at(4, 60, 1)), at(0, 60, 0), signal)).toMatchObject({
      kind: 'skipped',
      reason: 'protected',
    })
  })

  it('reports when the tool is missing', async () => {
    world.needsTool.set('diamond_ore', 'iron_pickaxe')
    world.hasTool = false

    expect(await miner.mine(vein(at(4, 60, 1)), at(0, 60, 0), signal)).toMatchObject({
      kind: 'skipped',
      reason: 'no_tool',
    })
  })

  it('skips a block with gravel above it, and blocks that are gone', async () => {
    world.setBlock(at(4, 61, 2), 'gravel')
    world.setBlock(at(4, 60, 3), 'air')

    const outcome = await miner.mine(
      vein(at(4, 60, 1), at(4, 60, 2), at(4, 60, 3)),
      at(0, 60, 0),
      signal,
    )

    expect(outcome).toEqual({ kind: 'mined', count: 1 })
  })

  it('goes on past a block it cannot reach, and stops when cancelled', async () => {
    world.navFailures = [{ reason: 'unreachable', message: 'no path' }]
    expect(await miner.mine(vein(at(4, 60, 1)), at(0, 60, 0), signal)).toEqual({
      kind: 'mined',
      count: 2,
    })

    const controller = new AbortController()
    controller.abort()
    expect(await miner.mine(vein(at(4, 60, 2)), at(0, 60, 0), controller.signal)).toMatchObject({
      kind: 'skipped',
      reason: 'aborted',
    })
  })

  it('has nothing to do for an empty vein', async () => {
    expect(await miner.mine(vein(), at(0, 60, 0), signal)).toEqual({ kind: 'mined', count: 0 })
  })
})
