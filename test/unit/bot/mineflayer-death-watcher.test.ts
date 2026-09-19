import { describe, expect, it } from '@jest/globals'
import type { BotHolder, BotLike } from '../../../src/bot/bot-like.types.js'
import { countSlots, MineflayerDeathWatcher } from '../../../src/bot/mineflayer-death-watcher.js'
import type { DeathEvent } from '../../../src/core/death-watcher.port.js'
import { FakeBot } from '../../fakes/fake-bot.js'
import { FakeClock } from '../../fakes/fake-clock.js'

class Holder implements BotHolder {
  bot: BotLike | undefined
  private listeners: ((bot: BotLike | undefined) => void)[] = []
  current(): BotLike | undefined {
    return this.bot
  }
  onChange(listener: (bot: BotLike | undefined) => void): () => void {
    this.listeners.push(listener)
    return () => undefined
  }
  set(bot: BotLike | undefined): void {
    this.bot = bot
    for (const listener of this.listeners) listener(bot)
  }
}

function setup() {
  const holder = new Holder()
  const bot = new FakeBot()
  bot.entity = { position: { x: 12.5, y: 70, z: -3.5 } }
  bot.slots[9] = { name: 'iron_ingot', count: 20 }
  bot.slots[10] = { name: 'iron_ingot', count: 5 }
  bot.slots[6] = { name: 'iron_chestplate', count: 1 }
  holder.set(bot)
  const clock = new FakeClock(100_000)
  const watcher = new MineflayerDeathWatcher(holder, clock)
  const deaths: DeathEvent[] = []
  watcher.onDeath((event) => deaths.push(event))
  return { holder, bot, watcher, deaths, clock }
}

describe('countSlots', () => {
  it('adds up stacks by name and skips empty slots', () => {
    expect(
      countSlots([
        { name: 'stick', count: 3 },
        null,
        { name: 'stick', count: 4 },
        { name: 'bow', count: 1 },
      ]),
    ).toEqual([
      { name: 'stick', count: 7 },
      { name: 'bow', count: 1 },
    ])
  })
})

describe('MineflayerDeathWatcher', () => {
  it('reports the death at the respawn, with the place and everything carried and worn', () => {
    const { bot, deaths } = setup()

    bot.health = 0
    bot.emit('death')
    bot.entity = { position: { x: 48, y: 81, z: 32 } } // the respawn moves the bot
    bot.emit('respawn')

    expect(deaths).toEqual([
      {
        position: { x: 12.5, y: 70, z: -3.5 },
        dimension: 'overworld',
        carried: [
          { name: 'iron_chestplate', count: 1 },
          { name: 'iron_ingot', count: 25 },
        ],
        cause: undefined,
      },
    ])
  })

  it('says why, from the first server message about the bot after the death', () => {
    const { bot, deaths } = setup()

    bot.emit('messagestr', 'Andrey_Knight joined the game')
    bot.emit('death')
    bot.emit('messagestr', 'ClaudeBot was slain by Zombie')
    bot.emit('messagestr', 'ClaudeBot fell out of the world')
    bot.emit('respawn')

    expect(deaths[0]?.cause).toBe('ClaudeBot was slain by Zombie')
  })

  it('counts what was carried a moment ago when the server empties the inventory before announcing the death', () => {
    const { bot, deaths, clock } = setup()
    bot.inventoryChanged() // the items were given
    clock.advance(500)
    bot.slots.fill(null) // the server cleared it ...
    bot.inventoryItems = []
    bot.inventoryChanged()
    clock.advance(50)

    bot.emit('death') // ... and only then announced the death
    bot.emit('respawn')

    expect(deaths[0]?.carried).toEqual([
      { name: 'iron_chestplate', count: 1 },
      { name: 'iron_ingot', count: 25 },
    ])
  })

  it('still knows what was carried when nothing changed for a long time before the death', () => {
    const { bot, deaths, clock } = setup()
    bot.inventoryChanged()
    clock.advance(60_000)
    bot.slots.fill(null)
    bot.inventoryChanged() // emptied just before the death

    bot.emit('death')
    bot.emit('respawn')

    expect(deaths[0]?.carried).toHaveLength(2)
  })

  it('does not count what was carried long before the window when it was used up since', () => {
    const { bot, deaths, clock } = setup()
    bot.inventoryChanged()
    clock.advance(5_000)
    bot.slots.fill(null) // used up 5 seconds ago
    bot.inventoryChanged()
    clock.advance(4_000)

    bot.emit('death')
    bot.emit('respawn')

    expect(deaths[0]?.carried).toEqual([])
  })

  it('does not treat changes while dying as fresh looks', () => {
    const { bot, deaths } = setup()
    bot.emit('death')
    bot.slots.fill(null)

    bot.inventoryChanged()
    bot.emit('respawn')

    expect(deaths[0]?.carried).toHaveLength(2)
  })

  it('ignores a respawn without a death (the first spawn, a dimension change)', () => {
    const { bot, deaths } = setup()

    bot.emit('respawn')

    expect(deaths).toEqual([])
  })

  it('reports each death once, and can be unsubscribed', () => {
    const { bot, watcher, deaths } = setup()
    const later: DeathEvent[] = []
    const off = watcher.onDeath((event) => later.push(event))

    bot.emit('death')
    bot.emit('respawn')
    bot.emit('respawn')
    off()
    bot.emit('death')
    bot.emit('respawn')

    expect(deaths).toHaveLength(2)
    expect(later).toHaveLength(1)
  })

  it('follows the current bot across reconnects and lets go of the old one', () => {
    const { holder, bot, deaths } = setup()
    const next = new FakeBot()
    next.entity = { position: { x: 1, y: 2, z: 3 } }
    next.slots[9] = { name: 'stick', count: 2 }

    holder.set(undefined)
    expect(bot.listenerCount('death')).toBe(0)
    expect(bot.inventory.listenerCount()).toBe(0)
    holder.set(next)
    next.emit('death')
    next.emit('respawn')

    expect(deaths).toMatchObject([
      { position: { x: 1, y: 2, z: 3 }, carried: [{ name: 'stick', count: 2 }] },
    ])
  })

  it('reads what is carried now across all slots, and nothing without a bot', () => {
    const { holder, watcher } = setup()
    expect(watcher.carried()).toHaveLength(2)

    holder.set(undefined)

    expect(watcher.carried()).toEqual([])
  })
})
