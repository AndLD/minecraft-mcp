import type { WorldFingerprint } from '../core/world-identifier.port.js'

/** A world counts as the same when its signals score at least this much. */
export const MATCH_THRESHOLD = 2

const sameBlock = (a: WorldFingerprint['spawn'], b: WorldFingerprint['spawn']): boolean =>
  a !== null &&
  b !== null &&
  Math.floor(a.x) === Math.floor(b.x) &&
  Math.floor(a.y) === Math.floor(b.y) &&
  Math.floor(a.z) === Math.floor(b.z)

/**
 * How well two fingerprints agree. `undefined` means they are certainly different worlds (different seeds).
 * A matching seed is worth 2 (enough on its own); a matching spawn point or world name is worth 1 each.
 */
export function matchScore(known: WorldFingerprint, seen: WorldFingerprint): number | undefined {
  if (known.seed !== null && seen.seed !== null && known.seed !== seen.seed) return undefined
  let score = 0
  if (known.seed !== null && known.seed === seen.seed) score += 2
  if (sameBlock(known.spawn, seen.spawn)) score += 1
  if (
    known.worldName !== null &&
    seen.worldName !== null &&
    known.worldName.toLowerCase() === seen.worldName.toLowerCase()
  ) {
    score += 1
  }
  return score
}

/** True when the fingerprint carries anything that could recognize the world again. */
export function hasUsableSignals(fingerprint: WorldFingerprint): boolean {
  return fingerprint.seed !== null || fingerprint.worldName !== null
}
