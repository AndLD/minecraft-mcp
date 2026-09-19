import { describe, expect, it } from '@jest/globals'
import { ok } from '../../../../src/core/result.js'
import type { SkillContext } from '../../../../src/core/skill.types.js'
import { TaskLauncher } from '../../../../src/mcp/task-launcher.js'
import {
  ListDeathRecordsTool,
  RecoverDropsTool,
  SetDropRecoveryPolicyTool,
  SkipDropRecoveryTool,
} from '../../../../src/mcp/tools/drop-recovery-tools.js'
import type { ToolContext } from '../../../../src/mcp/tool.types.js'
import type { RecoverDropsSkill } from '../../../../src/skills/recovery/recover-drops-skill.js'
import { DropRecords, type NewDropRecord } from '../../../../src/state/drop-records.js'
import { DropRecoveryPolicy } from '../../../../src/state/drop-recovery-policy.js'
import { StandingInstructions } from '../../../../src/state/standing-instructions.js'
import { TaskManager } from '../../../../src/tasks/task-manager.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeLogger } from '../../../fakes/fake-logger.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const START = 10_000_000
const context: ToolContext = { signal: new AbortController().signal }

async function setup() {
  const clock = new FakeClock(START)
  const tasks = new TaskManager({
    clock,
    scheduler: new FakeScheduler(clock),
    logger: new FakeLogger(),
  })
  const store = new InMemoryStateStore()
  const records = new DropRecords(clock)
  const policy = new DropRecoveryPolicy()
  const standing = new StandingInstructions()
  await records.attach(store)
  await policy.attach(store)
  await standing.attach(store)
  const add = (patch: Partial<NewDropRecord> = {}) =>
    records.add({
      kind: 'death',
      position: { x: 1, y: 64, z: 2 },
      dimension: 'overworld',
      at: START - 60_000,
      cause: 'ClaudeBot fell from a high place',
      lost: [{ name: 'iron_ingot', count: 5 }],
      note: null,
      ...patch,
    })
  return { clock, tasks, records, policy, standing, add, launcher: new TaskLauncher(tasks, clock) }
}

describe('SetDropRecoveryPolicyTool', () => {
  it('sets both situations by default, and shows it as a standing instruction', async () => {
    const s = await setup()
    const tool = new SetDropRecoveryPolicyTool(s.policy, s.standing)

    const result = tool.execute(tool.inputSchema.parse({ policy: 'skip' }))

    expect(result).toEqual({ ok: true, data: { death: 'skip', unclaimed: 'skip' } })
    expect(s.standing.all().drop_recovery_policy).toContain('death and unclaimed')
  })

  it('sets one situation and names only that one', async () => {
    const s = await setup()
    const tool = new SetDropRecoveryPolicyTool(s.policy, s.standing)

    tool.execute(tool.inputSchema.parse({ policy: 'skip', situation: 'unclaimed' }))

    expect(s.policy.get()).toEqual({ death: 'auto', unclaimed: 'skip' })
    expect(s.standing.all().drop_recovery_policy).toContain('(unclaimed)')
  })

  it('removes the standing instruction when everything is recovered again', async () => {
    const s = await setup()
    const tool = new SetDropRecoveryPolicyTool(s.policy, s.standing)
    tool.execute(tool.inputSchema.parse({ policy: 'skip' }))

    tool.execute(tool.inputSchema.parse({ policy: 'auto' }))

    expect(s.standing.all().drop_recovery_policy).toBeUndefined()
  })

  it('fails without an active world', async () => {
    const tool = new SetDropRecoveryPolicyTool(new DropRecoveryPolicy(), new StandingInstructions())

    expect(tool.execute(tool.inputSchema.parse({ policy: 'skip' }))).toMatchObject({ ok: false })
  })
})

describe('ListDeathRecordsTool', () => {
  it('lists the newest first with coordinates and how long the items last', async () => {
    const s = await setup()
    s.add()
    s.add({ at: START - 240_000, cause: null })
    const tool = new ListDeathRecordsTool(s.records, s.clock)

    const result = tool.execute(tool.inputSchema.parse({}))

    expect(result).toMatchObject({
      ok: true,
      data: {
        records: [
          { id: 'drop-2', agoSeconds: 240, secondsLeft: 60, cause: null },
          {
            id: 'drop-1',
            kind: 'death',
            status: 'pending',
            position: { x: 1, y: 64, z: 2 },
            dimension: 'overworld',
            agoSeconds: 60,
            secondsLeft: 240,
            lost: [{ name: 'iron_ingot', count: 5 }],
          },
        ],
      },
    })
  })

  it('marks despawned records as expired and honours the limit', async () => {
    const s = await setup()
    s.add({ at: START - 400_000 })
    s.add()
    s.add()
    const tool = new ListDeathRecordsTool(s.records, s.clock)

    const result = tool.execute(tool.inputSchema.parse({ limit: 3 }))

    expect(result).toMatchObject({
      ok: true,
      data: {
        records: [
          { id: 'drop-3' },
          { id: 'drop-2' },
          { id: 'drop-1', status: 'expired', secondsLeft: 0 },
        ],
      },
    })
  })
})

