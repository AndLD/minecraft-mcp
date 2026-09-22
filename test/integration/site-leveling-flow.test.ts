import { afterEach, describe, expect, it } from '@jest/globals'
import { toVec3 } from '../../src/bot/vec3.js'
import { FakeBot } from '../fakes/fake-bot.js'
import { createHarness, type Harness } from './support/app-harness.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.close().catch(() => undefined)
  harness = undefined
})

const at = (x: number, y: number, z: number) => ({ x, y, z })
const PLAYER = at(10, 64, 10)

/** Dirt from y = 40 up to the surface at y = 63, air above; the bot and the owner stand on the surface. */
async function start(setup: (bot: FakeBot) => void = () => undefined): Promise<Harness> {
  const bot = new FakeBot().useGameData()
  for (let x = -10; x <= 40; x += 1)
    for (let z = -10; z <= 40; z += 1) {
      for (let y = 40; y <= 63; y += 1) bot.setBlock({ x, y, z }, 'dirt')
      for (let y = 64; y <= 70; y += 1) bot.setBlock({ x, y, z }, 'air')
    }
  bot.entity = { position: at(5, 64, 5) }
  bot.physics = true
  // Facing south (+z): yaw = PI, the convention this codebase's LookTarget/facing math uses.
  bot.players['Andrey_Knight'] = {
    username: 'Andrey_Knight',
    entity: { id: 900, type: 'player', name: 'Andrey_Knight', position: PLAYER, yaw: Math.PI },
  }
  setup(bot)
  const h = await createHarness({}, { bot })
  harness = h
  bot.now = () => h.clock.now()
  const connected = await h.call('connect', { port: 34231 })
  if (connected.isError) throw new Error(connected.text)
  await h.call('wait_for_chat', { timeout_seconds: 1 })
  return h
}

async function pumped<T>(h: Harness, promise: Promise<T>): Promise<T> {
  const state = { done: false }
  const tracked = promise.finally(() => {
    state.done = true
  })
  while (!state.done) {
    h.scheduler.advance(250)
    await h.settle()
  }
  return tracked
}

const call = (h: Harness, name: string, args: Record<string, unknown> = {}) =>
  pumped(h, h.call(name, args))
const task = (result: { data: unknown }): Record<string, unknown> =>
  result.data as Record<string, unknown>
const nameAt = (h: Harness, x: number, y: number, z: number): string | undefined =>
  h.bot.blockAt(toVec3(at(x, y, z)))?.name

describe('site leveling through the MCP server', () => {
  it('previews a flatten: the counts understood, changing nothing', async () => {
    const h = await start((bot) => {
      bot.setBlock({ x: 10, y: 64, z: 10 }, 'stone') // a one-block mound at the player's own cell
    })

    const preview = await h.call('preview_flatten', { width: 3, length: 3 })

    expect(preview.isError).toBe(false)
    expect(task(preview)).toMatchObject({ level: 63, toCut: 1 })
    expect(nameAt(h, 10, 64, 10)).toBe('stone') // untouched
  })

  it('cuts a mound and fills a hole in the plot the player faces', async () => {
    const h = await start((bot) => {
      // Facing south from (10,64,10): the 1x3 plot runs z = 10, 11, 12.
      bot.setBlock({ x: 10, y: 64, z: 10 }, 'dirt') // a mound to cut (dirt drops itself)
      bot.setBlock({ x: 10, y: 63, z: 12 }, 'air') // a hole to fill
    })

    const result = await call(h, 'flatten_area', { width: 1, length: 3, wait_seconds: 30 })

    expect(task(result)).toMatchObject({
      status: 'succeeded',
      result: { level: 63, cut: 1, filled: 1, fillBlock: 'dirt' },
    })
    expect(nameAt(h, 10, 64, 10)).toBe('air')
    expect(nameAt(h, 10, 63, 12)).toBe('dirt') // filled with what cutting the mound produced
  })

  it('leaves a player-made block alone, reported as blocked_cells, unless clear_structures is true', async () => {
    const h = await start((bot) => {
      bot.setBlock({ x: 10, y: 64, z: 10 }, 'oak_fence')
    })

    const left = await call(h, 'flatten_area', { width: 1, length: 1, wait_seconds: 30 })
    expect(task(left)).toMatchObject({
      status: 'succeeded',
      result: { blockedCells: [{ x: 10, y: 64, z: 10 }] },
    })
    expect(nameAt(h, 10, 64, 10)).toBe('oak_fence')

    const cleared = await call(h, 'flatten_area', {
      width: 1,
      length: 1,
      clear_structures: true,
      wait_seconds: 30,
    })
    expect(task(cleared)).toMatchObject({ status: 'succeeded', result: { blockedCells: [] } })
    expect(nameAt(h, 10, 64, 10)).toBe('air')
  })

  it('refuses level: "auto": it only suggests, through preview_flatten', async () => {
    const h = await start()

    const result = await h.call('flatten_area', { width: 3, length: 3, level: 'auto' })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('ambiguous_level')

    const preview = await h.call('preview_flatten', { width: 3, length: 3, level: 'auto' })
    expect(preview.isError).toBe(false)
    expect(task(preview)).toMatchObject({ suggestion: { level: 63, hereLevel: 63 } })
  })
})
