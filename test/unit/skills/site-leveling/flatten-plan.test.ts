import { describe, expect, it } from '@jest/globals'
import {
  buildCutPlan,
  buildFillPlan,
  surveyFill,
} from '../../../../src/skills/site-leveling/flatten-plan.js'
import type { HeightSurvey } from '../../../../src/skills/site-leveling/height-survey.js'
import { FakeBlockScanner } from '../../../fakes/fake-ports.js'

const RECT = { x1: 0, z1: 0, x2: 1, z2: 0 } // two columns: (0,0) and (1,0)

function worldWithMound(): FakeBlockScanner {
  const blocks = new FakeBlockScanner()
  // Column (0,0): two natural blocks above level 60 (61, 62).
  blocks.blockNames.set('0,61,0', 'stone')
  blocks.blockNames.set('0,62,0', 'short_grass')
  // Column (1,0): a player-made block above level (a fence) and a tree.
  blocks.blockNames.set('1,61,0', 'oak_fence')
  blocks.blockNames.set('1,62,0', 'oak_log')
  return blocks
}

describe('buildCutPlan', () => {
  it('breaks every natural or vegetation cell above the level, and tallies cut vs cleared', () => {
    const blocks = worldWithMound()

    const result = buildCutPlan(blocks, RECT, 60, 6, false, false)

    // (0,61,0) stone -> cut; (0,62,0) grass -> cleared; the fence and the log are left alone (clearTrees off).
    const at = result.plan.steps.map((s) => `${s.at.x},${s.at.y},${s.at.z}`)
    expect(at).toEqual(expect.arrayContaining(['0,61,0', '0,62,0']))
    expect(at).not.toEqual(expect.arrayContaining(['1,61,0', '1,62,0']))
    expect(result.cutCount).toBe(1)
    expect(result.clearedCount).toBe(1)
    expect(result.blockedCells).toEqual(
      expect.arrayContaining([
        { x: 1, y: 61, z: 0 },
        { x: 1, y: 62, z: 0 },
      ]),
    )
  })

  it('cuts logs too when clearTrees is on', () => {
    const blocks = worldWithMound()

    const result = buildCutPlan(blocks, RECT, 60, 6, true, false)

    const at = result.plan.steps.map((s) => `${s.at.x},${s.at.y},${s.at.z}`)
    expect(at).toEqual(expect.arrayContaining(['1,62,0'])) // the log
    expect(at).not.toEqual(expect.arrayContaining(['1,61,0'])) // the fence, still player-made
  })

  it('cuts player-made blocks too when clearStructures is on, and reports nothing blocked', () => {
    const blocks = worldWithMound()

    const result = buildCutPlan(blocks, RECT, 60, 6, true, true)

    const at = result.plan.steps.map((s) => `${s.at.x},${s.at.y},${s.at.z}`)
    expect(at).toEqual(expect.arrayContaining(['1,61,0', '1,62,0']))
    expect(result.blockedCells).toEqual([])
  })

  it('digs top down: the highest cell of a column comes before the lowest', () => {
    const blocks = worldWithMound()

    const result = buildCutPlan(blocks, RECT, 60, 6, false, false)

    const column0 = result.plan.steps.filter((s) => s.at.x === 0).map((s) => s.at.y)
    expect(column0).toEqual([62, 61])
  })

  it('stops at clearHeight: nothing above level + clearHeight is touched', () => {
    const blocks = worldWithMound()

    const result = buildCutPlan(blocks, RECT, 60, 1, false, false) // only level+1 = 61 is checked

    const at = result.plan.steps.map((s) => `${s.at.x},${s.at.y},${s.at.z}`)
    expect(at).toEqual(['0,61,0'])
  })

  it('marks the plan hazards: refuse, so the shared lava-nearby check applies before anything runs', () => {
    const result = buildCutPlan(new FakeBlockScanner(), RECT, 60, 6, false, false)

    expect(result.plan.hazards).toBe('refuse')
  })
})

describe('surveyFill', () => {
  const survey = (heights: Record<string, number>): HeightSurvey => ({
    heights: new Map(Object.entries(heights)),
    min: 0,
    max: 0,
    median: 0,
  })

  it('finds columns below the level, and how deep each hole is', () => {
    const result = surveyFill(survey({ '0,0': 57, '1,0': 60 }), RECT, 60, 6)

    expect(result.fillable).toEqual([{ x: 0, z: 0, groundY: 57 }])
    expect(result.tooDeep).toEqual([])
  })

  it('leaves a hole deeper than maxFillDepth alone, reported as too deep', () => {
    const result = surveyFill(survey({ '0,0': 50, '1,0': 60 }), RECT, 60, 6) // 10 deep, limit 6

    expect(result.fillable).toEqual([])
    expect(result.tooDeep).toEqual([{ x: 0, y: 50, z: 0 }])
  })

  it('treats a column already at or above the level as needing no fill', () => {
    const result = surveyFill(survey({ '0,0': 60, '1,0': 65 }), RECT, 60, 6)

    expect(result.fillable).toEqual([])
    expect(result.tooDeep).toEqual([])
  })
})

describe('buildFillPlan', () => {
  it('places fillBlock bottom up, up to and including the level', () => {
    const plan = buildFillPlan(RECT, [{ x: 0, z: 0, groundY: 57 }], 60, 'dirt', undefined)

    expect(plan.steps).toEqual([
      { kind: 'place', at: { x: 0, y: 58, z: 0 }, block: 'dirt' },
      { kind: 'place', at: { x: 0, y: 59, z: 0 }, block: 'dirt' },
      { kind: 'place', at: { x: 0, y: 60, z: 0 }, block: 'dirt' },
    ])
  })

  it('uses surfaceBlock only for the very top cell', () => {
    const plan = buildFillPlan(RECT, [{ x: 0, z: 0, groundY: 58 }], 60, 'dirt', 'stone')

    expect(plan.steps).toEqual([
      { kind: 'place', at: { x: 0, y: 59, z: 0 }, block: 'dirt' },
      { kind: 'place', at: { x: 0, y: 60, z: 0 }, block: 'stone' },
    ])
  })
})
