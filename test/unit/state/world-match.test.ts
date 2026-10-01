import { describe, expect, it } from '@jest/globals'
import type { WorldFingerprint } from '../../../src/core/world-identifier.port.js'
import { hasUsableSignals, MATCH_THRESHOLD, matchScore } from '../../../src/state/world-match.js'

const spawn = { x: 48.5, y: 81, z: 32.2 }
const fp = (overrides: Partial<WorldFingerprint> = {}): WorldFingerprint => ({
  seed: 'abc',
  worldName: 'Survival',
  spawn,
  ...overrides,
})

describe('matchScore', () => {
  it('is certainly different when the seeds differ, whatever else matches', () => {
    expect(matchScore(fp(), fp({ seed: 'xyz' }))).toBeUndefined()
  })

  it('scores a matching seed as enough on its own', () => {
    expect(
      matchScore(
        fp({ worldName: null, spawn: null }),
        fp({ worldName: 'Other', spawn: { x: 1, y: 2, z: 3 } }),
      ),
    ).toBeGreaterThanOrEqual(MATCH_THRESHOLD)
  })

  it('adds a point for the same spawn block and one for the same world name (ignoring case)', () => {
    expect(
      matchScore(fp(), fp({ worldName: 'SURVIVAL', spawn: { x: 48.9, y: 81.4, z: 32.9 } })),
    ).toBe(4)
    expect(matchScore(fp(), fp({ worldName: 'Other', spawn: { x: 48, y: 81, z: 32 } }))).toBe(3)
    expect(matchScore(fp(), fp({ worldName: 'Other', spawn: { x: 0, y: 0, z: 0 } }))).toBe(2)
  })

  it('without seeds, name and spawn together are enough, either alone is not', () => {
    const noSeed = { seed: null }

    expect(matchScore(fp(noSeed), fp(noSeed))).toBe(2)
    expect(matchScore(fp({ ...noSeed, spawn: null }), fp(noSeed))).toBe(1)
    expect(matchScore(fp({ ...noSeed, worldName: null }), fp(noSeed))).toBe(1)
  })

  it('scores nothing when only one side has a seed and nothing else matches', () => {
    expect(
      matchScore(
        fp({ worldName: null, spawn: null }),
        fp({ seed: null, worldName: 'x', spawn: null }),
      ),
    ).toBe(0)
  })

  it('treats missing signals as unknown, not as a mismatch', () => {
    expect(matchScore(fp(), fp({ seed: null, worldName: null, spawn: null }))).toBe(0)
  })
})

describe('hasUsableSignals', () => {
  it.each([
    [{ seed: 'a', worldName: null, spawn: null }, true],
    [{ seed: null, worldName: 'w', spawn: null }, true],
    [{ seed: null, worldName: null, spawn: spawn }, false],
    [{ seed: null, worldName: null, spawn: null }, false],
  ])('%j -> %s', (fingerprint, expected) => {
    expect(hasUsableSignals(fingerprint)).toBe(expected)
  })
})
