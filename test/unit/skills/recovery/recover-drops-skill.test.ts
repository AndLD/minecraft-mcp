import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import { DropCollector } from '../../../../src/skills/gathering/drop-collector.js'
import { DropIgnoreList } from '../../../../src/skills/recovery/drop-ignore-list.js'
import { HazardAssessor } from '../../../../src/skills/recovery/hazard-assessor.js'
import {
  ABANDON,
  RecoverDropsSkill,
  TRY_CAREFULLY,
  type RecoverInput,
} from '../../../../src/skills/recovery/recover-drops-skill.js'
import { DropRecords, type NewDropRecord } from '../../../../src/state/drop-records.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import {
  buildVitals,
  FakeBlockScanner,
  FakeEntityScanner,
  FakeInventory,
  FakeVitals,
} from '../../../fakes/fake-ports.js'
import { AutoScheduler, InstantNavigator } from '../../../fakes/gathering-fakes.js'
import { askingContext, GroundItems } from '../../../fakes/recovery-fakes.js'
import { FakeCombatant } from '../../../fakes/reflex-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const SPOT: Position = { x: 100, y: 64, z: 100 }
const START = 1_000_000
const key = (x: number, y: number, z: number): string => `${String(x)},${String(y)},${String(z)}`

async function setup() {
  const clock = new FakeClock(START)
  const scheduler = new AutoScheduler(clock)
  const records = new DropRecords(clock)
  await records.attach(new InMemoryStateStore())
  const inventory = new FakeInventory()
  inventory.value = { stacks: [], emptySlots: 30, heldItem: undefined }
  const vitals = new FakeVitals()
  vitals.vitals = buildVitals({ position: { x: 100, y: 64, z: 160 }, dimension: 'overworld' })
  const ground = new GroundItems()
  const navigator = new InstantNavigator()
  navigator.onArrive = (target) => {
    // Like GoalNear, the bot stops `within` blocks short of the target.
    const within = navigator.trips.at(-1)?.within ?? 0
    const stopped = within > 1 ? { ...target, x: target.x - within } : target
    ground.arriveAt(stopped, inventory)
    if (vitals.vitals !== undefined) vitals.vitals = { ...vitals.vitals, position: stopped }
  }
  const blocks = new FakeBlockScanner()
  for (let dy = 1; dy <= 24; dy += 1) blocks.solid.set(key(100, 64 - dy, 100), true)
  const entities = new FakeEntityScanner()
  const combatant = new FakeCombatant()
  const ignore = new DropIgnoreList(clock)
  const skill = new RecoverDropsSkill({
    records,
    inventory,
    vitals,
    navigator,
    collector: new DropCollector({ drops: ground, navigator, scheduler }),
    hazards: new HazardAssessor(blocks, entities),
    combatant,
    ignore,
    clock,
    scheduler,
  })
  const death = (extra: Partial<NewDropRecord> = {}) => {
    const added = records.add({
      kind: 'death',
      position: SPOT,
      dimension: 'overworld',
      at: START - 30_000,
      cause: null,
      lost: [
        { name: 'iron_ingot', count: 5 },
        { name: 'stick', count: 3 },
      ],
      note: null,
      ...extra,
    })
    if (!added.ok) throw new Error(added.error)
    return added.value
  }
  const scatter = () => {
    ground.drop('iron_ingot', { x: 100, y: 64, z: 100 }, 5)
    ground.drop('stick', { x: 102, y: 64, z: 99 }, 3)
  }
  return {
    clock,
    records,
    inventory,
    vitals,
    ground,
    navigator,
    blocks,
    entities,
    combatant,
    ignore,
    skill,
    death,
    scatter,
  }
}

const go = (id?: string, maxAttempts = 2): RecoverInput => ({ record: id, maxAttempts })
const answers = (...replies: (string | undefined)[]) => askingContext(...replies)

