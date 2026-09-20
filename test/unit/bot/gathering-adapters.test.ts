import { describe, expect, it } from '@jest/globals'
import type { BotHolder, BotLike } from '../../../src/bot/bot-like.types.js'
import { MineflayerDigger } from '../../../src/bot/mineflayer-digger.js'
import { MineflayerDroppedItems } from '../../../src/bot/mineflayer-dropped-items.js'
import { MineflayerFurnaceAccess } from '../../../src/bot/mineflayer-furnace.js'
import { MineflayerLightReader } from '../../../src/bot/mineflayer-light-reader.js'
import { MineflayerPlacer } from '../../../src/bot/mineflayer-placer.js'
import { MineflayerRecipes } from '../../../src/bot/mineflayer-recipes.js'
import { FakeBot } from '../../fakes/fake-bot.js'

const holderOf = (bot: BotLike | undefined): BotHolder => ({
  current: () => bot,
  onChange: () => () => undefined,
})

/** A bot standing at (0.5, 64, 0.5) on stone, in the real 1.21.1 game data. */
function gameBot(): FakeBot {
  const bot = new FakeBot().useGameData()
  bot.entity = { position: { x: 0.5, y: 64, z: 0.5 } }
  return bot
}

const noSignal = new AbortController().signal

describe('MineflayerDigger', () => {
  it('reads nothing without a bot or an unloaded block', () => {
    expect(new MineflayerDigger(holderOf(undefined)).assess({ x: 1, y: 64, z: 0 })).toBeUndefined()
    expect(new MineflayerDigger(holderOf(gameBot())).assess({ x: 1, y: 64, z: 0 })).toBeUndefined()
  })

  it('needs no tool for dirt', () => {
    const bot = gameBot()
    bot.setBlock({ x: 1, y: 64, z: 0 }, 'dirt')

    expect(new MineflayerDigger(holderOf(bot)).assess({ x: 1, y: 64, z: 0 })).toEqual({
      blockName: 'dirt',
      diggable: true,
      requiredTools: [],
      canHarvest: true,
      tool: undefined,
    })
  })

  it('says iron ore needs a stone pickaxe or better, and whether the bot has one', () => {
    const bot = gameBot()
    bot.setBlock({ x: 1, y: 64, z: 0 }, 'iron_ore')
    const digger = new MineflayerDigger(holderOf(bot))
    bot.inventoryItems = [{ name: 'wooden_pickaxe', count: 1 }]

    const without = digger.assess({ x: 1, y: 64, z: 0 })
    bot.inventoryItems = [
      { name: 'wooden_pickaxe', count: 1 },
      { name: 'iron_pickaxe', count: 1 },
    ]
    const withIron = digger.assess({ x: 1, y: 64, z: 0 })

    expect(without?.requiredTools).toEqual(
      expect.arrayContaining([
        'stone_pickaxe',
        'iron_pickaxe',
        'diamond_pickaxe',
        'netherite_pickaxe',
      ]),
    )
    expect(without?.requiredTools).not.toContain('wooden_pickaxe')
    expect(without).toMatchObject({ canHarvest: false, tool: undefined })
    expect(withIron).toMatchObject({ canHarvest: true, tool: 'iron_pickaxe' })
  })

  it.each(['air', 'water', 'lava', 'bedrock'])('cannot dig %s', (name) => {
    const bot = gameBot()
    bot.setBlock({ x: 1, y: 64, z: 0 }, name)

    expect(new MineflayerDigger(holderOf(bot)).assess({ x: 1, y: 64, z: 0 })?.diggable).toBe(false)
  })

  it('takes the right tool in hand, digs, and leaves the drop', async () => {
    const bot = gameBot()
    bot.setBlock({ x: 2, y: 64, z: 0 }, 'iron_ore')
    bot.inventoryItems = [{ name: 'stone_pickaxe', count: 1 }]

    const result = await new MineflayerDigger(holderOf(bot)).dig({ x: 2, y: 64, z: 0 }, noSignal)

    expect(result).toEqual({ ok: true, value: undefined })
    expect(bot.heldItem?.name).toBe('stone_pickaxe')
    expect(bot.dug).toEqual([{ name: 'iron_ore', position: { x: 2, y: 64, z: 0 } }])
    expect(Object.values(bot.entities).map((e) => e.getDroppedItem?.()?.name)).toEqual(['raw_iron'])
  })

  it('does not swap tools when the right one is already in hand', async () => {
    const bot = gameBot()
    bot.setBlock({ x: 2, y: 64, z: 0 }, 'stone')
    bot.inventoryItems = [{ name: 'wooden_pickaxe', count: 1 }]
    bot.heldItem = { name: 'wooden_pickaxe', count: 1 }

    await new MineflayerDigger(holderOf(bot)).dig({ x: 2, y: 64, z: 0 }, noSignal)

    expect(bot.equipped).toEqual([])
  })

  it('reports blocks it cannot dig, or that are too far, without trying', async () => {
    const bot = gameBot()
    bot.setBlock({ x: 2, y: 64, z: 0 }, 'bedrock')
    bot.setBlock({ x: 9, y: 64, z: 0 }, 'dirt')
    const digger = new MineflayerDigger(holderOf(bot))

    expect(await digger.dig({ x: 2, y: 64, z: 0 }, noSignal)).toMatchObject({
      ok: false,
      error: { reason: 'not_diggable' },
    })
    expect(await digger.dig({ x: 9, y: 64, z: 0 }, noSignal)).toMatchObject({
      ok: false,
      error: { reason: 'out_of_reach' },
    })
    expect(await digger.dig({ x: 3, y: 64, z: 0 }, noSignal)).toMatchObject({
      ok: false,
      error: { reason: 'failed', message: 'That block is not loaded.' },
    })
    expect(bot.dug).toEqual([])
  })

  it('reports not connected, and an already aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const bot = gameBot()
    bot.setBlock({ x: 2, y: 64, z: 0 }, 'dirt')

    expect(
      await new MineflayerDigger(holderOf(undefined)).dig({ x: 2, y: 64, z: 0 }, noSignal),
    ).toMatchObject({
      ok: false,
      error: { reason: 'not_connected' },
    })
    expect(
      await new MineflayerDigger(holderOf(bot)).dig({ x: 2, y: 64, z: 0 }, controller.signal),
    ).toMatchObject({
      ok: false,
      error: { reason: 'aborted' },
    })
  })

  it('stops digging when aborted mid-way', async () => {
    const bot = gameBot()
    bot.holdDigs = true
    bot.setBlock({ x: 2, y: 64, z: 0 }, 'dirt')
    const controller = new AbortController()

    const pending = new MineflayerDigger(holderOf(bot)).dig(
      { x: 2, y: 64, z: 0 },
      controller.signal,
    )
    await Promise.resolve()
    controller.abort()

    expect(await pending).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    expect(bot.stopDiggingCalls).toBe(1)
  })

  it('reports a dig the server refused, and a tool that cannot be taken in hand', async () => {
    const bot = gameBot()
    bot.setBlock({ x: 2, y: 64, z: 0 }, 'dirt')
    bot.digFailure = new Error('block changed')
    const digger = new MineflayerDigger(holderOf(bot))

    expect(await digger.dig({ x: 2, y: 64, z: 0 }, noSignal)).toMatchObject({
      ok: false,
      error: { reason: 'failed', message: 'block changed' },
    })

    bot.digFailure = undefined
    bot.setBlock({ x: 2, y: 64, z: 0 }, 'stone')
    bot.inventoryItems = [{ name: 'stone_pickaxe', count: 1 }]
    bot.failEquip = new Error('no hand')
    expect(await digger.dig({ x: 2, y: 64, z: 0 }, noSignal)).toMatchObject({
      ok: false,
      error: {
        reason: 'failed',
        message: expect.stringContaining('stone_pickaxe') as unknown as string,
      },
    })
  })
})

