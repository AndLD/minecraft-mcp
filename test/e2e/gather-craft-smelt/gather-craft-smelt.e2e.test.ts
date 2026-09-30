import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { dataOf } from '../support/app-under-test.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { startSession, type E2ESession } from '../support/session.js'
import { pause, waitUntil } from '../support/wait.js'

const at = (x: number, z: number, height = 0): Position => ({ x, y: GROUND_Y + height, z })

interface TaskView {
  taskId: string
  status: string
  progress: string | null
  result: Record<string, unknown> | null
}

describe('gathering, crafting, and smelting on a real Minecraft server', () => {
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

  /** A trunk of `height` logs at the column (x, z). */
  const plantTree = (x: number, z: number, height: number): Promise<void> =>
    world.fill(at(x, z), at(x, z, height - 1), 'oak_log')

  /** RCON changes reach the bot a moment later: wait until its own view matches. */
  const untilBotSees = (names: string[], count: number): Promise<unknown> =>
    waitUntil(
      async () => {
        const result = await session.bot.call('find_blocks', { names })
        return !result.isError && (result.data as { count: number }).count >= count
          ? true
          : undefined
      },
      { description: `the bot to see ${String(count)} of ${names.join(', ')}` },
    )

  /** Waits until the bot's own inventory shows the item, since RCON gives reach the bot a moment later. */
  const untilBotCarries = (item: string): Promise<unknown> =>
    waitUntil(
      async () => {
        const result = await session.bot.call('get_inventory')
        const items = result.isError ? [] : (result.data as { items: { name: string }[] }).items
        return items.some((entry) => entry.name === item) ? true : undefined
      },
      { description: `the bot to carry ${item}` },
    )

  /** Starts a task-running tool and follows it until it is no longer running. */
  async function runToTheEnd(
    tool: string,
    args: Record<string, unknown>,
    timeoutMs = 100_000,
  ): Promise<{ failed: boolean; text: string; task: TaskView | undefined }> {
    const first = await session.bot.call(tool, { wait_seconds: 20, ...args })
    if (first.isError) return { failed: true, text: first.text, task: undefined }
    let task = first.data as TaskView
    if (task.status === 'running') {
      const finished = await waitUntil(
        async () => {
          const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
          return status.status === 'running' ? undefined : status
        },
        { timeoutMs, description: `${tool} to finish` },
      )
      task = finished
    }
    return { failed: task.status !== 'succeeded', text: JSON.stringify(task), task }
  }

  /** Fails with the tool's own message, which says why. */
  function expectSucceeded(run: { failed: boolean; text: string }): void {
    if (run.failed) throw new Error(`The task did not succeed: ${run.text}`)
  }

  it('collects logs from a tree and crafts a wooden pickaxe, making planks, sticks, and a crafting table on the way', async () => {
    await plantTree(-2, -3, 4)
    await untilBotSees(['oak_log'], 4)

    const collected = await runToTheEnd('collect_block', { blocks: ['logs'], count: 4 })

    expectSucceeded(collected)
    expect(collected.task?.result).toMatchObject({ mined: 4 })
    expect(await world.countItem(bot(), 'oak_log')).toBe(4)

    const crafted = await runToTheEnd('craft', { item: 'wooden_pickaxe' })

    expectSucceeded(crafted)
    expect(crafted.task?.result).toMatchObject({
      item: 'wooden_pickaxe',
      produced: 1,
      placedTable: true,
    })
    expect(await world.countItem(bot(), 'wooden_pickaxe')).toBe(1)
    await untilBotSees(['crafting_table'], 1)
  })

  it('mines iron ore only with a tool that can harvest it, then smelts the raw iron', async () => {
    await world.fill(at(3, -4), at(3, -2), 'iron_ore') // three ore blocks in a row
    await untilBotSees(['iron_ore'], 3)

    await world.give(bot(), 'wooden_pickaxe')
    await untilBotCarries('wooden_pickaxe')
    const tooWeak = await runToTheEnd('collect_block', { blocks: ['iron_ore'], count: 3 })
    expect(tooWeak.failed).toBe(true)
    expect(tooWeak.text).toContain('no_suitable_tool')
    expect(await world.isBlock(at(3, -3), 'iron_ore')).toBe(true) // untouched

    await world.give(bot(), 'stone_pickaxe')
    await untilBotCarries('stone_pickaxe')
    const mined = await runToTheEnd('collect_block', { blocks: ['iron_ore'], count: 3 })
    expect(mined.text).not.toContain('reason')
    expectSucceeded(mined)
    expect(await world.countItem(bot(), 'raw_iron')).toBe(3)

    await world.give(bot(), 'furnace')
    await world.give(bot(), 'coal')
    await untilBotCarries('furnace')
    await untilBotCarries('coal')
    const smelted = await runToTheEnd('smelt', { item: 'raw_iron' })

    expectSucceeded(smelted)
    expect(smelted.task?.result).toMatchObject({ smelted: 3, produced: 'iron_ingot', fuel: 'coal' })
    expect(await world.countItem(bot(), 'iron_ingot')).toBe(3)
    expect(await world.countItem(bot(), 'raw_iron')).toBe(0)
  })

  it('smelts twice in a row in the same furnace without losing the fuel (regression)', async () => {
    // Bug found in a live session: a single log used as fuel for a single item is consumed into the burn queue
    // the instant it starts burning, which can empty the fuel slot a moment before the server's burning-progress
    // update reaches the bot. A too-eager "out of fuel" check mistook that gap for real starvation, gave up with
    // nothing smelted, and lost the log (already burning, so it could not be taken back). One item per call and
    // exactly one log's worth of fuel (`oak_log` covers 1.5 items) reproduce the race most reliably.
    await world.give(bot(), 'furnace')
    await world.give(bot(), 'porkchop', 2)
    await world.give(bot(), 'oak_log', 4)
    await untilBotCarries('furnace')
    await untilBotCarries('porkchop')
    await untilBotCarries('oak_log')

    const first = await runToTheEnd('smelt', { item: 'porkchop', count: 1, fuel: 'oak_log' })
    expectSucceeded(first)
    expect(first.task?.result).toMatchObject({ smelted: 1, produced: 'cooked_porkchop' })

    const second = await runToTheEnd('smelt', { item: 'porkchop', count: 1, fuel: 'oak_log' })
    expectSucceeded(second)
    expect(second.task?.result).toMatchObject({ smelted: 1, produced: 'cooked_porkchop' })

    expect(await world.countItem(bot(), 'cooked_porkchop')).toBe(2)
    expect(await world.countItem(bot(), 'porkchop')).toBe(0)
  })

  it('stays free while a batch cooks: it hears the owner, a cancelled wait leaves the furnace burning, and a later smelt collects', async () => {
    await world.give(bot(), 'furnace')
    await world.give(bot(), 'raw_iron', 3)
    await world.give(bot(), 'coal', 1)
    await untilBotCarries('furnace')
    await untilBotCarries('raw_iron')
    await untilBotCarries('coal')

    const started = dataOf<TaskView>(
      await session.bot.call('smelt', { item: 'raw_iron', wait_seconds: 0 }),
    )
    expect(started.status).toBe('running')
    await pause(4000) // loaded, and now waiting with the window closed

    session.player.chat('are you there?')
    const heard = await waitUntil(
      async () => {
        const result = await session.bot.call('wait_for_chat', { timeout_seconds: 2 })
        const data = result.data as { messages: { text: string }[] } | undefined
        return data?.messages.some((m) => m.text === 'are you there?') === true ? true : undefined
      },
      { timeoutMs: 20_000, intervalMs: 50, description: 'the owner’s message' },
    )
    expect(heard).toBe(true)
    const stillRunning = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
    expect(stillRunning.status).toBe('running')

    await session.bot.call('cancel_task')
    await waitUntil(
      async () => {
        const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
        return status.status === 'cancelled' ? true : undefined
      },
      { description: 'the wait to be cancelled' },
    )
    // The items stay in the furnace and go on cooking; nothing was taken back.
    expect(await world.countItem(bot(), 'raw_iron')).toBe(0)

    await waitUntil(
      async () => {
        const collected = await runToTheEnd('smelt', { collect: true })
        if (collected.failed) return undefined
        return (await world.countItem(bot(), 'iron_ingot')) >= 3 ? true : undefined
      },
      { timeoutMs: 120_000, intervalMs: 5_000, description: 'the ingots to be collected' },
    )
    expect(await world.countItem(bot(), 'iron_ingot')).toBe(3)
  }, 240_000)

  it('runs a job that the first fuel does not cover, putting in more fuel at a look', async () => {
    // One coal smelts 8 items and 4 planks 6 more, so 12 iron needs both: the coal goes in first, the planks later.
    await world.give(bot(), 'furnace')
    await world.give(bot(), 'raw_iron', 12)
    await world.give(bot(), 'coal', 1)
    await world.give(bot(), 'oak_planks', 4)
    await untilBotCarries('furnace')
    await untilBotCarries('raw_iron')
    await untilBotCarries('coal')
    await untilBotCarries('oak_planks')

    const smelted = await runToTheEnd('smelt', { item: 'raw_iron' }, 240_000)

    expectSucceeded(smelted)
    expect(smelted.task?.result).toMatchObject({ smelted: 12, requested: 12, pending: 0 })
    const used = (smelted.task?.result as { fuelUsed: { name: string }[] }).fuelUsed.map(
      (entry) => entry.name,
    )
    expect(used).toEqual(expect.arrayContaining(['coal', 'oak_planks']))
    expect(await world.countItem(bot(), 'iron_ingot')).toBe(12)
    expect(await world.countItem(bot(), 'raw_iron')).toBe(0)
  }, 300_000)

  it('announces a job left with start_only when it should be done, and collect takes it', async () => {
    await world.give(bot(), 'furnace')
    await world.give(bot(), 'raw_iron', 3)
    await world.give(bot(), 'coal', 1)
    await untilBotCarries('furnace')
    await untilBotCarries('raw_iron')
    await untilBotCarries('coal')

    const started = dataOf<TaskView>(
      await session.bot.call('smelt', { item: 'raw_iron', wait: 'start_only', wait_seconds: 30 }),
    )
    expect(started.status).toBe('succeeded')
    expect(started.result).toMatchObject({ smelted: 0, pending: 3 })

    // The bot is free for other work; the agent hears when the furnace should be done (3 items: 30 seconds).
    const heard = await waitUntil(
      async () => {
        const result = await session.bot.call('wait_for_chat', { timeout_seconds: 5 })
        const events = (result.data as { events: { type: string; message: string }[] } | undefined)
          ?.events
        return events?.find((event) => event.type === 'smelt_ready')
      },
      { timeoutMs: 90_000, intervalMs: 100, description: 'the smelt_ready event' },
    )
    expect(heard.message).toContain('collect: true')

    const collected = await runToTheEnd('smelt', { collect: true })

    expectSucceeded(collected)
    expect(collected.task?.result).toMatchObject({ smelted: 3, pending: 0 })
    expect(await world.countItem(bot(), 'iron_ingot')).toBe(3)
  }, 240_000)

  it('takes fuel out of a chest when told to and the bag has none, and refuses without the option', async () => {
    await world.setBlock(at(6, -4), 'chest')
    await world.fillSlot(at(6, -4), 0, 'coal', 8)
    await world.give(bot(), 'furnace')
    await world.give(bot(), 'raw_iron', 3)
    await untilBotSees(['chest'], 1)
    await untilBotCarries('furnace')
    await untilBotCarries('raw_iron')
    expect(
      (
        await session.bot.call('register_container', {
          x: 6,
          y: GROUND_Y,
          z: -4,
          label: 'fuel',
        })
      ).isError,
    ).toBe(false)

    const refused = await runToTheEnd('smelt', { item: 'raw_iron' })
    expect(refused.failed).toBe(true)
    expect(refused.text).toContain('no_fuel')

    const smelted = await runToTheEnd('smelt', { item: 'raw_iron', fuel_from_storage: true })

    expectSucceeded(smelted)
    expect(smelted.task?.result).toMatchObject({
      smelted: 3,
      fuelFetched: [{ name: 'coal', count: 1 }],
    })
    expect(await world.countItem(bot(), 'iron_ingot')).toBe(3)
    expect(await world.countInChest(at(6, -4), 'coal')).toBe(7)
  }, 200_000)

  it('stops collecting the moment the task is cancelled', async () => {
    await plantTree(-2, -3, 4)
    await untilBotSees(['oak_log'], 4)

    const started = dataOf<TaskView>(
      await session.bot.call('collect_block', { blocks: ['oak_log'], count: 4, wait_seconds: 0 }),
    )
    expect(started.status).toBe('running')
    await pause(2500) // long enough to be walking up to, or digging, the first log
    await session.bot.call('cancel_task')

    await waitUntil(
      async () => {
        const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
        return status.status === 'cancelled' ? true : undefined
      },
      { description: 'the task to be cancelled' },
    )
    const before = await world.countItem(bot(), 'oak_log')
    await pause(3000)

    expect(await world.countItem(bot(), 'oak_log')).toBe(before)
    expect(before).toBeLessThan(4)
  })

  it('never breaks blocks inside a protected area', async () => {
    await plantTree(-2, -3, 3)
    await untilBotSees(['oak_log'], 3)
    const protectedArea = await session.bot.call('protect_area', {
      label: 'the old tree',
      x1: -4,
      y1: GROUND_Y - 1,
      z1: -5,
      x2: 0,
      y2: GROUND_Y + 6,
      z2: -1,
    })
    // The bot has no world profile to save it in until it has identified the world; connect already did that.
    expect(protectedArea.isError).toBe(false)

    const result = await session.bot.call('collect_block', {
      blocks: ['oak_log'],
      count: 2,
      wait_seconds: 10,
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('protected_area')
    expect(await world.isBlock(at(-2, -3), 'oak_log')).toBe(true)
    expect(await world.countItem(bot(), 'oak_log')).toBe(0)
  })

  it('picks up items lying on the ground', async () => {
    await world.summonWith(
      'item',
      at(-2.5, -3.5, 1),
      '{Item:{id:"minecraft:apple",count:3},PickupDelay:0}',
    )
    const picked = await waitUntil(
      async () => {
        const result = await session.bot.call('pickup_items', {
          items: ['apple'],
          wait_seconds: 20,
        })
        return result.isError ? undefined : (result.data as TaskView)
      },
      { description: 'the bot to see the apples and pick them up' },
    )

    expect(picked.status).toBe('succeeded')
    expect(await world.countItem(bot(), 'apple')).toBe(3)
  })
})
