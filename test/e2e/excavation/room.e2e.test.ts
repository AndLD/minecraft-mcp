import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { HEADINGS } from '../../../src/skills/excavation/providers/geometry.js'
import { dataOf } from '../support/app-under-test.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { startSession, type E2ESession } from '../support/session.js'
import { waitUntil } from '../support/wait.js'

interface TaskView {
  status: string
  result: Record<string, unknown> | null
  waitingFor: { options: string[]; message: string } | null
}

const add = (p: Position, v: Position, scale = 1): Position => ({
  x: p.x + v.x * scale,
  y: p.y + v.y * scale,
  z: p.z + v.z * scale,
})

describe('digging a room into a wall on a real Minecraft server', () => {
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
    await world.setTime('night') // dark inside, so the room's torches are actually needed
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
  const is = (position: Position, block: string): Promise<boolean> => world.isBlock(position, block)

  /** A solid stone hill facing the player, south of it: x = -3..3, z = -9..-3, y = ground..ground + 5. */
  async function hill() {
    await world.fill(
      { x: -3, y: GROUND_Y, z: -9 },
      { x: 3, y: GROUND_Y + 5, z: -3 },
      'stone',
    )
    // The player stands south of the wall, looking north (yaw 180) at its face.
    await world.face(session.player.username, { x: 0.5, y: GROUND_Y, z: -1.5 }, 180, 0)
    await world.teleport(bot(), { x: 1.5, y: GROUND_Y, z: -1.5 })
    await waitUntil(
      async () => {
        const seen = dataOf<{ blocks: number }>(
          await session.bot.call('preview_excavation', {
            shape: 'pit',
            params: { width: 1, length: 1, depth: 1, exit: 'none' },
            origin: { x: 0, y: GROUND_Y + 1, z: -3 },
          }),
        )
        return seen.blocks === 1 ? true : undefined // 1 block to break: the bot now sees the stone there
      },
      { description: 'the bot to see the hill' },
    )
  }

  async function runToTheEnd(args: Record<string, unknown>) {
    const first = await session.bot.call('excavate', { wait_seconds: 50, ...args })
    if (first.isError) return { failed: true as const, text: first.text, task: undefined }
    let task = first.data as TaskView
    if (task.status === 'running') {
      task = await waitUntil(
        async () => {
          const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
          return status.status === 'running' ? undefined : status
        },
        { timeoutMs: 220_000, description: 'the room to finish' },
      )
    }
    return { failed: task.status !== 'succeeded', text: JSON.stringify(task), task }
  }

  it('digs a room into the wall the player looks at, with a lit entrance and a door', async () => {
    await hill()
    await world.give(bot(), 'iron_pickaxe', 1)
    await world.give(bot(), 'torch', 8)
    await world.give(bot(), 'oak_door', 1)

    const preview = dataOf<{ origin: Position; interpreted: { direction: string } }>(
      await session.bot.call('preview_excavation', {
        shape: 'room',
        params: { width: 3, length: 3, height: 3, door: 'oak_door' },
      }),
    )
    const origin = preview.origin
    const direction = preview.interpreted.direction as keyof typeof HEADINGS
    expect(direction).toBe('north')
    const { forward, right } = HEADINGS[direction]
    const cell = (i: number, a: number, b: number): Position =>
      add(add(add(origin, forward, i), right, a - 1), { x: 0, y: 1, z: 0 }, b)

    const run = await runToTheEnd({
      shape: 'room',
      params: { width: 3, length: 3, height: 3, door: 'oak_door' },
    })

    if (run.failed) throw new Error(`The room did not finish: ${run.text}`)
    expect(run.task.result).toMatchObject({ shape: 'room 3x3x3' })
    // The entrance: a door placed at the floor fills both cells of the entrance's height by itself (the upper
    // and lower halves of the same door), matching entrance_height's default of 2.
    expect(await is(cell(0, 1, 0), 'oak_door')).toBe(true)
    expect(await is(cell(0, 1, 1), 'oak_door')).toBe(true)
    // The room itself: every cell open, except the floor-level side-wall cells, which hold torches.
    for (let i = 1; i <= 3; i += 1)
      for (let a = 0; a <= 2; a += 1)
        for (let b = 0; b <= 2; b += 1) {
          const isTorchSpot = b === 0 && (a === 0 || a === 2) && i === 1
          expect(await is(cell(i, a, b), isTorchSpot ? 'torch' : 'air')).toBe(true)
        }
    // Outside the room, the hill is untouched.
    expect(await is(cell(2, -1, 1), 'stone')).toBe(true)
    expect(await is(cell(2, 3, 1), 'stone')).toBe(true)
  }, 240_000)

  it('with entrance: player, waits for the entrance to be cut by hand, then finishes the room', async () => {
    await hill()
    await world.give(bot(), 'iron_pickaxe', 1)
    await world.give(bot(), 'torch', 8)

    const preview = dataOf<{ origin: Position; interpreted: { direction: string } }>(
      await session.bot.call('preview_excavation', {
        shape: 'room',
        params: { width: 2, length: 2, height: 2 },
      }),
    )
    const origin = preview.origin
    const direction = preview.interpreted.direction as keyof typeof HEADINGS
    const { forward } = HEADINGS[direction]

    const first = await session.bot.call('excavate', {
      shape: 'room',
      params: { width: 2, length: 2, height: 2, entrance: 'player' },
      wait_seconds: 20,
    })
    const started = dataOf<TaskView>(first)
    const waiting =
      started.status === 'waiting_for_input'
        ? started
        : await waitUntil(
            async () => {
              const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status'))
                .task
              return status.status === 'waiting_for_input' ? status : undefined
            },
            { timeoutMs: 60_000, description: 'the room to ask for the entrance' },
          )
    expect(waiting.waitingFor?.options).toEqual(['done'])
    // Nothing is dug yet: the entrance cell is still stone.
    expect(await is(origin, 'stone')).toBe(true)

    // Cut the entrance by hand (1 wide, 2 high, 1 deep), then say it is open.
    await world.setBlock(origin, 'air')
    await world.setBlock(add(origin, { x: 0, y: 1, z: 0 }), 'air')
    // RCON changes reach the bot a moment later: wait until it sees the entrance is open before saying so.
    for (const spot of [origin, add(origin, { x: 0, y: 1, z: 0 })])
      await waitUntil(
        async () => {
          const seen = dataOf<{ blocks: number }>(
            await session.bot.call('preview_excavation', {
              shape: 'pit',
              params: { width: 1, length: 1, depth: 1, exit: 'none' },
              origin: spot,
            }),
          )
          return seen.blocks === 0 ? true : undefined
        },
        { description: 'the bot to see the entrance open' },
      )
    const answered = await session.bot.call('resume_task', { decision: 'done' })
    expect(answered.isError).toBe(false)

    const finished = await waitUntil(
      async () => {
        const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
        return status.status === 'running' ? undefined : status
      },
      { timeoutMs: 120_000, description: 'the room to finish after the entrance is opened' },
    )
    if (finished.status !== 'succeeded')
      throw new Error(`The room did not finish: ${JSON.stringify(finished)}`)
    // The room itself was dug (b = 1, above the floor-level side-wall cells, which hold torches instead).
    expect(await is(add(add(origin, forward, 1), { x: 0, y: 1, z: 0 }), 'air')).toBe(true)
  })

  it('stops a column one block short of water behind the wall', async () => {
    await hill()
    await world.give(bot(), 'iron_pickaxe', 1)
    await world.give(bot(), 'torch', 8)

    const preview = dataOf<{ origin: Position; interpreted: { direction: string } }>(
      await session.bot.call('preview_excavation', {
        shape: 'room',
        params: { width: 2, length: 3, height: 2, torch_spacing: 0 },
      }),
    )
    const origin = preview.origin
    const direction = preview.interpreted.direction as keyof typeof HEADINGS
    const { forward, right } = HEADINGS[direction]
    const WIDTH = 2
    const centerIndex = Math.floor((WIDTH - 1) / 2) // 0: origin's own column is a = 0
    const cell = (i: number, a: number): Position =>
      add(add(origin, forward, i), right, a - centerIndex)
    // The room's own back row (i = 3: entrance length (1) + room length (3) - 1), column a = 1, with water one
    // cell further on (i = 4, outside the room): the cell touching the water (i = 3) is not broken, so the chain's
    // last dug cell is the one before it (i = 2).
    const lastDug = cell(2, 1)
    const notDug = cell(3, 1)
    await world.setBlock(add(notDug, forward, 1), 'water')

    const run = await runToTheEnd({
      shape: 'room',
      params: { width: 2, length: 3, height: 2, torch_spacing: 0 },
    })

    if (run.failed) throw new Error(`The room did not finish: ${run.text}`)
    const value = run.task.result as { ended: { reason: string }[] }
    expect(value.ended.some((e) => e.reason === 'hit_water')).toBe(true)
    expect(await is(lastDug, 'air')).toBe(true)
    expect(await is(notDug, 'stone')).toBe(true) // one block short of the water
    expect(await is(add(notDug, forward, 1), 'water')).toBe(true) // untouched
  })
})
