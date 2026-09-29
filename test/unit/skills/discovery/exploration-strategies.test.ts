import { describe, expect, it } from '@jest/globals'
import {
  FrontierExplorer,
  spiralCell,
  SpiralExplorer,
  TowardExplorer,
  WAYPOINT_STEP,
} from '../../../../src/skills/discovery/exploration-strategies.js'
import type { ExplorationState } from '../../../../src/skills/discovery/exploration-strategy.types.js'
import { FakeRandom } from '../../../fakes/fake-random.js'

const at = (x: number, y: number, z: number) => ({ x, y, z })
const state = (patch: Partial<ExplorationState> = {}): ExplorationState => ({
  origin: at(0, 64, 0),
  current: at(0, 64, 0),
  visited: [at(0, 64, 0)],
  maxDistance: 200,
  ...patch,
})

describe('spiralCell', () => {
  it('starts at the centre and walks the first ring round it', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(spiralCell)).toEqual([
      { i: 0, j: 0 },
      { i: 1, j: 0 },
      { i: 1, j: 1 },
      { i: 0, j: 1 },
      { i: -1, j: 1 },
      { i: -1, j: 0 },
      { i: -1, j: -1 },
      { i: 0, j: -1 },
      { i: 1, j: -1 },
    ])
  })

  it('visits every cell of the first three rings exactly once', () => {
    const seen = new Set<string>()
    for (let n = 0; n < 49; n += 1) {
      const { i, j } = spiralCell(n)
      expect(Math.max(Math.abs(i), Math.abs(j))).toBeLessThanOrEqual(3)
      seen.add(`${String(i)},${String(j)}`)
    }
    expect(seen.size).toBe(49)
  })
})

describe('SpiralExplorer', () => {
  it('goes ring by ring around the start, at the step it was given', () => {
    const explorer = new SpiralExplorer(50)

    expect(explorer.nextWaypoint(state())).toEqual(at(50, 64, 0))
    expect(explorer.nextWaypoint(state())).toEqual(at(50, 64, 50))
    expect(explorer.nextWaypoint(state())).toEqual(at(0, 64, 50))
  })

  it('ends when the next ring is beyond the distance limit', () => {
    const explorer = new SpiralExplorer(50)
    const limit = state({ maxDistance: 60 })
    let count = 0
    while (explorer.nextWaypoint(limit) !== null) count += 1

    // Four sides at 50 blocks; the corners (70) are beyond the limit.
    expect(count).toBe(4)
  })

  it('measures from the start, wherever the bot is now', () => {
    const explorer = new SpiralExplorer(40)

    expect(
      explorer.nextWaypoint(state({ origin: at(100, 70, -100), current: at(0, 60, 0) })),
    ).toEqual(at(140, 60, -100))
  })
})

describe('FrontierExplorer', () => {
  it('heads for an unvisited cell next to the bot', () => {
    const next = new FrontierExplorer(new FakeRandom([0])).nextWaypoint(state())

    expect(next).not.toBeNull()
    expect(Math.hypot(next?.x ?? 0, next?.z ?? 0)).toBeLessThanOrEqual(WAYPOINT_STEP * 1.5)
    expect(next).not.toEqual(at(0, 64, 0))
  })

  it('never returns a cell that was visited, and covers the whole area without repeats', () => {
    const explorer = new FrontierExplorer(new FakeRandom([0.13, 0.71, 0.4, 0.93]), 50)
    const visited = [at(0, 64, 0)]
    let current = at(0, 64, 0)
    const cells = new Set<string>(['0,0'])

    for (let n = 0; n < 60; n += 1) {
      const next = explorer.nextWaypoint(state({ maxDistance: 100, visited, current }))
      if (next === null) break
      const key = `${String(next.x / 50)},${String(next.z / 50)}`
      expect(cells.has(key)).toBe(false)
      cells.add(key)
      visited.push(next)
      current = next
    }

    // Within 100 blocks of the start at a 50 block step: the 13 cells of the disc.
    expect(cells.size).toBe(13)
  })

  it('grows the searched area around the start instead of wandering off in one direction', () => {
    const explorer = new FrontierExplorer(new FakeRandom([0.13, 0.71, 0.4, 0.93]), 50)
    const visited = [at(0, 64, 0)]
    let current = at(0, 64, 0)

    for (let n = 0; n < 8; n += 1) {
      const next = explorer.nextWaypoint(state({ maxDistance: 300, visited, current }))
      if (next === null) throw new Error('The explorer ran out of cells.')
      expect(Math.max(Math.abs(next.x), Math.abs(next.z))).toBeLessThanOrEqual(100)
      visited.push(next)
      current = next
    }
  })

  it('stays inside the distance limit and returns null when everything is visited', () => {
    const explorer = new FrontierExplorer(new FakeRandom([0.5]), 50)
    const all = []
    for (let i = -2; i <= 2; i += 1)
      for (let j = -2; j <= 2; j += 1) all.push(at(i * 50, 64, j * 50))

    expect(explorer.nextWaypoint(state({ maxDistance: 100, visited: all }))).toBeNull()
  })

  it('is deterministic for a given random sequence', () => {
    const one = new FrontierExplorer(new FakeRandom([0.3, 0.6])).nextWaypoint(state())
    const two = new FrontierExplorer(new FakeRandom([0.3, 0.6])).nextWaypoint(state())

    expect(one).toEqual(two)
  })
})

describe('TowardExplorer', () => {
  it('hops towards the target in steps, and stops when close', () => {
    const explorer = new TowardExplorer(at(400, 64, 0), 40, 8)

    expect(explorer.nextWaypoint(state())).toEqual(at(40, 64, 0))
    expect(explorer.nextWaypoint(state({ current: at(380, 64, 0) }))).toEqual(at(400, 64, 0))
    expect(explorer.nextWaypoint(state({ current: at(395, 64, 3) }))).toBeNull()
  })

  it('goes diagonally when the target is', () => {
    const next = new TowardExplorer(at(300, 64, 400), 100).nextWaypoint(state())

    expect(next).toEqual(at(60, 64, 80))
  })
})
