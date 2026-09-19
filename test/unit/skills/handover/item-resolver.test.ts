import { describe, expect, it } from '@jest/globals'
import { MineflayerItemFacts } from '../../../../src/bot/mineflayer-item-facts.js'
import { ItemResolver, type Availability } from '../../../../src/skills/handover/item-resolver.js'
import { FakeBot } from '../../../fakes/fake-bot.js'

const facts = new MineflayerItemFacts({
  current: () => new FakeBot().useGameData(),
  onChange: () => () => undefined,
})
const resolver = new ItemResolver(facts)
const have = (
  carried: Record<string, number> = {},
  stored: Record<string, number> = {},
): Availability => ({
  carried: new Map(Object.entries(carried)),
  stored: new Map(Object.entries(stored)),
})

describe('ItemResolver', () => {
  it('takes an exact item name, also written with spaces or capitals', () => {
    expect(resolver.resolve('iron_ingot', have())).toEqual({
      kind: 'items',
      items: ['iron_ingot'],
      via: 'exact',
    })
    expect(resolver.resolve('Iron Ingot', have())).toEqual({
      kind: 'items',
      items: ['iron_ingot'],
      via: 'exact',
    })
    expect(resolver.resolve('  cobblestone ', have())).toMatchObject({ items: ['cobblestone'] })
  })

  it('understands plurals', () => {
    expect(resolver.resolve('diamonds', have())).toEqual({
      kind: 'items',
      items: ['diamond'],
      via: 'exact',
    })
    expect(resolver.resolve('apples', have())).toMatchObject({ items: ['apple'] })
    expect(resolver.resolve('sticks', have())).toMatchObject({ items: ['stick'] })
    expect(resolver.resolve('potatoes', have())).toMatchObject({ items: ['potato'] })
  })

  it('turns "ies" into "y" for names that end that way', () => {
    const stub = new ItemResolver({
      isItem: (name) => name === 'berry',
      isFood: () => false,
      isBlock: () => false,
      stackSize: () => 64,
      allItems: () => ['berry'],
    })

    expect(stub.resolve('berries', have())).toEqual({
      kind: 'items',
      items: ['berry'],
      via: 'exact',
    })
  })

  it('understands everyday words', () => {
    expect(resolver.resolve('cobble', have())).toEqual({
      kind: 'items',
      items: ['cobblestone'],
      via: 'alias',
    })
    expect(resolver.resolve('steaks', have())).toEqual({
      kind: 'items',
      items: ['cooked_beef'],
      via: 'alias',
    })
    expect(resolver.resolve('lapis', have())).toMatchObject({ items: ['lapis_lazuli'] })
  })

  it('turns a group into the items of it that are on hand, carried or stored', () => {
    const logs = resolver.resolve('logs', have({ oak_log: 5, dirt: 9 }, { birch_log: 3 }))

    expect(logs).toEqual({ kind: 'items', items: ['birch_log', 'oak_log'], via: 'group' })
    expect(resolver.resolve('food', have({ bread: 2, cooked_beef: 3, stick: 1 }))).toMatchObject({
      items: ['bread', 'cooked_beef'],
    })
    expect(resolver.resolve('ores', have())).toEqual({ kind: 'items', items: [], via: 'group' })
  })

  it('asks which one for "wood", offering what is on hand', () => {
    const wood = resolver.resolve('wood', have({ oak_log: 5, birch_planks: 8, dirt: 1 }))

    expect(wood).toEqual({
      kind: 'ambiguous',
      candidates: [
        { item: 'birch_planks', carried: 8, stored: 0 },
        { item: 'oak_log', carried: 5, stored: 0 },
      ],
    })
    expect(resolver.resolve('wood', have())).toMatchObject({
      kind: 'ambiguous',
      candidates: [{ item: 'oak_log' }, { item: 'oak_planks' }],
    })
  })

  it('picks the only item of a material that the bot has, and asks when it has several', () => {
    expect(resolver.resolve('iron', have({ iron_ingot: 12 }))).toEqual({
      kind: 'items',
      items: ['iron_ingot'],
      via: 'match',
    })
    expect(resolver.resolve('iron', have({ iron_ingot: 12 }, { raw_iron: 30 }))).toEqual({
      kind: 'ambiguous',
      candidates: [
        { item: 'raw_iron', carried: 0, stored: 30 },
        { item: 'iron_ingot', carried: 12, stored: 0 },
      ],
    })
  })

  it('lists the likely items when nothing of the material is on hand', () => {
    const iron = resolver.resolve('iron', have())

    expect(iron.kind).toBe('ambiguous')
    expect(iron.kind === 'ambiguous' && iron.candidates.length).toBe(8)
    expect(iron.kind === 'ambiguous' && iron.candidates[0]?.carried).toBe(0)
    expect(iron.kind === 'ambiguous' && iron.candidates.map((c) => c.item)).toContain('iron_ingot')
  })

  it('matches several words of a phrase, and a single possible item', () => {
    expect(resolver.resolve('golden apple', have())).toMatchObject({ items: ['golden_apple'] })
    expect(resolver.resolve('ingot iron', have())).toMatchObject({
      kind: 'items',
      items: ['iron_ingot'],
    })
    expect(resolver.resolve('lazuli', have())).toEqual({
      kind: 'items',
      items: ['lapis_lazuli'],
      via: 'match',
    })
  })

  it('does not know what is not an item, and suggests names', () => {
    expect(resolver.resolve('unobtainium', have())).toEqual({ kind: 'unknown', suggestions: [] })
    expect(resolver.resolve('', have())).toEqual({ kind: 'unknown', suggestions: [] })
    expect(resolver.resolve('ingotz', have())).toMatchObject({ kind: 'unknown' })
  })
})
