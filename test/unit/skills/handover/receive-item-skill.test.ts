import { describe, expect, it } from '@jest/globals'
import type { ItemFacts } from '../../../../src/core/item-facts.port.js'
import type { Scheduler } from '../../../../src/core/scheduler.port.js'
import type { DropFilter } from '../../../../src/skills/gathering/drop-collector.js'
import { ReceiveItemSkill } from '../../../../src/skills/handover/receive-item-skill.js'
import { Bag } from '../../../fakes/bag-fakes.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeChatPort, FakeEntityScanner } from '../../../fakes/fake-ports.js'
import { FakeGaze, playerAt } from '../../../fakes/handover-fakes.js'
import { FakeDroppedItems, InstantNavigator, skillContext } from '../../../fakes/gathering-fakes.js'
import { FakeCombatant } from '../../../fakes/reflex-fakes.js'

const facts: ItemFacts = {
  isItem: () => true,
  isFood: (name) => name === 'bread',
  isBlock: () => false,
  stackSize: () => 64,
  allItems: () => [],
}

/** A scheduler that moves the clock and lets the test script what happens at each moment. */
class Script implements Scheduler {
  onTick: (now: number) => void = () => undefined
  constructor(private readonly clock: FakeClock) {}
  after(ms: number, callback: () => void): () => void {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      this.clock.advance(ms)
      this.onTick(this.clock.now())
      callback()
    })
    return () => {
      cancelled = true
    }
  }
}

function setup(items: Record<string, number> = {}) {
  const clock = new FakeClock()
  const scheduler = new Script(clock)
  const scanner = new FakeEntityScanner()
  const drops = new FakeDroppedItems()
  const bag = new Bag(items)
  const chat = new FakeChatPort()
  const navigator = new InstantNavigator()
  const gaze = new FakeGaze()
  const combatant = new FakeCombatant()
  const pickedUp: DropFilter[] = []
  /** Picks up what the filter accepts, unless the bag is full. */
  const collector = {
    collect: (filter: DropFilter) => {
      pickedUp.push(filter)
      for (const item of drops
        .nearby(filter.maxDistance)
        .filter((i) => filter.accept?.(i) !== false))
        if ((bag.value?.emptySlots ?? 1) > 0) {
          drops.remove(item.entityId)
          bag.give(item.name, item.count)
        }
      return Promise.resolve()
    },
  }
  const skill = new ReceiveItemSkill({
    entities: scanner,
    navigator,
    gaze,
    drops,
    collector: { collect: collector.collect } as never,
    inventory: bag,
    facts,
    chat,
    combatant,
    scheduler,
    clock,
  })
  const place = (): void => {
    playerAt(scanner, 'Alex', PLAYER)
    navigator.players.set('Alex', PLAYER)
  }
  return {
    place,
    skill,
    scheduler,
    scanner,
    drops,
    bag,
    chat,
    navigator,
    gaze,
    combatant,
    clock,
    pickedUp,
  }
}

const PLAYER = { x: 10, y: 64, z: 10 }
const ask = { player: 'Alex', item: undefined, count: undefined, useIt: false, timeoutMs: 30_000 }

