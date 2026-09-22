import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import { MarkerFinder } from '../../../../src/skills/site-leveling/marker-finder.js'
import { FakeBlockScanner } from '../../../fakes/fake-ports.js'

/** Places a valid two-high marker stack of `name` at `base`, isolated on all sides, on solid ground. */
function placeMarker(blocks: FakeBlockScanner, base: Position, name: string): void {
  const key = (p: Position): string => `${String(p.x)},${String(p.y)},${String(p.z)}`
  blocks.blockNames.set(key(base), name)
  blocks.blockNames.set(key({ ...base, y: base.y + 1 }), name)
  blocks.solid.set(key({ ...base, y: base.y - 1 }), true) // solid ground below
  blocks.blocks.push({ name, position: base, distance: 0 })
}

describe('MarkerFinder', () => {
  it('finds a pair of two-high stacks, nearest first', () => {
    const blocks = new FakeBlockScanner()
    placeMarker(blocks, { x: 0, y: 63, z: 0 }, 'dirt')
    placeMarker(blocks, { x: 10, y: 63, z: 10 }, 'cobblestone')
    const finder = new MarkerFinder(blocks)

    const result = finder.find({ x: 0, y: 63, z: 0 })

    expect(result).toMatchObject({
      ok: true,
      a: { x: 0, y: 63, z: 0 },
      b: { x: 10, y: 63, z: 10 },
      extra: [],
    })
  })

  it('reports none found when nothing is placed', () => {
    const blocks = new FakeBlockScanner()
    const finder = new MarkerFinder(blocks)

    const result = finder.find({ x: 0, y: 63, z: 0 })

    expect(result).toMatchObject({ ok: false, found: [] })
  })

  it('reports only one found when a single stack exists', () => {
    const blocks = new FakeBlockScanner()
    placeMarker(blocks, { x: 0, y: 63, z: 0 }, 'dirt')
    const finder = new MarkerFinder(blocks)

    const result = finder.find({ x: 0, y: 63, z: 0 })

    expect(result).toMatchObject({ ok: false, found: [{ x: 0, y: 63, z: 0 }] })
  })

  it('ignores a stack that is only one block high', () => {
    const blocks = new FakeBlockScanner()
    placeMarker(blocks, { x: 0, y: 63, z: 0 }, 'dirt')
    placeMarker(blocks, { x: 10, y: 63, z: 10 }, 'dirt')
    // Knock the second stack down to one block: no dirt above it.
    blocks.blockNames.delete('10,64,10')
    const finder = new MarkerFinder(blocks)

    const result = finder.find({ x: 0, y: 63, z: 0 })

    expect(result).toMatchObject({ ok: false, found: [{ x: 0, y: 63, z: 0 }] })
  })

  it('ignores a stack attached to a wall (not open on all four sides)', () => {
    const blocks = new FakeBlockScanner()
    placeMarker(blocks, { x: 0, y: 63, z: 0 }, 'dirt')
    placeMarker(blocks, { x: 10, y: 63, z: 10 }, 'dirt')
    // A solid wall right beside the second stack.
    blocks.solid.set('11,63,10', true)
    const finder = new MarkerFinder(blocks)

    const result = finder.find({ x: 0, y: 63, z: 0 })

    expect(result).toMatchObject({ ok: false, found: [{ x: 0, y: 63, z: 0 }] })
  })

  it('takes the two nearest when more than two are found, and names the rest as extra', () => {
    const blocks = new FakeBlockScanner()
    placeMarker(blocks, { x: 0, y: 63, z: 0 }, 'dirt')
    placeMarker(blocks, { x: 5, y: 63, z: 0 }, 'dirt')
    placeMarker(blocks, { x: 40, y: 63, z: 0 }, 'dirt')
    blocks.blocks.forEach((b, i) => {
      // Distances from a player near the first two.
      ;(blocks.blocks[i] as { distance: number }).distance = Math.abs(b.position.x)
    })
    const finder = new MarkerFinder(blocks)

    const result = finder.find({ x: 0, y: 63, z: 0 })

    expect(result).toMatchObject({
      ok: true,
      a: { x: 0, y: 63, z: 0 },
      b: { x: 5, y: 63, z: 0 },
      extra: [{ x: 40, y: 63, z: 0 }],
    })
  })

  it('only accepts the named marker block when marker_block narrows it', () => {
    const blocks = new FakeBlockScanner()
    placeMarker(blocks, { x: 0, y: 63, z: 0 }, 'dirt')
    placeMarker(blocks, { x: 10, y: 63, z: 10 }, 'cobblestone')
    const finder = new MarkerFinder(blocks)

    const result = finder.find({ x: 0, y: 63, z: 0 }, { markerBlocks: ['dirt'] })

    expect(result).toMatchObject({ ok: false, found: [{ x: 0, y: 63, z: 0 }] })
  })
})
