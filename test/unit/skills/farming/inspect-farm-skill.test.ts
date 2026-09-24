import { describe, expect, it } from '@jest/globals'
import type { AnimalInfo, AnimalScanner } from '../../../../src/core/animal-scanner.port.js'
import type { CropAccess, CropState } from '../../../../src/core/crop.port.js'
import type { Position } from '../../../../src/core/position.types.js'
import { InspectFarmSkill } from '../../../../src/skills/farming/inspect-farm-skill.js'
import { FarmRegistry } from '../../../../src/state/farm-registry.js'
import { FakeBlockScanner } from '../../../fakes/fake-ports.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const context = () => ({ signal: new AbortController().signal, progress: () => undefined })
const key = (p: Position): string => `${String(p.x)},${String(p.y)},${String(p.z)}`
const at = (x: number, y: number, z: number): Position => ({ x, y, z })

class FakeCropAccess implements CropAccess {
  readonly crops = new Map<string, CropState>()
  set(position: Position, state: CropState): void {
    this.crops.set(key(position), state)
  }
  stateAt(position: Position): CropState | undefined {
    return this.crops.get(key(position))
  }
}

class FakeAnimalScanner implements AnimalScanner {
  animals: AnimalInfo[] = []
  nearby(): readonly AnimalInfo[] {
    return this.animals
  }
  find(id: number): AnimalInfo | undefined {
    return this.animals.find((a) => a.id === id)
  }
}

const animal = (overrides: Partial<AnimalInfo> & { species: string; position: Position }): AnimalInfo => ({
  id: overrides.id ?? Math.floor(Math.random() * 100_000),
  distance: 1,
  baby: false,
  named: false,
  owned: false,
  saddled: false,
  ridden: false,
  dead: false,
  ...overrides,
})

async function setup() {
  const blocks = new FakeBlockScanner()
  const crops = new FakeCropAccess()
  const animals = new FakeAnimalScanner()
  const farms = new FarmRegistry(new FakeClock(0))
  await farms.attach(new InMemoryStateStore())
  const skill = new InspectFarmSkill({ blocks, crops, animals, farms })
  return { blocks, crops, animals, farms, skill }
}

const bounds = { from: at(0, 64, 0), to: at(1, 64, 0) }

