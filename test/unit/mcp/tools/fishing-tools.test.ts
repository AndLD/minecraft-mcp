import { describe, expect, it } from '@jest/globals'
import { ok } from '../../../../src/core/result.js'
import { TaskLauncher } from '../../../../src/mcp/task-launcher.js'
import { FishTool } from '../../../../src/mcp/tools/fishing-tools.js'
import type { FishInput, FishSkill } from '../../../../src/skills/fishing/fish-skill.js'
import { TaskManager } from '../../../../src/tasks/task-manager.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeLogger } from '../../../fakes/fake-logger.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'

const context = { signal: new AbortController().signal }

function build() {
  const clock = new FakeClock(Date.UTC(2026, 8, 19, 12, 0, 0))
  const tasks = new TaskManager({
    clock,
    scheduler: new FakeScheduler(clock),
    logger: new FakeLogger(),
  })
  const runs: FishInput[] = []
  const skill = {
    name: 'fish',
    run: (input: FishInput) => {
      runs.push(input)
      return Promise.resolve(ok({ stopped: 'count', caught: 3 }))
    },
  } as unknown as FishSkill
  return { runs, tool: new FishTool(skill, new TaskLauncher(tasks, clock)) }
}

describe('fish', () => {
  it('translates the input and runs the skill as a task', async () => {
    const { tool, runs } = build()

    const result = await tool.execute(
      tool.inputSchema.parse({
        count: 3,
        item: 'salmon',
        max_minutes: 5,
        cook: true,
        at: { x: 1, y: 64, z: 2 },
      }),
      context,
    )

    expect(runs[0]).toEqual({
      count: 3,
      item: 'salmon',
      maxMinutes: 5,
      cook: true,
      at: { x: 1, y: 64, z: 2 },
    })
    expect(result).toMatchObject({ ok: true, data: { description: 'Fish for 3 salmon' } })
  })

  it('has defaults: ten fish, ten minutes, no cooking, the nearest water', () => {
    const { tool } = build()

    expect(tool.inputSchema.parse({})).toMatchObject({
      count: 10,
      max_minutes: 10,
      cook: false,
      replace: false,
    })
  })

  it('names fish in the task description when no item is given', async () => {
    const { tool } = build()

    const result = await tool.execute(tool.inputSchema.parse({}), context)

    expect(result).toMatchObject({ ok: true, data: { description: 'Fish for 10 fish' } })
  })

  it.each([{ count: 0 }, { count: 500 }, { max_minutes: 0 }, { max_minutes: 120 }, { item: '' }])(
    'refuses %j',
    (bad) => {
      expect(build().tool.inputSchema.safeParse(bad).success).toBe(false)
    },
  )
})
