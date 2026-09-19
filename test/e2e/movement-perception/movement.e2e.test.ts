import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { dataOf } from '../support/app-under-test.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { horizontalDistance, startSession, type E2ESession } from '../support/session.js'
import { pause, waitUntil } from '../support/wait.js'

const at = (x: number, z: number): Position => ({ x, y: GROUND_Y, z })

interface TaskView {
  status: string
  result: { targetPosition?: Position } | null
}

describe('moving and perceiving on a real Minecraft server', () => {
  let info: ServerInfo
  let world: E2EWorld
  let session: E2ESession

  beforeAll(async () => {
    info = readServerInfo()
    world = await E2EWorld.connect(info)
    await world.setGameRule('doDaylightCycle', false)
    await world.setGameRule('doMobSpawning', false)
    await world.setTime('day')
  })

  beforeEach(async () => {
    session = await startSession(world, info)
  })

  afterEach(async () => {
    await session.close()
  })

  afterAll(async () => {
    await world.close()
  })

  const botPosition = (): Promise<Position> => world.playerPosition(session.bot.username)

  /** RCON changes reach the bot a moment later: retry a tool call until the bot's own view matches. */
  async function untilBotSees<T>(
    tool: string,
    args: Record<string, unknown>,
    accept: (data: T) => boolean,
    description: string,
  ): Promise<T> {
    return waitUntil(
      async () => {
        const result = await session.bot.call(tool, args)
        return !result.isError && accept(result.data as T) ? (result.data as T) : undefined
      },
      { description },
    )
  }

  describe('goto', () => {
    it('walks to coordinates', async () => {
      const task = dataOf<TaskView>(
        await session.bot.call('goto', { x: 8, y: GROUND_Y, z: 8, within: 1, wait_seconds: 40 }),
      )

      expect(task.status).toBe('succeeded')
      expect(horizontalDistance(await botPosition(), at(8, 8))).toBeLessThan(2)
    })

    it('walks to a player', async () => {
      await world.teleport(session.player.username, at(10.5, -9.5))
      await untilBotSees<{ position: Position }>(
        'get_player_position',
        {},
        (owner) => horizontalDistance(owner.position, at(10.5, -9.5)) < 1,
        'the bot to see its owner at the new spot',
      )

      const task = dataOf<TaskView>(
        await session.bot.call('goto', {
          player: session.player.username,
          within: 3,
          wait_seconds: 40,
        }),
      )

      expect(task.status).toBe('succeeded')
      expect(horizontalDistance(await botPosition(), at(10.5, -9.5))).toBeLessThan(4.5)
    })

    it('walks to the nearest block of a type', async () => {
      await world.setBlock(at(-9, 7), 'crafting_table')
      await untilBotSees<{ count: number }>(
        'find_blocks',
        { names: ['crafting_table'] },
        (found) => found.count === 1,
        'the bot to see the crafting table',
      )

      const task = dataOf<TaskView>(
        await session.bot.call('goto', { block: 'crafting_table', within: 2, wait_seconds: 40 }),
      )

      expect(task.status).toBe('succeeded')
      expect(task.result?.targetPosition).toEqual({ x: -9, y: GROUND_Y, z: 7 })
      expect(horizontalDistance(await botPosition(), at(-9, 7))).toBeLessThan(3.5)
    })

    it('reports a missing block with a reason', async () => {
      const result = await session.bot.call('goto', { block: 'diamond_block', max_distance: 20 })

      expect(result.isError).toBe(true)
      expect(result.text).toContain('block_not_found')
    })

    it('can walk again right after a trip (no stale stop request)', async () => {
      dataOf(
        await session.bot.call('goto', { x: 4, y: GROUND_Y, z: -4, within: 1, wait_seconds: 40 }),
      )

      const second = dataOf<TaskView>(
        await session.bot.call('goto', { x: -4, y: GROUND_Y, z: 4, within: 1, wait_seconds: 40 }),
      )

      expect(second.status).toBe('succeeded')
      expect(horizontalDistance(await botPosition(), at(-4, 4))).toBeLessThan(2)
    })

    it('returns "running" for a trip longer than the wait budget, then completes in the background', async () => {
      const started = dataOf<TaskView>(
        await session.bot.call('goto', { x: 13, y: GROUND_Y, z: 13, within: 1, wait_seconds: 0 }),
      )
      expect(started.status).toBe('running')

      const finished = await waitUntil(
        async () => {
          const task = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
          return task.status === 'running' ? undefined : task
        },
        { timeoutMs: 40_000, description: 'the background trip to finish' },
      )

      expect(finished.status).toBe('succeeded')
    })
  })

  describe('following and stopping', () => {
    /** Walks the human along a route and waits for the bot to catch up with each stop. */
    async function followAcross(...points: Position[]): Promise<void> {
      for (const point of points) {
        await world.teleport(session.player.username, point)
        await waitUntil(async () => horizontalDistance(await botPosition(), point) < 5, {
          timeoutMs: 30_000,
          description: `the bot to follow to ${String(point.x)}, ${String(point.z)}`,
        })
      }
    }

    it('follows the owner around until stopped with the stop tool', async () => {
      const started = dataOf<TaskView & { description: string }>(
        await session.bot.call('follow_player', { distance: 3 }),
      )
      expect(started.status).toBe('running')
      expect(started.description).toBe(`Follow ${session.player.username}`)

      await followAcross(at(12.5, 0.5), at(-12.5, 6.5))
      const stopped = dataOf<{ stopped: boolean; task: TaskView }>(await session.bot.call('stop'))

      expect(stopped.stopped).toBe(true)
      expect(stopped.task.status).toBe('cancelled')
      const resting = await botPosition()
      await world.teleport(session.player.username, at(12.5, -12.5))
      await pause(3_000)
      expect(horizontalDistance(await botPosition(), resting)).toBeLessThan(1.5)
    })

    it('stops in code when the owner types "stop" in chat', async () => {
      dataOf(await session.bot.call('follow_player', { distance: 3 }))
      await followAcross(at(12.5, 0.5))

      session.player.chat('stop')

      await waitUntil(
        async () => {
          const task = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
          return task.status === 'cancelled' ? true : undefined
        },
        { timeoutMs: 10_000, description: 'the follow task to be cancelled by the chat command' },
      )
      const resting = await botPosition()
      await world.teleport(session.player.username, at(-12.5, -12.5))
      await pause(3_000)
      expect(horizontalDistance(await botPosition(), resting)).toBeLessThan(1.5)
      const heard = dataOf<{ events: { type: string }[] }>(
        await session.bot.call('wait_for_chat', { timeout_seconds: 1 }),
      )
      expect(heard.events.map((e) => e.type)).toContain('command')
    })

    it('stops a trip in progress when the owner types "stop"', async () => {
      dataOf(
        await session.bot.call('goto', { x: 13, y: GROUND_Y, z: 13, within: 1, wait_seconds: 0 }),
      )
      await pause(500)

      session.player.chat('stop')

      await waitUntil(() => (session.bot.app.tasks.current() === undefined ? true : undefined), {
        timeoutMs: 10_000,
        description: 'the trip to be cancelled',
      })
      expect(session.bot.app.tasks.latest()?.status).toBe('cancelled')
    })
  })

  describe('perception', () => {
    it('finds blocks the game placed nearby, nearest first', async () => {
      await world.setBlock(at(3, 3), 'iron_ore')
      await world.setBlock(at(-2, 2), 'iron_ore') // clearly nearer to the bot (at -5.5, -5.5) than the other

      const found = await untilBotSees<{
        count: number
        blocks: { name: string; distance: number }[]
      }>(
        'find_blocks',
        { names: ['iron_ore'], max_distance: 30 },
        (data) => data.count === 2,
        'the bot to see both iron ore blocks',
      )

      expect(found.blocks.map((b) => b.name)).toEqual(['iron_ore', 'iron_ore'])
      expect(found.blocks[0]?.distance).toBeLessThan(found.blocks[1]?.distance ?? 0)
    })

    it('looks around: the block underfoot, notable blocks, and creatures', async () => {
      await world.setBlock(at(-4, -4), 'oak_log')
      await world.setBlock(at(-3, -5), 'chest')
      await world.summon('cow', at(-3.5, -3.5))

      const around = await untilBotSees<{
        dimension: string
        standingOn: string
        notableBlocks: { name: string }[]
        entities: { name: string }[]
      }>(
        'look_around',
        { radius: 6 },
        (data) =>
          data.notableBlocks.some((b) => b.name === 'oak_log') &&
          data.notableBlocks.some((b) => b.name === 'chest') &&
          data.entities.some((e) => e.name === 'cow'),
        'the bot to see the log, the chest, and the cow',
      )

      expect(around.dimension).toBe('overworld')
      expect(around.standingOn).toBe('grass_block')
    })

    it('lists nearby entities and finds the owner', async () => {
      await world.summon('cow', at(-3.5, -1.5))

      const entities = await untilBotSees<{ entities: { name: string }[] }>(
        'get_nearby_entities',
        { radius: 20, category: 'animal' },
        (data) => data.entities.some((e) => e.name === 'cow'),
        'the bot to see the cow',
      )
      const owner = dataOf<{ player: string; visible: boolean; position: Position }>(
        await session.bot.call('get_player_position'),
      )

      expect(entities.entities.length).toBeGreaterThan(0)
      expect(owner.player).toBe(session.player.username)
      expect(owner.visible).toBe(true)
      expect(
        horizontalDistance(owner.position, await world.playerPosition(session.player.username)),
      ).toBeLessThan(1)
    })

    it('reads the inventory', async () => {
      await world.give(session.bot.username, 'iron_ingot', 12)
      await world.give(session.bot.username, 'apple', 5)

      const inventory = await untilBotSees<{ items: { name: string; count: number }[] }>(
        'get_inventory',
        {},
        (data) =>
          data.items.some((i) => i.name === 'iron_ingot') &&
          data.items.some((i) => i.name === 'apple'),
        'the given items to show up in the inventory',
      )

      expect(inventory.items).toEqual(
        expect.arrayContaining([
          { name: 'iron_ingot', count: 12 },
          { name: 'apple', count: 5 },
        ]),
      )
    })
  })
})