describe('ReceiveItemSkill', () => {
  it('walks up to the player, faces them, and takes an item thrown after the wait began', async () => {
    const s = setup()
    s.place()
    s.scheduler.onTick = (now) => {
      if (now >= 2_000 && s.drops.items.length === 0 && s.bag.count('diamond_pickaxe') === 0)
        s.drops.drop('diamond_pickaxe', { x: 11, y: 64, z: 10 }, 2, 1)
    }
    const { context } = skillContext()

    const result = await s.skill.run({ ...ask, item: 'pickaxe' }, context)

    expect(result).toEqual({
      ok: true,
      value: { received: [{ name: 'diamond_pickaxe', count: 1 }] },
    })
    expect(s.navigator.playerTrips).toEqual([{ player: 'Alex', within: 1.5 }])
    expect(s.gaze.looked).toEqual([PLAYER])
    expect(s.chat.said).toEqual(['Ready: throw me the pickaxe.', 'Got 1 diamond pickaxe.'])
  })

  it('does not walk when the player is already close', async () => {
    const s = setup()
    s.scanner.players.set('alex', { name: 'Alex', online: true, position: PLAYER, distance: 2 })
    s.scheduler.onTick = () => {
      if (s.bag.count('stick') === 0 && s.drops.items.length === 0)
        s.drops.drop('stick', PLAYER, 2, 3)
    }
    const { context } = skillContext()

    const result = await s.skill.run(ask, context)

    expect(result).toMatchObject({ ok: true, value: { received: [{ name: 'stick', count: 3 }] } })
    expect(s.navigator.playerTrips).toEqual([])
  })

  it('leaves what lay on the ground before, and what is the wrong item or too far from the player', async () => {
    const s = setup()
    s.place()
    s.drops.drop('iron_pickaxe', { x: 11, y: 64, z: 10 }, 2, 1) // was there before
    s.scheduler.onTick = (now) => {
      if (now === 1_000) {
        s.drops.drop('cobblestone', { x: 11, y: 64, z: 10 }, 2, 4) // wrong item
        s.drops.drop('diamond_pickaxe', { x: 40, y: 64, z: 10 }, 2, 1) // far from the player
      }
    }
    const { context } = skillContext()

    const result = await s.skill.run({ ...ask, item: 'pickaxe', timeoutMs: 5_000 }, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'nothing_received' } })
    expect(s.bag.count('iron_pickaxe')).toBe(0)
    expect(s.chat.said.at(-1)).toBe('Nothing came my way.')
  })

  it('takes a group, and stops at count', async () => {
    const s = setup()
    s.place()
    let thrown = 0
    s.scheduler.onTick = () => {
      if (thrown < 3) {
        thrown += 1
        s.drops.drop(thrown === 1 ? 'iron_sword' : 'iron_axe', { x: 11, y: 64, z: 10 }, 2, 1)
      }
    }
    const { context } = skillContext()

    const result = await s.skill.run({ ...ask, item: 'tools', count: 2 }, context)

    expect(result).toMatchObject({ ok: true })
    const got = result.ok ? result.value.received.reduce((sum, e) => sum + e.count, 0) : 0
    expect(got).toBeGreaterThanOrEqual(2)
  })

  it('with use_it equips the best gear and says so', async () => {
    const s = setup()
    s.place()
    s.combatant.gear = { weapon: 'diamond_sword', armor: [] }
    s.scheduler.onTick = () => {
      if (s.bag.count('diamond_sword') === 0 && s.drops.items.length === 0)
        s.drops.drop('diamond_sword', { x: 11, y: 64, z: 10 }, 2, 1)
    }
    const { context } = skillContext()

    const result = await s.skill.run({ ...ask, item: 'sword', useIt: true }, context)

    expect(result).toMatchObject({ ok: true, value: { equipped: { weapon: 'diamond_sword' } } })
    expect(s.combatant.gearCalls).toBe(1)
    expect(s.chat.said.at(-1)).toBe('Equipped diamond sword.')
  })

  it('ends nothing_received after the wait when nothing is thrown, with one line in chat', async () => {
    const s = setup()
    s.place()
    const { context } = skillContext()

    const result = await s.skill.run({ ...ask, timeoutMs: 4_000 }, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'nothing_received' } })
    expect(s.chat.said).toEqual(['Ready: throw me the item.', 'Nothing came my way.'])
    expect(s.clock.now()).toBeLessThan(10_000)
  })

  it('fails when the player is offline or out of view at the start, and when they leave or vanish', async () => {
    const s = setup()
    const { context } = skillContext()
    expect(await s.skill.run(ask, context)).toMatchObject({
      ok: false,
      error: { reason: 'player_offline' },
    })

    s.scanner.players.set('alex', {
      name: 'Alex',
      online: true,
      position: undefined,
      distance: undefined,
    })
    expect(await s.skill.run(ask, context)).toMatchObject({
      ok: false,
      error: { reason: 'player_lost' },
    })

    s.place()
    s.scheduler.onTick = (now) => {
      if (now === 1_500) s.scanner.players.delete('alex')
    }
    expect(await s.skill.run(ask, context)).toMatchObject({
      ok: false,
      error: { reason: 'player_offline' },
    })

    s.place()
    s.scheduler.onTick = (now) => {
      if (now >= s.clock.now() && now > 0)
        s.scanner.players.set('alex', {
          name: 'Alex',
          online: true,
          position: undefined,
          distance: undefined,
        })
    }
    expect(await s.skill.run({ ...ask, timeoutMs: 60_000 }, context)).toMatchObject({
      ok: false,
      error: { reason: 'player_lost' },
    })
  })

  it('leaves the item on the ground and says so when the inventory is full', async () => {
    const s = setup()
    if (s.bag.value !== undefined) s.bag.value = { ...s.bag.value, emptySlots: 0 }
    s.place()
    s.scheduler.onTick = () => {
      if (s.drops.items.length === 0) s.drops.drop('diamond_pickaxe', { x: 11, y: 64, z: 10 }, 2, 1)
    }
    const { context } = skillContext()

    const result = await s.skill.run({ ...ask, timeoutMs: 5_000 }, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'inventory_full' } })
    if (!result.ok) expect(result.error.message).toContain('diamond_pickaxe')
    expect(s.chat.said.at(-1)).toContain('full')
  })

  it('stops when cancelled', async () => {
    const s = setup()
    s.place()
    const { context, controller } = skillContext()
    s.scheduler.onTick = () => {
      controller.abort()
    }

    expect(await s.skill.run(ask, context)).toMatchObject({
      ok: false,
      error: { reason: 'aborted' },
    })
  })
})
