import { describe, expect, it } from '@jest/globals'
import {
  fenceRingSteps,
  gateAlignAxis,
  type GateSide,
} from '../../../../src/skills/farming/fence-ring.js'
import type { WorkStep } from '../../../../src/skills/construction/work-plan.types.js'

const SIDES: GateSide[] = ['north', 'south', 'east', 'west']
const ring = (side: GateSide | undefined, width = 5, length = 7) =>
  fenceRingSteps({ x0: 10, y0: 63, z0: -5, width, length, torches: false, gateSide: side })
const gateOf = (steps: WorkStep[]) => {
  const gates = steps.filter((s) => s.kind === 'place' && s.block === 'oak_fence_gate')
  expect(gates).toHaveLength(1)
  return gates[0] as Extract<WorkStep, { kind: 'place' }>
}

describe('fenceRingSteps: the gate', () => {
  it.each([
    ['north', 'z'],
    ['south', 'z'],
    ['east', 'x'],
    ['west', 'x'],
  ] as const)(
    'in the %s side the bot stands in line along %s, so the gate lies along the fence',
    (side, axis) => {
      expect(gateAlignAxis(side)).toBe(axis)
      expect(gateOf(ring(side)).alignAxis).toBe(axis)
    },
  )

  it('defaults to the south side (a fence along x, so the bot stands along z)', () => {
    const gate = gateOf(ring(undefined))

    expect(gate.at).toEqual({ x: 12, y: 64, z: 2 })
    expect(gate.alignAxis).toBe('z')
  })

  it.each([
    ['north', { x: 12, y: 64, z: -6 }],
    ['south', { x: 12, y: 64, z: 2 }],
    ['east', { x: 15, y: 64, z: -2 }],
    ['west', { x: 9, y: 64, z: -2 }],
  ] as const)(
    'puts the %s gate at the middle of its side, in the ring one cell out',
    (side, at) => {
      expect(gateOf(ring(side)).at).toEqual(at)
    },
  )

  it('finds the middle of an even side on the lower of the two centre cells', () => {
    const north = gateOf(ring('north', 4, 6))
    const west = gateOf(ring('west', 4, 6))

    expect(north.at).toEqual({ x: 11, y: 64, z: -6 })
    expect(west.at).toEqual({ x: 9, y: 64, z: -3 })
  })

  it.each(SIDES)(
    'closes the ring on every side: the gate replaces exactly one fence cell (%s)',
    (side) => {
      const steps = ring(side, 5, 7)

      expect(steps).toHaveLength(2 * (5 + 2) + 2 * 7) // the whole perimeter, one step a cell
      expect(steps.filter((s) => s.kind === 'place' && s.block === 'oak_fence')).toHaveLength(
        2 * (5 + 2) + 2 * 7 - 1,
      )
    },
  )

  it('leaves the rest of the ring where it was: fence at ground level plus one, all in the fence branch', () => {
    const steps = ring('east')

    expect(steps.every((s) => s.kind === 'place' && s.at.y === 64 && s.branch === 'fence')).toBe(
      true,
    )
  })

  it('still puts a torch on every fifth post when asked, whatever the side', () => {
    for (const side of SIDES) {
      const steps = fenceRingSteps({
        x0: 0,
        y0: 63,
        z0: 0,
        width: 5,
        length: 5,
        torches: true,
        gateSide: side,
      })

      expect(steps.filter((s) => s.kind === 'light').length).toBeGreaterThan(0)
      expect(steps.filter((s) => s.kind === 'light').every((s) => s.at.y === 65)).toBe(true)
    }
  })
})
