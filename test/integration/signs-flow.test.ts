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
const GROUND = 63
const FLOOR = GROUND + 1
const TOP = 1
const SOUTH = 3

/** A flat dirt world with a stone wall at x = 12 and a chest; the bot stands at (10, 64, 10), the owner to the south. */
async function start(setup: (bot: FakeBot) => void = () => undefined): Promise<Harness> {
  const bot = new FakeBot().useGameData()
  for (let x = -10; x <= 40; x += 1)
    for (let z = -10; z <= 40; z += 1) {
      bot.setBlock(at(x, GROUND, z), 'dirt')
      for (let y = FLOOR; y <= FLOOR + 4; y += 1) bot.setBlock(at(x, y, z), 'air')
    }
  for (let y = FLOOR; y <= FLOOR + 2; y += 1) bot.setBlock(at(12, y, 10), 'stone')
  bot.setBlock(at(20, FLOOR, 10), 'chest')
  bot.entity = { position: at(10.5, FLOOR, 10.5) }
  bot.players['Andrey_Knight'] = {
    username: 'Andrey_Knight',
    entity: {
      id: 900,
      type: 'player',
      name: 'Andrey_Knight',
      position: at(12.5, FLOOR, 20.5),
      yaw: Math.PI,
      pitch: 0,
    },
  }
  bot.addItems('oak_sign', 2)
  setup(bot)
  const h = await createHarness({}, { bot })
  harness = h
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
const data = (result: { data: unknown }): Record<string, unknown> =>
  result.data as Record<string, unknown>
const nameAt = (h: Harness, position: { x: number; y: number; z: number }): string | undefined =>
  h.bot.blockAt(toVec3(position))?.name
const look = (
  h: Harness,
  name: string,
  position: { x: number; y: number; z: number },
  face: number,
) => {
  h.bot.rayHit = { name, position, face }
}
const carried = (h: Harness, item: string): number => h.bot.count(item)

describe('signs through the MCP server', () => {
  it('hangs a wall sign on the face the owner looks at and reads the text back', async () => {
    const h = await start()
    look(h, 'stone', at(12, FLOOR, 10), SOUTH)

    const result = await call(h, 'place_sign', { text: 'Iron', wait_seconds: 30 })

    expect(data(result)).toMatchObject({
      status: 'succeeded',
      result: { position: at(12, FLOOR, 11), kind: 'wall', item: 'oak_sign', facing: 'south' },
    })
    expect(nameAt(h, at(12, FLOOR, 11))).toBe('oak_wall_sign')
    expect(carried(h, 'oak_sign')).toBe(1)
    const read = data(await h.call('read_signs', { radius: 10 }))
    expect(read).toMatchObject({
      count: 1,
      signs: [{ position: at(12, FLOOR, 11), front: ['Iron'], placedByBot: true, waxed: false }],
    })
  })

  it('hangs a sign on the side of the chest the owner looks at, even when they look at its top', async () => {
    const h = await start()
    look(h, 'chest', at(20, FLOOR, 10), TOP)

    const result = await call(h, 'place_sign', { text: 'Iron', wait_seconds: 30 })

    expect(data(result)).toMatchObject({ status: 'succeeded', result: { kind: 'wall' } })
    const placed = (data(result)['result'] as { position: { x: number; y: number; z: number } })
      .position
    expect(placed.y).toBe(FLOOR)
    expect(Math.abs(placed.x - 20) + Math.abs(placed.z - 10)).toBe(1)
  })

  it('puts a standing sign on the ground, turned towards the owner', async () => {
    const h = await start()
    look(h, 'dirt', at(15, GROUND, 12), TOP)

    const result = await call(h, 'place_sign', { lines: ['Farm', 'north'], wait_seconds: 30 })

    expect(data(result)).toMatchObject({
      status: 'succeeded',
      result: { position: at(15, FLOOR, 12), kind: 'standing', facing: 'south' },
    })
    const read = data(await h.call('read_signs', {}))
    expect(read).toMatchObject({ signs: [{ kind: 'standing', front: ['Farm', 'north'] }] })
  })

  it('crafts a sign from planks and a stick when it carries none', async () => {
    const h = await start((bot) => {
      bot.removeItems('oak_sign', 2)
      bot.addItems('oak_planks', 10) // a crafting table (4) and the signs (6)
      bot.addItems('stick', 1)
    })
    look(h, 'stone', at(12, FLOOR, 10), SOUTH)

    const result = await call(h, 'place_sign', { text: 'Made', wait_seconds: 30 })

    expect(data(result)).toMatchObject({ status: 'succeeded' })
    expect(nameAt(h, at(12, FLOOR, 11))).toBe('oak_wall_sign')
    expect(carried(h, 'oak_sign')).toBe(2)
  })

  it('fails clearly when there is nothing to make a sign from', async () => {
    const h = await start((bot) => {
      bot.removeItems('oak_sign', 2)
    })
    look(h, 'stone', at(12, FLOOR, 10), SOUTH)

    const result = await call(h, 'place_sign', { text: 'None', wait_seconds: 30 })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('no_sign_item')
  })

  it('hangs a sign beside a labelled chest with the label as its text', async () => {
    const h = await start()
    await h.call('register_container', { x: 20, y: FLOOR, z: 10, label: 'Iron' })

    const result = await call(h, 'place_sign', { beside: 'Iron', wait_seconds: 30 })

    expect(data(result)).toMatchObject({ status: 'succeeded', result: { kind: 'wall' } })
    const read = data(await h.call('read_signs', { matching: 'iron' }))
    expect(read).toMatchObject({ count: 1, signs: [{ front: ['Iron'] }] })
    const placed = (read['signs'] as { position: { x: number; z: number } }[])[0]?.position
    expect(Math.abs((placed?.x ?? 0) - 20) + Math.abs((placed?.z ?? 0) - 10)).toBe(1)
  })

  it('refuses a protected area, a taken cell, and text that is too long', async () => {
    const h = await start()
    look(h, 'stone', at(12, FLOOR, 10), SOUTH)
    await h.call('protect_area', { label: 'house', x1: 5, y1: 60, z1: 5, x2: 15, y2: 70, z2: 15 })

    const guarded = await call(h, 'place_sign', { text: 'No', wait_seconds: 30 })
    expect(guarded.isError).toBe(true)
    expect(guarded.text).toContain('protected_area')

    await h.call('unprotect_area', { label: 'house' })
    h.bot.setBlock(at(12, FLOOR, 11), 'oak_planks')
    const taken = await call(h, 'place_sign', { text: 'No', wait_seconds: 30 })
    expect(taken.isError).toBe(true)
    expect(taken.text).toContain('blocked')

    const long = await h.call('place_sign', {
      text: 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo',
    })
    expect(long.isError).toBe(true)
    expect(long.text).toContain('text_too_long')
    expect(carried(h, 'oak_sign')).toBe(2)
  })

  describe('with a sign already up', () => {
    const SIGN = at(12, FLOOR, 11)

    it('changes the text of the sign the owner looks at', async () => {
      const h = await start((bot) => {
        bot.setSign(SIGN, { front: 'Iron' })
      })
      look(h, 'oak_wall_sign', SIGN, SOUTH)

      const result = await call(h, 'edit_sign', { text: 'Ores', wait_seconds: 30 })

      expect(data(result)).toMatchObject({
        status: 'succeeded',
        result: { position: SIGN, lines: ['Ores', '', '', ''], previous: ['Iron', '', '', ''] },
      })
      const read = data(await h.call('read_signs', {}))
      expect(read).toMatchObject({ signs: [{ front: ['Ores'] }] })
    })

    it('takes that sign down and picks it up, and no other', async () => {
      const h = await start((bot) => {
        bot.setSign(SIGN, { front: 'Iron' })
        bot.setSign(at(14, FLOOR, 11), { front: 'Farm' })
      })
      look(h, 'oak_wall_sign', SIGN, SOUTH)

      const result = await call(h, 'remove_sign', { wait_seconds: 30 })

      expect(data(result)).toMatchObject({
        status: 'succeeded',
        result: { position: SIGN, text: ['Iron'], pickedUp: true },
      })
      expect(nameAt(h, SIGN)).toBe('air')
      expect(nameAt(h, at(14, FLOOR, 11))).toBe('oak_wall_sign')
      expect(carried(h, 'oak_sign')).toBe(3)
    })

    it('refuses to edit a waxed sign but takes it down on request', async () => {
      const h = await start((bot) => {
        bot.setSign(SIGN, { front: 'Keep', waxed: true })
      })
      look(h, 'oak_wall_sign', SIGN, SOUTH)

      const edit = await call(h, 'edit_sign', { text: 'Change', wait_seconds: 30 })
      expect(edit.isError).toBe(true)
      expect(edit.text).toContain('waxed')
      expect(data(await h.call('read_signs', {}))).toMatchObject({ signs: [{ front: ['Keep'] }] })

      const removed = await call(h, 'remove_sign', { wait_seconds: 30 })
      expect(data(removed)).toMatchObject({ status: 'succeeded' })
      expect(nameAt(h, SIGN)).toBe('air')
    })

    it('never removes several: text that fits two signs is ambiguous and nothing changes', async () => {
      const h = await start((bot) => {
        bot.setSign(SIGN, { front: 'Iron' })
        bot.setSign(at(14, FLOOR, 11), { front: 'Iron mine' })
      })

      const result = await call(h, 'remove_sign', { matching: 'iron', wait_seconds: 30 })

      expect(result.isError).toBe(true)
      expect(result.text).toContain('ambiguous')
      expect(nameAt(h, SIGN)).toBe('oak_wall_sign')
      expect(nameAt(h, at(14, FLOOR, 11))).toBe('oak_wall_sign')
    })

    it('leaves signs in a protected area alone', async () => {
      const h = await start((bot) => {
        bot.setSign(SIGN, { front: 'Theirs' })
      })
      look(h, 'oak_wall_sign', SIGN, SOUTH)
      await h.call('protect_area', { label: 'house', x1: 5, y1: 60, z1: 5, x2: 15, y2: 70, z2: 15 })

      const result = await call(h, 'remove_sign', { wait_seconds: 30 })

      expect(result.isError).toBe(true)
      expect(result.text).toContain('protected_area')
      expect(nameAt(h, SIGN)).toBe('oak_wall_sign')
    })

    it('reads what the players wrote, both sides, and says which signs the bot put up', async () => {
      const h = await start((bot) => {
        bot.setSign(SIGN, { front: 'Home\nsweet home', back: 'Keep out' })
      })

      const read = data(await h.call('read_signs', {}))

      expect(read).toMatchObject({
        count: 1,
        signs: [
          {
            front: ['Home', 'sweet home'],
            back: ['Keep out'],
            placedByBot: false,
            wood: 'oak',
            kind: 'wall',
          },
        ],
      })
    })
  })

  it('a place_sign cancelled while the sign is being crafted leaves no sign behind', async () => {
    const h = await start((bot) => {
      bot.removeItems('oak_sign', 2)
      bot.addItems('oak_planks', 10)
      bot.addItems('stick', 1)
    })
    look(h, 'stone', at(12, FLOOR, 10), SOUTH)
    // The craft hangs until the test lets it go, so the cancel arrives in the middle of it.
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const realCraft = h.bot.craft.bind(h.bot)
    h.bot.craft = async (recipe, count, table) => {
      await gate
      return realCraft(recipe, count, table)
    }

    const started = await h.call('place_sign', { text: 'Never', wait_seconds: 0 })
    expect(data(started)).toMatchObject({ status: 'running' })
    await h.settle()
    const cancelling = h.call('cancel_task')
    release()
    await pumped(h, cancelling)

    expect(nameAt(h, at(12, FLOOR, 11))).toBe('air')
    expect(data(await h.call('get_task_status'))).toMatchObject({ task: { status: 'cancelled' } })
  })
  describe('a sign on top of a fence with a torch on it', () => {
    const onFence = (bot: FakeBot) => {
      for (const x of [14, 15, 16]) bot.setBlock(at(x, FLOOR, 8), 'oak_fence')
      bot.setBlock(at(15, FLOOR + 1, 8), 'torch')
    }

    it('names a free place and offers to swap the torch, without touching it', async () => {
      const h = await start(onFence)

      const result = await call(h, 'place_sign', {
        at: at(15, FLOOR, 8),
        face: 'top',
        text: 'Field',
        wait_seconds: 40,
      })

      expect(result.isError).toBe(true)
      expect(result.text).toContain('blocked')
      expect(result.text).toContain('Free instead')
      expect(result.text).toContain('replace_block: true')
      expect(nameAt(h, at(15, FLOOR + 1, 8))).toBe('torch')
    })

    it('swaps the torch for the sign with replace_block', async () => {
      const h = await start(onFence)

      const result = await call(h, 'place_sign', {
        at: at(15, FLOOR, 8),
        face: 'top',
        text: 'Field',
        replace_block: true,
        wait_seconds: 40,
      })

      expect(data(result)).toMatchObject({ status: 'succeeded' })
      expect(nameAt(h, at(15, FLOOR + 1, 8))).toBe('oak_sign')
    })
  })
})
