import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { dataOf } from '../support/app-under-test.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { startSession, type E2ESession } from '../support/session.js'
import { pause, waitUntil } from '../support/wait.js'

const at = (x: number, z: number, y = GROUND_Y): Position => ({ x, y, z })

interface TaskView {
  status: string
  result: Record<string, unknown> | null
}

describe('break_block on a real Minecraft server', () => {
  let info: ServerInfo
  let world: E2EWorld
  let session: E2ESession
  let sessionOpen = false

  beforeAll(async () => {
    info = readServerInfo()
    world = await E2EWorld.connect(info)
    await world.setDifficulty('peaceful')
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

  const owner = (): string => session.player.username

  /** RCON changes reach the bot a moment later: wait until it sees this block at this place. */
  async function untilBotSeesAt(position: Position, name: string): Promise<void> {
    await waitUntil(
      async () => {
        const found = await session.bot.call('find_blocks', { names: [name], count: 30 })
        const blocks = found.isError
          ? []
          : (found.data as { blocks: { position: Position }[] }).blocks
        return blocks.some(
          (block) =>
            block.position.x === position.x &&
            block.position.y === position.y &&
            block.position.z === position.z,
        )
          ? true
          : undefined
      },
      { description: `the bot to see ${name} at ${JSON.stringify(position)}` },
    )
  }

  /** Runs a task tool and waits for its end; `failed` carries the failure text. */
  async function run(tool: string, args: Record<string, unknown> = {}) {
    const first = await session.bot.call(tool, { wait_seconds: 50, ...args })
    if (first.isError) return { failed: true as const, text: first.text, task: undefined }
    let task = first.data as TaskView
    if (task.status === 'running') {
      task = await waitUntil(
        async () => {
          const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
          return status.status === 'running' ? undefined : status
        },
        { timeoutMs: 120_000, description: `${tool} to finish` },
      )
    }
    return { failed: task.status !== 'succeeded', text: JSON.stringify(task), task }
  }

  /** A row of three stairs a "player" built, seen by the bot. */
  async function stairRow(z: number): Promise<void> {
    for (const x of [9, 10, 11]) await world.setBlock(at(x, z), 'oak_stairs[facing=south]')
    await untilBotSeesAt(at(11, z), 'oak_stairs')
  }

  it('breaks exactly one stair block and nothing beside it (exit criterion)', async () => {
    await stairRow(-8)

    const result = await run('break_block', { ...at(10, -8) })

    if (result.failed) throw new Error(result.text)
    expect(result.task.result).toMatchObject({ broken: true, block: 'oak_stairs' })
    expect(await world.isBlock(at(10, -8), 'air')).toBe(true)
    expect(await world.isBlock(at(9, -8), 'oak_stairs')).toBe(true)
    expect(await world.isBlock(at(11, -8), 'oak_stairs')).toBe(true)
  })

  it('breaks the block the owner looks at, without coordinates', async () => {
    await world.setBlock(at(-1, 4), 'oak_planks')
    await untilBotSeesAt(at(-1, 4), 'oak_planks')
    // Two blocks south of the block, looking north (yaw 180) and slightly down at it.
    await world.face(owner(), at(-1, 6), 180, 20)
    await pause(1500)

    const result = await waitUntil(
      async () => {
        const attempt = await run('break_block', { looking_at: true })
        return attempt.failed && attempt.text.includes('not looking') ? undefined : attempt
      },
      { description: 'the bot to see where the owner looks' },
    )

    if (result.failed) throw new Error(result.text)
    expect(result.task.result).toMatchObject({ broken: true, at: at(-1, 4) })
    expect(await world.isBlock(at(-1, 4), 'air')).toBe(true)
  })

  it('refuses a stone with lava behind it', async () => {
    await world.setBlock(at(9, 8), 'stone')
    await world.setBlock(at(10, 8), 'lava')
    await untilBotSeesAt(at(10, 8), 'lava')

    const result = await run('break_block', { ...at(9, 8) })

    expect(result.failed).toBe(true)
    expect(result.text).toContain('hit_lava')
    expect(await world.isBlock(at(9, 8), 'stone')).toBe(true)
  })

  it('refuses a protected block, then breaks just that one with the override, and the area stays', async () => {
    await stairRow(-6)
    dataOf(
      await session.bot.call('protect_area', {
        label: 'House',
        x1: 8,
        y1: GROUND_Y - 2,
        z1: -8,
        x2: 12,
        y2: GROUND_Y + 4,
        z2: -4,
      }),
    )

    const refused = await run('break_block', { ...at(10, -6) })
    expect(refused.failed).toBe(true)
    expect(refused.text).toContain('protected_area')
    expect(await world.isBlock(at(10, -6), 'oak_stairs')).toBe(true)

    const forced = await run('break_block', { ...at(10, -6), override_protection: true })
    if (forced.failed) throw new Error(forced.text)
    expect(forced.task.result).toMatchObject({ broken: true, overrodeProtection: 'House' })
    expect(await world.isBlock(at(10, -6), 'air')).toBe(true)
    expect(await world.isBlock(at(9, -6), 'oak_stairs')).toBe(true)
    const areas = dataOf<{ areas: { label: string }[] }>(
      await session.bot.call('list_protected_areas'),
    )
    expect(areas.areas.map((area) => area.label)).toEqual(['House'])
  })

  it('refuses bedrock, even inside a protected area with the override', async () => {
    await world.setBlock(at(9, 6), 'bedrock')
    // The whole floor below is bedrock, so "the nearest bedrock" cannot tell when this one has arrived: just wait.
    await pause(1500)
    dataOf(
      await session.bot.call('protect_area', {
        label: 'Vault',
        x1: 8,
        y1: GROUND_Y - 2,
        z1: 5,
        x2: 10,
        y2: GROUND_Y + 3,
        z2: 7,
      }),
    )

    const result = await run('break_block', { ...at(9, 6), override_protection: true })

    expect(result.failed).toBe(true)
    expect(result.text).toContain('unbreakable')
    expect(await world.isBlock(at(9, 6), 'bedrock')).toBe(true)
  })

  it('asks before breaking a chest with things in it', async () => {
    await world.setBlock(at(9, -10), 'chest')
    await untilBotSeesAt(at(9, -10), 'chest')

    const refused = await run('break_block', { ...at(9, -10) })

    expect(refused.failed).toBe(true)
    expect(refused.text).toContain('holds_items')
    expect(await world.isBlock(at(9, -10), 'chest')).toBe(true)
  })
})