describe('RecoverDropsSkill: getting the items back', () => {
  it('walks to the death spot, picks up everything that scattered, and reports it', async () => {
    const s = await setup()
    s.death()
    s.scatter()
    const { context } = answers()

    const result = await s.skill.run(go(), context)

    expect(result).toMatchObject({
      ok: true,
      value: {
        record: 'drop-1',
        kind: 'death',
        status: 'recovered',
        recovered: [
          { name: 'iron_ingot', count: 5 },
          { name: 'stick', count: 3 },
        ],
        missing: [],
      },
    })
    expect(s.records.get('drop-1')).toMatchObject({ status: 'recovered', attempts: 1 })
    expect(s.navigator.trips[0]).toEqual({ target: SPOT, within: 6 }) // stages first
  })

  it('puts armor, weapon, and shield on after the pickup', async () => {
    const s = await setup()
    s.death()
    s.scatter()
    s.combatant.gear = { weapon: 'iron_sword', armor: ['iron_helmet', 'shield'] }

    const result = await s.skill.run(go(), answers().context)

    expect(s.combatant.gearCalls).toBe(1)
    expect(result).toMatchObject({
      ok: true,
      value: { gear: { weapon: 'iron_sword', armor: ['iron_helmet', 'shield'] } },
    })
  })

  it('reports what is still missing when only part of it is there', async () => {
    const s = await setup()
    s.death()
    s.ground.drop('iron_ingot', SPOT, 2)

    const result = await s.skill.run(go(), answers().context)

    expect(result).toMatchObject({
      ok: true,
      value: {
        status: 'partial',
        recovered: [{ name: 'iron_ingot', count: 2 }],
        missing: [
          { name: 'iron_ingot', count: 3 },
          { name: 'stick', count: 3 },
        ],
      },
    })
    expect(s.records.get('drop-1')?.status).toBe('partial')
  })

  it('adds up over attempts: a second trip only has to find the rest', async () => {
    const s = await setup()
    s.death()
    s.ground.drop('iron_ingot', SPOT, 5)
    await s.skill.run(go(), answers().context)
    s.ground.drop('stick', SPOT, 3)

    const result = await s.skill.run(go('drop-1'), answers().context)

    expect(result).toMatchObject({ ok: true, value: { status: 'recovered', missing: [] } })
    expect(s.records.get('drop-1')).toMatchObject({ attempts: 2 })
  })

  it('does not pick up things the bot threw away on purpose', async () => {
    const s = await setup()
    s.death({ lost: [{ name: 'iron_ingot', count: 5 }] })
    s.ground.drop('iron_ingot', SPOT, 5)
    s.ground.drop('rotten_flesh', { x: 101, y: 64, z: 100 }, 8)
    s.ignore.add([{ name: 'rotten_flesh', count: 8 }], { x: 101, y: 64, z: 100 })

    const result = await s.skill.run(go(), answers().context)

    expect(result).toMatchObject({
      ok: true,
      value: { recovered: [{ name: 'iron_ingot', count: 5 }] },
    })
    expect(s.ground.items.map((i) => i.name)).toEqual(['rotten_flesh'])
  })

  it('leaves items far from the spot alone', async () => {
    const s = await setup()
    s.death({ lost: [{ name: 'iron_ingot', count: 5 }] })
    s.ground.drop('iron_ingot', SPOT, 5)
    s.ground.drop('iron_ingot', { x: 100, y: 64, z: 130 }, 9) // somebody else's

    const result = await s.skill.run(go(), answers().context)

    expect(result).toMatchObject({
      ok: true,
      value: { recovered: [{ name: 'iron_ingot', count: 5 }] },
    })
  })

  it('picks the newest record that can still be fetched when none is named', async () => {
    const s = await setup()
    s.death({ at: START - 60_000 })
    s.death({ position: { x: 100, y: 64, z: 100 }, at: START - 10_000 })
    s.scatter()

    const result = await s.skill.run(go(), answers().context)

    expect(result).toMatchObject({ ok: true, value: { record: 'drop-2' } })
  })
})

