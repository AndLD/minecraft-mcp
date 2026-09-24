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

interface SignText {
  front: string[]
  back: string[]
  waxed: boolean
}

describe('signs on a real Minecraft server', () => {
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

  const bot = (): string => session.bot.username
  const owner = (): string => session.player.username

  async function untilBotCarries(item: string): Promise<void> {
    await waitUntil(
      async () => {
        const inventory = await session.bot.call('get_inventory')
        const items = inventory.isError
          ? []
          : (inventory.data as { items: { name: string }[] }).items
        return items.some((stack) => stack.name === item) ? true : undefined
      },
      { description: `the bot to carry ${item}` },
    )
  }

  async function untilBotSees(names: string[], count: number): Promise<void> {
    await waitUntil(
      async () => {
        const found = await session.bot.call('find_blocks', { names, count: 8 })
        return !found.isError && (found.data as { blocks: unknown[] }).blocks.length >= count
          ? true
          : undefined
      },
      { description: `the bot to see ${names.join(', ')}` },
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

  /**
   * The lines of both sides and whether the sign is waxed, from the block data the server keeps. Whole-block replies
   * are cut short by the server, so each part is asked for by its path.
   */
  async function signAt(position: Position): Promise<SignText> {
    const where = `${String(position.x)} ${String(position.y)} ${String(position.z)}`
    const linesOf = async (side: 'front_text' | 'back_text'): Promise<string[]> => {
      const raw = await world.command(`data get block ${where} ${side}.messages`, true)
      const lines: string[] = []
      // Each message is a JSON text in single or double quotes, for example '"Iron"' or '{"text":"Iron"}'.
      for (const match of raw
        .slice(raw.indexOf('['))
        .matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)) {
        const source = (match[1] ?? match[2] ?? '').replace(/\\(["'\\])/g, '$1')
        let text = source
        try {
          const parsed: unknown = JSON.parse(source)
          text = typeof parsed === 'string' ? parsed : textOf(parsed)
        } catch {
          // Not JSON: keep it as it is.
        }
        lines.push(text)
      }
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      return lines
    }
    const waxed = await world.command(`data get block ${where} is_waxed`, true)
    return {
      front: await linesOf('front_text'),
      back: await linesOf('back_text'),
      waxed: /\b1b\b/.test(waxed),
    }
  }

  const textOf = (parsed: unknown): string => {
    const text = (parsed as { text?: unknown } | null)?.text
    return typeof text === 'string' ? text : ''
  }

  /** A sign a "player" made: put down over RCON (`setblock` does nothing when the block is already a sign). */
  async function playerSign(position: Position, text: string): Promise<void> {
    await world.setBlock(
      position,
      `minecraft:oak_wall_sign[facing=south]{front_text:{messages:['"${text}"','""','""','""']}}`,
    )
    await untilBotSeesAt(position, 'oak_wall_sign')
  }

  /** Waxes it, as a player does with honeycomb. */
  async function wax(position: Position): Promise<void> {
    await world.command(
      `data merge block ${String(position.x)} ${String(position.y)} ${String(position.z)} {is_waxed:1b}`,
    )
    await waitUntil(async () => ((await signAt(position)).waxed ? true : undefined), {
      description: 'the sign to be waxed',
    })
  }

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

  it('puts a wall sign on the chest the owner looks at, and reads it back (exit criterion)', async () => {
    await world.give(bot(), 'oak_sign', 2)
    await untilBotCarries('oak_sign')
    await world.setBlock(at(-1, 4), 'chest')
    await untilBotSees(['chest'], 1)
    // Two blocks south of the chest, looking north (yaw 180) and slightly down at it.
    await world.face(owner(), at(-1, 6), 180, 20)
    await pause(1500)

    const placed = await waitUntil(
      async () => {
        const result = await run('place_sign', { text: 'Iron' })
        return result.failed && result.text.includes('not looking') ? undefined : result
      },
      { description: 'the bot to see where the owner looks' },
    )

    if (placed.failed) throw new Error(placed.text)
    const sign = placed.task.result as { position: Position; kind: string }
    expect(sign.kind).toBe('wall')
    expect(sign.position).toEqual(at(-1, 5))
    expect(await world.isBlock(sign.position, 'oak_wall_sign[facing=south]')).toBe(true)
    expect((await signAt(sign.position)).front).toEqual(['Iron'])
    expect(await world.countItem(bot(), 'oak_sign')).toBe(1)
  })

  it('puts a standing sign on the ground, turned towards the owner', async () => {
    await world.give(bot(), 'oak_sign', 1)
    await untilBotCarries('oak_sign')
    await world.teleport(owner(), { x: -8.5, y: GROUND_Y, z: 10.5 })
    await pause(1000)

    const placed = await run('place_sign', {
      at: { x: -9, y: GROUND_Y - 1, z: 2 },
      face: 'top',
      lines: ['Farm', 'to the north'],
    })

    if (placed.failed) throw new Error(placed.text)
    const cell = (placed.task.result as { position: Position }).position
    expect(cell).toEqual(at(-9, 2))
    // The owner is due south of the sign, so its text faces south: rotation 0.
    expect(await world.isBlock(cell, 'oak_sign[rotation=0]')).toBe(true)
    expect((await signAt(cell)).front).toEqual(['Farm', 'to the north'])
  })

  it('hangs a sign beside a labelled chest with the label as its text', async () => {
    await world.give(bot(), 'oak_sign', 1)
    await untilBotCarries('oak_sign')
    await world.setBlock(at(6, -6), 'chest')
    await untilBotSees(['chest'], 1)
    const registered = await session.bot.call('register_container', {
      x: 6,
      y: GROUND_Y,
      z: -6,
      label: 'Ores',
    })
    expect(registered.isError).toBe(false)

    const placed = await run('place_sign', { beside: 'Ores' })

    if (placed.failed) throw new Error(placed.text)
    const cell = (placed.task.result as { position: Position }).position
    expect(Math.abs(cell.x - 6) + Math.abs(cell.z - -6)).toBe(1)
    expect((await signAt(cell)).front).toEqual(['Ores'])
  })

  it('refuses text that is too long, a taken cell, and a protected area', async () => {
    await world.give(bot(), 'oak_sign', 3)
    await untilBotCarries('oak_sign')
    await world.fill(at(8, 0), at(8, 0, GROUND_Y + 2), 'stone')
    await world.fill(at(-8, 0), at(-8, 0, GROUND_Y + 2), 'stone')
    await untilBotSeesAt(at(8, 0), 'stone')
    await untilBotSeesAt(at(-8, 0), 'stone')

    const long = await session.bot.call('place_sign', {
      at: at(8, 0),
      face: 'south',
      text: 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo',
    })
    expect(long.isError).toBe(true)
    expect(long.text).toContain('text_too_long')

    await world.setBlock(at(-8, 1), 'oak_planks')
    await untilBotSeesAt(at(-8, 1), 'oak_planks')
    const taken = await run('place_sign', { at: at(-8, 0), face: 'south', text: 'No' })
    expect(taken.failed).toBe(true)
    expect(taken.text).toContain('blocked')

    const guard = await session.bot.call('protect_area', {
      x1: 5,
      y1: GROUND_Y - 2,
      z1: -3,
      x2: 11,
      y2: GROUND_Y + 5,
      z2: 5,
      label: 'house',
    })
    expect(guard.isError).toBe(false)
    const guarded = await run('place_sign', { at: at(8, 0), face: 'south', text: 'No' })
    expect(guarded.failed).toBe(true)
    expect(guarded.text).toContain('protected_area')
    expect(await world.isBlock(at(8, 1), 'oak_wall_sign')).toBe(false)
    expect(await world.countItem(bot(), 'oak_sign')).toBe(3)
  })

  describe('with a sign a player put up', () => {
    const SIGN = at(-6, 6)

    beforeEach(async () => {
      await world.fill(at(-6, 5), at(-6, 5, GROUND_Y + 1), 'stone')
      await untilBotSeesAt(at(-6, 5), 'stone')
      await playerSign(SIGN, 'Old')
    })

    it('changes its text, and reads the new text back', async () => {
      const edited = await run('edit_sign', { at: SIGN, text: 'Ores' })

      if (edited.failed) throw new Error(edited.text)
      expect(edited.task.result).toMatchObject({ lines: ['Ores', '', '', ''] })
      expect((await signAt(SIGN)).front).toEqual(['Ores'])
    })

    it('takes that sign down and picks it up', async () => {
      await world.setBlock(at(-4, 6), 'stone')

      const removed = await run('remove_sign', { at: SIGN })

      if (removed.failed) throw new Error(removed.text)
      expect(removed.task.result).toMatchObject({ text: ['Old'], pickedUp: true })
      expect(await world.isBlock(SIGN, 'oak_wall_sign')).toBe(false)
      expect(await world.countItem(bot(), 'oak_sign')).toBe(1)
      expect(await world.isBlock(at(-4, 6), 'stone')).toBe(true)
    })

    it('refuses to edit a waxed sign, and still takes it down on request', async () => {
      await wax(SIGN)

      const edit = await run('edit_sign', { at: SIGN, text: 'Changed' })
      expect(edit.failed).toBe(true)
      expect(edit.text).toContain('waxed')
      expect((await signAt(SIGN)).front).toEqual(['Old'])

      const removed = await run('remove_sign', { at: SIGN })
      expect(removed.failed).toBe(false)
      expect(await world.isBlock(SIGN, 'oak_wall_sign')).toBe(false)
    })

    it('reads what the owner and the bot wrote', async () => {
      await world.give(bot(), 'oak_sign', 1)
      await untilBotCarries('oak_sign')
      await world.setBlock(at(6, 8), 'stone')
      await untilBotSeesAt(at(6, 8), 'stone')
      const placed = await run('place_sign', { at: at(6, 8), face: 'south', text: 'Bot sign' })
      if (placed.failed) throw new Error(placed.text)

      const read = dataOf<{
        count: number
        signs: { front: string[]; placedByBot: boolean }[]
      }>(await session.bot.call('read_signs', { radius: 30 }))

      expect(read.count).toBe(2)
      expect(read.signs.find((sign) => sign.front[0] === 'Old')).toMatchObject({
        placedByBot: false,
      })
      expect(read.signs.find((sign) => sign.front[0] === 'Bot sign')).toMatchObject({
        placedByBot: true,
      })
    })
  })
})