describe('MineflayerDroppedItems', () => {
  it('lists dropped items nearest first with their names and counts', () => {
    const bot = gameBot()
    bot.dropItem('oak_log', 3, { x: 5.5, y: 64, z: 0.5 })
    const near = bot.dropItem('apple', 1, { x: 2.5, y: 64, z: 0.5 })
    bot.entities['1'] = {
      id: 1,
      type: 'hostile',
      name: 'zombie',
      position: { x: 1.5, y: 64, z: 0.5 },
    }

    const found = new MineflayerDroppedItems(holderOf(bot)).nearby(10)

    expect(found.map((f) => [f.name, f.count, f.distance])).toEqual([
      ['apple', 1, 2],
      ['oak_log', 3, 5],
    ])
    expect(found[0]?.entityId).toBe(near)
  })

  it('skips far items, removed ones, and items whose data has not arrived', () => {
    const bot = gameBot()
    bot.dropItem('far', 1, { x: 50, y: 64, z: 0 })
    const removed = bot.dropItem('gone', 1, { x: 2, y: 64, z: 0 })
    bot.entities[String(removed)] = { ...bot.entities[String(removed)], isValid: false } as never
    bot.entities['7'] = { id: 7, type: 'other', name: 'item', position: { x: 1, y: 64, z: 0 } }
    bot.entities['8'] = {
      id: 8,
      type: 'other',
      name: 'item',
      position: { x: 1, y: 64, z: 0 },
      getDroppedItem: () => null,
    }

    expect(new MineflayerDroppedItems(holderOf(bot)).nearby(10)).toEqual([])
  })

  it('finds nothing without a bot', () => {
    expect(new MineflayerDroppedItems(holderOf(undefined)).nearby(10)).toEqual([])
  })
})

