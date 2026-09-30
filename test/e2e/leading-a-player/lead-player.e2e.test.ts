import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { dataOf } from '../support/app-under-test.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { startSession, type E2ESession } from '../support/session.js'
import { pause, waitUntil } from '../support/wait.js'

interface TaskView {
  status: string
  progress?: string
  result: { destination: string; calls: number; waits: number } | null
}

const step = (from: Position, to: Position, distance: number): Position => {
  const gap = Math.hypot(to.x - from.x, to.z - from.z)
  if (gap <= distance || gap === 0) return { x: to.x, y: GROUND_Y, z: to.z }
  return {
    x: from.x + ((to.x - from.x) / gap) * distance,
    y: GROUND_Y,
    z: from.z + ((to.z - from.z) / gap) * distance,
  }
}

describe('leading a player on a real Minecraft server', () => {
  let info: ServerInfo
  let world: E2EWorld
  let session: E2ESession
  let sessionOpen = false
  let driver: { stop(): Promise<void>; maxSeparation(): number } | undefined

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
    await driver?.stop()
    driver = undefined
    if (sessionOpen) {
      sessionOpen = false
      await session.close()
    }
  })

  afterAll(async () => {
    await world.close()
  })

  /**
   * Plays the human's feet: every half second the owner is teleported a step towards `goal(bot)` (a real player bot cannot
   * walk), at `speed` blocks per second, and the distance between the two is recorded.
   */
  function drive(speed: number, goal: (bot: Position, owner: Position) => Position) {
    const state = { running: true }
    let farthest = 0
    const done = (async () => {
      while (state.running) {
        const bot = await world.playerPosition(session.bot.username)
        const owner = await world.playerPosition(session.player.username)
        farthest = Math.max(farthest, Math.hypot(bot.x - owner.x, bot.z - owner.z))
        await world.teleport(session.player.username, step(owner, goal(bot, owner), speed * 0.5))
        await pause(400)
      }
    })()
    driver = {
      stop: async () => {
        state.running = false
        await done
      },
      maxSeparation: () => farthest,
    }
    return driver
  }

  async function lead(args: Record<string, unknown>, waitSeconds = 45) {
    return session.bot.call('lead_player', { wait_seconds: waitSeconds, ...args })
  }

  const finished = (): Promise<TaskView> =>
    waitUntil(
      async () => {
        const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
        return status.status === 'running' ? undefined : status
      },
      { timeoutMs: 120_000, description: 'the leading to finish' },
    )

  it('leads a following owner 40 blocks, and both end near the destination', async () => {
    const goal = { x: 40.5, y: GROUND_Y, z: 0.5 }
    const following = drive(4, (bot) => bot)

    const first = await lead({
      x: goal.x,
      y: goal.y,
      z: goal.z,
      lead_distance: 8,
      arrive_within: 5,
    })
    const task = first.isError ? undefined : (first.data as TaskView)
    const result = task?.status === 'running' ? await finished() : task
    if (result?.status !== 'succeeded')
      throw new Error(`Leading did not succeed: ${JSON.stringify(result)} ${first.text}`)

    const bot = await world.playerPosition(session.bot.username)
    const owner = await world.playerPosition(session.player.username)
    expect(Math.hypot(bot.x - goal.x, bot.z - goal.z)).toBeLessThanOrEqual(6)
    expect(Math.hypot(owner.x - goal.x, owner.z - goal.z)).toBeLessThanOrEqual(16)
    // Never more than the lead distance plus one leg (and a moment of lag from the half-second driver).
    expect(following.maxSeparation()).toBeLessThanOrEqual(8 + 6 + 4)
  }, 240_000)

  it('waits when the owner stands still, and stays within reach of an owner who walks off sideways', async () => {
    const goal = { x: 45.5, y: GROUND_Y, z: -30.5 }
    // The owner stands still for a while, then wanders off along z.
    let wandering = false
    const moving = drive(3, (_bot, owner) =>
      wandering ? { x: owner.x, y: GROUND_Y, z: owner.z + 20 } : owner,
    )

    const first = await lead(
      { x: goal.x, y: goal.y, z: goal.z, lead_distance: 8, arrive_within: 5 },
      20,
    )
    expect((first.data as TaskView).status).toBe('running')
    await waitUntil(
      async () => {
        const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
        return status.progress?.startsWith('Waiting for') === true ? true : undefined
      },
      { timeoutMs: 60_000, description: 'the bot to wait for the owner' },
    )

    wandering = true
    await pause(15_000)
    const bot = await world.playerPosition(session.bot.username)
    const owner = await world.playerPosition(session.player.username)

    expect(Math.hypot(bot.x - goal.x, bot.z - goal.z)).toBeGreaterThan(8) // it did not go on alone
    expect(Math.hypot(bot.x - owner.x, bot.z - owner.z)).toBeLessThan(8 * 3) // and it came after the player
    expect(moving.maxSeparation()).toBeLessThan(8 * 4)
  }, 240_000)

  it('ends when the owner types stop', async () => {
    drive(4, (bot) => bot)
    const first = await lead({ x: 60.5, y: GROUND_Y, z: 0.5, lead_distance: 8 }, 5)
    expect((first.data as TaskView).status).toBe('running')

    session.player.chat('stop')

    const status = await waitUntil(
      async () => {
        const view = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
        return view.status === 'running' ? undefined : view
      },
      { timeoutMs: 15_000, description: 'the leading to be stopped by the chat command' },
    )
    expect(status.status).toBe('cancelled')
  }, 120_000)
})
