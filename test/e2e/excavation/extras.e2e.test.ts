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
  result: { broken: number; placed: number; ended: unknown[] } | null
}

describe('stairs and a water landing on a real Minecraft server', () => {
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
    // The arena reset only restores the top layer of the floor: fill the layers below back in after earlier digs.
    await world.fill(cell(-14, -3, -14), cell(14, -2, 14), 'dirt')
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

  async function excavate(args: Record<string, unknown>) {
    const first = await session.bot.call('excavate', { wait_seconds: 40, ...args })
    if (first.isError) return { failed: true as const, text: first.text, task: undefined }
    let task = first.data as TaskView
    if (task.status === 'running') {
      task = await waitUntil(
        async () => {
          const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
          return status.status === 'running' ? undefined : status
        },
        { timeoutMs: 180_000, description: 'the dig to finish' },
      )
    }
    return { failed: task.status !== 'succeeded', text: JSON.stringify(task), task }
  }

  const is = (position: Position, block: string): Promise<boolean> => world.isBlock(position, block)

  /** A picture of the blocks around the stairs, one line per height: air, bedrock, or something solid. */
  async function slice(): Promise<string[]> {
    const lines: string[] = []
    for (let dy = -3; dy <= 1; dy += 1) {
      let row = ''
      for (let z = -8; z <= -4; z += 1) {
        for (let x = 7; x <= 12; x += 1)
          row += (await is(cell(x, dy, z), 'air'))
            ? '.'
            : (await is(cell(x, dy, z), 'bedrock'))
              ? 'B'
              : '#'
        row += ' '
      }
      lines.push(`y=${String(GROUND_Y + dy)} ${row}`)
    }
    return lines
  }

  /** Waits until the bot's own view shows a solid floor at the spot again (RCON changes arrive late). */
  const untilBotSeesFloor = (origin: Position): Promise<true> =>
    waitUntil(
      async () => {
        const seen = dataOf<{ blocks: number }>(
          await session.bot.call('preview_excavation', {
            shape: 'pit',
            params: { width: 1, length: 1, depth: 3, exit: 'none' },
            origin: { x: origin.x, y: origin.y, z: origin.z },
          }),
        )
        return seen.blocks === 3 ? true : undefined
      },
      { description: 'the bot to see the solid floor' },
    )

  it('cuts a staircase around a pit, and the bot walks up it by itself', async () => {
    const origin = cell(9, -1, -6)
    await untilBotSeesFloor(origin)

    const run = await excavate({
      shape: 'pit',
      params: { width: 3, length: 3, depth: 3, exit: 'stairs' },
      origin: { x: origin.x, y: origin.y, z: origin.z },
    })

    if (run.failed) throw new Error(`The dig did not succeed: ${run.text}`)
    // Ring cell n at depth n: north-west corner (8, -7), then east along the north edge.
    expect(await is(cell(8, -1, -7), 'air')).toBe(true) // step 0: dug into the grass layer
    expect(await is(cell(9, -2, -7), 'air')).toBe(true) // step 1
    expect(await is(cell(10, -3, -7), 'air')).toBe(true) // step 2
    expect(await is(cell(10, -4, -7), 'bedrock')).toBe(true) // its floor is the bedrock
    if (!(await is(cell(9, -3, -7), 'dirt'))) {
      const seen: string[] = []
      for (const name of [
        'air',
        'grass_block',
        'stone',
        'coarse_dirt',
        'cobblestone',
        'ladder',
        'torch',
        'gravel',
      ])
        if (await is(cell(9, -3, -7), name)) seen.push(name)
      throw new Error(
        `Below step 1 there should be dirt, but it is: ${seen.join(', ') || 'something else'}\n${(await slice()).join('\n')}`,
      )
    }
    expect(await is(cell(10, -3, -5), 'air')).toBe(true) // the pit itself, bottom layer

    // The bot is in the pit: it walks out by the stairs.
    const surface = { x: 6.5, y: GROUND_Y, z: -5.5 }
    const out = await session.bot.call('goto', {
      x: surface.x,
      y: surface.y,
      z: surface.z,
      wait_seconds: 30,
    })
    if (out.isError) {
      const here = await world.playerPosition(bot())
      throw new Error(
        `The bot could not walk out: ${out.text}; it stands at ${JSON.stringify(here)}\n${(await slice()).join('\n')}`,
      )
    }
    await waitUntil(
      async () => {
        const here = await world.playerPosition(bot())
        return Math.hypot(here.x - surface.x, here.z - surface.z) < 2 && here.y > GROUND_Y - 0.5
          ? true
          : undefined
      },
      { description: 'the bot to walk out of the pit' },
    )
  })

  it('digs a quarry with a water landing: two buckets make a pond in the far corner', async () => {
    await world.give(bot(), 'water_bucket', 2)
    await waitUntil(
      async () => {
        const inventory = await session.bot.call('get_inventory')
        const items = inventory.isError
          ? []
          : (inventory.data as { items: { name: string }[] }).items
        return items.some((entry) => entry.name === 'water_bucket') ? true : undefined
      },
      { description: 'the bot to carry the buckets' },
    )
    const origin = cell(3, -1, -8)
    await untilBotSeesFloor(origin)

    const run = await excavate({
      shape: 'quarry',
      params: { width: 4, length: 4, to_y: origin.y, exit: 'none', water_landing: true },
      origin: { x: origin.x, y: origin.y, z: origin.z },
    })

    if (run.failed) throw new Error(`The dig did not succeed: ${run.text}`)
    expect(run.task.result?.placed).toBe(2)
    // The pond is in the far (south-east) corner of x 3..6, z -8..-5: x 5..6, z -6..-5, two layers below the floor.
    for (const [x, z] of [
      [5, -6],
      [6, -5],
    ] as const)
      expect(await is(cell(x, -2, z), 'water')).toBe(true) // the two sources
    // Water renews itself between the sources, and falls into the lower layer.
    await waitUntil(
      async () =>
        (await is(cell(6, -2, -6), 'water')) && (await is(cell(5, -3, -6), 'water'))
          ? true
          : undefined,
      { description: 'the pond to fill' },
    )
    expect(await is(cell(3, -1, -8), 'air')).toBe(true) // the rest of the quarry is dry and open
    expect(await is(cell(4, -2, -6), 'dirt')).toBe(true) // outside the pond
  })
})
