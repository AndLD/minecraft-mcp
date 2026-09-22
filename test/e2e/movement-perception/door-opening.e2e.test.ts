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

describe('opening doors on a real Minecraft server', () => {
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

  /** True when the door-like block at the position is open (a block-state property, matched via /execute if block). */
  async function isOpen(position: Position, block: string): Promise<boolean> {
    return world.isBlock(position, `${block}[open=true]`)
  }

  async function untilBotSees(names: string[], count: number): Promise<void> {
    await waitUntil(
      async () => {
        const result = await session.bot.call('find_blocks', { names })
        return !result.isError && (result.data as { count: number }).count >= count
          ? true
          : undefined
      },
      { description: `the bot to see ${String(count)} of ${names.join(', ')}` },
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

  /** A 3x3 sealed box, floor at GROUND_Y - 1, walls of oak_planks, one door in the south wall (z = z0). */
  async function house(x0: number, z0: number, doorBlock = 'oak_door'): Promise<Position> {
    await world.fill({ x: x0, y: GROUND_Y - 1, z: z0 }, { x: x0 + 2, y: GROUND_Y - 1, z: z0 + 2 }, 'stone')
    await world.fill({ x: x0, y: GROUND_Y, z: z0 }, { x: x0 + 2, y: GROUND_Y + 2, z: z0 + 2 }, 'air')
    await world.fill({ x: x0, y: GROUND_Y, z: z0 }, { x: x0 + 2, y: GROUND_Y + 2, z: z0 }, 'oak_planks')
    await world.fill(
      { x: x0, y: GROUND_Y, z: z0 + 2 },
      { x: x0 + 2, y: GROUND_Y + 2, z: z0 + 2 },
      'oak_planks',
    )
    await world.fill({ x: x0, y: GROUND_Y, z: z0 }, { x: x0, y: GROUND_Y + 2, z: z0 + 2 }, 'oak_planks')
    await world.fill(
      { x: x0 + 2, y: GROUND_Y, z: z0 },
      { x: x0 + 2, y: GROUND_Y + 2, z: z0 + 2 },
      'oak_planks',
    )
    await world.fill({ x: x0, y: GROUND_Y + 3, z: z0 }, { x: x0 + 2, y: GROUND_Y + 3, z: z0 + 2 }, 'oak_planks')
    const doorPos = { x: x0 + 1, y: GROUND_Y, z: z0 }
    await world.setBlock(doorPos, 'air')
    await world.setBlock({ ...doorPos, y: GROUND_Y + 1 }, 'air')
    await world.command(
      `setblock ${String(doorPos.x)} ${String(doorPos.y)} ${String(doorPos.z)} ${doorBlock}[facing=north,half=lower,open=false]`,
    )
    await world.command(
      `setblock ${String(doorPos.x)} ${String(doorPos.y + 1)} ${String(doorPos.z)} ${doorBlock}[facing=north,half=upper,open=false]`,
    )
    return doorPos
  }

  it('walks in and back out through a closed oak door, closing it behind each pass', async () => {
    const doorPos = await house(0, 0)
    await world.teleport(session.bot.username, { x: 1.5, y: GROUND_Y, z: -3.5 })
    await untilBotSees(['oak_door'], 2)

    const inside = { x: 1, y: GROUND_Y, z: 1 }
    await goto(inside)
    expect(await isOpen(doorPos, 'oak_door')).toBe(false) // closed again once inside

    const outside = { x: 1, y: GROUND_Y, z: -3 }
    await goto(outside)
    expect(await isOpen(doorPos, 'oak_door')).toBe(false) // closed again once outside
  })

  it('leaves the door open when close_doors is false', async () => {
    const doorPos = await house(10, 0)
    await world.teleport(session.bot.username, { x: 11.5, y: GROUND_Y, z: -3.5 })
    await untilBotSees(['oak_door'], 2)

    await goto({ x: 11, y: GROUND_Y, z: 1 }, { close_doors: false })

    expect(await isOpen(doorPos, 'oak_door')).toBe(true)
  })

  it('passes through a fence-gate pen and closes the gate again', async () => {
    // A square pen of fences with one oak_fence_gate on the south side.
    const x0 = 20
    const z0 = 0
    await world.fill({ x: x0, y: GROUND_Y - 1, z: z0 }, { x: x0 + 3, y: GROUND_Y - 1, z: z0 + 3 }, 'grass_block')
    await world.fill({ x: x0, y: GROUND_Y, z: z0 }, { x: x0 + 3, y: GROUND_Y + 2, z: z0 + 3 }, 'air')
    await world.fill({ x: x0, y: GROUND_Y, z: z0 }, { x: x0 + 3, y: GROUND_Y, z: z0 }, 'oak_fence')
    await world.fill({ x: x0, y: GROUND_Y, z: z0 + 3 }, { x: x0 + 3, y: GROUND_Y, z: z0 + 3 }, 'oak_fence')
    await world.fill({ x: x0, y: GROUND_Y, z: z0 }, { x: x0, y: GROUND_Y, z: z0 + 3 }, 'oak_fence')
    await world.fill({ x: x0 + 3, y: GROUND_Y, z: z0 }, { x: x0 + 3, y: GROUND_Y, z: z0 + 3 }, 'oak_fence')
    const gatePos = { x: x0 + 1, y: GROUND_Y, z: z0 }
    await world.command(
      `setblock ${String(gatePos.x)} ${String(gatePos.y)} ${String(gatePos.z)} oak_fence_gate[facing=north,open=false]`,
    )
    await world.teleport(session.bot.username, { x: gatePos.x + 0.5, y: GROUND_Y, z: z0 - 3.5 })
    await untilBotSees(['oak_fence_gate'], 1)

    await goto({ x: gatePos.x, y: GROUND_Y, z: z0 + 1 })

    expect(await isOpen(gatePos, 'oak_fence_gate')).toBe(false)
  })

  it('reports needs_switch for an iron door, without trying it', async () => {
    const doorPos = await house(0, 20, 'iron_door')
    await world.teleport(session.bot.username, { x: 1.5, y: GROUND_Y, z: 16.5 })
    await untilBotSees(['iron_door'], 2)

    const result = await session.bot.call('goto', {
      x: 1,
      y: GROUND_Y,
      z: 21,
      within: 1,
      wait_seconds: 40,
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('needs_switch')
    expect(await isOpen(doorPos, 'iron_door')).toBe(false) // never touched
  })
})
