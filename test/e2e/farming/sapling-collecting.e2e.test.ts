import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { dataOf } from '../support/app-under-test.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { startSession, type E2ESession } from '../support/session.js'
import { waitUntil } from '../support/wait.js'

const cell = (x: number, dy: number, z: number): Position => ({ x, y: GROUND_Y + dy, z })

interface TaskView {
  status: string
  result: Record<string, unknown> | null
}

describe('sapling collecting on a real Minecraft server', () => {
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

  /** RCON changes reach the bot's own view a moment later: wait until it sees what the tool will look for. */
  const untilBotSeesEntity = (name: string): Promise<unknown> =>
    waitUntil(
      async () => {
        const result = await session.bot.call('get_nearby_entities', { radius: 32 })
        if (result.isError) return undefined
        const entities = (result.data as { entities: { name: string }[] }).entities
        return entities.some((entity) => entity.name === name) ? true : undefined
      },
      { description: `the bot to see a ${name}` },
    )

  const untilBotSeesBlock = (name: string): Promise<unknown> =>
    waitUntil(
      async () => {
        const result = await session.bot.call('find_blocks', { names: [name] })
        return !result.isError && (result.data as { count: number }).count >= 1 ? true : undefined
      },
      { description: `the bot to see ${name}` },
    )

  async function run(tool: string, args: Record<string, unknown>) {
    const first = await session.bot.call(tool, { wait_seconds: 45, ...args })
    if (first.isError) return { failed: true as const, text: first.text, task: undefined }
    let task = first.data as TaskView
    if (task.status === 'running') {
      task = await waitUntil(
        async () => {
          const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
          return status.status === 'running' ? undefined : status
        },
        { timeoutMs: 150_000, description: `${tool} to finish` },
      )
    }
    return { failed: task.status !== 'succeeded', text: JSON.stringify(task), task }
  }

  it('picks up saplings lying on the ground before it breaks any leaf', async () => {
    await world.summonWith('item', cell(3, 0, -8), '{Item:{id:"minecraft:oak_sapling",count:3},PickupDelay:0}')
    await untilBotSeesEntity('item')

    const collected = await run('collect_saplings', { species: 'oak', count: 2 })

    if (collected.failed) throw new Error(`collect_saplings did not succeed: ${collected.text}`)
    expect(collected.task.result).toMatchObject({ saplings: 3, requested: 2, leaves: 0 })
    expect(await world.countItem(bot(), 'oak_sapling')).toBe(3)
  })

  it('breaks oak leaves by hand until a sapling drops', async () => {
    // Persistent leaves never decay by themselves. About 1 leaf in 20 drops a sapling, so 100 leaves are almost
    // sure to give one (the chance of none is under 1%).
    await world.fill(cell(2, 0, -13), cell(8, 2, -8), 'oak_leaves[persistent=true]')
    await untilBotSeesBlock('oak_leaves')

    const collected = await run('collect_saplings', { species: 'oak', count: 1, max_leaves: 100 })

    if (collected.failed) throw new Error(`collect_saplings did not succeed: ${collected.text}`)
    const result = collected.task.result as { saplings: number; leaves: number }
    expect(result.saplings).toBeGreaterThanOrEqual(1)
    expect(result.leaves).toBeGreaterThan(0)
    expect(await world.countItem(bot(), 'oak_sapling')).toBeGreaterThanOrEqual(1)
  })
})
