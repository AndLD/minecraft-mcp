import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { dataOf } from '../support/app-under-test.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { startSession, type E2ESession } from '../support/session.js'
import { waitUntil } from '../support/wait.js'

interface TaskView {
  status: string
  result: Record<string, unknown> | null
}

describe('site leveling on a real Minecraft server', () => {
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

  const is = (position: Position, block: string): Promise<boolean> => world.isBlock(position, block)

  async function flatten(args: Record<string, unknown>) {
    const first = await session.bot.call('flatten_area', { wait_seconds: 40, ...args })
    if (first.isError) return { failed: true as const, text: first.text, task: undefined }
    let task = first.data as TaskView
    if (task.status === 'running') {
      task = await waitUntil(
        async () => {
          const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
          return status.status === 'running' ? undefined : status
        },
        { timeoutMs: 120_000, description: 'the flatten to finish' },
      )
    }
    return { failed: task.status !== 'succeeded', text: JSON.stringify(task), task }
  }

  it('cuts a mound and fills a hole in the plot given by origin, direction, width, and length', async () => {
    const origin = { x: 5, y: GROUND_Y, z: -5 }
    await world.fill({ x: 4, y: GROUND_Y - 3, z: -6 }, { x: 9, y: GROUND_Y + 3, z: -4 }, 'air')
    await world.fill({ x: 4, y: GROUND_Y - 3, z: -6 }, { x: 9, y: GROUND_Y - 1, z: -4 }, 'dirt')
    await world.setBlock(origin, 'dirt') // a one-block mound at the plot's own start cell
    await world.setBlock({ x: 7, y: GROUND_Y - 1, z: -5 }, 'air') // a one-block hole further along
    // RCON changes reach the bot a moment later: wait until it sees the mound.
    await waitUntil(
      async () => {
        const seen = dataOf<{ blocks: number }>(
          await session.bot.call('preview_excavation', {
            shape: 'pit',
            params: { width: 1, length: 1, depth: 1, exit: 'none' },
            origin,
          }),
        )
        return seen.blocks === 1 ? true : undefined
      },
      { description: 'the bot to see the mound' },
    )

    const run = await flatten({
      origin: { x: origin.x, z: origin.z },
      direction: 'east',
      width: 1,
      length: 3,
      level: 'y',
      y: GROUND_Y - 1,
    })

    if (run.failed) throw new Error(`The flatten did not succeed: ${run.text}`)
    expect(run.task.result).toMatchObject({
      level: GROUND_Y - 1,
      cut: 1,
      filled: 1,
      fillBlock: 'dirt',
    })
    expect(await is(origin, 'air')).toBe(true) // the mound is gone
    expect(await is({ x: 7, y: GROUND_Y - 1, z: -5 }, 'dirt')).toBe(true) // filled with what the mound produced
  })

  it('refuses when lava is in or next to the plot', async () => {
    const origin = { x: 5, y: GROUND_Y, z: 5 }
    await world.setBlock(origin, 'dirt') // something to cut, so the plan has a step near the lava to check
    await world.setBlock({ x: 6, y: GROUND_Y - 1, z: 5 }, 'lava')
    // RCON changes reach the bot a moment later: wait until it sees the mound (checking the world directly with
    // world.isBlock would only prove the server's own state, not what the bot itself has caught up to).
    await waitUntil(
      async () => {
        const seen = dataOf<{ blocks: number }>(
          await session.bot.call('preview_excavation', {
            shape: 'pit',
            params: { width: 1, length: 1, depth: 1, exit: 'none' },
            origin,
          }),
        )
        return seen.blocks === 1 ? true : undefined
      },
      { description: 'the bot to see the mound' },
    )

    const run = await flatten({
      origin: { x: origin.x, z: origin.z },
      direction: 'east',
      width: 2,
      length: 1,
      level: 'y',
      y: GROUND_Y - 1,
    })

    expect(run.failed).toBe(true)
    expect(run.text).toContain('unsafe_site')
  })
})