describe('MineflayerRecipes', () => {
  it('lists the recipes for an item with names, counts, and whether a table is needed', () => {
    const recipes = new MineflayerRecipes(holderOf(gameBot()))

    const planks = recipes.recipesFor('oak_planks')
    const pickaxe = recipes.recipesFor('wooden_pickaxe')

    expect(planks).toEqual([
      {
        result: { name: 'oak_planks', count: 4 },
        ingredients: [{ name: 'oak_log', count: 1 }],
        needsTable: false,
        index: 0,
      },
    ])
    expect(pickaxe.length).toBeGreaterThan(5)
    expect(pickaxe.every((r) => r.needsTable)).toBe(true)
    expect(pickaxe[0]?.ingredients).toEqual(expect.arrayContaining([{ name: 'stick', count: 2 }]))
  })

  it('knows items and which of them can be crafted', () => {
    const recipes = new MineflayerRecipes(holderOf(gameBot()))

    expect(recipes.isItem('stick')).toBe(true)
    expect(recipes.isItem('unobtainium')).toBe(false)
    expect(recipes.craftableItems()).toEqual(expect.arrayContaining(['stick', 'furnace']))
    expect(recipes.craftableItems()).not.toContain('cobblestone')
    expect(recipes.recipesFor('cobblestone')).toEqual([])
    expect(recipes.recipesFor('unobtainium')).toEqual([])
  })

  it('knows nothing without a bot', () => {
    const recipes = new MineflayerRecipes(holderOf(undefined))

    expect(recipes.recipesFor('stick')).toEqual([])
    expect(recipes.craftableItems()).toEqual([])
    expect(recipes.isItem('stick')).toBe(false)
  })

  it('crafts by the recipe index and takes the ingredients', async () => {
    const bot = gameBot()
    bot.inventoryItems = [{ name: 'oak_log', count: 2 }]

    const result = await new MineflayerRecipes(holderOf(bot)).craft('oak_planks', 0, 2, undefined)

    expect(result).toEqual({ ok: true, value: undefined })
    expect(bot.count('oak_planks')).toBe(8)
    expect(bot.count('oak_log')).toBe(0)
  })

  it('crafts a table recipe on a crafting table', async () => {
    const bot = gameBot()
    bot.setBlock({ x: 2, y: 64, z: 0 }, 'crafting_table')
    bot.inventoryItems = [
      { name: 'oak_planks', count: 3 },
      { name: 'stick', count: 2 },
    ]
    const recipes = new MineflayerRecipes(holderOf(bot))
    const index = recipes
      .recipesFor('wooden_pickaxe')
      .findIndex((r) => r.ingredients.some((i) => i.name === 'oak_planks'))

    const result = await recipes.craft('wooden_pickaxe', index, 1, { x: 2, y: 64, z: 0 })

    expect(result.ok).toBe(true)
    expect(bot.count('wooden_pickaxe')).toBe(1)
  })

  it('refuses a table recipe with no table, and unknown recipes', async () => {
    const bot = gameBot()
    bot.inventoryItems = [
      { name: 'oak_planks', count: 3 },
      { name: 'stick', count: 2 },
    ]
    const recipes = new MineflayerRecipes(holderOf(bot))
    const index = recipes
      .recipesFor('wooden_pickaxe')
      .findIndex((r) => r.ingredients.some((i) => i.name === 'oak_planks'))

    expect(await recipes.craft('wooden_pickaxe', index, 1, undefined)).toMatchObject({
      ok: false,
      error: { reason: 'table_missing' },
    })
    bot.setBlock({ x: 2, y: 64, z: 0 }, 'stone')
    expect(await recipes.craft('wooden_pickaxe', index, 1, { x: 2, y: 64, z: 0 })).toMatchObject({
      ok: false,
      error: { reason: 'table_missing' },
    })
    expect(await recipes.craft('wooden_pickaxe', 99, 1, undefined)).toMatchObject({
      ok: false,
      error: { reason: 'unknown_recipe' },
    })
    expect(await recipes.craft('unobtainium', 0, 1, undefined)).toMatchObject({
      ok: false,
      error: { reason: 'unknown_recipe' },
    })
  })

  it('reports a craft the game rejects, and not connected', async () => {
    const bot = gameBot()
    const recipes = new MineflayerRecipes(holderOf(bot))

    expect(await recipes.craft('oak_planks', 0, 1, undefined)).toMatchObject({
      ok: false,
      error: { reason: 'failed', message: expect.stringContaining('oak_log') as unknown as string },
    })
    expect(
      await new MineflayerRecipes(holderOf(undefined)).craft('oak_planks', 0, 1, undefined),
    ).toMatchObject({
      ok: false,
      error: { reason: 'not_connected' },
    })
  })
})

