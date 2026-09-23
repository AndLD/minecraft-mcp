import { describe, expect, it } from '@jest/globals'
import type { AnimalInfo, AnimalScanner } from '../../../../src/core/animal-scanner.port.js'
import type { InventoryWriter } from '../../../../src/core/inventory-writer.port.js'
import type { Position } from '../../../../src/core/position.types.js'
import { ok } from '../../../../src/core/result.js'
import type { SkillResult } from '../../../../src/core/skill.types.js'
import { penCapacity } from '../../../../src/skills/farming/providers/animal-pen.js'
import { CollectEggsSkill } from '../../../../src/skills/farming/collect-eggs-skill.js'
import { EggThrower } from '../../../../src/skills/farming/egg-thrower.js'
import { DropCollector } from '../../../../src/skills/gathering/drop-collector.js'
import type {
  DepositInput,
  DepositOutput,
  ItemDepositor,
} from '../../../../src/skills/storage/deposit-items-skill.js'
import { EggPolicy } from '../../../../src/state/egg-policy.js'
import { FarmRegistry } from '../../../../src/state/farm-registry.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeInventory, FakeVitals } from '../../../fakes/fake-ports.js'
import {
  AutoScheduler,
  FakeAreaGuard,
  FakeDroppedItems,
  InstantNavigator,
  skillContext,
} from '../../../fakes/gathering-fakes.js'
import { FakeGaze } from '../../../fakes/handover-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })
const bounds = (x0: number, z0: number, x1: number, z1: number) => ({
  from: at(x0, 64, z0),
  to: at(x1, 66, z1),
})

class FakeAnimalScanner implements AnimalScanner {
  animals: AnimalInfo[] = []
  nearby(): readonly AnimalInfo[] {
    return this.animals
  }
  find(id: number): AnimalInfo | undefined {
    return this.animals.find((a) => a.id === id)
  }
}

const chicken = (id: number, position: Position): AnimalInfo => ({
  id,
  species: 'chicken',
  position,
  distance: 1,
  baby: false,
  named: false,
  owned: false,
  saddled: false,
  ridden: false,
  dead: false,
})

class FakeThrowWriter implements InventoryWriter {
  readonly tosses: { item: string; count: number }[] = []
  toss(item: string, count: number): Promise<number> {
    this.tosses.push({ item, count })
    return Promise.resolve(count)
  }
}

class FakeDepositor implements ItemDepositor {
  readonly calls: DepositInput[] = []
  run(input: DepositInput): Promise<SkillResult<DepositOutput>> {
    this.calls.push(input)
    return Promise.resolve(ok({ deposited: [], leftover: [] }))
  }
}

async function setup(here: Position = at(0, 64, 0)) {
  const clock = new FakeClock(0)
  const drops = new FakeDroppedItems()
  const navigator = new InstantNavigator()
  const inventory = new FakeInventory()
  inventory.value = { stacks: [], emptySlots: 30, heldItem: undefined }
  navigator.onArrive = (target) => {
    for (const item of drops.items) {
      if (Math.hypot(item.position.x - target.x, item.position.z - target.z) > 1) continue
      inventory.value = {
        stacks: [...(inventory.value?.stacks ?? []), { name: item.name, count: item.count }],
        emptySlots: inventory.value?.emptySlots ?? 0,
        heldItem: undefined,
      }
      drops.remove(item.entityId)
    }
  }
  const collector = new DropCollector({ drops, navigator, scheduler: new AutoScheduler(clock) })
  const vitals = new FakeVitals()
  vitals.vitals = {
    health: 20,
    food: 20,
    saturation: 5,
    oxygen: 20,
    inLava: false,
    inWater: false,
    headUnderwater: false,
    position: here,
    dimension: 'overworld',
    timeOfDay: 0,
  }
  const animals = new FakeAnimalScanner()
  const guard = new FakeAreaGuard()
  const depositor = new FakeDepositor()
  const writer = new FakeThrowWriter()
  const thrower = new EggThrower({ gaze: new FakeGaze(), writer, scheduler: new AutoScheduler(clock) })
  const policy = new EggPolicy()
  await policy.attach(new InMemoryStateStore())
  const farms = new FarmRegistry(clock)
  await farms.attach(new InMemoryStateStore())
  const skill = new CollectEggsSkill({
    drops: collector,
    inventory,
    vitals,
    animals,
    guard,
    depositor,
    thrower,
    policy,
    farms,
  })
  return { drops, navigator, inventory, vitals, animals, guard, depositor, writer, thrower, policy, farms, skill }
}

