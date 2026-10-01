import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import { DeathResponder } from '../../../../src/skills/recovery/death-responder.js'
import { BedRegistry } from '../../../../src/state/bed-registry.js'
import { DropRecords } from '../../../../src/state/drop-records.js'
import { DropRecoveryPolicy } from '../../../../src/state/drop-recovery-policy.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'
import { FakeDeathWatcher } from '../../../fakes/recovery-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const BED: Position = { x: 50, y: 64, z: 50 }

async function setup(where: { position: Position; dimension: string } | undefined) {
  const clock = new FakeClock(0)
  const scheduler = new FakeScheduler(clock)
  const watcher = new FakeDeathWatcher()
  const store = new InMemoryStateStore()
  const beds = new BedRegistry(clock)
  const records = new DropRecords(clock)
  const policy = new DropRecoveryPolicy()
  await Promise.all([beds.attach(store), records.attach(store), policy.attach(store)])
  beds.setRespawn(BED, 'red')
  const events: { type: string; message: string }[] = []
  const responder = new DeathResponder({
    watcher,
    records,
    policy,
    recovery: { start: () => Promise.resolve() },
    cancelTasks: () => Promise.resolve(),
    emit: (type, message) => events.push({ type, message }),
    say: () => undefined,
    beds,
    whereIsBot: () => where,
    clock,
    scheduler,
  })
  responder.start()
  const die = async (): Promise<void> => {
    watcher.die({ carried: [{ name: 'iron_ingot', count: 3 }] })
    await flush()
    scheduler.advance(2_000)
    await flush()
  }
  return { beds, events, die }
}

describe('DeathResponder and the respawn point', () => {
  it('says nothing when the bot wakes up at its bed', async () => {
    const s = await setup({ position: { x: 51, y: 64, z: 49 }, dimension: 'overworld' })

    await s.die()

    expect(s.events.map((e) => e.type)).not.toContain('respawn_point_lost')
    expect(s.beds.respawn()).toBeDefined()
  })

  it('notices a bed that was destroyed or blocked, and corrects the record', async () => {
    const s = await setup({ position: { x: 0, y: 70, z: 0 }, dimension: 'overworld' })

    await s.die()

    const lost = s.events.find((e) => e.type === 'respawn_point_lost')
    expect(lost?.message).toContain('50, 64, 50')
    expect(s.beds.respawn()).toBeUndefined()
    expect(s.beds.all()[0]).toMatchObject({ intact: false, respawn: false })
  })

  it('does not judge the respawn from another dimension or before the position is known', async () => {
    const nether = await setup({ position: { x: 0, y: 70, z: 0 }, dimension: 'the_nether' })
    await nether.die()
    const unknown = await setup(undefined)
    await unknown.die()

    expect(nether.beds.respawn()).toBeDefined()
    expect(unknown.beds.respawn()).toBeDefined()
    expect([...nether.events, ...unknown.events].map((e) => e.type)).not.toContain(
      'respawn_point_lost',
    )
  })
})
