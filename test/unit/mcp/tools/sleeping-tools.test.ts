import { describe, expect, it } from '@jest/globals'
import { ok } from '../../../../src/core/result.js'
import { TaskLauncher } from '../../../../src/mcp/task-launcher.js'
import {
  ListBedsTool,
  PlaceBedTool,
  SetRespawnPointTool,
  SetSleepPolicyTool,
  SleepTool,
} from '../../../../src/mcp/tools/sleeping-tools.js'
import type { PlaceBedSkill } from '../../../../src/skills/sleeping/place-bed-skill.js'
import type { SetRespawnPointSkill } from '../../../../src/skills/sleeping/set-respawn-point-skill.js'
import type { SleepSkill } from '../../../../src/skills/sleeping/sleep-skill.js'
import { BedRegistry } from '../../../../src/state/bed-registry.js'
import { SleepPolicy } from '../../../../src/state/sleep-policy.js'
import { StandingInstructions } from '../../../../src/state/standing-instructions.js'
import { TaskManager } from '../../../../src/tasks/task-manager.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeLogger } from '../../../fakes/fake-logger.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const context = { signal: new AbortController().signal }
const bed = { x: 4, y: 64, z: 9 }

function launching() {
  const clock = new FakeClock(0)
  const tasks = new TaskManager({ clock, scheduler: new FakeScheduler(clock), logger: new FakeLogger() })
  return { tasks, launcher: new TaskLauncher(tasks, clock) }
}

const skillOf = (name: string, runs: unknown[]): unknown => ({
  name,
  run: (input: unknown) => {
    runs.push(input)
    return Promise.resolve(ok({ done: true }))
  },
})

describe('sleeping tools that start tasks', () => {
  it('sleep passes the bed and the stay on, and can be resumed', async () => {
    const { launcher, tasks } = launching()
    const runs: unknown[] = []
    const tool = new SleepTool(skillOf('sleep', runs) as SleepSkill, launcher)

    const result = await tool.execute(tool.inputSchema.parse({ bed, stay_seconds: 20 }), context)
    await tool.execute(tool.inputSchema.parse({}), context)

    expect(runs).toEqual([
      { bed, staySeconds: 20 },
      { bed: undefined, staySeconds: undefined },
    ])
    expect(result).toMatchObject({ ok: true, data: { status: 'succeeded' } })
    expect(tasks.latest()?.resume?.tool).toBe('sleep')
    expect(tool.inputSchema.safeParse({ stay_seconds: 2 }).success).toBe(false)
  })

  it('set_respawn_point passes the bed on', async () => {
    const { launcher } = launching()
    const runs: unknown[] = []
    const tool = new SetRespawnPointTool(skillOf('set_respawn_point', runs) as SetRespawnPointSkill, launcher)

    await tool.execute(tool.inputSchema.parse({ bed }), context)

    expect(runs).toEqual([{ bed }])
  })

  it('place_bed passes the cell and the colour on, and only knows real colours', async () => {
    const { launcher } = launching()
    const runs: unknown[] = []
    const tool = new PlaceBedTool(skillOf('place_bed', runs) as PlaceBedSkill, launcher)

    await tool.execute(tool.inputSchema.parse({ at: bed, colour: 'light_blue' }), context)

    expect(runs).toEqual([{ at: bed, colour: 'light_blue' }])
    expect(tool.inputSchema.safeParse({ colour: 'plaid' }).success).toBe(false)
  })
})

describe('ListBedsTool', () => {
  it('lists the beds and which one is the respawn point, changing nothing', async () => {
    const registry = new BedRegistry(new FakeClock(0))
    await registry.attach(new InMemoryStateStore())
    const tool = new ListBedsTool(registry)
    expect(tool.execute()).toEqual({ ok: true, data: { beds: [], respawnPoint: null } })

    registry.note({ x: 1, y: 64, z: 1 }, 'blue')
    registry.setRespawn(bed, 'red')
    const result = tool.execute()

    expect(result.ok && (result.data as { beds: unknown[] }).beds).toHaveLength(2)
    expect(result.ok && (result.data as { respawnPoint: unknown }).respawnPoint).toMatchObject({
      colour: 'red',
      position: bed,
      respawnPoint: true,
    })
  })
})

describe('SetSleepPolicyTool', () => {
  async function tool() {
    const store = new InMemoryStateStore()
    const policy = new SleepPolicy()
    const standing = new StandingInstructions()
    await policy.attach(store)
    await standing.attach(store)
    return { policy, standing, tool: new SetSleepPolicyTool(policy, standing) }
  }

  it('saves the policy and mirrors it as a standing instruction, removed again on ask', async () => {
    const { policy, standing, tool: t } = await tool()

    expect(t.execute(t.inputSchema.parse({ policy: 'when_idle' }))).toEqual({
      ok: true,
      data: { policy: 'when_idle' },
    })
    expect(policy.get()).toBe('when_idle')
    expect(standing.all().sleep_policy).toContain('goes to bed')

    t.execute(t.inputSchema.parse({ policy: 'never' }))
    expect(standing.all().sleep_policy).toContain('never')

    t.execute(t.inputSchema.parse({ policy: 'ask' }))
    expect(standing.all()).not.toHaveProperty('sleep_policy')
  })

  it('fails without an active world and rejects unknown policies', () => {
    const t = new SetSleepPolicyTool(new SleepPolicy(), new StandingInstructions())

    expect(t.execute(t.inputSchema.parse({ policy: 'never' })).ok).toBe(false)
    expect(t.inputSchema.safeParse({ policy: 'sometimes' }).success).toBe(false)
  })
})
