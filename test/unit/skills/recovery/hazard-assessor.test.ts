import { describe, expect, it } from '@jest/globals'
import { HazardAssessor } from '../../../../src/skills/recovery/hazard-assessor.js'
import { FakeBlockScanner, FakeEntityScanner } from '../../../fakes/fake-ports.js'

const SPOT = { x: 10.5, y: 64, z: 10.5 }
const key = (x: number, y: number, z: number): string => `${String(x)},${String(y)},${String(z)}`

function setup() {
  const blocks = new FakeBlockScanner()
  const entities = new FakeEntityScanner()
  // Solid ground under the spot, so only what a test adds counts.
  for (let dy = 1; dy <= 24; dy += 1) blocks.solid.set(key(10, 64 - dy, 10), true)
  return { blocks, entities, assessor: new HazardAssessor(blocks, entities) }
}

describe('HazardAssessor', () => {
  it('reports nothing on plain ground', () => {
    expect(setup().assessor.assess(SPOT)).toEqual([])
  })

  it.each(['lava', 'fire', 'cactus', 'magma block'])('names %s near the spot', (name) => {
    const { blocks, assessor } = setup()
    blocks.blockNames.set(key(11, 64, 12), name.replace(' ', '_'))

    expect(assessor.assess(SPOT)).toEqual([`${name} within 2 blocks`])
  })

  it('ignores harmful blocks further than two blocks away', () => {
    const { blocks, assessor } = setup()
    blocks.blockNames.set(key(14, 64, 10), 'lava')

    expect(assessor.assess(SPOT)).toEqual([])
  })

  it('reports deep water but not a puddle', () => {
    const { blocks, assessor } = setup()
    blocks.blockNames.set(key(10, 64, 10), 'water')
    expect(assessor.assess(SPOT)).toEqual([])

    blocks.blockNames.set(key(10, 65, 10), 'water')
    blocks.blockNames.set(key(10, 63, 10), 'water')
    expect(assessor.assess(SPOT)).toEqual(['deep water'])
  })

  it('reports a missing floor, but not one it cannot see', () => {
    const { blocks, assessor } = setup()
    for (let dy = 1; dy <= 24; dy += 1) blocks.solid.set(key(10, 64 - dy, 10), false)
    expect(assessor.assess(SPOT)).toEqual(['no ground below (the void or a long fall)'])

    blocks.solid.delete(key(10, 50, 10)) // not loaded
    expect(assessor.assess(SPOT)).toEqual([])
  })

  it('counts hostile mobs near the spot, and not endermen or far ones', () => {
    const { entities, assessor } = setup()
    const mob = (name: string, x: number, category = 'hostile') => ({
      id: 1,
      category,
      name,
      position: { x, y: 64, z: 10 },
      distance: 5,
    })
    entities.entities = [
      mob('zombie', 12),
      mob('zombie', 13),
      mob('creeper', 9),
      mob('enderman', 11),
      mob('skeleton', 60),
      mob('cow', 10, 'animal'),
    ]

    expect(assessor.assess(SPOT)).toEqual(['hostile mobs: 2 zombie, 1 creeper'])
  })
})
