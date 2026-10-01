import { describe, expect, it } from '@jest/globals'
import type { LookFace, LookTarget } from '../../../../src/core/container.port.js'
import type { Position } from '../../../../src/core/position.types.js'
import { WallTarget } from '../../../../src/skills/excavation/wall-target.js'
import { FakeBlockScanner, FakeEntityScanner } from '../../../fakes/fake-ports.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })

function setup(hit: { name: string; position: Position; face: LookFace } | undefined) {
  const look: LookTarget = { blockLookedAt: () => hit }
  const blocks = new FakeBlockScanner()
  const entities = new FakeEntityScanner()
  return { look, blocks, entities, target: new WallTarget(look, blocks, entities) }
}

describe('WallTarget', () => {
  it('digs opposite the face hit: a look at each horizontal face gives the direction into the wall', () => {
    const cases: [LookFace, string][] = [
      ['north', 'south'],
      ['south', 'north'],
      ['east', 'west'],
      ['west', 'east'],
    ]
    for (const [face, direction] of cases) {
      const s = setup({ name: 'stone', position: at(5, 65, 5), face })
      s.blocks.solid.set('5,63,5', true) // solid ground at the hit column, so the floor resolves at all

      const result = s.target.resolve({ player: 'Andrey_Knight' })

      expect(result).toMatchObject({ ok: true, direction })
    }
  })

  it('refuses the floor or the ceiling: not a wall', () => {
    const s = setup({ name: 'stone', position: at(5, 65, 5), face: 'top' })

    const result = s.target.resolve({ player: 'Andrey_Knight' })

    expect(result).toEqual({
      ok: false,
      reason: 'not_a_wall',
      message: expect.stringContaining('top') as unknown as string,
    })
  })

  it('reports no_target when nobody is looking at anything', () => {
    const s = setup(undefined)

    const result = s.target.resolve({ player: 'Andrey_Knight' })

    expect(result).toEqual({
      ok: false,
      reason: 'no_target',
      message: expect.stringContaining('Andrey_Knight') as unknown as string,
    })
  })

  it('finds the walkable floor in the column in front of the wall, at the hit column', () => {
    const s = setup({ name: 'stone', position: at(5, 70, 5), face: 'north' })
    // "In front of the wall" for a north-face hit (digging south) is z - 1 = 4: solid ground at y = 63.
    s.blocks.solid.set('5,63,4', true)

    const result = s.target.resolve({ player: 'Andrey_Knight' })

    expect(result).toEqual({ ok: true, origin: at(5, 64, 5), direction: 'south' })
  })

  it("falls back to the player's own standing level when no floor is found in range", () => {
    const s = setup({ name: 'stone', position: at(5, 70, 5), face: 'north' })
    // No solid ground anywhere near the hit column.
    s.entities.players.set('andrey_knight', {
      name: 'Andrey_Knight',
      online: true,
      position: at(4.5, 61.9, 4.5),
      distance: 1,
    })

    const result = s.target.resolve({ player: 'Andrey_Knight' })

    expect(result).toEqual({ ok: true, origin: at(5, 61, 5), direction: 'south' })
  })

  it('skips the look entirely when both at and direction are given explicitly', () => {
    const s = setup(undefined) // nobody is looking at anything
    // direction: "east" digs with forward = (1,0,0); "in front" (outside) is x - 1 = 7.
    s.blocks.solid.set('7,63,8', true)

    const result = s.target.resolve({ player: 'Andrey_Knight', at: at(8, 65, 8), direction: 'east' })

    expect(result).toEqual({ ok: true, origin: at(8, 64, 8), direction: 'east' })
  })

  it('an explicit direction overrides the one the face would give, at is still read from the look', () => {
    const s = setup({ name: 'stone', position: at(2, 65, 2), face: 'north' })
    // direction: "west" digs with forward = (-1,0,0); "in front" (outside) is x + 1 = 3.
    s.blocks.solid.set('3,63,2', true)

    const result = s.target.resolve({ player: 'Andrey_Knight', direction: 'west' })

    // origin.x/z come from the look (2, 2); only the direction (and so the floor search side) is overridden.
    expect(result).toEqual({ ok: true, direction: 'west', origin: at(2, 64, 2) })
  })
})
