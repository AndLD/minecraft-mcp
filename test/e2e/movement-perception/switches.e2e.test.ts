import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { dataOf } from '../support/app-under-test.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { startSession, type E2ESession } from '../support/session.js'
import { waitUntil } from '../support/wait.js'

interface TaskView {
  status: string
  result: unknown
}

describe('iron doors and switches on a real Minecraft server', () => {
  let info: ServerInfo
  let world: E2EWorld
  let session: E2ESession

  beforeAll(async () => {
    info = readServerInfo()
    world = await E2EWorld.connect(info)
    await world.setGameRule('doDaylightCycle', false)
    await world.setGameRule('doMobSpawning', false)
    await world.setTime('day')
  })

  beforeEach(async () => {
    session = await startSession(world, info)
  })

  afterEach(async () => {
    await session.close()
  })

  afterAll(async () => {
    await world.close()
  })

  async function isOpen(position: Position): Promise<boolean> {
    return world.isBlock(position, 'iron_door[open=true]')
  }

  async function isPowered(position: Position, block: string): Promise<boolean> {
    return world.isBlock(position, `${block}[powered=true]`)
  }

  /**
   * Waits until the bot's own view has a block of this name at this exact position. Several houses are built
   * across this file's tests, 10 blocks apart, so a plain "sees N of this name" count (as movement-perception's
   * other e2e tests use) can be satisfied by an *earlier* test's still-visible structure within the default
   * 32-block search radius, racing ahead of the new one this test actually cares about.
   */
  async function untilBotSeesAt(name: string, position: Position): Promise<void> {
    await waitUntil(
      async () => {
        const result = await session.bot.call('find_blocks', { names: [name], max_distance: 24 })
        if (result.isError) return undefined
        const blocks = (result.data as { blocks: { position: Position }[] }).blocks
        const seen = blocks.some(
          (b) => b.position.x === position.x && b.position.y === position.y && b.position.z === position.z,
        )
        return seen ? true : undefined
      },
      { description: `the bot to see ${name} at ${String(position.x)}, ${String(position.y)}, ${String(position.z)}` },
    )
  }

  async function goto(target: Position, args: Record<string, unknown> = {}) {
    const result = dataOf<TaskView>(
      await session.bot.call('goto', {
        x: target.x,
        y: target.y,
        z: target.z,
        within: 1,
        wait_seconds: 40,
        ...args,
      }),
    )
    if (result.status !== 'succeeded') throw new Error(`goto did not succeed: ${JSON.stringify(result)}`)
    return result
  }

  /**
   * A 3x3 sealed box, floor at GROUND_Y - 1, stone walls, one closed iron door in the south wall (z = z0). A
   * floor-mounted switch (a lever or button, both real vanilla mechanics) placed directly south of the door,
   * just outside, powers the door's own base block: `switchAt`.
   */
  async function ironHouse(
    x0: number,
    z0: number,
    switchKind: string,
  ): Promise<{ doorAt: Position; switchAt: Position }> {
    await world.fill({ x: x0, y: GROUND_Y - 1, z: z0 }, { x: x0 + 2, y: GROUND_Y - 1, z: z0 + 2 }, 'stone')
    await world.fill({ x: x0, y: GROUND_Y, z: z0 }, { x: x0 + 2, y: GROUND_Y + 2, z: z0 + 2 }, 'air')
    await world.fill({ x: x0, y: GROUND_Y, z: z0 }, { x: x0 + 2, y: GROUND_Y + 2, z: z0 }, 'stone')
    await world.fill({ x: x0, y: GROUND_Y, z: z0 + 2 }, { x: x0 + 2, y: GROUND_Y + 2, z: z0 + 2 }, 'stone')
    await world.fill({ x: x0, y: GROUND_Y, z: z0 }, { x: x0, y: GROUND_Y + 2, z: z0 + 2 }, 'stone')
    await world.fill({ x: x0 + 2, y: GROUND_Y, z: z0 }, { x: x0 + 2, y: GROUND_Y + 2, z: z0 + 2 }, 'stone')
    const doorAt = { x: x0 + 1, y: GROUND_Y, z: z0 }
    await world.setBlock(doorAt, 'air')
    await world.setBlock({ ...doorAt, y: GROUND_Y + 1 }, 'air')
    await world.command(
      `setblock ${String(doorAt.x)} ${String(doorAt.y)} ${String(doorAt.z)} iron_door[facing=north,half=lower,open=false]`,
    )
    await world.command(
      `setblock ${String(doorAt.x)} ${String(doorAt.y + 1)} ${String(doorAt.z)} iron_door[facing=north,half=upper,open=false]`,
    )
    const switchAt = { x: x0 + 1, y: GROUND_Y, z: z0 - 1 }
    await world.command(
      `setblock ${String(switchAt.x)} ${String(switchAt.y)} ${String(switchAt.z)} ${switchKind}[face=floor,facing=north,powered=false]`,
    )
    return { doorAt, switchAt }
  }

  it('with the switch policy auto, presses a lever, walks through, and restores it', async () => {
    const { doorAt, switchAt } = await ironHouse(0, 0, 'lever')
    await world.teleport(session.bot.username, { x: 1.5, y: GROUND_Y, z: -3.5 })
    await untilBotSeesAt('iron_door', doorAt)
    await untilBotSeesAt('lever', switchAt)
    await session.bot.call('set_switch_policy', { policy: 'auto' })

    await goto({ x: 1, y: GROUND_Y, z: 1 })

    expect(await isOpen(doorAt)).toBe(false) // closed again once inside
    expect(await isPowered(switchAt, 'lever')).toBe(false) // the lever was put back
  })

  it('leaves the lever pressed and the door open when close_doors is false', async () => {
    const { doorAt, switchAt } = await ironHouse(10, 0, 'lever')
    await world.teleport(session.bot.username, { x: 11.5, y: GROUND_Y, z: -3.5 })
    await untilBotSeesAt('iron_door', doorAt)
    await untilBotSeesAt('lever', switchAt)
    await session.bot.call('set_switch_policy', { policy: 'auto' })

    await goto({ x: 11, y: GROUND_Y, z: 1 }, { close_doors: false })

    expect(await isOpen(doorAt)).toBe(true)
    expect(await isPowered(switchAt, 'lever')).toBe(true)
  })

  it('with a wooden button, walks through before it times out, with nothing left to restore', async () => {
    const { doorAt, switchAt } = await ironHouse(20, 0, 'oak_button')
    await world.teleport(session.bot.username, { x: 21.5, y: GROUND_Y, z: -3.5 })
    await untilBotSeesAt('iron_door', doorAt)
    await untilBotSeesAt('oak_button', switchAt)
    await session.bot.call('set_switch_policy', { policy: 'auto' })

    const result = await goto({ x: 21, y: GROUND_Y, z: 1 })

    expect(result.status).toBe('succeeded')
  })

  it('reports iron_door_blocked with the switch found, when the policy is ask', async () => {
    const { doorAt, switchAt } = await ironHouse(30, 0, 'lever')
    await world.teleport(session.bot.username, { x: 31.5, y: GROUND_Y, z: -3.5 })
    await untilBotSeesAt('iron_door', doorAt)
    await untilBotSeesAt('lever', switchAt)
    await session.bot.call('set_switch_policy', { policy: 'ask' })

    const result = await session.bot.call('goto', {
      x: 31,
      y: GROUND_Y,
      z: 1,
      within: 1,
      wait_seconds: 40,
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('iron_door_blocked')
    expect(result.text).toContain('lever')
    expect(await isPowered(switchAt, 'lever')).toBe(false) // never touched
  })

  it('press_switch presses a lever directly and reports the door beside it', async () => {
    const { doorAt, switchAt } = await ironHouse(40, 0, 'lever')
    await world.teleport(session.bot.username, { x: 41.5, y: GROUND_Y, z: -3.5 })
    await untilBotSeesAt('iron_door', doorAt)
    await untilBotSeesAt('lever', switchAt)

    const result = dataOf<TaskView>(
      await session.bot.call('press_switch', { at: switchAt, wait_seconds: 20 }),
    )

    expect(result.status).toBe('succeeded')
    expect(result.result).toMatchObject({ door: { position: doorAt, open: true } })
    expect(await isOpen(doorAt)).toBe(true)
  })

  it('open_door opens an iron door directly, ignoring the switch policy', async () => {
    const { doorAt, switchAt } = await ironHouse(50, 0, 'lever')
    await world.teleport(session.bot.username, { x: 51.5, y: GROUND_Y, z: -3.5 })
    await untilBotSeesAt('iron_door', doorAt)
    await untilBotSeesAt('lever', switchAt)
    await session.bot.call('set_switch_policy', { policy: 'never' })

    const result = dataOf<TaskView>(
      await session.bot.call('open_door', { at: doorAt, wait_seconds: 20 }),
    )

    expect(result.status).toBe('succeeded')
    expect(result.result).toMatchObject({ walkedThrough: true, restored: true })
    expect(await isOpen(doorAt)).toBe(false) // closed again: restore put the lever back
    expect(await isPowered(switchAt, 'lever')).toBe(false)
  })

  it('find_switches lists the switch around the door without touching it', async () => {
    const { doorAt, switchAt } = await ironHouse(60, 0, 'lever')
    await world.teleport(session.bot.username, { x: 61.5, y: GROUND_Y, z: -3.5 })
    await untilBotSeesAt('iron_door', doorAt)
    await untilBotSeesAt('lever', switchAt)

    const result = await session.bot.call('find_switches', { at: doorAt })

    expect(result.isError).toBe(false)
    expect(result.data).toMatchObject({ switches: [{ position: switchAt, kind: 'lever' }] })
    expect(await isPowered(switchAt, 'lever')).toBe(false) // read-only
  })
})
