import { describe, expect, it } from '@jest/globals'
import type { BiomeRule } from '../../../../src/knowledge/structure-biomes/structure-biome-table.types.js'
import { BiomeGuidedExplorer } from '../../../../src/skills/discovery/biome-guided-explorer.js'
import type { ExplorationState } from '../../../../src/skills/discovery/exploration-strategy.types.js'
import { DiscoveryWorld, GROUND } from '../../../fakes/discovery-fakes.js'
import { FakeRandom } from '../../../fakes/fake-random.js'

const ORIGIN = { x: 0, y: GROUND + 1, z: 0 }
const state = (over: Partial<ExplorationState> = {}): ExplorationState => ({
  origin: ORIGIN,
  current: ORIGIN,
  visited: [ORIGIN],
  maxDistance: 500,
  ...over,
})
const RULE: BiomeRule = { biomes: ['desert'], neighbours: ['badlands'], never: ['ocean'] }
const world = (): DiscoveryWorld => {
  const w = new DiscoveryWorld()
  w.biomeNames = ['plains', 'desert', 'badlands', 'forest', 'ocean']
  return w
}
const explorer = (w: DiscoveryWorld, rule: BiomeRule = RULE) =>
  new BiomeGuidedExplorer(w, rule, new FakeRandom([0.3]))

describe('BiomeGuidedExplorer', () => {
  it('heads for a matching biome in view, even far from the ground it has visited', () => {
    const w = world().biome('desert', 90, -30, 130, 30)

    const next = explorer(w).nextWaypoint(state())

    expect(next).not.toBeNull()
    expect(w.biomeAt(next ?? ORIGIN)).toBe('desert')
    expect(next?.x).toBeGreaterThanOrEqual(80)
  })

  it('prefers a biome that borders a matching one when no match is in view', () => {
    const w = world().biome('badlands', -60, 30, -20, 50)

    const next = explorer(w).nextWaypoint(state())

    expect(w.biomeAt(next ?? ORIGIN)).toBe('badlands')
  })

  it('prefers a biome unlike the current one to more of the same', () => {
    const w = world().biome('forest', -50, -50, 50, -35)

    const next = explorer(w).nextWaypoint(state())

    expect(w.biomeAt(next ?? ORIGIN)).toBe('forest')
  })

  it('never goes into a biome the structure cannot be in', () => {
    const w = world().biome('plains', 30, -20, 60, 20).biome('ocean', -400, -400, 400, 400)

    const next = explorer(w).nextWaypoint(state())

    expect(w.biomeAt(next ?? ORIGIN)).not.toBe('ocean')
  })

  it('falls back to the frontier search when every place is one it must not search', () => {
    const w = world().biome('ocean', -1000, -1000, 1000, 1000)

    const next = explorer(w).nextWaypoint(state())

    expect(next).not.toBeNull()
  })

  it('stays inside the distance limit', () => {
    const w = world().biome('desert', 300, -30, 400, 30)

    for (let n = 0; n < 5; n += 1) {
      const next = explorer(w).nextWaypoint(state({ maxDistance: 120 }))
      expect(Math.hypot((next?.x ?? 0) - ORIGIN.x, (next?.z ?? 0) - ORIGIN.z)).toBeLessThanOrEqual(
        120,
      )
    }
  })

  it('does not go back to ground it has already visited', () => {
    const w = world().biome('desert', 90, -30, 130, 30)
    const visited = [ORIGIN, { x: 120, y: ORIGIN.y, z: 0 }, { x: 120, y: ORIGIN.y, z: 40 }]

    const next = explorer(w).nextWaypoint(state({ visited, current: visited[2] ?? ORIGIN }))

    expect(next).not.toBeNull()
    expect(visited.some((v) => v.x === next?.x && v.z === next.z)).toBe(false)
  })

  it('returns null when nothing is left within the limit', () => {
    const w = world()
    const visited = []
    for (let i = -1; i <= 1; i += 1)
      for (let j = -1; j <= 1; j += 1) visited.push({ x: i * 40, y: ORIGIN.y, z: j * 40 })

    expect(explorer(w).nextWaypoint(state({ maxDistance: 40, visited }))).toBeNull()
  })
})
