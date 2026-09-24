import { describe, expect, it } from '@jest/globals'
import { searchPath, type Col, type SearchOptions } from '../../../../src/skills/railway/path-search.js'

const bounds = { minX: -10, maxX: 20, minZ: -10, maxZ: 20 }

const options = (over: Partial<SearchOptions> = {}): SearchOptions => ({
  start: { x: 0, z: 0 },
  end: { x: 5, z: 0 },
  bounds,
  maxExpansions: 100_000,
  step: (_from, _to, turned) => 1 + (turned ? 4 : 0),
  ...over,
})

const turns = (path: readonly Col[]): number => {
  let count = 0
  for (let i = 2; i < path.length; i += 1) {
    const a = path[i - 2] as Col
    const b = path[i - 1] as Col
    const c = path[i] as Col
    if (b.x - a.x !== c.x - b.x || b.z - a.z !== c.z - b.z) count += 1
  }
  return count
}

describe('searchPath', () => {
  it('goes straight when nothing is in the way', () => {
    const path = searchPath(options())

    expect(path).toHaveLength(6)
    expect(path?.every((col) => col.z === 0)).toBe(true)
  })

  it('prefers few turns over a staircase of them', () => {
    const path = searchPath(options({ end: { x: 8, z: 6 } }))

    expect(path).toHaveLength(15)
    expect(turns(path ?? [])).toBe(1)
  })

  it('goes around what may not be entered', () => {
    const wall = (col: Col): boolean => col.x === 3 && col.z >= -3 && col.z <= 3
    const path = searchPath(options({ step: (_from, to) => (wall(to) ? undefined : 1) }))

    expect(path?.some(wall)).toBe(false)
    expect(path?.[path.length - 1]).toEqual({ x: 5, z: 0 })
  })

  it('stays inside its bounds', () => {
    const path = searchPath(options({ bounds: { minX: 0, maxX: 5, minZ: 0, maxZ: 0 } }))

    expect(path).toHaveLength(6)
    expect(
      searchPath(
        options({
          bounds: { minX: 0, maxX: 5, minZ: 0, maxZ: 0 },
          step: (_from, to) => (to.x === 3 ? undefined : 1),
        }),
      ),
    ).toBeUndefined()
  })

  it('gives up when there is no way, and when it would take too many steps', () => {
    expect(searchPath(options({ step: (_from, to) => (to.x === 5 ? undefined : 1) }))).toBeUndefined()
    expect(searchPath(options({ end: { x: 20, z: 20 }, maxExpansions: 5 }))).toBeUndefined()
  })

  it('is the one column when the start is the end', () => {
    expect(searchPath(options({ end: { x: 0, z: 0 } }))).toEqual([{ x: 0, z: 0 }])
  })

  it('takes the cheaper way even when it is longer', () => {
    // Column z = 0 is costly to enter; the way round through z = 1 costs less.
    const path = searchPath(
      options({
        end: { x: 6, z: 0 },
        step: (_from, to, turned) => 1 + (turned ? 0.1 : 0) + (to.z === 0 && to.x > 0 && to.x < 6 ? 10 : 0),
      }),
    )

    expect(path?.some((col) => col.z !== 0)).toBe(true)
  })
})
