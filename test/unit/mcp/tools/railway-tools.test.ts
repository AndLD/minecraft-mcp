import { describe, expect, it } from '@jest/globals'
import { err, ok } from '../../../../src/core/result.js'
import { TaskLauncher } from '../../../../src/mcp/task-launcher.js'
import { BuildRailwayTool, PlaceMinecartTool, PlanRailwayTool } from '../../../../src/mcp/tools/railway-tools.js'
import type { BuildRailwaySkill, RailwayInput } from '../../../../src/skills/railway/build-railway-skill.js'
import type { PlaceMinecartSkill } from '../../../../src/skills/railway/place-minecart-skill.js'
import { TaskManager } from '../../../../src/tasks/task-manager.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeLogger } from '../../../fakes/fake-logger.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'

const context = { signal: new AbortController().signal }

function launching() {
  const clock = new FakeClock(Date.UTC(2026, 8, 24, 12, 0, 0))
  const tasks = new TaskManager({ clock, scheduler: new FakeScheduler(clock), logger: new FakeLogger() })
  return { tasks, launcher: new TaskLauncher(tasks, clock) }
}

const to = { x: 20, y: 64, z: 0 }

function railwaySkill(result: unknown = ok({ rails: 21 })) {
  const previews: RailwayInput[] = []
  const runs: RailwayInput[] = []
  const skill = {
    name: 'build_railway',
    preview: (input: RailwayInput) => {
      previews.push(input)
      return result
    },
    run: (input: RailwayInput) => {
      runs.push(input)
      return Promise.resolve(ok({ rails: 21, verification: { checked: 21, problems: [] } }))
    },
  } as unknown as BuildRailwaySkill
  return { skill, previews, runs }
}

describe('PlanRailwayTool', () => {
  it('translates the input, changes nothing, and returns the preview', () => {
    const { skill, previews } = railwaySkill()
    const tool = new PlanRailwayTool(skill)

    const result = tool.execute(
      tool.inputSchema.parse({ to, layout: 'underground', variant: 'rich', depth: 5, label: 'mine line', to_player: undefined }),
    )

    expect(previews[0]).toEqual({
      from: undefined,
      to,
      toPlayer: undefined,
      layout: 'underground',
      variant: 'rich',
      spacing: undefined,
      depth: 5,
      supportBlock: 'cobblestone',
      label: 'mine line',
      fetchFromStorage: false,
      verify: false,
      onInventoryFull: undefined,
    })
    expect(result).toEqual({ ok: true, data: { rails: 21 } })
  })

  it('applies defaults: auto layout, economy variant, cobblestone supports', () => {
    const tool = new PlanRailwayTool(railwaySkill().skill)

    expect(tool.inputSchema.parse({ to })).toMatchObject({ layout: 'auto', variant: 'economy', support_block: 'cobblestone' })
  })

  it('reports why there is no route, with the reason', () => {
    const tool = new PlanRailwayTool(railwaySkill(err({ reason: 'no_route', message: 'Blocked by lava.' })).skill)

    expect(tool.execute(tool.inputSchema.parse({ to }))).toEqual({
      ok: false,
      error: 'Blocked by lava. (reason: no_route)',
    })
  })

  it('validates its arguments', () => {
    const tool = new PlanRailwayTool(railwaySkill().skill)
    const valid = (input: unknown): boolean => tool.inputSchema.safeParse(input).success

    expect(valid({ to })).toBe(true)
    expect(valid({ to, spacing: 6 })).toBe(false)
    expect(valid({ to, spacing: 11 })).toBe(false)
    expect(valid({ to, spacing: 9 })).toBe(true)
    expect(valid({ to, depth: 1 })).toBe(false)
    expect(valid({ to, layout: 'sky' })).toBe(false)
    expect(valid({ to: { x: 1.5, y: 2, z: 3 } })).toBe(false)
    expect(tool.description).toContain('Dry run')
  })
})

describe('BuildRailwayTool', () => {
  it('runs the skill through the task launcher with the storage and verification choices', async () => {
    const { launcher, tasks } = launching()
    const { skill, runs } = railwaySkill()
    const tool = new BuildRailwayTool(skill, launcher)

    const result = await tool.execute(
      tool.inputSchema.parse({ to_player: 'Alex', variant: 'rich', spacing: 9, fetch_from_storage: false, verify: false, on_inventory_full: 'stop' }),
      context,
    )

    expect(runs[0]).toEqual({
      from: undefined,
      to: undefined,
      toPlayer: 'Alex',
      layout: 'auto',
      variant: 'rich',
      spacing: 9,
      depth: undefined,
      supportBlock: 'cobblestone',
      label: undefined,
      fetchFromStorage: false,
      verify: false,
      onInventoryFull: 'stop',
    })
    expect(result).toMatchObject({ ok: true, data: { description: 'Build a rich railway', status: 'succeeded', result: { rails: 21 } } })
    expect(tasks.latest()?.resume?.tool).toBe('build_railway')
  })

  it('fetches from storage and verifies by default', async () => {
    const { launcher } = launching()
    const { skill, runs } = railwaySkill()
    const tool = new BuildRailwayTool(skill, launcher)

    await tool.execute(tool.inputSchema.parse({ to }), context)

    expect(runs[0]).toMatchObject({ fetchFromStorage: true, verify: true })
  })
})

describe('PlaceMinecartTool', () => {
  it('passes the rail or the railway on to the skill through the task launcher', async () => {
    const { launcher, tasks } = launching()
    const runs: unknown[] = []
    const skill = {
      name: 'place_minecart',
      run: (input: unknown) => {
        runs.push(input)
        return Promise.resolve(ok({ at: to, line: 'railway-1' }))
      },
    } as unknown as PlaceMinecartSkill
    const tool = new PlaceMinecartTool(skill, launcher)

    const result = await tool.execute(tool.inputSchema.parse({ line: 'mine line' }), context)
    await tool.execute(tool.inputSchema.parse({ at: to }), context)

    expect(runs).toEqual([
      { at: undefined, line: 'mine line' },
      { at: to, line: undefined },
    ])
    expect(result).toMatchObject({ ok: true, data: { status: 'succeeded', result: { line: 'railway-1' } } })
    expect(tasks.latest()?.resume?.tool).toBe('place_minecart')
  })
})
