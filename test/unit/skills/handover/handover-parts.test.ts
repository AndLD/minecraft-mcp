import { describe, expect, it } from '@jest/globals'
import { MineflayerItemFacts } from '../../../../src/bot/mineflayer-item-facts.js'
import { DropSpot } from '../../../../src/skills/handover/drop-spot.js'
import { ItemThrower } from '../../../../src/skills/handover/item-thrower.js'
import { RequestPlanner } from '../../../../src/skills/handover/request-planner.js'
import { FakeBot } from '../../../fakes/fake-bot.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeBlockScanner } from '../../../fakes/fake-ports.js'
import { AutoScheduler } from '../../../fakes/gathering-fakes.js'
import type { InventoryWriter } from '../../../../src/core/inventory-writer.port.js'

const facts = new MineflayerItemFacts({
  current: () => new FakeBot().useGameData(),
  onChange: () => () => undefined,
})

describe('DropSpot', () => {
  const at = { x: 5.5, y: 64, z: 5.5 }
  function blocks(
    cells: Record<string, string>,
    solid: Record<string, boolean> = { '5,63,5': true },
  ): DropSpot {
    const scanner = new FakeBlockScanner()
    for (const [key, name] of Object.entries(cells)) scanner.blockNames.set(key, name)
    for (const [key, value] of Object.entries(solid)) scanner.solid.set(key, value)
    return new DropSpot(scanner)
  }

  it('accepts solid ground', () => {
    expect(blocks({ '5,64,5': 'air', '5,63,5': 'grass_block' }).problemAt(at)).toBeUndefined()
    expect(blocks({}).problemAt(at)).toBeUndefined() // unloaded blocks are not a reason to refuse
  })

  it.each(['lava', 'fire', 'magma_block', 'cactus'])(
    'refuses %s at the feet or under them',
    (name) => {
      expect(blocks({ '5,64,5': name }).problemAt(at)).toContain(name)
      expect(blocks({ '5,63,5': name }).problemAt(at)).toContain(name)
    },
  )

  it('refuses water, and a place with no ground below', () => {
    expect(blocks({ '5,64,5': 'water' }).problemAt(at)).toContain('water')
    expect(blocks({ '5,63,5': 'water' }).problemAt(at)).toContain('water')
    expect(blocks({ '5,63,5': 'air' }, { '5,63,5': false }).problemAt(at)).toContain('no ground')
  })
})

describe('ItemThrower', () => {
  it('throws each item in turn with a pause, and reports what really left', async () => {
    const clock = new FakeClock()
    const tosses: string[] = []
    const writer: InventoryWriter = {
      toss: (item, count) => {
        tosses.push(`${item}:${String(count)}`)
        return Promise.resolve(item === 'dirt' ? 0 : count)
      },
    }

    const thrown = await new ItemThrower(writer, new AutoScheduler(clock)).throwAll(
      [
        { name: 'coal', count: 5 },
        { name: 'dirt', count: 3 },
        { name: 'sand', count: 2 },
      ],
      new AbortController().signal,
    )

    expect(tosses).toEqual(['coal:5', 'dirt:3', 'sand:2'])
    expect(thrown).toEqual([
      { name: 'coal', count: 5 },
      { name: 'sand', count: 2 },
    ])
    expect(clock.now()).toBe(900)
  })

  it('stops when cancelled', async () => {
    const clock = new FakeClock()
    const controller = new AbortController()
    const writer: InventoryWriter = {
      toss: (_item, count) => {
        controller.abort()
        return Promise.resolve(count)
      },
    }

    const thrown = await new ItemThrower(writer, new AutoScheduler(clock)).throwAll(
      [
        { name: 'coal', count: 5 },
        { name: 'sand', count: 2 },
      ],
      controller.signal,
    )

    expect(thrown).toEqual([{ name: 'coal', count: 5 }])
  })
})

describe('RequestPlanner', () => {
  const planner = new RequestPlanner(facts)
  const have = (carried: Record<string, number> = {}, stored: Record<string, number> = {}) => ({
    carried: new Map(Object.entries(carried)),
    stored: new Map(Object.entries(stored)),
  })
  const plan = (
    requests: Parameters<RequestPlanner['plan']>[0],
    available = have(),
    keepReserve = true,
  ) => {
    const result = planner.plan(requests, available, keepReserve)
    if (!result.ok) throw new Error(result.failure.message)
    return result.plan
  }
  const count = (item: string, n: number) => ({
    item,
    amount: { kind: 'count' as const, count: n },
  })

  it('plans a count, stacks, and everything', () => {
    const result = plan(
      [
        count('iron_ingot', 20),
        { item: 'cobble', amount: { kind: 'stacks', stacks: 3 } },
        { item: 'coal', amount: { kind: 'all' } },
      ],
      have({ coal: 5 }, { coal: 40 }),
    )

    expect(result.wanted).toEqual([
      { name: 'iron_ingot', count: 20, all: false },
      { name: 'cobblestone', count: 192, all: false },
      { name: 'coal', count: 45, all: true },
    ])
  })

  it('adds up several requests for the same item', () => {
    expect(plan([count('dirt', 5), count('dirt', 7)]).wanted).toEqual([
      { name: 'dirt', count: 12, all: false },
    ])
  })

  it('takes a group from the item there is most of first, and moves on to the next when that is not enough', () => {
    const enough = plan([count('logs', 10)], have({ oak_log: 6 }, { birch_log: 20 }))
    const both = plan([count('logs', 24)], have({ oak_log: 6 }, { birch_log: 20 }))

    expect(enough.wanted).toEqual([{ name: 'birch_log', count: 10, all: false }])
    expect(both.wanted).toEqual([
      { name: 'birch_log', count: 20, all: false },
      { name: 'oak_log', count: 4, all: false },
    ])
  })

  it('reports what several items of a group could not cover', () => {
    const result = plan([count('logs', 30)], have({ oak_log: 6 }, { birch_log: 20 }))

    expect(result.wanted.map((w) => [w.name, w.count])).toEqual([
      ['birch_log', 20],
      ['oak_log', 6],
    ])
    expect(result.nothingOf).toEqual([{ name: 'logs', count: 4 }])
  })

  it('leaves the reserve out of group requests, unless told not to, and gives exact names always', () => {
    const carried = have({ cooked_beef: 5, bread: 3, apple: 2 })

    expect(plan([count('food', 5)], carried).wanted).toEqual([])
    expect(plan([count('food', 5)], carried).nothingOf).toEqual([{ name: 'food', count: 5 }])
    expect(plan([count('food', 10)], carried, false).wanted.map((w) => w.name)).toEqual([
      'cooked_beef',
      'bread',
      'apple',
    ])
    expect(plan([count('cooked_beef', 2)], carried).wanted).toEqual([
      { name: 'cooked_beef', count: 2, all: false },
    ])
  })

  it('fails with the candidates when a word is ambiguous, and with suggestions for an unknown one', () => {
    const ambiguous = planner.plan([count('iron', 5)], have({ iron_ingot: 3, raw_iron: 3 }), true)
    const unknown = planner.plan([count('ingotz', 5)], have(), true)

    expect(ambiguous).toMatchObject({
      ok: false,
      failure: {
        reason: 'ambiguous',
        message: expect.stringContaining('Ask the player which') as unknown as string,
      },
    })
    expect(unknown).toMatchObject({ ok: false, failure: { reason: 'unknown_item' } })
  })
})
