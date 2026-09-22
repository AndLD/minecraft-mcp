import { describe, expect, it } from '@jest/globals'
import { err, ok } from '../../../../src/core/result.js'
import type { SkillResult } from '../../../../src/core/skill.types.js'
import { TaskLauncher } from '../../../../src/mcp/task-launcher.js'
import {
  FlattenAreaTool,
  PreviewFlattenTool,
} from '../../../../src/mcp/tools/site-leveling-tools.js'
import type {
  FlattenAreaInput,
  FlattenAreaOutput,
  FlattenAreaSkill,
  FlattenPreview,
} from '../../../../src/skills/site-leveling/flatten-area-skill.js'
import { TaskManager } from '../../../../src/tasks/task-manager.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeLogger } from '../../../fakes/fake-logger.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'

const context = { signal: new AbortController().signal }

function launching() {
  const clock = new FakeClock(Date.UTC(2026, 8, 19, 12, 0, 0))
  const tasks = new TaskManager({
    clock,
    scheduler: new FakeScheduler(clock),
    logger: new FakeLogger(),
  })
  return { tasks, launcher: new TaskLauncher(tasks, clock) }
}

function output(overrides: Partial<FlattenAreaOutput> = {}): FlattenAreaOutput {
  return {
    bounds: { from: { x: 0, y: 60, z: 0 }, to: { x: 0, y: 60, z: 0 } },
    level: 60,
    cut: 0,
    cleared: 0,
    filled: 0,
    fillBlock: 'dirt',
    blockedCells: [],
    tooDeep: [],
    gained: [],
    fetched: [],
    ...overrides,
  }
}

function stubSkill(
  runResult: SkillResult<FlattenAreaOutput> = ok(output()),
  previewResult: SkillResult<FlattenPreview> = ok({
    bounds: { from: { x: 0, y: 60, z: 0 }, to: { x: 0, y: 60, z: 0 } },
    level: 60,
    direction: 'north',
    usedMarkersForArea: false,
    toCut: 0,
    toClear: 0,
    fillColumns: 0,
    toFill: 0,
    blockedCells: [],
    blockedCount: 0,
    tooDeep: [],
  }),
) {
  const runs: FlattenAreaInput[] = []
  const skill = {
    name: 'flatten_area',
    run: (input: FlattenAreaInput) => {
      runs.push(input)
      return Promise.resolve(runResult)
    },
    preview: (input: FlattenAreaInput) => {
      runs.push(input)
      return previewResult
    },
  }
  return { skill: skill as unknown as FlattenAreaSkill, runs }
}

describe('FlattenAreaTool', () => {
  it('resolves the player from for_player, falling back to the configured owner', async () => {
    const { launcher } = launching()
    const { skill, runs } = stubSkill()
    const tool = new FlattenAreaTool(skill, launcher, 'Owner')

    await tool.execute(tool.inputSchema.parse({ width: 3, length: 3 }), context)

    expect(runs[0]?.player).toBe('Owner')

    await tool.execute(
      tool.inputSchema.parse({ width: 3, length: 3, for_player: 'Someone' }),
      context,
    )
    expect(runs[1]?.player).toBe('Someone')
  })

  it('fails without asking the skill when no player is configured or given', async () => {
    const { launcher } = launching()
    const { skill, runs } = stubSkill()
    const tool = new FlattenAreaTool(skill, launcher, undefined)

    const result = await tool.execute(tool.inputSchema.parse({ width: 3, length: 3 }), context)

    expect(result).toMatchObject({ ok: false })
    expect(runs).toHaveLength(0)
  })

  it('passes marker_block through as a single-item list, and undefined when not given', async () => {
    const { launcher } = launching()
    const { skill, runs } = stubSkill()
    const tool = new FlattenAreaTool(skill, launcher, 'Owner')

    await tool.execute(
      tool.inputSchema.parse({ width: 1, length: 1, marker_block: 'cobblestone' }),
      context,
    )
    expect(runs[0]?.markerBlocks).toEqual(['cobblestone'])

    await tool.execute(tool.inputSchema.parse({ width: 1, length: 1 }), context)
    expect(runs[1]?.markerBlocks).toBeUndefined()
  })

  it('returns the run result on success', async () => {
    const { launcher } = launching()
    const { skill } = stubSkill(ok(output({ cut: 3, filled: 2 })))
    const tool = new FlattenAreaTool(skill, launcher, 'Owner')

    const result = await tool.execute(tool.inputSchema.parse({ width: 3, length: 3 }), context)

    expect(result).toMatchObject({ ok: true, data: { result: { cut: 3, filled: 2 } } })
  })
})

describe('PreviewFlattenTool', () => {
  it('fails without asking the skill when no player is configured or given', () => {
    const { skill, runs } = stubSkill()
    const tool = new PreviewFlattenTool(skill, undefined)

    const result = tool.execute(tool.inputSchema.parse({ width: 3, length: 3 }))

    expect(result).toMatchObject({ ok: false })
    expect(runs).toHaveLength(0)
  })

  it('returns the preview on success', () => {
    const { skill } = stubSkill(
      undefined,
      ok({
        bounds: { from: { x: 0, y: 60, z: 0 }, to: { x: 2, y: 60, z: 2 } },
        level: 60,
        direction: 'south',
        usedMarkersForArea: false,
        toCut: 4,
        toClear: 1,
        fillColumns: 0,
        toFill: 0,
        blockedCells: [],
        blockedCount: 0,
        tooDeep: [],
      }),
    )
    const tool = new PreviewFlattenTool(skill, 'Owner')

    const result = tool.execute(tool.inputSchema.parse({ width: 3, length: 3 }))

    expect(result).toMatchObject({ ok: true, data: { toCut: 4, toClear: 1 } })
  })

  it('reports a skill failure with its reason', () => {
    const { skill } = stubSkill(
      undefined,
      err({ reason: 'too_large', message: 'That plot is too big.' }),
    )
    const tool = new PreviewFlattenTool(skill, 'Owner')

    const result = tool.execute(tool.inputSchema.parse({ width: 64, length: 64 }))

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('too_large') })
  })
})