describe('InspectFarmSkill', () => {
  it('reports ripe, growing, and empty plots without touching anything', async () => {
    const s = await setup()
    const entry = s.farms.register({ kind: 'field', crop: 'wheat', bounds })
    if (!entry.ok) throw new Error(entry.error)
    s.blocks.blockNames.set(key(at(0, 64, 0)), 'farmland')
    s.crops.set(at(0, 65, 0), { name: 'wheat', age: 7 })
    s.blocks.blockNames.set(key(at(1, 64, 0)), 'farmland')
    s.crops.set(at(1, 65, 0), { name: 'wheat', age: 2 })

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result).toEqual({
      ok: true,
      value: {
        components: [
          {
            id: entry.value.id,
            kind: 'field',
            crop: 'wheat',
            species: null,
            herdTarget: null,
            ripe: 1,
            growing: 1,
            empty: 0,
            adults: 0,
            babies: 0,
          },
        ],
      },
    })
  })

  it('counts a farmland plot with nothing growing as empty', async () => {
    const s = await setup()
    const entry = s.farms.register({ kind: 'field', crop: 'wheat', bounds: { from: at(0, 64, 0), to: at(0, 64, 0) } })
    if (!entry.ok) throw new Error(entry.error)
    s.blocks.blockNames.set(key(at(0, 64, 0)), 'farmland')

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result).toMatchObject({
      ok: true,
      value: { components: [{ ripe: 0, growing: 0, empty: 1 }] },
    })
  })

  it('ignores a cell that is not farmland at all', async () => {
    const s = await setup()
    const entry = s.farms.register({ kind: 'field', bounds: { from: at(0, 64, 0), to: at(0, 64, 0) } })
    if (!entry.ok) throw new Error(entry.error)

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result).toMatchObject({
      ok: true,
      value: { components: [{ crop: null, ripe: 0, growing: 0, empty: 0 }] },
    })
  })

  it('reports a pen its adults and babies of the right species inside its bounds', async () => {
    const s = await setup()
    const entry = s.farms.register({ kind: 'pen', species: 'cow', herdTarget: 6, bounds })
    if (!entry.ok) throw new Error(entry.error)
    s.animals.animals = [
      animal({ species: 'cow', position: at(0, 64, 0) }),
      animal({ species: 'cow', position: at(1, 64, 0), baby: true }),
      animal({ species: 'cow', position: at(50, 64, 0) }), // outside the pen's bounds
      animal({ species: 'pig', position: at(0, 64, 0) }), // wrong species
    ]

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result).toEqual({
      ok: true,
      value: {
        components: [
          {
            id: entry.value.id,
            kind: 'pen',
            crop: null,
            species: 'cow',
            herdTarget: 6,
            ripe: 0,
            growing: 0,
            empty: 0,
            adults: 1,
            babies: 1,
          },
        ],
      },
    })
  })

  it('reports a grove with nothing standing in it as zero counts', async () => {
    const s = await setup()
    const entry = s.farms.register({ kind: 'grove', bounds })
    if (!entry.ok) throw new Error(entry.error)

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result).toMatchObject({
      ok: true,
      value: { components: [{ kind: 'grove', ripe: 0, growing: 0, empty: 0, adults: 0, babies: 0 }] },
    })
  })

  it('reports every component of a group', async () => {
    const s = await setup()
    const a = s.farms.register({ kind: 'field', bounds, group: 'home' })
    const b = s.farms.register({ kind: 'pen', species: 'pig', bounds, group: 'home' })
    if (!a.ok || !b.ok) throw new Error('setup failed')

    const result = await s.skill.run({ farm: 'home' }, context())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.components).toHaveLength(2)
  })

  it('counts a planted grove by its spots: grown, sapling, and empty', async () => {
    const s = await setup()
    const entry = s.farms.register({
      kind: 'grove',
      crop: 'oak',
      bounds: { from: at(0, 64, 0), to: at(20, 64, 20) },
      spots: [
        { x: 2, y: 65, z: 2, size: 1 },
        { x: 8, y: 65, z: 8, size: 1 },
        { x: 14, y: 65, z: 14, size: 1 },
        { x: 4, y: 65, z: 16, size: 2 },
      ],
    })
    if (!entry.ok) throw new Error(entry.error)
    s.blocks.blockNames.set(key(at(2, 65, 2)), 'oak_log')
    s.blocks.blockNames.set(key(at(8, 65, 8)), 'oak_sapling')
    s.blocks.blockNames.set(key(at(5, 65, 17)), 'oak_log') // one trunk of a 2x2 tree is enough

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result).toMatchObject({
      ok: true,
      value: { components: [{ kind: 'grove', crop: 'oak', ripe: 2, growing: 1, empty: 1 }] },
    })
  })

  it('finds the trees of a grove registered by hand inside its bounds', async () => {
    const s = await setup()
    s.blocks.names = ['dirt', 'oak_log', 'oak_sapling']
    const entry = s.farms.register({
      kind: 'grove',
      bounds: { from: at(0, 64, 0), to: at(10, 64, 10) },
    })
    if (!entry.ok) throw new Error(entry.error)
    s.blocks.blocks = [
      { name: 'oak_log', position: at(3, 65, 3), distance: 1 },
      { name: 'oak_log', position: at(3, 66, 3), distance: 1 }, // higher up the same trunk
      { name: 'oak_log', position: at(6, 70, 6), distance: 1 }, // a log with no ground under it
      { name: 'oak_log', position: at(40, 65, 40), distance: 1 }, // outside the bounds
      { name: 'oak_sapling', position: at(8, 65, 8), distance: 1 },
    ]
    s.blocks.blockNames.set(key(at(3, 64, 3)), 'grass_block')
    s.blocks.blockNames.set(key(at(3, 65, 3)), 'oak_log')
    s.blocks.blockNames.set(key(at(6, 69, 6)), 'air')
    s.blocks.blockNames.set(key(at(40, 64, 40)), 'grass_block')

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result).toMatchObject({
      ok: true,
      value: { components: [{ kind: 'grove', ripe: 1, growing: 1, empty: 0 }] },
    })
  })

  it('finds nothing in a hand-registered grove when no tree block is known', async () => {
    const s = await setup()
    s.blocks.names = ['dirt']
    const entry = s.farms.register({ kind: 'grove', bounds })
    if (!entry.ok) throw new Error(entry.error)

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result).toMatchObject({ ok: true, value: { components: [{ ripe: 0, growing: 0, empty: 0 }] } })
  })

  it('fails with unknown_farm for an unrecognised reference', async () => {
    const s = await setup()

    const result = await s.skill.run({ farm: 'nothing-here' }, context())

    expect(result).toMatchObject({ ok: false, error: { reason: 'unknown_farm' } })
  })
})