describe('RecoverDropsSkill: when not to go', () => {
  it('says there is nothing to recover without a record, or with an unknown one', async () => {
    const s = await setup()

    expect(await s.skill.run(go(), answers().context)).toMatchObject({
      ok: false,
      error: { reason: 'no_record' },
    })
    expect(await s.skill.run(go('drop-9'), answers().context)).toMatchObject({
      ok: false,
      error: { reason: 'no_record', message: 'There is no drop record "drop-9".' },
    })
  })

  it('needs a connection', async () => {
    const s = await setup()
    s.death()
    s.vitals.vitals = undefined

    expect(await s.skill.run(go(), answers().context)).toMatchObject({
      ok: false,
      error: { reason: 'not_connected' },
    })
  })

  it('will not go for items that have despawned, and marks the record', async () => {
    const s = await setup()
    s.death({ at: START - 300_000 })

    const result = await s.skill.run(go('drop-1'), answers().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'expired' } })
    expect(s.records.get('drop-1')?.status).toBe('expired')
    expect(s.navigator.trips).toEqual([])
  })

  it('says so instead of trying when it cannot get there before the items vanish', async () => {
    const s = await setup()
    s.death({ position: { x: 100, y: 64, z: 1200 }, at: START - 100_000 })

    const result = await s.skill.run(go('drop-1'), answers().context)

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'too_far', detail: { etaSeconds: 308, secondsLeft: 200 } },
    })
    expect(s.records.get('drop-1')).toMatchObject({ status: 'pending', attempts: 0 })
    expect(s.navigator.trips).toEqual([])
  })

  it('will not cross dimensions', async () => {
    const s = await setup()
    s.death({ dimension: 'the_nether' })

    expect(await s.skill.run(go(), answers().context)).toMatchObject({
      ok: false,
      error: { reason: 'wrong_dimension' },
    })
  })

  it('stops after the maximum number of attempts, unless the limit is raised', async () => {
    const s = await setup()
    s.death()
    s.records.update('drop-1', { attempts: 2 })
    s.scatter()

    const refused = await s.skill.run(go('drop-1'), answers().context)
    const allowed = await s.skill.run(go('drop-1', 3), answers().context)

    expect(refused).toMatchObject({
      ok: false,
      error: { reason: 'max_attempts', detail: { position: SPOT } },
    })
    expect(allowed.ok).toBe(true)
  })

  it.each(['recovered', 'gone'] as const)(
    'has nothing left to do for a %s record',
    async (status) => {
      const s = await setup()
      s.death({ status })

      expect(await s.skill.run(go('drop-1'), answers().context)).toMatchObject({
        ok: false,
        error: { reason: 'nothing_left' },
      })
    },
  )

  it('does not start a second recovery for a record that is being recovered', async () => {
    const s = await setup()
    s.death({ status: 'recovering' })

    expect(await s.skill.run(go('drop-1'), answers().context)).toMatchObject({
      ok: false,
      error: { reason: 'already_recovering' },
    })
  })
})

describe('RecoverDropsSkill: dangerous places', () => {
  it('asks the player when the spot has lava next to it, and names the risk', async () => {
    const s = await setup()
    s.death()
    s.scatter()
    s.blocks.blockNames.set(key(101, 64, 100), 'lava')
    const asked = answers(TRY_CAREFULLY)

    const result = await s.skill.run(go(), asked.context)

    expect(asked.prompts).toHaveLength(1)
    expect(asked.prompts[0]?.message).toContain('lava within 2 blocks')
    expect(asked.prompts[0]?.options).toEqual([TRY_CAREFULLY, ABANDON])
    expect(result.ok).toBe(true)
  })

  it('leaves the items and keeps the coordinates when the player says to abandon', async () => {
    const s = await setup()
    s.death()
    s.scatter()
    s.blocks.blockNames.set(key(101, 64, 100), 'lava')

    const result = await s.skill.run(go(), answers(ABANDON).context)

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'abandoned', detail: { position: SPOT, hazards: ['lava within 2 blocks'] } },
    })
    expect(s.records.get('drop-1')).toMatchObject({ status: 'abandoned' })
    expect(s.ground.items).toHaveLength(2) // nothing was picked up
    expect(s.navigator.trips).toHaveLength(1) // it never went closer than the staging point
  })

  it('treats a cancelled question as a no', async () => {
    const s = await setup()
    s.death()
    s.blocks.blockNames.set(key(101, 64, 100), 'lava')

    const result = await s.skill.run(go(), answers(undefined).context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'abandoned' } })
  })

  it('does not go where nobody can be asked', async () => {
    const s = await setup()
    s.death()
    s.blocks.blockNames.set(key(101, 64, 100), 'lava')
    const controller = new AbortController()

    const result = await s.skill.run(go(), { signal: controller.signal, progress: () => undefined })

    expect(result).toMatchObject({ ok: false, error: { reason: 'abandoned' } })
    expect(s.records.get('drop-1')?.status).toBe('abandoned')
  })

  it('asks about hostile mobs at the spot too', async () => {
    const s = await setup()
    s.death()
    s.entities.entities = [
      {
        id: 7,
        category: 'hostile',
        name: 'zombie',
        position: { x: 103, y: 64, z: 100 },
        distance: 10,
      },
    ]
    const asked = answers(ABANDON)

    await s.skill.run(go(), asked.context)

    expect(asked.prompts[0]?.message).toContain('hostile mobs: 1 zombie')
  })

  it('does not ask when the spot is safe', async () => {
    const s = await setup()
    s.death()
    s.scatter()
    const asked = answers()

    await s.skill.run(go(), asked.context)

    expect(asked.prompts).toEqual([])
  })
})