describe('SkipDropRecoveryTool', () => {
  it('abandons what is waiting or running and gives the coordinates back', async () => {
    const s = await setup()
    s.add()
    s.add({ kind: 'unclaimed', position: { x: 9, y: 64, z: 9 } })
    s.add({ status: 'recovered' })
    const tool = new SkipDropRecoveryTool(s.records, s.tasks, s.clock)

    const result = await tool.execute({})

    expect(result).toMatchObject({
      ok: true,
      data: {
        skipped: [
          { id: 'drop-1', status: 'abandoned', position: { x: 1, y: 64, z: 2 } },
          { id: 'drop-2', status: 'abandoned', position: { x: 9, y: 64, z: 9 } },
        ],
      },
    })
    expect(s.records.get('drop-3')?.status).toBe('recovered')
    expect(s.records.get('drop-1')?.note).toBe('Skipped on request.')
  })

  it('cancels a running recovery before marking the record', async () => {
    const s = await setup()
    s.add({ status: 'recovering' })
    const seen: string[] = []
    s.tasks.start({
      name: 'recover_drops',
      description: 'Recover',
      run: (ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            // What the real skill does when cancelled: release the record.
            seen.push(s.records.get('drop-1')?.status ?? '')
            s.records.update('drop-1', { status: 'pending' })
            resolve({ ok: false, error: { reason: 'aborted', message: 'Cancelled.' } })
          })
        }),
    })
    const tool = new SkipDropRecoveryTool(s.records, s.tasks, s.clock)

    await tool.execute({ record: 'drop-1' })

    expect(seen).toEqual(['recovering'])
    expect(s.records.get('drop-1')?.status).toBe('abandoned')
    expect(s.tasks.current()).toBeUndefined()
  })

  it('leaves other tasks alone', async () => {
    const s = await setup()
    s.add()
    s.tasks.start({
      name: 'collect_block',
      description: 'x',
      run: () => new Promise(() => undefined),
    })
    const tool = new SkipDropRecoveryTool(s.records, s.tasks, s.clock)

    await tool.execute({})

    expect(s.tasks.current()?.name).toBe('collect_block')
  })

  it('says when there is nothing to skip, or the record is unknown', async () => {
    const s = await setup()
    const tool = new SkipDropRecoveryTool(s.records, s.tasks, s.clock)

    expect(await tool.execute({})).toEqual({
      ok: false,
      error: 'There is no drop recovery waiting or running.',
    })
    expect(await tool.execute({ record: 'drop-7' })).toEqual({
      ok: false,
      error: 'There is no drop record "drop-7".',
    })
  })
})

describe('RecoverDropsTool', () => {
  function tool(s: Awaited<ReturnType<typeof setup>>) {
    const inputs: unknown[] = []
    const skill = {
      name: 'recover_drops',
      run: (input: unknown, _ctx: SkillContext) => {
        inputs.push(input)
        return Promise.resolve(ok('done'))
      },
    }
    return {
      inputs,
      tool: new RecoverDropsTool(skill as unknown as RecoverDropsSkill, s.launcher, s.records),
    }
  }

  it('recovers the newest record that can still be fetched, and can be resumed with its id', async () => {
    const s = await setup()
    s.add({ at: START - 100_000 })
    s.add()
    const { tool: t, inputs } = tool(s)

    const result = await t.execute(t.inputSchema.parse({}), context)

    expect(inputs).toEqual([{ record: 'drop-2', maxAttempts: 2 }])
    expect(result).toMatchObject({
      ok: true,
      data: { description: 'Recover dropped items (drop-2)' },
    })
    expect(s.tasks.get('task-1')?.resume).toEqual({
      tool: 'recover_drops',
      arguments: { record: 'drop-2' },
    })
  })

  it('takes the record and the attempt limit from the call', async () => {
    const s = await setup()
    s.add()
    s.add()
    const { tool: t, inputs } = tool(s)

    await t.execute(t.inputSchema.parse({ record: 'drop-1', max_attempts: 5 }), context)

    expect(inputs).toEqual([{ record: 'drop-1', maxAttempts: 5 }])
  })

  it('still runs when there is no record, so the skill can explain', async () => {
    const s = await setup()
    const { tool: t, inputs } = tool(s)

    await t.execute(t.inputSchema.parse({}), context)

    expect(inputs).toEqual([{ record: undefined, maxAttempts: 2 }])
    expect(s.tasks.get('task-1')?.resume).toBeUndefined()
  })
})
