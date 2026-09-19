import { describe, expect, it } from '@jest/globals'
import { DeathResponder } from '../../../../src/skills/recovery/death-responder.js'
import { DropRecords } from '../../../../src/state/drop-records.js'
import { DropRecoveryPolicy } from '../../../../src/state/drop-recovery-policy.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'
import { FakeDeathWatcher } from '../../../fakes/recovery-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const START = 5_000_000
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

async function setup(options: { attached?: boolean } = {}) {
  const clock = new FakeClock(START)
  const scheduler = new FakeScheduler(clock)
  const watcher = new FakeDeathWatcher()
  const records = new DropRecords(clock)
  const policy = new DropRecoveryPolicy()
  if (options.attached !== false) {
    const store = new InMemoryStateStore()
    await records.attach(store)
    await policy.attach(store)
  }
  const events: { type: string; message: string }[] = []
  const said: string[] = []
  const started: string[] = []
  const log: string[] = []
  const responder = new DeathResponder({
    watcher,
    records,
    policy,
    recovery: {
      start: (id) => {
        started.push(id)
        return Promise.resolve()
      },
    },
    cancelTasks: () => {
      log.push('cancelTasks')
      return Promise.resolve()
    },
    emit: (type, message) => {
      events.push({ type, message })
    },
    say: (text) => {
      said.push(text)
    },
    clock,
    scheduler,
  })
  responder.start()
  /** The bot dies, respawns, and time passes until the responder has finished. */
  const dieAndWait = async (event: Parameters<FakeDeathWatcher['die']>[0] = {}) => {
    watcher.die(event)
    await flush()
    scheduler.advance(2_000) // the inventory settles after the respawn
    await flush()
    scheduler.advance(3_000) // the walk back starts
    await flush()
  }
  return {
    clock,
    scheduler,
    watcher,
    records,
    policy,
    events,
    said,
    started,
    log,
    responder,
    dieAndWait,
  }
}

const CARRIED = [
  { name: 'iron_ingot', count: 20 },
  { name: 'iron_pickaxe', count: 1 },
]

describe('DeathResponder', () => {
  it('records the death, tells the agent and the chat, and goes back for the items', async () => {
    const s = await setup()

    await s.dieAndWait({ carried: CARRIED, cause: 'ClaudeBot was slain by Zombie' })

    expect(s.records.all()).toMatchObject([
      {
        id: 'drop-1',
        kind: 'death',
        position: { x: 100.4, y: 64, z: -20.6 },
        dimension: 'overworld',
        cause: 'ClaudeBot was slain by Zombie',
        at: START,
        lost: CARRIED,
        status: 'pending',
      },
    ])
    expect(s.events).toHaveLength(1)
    expect(s.events[0]?.type).toBe('bot_died')
    expect(s.events[0]?.message).toContain('100, 64, -21 in overworld')
    expect(s.events[0]?.message).toContain('ClaudeBot was slain by Zombie')
    expect(s.events[0]?.message).toContain('20 iron_ingot')
    expect(s.said).toEqual(['I died at 100, 64, -21 in overworld. I am going back for my items.'])
    expect(s.started).toEqual(['drop-1'])
  })

  it('stops the running task first', async () => {
    const s = await setup()

    await s.dieAndWait({ carried: CARRIED })

    expect(s.log).toEqual(['cancelTasks'])
  })

  it('only counts what the respawn did not give back (keepInventory keeps everything)', async () => {
    const s = await setup()
    s.watcher.carriedNow = [{ name: 'iron_pickaxe', count: 1 }] // the pickaxe was kept

    await s.dieAndWait({ carried: CARRIED })

    expect(s.records.all()[0]?.lost).toEqual([{ name: 'iron_ingot', count: 20 }])
  })

  it('notes that nothing was lost, and does not go anywhere, with keepInventory', async () => {
    const s = await setup()
    s.watcher.carriedNow = [...CARRIED]

    await s.dieAndWait({ carried: CARRIED })

    expect(s.records.all()).toEqual([])
    expect(s.started).toEqual([])
    expect(s.events[0]?.message).toContain('kept its inventory')
    expect(s.said[0]).toContain('I kept my things')
  })

  it('does not wait for the respawn to settle before the death spot is noted', async () => {
    const s = await setup()

    s.watcher.die({ carried: CARRIED })
    await flush()

    expect(s.log).toEqual(['cancelTasks']) // reacted at once
    expect(s.records.all()).toEqual([]) // but the record waits for the inventory to settle
  })

  it('leaves the items and says where they are when the policy is skip', async () => {
    const s = await setup()
    s.policy.set({ death: 'skip' })

    await s.dieAndWait({ carried: CARRIED })

    expect(s.records.all()[0]).toMatchObject({
      status: 'abandoned',
      note: 'The drop recovery policy is skip.',
    })
    expect(s.started).toEqual([])
    expect(s.events[0]?.message).toContain('Recovery is off (policy skip)')
    expect(s.events[0]?.message).toContain('100, 64, -21')
    expect(s.said[0]).toContain('My items are there')
  })

  it('does not go back on its own when it died while recovering', async () => {
    const s = await setup()
    await s.dieAndWait({ carried: CARRIED })
    s.records.update('drop-1', { status: 'recovering', attempts: 1 })
    s.started.length = 0
    s.events.length = 0

    await s.dieAndWait({
      carried: [{ name: 'iron_ingot', count: 3 }],
      position: { x: 101, y: 64, z: -20 },
    })

    expect(s.records.get('drop-1')?.status).toBe('pending') // released, not stuck
    expect(s.records.get('drop-2')).toMatchObject({ status: 'pending' })
    expect(s.started).toEqual([])
    expect(s.events[0]?.message).toContain('died while recovering an earlier drop (drop-1)')
    expect(s.events[0]?.message).toContain('will not go back on its own')
  })

  it('keeps what an interrupted recovery had already picked up', async () => {
    const s = await setup()
    await s.dieAndWait({ carried: CARRIED })
    s.records.update('drop-1', {
      status: 'recovering',
      recovered: [{ name: 'iron_ingot', count: 5 }],
    })

    await s.dieAndWait({ carried: [{ name: 'iron_ingot', count: 5 }] })

    expect(s.records.get('drop-1')?.status).toBe('partial')
  })

  it('says so when no world profile is active, since nothing can be saved', async () => {
    const s = await setup({ attached: false })

    await s.dieAndWait({ carried: CARRIED })

    expect(s.records.all()).toEqual([])
    expect(s.started).toEqual([])
    expect(s.events[0]?.message).toContain('could not be recorded')
    expect(s.events[0]?.message).toContain('20 iron_ingot')
  })

  it('names an unknown cause plainly', async () => {
    const s = await setup()

    await s.dieAndWait({ carried: CARRIED })

    expect(s.events[0]?.message.startsWith('The bot died at')).toBe(true)
  })

  it('stops listening when stopped, and does not listen twice when started twice', async () => {
    const s = await setup()
    s.responder.start()
    expect(s.watcher.listening).toBe(1)

    s.responder.stop()

    expect(s.watcher.listening).toBe(0)
    await s.dieAndWait({ carried: CARRIED })
    expect(s.records.all()).toEqual([])
  })
})
