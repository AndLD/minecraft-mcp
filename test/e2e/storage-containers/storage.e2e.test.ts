import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { dataOf } from '../support/app-under-test.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { startSession, type E2ESession } from '../support/session.js'
import { pause, waitUntil } from '../support/wait.js'

const at = (x: number, z: number, height = 0): Position => ({ x, y: GROUND_Y + height, z })

interface TaskView {
  status: string
  result: Record<string, unknown> | null
  waitingFor: { options: string[]; message: string } | null
}

describe('storage on a real Minecraft server', () => {
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

  /** Waits until the bot's own inventory shows the item: RCON gives reach it a moment later. */
  const untilBotCarries = (item: string): Promise<unknown> =>
    waitUntil(
      async () => {
        const result = await session.bot.call('get_inventory')
        const items = result.isError ? [] : (result.data as { items: { name: string }[] }).items
        return items.some((entry) => entry.name === item) ? true : undefined
      },
      { description: `the bot to carry ${item}` },
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

  it('routes stone, ores, and everything else to three chests by rule, and keeps the gear', async () => {
    for (const x of [2, 4, 6]) await world.setBlock(at(x, -4), 'chest')
    await untilBotSees(['chest'], 3)
    await world.give(bot(), 'cobblestone', 100)
    await world.give(bot(), 'raw_iron', 12)
    await world.give(bot(), 'iron_ingot', 3)
    await world.give(bot(), 'feather', 5)
    await world.give(bot(), 'iron_pickaxe')
    await world.give(bot(), 'cooked_beef', 8)
    for (const item of [
      'cobblestone',
      'raw_iron',
      'iron_ingot',
      'feather',
      'iron_pickaxe',
      'cooked_beef',
    ])
      await untilBotCarries(item)
    for (const [x, label] of [
      [2, 'stone'],
      [4, 'metal'],
      [6, 'misc'],
    ] as const)
      expect(
        (await session.bot.call('register_container', { x, y: GROUND_Y, z: -4, label })).isError,
      ).toBe(false)
    await session.bot.call('set_storage_rule', {
      container: 'stone',
      items: ['stone', 'cobblestone'],
    })
    await session.bot.call('set_storage_rule', { container: 'metal', items: ['ores', 'ingots'] })
    await session.bot.call('set_storage_rule', { container: 'misc', items: ['*'], priority: -10 })

    const run = await runToTheEnd('deposit_items', {})

    succeeded(run)
    expect(await world.countInChest(at(2, -4), 'cobblestone')).toBe(100)
    expect(await world.countInChest(at(4, -4), 'raw_iron')).toBe(12)
    expect(await world.countInChest(at(4, -4), 'iron_ingot')).toBe(3)
    expect(await world.countInChest(at(6, -4), 'feather')).toBe(5)
    expect(await world.countItem(bot(), 'iron_pickaxe')).toBe(1)
    expect(await world.countItem(bot(), 'cooked_beef')).toBe(8)
    expect(await world.countItem(bot(), 'cobblestone')).toBe(0)
  })

  it('finds an item across several chests and takes it out', async () => {
    await world.setBlock(at(2, -4), 'chest')
    await world.setBlock(at(5, -4), 'chest')
    await world.setBlock(at(8, -4), 'barrel')
    await world.fillSlot(at(2, -4), 0, 'iron_ingot', 20)
    await world.fillSlot(at(5, -4), 3, 'iron_ingot', 5)
    await world.fillSlot(at(8, -4), 1, 'coal', 9)
    await untilBotSees(['chest', 'barrel'], 3)

    const found = await runToTheEnd('find_items', { item: 'iron_ingot' })
    succeeded(found)
    expect(found.task?.result).toMatchObject({ total: 25, scanned: true })

    const taken = await runToTheEnd('withdraw_items', {
      items: [{ item: 'iron_ingot', count: 23 }],
    })

    succeeded(taken)
    expect(await world.countItem(bot(), 'iron_ingot')).toBe(23)
    expect(
      (await world.countInChest(at(2, -4), 'iron_ingot')) +
        (await world.countInChest(at(5, -4), 'iron_ingot')),
    ).toBe(2)
  })

  it('registers the chest the player is looking at', async () => {
    await world.setBlock(at(-1, 4), 'chest')
    await untilBotSees(['chest'], 1)
    // Stand two blocks south of it and look north (yaw 180 faces -z), slightly down at the chest.
    await world.face(session.player.username, at(-1, 6), 180, 20)
    await pause(1500)

    const registered = await waitUntil(
      async () => {
        const result = await session.bot.call('register_container', {
          looking_at: true,
          label: 'lookedat',
        })
        return result.isError ? undefined : result
      },
      { description: 'the bot to see where the player looks' },
    )

    expect(
      dataOf<{ container: { position: Position; block: string } }>(registered).container,
    ).toMatchObject({
      block: 'chest',
      position: { x: -1, y: GROUND_Y, z: 4 },
    })
  })

  describe('a full inventory during a task', () => {
    /** 35 of 36 slots hold dirt, a tree stands nearby, and a chest is next to the bot. */
    async function crampedBot(): Promise<void> {
      await world.fill(at(-2, -3), at(-2, -3, 3), 'oak_log')
      await world.setBlock(at(-8, -3), 'chest')
      await untilBotSees(['oak_log', 'chest'], 2)
      await world.give(bot(), 'dirt', 35 * 64)
      await untilBotCarries('dirt')
      await pause(1000)
    }

    it('pauses and asks, and carries on after "offload"', async () => {
      await crampedBot()

      const first = await session.bot.call('collect_block', {
        blocks: ['oak_log'],
        count: 4,
        wait_seconds: 40,
      })
      const started = dataOf<TaskView>(first)
      const waiting =
        started.status === 'waiting_for_input'
          ? started
          : await waitUntil(
              async () => {
                const status = dataOf<{ task: TaskView }>(
                  await session.bot.call('get_task_status'),
                ).task
                return status.status === 'waiting_for_input' ? status : undefined
              },
              { timeoutMs: 60_000, description: 'the task to ask about the full inventory' },
            )
      expect(waiting.waitingFor?.options).toEqual(['offload', 'continue', 'stop'])
      const events = session.bot.app.inbox.drain().events
      expect(events.some((e) => e.type === 'needs_decision')).toBe(true)

      const answered = await session.bot.call('resume_task', { decision: 'offload' })
      expect(answered.isError).toBe(false)
      const finished = await waitUntil(
        async () => {
          const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
          return status.status === 'succeeded' || status.status === 'failed' ? status : undefined
        },
        { timeoutMs: 100_000, description: 'the task to finish after offloading' },
      )

      if (finished.status !== 'succeeded')
        throw new Error(`The task did not succeed: ${JSON.stringify(finished)}`)
      expect(await world.countInChest(at(-8, -3), 'dirt')).toBeGreaterThan(0)
      expect(await world.countItem(bot(), 'oak_log')).toBe(4)
    })

    it('offloads by itself under the "offload_and_return" policy', async () => {
      await crampedBot()
      await session.bot.call('set_storage_policy', { policy: 'offload_and_return' })

      const run = await runToTheEnd('collect_block', { blocks: ['oak_log'], count: 4 })

      succeeded(run)
      expect(await world.countInChest(at(-8, -3), 'dirt')).toBeGreaterThan(0)
      expect(await world.countItem(bot(), 'oak_log')).toBe(4)
    })
  })
})
