import { describe, expect, it } from '@jest/globals'
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

async function setup() {
  const blocks = new FakeBlockScanner()
  const crops = new FakeCropAccess()
  const farms = new FarmRegistry(new FakeClock(0))
  await farms.attach(new InMemoryStateStore())
  const skill = new InspectFarmSkill({ blocks, crops, farms })
  return { blocks, crops, farms, skill }
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
        components: [{ id: entry.value.id, kind: 'field', crop: 'wheat', ripe: 1, growing: 1, empty: 0 }],
      },
    })
  })

  it('counts a farmland plot with nothing growing as empty', async () => {
    const s = await setup()
    const entry = s.farms.register({ kind: 'field', crop: 'wheat', bounds: { from: at(0, 64, 0), to: at(0, 64, 0) } })
    if (!entry.ok) throw new Error(entry.error)
    s.blocks.blockNames.set(key(at(0, 64, 0)), 'farmland')

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result).toEqual({
      ok: true,
      value: { components: [{ id: entry.value.id, kind: 'field', crop: 'wheat', ripe: 0, growing: 0, empty: 1 }] },
    })
  })

  it('ignores a cell that is not farmland at all', async () => {
    const s = await setup()
    const entry = s.farms.register({ kind: 'field', bounds: { from: at(0, 64, 0), to: at(0, 64, 0) } })
    if (!entry.ok) throw new Error(entry.error)

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result).toEqual({
      ok: true,
      value: { components: [{ id: entry.value.id, kind: 'field', crop: null, ripe: 0, growing: 0, empty: 0 }] },
    })
  })

  it('reports a non-field component with zero counts', async () => {
    const s = await setup()
    const entry = s.farms.register({ kind: 'pen', bounds })
    if (!entry.ok) throw new Error(entry.error)

    const result = await s.skill.run({ farm: entry.value.id }, context())

    expect(result).toEqual({
      ok: true,
      value: { components: [{ id: entry.value.id, kind: 'pen', crop: null, ripe: 0, growing: 0, empty: 0 }] },
    })
  })

  it('reports every component of a group', async () => {
    const s = await setup()
    const a = s.farms.register({ kind: 'field', bounds, group: 'home' })
    const b = s.farms.register({ kind: 'pen', bounds, group: 'home' })
    if (!a.ok || !b.ok) throw new Error('setup failed')

    const result = await s.skill.run({ farm: 'home' }, context())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.components).toHaveLength(2)
  })

  it('fails with unknown_farm for an unrecognised reference', async () => {
    const s = await setup()

    const result = await s.skill.run({ farm: 'nothing-here' }, context())

    expect(result).toMatchObject({ ok: false, error: { reason: 'unknown_farm' } })
  })
})