describe('MineflayerPlacer', () => {
  it('equips the item and places it on top of the block below the target', async () => {
    const bot = gameBot()
    bot.setBlock({ x: 2, y: 63, z: 0 }, 'stone')
    bot.setBlock({ x: 2, y: 64, z: 0 }, 'air')
    bot.inventoryItems = [{ name: 'crafting_table', count: 1 }]

    const result = await new MineflayerPlacer(holderOf(bot)).placeAt('crafting_table', {
      x: 2,
      y: 64,
      z: 0,
    })

    expect(result).toEqual({ ok: true, value: undefined })
    expect(bot.placed).toEqual([{ name: 'crafting_table', position: { x: 2, y: 64, z: 0 } }])
  })

  it('refuses without the item, without support, and without a bot', async () => {
    const bot = gameBot()
    bot.setBlock({ x: 2, y: 63, z: 0 }, 'air')
    bot.inventoryItems = [{ name: 'furnace', count: 1 }]
    const placer = new MineflayerPlacer(holderOf(bot))

    expect(await placer.placeAt('crafting_table', { x: 2, y: 64, z: 0 })).toMatchObject({
      ok: false,
      error: { reason: 'no_item' },
    })
    expect(await placer.placeAt('furnace', { x: 2, y: 64, z: 0 })).toMatchObject({
      ok: false,
      error: { reason: 'no_support' },
    })
    expect(await placer.placeAt('furnace', { x: 9, y: 64, z: 9 })).toMatchObject({
      ok: false,
      error: { reason: 'no_support' },
    })
    expect(
      await new MineflayerPlacer(holderOf(undefined)).placeAt('furnace', { x: 2, y: 64, z: 0 }),
    ).toMatchObject({
      ok: false,
      error: { reason: 'not_connected' },
    })
  })

  it('reports a placement the game rejects', async () => {
    const bot = gameBot()
    bot.setBlock({ x: 2, y: 63, z: 0 }, 'stone')
    bot.inventoryItems = [{ name: 'furnace', count: 1 }]
    bot.failEquip = new Error('cannot hold it')

    expect(
      await new MineflayerPlacer(holderOf(bot)).placeAt('furnace', { x: 2, y: 64, z: 0 }),
    ).toMatchObject({
      ok: false,
      error: { reason: 'failed', message: 'cannot hold it' },
    })
  })
})

