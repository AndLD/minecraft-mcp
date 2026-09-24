import { beforeEach, describe, expect, it } from '@jest/globals'
import type { SkillContext } from '../../../../src/core/skill.types.js'
import type { MaterialFetcher } from '../../../../src/skills/building/material-fetcher.js'
import type { SupplyCrafter } from '../../../../src/skills/construction/crafting-supplies.js'
import { SignReader } from '../../../../src/skills/signs/sign-reader.js'
import { SignSupplies } from '../../../../src/skills/signs/sign-supplies.js'
import { SignTargeter } from '../../../../src/skills/signs/sign-target.js'
import { ContainerIndex } from '../../../../src/state/container-index.js'
import { SignRegistry } from '../../../../src/state/sign-registry.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeInventory } from '../../../fakes/fake-ports.js'
import { skillContext } from '../../../fakes/gathering-fakes.js'
import { FLOOR, FakeLookTarget, FakeSignAccess, SignWorld } from '../../../fakes/sign-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const at = (x: number, y: number, z: number) => ({ x, y, z })

describe('SignReader and SignTargeter', () => {
  let world: SignWorld
  let registry: SignRegistry
  let reader: SignReader
  let look: FakeLookTarget
  let targeter: SignTargeter

  beforeEach(async () => {
    world = new SignWorld()
    registry = new SignRegistry(new FakeClock(0))
    await registry.attach(new InMemoryStateStore())
    look = new FakeLookTarget()
    reader = new SignReader(world, new FakeSignAccess(world), registry)
    targeter = new SignTargeter(world, look, reader)
    world.addSign(at(3, FLOOR, 0), { front: ['Iron', 'chest'], facing: 'east' })
    world.addSign(at(9, FLOOR, 0), {
      name: 'spruce_sign',
      front: ['Farm'],
      back: ['Wheat'],
      waxed: true,
    })
    world.addSign(at(0, FLOOR, 20), { front: ['Iron mine'] })
    registry.note(at(3, FLOOR, 0), { lines: ['Iron', 'chest'], side: 'front', wood: 'oak' })
  })

  describe('reading', () => {
    it('lists the signs within the radius, nearest first, with both sides and who put them up', () => {
      const signs = reader.read(12)

      expect(signs.map((sign) => sign.position)).toEqual([at(3, FLOOR, 0), at(9, FLOOR, 0)])
      expect(signs[0]).toMatchObject({
        kind: 'wall',
        wood: 'oak',
        front: ['Iron', 'chest'],
        back: [],
        waxed: false,
        facing: 'east',
        placedByBot: true,
      })
      expect(signs[1]).toMatchObject({
        kind: 'standing',
        wood: 'spruce',
        back: ['Wheat'],
        waxed: true,
        placedByBot: false,
      })
    })

    it('keeps only signs with the words on either side, ignoring case', () => {
      expect(reader.read(30, 'iron').map((sign) => sign.position)).toEqual([
        at(3, FLOOR, 0),
        at(0, FLOOR, 20),
      ])
      expect(reader.read(30, 'WHEAT').map((sign) => sign.position)).toEqual([at(9, FLOOR, 0)])
      expect(reader.read(30, 'nothing here')).toEqual([])
    })
  })

  describe('naming one sign', () => {
    const resolve = (input: Partial<Parameters<SignTargeter['resolve']>[0]> = {}) =>
      targeter.resolve({ radius: 16, player: undefined, ...input })

    it('takes a position that holds a sign', () => {
      expect(resolve({ at: at(3, FLOOR, 0) })).toEqual({ ok: true, value: at(3, FLOOR, 0) })
    })

    it('refuses a position that is not a sign, or not loaded', () => {
      expect(resolve({ at: at(1, FLOOR, 1) })).toMatchObject({
        ok: false,
        error: { reason: 'not_a_sign' },
      })
      expect(resolve({ at: at(500, FLOOR, 1) })).toMatchObject({
        ok: false,
        error: { reason: 'not_loaded' },
      })
    })

    it('takes the one sign whose text matches', () => {
      expect(resolve({ matching: 'farm' })).toEqual({ ok: true, value: at(9, FLOOR, 0) })
    })

    it('never picks among several: lists them and asks which', () => {
      const result = resolve({ matching: 'iron', radius: 30 })

      expect(result).toMatchObject({ ok: false, error: { reason: 'ambiguous' } })
      const detail = result.ok ? undefined : result.error.detail
      expect(detail?.['candidates']).toHaveLength(2)
    })

    it('says when nothing matches', () => {
      expect(resolve({ matching: 'lava' })).toMatchObject({
        ok: false,
        error: { reason: 'not_found' },
      })
    })

    it('uses the sign the player looks at', () => {
      look.hits.set('Steve', { name: 'oak_wall_sign', position: at(9, FLOOR, 0), face: 'north' })

      expect(resolve({ player: 'Steve' })).toEqual({ ok: true, value: at(9, FLOOR, 0) })
    })

    it('refuses when the player looks at something else, at nothing, or nobody is named', () => {
      look.hits.set('Steve', { name: 'stone', position: at(1, FLOOR, 1), face: 'north' })
      expect(resolve({ player: 'Steve' })).toMatchObject({
        ok: false,
        error: { reason: 'not_a_sign' },
      })
      expect(resolve({ player: 'Alex' })).toMatchObject({
        ok: false,
        error: { reason: 'not_looking' },
      })
      expect(resolve()).toMatchObject({ ok: false, error: { reason: 'no_target' } })
    })

    it('prefers a position over text, and text over the look', () => {
      look.hits.set('Steve', { name: 'oak_wall_sign', position: at(9, FLOOR, 0), face: 'north' })

      expect(resolve({ at: at(3, FLOOR, 0), matching: 'farm', player: 'Steve' })).toEqual({
        ok: true,
        value: at(3, FLOOR, 0),
      })
      expect(resolve({ matching: 'iron chest', player: 'Steve' })).toEqual({
        ok: true,
        value: at(3, FLOOR, 0),
      })
    })
  })
})

