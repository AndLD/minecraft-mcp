import { describe, expect, it } from '@jest/globals'
import type { AnimalInfo, AnimalScanner } from '../../../../src/core/animal-scanner.port.js'
import type { CropAccess, CropState } from '../../../../src/core/crop.port.js'
import type { Position } from '../../../../src/core/position.types.js'
import {
  DiscoverFarmSkill,
  type DiscoverFarmInput,
} from '../../../../src/skills/farming/discover-farm-skill.js'
import { FarmRegistry } from '../../../../src/state/farm-registry.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeVitals } from '../../../fakes/fake-ports.js'
import { skillContext } from '../../../fakes/gathering-fakes.js'
import { GroveWorld } from '../../../fakes/grove-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const Y = 63
const at = (x: number, y: number, z: number): Position => ({ x, y, z })
const key = (p: Position): string => `${String(p.x)},${String(p.y)},${String(p.z)}`

class FakeCrops implements CropAccess {
  readonly states = new Map<string, CropState>()
  stateAt(position: Position): CropState | undefined {
    return this.states.get(key(position))
  }
}

class FakeAnimals implements AnimalScanner {
  animals: AnimalInfo[] = []
  nearby(): readonly AnimalInfo[] {
    return this.animals
  }
  find(id: number): AnimalInfo | undefined {
    return this.animals.find((a) => a.id === id)
  }
}

let nextId = 1
const animal = (species: string, x: number, z: number, over: Partial<AnimalInfo> = {}): AnimalInfo => ({
  id: nextId++,
  species,
  position: at(x + 0.5, Y + 1, z + 0.5),
  distance: 1,
  baby: false,
  named: false,
  owned: false,
  saddled: false,
  ridden: false,
  dead: false,
  ...over,
})

async function setup(botAt: Position = at(0, Y + 1, 0)) {
  const world = new GroveWorld({ x0: -80, x1: 120, z0: -80, z1: 120, y0: 40, y1: 90 })
  world.names = ['air', 'farmland', 'water', 'wheat', 'carrots', 'oak_fence', 'oak_fence_gate', 'stone_brick_wall', 'grass_block']
  world.origin = botAt
  const crops = new FakeCrops()
  const animals = new FakeAnimals()
  const vitals = new FakeVitals()
  vitals.vitals = {
    health: 20,
    food: 20,
    saturation: 5,
    oxygen: 20,
    inLava: false,
    inWater: false,
    headUnderwater: false,
    position: botAt,
    dimension: 'overworld',
    timeOfDay: 0,
  }
  const farms = new FarmRegistry(new FakeClock(0))
  await farms.attach(new InMemoryStateStore())
  const skill = new DiscoverFarmSkill({ blocks: world, crops, animals, farms, vitals })

  return {
    world,
    crops,
    animals,
    farms,
    vitals,
    skill,
    /** Farmland over a rectangle, with a crop on every plot unless `crop` is undefined. */
    field(x0: number, z0: number, x1: number, z1: number, crop: string | null = 'wheat'): void {
      for (let x = x0; x <= x1; x += 1) {
        for (let z = z0; z <= z1; z += 1) {
          world.set(x, Y, z, 'farmland')
          if (crop !== null) {
            world.set(x, Y + 1, z, crop)
            crops.states.set(key(at(x, Y + 1, z)), { name: crop, age: 3 })
          }
        }
      }
    },
    /** A fence ring one cell outside x0..x1 by z0..z1, with a gate in the middle of the south side. */
    pen(x0: number, z0: number, x1: number, z1: number, gate = true): void {
      for (let x = x0 - 1; x <= x1 + 1; x += 1) {
        for (let z = z0 - 1; z <= z1 + 1; z += 1) {
          if (x !== x0 - 1 && x !== x1 + 1 && z !== z0 - 1 && z !== z1 + 1) continue
          const isGate = gate && z === z1 + 1 && x === Math.floor((x0 + x1) / 2)
          world.set(x, Y + 1, z, isGate ? 'oak_fence_gate' : 'oak_fence')
        }
      }
    },
  }
}

const input = (over: Partial<DiscoverFarmInput> = {}): DiscoverFarmInput => ({
  around: undefined,
  radius: undefined,
  group: undefined,
  ...over,
})