describe('RecoverDropsSkill: things going wrong', () => {
  it('gives the record back when the spot cannot be reached', async () => {
    const s = await setup()
    s.death()
    s.navigator.failures = [{ reason: 'unreachable', message: 'no path' }]

    const result = await s.skill.run(go(), answers().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'unreachable' } })
    expect(s.records.get('drop-1')).toMatchObject({ status: 'pending', attempts: 1 })
  })

  it('reports items it cannot get to', async () => {
    const s = await setup()
    s.death()
    s.scatter()
    s.navigator.failures = [
      undefined,
      undefined,
      undefined, // the nearest item
      ...Array.from({ length: 20 }, () => ({ reason: 'unreachable' as const, message: 'lava' })),
    ]

    const result = await s.skill.run(go(), answers().context)

    // The ingots are picked up; the scattered stick is out of reach.
    expect(result).toMatchObject({ ok: true, value: { status: 'partial' } })
    expect(s.ground.items.map((i) => i.name)).toEqual(['stick'])
  })

  it('says the items are out of reach when nothing could be taken', async () => {
    const s = await setup()
    s.death({ lost: [{ name: 'stick', count: 3 }] })
    s.ground.drop('stick', { x: 102, y: 64, z: 99 }, 3)
    s.navigator.failures = [
      undefined,
      undefined,
      ...Array.from({ length: 20 }, () => ({ reason: 'unreachable' as const, message: 'lava' })),
    ]

    const result = await s.skill.run(go(), answers().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'unreachable' } })
    expect(s.records.get('drop-1')?.status).toBe('pending')
  })

  it('says the inventory is full when that is why nothing was taken', async () => {
    const s = await setup()
    s.death()
    s.scatter()
    s.inventory.value = { stacks: [], emptySlots: 0, heldItem: undefined }
    s.ground.capacity = 0 // nothing fits

    const result = await s.skill.run(go(), answers().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'inventory_full' } })
  })

  it('reports that nothing was found when the spot is empty', async () => {
    const s = await setup()
    s.death()

    const result = await s.skill.run(go(), answers().context)

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'nothing_found', detail: { position: SPOT } },
    })
    expect(s.records.get('drop-1')?.status).toBe('pending')
  })

  it('is never left "recovering" when cancelled, and keeps what it had picked up', async () => {
    const s = await setup()
    s.death()
    s.scatter()
    const { context, controller } = answers()
    // The player says stop right after the first pickup.
    s.navigator.onArrive = (target) => {
      const within = s.navigator.trips.at(-1)?.within ?? 0
      s.ground.arriveAt(within > 1 ? { ...target, x: target.x - within } : target, s.inventory)
      if (s.ground.items.length < 2) controller.abort()
    }

    const result = await s.skill.run(go(), context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    expect(s.records.get('drop-1')).toMatchObject({
      status: 'partial',
      recovered: [{ name: 'iron_ingot', count: 5 }],
    })
  })

  it('is cancelled before it starts walking', async () => {
    const s = await setup()
    s.death()
    const { context, controller } = answers()
    controller.abort()

    const result = await s.skill.run(go(), context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    expect(s.records.get('drop-1')?.status).toBe('pending')
  })
})

describe('RecoverDropsSkill: items nobody picked up', () => {
  async function unclaimed() {
    const s = await setup()
    s.death({
      kind: 'unclaimed',
      lost: [{ name: 'iron_ingot', count: 5 }],
      at: START - 60_000,
    })
    return s
  }

  it('takes back what was thrown, and only that', async () => {
    const s = await unclaimed()
    s.ground.drop('iron_ingot', SPOT, 5)
    s.ground.drop('cobblestone', { x: 101, y: 64, z: 100 }, 20)

    const result = await s.skill.run(go(), answers().context)

    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: 'unclaimed',
        status: 'recovered',
        recovered: [{ name: 'iron_ingot', count: 5 }],
      },
    })
    expect(s.ground.items.map((i) => i.name)).toEqual(['cobblestone'])
  })

  it('says the items are gone when somebody took them', async () => {
    const s = await unclaimed()

    const result = await s.skill.run(go(), answers().context)

    expect(result).toMatchObject({ ok: true, value: { status: 'gone', recovered: [] } })
    expect(s.records.get('drop-1')?.status).toBe('gone')
  })
})
