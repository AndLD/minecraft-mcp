import { describe, expect, it } from '@jest/globals'
import type { CropAccess, CropState } from '../../../../src/core/crop.port.js'
import type { DigFailure, Digger, DigAssessment } from '../../../../src/core/digger.port.js'
import type { NavigationFailure, Navigator } from '../../../../src/core/navigator.port.js'
import type { PlaceFailure, Placer } from '../../../../src/core/placer.port.js'
import type { Position } from '../../../../src/core/position.types.js'
import { err, ok, type Result } from '../../../../src/core/result.js'
import { DropCollector } from '../../../../src/skills/gathering/drop-collector.js'
import { HarvestCropsSkill } from '../../../../src/skills/farming/harvest-crops-skill.js'
import { FarmRegistry } from '../../../../src/state/farm-registry.js'
import { FakeBlockScanner, FakeInventory } from '../../../fakes/fake-ports.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { AutoScheduler, FakeDroppedItems } from '../../../fakes/gathering-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const context = () => ({ signal: new AbortController().signal, progress: () => undefined })
const at = (x: number, y: number, z: number): Position => ({ x, y, z })

class AutoNavigator implements Navigator {
  readonly calls: Position[] = []
  fail: NavigationFailure | undefined
  goToPosition(target: Position): Promise<Result<Position, NavigationFailure>> {
    this.calls.push(target)
    return Promise.resolve(this.fail === undefined ? ok(target) : err(this.fail))
  }
  goToPlayer(): Promise<Result<Position, NavigationFailure>> {
    return Promise.resolve(ok({ x: 0, y: 0, z: 0 }))
  }
  follow(): Promise<Result<void, NavigationFailure>> {
    return Promise.resolve(ok(undefined))
  }
}

class FakeCropAccess implements CropAccess {
  readonly crops = new Map<string, CropState>()
  set(position: Position, state: CropState): void {
    this.crops.set(`${String(position.x)},${String(position.y)},${String(position.z)}`, state)
  }
  stateAt(position: Position): CropState | undefined {
    return this.crops.get(`${String(position.x)},${String(position.y)},${String(position.z)}`)
  }
}

class FakeDigger implements Digger {
  readonly dug: Position[] = []
  assess(): DigAssessment | undefined {
    return {
      blockName: 'wheat',
      diggable: true,
      requiredTools: [],
      canHarvest: true,
      tool: undefined,
    }
  }
  dig(position: Position): Promise<Result<void, DigFailure>> {
    this.dug.push(position)
    return Promise.resolve(ok(undefined))
  }
}

class FakePlacer implements Placer {
  readonly placed: { item: string; at: Position }[] = []
  placeAt(itemName: string, target: Position): Promise<Result<void, PlaceFailure>> {
    this.placed.push({ item: itemName, at: target })
    return Promise.resolve(ok(undefined))
  }
  placeAgainst(): Promise<Result<void, PlaceFailure>> {
    return Promise.resolve(ok(undefined))
  }
}

function setup() {
  const blocks = new FakeBlockScanner()
  const crops = new FakeCropAccess()
  const navigator = new AutoNavigator()
  const digger = new FakeDigger()
  const placer = new FakePlacer()
  const inventory = new FakeInventory()
  inventory.value = { stacks: [], emptySlots: 30, heldItem: undefined }
  const clock = new FakeClock(0)
  const scheduler = new AutoScheduler(clock)
  const drops = new DropCollector({ drops: new FakeDroppedItems(), navigator, scheduler })
  const farms = new FarmRegistry(clock)
  const skill = new HarvestCropsSkill({
    blocks,
    crops,
    navigator,
    digger,
    placer,
    drops,
    inventory,
    farms,
  })
  return { blocks, crops, navigator, digger, placer, inventory, farms, skill }
}

const area = { from: at(0, 64, 0), to: at(1, 64, 0) }