async function discover(s: Awaited<ReturnType<typeof setup>>, over: Partial<DiscoverFarmInput> = {}) {
  const result = await s.skill.run(input(over), skillContext().context)
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

describe('DiscoverFarmSkill: fields', () => {
  it('proposes a field from farmland, with the crop growing on it and the exact registration', async () => {
    const s = await setup()
    s.field(4, 4, 8, 9)

    const found = await discover(s)

    expect(found.proposals).toHaveLength(1)
    expect(found.proposals[0]).toMatchObject({
      kind: 'field',
      confidence: 'high',
      plots: 30,
      crops: { wheat: 30 },
      bounds: { from: at(4, Y, 4), to: at(8, Y + 1, 9) },
      register: { kind: 'field', crop: 'wheat', from: at(4, Y, 4), to: at(8, Y + 1, 9), label: 'wheat field' },
    })
    expect(found.alreadyRegistered).toEqual([])
    expect(found.truncated).toBe(false)
  })

  it('takes the two halves of a field split by a water channel as one', async () => {
    const s = await setup()
    s.field(4, 4, 6, 9)
    s.field(8, 4, 10, 9)
    for (let z = 4; z <= 9; z += 1) s.world.set(7, Y, z, 'water')

    const found = await discover(s)

    expect(found.proposals).toHaveLength(1)
    expect(found.proposals[0]).toMatchObject({ plots: 36, bounds: { from: at(4, Y, 4), to: at(10, Y + 1, 9) } })
  })

  it('proposes bare farmland with low confidence and no crop', async () => {
    const s = await setup()
    s.field(4, 4, 6, 6, null)

    const found = await discover(s)

    expect(found.proposals[0]).toMatchObject({ kind: 'field', confidence: 'low', crops: {}, register: { label: 'field' } })
    expect(found.proposals[0]?.register.crop).toBeUndefined()
    expect(found.proposals[0]?.notes.join(' ')).toContain('Nothing is planted yet')
  })

  it('proposes the most common of mixed crops, and says so', async () => {
    const s = await setup()
    s.field(4, 4, 8, 5, 'carrots')
    s.field(4, 6, 5, 6, 'wheat')

    const found = await discover(s)

    expect(found.proposals[0]).toMatchObject({ register: { crop: 'carrots' }, crops: { carrots: 10, wheat: 2 } })
    expect(found.proposals[0]?.notes.join(' ')).toContain('Mixed crops')
  })

  it('ignores a few stray tilled blocks', async () => {
    const s = await setup()
    s.field(4, 4, 5, 5) // 4 plots: a field
    s.field(20, 4, 21, 4) // 2 plots: not

    const found = await discover(s)

    expect(found.proposals).toHaveLength(1)
  })

  it('keeps fields on different levels apart', async () => {
    const s = await setup()
    s.field(4, 4, 6, 6)
    for (let x = 4; x <= 6; x += 1) for (let z = 4; z <= 6; z += 1) s.world.set(x, Y + 5, z, 'farmland')

    const found = await discover(s)

    expect(found.proposals).toHaveLength(2)
  })
})

describe('DiscoverFarmSkill: pens', () => {
  it('proposes a pen from a fence with animals in it, bounds including the fence', async () => {
    const s = await setup()
    s.pen(10, 10, 14, 13)
    s.animals.animals = [animal('cow', 11, 11), animal('cow', 12, 12), animal('cow', 13, 11, { baby: true })]

    const found = await discover(s)

    expect(found.proposals).toHaveLength(1)
    expect(found.proposals[0]).toMatchObject({
      kind: 'pen',
      confidence: 'high',
      hasGate: true,
      animals: { cow: 3 },
      bounds: { from: at(9, Y, 9), to: at(15, Y + 2, 14) },
      register: { kind: 'pen', species: 'cow', herd_target: 3, label: 'cow pen', from: at(9, Y, 9), to: at(15, Y + 2, 14) },
    })
    expect(found.proposals[0]?.notes.join(' ')).toContain('herd right now (3)')
  })

  it('proposes the most common of mixed animals, ignoring the dead, other species, and animals outside', async () => {
    const s = await setup()
    s.pen(10, 10, 14, 13)
    s.animals.animals = [
      animal('sheep', 11, 11),
      animal('sheep', 12, 11),
      animal('pig', 13, 12),
      animal('cow', 12, 12, { dead: true }),
      animal('wolf', 12, 13),
      animal('sheep', 30, 30),
    ]

    const found = await discover(s)

    expect(found.proposals[0]).toMatchObject({ animals: { sheep: 2, pig: 1 }, register: { species: 'sheep', herd_target: 2 } })
    expect(found.proposals[0]?.notes.join(' ')).toContain('Mixed animals')
  })

  it('proposes an empty fenced area with a gate as a low-confidence pen, and skips one with no gate', async () => {
    const withGate = await setup()
    withGate.pen(10, 10, 14, 13, true)
    const without = await setup()
    without.pen(10, 10, 14, 13, false)

    const gated = await discover(withGate)
    const bare = await discover(without)

    expect(gated.proposals[0]).toMatchObject({ kind: 'pen', confidence: 'low', hasGate: true, register: { label: 'animal pen' } })
    expect(gated.proposals[0]?.register.species).toBeUndefined()
    expect(gated.proposals[0]?.notes.join(' ')).toContain('Nothing is in it')
    expect(bare.proposals).toEqual([])
  })

  it('takes a fenced field for a field, not a pen', async () => {
    const s = await setup()
    s.field(10, 10, 14, 13)
    s.pen(10, 10, 14, 13)

    const found = await discover(s)

    expect(found.proposals.map((p) => p.kind)).toEqual(['field'])
  })

  it('finds two pens that share a fence', async () => {
    const s = await setup()
    s.pen(10, 10, 13, 13)
    for (let z = 9; z <= 14; z += 1) s.world.set(14, Y + 1, z, 'oak_fence')
    for (let x = 14; x <= 18; x += 1) {
      s.world.set(x, Y + 1, 9, 'oak_fence')
      s.world.set(x, Y + 1, 14, 'oak_fence')
    }
    for (let z = 9; z <= 14; z += 1) s.world.set(19, Y + 1, z, 'oak_fence')
    s.animals.animals = [animal('cow', 11, 11), animal('pig', 16, 11)]

    const found = await discover(s)

    expect(found.proposals.map((p) => p.register.species).sort()).toEqual(['cow', 'pig'])
  })

  it('does not take a fence with a gap, a long straight fence, or a huge fenced area for a pen', async () => {
    const gap = await setup()
    gap.pen(10, 10, 14, 13)
    gap.world.set(9, Y + 1, 11, 'air')
    gap.animals.animals = [animal('cow', 11, 11)]
    const straight = await setup()
    for (let x = 10; x <= 30; x += 1) straight.world.set(x, Y + 1, 10, 'oak_fence')
    const huge = await setup()
    huge.pen(-30, -30, 40, 40)
    huge.animals.animals = [animal('cow', 0, 0)]

    expect((await discover(gap)).proposals).toEqual([])
    expect((await discover(straight)).proposals).toEqual([])
    expect((await discover(huge, { radius: 48 })).proposals).toEqual([])
  })

  it('does not take a ragged enclosure for a pen', async () => {
    const s = await setup()
    // An L-shaped area (42 cells in a 9 by 10 box), fenced all round.
    const inside = new Set<string>()
    for (let x = 11; x <= 19; x += 1) for (const z of [11, 12]) inside.add(`${String(x)},${String(z)}`)
    for (let x = 11; x <= 13; x += 1) for (let z = 13; z <= 20; z += 1) inside.add(`${String(x)},${String(z)}`)
    for (const cell of inside) {
      const [x = 0, z = 0] = cell.split(',').map(Number)
      for (let dx = -1; dx <= 1; dx += 1)
        for (let dz = -1; dz <= 1; dz += 1)
          if (!inside.has(`${String(x + dx)},${String(z + dz)}`)) s.world.set(x + dx, Y + 1, z + dz, 'oak_fence')
    }
    s.animals.animals = [animal('cow', 12, 12)]

    const found = await discover(s)

    expect(found.proposals).toEqual([])
  })

  it('knows walls and fences of any wood', async () => {
    const s = await setup()
    for (let x = 10; x <= 14; x += 1) for (const z of [10, 14]) s.world.set(x, Y + 1, z, 'stone_brick_wall')
    for (let z = 11; z <= 13; z += 1) for (const x of [10, 14]) s.world.set(x, Y + 1, z, 'stone_brick_wall')
    s.animals.animals = [animal('pig', 12, 12)]

    const found = await discover(s)

    expect(found.proposals[0]).toMatchObject({ register: { species: 'pig' }, hasGate: false })
  })

  it('finds no pens when the game has no fence blocks', async () => {
    const s = await setup()
    s.world.names = ['air', 'farmland']

    expect((await discover(s)).proposals).toEqual([])
  })
})

describe('DiscoverFarmSkill: what is left out, named, ordered', () => {
  it('leaves out what a registered farm covers, and lists it', async () => {
    const s = await setup()
    s.field(4, 4, 8, 9)
    s.field(30, 4, 34, 9)
    const known = s.farms.register({ kind: 'field', crop: 'wheat', label: 'home wheat', bounds: { from: at(3, Y, 3), to: at(9, Y + 1, 10) } })
    if (!known.ok) throw new Error(known.error)

    const found = await discover(s, { radius: 48 })

    expect(found.proposals).toHaveLength(1)
    expect(found.proposals[0]?.bounds.from.x).toBe(30)
    expect(found.alreadyRegistered).toEqual([{ id: known.value.id, label: 'home wheat', kind: 'field' }])
  })

  it('gives every proposal a label nobody uses, and the group asked for', async () => {
    const s = await setup()
    s.field(4, 4, 6, 6)
    s.field(14, 4, 16, 6)
    s.field(24, 4, 26, 6)
    s.farms.register({ kind: 'field', label: 'wheat field', bounds: { from: at(60, Y, 60), to: at(61, Y, 61) } })

    const found = await discover(s, { group: 'home', radius: 48 })

    expect(found.proposals.map((p) => p.register.label)).toEqual(['wheat field 2', 'wheat field 3', 'wheat field 4'])
    expect(found.proposals.every((p) => p.register.group === 'home')).toBe(true)
    expect((await discover(await withField())).proposals[0]?.register.group).toBeUndefined()

    async function withField() {
      const t = await setup()
      t.field(4, 4, 6, 6)
      return t
    }
  })

  it('lists the nearest first', async () => {
    const s = await setup()
    s.field(30, 4, 32, 6)
    s.field(4, 4, 6, 6)

    const found = await discover(s, { radius: 48 })

    expect(found.proposals.map((p) => p.bounds.from.x)).toEqual([4, 30])
  })

  it('looks around a given place, even far from the bot, and only as far as the radius', async () => {
    const s = await setup(at(0, Y + 1, 0))
    s.field(70, 70, 74, 74)
    s.field(4, 4, 8, 8)

    const far = await discover(s, { around: at(72, Y, 72), radius: 10 })
    const near = await discover(s, { radius: 10 })

    expect(far.proposals.map((p) => p.bounds.from.x)).toEqual([70])
    expect(near.proposals.map((p) => p.bounds.from.x)).toEqual([4])
    expect(far.center).toEqual(at(72, Y, 72))
    expect(near.radius).toBe(10)
  })

  it('lists a limited number and says there were more', async () => {
    const s = await setup()
    for (let i = 0; i < 22; i += 1) s.field(4 + (i % 6) * 5, 4 + Math.floor(i / 6) * 5, 5 + (i % 6) * 5, 5 + Math.floor(i / 6) * 5)

    const found = await discover(s, { radius: 48 })

    expect(found.proposals).toHaveLength(20)
    expect(found.truncated).toBe(true)
  })

  it('finds nothing in an empty world, and fails when not connected', async () => {
    const s = await setup()
    expect(await discover(s)).toMatchObject({ proposals: [], alreadyRegistered: [], truncated: false })

    s.vitals.vitals = undefined
    const result = await s.skill.run(input(), skillContext().context)
    expect(result).toMatchObject({ ok: false, error: { reason: 'not_connected' } })
  })
})
