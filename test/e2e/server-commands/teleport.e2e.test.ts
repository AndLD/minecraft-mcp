import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { dataOf } from '../support/app-under-test.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { startSession, type E2ESession } from '../support/session.js'
import { waitUntil } from '../support/wait.js'

const at = (x: number, z: number): Position => ({ x, y: GROUND_Y, z })
/** Far outside the arena, and out of the bot's view. */
const FAR = at(400.5, 400.5)

interface TaskView {
  status: string
  result: { from: Position; arrivedAt: Position; reply?: string } | null
}

describe('server commands and teleporting on a real Minecraft server', () => {
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
    await world.command(`deop ${session.bot.username}`, true)
    await session.close()
  })

  afterAll(async () => {
    await world.close()
  })

  const bot = (): string => session.bot.username

  const canTeleport = async (): Promise<boolean | null> =>
    dataOf<{ commands: { canTeleport: boolean | null } }>(await session.bot.call('get_status'))
      .commands.canTeleport

  const untilCanTeleport = (expected: boolean): Promise<true> =>
    waitUntil(async () => ((await canTeleport()) === expected ? true : undefined), {
      description: `the server to ${expected ? 'offer' : 'withdraw'} /tp to the bot`,
    })

  it('says it cannot teleport, and what to enable, when the bot is not an operator', async () => {
    await untilCanTeleport(false)
    await world.teleport(session.player.username, FAR)

    const result = await session.bot.call('teleport_to_player', { wait_seconds: 20 })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('no_permission')
    expect(result.text).toContain(`/op ${bot()}`)
    expect(result.text).toContain('Allow cheats')
    const here = await world.playerPosition(bot())
    expect(Math.hypot(here.x - FAR.x, here.z - FAR.z)).toBeGreaterThan(100) // it did not go anywhere
  })

  it('teleports to a player standing far away, and ends on solid ground next to them', async () => {
    await world.command(`op ${bot()}`)
    await untilCanTeleport(true)
    await world.teleport(session.player.username, FAR)

    const run = dataOf<TaskView>(await session.bot.call('teleport_to_player', { wait_seconds: 30 }))

    expect(run.status).toBe('succeeded')
    const here = await world.playerPosition(bot())
    expect(Math.hypot(here.x - FAR.x, here.z - FAR.z)).toBeLessThan(3)
    expect(here.y).toBeCloseTo(GROUND_Y, 0)
    expect(run.result?.arrivedAt.x).toBeCloseTo(here.x, 0)
  })

  it('teleports to coordinates', async () => {
    await world.command(`op ${bot()}`)
    await untilCanTeleport(true)

    const run = dataOf<TaskView>(
      await session.bot.call('teleport_to_position', {
        x: 300.5,
        y: GROUND_Y,
        z: -300.5,
        wait_seconds: 30,
      }),
    )

    expect(run.status).toBe('succeeded')
    const here = await world.playerPosition(bot())
    expect(here.x).toBeCloseTo(300.5, 0)
    expect(here.z).toBeCloseTo(-300.5, 0)
  })

  it('stops being able to teleport when the operator rights are taken away again', async () => {
    await world.command(`op ${bot()}`)
    await untilCanTeleport(true)

    await world.command(`deop ${bot()}`)

    await untilCanTeleport(false)
  })
})
