import { describe, expect, it } from '@jest/globals'
import type { BotHolder, BotLike, EntityLike } from '../../../src/bot/bot-like.types.js'
import { MineflayerAnimalScanner } from '../../../src/bot/mineflayer-animal-scanner.js'
import { ANIMAL_KEYS, FakeBot } from '../../fakes/fake-bot.js'

const holderOf = (bot: BotLike | undefined): BotHolder => ({
  current: () => bot,
  onChange: () => () => undefined,
})

/** Metadata as Mineflayer holds it: values at the index of each key. */
function metadata(keys: readonly string[], values: Record<string, unknown>): unknown[] {
  return keys.map((key) => values[key])
}

function cow(id: number, x: number, over: Partial<EntityLike> = {}): EntityLike {
  return {
    id,
    type: 'animal',
    name: 'cow',
    position: { x, y: 64, z: -5 },
    metadata: metadata(ANIMAL_KEYS, {}),
    ...over,
  }
}

describe('MineflayerAnimalScanner', () => {
  it('lists animals nearest first, reading baby, name, owner, saddle, and riders from the metadata', () => {
    const bot = new FakeBot() // stands at (10, 64, -5)
    bot.entities = {
      '1': cow(1, 16),
      '2': cow(2, 13, { metadata: metadata(ANIMAL_KEYS, { baby: true }) }),
      '3': cow(3, 14, { metadata: metadata(ANIMAL_KEYS, { custom_name: { text: 'Bessie' } }) }),
      '4': {
        id: 4,
        type: 'animal',
        name: 'wolf',
        position: { x: 12, y: 64, z: -5 },
        metadata: metadata([...ANIMAL_KEYS, 'flags', 'owneruuid'], { owneruuid: 'abcd' }),
      },
      '5': {
        id: 5,
        type: 'animal',
        name: 'pig',
        position: { x: 11, y: 64, z: -5 },
        metadata: metadata([...ANIMAL_KEYS, 'saddle'], { saddle: true }),
        passengers: [{}],
      },
    }

    const found = new MineflayerAnimalScanner(holderOf(bot)).nearby(20)

    expect(found.map((a) => [a.species, a.distance])).toEqual([
      ['pig', 1],
      ['wolf', 2],
      ['cow', 3],
      ['cow', 4],
      ['cow', 6],
    ])
    expect(found[0]).toMatchObject({ saddled: true, ridden: true, baby: false, named: false })
    expect(found[1]).toMatchObject({ owned: true })
    expect(found[2]).toMatchObject({ baby: true })
    expect(found[3]).toMatchObject({ named: true })
    expect(found[4]).toMatchObject({
      baby: false,
      named: false,
      owned: false,
      saddled: false,
      ridden: false,
      dead: false,
    })
  })

  it('treats null metadata values as absent', () => {
    const bot = new FakeBot()
    bot.entities = { '1': cow(1, 12, { metadata: metadata(ANIMAL_KEYS, { custom_name: null }) }) }

    expect(new MineflayerAnimalScanner(holderOf(bot)).nearby(10)[0]?.named).toBe(false)
  })

  it('skips far animals, other kinds of entities, dead ones, and removed ones', () => {
    const bot = new FakeBot()
    bot.entities = {
      '1': cow(1, 60),
      '2': { id: 2, type: 'hostile', name: 'zombie', position: { x: 11, y: 64, z: -5 } },
      '3': cow(3, 12, { isDead: true }),
      '4': cow(4, 13, { isValid: false }),
      '5': { id: 5, type: 'passive', name: 'villager', position: { x: 12, y: 64, z: -5 } },
    }

    expect(new MineflayerAnimalScanner(holderOf(bot)).nearby(20).map((a) => a.species)).toEqual([
      'villager',
    ])
  })

  it('reads an animal without metadata keys as a plain adult', () => {
    const bot = new FakeBot()
    bot.entities = {
      '1': { id: 1, type: 'animal', name: 'axolotl', position: { x: 12, y: 64, z: -5 } },
    }

    expect(new MineflayerAnimalScanner(holderOf(bot)).nearby(10)[0]).toMatchObject({
      baby: false,
      named: false,
    })
  })

  it('finds one animal by id, dead ones too, and nothing once it is removed', () => {
    const bot = new FakeBot()
    bot.entities = { '1': cow(1, 12, { isDead: true }), '2': cow(2, 13, { isValid: false }) }
    const scanner = new MineflayerAnimalScanner(holderOf(bot))

    expect(scanner.find(1)).toMatchObject({ species: 'cow', dead: true })
    expect(scanner.find(2)).toBeUndefined()
    expect(scanner.find(9)).toBeUndefined()
  })

  it('sees nothing without a bot or before the bot is in the world', () => {
    expect(new MineflayerAnimalScanner(holderOf(undefined)).nearby(10)).toEqual([])
    expect(new MineflayerAnimalScanner(holderOf(undefined)).find(1)).toBeUndefined()
    const bot = new FakeBot()
    bot.entity = undefined
    bot.entities = { '1': cow(1, 12) }
    expect(new MineflayerAnimalScanner(holderOf(bot)).nearby(10)).toEqual([])
  })

  it("reads a sheep's colour and whether it is sheared from the wool byte", () => {
    const bot = new FakeBot()
    const sheep = (id: number, wool: number | undefined): EntityLike => ({
      id,
      type: 'animal',
      name: 'sheep',
      position: { x: 11 + id, y: 64, z: -5 },
      metadata: metadata([...ANIMAL_KEYS, 'wool'], { wool }),
    })
    bot.entities = {
      '1': sheep(1, 0),
      '2': sheep(2, 3 | 0x10),
      '3': sheep(3, undefined),
      '4': cow(4, 20),
    }

    const [white, sheared, unknown, other] = new MineflayerAnimalScanner(holderOf(bot)).nearby(30)

    expect(white).toMatchObject({ colour: 'white', sheared: false })
    expect(sheared).toMatchObject({ colour: 'light_blue', sheared: true })
    expect(unknown?.sheared).toBeUndefined()
    expect(other?.colour).toBeUndefined()
  })

  it('reads whether a bee is angry from its remaining anger time', () => {
    const bot = new FakeBot().useGameData()
    const keys = bot.registry.entitiesByName['bee']?.metadataKeys ?? []
    const bee = (id: number, anger: number): EntityLike => ({
      id,
      type: 'animal',
      name: 'bee',
      position: { x: 11 + id, y: 64, z: -5 },
      metadata: metadata(keys, { remaining_anger_time: anger }),
    })
    bot.entities = { '1': bee(1, 0), '2': bee(2, 400), '3': cow(3, 20) }

    const [calm, angry, other] = new MineflayerAnimalScanner(holderOf(bot)).nearby(30)

    expect(calm?.angry).toBe(false)
    expect(angry?.angry).toBe(true)
    expect(other?.angry).toBeUndefined()
  })
})
