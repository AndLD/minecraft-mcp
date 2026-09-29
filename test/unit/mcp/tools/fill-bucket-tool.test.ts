import { describe, expect, it } from '@jest/globals'
import { err, ok } from '../../../../src/core/result.js'
import { TaskLauncher } from '../../../../src/mcp/task-launcher.js'
import { FillBucketTool } from '../../../../src/mcp/tools/fill-bucket-tool.js'
import type { FillBucketSkill } from '../../../../src/skills/buckets/fill-bucket-skill.js'
import { TaskManager } from '../../../../src/tasks/task-manager.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeLogger } from '../../../fakes/fake-logger.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'

const context = { signal: new AbortController().signal }

function launching() {
  const clock = new FakeClock(Date.UTC(2026, 8, 29, 12, 0, 0))
  const tasks = new TaskManager({
    clock,
    scheduler: new FakeScheduler(clock),
    logger: new FakeLogger(),
  })
  return { tasks, launcher: new TaskLauncher(tasks, clock) }
}

function skillReturning(result: unknown) {
  const runs: unknown[] = []
  const skill = {
    name: 'fill_bucket',
    run: (input: unknown) => {
      runs.push(input)
      return Promise.resolve(result)
    },
  } as unknown as FillBucketSkill
  return { skill, runs }
}

describe('FillBucketTool', () => {
  it('passes the liquid, count, block, and distance on to the skill through the task launcher', async () => {
    const { launcher, tasks } = launching()
    const { skill, runs } = skillReturning(ok({ filled: 2, item: 'lava_bucket' }))
    const tool = new FillBucketTool(skill, launcher)

    const result = await tool.execute(
      tool.inputSchema.parse({
        liquid: 'lava',
        count: 2,
        at: { x: 5, y: 12, z: -3 },
        max_distance: 10,
      }),
      context,
    )

    expect(runs).toEqual([
      { liquid: 'lava', count: 2, at: { x: 5, y: 12, z: -3 }, maxDistance: 10 },
    ])
    expect(result).toMatchObject({
      ok: true,
      data: {
        description: 'Fill 2 bucket(s) with lava',
        status: 'succeeded',
        result: { filled: 2, item: 'lava_bucket' },
      },
    })
    expect(tasks.latest()?.resume).toEqual({
      tool: 'fill_bucket',
      arguments: expect.objectContaining({ liquid: 'lava', count: 2 }),
    })
  })

  it('takes one bucket from the nearest source within 24 blocks by default', async () => {
    const { launcher } = launching()
    const { skill, runs } = skillReturning(ok({ filled: 1 }))
    const tool = new FillBucketTool(skill, launcher)

    await tool.execute(tool.inputSchema.parse({ liquid: 'water' }), context)

    expect(runs).toEqual([{ liquid: 'water', count: 1, at: undefined, maxDistance: 24 }])
  })

  it('returns the skill failure as the task failure, with its reason', async () => {
    const { launcher } = launching()
    const { skill } = skillReturning(
      err({ reason: 'no_bucket', message: 'The bot has no empty bucket.' }),
    )
    const tool = new FillBucketTool(skill, launcher)

    const result = await tool.execute(tool.inputSchema.parse({ liquid: 'water' }), context)

    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).toContain('no_bucket')
  })

  it.each([
    [{ liquid: 'milk' }],
    [{ liquid: 'water', count: 0 }],
    [{ liquid: 'water', count: 17 }],
    [{ liquid: 'water', at: { x: 1.5, y: 2, z: 3 } }],
    [{ liquid: 'water', max_distance: 0 }],
    [{}],
  ])('rejects invalid input %j', (input) => {
    const { launcher } = launching()
    const tool = new FillBucketTool(skillReturning(ok({})).skill, launcher)

    expect(tool.inputSchema.safeParse(input).success).toBe(false)
  })
})
