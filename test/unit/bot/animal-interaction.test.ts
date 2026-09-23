import { describe, expect, it } from '@jest/globals'
import type { BotHolder, BotLike } from '../../../src/bot/bot-like.types.js'
import { MineflayerAnimalInteraction } from '../../../src/bot/mineflayer-animal-interaction.js'
import { FakeBot } from '../../fakes/fake-bot.js'

const holderOf = (bot: BotLike | undefined): BotHolder => ({
  current: () => bot,
  onChange: () => () => undefined,
})

describe('MineflayerAnimalInteraction', () => {
  it('equips the item in hand', async () => {
    const bot = new FakeBot()
    bot.addItems('wheat', 1)
    const interaction = new MineflayerAnimalInteraction(holderOf(bot))

    const result = await interaction.hold('wheat')

    expect(result).toEqual({ ok: true, value: undefined })
    expect(bot.heldItem?.name).toBe('wheat')
  })

  it('reports no_item when the bot does not carry it', async () => {
    const bot = new FakeBot()
    const interaction = new MineflayerAnimalInteraction(holderOf(bot))

    const result = await interaction.hold('wheat')

    expect(result).toEqual({
      ok: false,
      error: { reason: 'no_item', message: 'The bot has no wheat to hold.' },
    })
  })

  it('reports not_connected for hold and feed when there is no bot', async () => {
    const interaction = new MineflayerAnimalInteraction(holderOf(undefined))

    expect(await interaction.hold('wheat')).toEqual({
      ok: false,
      error: { reason: 'not_connected', message: 'Not connected to a Minecraft world.' },
    })
    expect(await interaction.feed(1)).toEqual({
      ok: false,
      error: { reason: 'not_connected', message: 'Not connected to a Minecraft world.' },
    })
  })

  it('right-clicks the entity', async () => {
    const bot = new FakeBot()
    bot.entities['7'] = { id: 7, type: 'animal', name: 'cow', position: { x: 0, y: 64, z: 0 } }
    const interaction = new MineflayerAnimalInteraction(holderOf(bot))

    const result = await interaction.feed(7)

    expect(result).toEqual({ ok: true, value: undefined })
    expect(bot.activatedEntities).toEqual([7])
  })

  it('reports not_found when the entity is not in view', async () => {
    const bot = new FakeBot()
    const interaction = new MineflayerAnimalInteraction(holderOf(bot))

    const result = await interaction.feed(7)

    expect(result).toEqual({
      ok: false,
      error: { reason: 'not_found', message: 'Entity 7 is not in view.' },
    })
  })

  it('fails cleanly when equip throws', async () => {
    const bot = new FakeBot()
    bot.addItems('wheat', 1)
    bot.failEquip = new Error('too far')
    const interaction = new MineflayerAnimalInteraction(holderOf(bot))

    const result = await interaction.hold('wheat')

    expect(result).toEqual({ ok: false, error: { reason: 'failed', message: 'too far' } })
  })

  it('fails cleanly when activateEntity throws', async () => {
    const bot = new FakeBot()
    bot.entities['7'] = { id: 7, type: 'animal', name: 'cow', position: { x: 0, y: 64, z: 0 } }
    bot.activateEntity = () => Promise.reject(new Error('too far'))
    const interaction = new MineflayerAnimalInteraction(holderOf(bot))

    const result = await interaction.feed(7)

    expect(result).toEqual({ ok: false, error: { reason: 'failed', message: 'too far' } })
  })
})
