import { describe, expect, it } from '@jest/globals'
import type { LookTarget } from '../../../../src/core/container.port.js'
import { err, ok } from '../../../../src/core/result.js'
import { TaskLauncher } from '../../../../src/mcp/task-launcher.js'
import { BreakBlockTool } from '../../../../src/mcp/tools/break-block-tool.js'
import type { BreakBlockSkill } from '../../../../src/skills/breaking/break-block-skill.js'
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
    name: 'break_block',
    run: (input: unknown) => {
      runs.push(input)
      return Promise.resolve(result)
    },
  } as unknown as BreakBlockSkill
  return { skill, runs }
}

const looking = (hit: ReturnType<LookTarget['blockLookedAt']>): LookTarget => ({
  blockLookedAt: () => hit,
})
const nobody = looking(undefined)

describe('BreakBlockTool', () => {
  it('breaks the block at the coordinates, with the safe defaults', async () => {
    const { launcher, tasks } = launching()
    const { skill, runs } = skillReturning(ok({ broken: true }))
    const tool = new BreakBlockTool(skill, launcher, nobody, 'Owner')

    const result = await tool.execute(tool.inputSchema.parse({ x: 12, y: 70, z: -4 }), context)

    expect(runs).toEqual([
      {
        at: { x: 12, y: 70, z: -4 },
        collect: true,
        allowContainers: false,
        overrideProtection: false,
      },
    ])
    expect(result).toMatchObject({
      ok: true,
      data: { description: 'Break the block at 12, 70, -4', status: 'succeeded' },
    })
    expect(tasks.latest()?.resume).toEqual({
      tool: 'break_block',
      arguments: { x: 12, y: 70, z: -4, collect: true, allow_containers: false },
    })
  })

  it('passes the flags on, but never puts the protection override into a resume', async () => {
    const { launcher, tasks } = launching()
    const { skill, runs } = skillReturning(ok({ broken: true }))
    const tool = new BreakBlockTool(skill, launcher, nobody, undefined)

    await tool.execute(
      tool.inputSchema.parse({
        x: 1,
        y: 2,
        z: 3,
        collect: false,
        allow_containers: true,
        override_protection: true,
      }),
      context,
    )

    expect(runs).toEqual([
      {
        at: { x: 1, y: 2, z: 3 },
        collect: false,
        allowContainers: true,
        overrideProtection: true,
      },
    ])
    expect(JSON.stringify(tasks.latest()?.resume)).not.toContain('override')
  })

  it('takes the block the owner looks at', async () => {
    const { launcher, tasks } = launching()
    const { skill, runs } = skillReturning(ok({ broken: true }))
    const tool = new BreakBlockTool(
      skill,
      launcher,
      looking({ name: 'oak_stairs', position: { x: 5, y: 64, z: 9 }, face: 'north' }),
      'Owner',
    )

    await tool.execute(tool.inputSchema.parse({ looking_at: true }), context)

    expect(runs[0]).toMatchObject({ at: { x: 5, y: 64, z: 9 } })
    expect(tasks.latest()?.resume?.arguments).toMatchObject({ x: 5, y: 64, z: 9 })
  })

  it('asks the given player when for_player is set', async () => {
    const { launcher } = launching()
    const asked: string[] = []
    const { skill } = skillReturning(ok({}))
    const tool = new BreakBlockTool(
      skill,
      launcher,
      {
        blockLookedAt: (player) => {
          asked.push(player)
          return { name: 'stone', position: { x: 0, y: 0, z: 0 }, face: 'top' }
        },
      },
      'Owner',
    )

    await tool.execute(tool.inputSchema.parse({ looking_at: true, for_player: 'Alex' }), context)

    expect(asked).toEqual(['Alex'])
  })

  it('says so when nobody is looking at a block, or no player is known', async () => {
    const { launcher } = launching()
    const { skill, runs } = skillReturning(ok({}))

    const tool = new BreakBlockTool(skill, launcher, nobody, 'Owner')
    const notLooking = await tool.execute(tool.inputSchema.parse({ looking_at: true }), context)
    const noOwner = await new BreakBlockTool(skill, launcher, nobody, undefined).execute(
      tool.inputSchema.parse({ looking_at: true }),
      context,
    )

    expect(notLooking).toMatchObject({ ok: false })
    expect(JSON.stringify(notLooking)).toContain('not looking at any block')
    expect(JSON.stringify(noOwner)).toContain('Say which player')
    expect(runs).toEqual([])
  })

  it('returns the skill failure with its reason', async () => {
    const { launcher } = launching()
    const { skill } = skillReturning(
      err({ reason: 'protected_area', message: 'inside the protected area "Home"' }),
    )
    const tool = new BreakBlockTool(skill, launcher, nobody, 'Owner')

    const result = await tool.execute(tool.inputSchema.parse({ x: 1, y: 2, z: 3 }), context)

    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).toContain('protected_area')
  })

  it.each([
    [{}],
    [{ x: 1, y: 2 }],
    [{ x: 1.5, y: 2, z: 3 }],
    [{ looking_at: true, x: 1, y: 2, z: 3 }],
  ])('rejects invalid input %j', (input) => {
    const { launcher } = launching()
    const tool = new BreakBlockTool(skillReturning(ok({})).skill, launcher, nobody, 'Owner')

    expect(tool.inputSchema.safeParse(input).success).toBe(false)
  })
})
