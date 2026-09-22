import { describe, expect, it } from '@jest/globals'
import type { BotHolder, BotLike, EntityLike } from '../../../src/bot/bot-like.types.js'
import { MineflayerContainerAccess } from '../../../src/bot/mineflayer-container-access.js'
import { MineflayerItemFacts } from '../../../src/bot/mineflayer-item-facts.js'
import { MineflayerLookTarget } from '../../../src/bot/mineflayer-look-target.js'
import { FakeBot } from '../../fakes/fake-bot.js'

const holderOf = (bot: BotLike | undefined): BotHolder => ({
  current: () => bot,
  onChange: () => () => undefined,
})

function gameBot(): FakeBot {
  const bot = new FakeBot().useGameData()
  bot.entity = { position: { x: 0.5, y: 64, z: 0.5 } }
  return bot
}
const chestAt = { x: 2, y: 64, z: 0 }

describe('MineflayerContainerAccess', () => {
  const access = (bot: FakeBot | undefined) =>
    new MineflayerContainerAccess(
      holderOf(bot),
      new MineflayerItemFacts(holderOf(bot ?? gameBot())),
    )

  it('opens a chest, reads it, and moves items in and out through the real game data', async () => {
    const bot = gameBot()
    bot.setBlock(chestAt, 'chest')
    bot.stock(chestAt, 'iron_ingot', 30)
    bot.inventoryItems = [{ name: 'cobblestone', count: 100 }]
    const opened = await access(bot).open(chestAt)
    if (!opened.ok) throw new Error(opened.error)
    const session = opened.value

    expect(session.contents()).toEqual({
      stacks: [{ name: 'iron_ingot', count: 30 }],
      totalSlots: 27,
      emptySlots: 26,
    })
    expect(await session.deposit('cobblestone', undefined)).toBe(100)
    expect(await session.withdraw('iron_ingot', 10)).toBe(10)
    await session.close()

    expect(bot.inContainer(chestAt, 'cobblestone')).toBe(100)
    expect(bot.count('iron_ingot')).toBe(10)
    expect(bot.count('cobblestone')).toBe(0)
    expect(bot.windows[0]?.closed).toBe(true)
  })

  it('opens barrels and shulker boxes too, and refuses other blocks', async () => {
    const bot = gameBot()
    bot.setBlock({ x: 2, y: 64, z: 0 }, 'barrel')
    bot.setBlock({ x: 3, y: 64, z: 0 }, 'red_shulker_box')
    bot.setBlock({ x: 4, y: 64, z: 0 }, 'furnace')

    expect((await access(bot).open({ x: 2, y: 64, z: 0 })).ok).toBe(true)
    expect((await access(bot).open({ x: 3, y: 64, z: 0 })).ok).toBe(true)
    expect(await access(bot).open({ x: 4, y: 64, z: 0 })).toEqual({
      ok: false,
      error: 'There is no chest, barrel, or shulker box there.',
    })
    expect(await access(bot).open({ x: 9, y: 64, z: 0 })).toMatchObject({ ok: false })
  })

  it('reports being offline, and a container the server would not open', async () => {
    const bot = gameBot()
    bot.setBlock(chestAt, 'chest')
    bot.openContainerWindow = () => Promise.reject(new Error('too far away'))

    expect(await access(undefined).open(chestAt)).toEqual({
      ok: false,
      error: 'Not connected to a Minecraft world.',
    })
    expect(await access(bot).open(chestAt)).toEqual({ ok: false, error: 'too far away' })
  })

  it('reads a double chest as one container', async () => {
    const bot = gameBot()
    bot.setBlock(chestAt, 'chest')
    bot.containerSlots = 54
    const opened = await access(bot).open(chestAt)
    if (!opened.ok) throw new Error(opened.error)

    expect(opened.value.contents().totalSlots).toBe(54)
  })
})

describe('MineflayerLookTarget', () => {
  function withPlayer(over: Partial<EntityLike> = {}): FakeBot {
    const bot = gameBot()
    bot.players['Andrey_Knight'] = {
      username: 'Andrey_Knight',
      entity: {
        id: 9,
        type: 'player',
        position: { x: 10, y: 64, z: 10 },
        yaw: 0,
        pitch: 0,
        ...over,
      },
    }
    return bot
  }

  it("casts a ray from the player's eyes in the direction they look", () => {
    const bot = withPlayer()
    bot.rayHit = { name: 'chest', position: { x: 10, y: 65, z: 8 } }

    const hit = new MineflayerLookTarget(holderOf(bot)).blockLookedAt('andrey_knight')

    expect(hit).toEqual({ name: 'chest', position: { x: 10, y: 65, z: 8 }, face: 'north' })
    expect(bot.rays[0]?.from).toMatchObject({ x: 10, y: 65.62, z: 10 })
    expect(bot.rays[0]?.direction.x).toBeCloseTo(-0) // yaw 0 faces -z
    expect(bot.rays[0]?.direction.z).toBeCloseTo(-1)
    expect(bot.rays[0]?.range).toBe(8)
  })

  it('reports the face the ray hit, for every side', () => {
    const bot = withPlayer()
    const faces: [number, string][] = [
      [0, 'bottom'],
      [1, 'top'],
      [2, 'north'],
      [3, 'south'],
      [4, 'west'],
      [5, 'east'],
    ]
    for (const [face, name] of faces) {
      bot.rayHit = { name: 'stone', position: { x: 1, y: 2, z: 3 }, face }
      expect(new MineflayerLookTarget(holderOf(bot)).blockLookedAt('Andrey_Knight')?.face).toBe(
        name,
      )
    }
  })

  it('follows yaw and pitch', () => {
    const bot = withPlayer({ yaw: Math.PI / 2, pitch: Math.PI / 4 })

    new MineflayerLookTarget(holderOf(bot)).blockLookedAt('Andrey_Knight')

    const direction = bot.rays[0]?.direction
    expect(direction?.x).toBeCloseTo(-Math.cos(Math.PI / 4)) // yaw 90 degrees faces -x
    expect(direction?.y).toBeCloseTo(Math.sin(Math.PI / 4))
    expect(direction?.z).toBeCloseTo(0)
  })

  it('finds nothing when the ray hits nothing, the player is out of view, or there is no bot', () => {
    const bot = withPlayer()
    const far = gameBot()
    far.players['Andrey_Knight'] = { username: 'Andrey_Knight' }

    expect(new MineflayerLookTarget(holderOf(bot)).blockLookedAt('Andrey_Knight')).toBeUndefined()
    expect(new MineflayerLookTarget(holderOf(far)).blockLookedAt('Andrey_Knight')).toBeUndefined()
    expect(new MineflayerLookTarget(holderOf(bot)).blockLookedAt('Nobody')).toBeUndefined()
    expect(
      new MineflayerLookTarget(holderOf(undefined)).blockLookedAt('Andrey_Knight'),
    ).toBeUndefined()
  })

  it('finds nothing when the entity has no look direction yet', () => {
    const bot = withPlayer({ yaw: undefined })

    expect(new MineflayerLookTarget(holderOf(bot)).blockLookedAt('Andrey_Knight')).toBeUndefined()
  })
})
