import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import { SwitchFinder } from '../../../../src/skills/movement/switch-finder.js'
import { FakeBlockScanner } from '../../../fakes/fake-ports.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })

function setup() {
  const blocks = new FakeBlockScanner()
  blocks.names = ['lever', 'stone_button', 'oak_pressure_plate', 'stone']
  return { blocks, finder: new SwitchFinder(blocks) }
}

describe('SwitchFinder', () => {
  it('finds a lever, a button, and a plate, nearest first', () => {
    const s = setup()
    const target = at(0, 64, 0)
    s.blocks.blocks = [
      { name: 'stone_button', position: at(2, 64, 0), distance: 2 },
      { name: 'lever', position: at(1, 64, 0), distance: 1 },
      { name: 'oak_pressure_plate', position: at(0, 64, 1), distance: 1 },
    ]

    const found = s.finder.near(target)

    expect(found.map((c) => c.kind)).toEqual(expect.arrayContaining(['lever', 'button', 'plate']))
    expect(found[0]?.distance).toBeLessThanOrEqual(found[1]?.distance ?? Infinity)
    expect(found[1]?.distance).toBeLessThanOrEqual(found[2]?.distance ?? Infinity)
  })

  it('ignores a switch farther than the radius from the searched position', () => {
    const s = setup()
    const target = at(0, 64, 0)
    s.blocks.blocks = [
      { name: 'lever', position: at(1, 64, 0), distance: 1 }, // within radius
      { name: 'stone_button', position: at(20, 64, 0), distance: 20 }, // far away
    ]

    const found = s.finder.near(target, 4)

    expect(found).toHaveLength(1)
    expect(found[0]?.kind).toBe('lever')
  })

  it('ignores blocks that are not switches', () => {
    const s = setup()
    const target = at(0, 64, 0)
    s.blocks.blocks = [{ name: 'stone', position: at(1, 64, 0), distance: 1 }]

    expect(s.finder.near(target)).toEqual([])
  })

  it('returns nothing when the game does not know any switch block names', () => {
    const s = setup()
    s.blocks.names = ['stone', 'dirt']

    expect(s.finder.near(at(0, 64, 0))).toEqual([])
  })
})