describe('MineflayerPlacer.placeAgainst', () => {
  it('places the block on the given face of the reference block', async () => {
    const bot = gameBot()
    bot.setBlock({ x: 2, y: 64, z: 0 }, 'stone')
    bot.setBlock({ x: 3, y: 64, z: 0 }, 'air')
    bot.inventoryItems = [{ name: 'oak_planks', count: 3 }]

    const result = await new MineflayerPlacer(holderOf(bot)).placeAgainst(
      'oak_planks',
      { x: 2, y: 64, z: 0 },
      { x: 1, y: 0, z: 0 },
    )

    expect(result).toEqual({ ok: true, value: undefined })
    expect(bot.placed).toEqual([{ name: 'oak_planks', position: { x: 3, y: 64, z: 0 } }])
  })

  it('refuses without the item, without a solid reference, and without a bot', async () => {
    const bot = gameBot()
    bot.setBlock({ x: 2, y: 64, z: 0 }, 'air')
    bot.inventoryItems = [{ name: 'oak_planks', count: 1 }]
    const placer = new MineflayerPlacer(holderOf(bot))
    const east = { x: 1, y: 0, z: 0 }

    expect(await placer.placeAgainst('stone', { x: 2, y: 64, z: 0 }, east)).toMatchObject({
      ok: false,
      error: { reason: 'no_item' },
    })
    expect(await placer.placeAgainst('oak_planks', { x: 2, y: 64, z: 0 }, east)).toMatchObject({
      ok: false,
      error: { reason: 'no_support' },
    })
    expect(await placer.placeAgainst('oak_planks', { x: 90, y: 64, z: 0 }, east)).toMatchObject({
      ok: false,
      error: { reason: 'no_support' },
    })
    expect(
      await new MineflayerPlacer(holderOf(undefined)).placeAgainst(
        'oak_planks',
        { x: 2, y: 64, z: 0 },
        east,
      ),
    ).toMatchObject({ ok: false, error: { reason: 'not_connected' } })
  })

  it('reports a placement the game rejects', async () => {
    const bot = gameBot()
    bot.setBlock({ x: 2, y: 64, z: 0 }, 'stone')
    bot.inventoryItems = [{ name: 'oak_planks', count: 1 }]
    bot.failEquip = new Error('cannot hold it')

    expect(
      await new MineflayerPlacer(holderOf(bot)).placeAgainst(
        'oak_planks',
        { x: 2, y: 64, z: 0 },
        { x: 0, y: 1, z: 0 },
      ),
    ).toMatchObject({ ok: false, error: { reason: 'failed', message: 'cannot hold it' } })
  })
})

describe('MineflayerLightReader', () => {
  it('reads the block light of a loaded cell, and nothing for an unloaded one or without a bot', () => {
    const bot = gameBot()
    bot.setBlock({ x: 2, y: 64, z: 0 }, 'air')
    bot.setLight({ x: 2, y: 64, z: 0 }, 11)

    const reader = new MineflayerLightReader(holderOf(bot))

    expect(reader.blockLightAt({ x: 2, y: 64, z: 0 })).toBe(11)
    expect(reader.blockLightAt({ x: 9, y: 64, z: 9 })).toBeUndefined()
    expect(
      new MineflayerLightReader(holderOf(undefined)).blockLightAt({ x: 2, y: 64, z: 0 }),
    ).toBeUndefined()
  })
})