describe('HarvestCropsSkill', () => {
  it('harvests only fully grown crops', async () => {
    const s = setup()
    s.crops.set(at(0, 65, 0), { name: 'wheat', age: 7 })
    s.crops.set(at(1, 65, 0), { name: 'wheat', age: 3 })

    const result = await s.skill.run({ farm: undefined, area, replant: false }, context())

    expect(result).toEqual({ ok: true, value: { harvested: 1, replanted: 0 } })
    expect(s.digger.dug).toEqual([at(0, 65, 0)])
  })

  it('replants at once, keeping a seed in reserve', async () => {
    const s = setup()
    s.crops.set(at(0, 65, 0), { name: 'wheat', age: 7 })
    s.inventory.value = {
      stacks: [{ name: 'wheat_seeds', count: 5 }],
      emptySlots: 30,
      heldItem: undefined,
    }

    const result = await s.skill.run(
      { farm: undefined, area: { from: at(0, 64, 0), to: at(0, 64, 0) }, replant: true },
      context(),
    )

    expect(result).toEqual({ ok: true, value: { harvested: 1, replanted: 1 } })
    expect(s.placer.placed).toEqual([{ item: 'wheat_seeds', at: at(0, 65, 0) }])
  })

  it('does not replant when only the reserve seed is left', async () => {
    const s = setup()
    s.crops.set(at(0, 65, 0), { name: 'wheat', age: 7 })
    s.inventory.value = {
      stacks: [{ name: 'wheat_seeds', count: 1 }],
      emptySlots: 30,
      heldItem: undefined,
    }

    const result = await s.skill.run(
      { farm: undefined, area: { from: at(0, 64, 0), to: at(0, 64, 0) }, replant: true },
      context(),
    )

    expect(result).toEqual({ ok: true, value: { harvested: 1, replanted: 0 } })
    expect(s.placer.placed).toEqual([])
  })

  it('ignores an empty or unloaded plot', async () => {
    const s = setup()

    const result = await s.skill.run({ farm: undefined, area, replant: false }, context())

    expect(result).toEqual({ ok: true, value: { harvested: 0, replanted: 0 } })
  })

  it('resolves the area from a registered farm', async () => {
    const s = setup()
    await s.farms.attach(new InMemoryStateStore())
    const entry = s.farms.register({ kind: 'field', bounds: area, label: 'wheat field' })
    if (!entry.ok) throw new Error(entry.error)
    s.crops.set(at(0, 65, 0), { name: 'wheat', age: 7 })

    const result = await s.skill.run(
      { farm: 'wheat field', area: undefined, replant: false },
      context(),
    )

    expect(result).toEqual({ ok: true, value: { harvested: 1, replanted: 0 } })
  })

  it('fails with no_area when neither a farm nor an area is given', async () => {
    const s = setup()

    const result = await s.skill.run(
      { farm: undefined, area: undefined, replant: false },
      context(),
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_area' } })
  })
  describe('a pumpkin field', () => {
    const field = { from: at(0, 64, 0), to: at(2, 64, 2) }
    const stem = (s: ReturnType<typeof setup>, x: number, z: number, age = 7) => {
      s.blocks.blockNames.set(`${String(x)},65,${String(z)}`, 'pumpkin_stem')
      s.crops.set(at(x, 65, z), { name: 'pumpkin_stem', age })
    }
    const pumpkin = (s: ReturnType<typeof setup>, x: number, z: number) => {
      s.blocks.blockNames.set(`${String(x)},65,${String(z)}`, 'pumpkin')
    }

    it('breaks the pumpkins and leaves every stem, even a ripe-looking one', async () => {
      const s = setup()
      stem(s, 0, 0)
      stem(s, 1, 0, 3)
      pumpkin(s, 0, 1)
      pumpkin(s, 1, 1)

      const result = await s.skill.run({ farm: undefined, area: field, replant: true }, context())

      expect(result).toEqual({ ok: true, value: { harvested: 2, replanted: 0 } })
      expect(s.digger.dug).toEqual([at(0, 65, 1), at(1, 65, 1)])
    })

    it('never replants: the stem grows the next pumpkin', async () => {
      const s = setup()
      pumpkin(s, 1, 1)
      s.inventory.value = {
        stacks: [{ name: 'pumpkin_seeds', count: 9 }],
        emptySlots: 30,
        heldItem: undefined,
      }

      await s.skill.run({ farm: undefined, area: field, replant: true }, context())

      expect(s.placer.placed).toEqual([])
    })

    it('takes nothing when no pumpkin has grown yet', async () => {
      const s = setup()
      stem(s, 0, 0)

      const result = await s.skill.run({ farm: undefined, area: field, replant: true }, context())

      expect(result).toEqual({ ok: true, value: { harvested: 0, replanted: 0 } })
      expect(s.digger.dug).toEqual([])
    })

    it('does not count a pumpkin it could not reach', async () => {
      const s = setup()
      pumpkin(s, 0, 1)
      s.navigator.fail = { reason: 'unreachable', message: 'no path' }

      const result = await s.skill.run({ farm: undefined, area: field, replant: true }, context())

      expect(result).toEqual({ ok: true, value: { harvested: 0, replanted: 0 } })
    })

    it('stops when cancelled while walking to a pumpkin', async () => {
      const s = setup()
      pumpkin(s, 0, 1)
      s.navigator.fail = { reason: 'aborted', message: 'stopped' }

      const result = await s.skill.run({ farm: undefined, area: field, replant: true }, context())

      expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    })
  })
})
