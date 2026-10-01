import { describe, expect, it } from '@jest/globals'
import { surveyHeights } from '../../../../src/skills/site-leveling/height-survey.js'
import { FakeBlockScanner } from '../../../fakes/fake-ports.js'

function flatWorld(groundY: number, rect: { x1: number; z1: number; x2: number; z2: number }) {
  const blocks = new FakeBlockScanner()
  for (let x = rect.x1; x <= rect.x2; x += 1)
    for (let z = rect.z1; z <= rect.z2; z += 1)
      for (let y = groundY - 3; y <= groundY; y += 1)
        blocks.solid.set(`${String(x)},${String(y)},${String(z)}`, true)
  return blocks
}

describe('surveyHeights', () => {
  it('finds the topmost solid block of every column, on flat ground', () => {
    const rect = { x1: 0, z1: 0, x2: 2, z2: 2 }
    const blocks = flatWorld(63, rect)

    const survey = surveyHeights(blocks, rect, 70, 50)

    expect(survey.min).toBe(63)
    expect(survey.max).toBe(63)
    expect(survey.median).toBe(63)
    expect(survey.heights.get('1,1')).toBe(63)
  })

  it('reports a mound higher and a hole lower', () => {
    const rect = { x1: 0, z1: 0, x2: 2, z2: 0 }
    const blocks = flatWorld(63, rect)
    blocks.solid.set('0,66,0', true) // a mound at x=0
    blocks.solid.set('2,63,0', false) // a hole at x=2 (the top layer removed)

    const survey = surveyHeights(blocks, rect, 70, 50)

    expect(survey.heights.get('0,0')).toBe(66)
    expect(survey.heights.get('1,0')).toBe(63)
    expect(survey.heights.get('2,0')).toBe(62)
  })

  it('records the bottom probe when nothing solid is found in range', () => {
    const blocks = new FakeBlockScanner() // isSolid undefined everywhere

    const survey = surveyHeights(blocks, { x1: 0, z1: 0, x2: 0, z2: 0 }, 10, 5)

    expect(survey.heights.get('0,0')).toBe(5)
  })

  it('picks the median as the height that moves the fewest blocks', () => {
    const rect = { x1: 0, z1: 0, x2: 4, z2: 0 }
    const blocks = new FakeBlockScanner()
    // Five columns at heights 60, 61, 62, 63, 70 (one outlier mound).
    for (const [x, y] of [
      [0, 60],
      [1, 61],
      [2, 62],
      [3, 63],
      [4, 70],
    ] as const)
      blocks.solid.set(`${String(x)},${String(y)},0`, true)

    const survey = surveyHeights(blocks, rect, 75, 55)

    expect(survey.median).toBe(62) // the middle value, not skewed by the outlier mound
  })
})