describe('MineflayerFurnaceAccess', () => {
  const furnaceAt = { x: 2, y: 64, z: 0 }

  it('opens a furnace and moves items in and out', async () => {
    const bot = gameBot()
    let now = 0
    bot.now = () => now
    bot.setBlock(furnaceAt, 'furnace')
    bot.inventoryItems = [
      { name: 'raw_iron', count: 3 },
      { name: 'coal', count: 2 },
    ]
    const opened = await new MineflayerFurnaceAccess(holderOf(bot)).open(furnaceAt)
    if (!opened.ok) throw new Error(opened.error)
    const session = opened.value

    await session.putFuel('coal', 1)
    await session.putInput('raw_iron', 3)
    expect(session.contents()).toEqual({
      input: { name: 'raw_iron', count: 3 },
      fuel: { name: 'coal', count: 1 },
      output: undefined,
      burning: false,
    })
    now = 30_000
    const contents = session.contents()
    expect(contents.output).toEqual({ name: 'iron_ingot', count: 3 })
    expect(contents.burning).toBe(true)

    expect(await session.takeOutput()).toEqual({ name: 'iron_ingot', count: 3 })
    expect(await session.takeOutput()).toBeUndefined()
    expect(await session.takeInput()).toBeUndefined()
    expect(await session.takeFuel()).toBeUndefined() // the coal was burned
    await session.close()
    expect(bot.count('iron_ingot')).toBe(3)
  })

  it('gives back input and fuel that are still there', async () => {
    const bot = gameBot()
    bot.setBlock(furnaceAt, 'furnace')
    bot.inventoryItems = [
      { name: 'raw_iron', count: 3 },
      { name: 'coal', count: 2 },
    ]
    const opened = await new MineflayerFurnaceAccess(holderOf(bot)).open(furnaceAt)
    if (!opened.ok) throw new Error(opened.error)

    await opened.value.putFuel('coal', 2)
    await opened.value.putInput('raw_iron', 3)

    expect(await opened.value.takeInput()).toEqual({ name: 'raw_iron', count: 3 })
    expect(await opened.value.takeFuel()).toEqual({ name: 'coal', count: 2 })
    expect(bot.count('raw_iron')).toBe(3)
    expect(bot.count('coal')).toBe(2)
  })

  it('rejects an item name the game does not know', async () => {
    const bot = gameBot()
    bot.setBlock(furnaceAt, 'furnace')
    const opened = await new MineflayerFurnaceAccess(holderOf(bot)).open(furnaceAt)
    if (!opened.ok) throw new Error(opened.error)

    await expect(opened.value.putInput('unobtainium', 1)).rejects.toThrow('not an item')
  })

  it('refuses a block that is not a furnace, and not connected', async () => {
    const bot = gameBot()
    bot.setBlock(furnaceAt, 'stone')

    expect(await new MineflayerFurnaceAccess(holderOf(bot)).open(furnaceAt)).toEqual({
      ok: false,
      error: 'There is no furnace there.',
    })
    expect(await new MineflayerFurnaceAccess(holderOf(bot)).open({ x: 9, y: 9, z: 9 })).toEqual({
      ok: false,
      error: 'There is no furnace there.',
    })
    expect(await new MineflayerFurnaceAccess(holderOf(undefined)).open(furnaceAt)).toEqual({
      ok: false,
      error: 'Not connected to a Minecraft world.',
    })
  })

  it('reports a furnace the server will not open', async () => {
    const bot = gameBot()
    bot.setBlock(furnaceAt, 'furnace')
    bot.openFurnace = () => Promise.reject(new Error('too far'))

    expect(await new MineflayerFurnaceAccess(holderOf(bot)).open(furnaceAt)).toEqual({
      ok: false,
      error: 'too far',
    })
  })
})