describe('CollectEggsSkill', () => {
  it('picks up eggs in a pen, stores a share, and throws the rest in for chicks', async () => {
    const s = await setup()
    const farm = s.farms.register({ kind: 'pen', species: 'chicken', herdTarget: 20, bounds: bounds(0, 0, 10, 10) })
    if (!farm.ok) throw new Error(farm.error)
    s.drops.drop('egg', at(5, 64, 5), 2, 10)
    s.animals.animals = [chicken(1, at(2, 64, 2)), chicken(2, at(3, 64, 3))]

    const result = await s.skill.run(
      { farm: farm.value.id, area: undefined, storeFraction: undefined, release: undefined, maxChickens: undefined },
      skillContext().context,
    )

    expect(result).toEqual({ ok: true, value: { pickedUp: 10, stored: 1, released: 9, penFull: false } })
    expect(s.depositor.calls).toEqual([
      { specs: ['egg'], includeReserved: false, container: undefined, count: 1, maxDistance: 64 },
    ])
    expect(s.writer.tosses).toHaveLength(9)
  })

  it('stores everything and throws none when the policy says "store"', async () => {
    const s = await setup()
    s.drops.drop('egg', at(2, 64, 2), 2, 6)

    const result = await s.skill.run(
      { farm: undefined, area: bounds(0, 0, 5, 5), storeFraction: undefined, release: 'store', maxChickens: undefined },
      skillContext().context,
    )

    expect(result).toEqual({ ok: true, value: { pickedUp: 6, stored: 6, released: 0, penFull: false } })
    expect(s.writer.tosses).toEqual([])
    expect(s.depositor.calls).toEqual([
      { specs: ['egg'], includeReserved: false, container: undefined, count: 6, maxDistance: 64 },
    ])
  })

  it('stops releasing once the pen already holds its target chicken count (penFull)', async () => {
    const s = await setup()
    const farm = s.farms.register({ kind: 'pen', species: 'chicken', herdTarget: 2, bounds: bounds(0, 0, 10, 10) })
    if (!farm.ok) throw new Error(farm.error)
    s.drops.drop('egg', at(5, 64, 5), 2, 5)
    s.animals.animals = [chicken(1, at(2, 64, 2)), chicken(2, at(3, 64, 3))]

    const result = await s.skill.run(
      { farm: farm.value.id, area: undefined, storeFraction: undefined, release: undefined, maxChickens: undefined },
      skillContext().context,
    )

    expect(result).toEqual({ ok: true, value: { pickedUp: 5, stored: 5, released: 0, penFull: true } })
    expect(s.writer.tosses).toEqual([])
  })

  it('an explicit max_chickens overrides the farm herd target', async () => {
    const s = await setup()
    const farm = s.farms.register({ kind: 'pen', species: 'chicken', herdTarget: 20, bounds: bounds(0, 0, 10, 10) })
    if (!farm.ok) throw new Error(farm.error)
    s.drops.drop('egg', at(5, 64, 5), 2, 10)

    const result = await s.skill.run(
      { farm: farm.value.id, area: undefined, storeFraction: undefined, release: undefined, maxChickens: 0 },
      skillContext().context,
    )

    expect(result).toEqual({ ok: true, value: { pickedUp: 10, stored: 10, released: 0, penFull: true } })
  })

  it('falls back to a rough pen capacity when no farm or max_chickens is given', async () => {
    const s = await setup()
    s.drops.drop('egg', at(2, 64, 2), 2, 3)

    const result = await s.skill.run(
      { farm: undefined, area: bounds(0, 0, 3, 3), storeFraction: undefined, release: undefined, maxChickens: undefined },
      skillContext().context,
    )

    expect(result).toEqual({ ok: true, value: { pickedUp: 3, stored: 1, released: 2, penFull: false } })
    expect(penCapacity(4, 4)).toBeGreaterThan(0) // sanity: the fallback capacity is nonzero for this area's size
  })

  it('never picks up an egg inside a protected area that is not the pen\'s own', async () => {
    const s = await setup()
    const farm = s.farms.register({
      kind: 'pen',
      species: 'chicken',
      herdTarget: 20,
      bounds: bounds(0, 0, 10, 10),
      label: 'coop',
    })
    if (!farm.ok) throw new Error(farm.error)
    s.guard.protect('coop', (p) => p.x <= 5)
    s.guard.protect('someone else\'s build', (p) => p.x > 5)
    s.drops.drop('egg', at(2, 64, 2), 2, 1) // inside the pen's own protected area: allowed
    s.drops.drop('egg', at(8, 64, 2), 2, 1) // inside a different protected area: skipped

    const result = await s.skill.run(
      { farm: farm.value.id, area: undefined, storeFraction: undefined, release: undefined, maxChickens: undefined },
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { pickedUp: 1 } })
  })

  it('reports nothing picked up without depositing or throwing anything', async () => {
    const s = await setup()

    const result = await s.skill.run(
      { farm: undefined, area: bounds(0, 0, 5, 5), storeFraction: undefined, release: undefined, maxChickens: undefined },
      skillContext().context,
    )

    expect(result).toEqual({ ok: true, value: { pickedUp: 0, stored: 0, released: 0, penFull: false } })
    expect(s.depositor.calls).toEqual([])
    expect(s.writer.tosses).toEqual([])
  })

  it('fails with no_area when neither a farm nor an area is given', async () => {
    const s = await setup()

    const result = await s.skill.run(
      { farm: undefined, area: undefined, storeFraction: undefined, release: undefined, maxChickens: undefined },
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_area' } })
  })

  it('fails with not_connected when the bot has no position', async () => {
    const s = await setup()
    s.vitals.vitals = undefined

    const result = await s.skill.run(
      { farm: undefined, area: bounds(0, 0, 5, 5), storeFraction: undefined, release: undefined, maxChickens: undefined },
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'not_connected' } })
  })
})
