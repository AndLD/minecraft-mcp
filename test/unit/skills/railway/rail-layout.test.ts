import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import { assignPower } from '../../../../src/skills/railway/rail-layout.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })
const line = (n: number): Position[] => Array.from({ length: n }, (_, i) => at(i, 64, 0))
const sorted = (set: ReadonlySet<number>): number[] => [...set].sort((a, b) => a - b)

describe('assignPower: economy', () => {
  it('powers a short run at the start, then one rail every spacing, each run with its own torch', () => {
    const power = assignPower(line(30), 'economy', 8)

    expect(sorted(power.powered)).toEqual([0, 1, 2, 3, 11, 19, 27])
    expect(sorted(power.torches)).toEqual([0, 11, 19, 27])
  })

  it('follows the spacing it is given', () => {
    const power = assignPower(line(30), 'economy', 10)

    expect(sorted(power.powered)).toEqual([0, 1, 2, 3, 13, 23])
  })

  it('powers a slope every third rail', () => {
    const cells = [
      ...Array.from({ length: 6 }, (_, i) => at(i, 64, 0)),
      ...Array.from({ length: 12 }, (_, i) => at(6 + i, 65 + i, 0)),
    ]

    const power = assignPower(cells, 'economy', 8)

    const onSlope = sorted(power.powered).filter((i) => i >= 6)
    for (let k = 1; k < onSlope.length; k += 1) expect((onSlope[k] as number) - (onSlope[k - 1] as number)).toBeLessThanOrEqual(3)
    expect(onSlope.length).toBeGreaterThanOrEqual(4)
  })

  it('never powers a corner, since a powered rail cannot bend', () => {
    const cells = [
      ...Array.from({ length: 12 }, (_, i) => at(i, 64, 0)),
      ...Array.from({ length: 8 }, (_, i) => at(11, 64, i + 1)),
    ]

    const power = assignPower(cells, 'economy', 7)

    expect(power.powered.has(11)).toBe(false)
    expect(power.powered.size).toBeGreaterThan(4)
  })

  it('powers what there is of a line shorter than the start run', () => {
    expect(sorted(assignPower(line(2), 'economy', 8).powered)).toEqual([0, 1])
    expect(assignPower([], 'economy', 8).powered.size).toBe(0)
  })
})

describe('assignPower: rich', () => {
  it('powers every rail and sets a torch on the first of each nine', () => {
    const power = assignPower(line(21), 'rich', 8)

    expect(power.powered.size).toBe(21)
    expect(sorted(power.torches)).toEqual([0, 9, 18])
  })

  it('leaves corners plain and starts a new run after each', () => {
    const cells = [
      ...Array.from({ length: 6 }, (_, i) => at(i, 64, 0)),
      ...Array.from({ length: 6 }, (_, i) => at(5, 64, i + 1)),
    ]

    const power = assignPower(cells, 'rich', 8)

    expect(power.powered.has(5)).toBe(false)
    expect(sorted(power.powered)).toEqual([0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11])
    expect(sorted(power.torches)).toEqual([0, 6])
  })
})
