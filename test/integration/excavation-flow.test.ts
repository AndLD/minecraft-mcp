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

/** Dirt from y = 40 up to the surface at y = 63, air above; the bot stands on the surface. */
async function start(setup: (bot: FakeBot) => void = () => undefined): Promise<Harness> {
  const bot = new FakeBot().useGameData()
  for (let x = -10; x <= 40; x += 1)
    for (let z = -40; z <= 30; z += 1) {
      for (let y = 40; y <= 63; y += 1) bot.setBlock({ x, y, z }, 'dirt')
      for (let y = 64; y <= 70; y += 1) bot.setBlock({ x, y, z }, 'air')
    }
  bot.entity = { position: at(10, 64, 5) }
  bot.physics = true
  bot.inventoryItems = [{ name: 'iron_pickaxe', count: 1 }]
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

/** An open two-block pocket underground, and the bot in it. */
function pocket(bot: FakeBot, x: number, y: number, z: number): void {
  bot.setBlock(at(x, y, z), 'air')
  bot.setBlock(at(x, y + 1, z), 'air')
  bot.entity = { position: at(x + 0.5, y, z + 0.5) }
}

/** Torches only go where it is dark: mark the cells of a tunnel area as dark. */
function darkness(
  bot: FakeBot,
  from: [number, number, number],
  to: [number, number, number],
): void {
  for (let x = from[0]; x <= to[0]; x += 1)
    for (let y = from[1]; y <= to[1]; y += 1)
      for (let z = from[2]; z <= to[2]; z += 1) bot.setLight(at(x, y, z), 0)
}

describe('excavating through the MCP server', () => {
  it('lists the shapes', async () => {
    const h = await start()

    const listed = await h.call('list_excavations')

    const names = (listed.data as { shapes: { name: string }[] }).shapes.map((s) => s.name)
    expect(names).toEqual([
      'branch_mine',
      'dig_to',
      'pit',
      'quarry',
      'room',
      'shaft',
      'staircase_down',
      'tunnel',
    ])
  })

  it('previews a pit: the dimensions understood, the blocks, what is missing, and changes nothing', async () => {
    const h = await start()

    const preview = await h.call('preview_excavation', {
      shape: 'pit',
      params: { width: 3, length: 3, depth: 4 },
    })

    expect(preview.data).toMatchObject({
      shape: 'pit 3x3x4',
      interpreted: { width: 3, length: 3, depth: 4, exit: 'ladder' },
      origin: { x: 12, y: 63, z: 5 },
      defaultOrigin: true,
      blocks: 36,
      missing: [{ name: 'ladder', count: 4 }],
    })
    expect(h.bot.dug).toEqual([])
  })

  it('digs a 3x3x2 pit next to the bot with a ladder up the wall', async () => {
    const h = await start((bot) => {
      bot.inventoryItems = [
        { name: 'iron_pickaxe', count: 1 },
        { name: 'ladder', count: 4 },
      ]
    })

    const result = await call(h, 'excavate', {
      shape: 'pit',
      params: { width: 3, length: 3, depth: 2 },
      wait_seconds: 55,
    })

    expect(task(result)).toMatchObject({
      status: 'succeeded',
      result: { shape: 'pit 3x3x2', broken: 18 },
    })
    expect(nameAt(h, 13, 63, 6)).toBe('air') // middle of the top layer
    expect(nameAt(h, 13, 62, 6)).toBe('air') // and of the second
    expect(nameAt(h, 13, 61, 6)).toBe('dirt') // the floor
    expect(nameAt(h, 12, 63, 6)).toBe('ladder') // the west wall column, in the middle row
    expect(nameAt(h, 12, 62, 6)).toBe('ladder')
    expect(h.bot.count('ladder')).toBe(2)
  })

  it("digs a wider, taller exit staircase without touching the pit's own reported size", async () => {
    const h = await start()

    const result = await call(h, 'excavate', {
      shape: 'pit',
      params: { width: 3, length: 3, depth: 1, exit: 'stairs', stair_width: 3, stair_height: 4 },
      wait_seconds: 55,
    })

    // The pit's own name and size are unaffected by the stair size: still "pit 3x3x1".
    expect(task(result)).toMatchObject({ status: 'succeeded', result: { shape: 'pit 3x3x1' } })
    // The ring sits stair_width (3) cells out from the footprint (origin at x=12, z=5): west=9, north=2.
    // Step 0 is a 3-cell-deep, 4-cell-tall band at x=9, z=2..4, y=63..66.
    for (const z of [2, 3, 4])
      for (const y of [63, 64, 65, 66]) expect(nameAt(h, 9, y, z)).toBe('air')
    // One cell further outward (z=1, one before the ring's own edge) stays solid rock: exactly stair_width deep.
    expect(nameAt(h, 9, 63, 1)).toBe('dirt')
  })

  it('digs a tunnel with torches and stops one block before lava, saying where', async () => {
    const h = await start((bot) => {
      pocket(bot, 10, 50, 5)
      bot.setBlock(at(10, 50, -3), 'lava')
      darkness(bot, [8, 49, -15], [12, 53, 6])
      bot.inventoryItems = [
        { name: 'iron_pickaxe', count: 1 },
        { name: 'torch', count: 4 },
      ]
    })

    const result = await call(h, 'excavate', {
      shape: 'tunnel',
      params: { direction: 'north', length: 14 },
      wait_seconds: 55,
    })

    const value = task(result).result as {
      ended: { branch: string; reason: string; at: unknown }[]
      broken: number
    }
    expect(task(result).status).toBe('succeeded')
    expect(value.ended).toMatchObject([{ branch: 'main', reason: 'hit_lava', at: at(10, 50, -3) }])
    // z runs north from 5: the lava is at -3, so the last cell dug is z = -1 (the one at -2 touches the lava).
    expect(nameAt(h, 10, 50, -1)).toBe('air')
    expect(nameAt(h, 10, 50, -2)).toBe('dirt')
    expect(nameAt(h, 10, 50, -3)).toBe('lava')
    expect(nameAt(h, 10, 50, 0)).toBe('torch') // the first torch, after 6 blocks (z = 5 - 5)
  })

  it('digs a branch mine: side branches every three blocks, and keeps two blocks of rock between them', async () => {
    const h = await start((bot) => {
      pocket(bot, 10, 50, 5)
      darkness(bot, [0, 49, -10], [20, 53, 6])
      bot.inventoryItems = [
        { name: 'iron_pickaxe', count: 1 },
        { name: 'torch', count: 20 },
      ]
    })

    const result = await call(h, 'excavate', {
      shape: 'branch_mine',
      params: { direction: 'north', length: 7, branch_length: 3 },
      wait_seconds: 55,
    })

    expect(task(result)).toMatchObject({ status: 'succeeded', result: { ended: [] } })
    // Heading north from z = 5: junctions at z = 2 and z = -1 (3 and 6 blocks on).
    expect(nameAt(h, 12, 50, 2)).toBe('air') // the right (east) branch, second cell
    expect(nameAt(h, 8, 50, 2)).toBe('air') // the left branch
    expect(nameAt(h, 12, 50, 1)).toBe('dirt') // rock between the branches
    expect(nameAt(h, 12, 50, 0)).toBe('dirt')
    expect(nameAt(h, 12, 50, -1)).toBe('air') // the next branch
  })

  it('a hazard in one branch ends only that branch', async () => {
    const h = await start((bot) => {
      pocket(bot, 10, 50, 5)
      bot.setBlock(at(13, 50, 2), 'water') // in the east branch of the first junction
      darkness(bot, [0, 49, -10], [20, 53, 6])
      bot.inventoryItems = [
        { name: 'iron_pickaxe', count: 1 },
        { name: 'torch', count: 20 },
      ]
    })

    const result = await call(h, 'excavate', {
      shape: 'branch_mine',
      params: { direction: 'north', length: 5, branch_length: 4 },
      wait_seconds: 55,
    })

    const ended = (task(result).result as { ended: { branch: string; reason: string }[] }).ended
    expect(ended.map((e) => `${e.branch}:${e.reason}`)).toEqual(['right-3:hit_water'])
    expect(nameAt(h, 13, 50, 2)).toBe('water') // untouched
    expect(nameAt(h, 7, 50, 2)).toBe('air') // the left branch went on to its full length
  })

  it('digs a quarry down to a level, with a ladder all the way', async () => {
    const h = await start((bot) => {
      bot.inventoryItems = [
        { name: 'iron_pickaxe', count: 1 },
        { name: 'ladder', count: 10 },
      ]
    })

    const result = await call(h, 'excavate', {
      shape: 'quarry',
      params: { width: 3, length: 3, to_y: 60 },
      wait_seconds: 55,
    })

    expect(task(result)).toMatchObject({
      status: 'succeeded',
      result: { shape: 'quarry 3x3 to y=60', broken: 36 },
    })
    for (const y of [63, 62, 61, 60]) {
      expect(nameAt(h, 13, y, 6)).toBe('air')
      expect(nameAt(h, 12, y, 6)).toBe('ladder')
    }
    expect(nameAt(h, 13, 59, 6)).toBe('dirt')
  })

  it('seals a cave beside a quarry column and still reaches the target depth', async () => {
    const h = await start((bot) => {
      bot.inventoryItems = [
        { name: 'iron_pickaxe', count: 1 },
        { name: 'ladder', count: 10 },
        { name: 'cobblestone', count: 5 },
      ]
      // A cave one block east of the column at (14, *, 7), outside the footprint and clear of the west-wall
      // ladder (at x = 12).
      bot.setBlock(at(15, 62, 7), 'air')
    })

    const result = await call(h, 'excavate', {
      shape: 'quarry',
      params: { width: 3, length: 3, to_y: 61 },
      wait_seconds: 55,
    })

    expect(task(result)).toMatchObject({ status: 'succeeded', result: { ended: [] } })
    // The column reached its target depth, right past the cave.
    expect(nameAt(h, 14, 61, 7)).toBe('air')
    // The cave itself is sealed (cobblestone was carried), not left open into the quarry.
    expect(nameAt(h, 15, 62, 7)).toBe('cobblestone')
  })

  it('digs a staircase down', async () => {
    const h = await start((bot) => {
      bot.inventoryItems = [
        { name: 'iron_pickaxe', count: 1 },
        { name: 'torch', count: 4 },
      ]
      darkness(bot, [8, 55, 3], [30, 66, 7])
    })

    const result = await call(h, 'excavate', {
      shape: 'staircase_down',
      params: { direction: 'east', depth: 6 },
      wait_seconds: 55,
    })

    expect(task(result)).toMatchObject({ status: 'succeeded' })
    expect(nameAt(h, 13, 61, 5)).toBe('air') // the fourth step: 3 blocks east, 3 down
    expect(nameAt(h, 13, 60, 5)).toBe('dirt') // its floor
    expect(nameAt(h, 15, 59, 5)).toBe('torch') // the last step, with the torch the spacing calls for
  })

  it('digs a staircase to a target level, fully walkable across a wider corridor', async () => {
    const h = await start((bot) => {
      bot.inventoryItems = [{ name: 'iron_pickaxe', count: 1 }]
    })

    const result = await call(h, 'excavate', {
      shape: 'staircase_down',
      params: { direction: 'east', to_y: 55, stair_width: 3, torch_spacing: 0 },
      wait_seconds: 55,
    })

    expect(task(result)).toMatchObject({ status: 'succeeded' })
    // Origin y = 64 (the bot's own cell): 10 steps reach y = 55, the last one 9 blocks east, 9 down.
    for (const z of [5, 6, 7]) {
      expect(nameAt(h, 19, 55, z)).toBe('air')
      expect(nameAt(h, 19, 54, z)).toBe('dirt') // its floor, untouched
    }
  })

  it('refuses a dig that would reach into a protected area', async () => {
    const h = await start()
    await h.call('protect_area', { label: 'house', x1: 10, y1: 50, z1: 0, x2: 20, y2: 70, z2: 10 })

    const result = await call(h, 'excavate', {
      shape: 'pit',
      params: { width: 2, length: 2, depth: 1 },
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('protected_area')
  })

  /** A solid stone hill at z = 10..14, x = 18..22, y = 64..67, standing on the default dirt ground. */
  function hill(bot: FakeBot): void {
    for (let x = 18; x <= 22; x += 1)
      for (let y = 64; y <= 67; y += 1)
        for (let z = 10; z <= 14; z += 1) bot.setBlock(at(x, y, z), 'stone')
    bot.players['Andrey_Knight'] = {
      username: 'Andrey_Knight',
      entity: {
        id: 900,
        type: 'player',
        name: 'Andrey_Knight',
        position: at(20.5, 64, 8.5),
        yaw: 0,
        pitch: 0,
      },
    }
    bot.entity = { position: at(20.5, 64, 8.5) }
    // Looking south into the hill's north face (hit block at x=20, z=10): the room digs south.
    bot.rayHit = { name: 'stone', position: at(20, 65, 10), face: 2 }
  }

  it("digs a room into the wall the player looks at, with an entrance, torches, and a door", async () => {
    const h = await start((bot) => {
      hill(bot)
      darkness(bot, [17, 63, 9], [23, 68, 15])
      bot.inventoryItems = [
        { name: 'iron_pickaxe', count: 1 },
        { name: 'torch', count: 4 },
        { name: 'oak_door', count: 1 },
      ]
    })

    const result = await call(h, 'excavate', {
      shape: 'room',
      params: { width: 3, length: 3, height: 3, door: 'oak_door' },
      wait_seconds: 55,
    })

    expect(task(result)).toMatchObject({ status: 'succeeded', result: { shape: 'room 3x3x3' } })
    // The entrance: one cell wide, two high, dug into the hill's own column (x = 20, z = 10).
    expect(nameAt(h, 20, 64, 10)).toBe('oak_door') // the door, in the entrance floor
    expect(nameAt(h, 20, 65, 10)).toBe('air')
    // The room behind it: x = 19..21, z = 11..13, y = 64..66 (open, except the torches on the floor).
    const torchCells = new Set(['21,64,11', '19,64,11'])
    for (const x of [19, 20, 21])
      for (const z of [11, 12, 13])
        for (const y of [64, 65, 66]) {
          const key = `${String(x)},${String(y)},${String(z)}`
          expect(nameAt(h, x, y, z)).toBe(torchCells.has(key) ? 'torch' : 'air')
        }
    // Outside the room, the hill stays solid.
    expect(nameAt(h, 18, 65, 12)).toBe('stone')
    expect(nameAt(h, 22, 65, 12)).toBe('stone')
    expect(nameAt(h, 20, 67, 12)).toBe('stone')
    // Torches along the side walls, on the floor.
    expect(nameAt(h, 21, 64, 11)).toBe('torch')
    expect(nameAt(h, 19, 64, 11)).toBe('torch')
  })

  it('previews a room from the wall the player looks at, without digging', async () => {
    const h = await start((bot) => {
      hill(bot)
    })

    const preview = await h.call('preview_excavation', {
      shape: 'room',
      params: { width: 3, length: 3, height: 3 },
    })

    expect(preview.data).toMatchObject({
      shape: 'room 3x3x3',
      origin: { x: 20, y: 64, z: 10 },
      interpreted: { direction: 'south', width: 3, length: 3, height: 3 },
    })
    expect(h.bot.dug).toEqual([])
  })

  it('refuses a room when the player looks at the floor, not a wall', async () => {
    const h = await start((bot) => {
      hill(bot)
      bot.rayHit = { name: 'stone', position: at(20, 63, 9), face: 1 } // top
    })

    const result = await call(h, 'excavate', { shape: 'room', params: { width: 3, length: 3 } })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('not a wall')
  })

  it('reports unknown shapes and wrong numbers in words', async () => {
    const h = await start()

    const unknown = await call(h, 'excavate', { shape: 'moat' })
    const wrong = await call(h, 'excavate', {
      shape: 'tunnel',
      params: { direction: 'up', length: 5 },
    })

    expect(unknown.text).toContain('unknown_shape')
    expect(unknown.text).toContain('quarry')
    expect(wrong.text).toContain('invalid_params')
    expect(wrong.text).toContain('direction')
  })
  describe('reliability of a dig', () => {
    it('digs a quarry over a cave and around a placed chest: nothing stray inside, and the result says it was checked', async () => {
      const h = await start((bot) => {
        bot.inventoryItems = [
          { name: 'iron_pickaxe', count: 1 },
          { name: 'cobblestone', count: 60 },
        ]
        // The bottom layer of the footprint (y 61) and a ring around it are one open cave.
        for (let x = 10; x <= 16; x += 1)
          for (let z = 3; z <= 9; z += 1) bot.setBlock(at(x, 61, z), 'air')
        // A chest a player put in the middle of the second layer.
        bot.setBlock(at(13, 62, 6), 'chest')
      })

      const result = await call(h, 'excavate', {
        shape: 'quarry',
        params: { width: 3, length: 3, to_y: 61, exit: 'none' },
        origin: at(12, 63, 5),
        wait_seconds: 55,
      })

      expect(task(result)).toMatchObject({
        status: 'succeeded',
        result: { shapeCheck: { kept: 0 }, ended: [{ reason: 'player_block' }] },
      })
      expect(nameAt(h, 13, 62, 6)).toBe('chest')
      const stray: string[] = []
      for (let x = 12; x <= 14; x += 1)
        for (let y = 61; y <= 63; y += 1)
          for (let z = 5; z <= 7; z += 1)
            if (!(x === 13 && y === 62 && z === 6) && nameAt(h, x, y, z) !== 'air')
              stray.push(`${String(x)},${String(y)},${String(z)}:${String(nameAt(h, x, y, z))}`)
      expect(stray).toEqual([])
      // The cave beside the volume is closed.
      expect(nameAt(h, 11, 61, 6)).toBe('cobblestone')
    })

    it('stops under gravel by default and names the cells, and digs through it with falling_blocks: clear', async () => {
      const gravel = (bot: FakeBot) => {
        pocket(bot, 10, 50, 5)
        for (const y of [52, 53]) bot.setBlock(at(10, y, 1), 'gravel')
      }
      const params = { direction: 'north', length: 8, torch_spacing: 0 }
      const stopped = await start(gravel)

      const first = await call(stopped, 'excavate', { shape: 'tunnel', params, wait_seconds: 55 })

      expect(task(first)).toMatchObject({
        status: 'succeeded',
        result: {
          ended: [{ reason: 'falling_blocks', cells: [at(10, 52, 1), at(10, 53, 1)] }],
        },
      })
      await stopped.close()

      const cleared = await start(gravel)
      const second = await call(cleared, 'excavate', {
        shape: 'tunnel',
        params,
        falling_blocks: 'clear',
        wait_seconds: 55,
      })

      expect(task(second)).toMatchObject({ status: 'succeeded', result: { ended: [] } })
      // The column is gone; the cell right above the tunnel is closed again (an opening over a sealed dig).
      expect(nameAt(cleared, 10, 53, 1)).toBe('air')
      expect(nameAt(cleared, 10, 52, 1)).not.toBe('gravel')
      expect(nameAt(cleared, 10, 50, -2)).toBe('air')
    })

    it('digs a route to an ore with dig_to and breaks the ore', async () => {
      const h = await start((bot) => {
        pocket(bot, 10, 50, 5)
        bot.setBlock(at(18, 52, 5), 'iron_ore')
      })

      const result = await call(h, 'excavate', {
        shape: 'dig_to',
        params: { target: at(18, 52, 5), torch_spacing: 0 },
        origin: at(10, 50, 5),
        wait_seconds: 55,
      })

      expect(task(result)).toMatchObject({ status: 'succeeded', result: { ended: [] } })
      expect(nameAt(h, 18, 52, 5)).toBe('air')
      expect(nameAt(h, 17, 52, 5)).toBe('air') // the cell it was dug from
    })
  })
})
