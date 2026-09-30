import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { dataOf } from '../support/app-under-test.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { startSession, type E2ESession } from '../support/session.js'
import { waitUntil } from '../support/wait.js'

const at = (x: number, z: number): Position => ({ x, y: GROUND_Y, z })

interface TaskView {
  status: string
  result: Record<string, unknown> | null
}

describe('handing items over on a real Minecraft server', () => {
  let info: ServerInfo
  let world: E2EWorld
  let session: E2ESession
  let sessionOpen = false

  beforeAll(async () => {
    info = readServerInfo()
    world = await E2EWorld.connect(info)
    await world.setDifficulty('peaceful')
    await world.setGameRule('doDaylightCycle', false)
    await world.setGameRule('doMobSpawning', false)
    await world.setTime('day')
  })

  beforeEach(async () => {
    session = await startSession(world, info)
    sessionOpen = true
  })

  afterEach(async () => {
    if (!sessionOpen) return
    sessionOpen = false
    await session.close()
  })

  afterAll(async () => {
    await world.close()
  })

  const bot = (): string => session.bot.username
  const player = (): string => session.player.username

  const untilBotCarries = (item: string): Promise<unknown> =>
    waitUntil(
      async () => {
        const result = await session.bot.call('get_inventory')
        const items = result.isError ? [] : (result.data as { items: { name: string }[] }).items
        return items.some((entry) => entry.name === item) ? true : undefined
      },
      { description: `the bot to carry ${item}` },
    )

  /** The player picks thrown items up by standing next to them: wait until they are in the inventory. */
  const untilPlayerHas = (item: string, count: number): Promise<number> =>
    waitUntil(
      async () => {
        const have = await world.countItem(player(), item)
        return have >= count ? have : undefined
      },
      { timeoutMs: 20_000, description: `${player()} to hold ${String(count)} ${item}` },
    )

  async function runToTheEnd(tool: string, args: Record<string, unknown>) {
    const first = await session.bot.call(tool, { wait_seconds: 25, ...args })
    if (first.isError) return { failed: true, text: first.text, task: undefined }
    let task = first.data as TaskView
    if (task.status === 'running') {
      task = await waitUntil(
        async () => {
          const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
          return status.status === 'running' ? undefined : status
        },
        { timeoutMs: 100_000, description: `${tool} to finish` },
      )
    }
    return { failed: task.status !== 'succeeded', text: JSON.stringify(task), task }
  }

  const succeeded = (run: { failed: boolean; text: string }): void => {
    if (run.failed) throw new Error(`The task did not succeed: ${run.text}`)
  }

  it('walks to the player and drops the requested items at their feet', async () => {
    await world.give(bot(), 'iron_ingot', 20)
    await world.give(bot(), 'iron_pickaxe')
    await untilBotCarries('iron_ingot')
    await untilBotCarries('iron_pickaxe')

    const run = await runToTheEnd('give_items', { items: [{ item: 'iron_ingot', count: 20 }] })

    succeeded(run)
    expect(run.task?.result).toMatchObject({
      given: [{ name: 'iron_ingot', count: 20 }],
      shortfall: [],
      unclaimed: [],
    })
    expect(await untilPlayerHas('iron_ingot', 20)).toBe(20)
    expect(await world.countItem(bot(), 'iron_ingot')).toBe(0)
    expect(await world.countItem(bot(), 'iron_pickaxe')).toBe(1) // the gear stays
  })

  it('gives part of a stack, and several stacks of another item', async () => {
    await world.give(bot(), 'iron_ingot', 40)
    await world.give(bot(), 'cobblestone', 150)
    await untilBotCarries('iron_ingot')
    await untilBotCarries('cobblestone')

    const run = await runToTheEnd('give_items', {
      items: [
        { item: 'iron_ingot', count: 13 },
        { item: 'cobble', stacks: 2 },
      ],
    })

    succeeded(run)
    expect(await untilPlayerHas('iron_ingot', 13)).toBe(13)
    expect(await untilPlayerHas('cobblestone', 128)).toBe(128)
    expect(await world.countItem(bot(), 'iron_ingot')).toBe(27)
    expect(await world.countItem(bot(), 'cobblestone')).toBe(22)
  })

  it('fetches what it lacks from a chest filled by hand, then delivers', async () => {
    await world.setBlock(at(-2, -4), 'chest')
    await world.fillSlot(at(-2, -4), 0, 'iron_ingot', 30)
    await world.give(bot(), 'iron_ingot', 5)
    await untilBotCarries('iron_ingot')
    await waitUntil(
      async () => {
        const seen = await session.bot.call('find_blocks', { names: ['chest'] })
        return !seen.isError && (seen.data as { count: number }).count >= 1 ? true : undefined
      },
      { description: 'the bot to see the chest' },
    )

    const run = await runToTheEnd('give_items', { items: [{ item: 'iron_ingot', count: 20 }] })

    succeeded(run)
    expect(await untilPlayerHas('iron_ingot', 20)).toBe(20)
    expect(await world.countInChest(at(-2, -4), 'iron_ingot')).toBe(15)
  })

  it('says exactly what is missing', async () => {
    await world.give(bot(), 'iron_ingot', 6)
    await untilBotCarries('iron_ingot')

    const run = await runToTheEnd('give_items', {
      items: [
        { item: 'iron_ingot', count: 20 },
        { item: 'diamond', count: 2 },
      ],
      fetch_from_storage: false,
    })

    succeeded(run)
    expect(run.task?.result).toMatchObject({
      given: [{ name: 'iron_ingot', count: 6 }],
      shortfall: [
        { name: 'iron_ingot', count: 14 },
        { name: 'diamond', count: 2 },
      ],
    })
    expect(await untilPlayerHas('iron_ingot', 6)).toBe(6)
  })

  it('does not give away its own food when asked for "food", and asks which one for "iron"', async () => {
    await world.give(bot(), 'cooked_beef', 8)
    await world.give(bot(), 'iron_ingot', 3)
    await world.give(bot(), 'raw_iron', 3)
    await untilBotCarries('cooked_beef')
    await untilBotCarries('raw_iron')
    await untilBotCarries('iron_ingot')

    const byGroup = await session.bot.call('give_items', {
      items: [{ item: 'food', count: 4 }],
      wait_seconds: 10,
    })
    const ambiguous = await session.bot.call('give_items', {
      items: [{ item: 'iron', count: 3 }],
      wait_seconds: 10,
    })

    expect(byGroup.isError).toBe(true)
    expect(byGroup.text).toContain('shortfall')
    expect(ambiguous.isError).toBe(true)
    expect(ambiguous.text).toContain('ambiguous')
    expect(await world.countItem(player(), 'cooked_beef')).toBe(0)
  })

  it('puts many stacks into a chest instead, and says which', async () => {
    await world.setBlock(at(-2, -4), 'chest')
    await world.give(bot(), 'cobblestone', 640)
    await untilBotCarries('cobblestone')
    await waitUntil(
      async () => {
        const registered = await session.bot.call('register_container', {
          x: -2,
          y: GROUND_Y,
          z: -4,
          label: 'for-player',
        })
        return registered.isError ? undefined : true
      },
      { description: 'the bot to see the chest' },
    )

    const run = await runToTheEnd('give_items', {
      items: [{ item: 'cobblestone', stacks: 9 }],
      mode: 'chest',
      chest: 'for-player',
    })

    succeeded(run)
    expect((run.task?.result as { deliveredTo: string }).deliveredTo).toContain('"for-player"')
    expect(await world.countInChest(at(-2, -4), 'cobblestone')).toBe(576)
    expect(await world.countItem(player(), 'cobblestone')).toBe(0)
  })

  it('takes a sword thrown at it after the wait began, leaves an old drop alone, and holds the sword', async () => {
    const owner = await world.playerPosition(player())
    // An item that lies near the player before the wait starts is not what they hand over (nobody can pick it up here).
    await world.summonWith(
      'item',
      { x: owner.x + 6, y: owner.y, z: owner.z },
      '{Item:{id:"minecraft:stone_sword",count:1},PickupDelay:32767}',
    )

    const started = await session.bot.call('receive_item', {
      item: 'sword',
      from_player: player(),
      use_it: true,
      timeout_seconds: 60,
      wait_seconds: 0,
    })
    if (started.isError) throw new Error(`receive_item failed to start: ${started.text}`)
    // Let the bot walk up and start listening, then "throw": an item lands a couple of blocks from the owner, on the
    // bot's side (the owner bot cannot throw, and standing on it would pick it up).
    await waitUntil(
      async () => {
        const status = dataOf<{ task: TaskView & { progress: string | null } }>(
          await session.bot.call('get_task_status'),
        ).task
        return status.status !== 'running' || status.progress?.startsWith('Waiting for') === true
          ? true
          : undefined
      },
      { description: 'the bot to start listening' },
    )
    const bots = await world.playerPosition(bot())
    const owner2 = await world.playerPosition(player())
    const drop = {
      x: owner2.x + Math.sign(bots.x - owner2.x) * 2.5,
      y: owner2.y,
      z: owner2.z + Math.sign(bots.z - owner2.z) * 2.5,
    }
    await world.summonWith(
      'item',
      drop,
      '{Item:{id:"minecraft:diamond_sword",count:1},PickupDelay:0}',
    )

    const task = await waitUntil(
      async () => {
        const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
        return status.status === 'running' ? undefined : status
      },
      { timeoutMs: 90_000, description: 'receive_item to finish' },
    )

    if (task.status !== 'succeeded')
      throw new Error(`receive_item did not succeed: ${JSON.stringify(task)}`)
    expect(task.result).toMatchObject({ received: [{ name: 'diamond_sword', count: 1 }] })
    expect(await world.countItem(bot(), 'diamond_sword')).toBe(1)
    expect(await world.countItem(bot(), 'stone_sword')).toBe(0)
    const inventory = dataOf<{ heldItem: string | null }>(await session.bot.call('get_inventory'))
    expect(inventory.heldItem).toBe('diamond_sword')
  }, 180_000)
})