describe('SignSupplies', () => {
  let inventory: FakeInventory
  let index: ContainerIndex
  let crafted: { item: string; count: number }[]
  let fetched: { name: string; count: number }[]
  let supplies: SignSupplies
  const context: SkillContext = skillContext().context

  const carry = (...names: string[]): void => {
    inventory.value = {
      stacks: names.map((name) => ({ name, count: 2 })),
      emptySlots: 10,
      heldItem: undefined,
    }
  }

  beforeEach(async () => {
    inventory = new FakeInventory()
    carry()
    index = new ContainerIndex(new FakeClock(0))
    await index.attach(new InMemoryStateStore())
    crafted = []
    fetched = []
    const fetcher: MaterialFetcher = {
      fetch: (missing) => {
        fetched.push(...missing)
        carry(...missing.map((item) => item.name))
        return Promise.resolve()
      },
    }
    const crafter: SupplyCrafter = {
      craft: (item, count) => {
        crafted.push({ item, count })
        carry(item)
        return Promise.resolve(true)
      },
    }
    supplies = new SignSupplies({ inventory, index, fetcher, crafter })
  })

  it('uses a sign it carries: the wood asked for, or any', async () => {
    carry('spruce_sign', 'oak_sign', 'stick')

    expect(await supplies.ensure('oak', context)).toBe('oak_sign')
    expect(await supplies.ensure(undefined, context)).toBe('spruce_sign')
    expect(crafted).toEqual([])
  })

  it('never takes a hanging sign for a sign', async () => {
    carry('oak_hanging_sign')

    expect(await supplies.ensure(undefined, context)).toBe('oak_sign')
    expect(crafted).toEqual([{ item: 'oak_sign', count: 1 }])
  })

  it('fetches one from a chest it knows before crafting', async () => {
    const chest = index.register(at(4, FLOOR, 4), 'chest')
    if (!chest.ok) throw new Error(chest.error)
    index.recordContents(chest.value.id, [{ name: 'birch_sign', count: 3 }], {
      totalSlots: 27,
      emptySlots: 24,
    })

    expect(await supplies.ensure(undefined, context)).toBe('birch_sign')
    expect(fetched).toEqual([{ name: 'birch_sign', count: 1 }])
    expect(crafted).toEqual([])
  })

  it('leaves chests marked protected alone', async () => {
    const chest = index.register(at(4, FLOOR, 4), 'chest', { protected: true })
    if (!chest.ok) throw new Error(chest.error)
    index.recordContents(chest.value.id, [{ name: 'birch_sign', count: 3 }], {
      totalSlots: 27,
      emptySlots: 24,
    })

    await supplies.ensure(undefined, context)

    expect(fetched).toEqual([])
    expect(crafted).toEqual([{ item: 'oak_sign', count: 1 }])
  })

  it('crafts the wood asked for, oak by default', async () => {
    expect(await supplies.ensure('spruce', context)).toBe('spruce_sign')
    carry()
    expect(await supplies.ensure(undefined, context)).toBe('oak_sign')
    expect(crafted).toEqual([
      { item: 'spruce_sign', count: 1 },
      { item: 'oak_sign', count: 1 },
    ])
  })

  it('gives up when nothing can be had', async () => {
    const empty = new SignSupplies({
      inventory,
      index,
      fetcher: { fetch: () => Promise.resolve() },
      crafter: { craft: () => Promise.resolve(false) },
    })

    expect(await empty.ensure(undefined, context)).toBeUndefined()
  })

  it('does not craft after being cancelled', async () => {
    const run = skillContext()
    run.controller.abort()

    expect(await supplies.ensure(undefined, run.context)).toBeUndefined()
    expect(crafted).toEqual([])
  })
})
