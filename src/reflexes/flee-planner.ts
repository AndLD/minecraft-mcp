import { distanceBetween } from '../core/position.js'
import type { Position } from '../core/position.types.js'

/** How far the bot runs in one go. */
export const FLEE_DISTANCE = 20
const DIRECTIONS = 8

/**
 * Candidate places to run to, best first: far from every threat, and (slightly preferred) close to the owner
 * or a known landmark, where help or safety is. Different directions are ranked so a blocked one can be skipped.
 */
export function rankFleeDestinations(
  here: Position,
  threats: readonly Position[],
  safeHaven?: Position,
): Position[] {
  const candidates: { readonly position: Position; readonly score: number }[] = []
  for (let i = 0; i < DIRECTIONS; i += 1) {
    const angle = (i * 2 * Math.PI) / DIRECTIONS
    const position = {
      x: here.x + Math.cos(angle) * FLEE_DISTANCE,
      y: here.y,
      z: here.z + Math.sin(angle) * FLEE_DISTANCE,
    }
    const fromThreats =
      threats.length === 0
        ? FLEE_DISTANCE
        : Math.min(...threats.map((threat) => distanceBetween(position, threat)))
    const towardHaven = safeHaven === undefined ? 0 : distanceBetween(position, safeHaven)
    candidates.push({ position, score: fromThreats - 0.3 * towardHaven })
  }
  return candidates.sort((a, b) => b.score - a.score).map((candidate) => candidate.position)
}
