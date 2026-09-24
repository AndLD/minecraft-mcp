import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { dataOf } from '../support/app-under-test.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { startSession, type E2ESession } from '../support/session.js'
import { waitUntil } from '../support/wait.js'

/** The ground block itself (one below the walking layer). */
const floor = (x: number, z: number): Position => ({ x, y: GROUND_Y - 1, z })
/** The walking layer: where fences and crops stand. */
const walk = (x: number, z: number): Position => ({ x, y: GROUND_Y, z })

interface Proposal {
  kind: string
  confidence: string
  register: Record<string, unknown>
}

interface Discovery {
  proposals: Proposal[]
  alreadyRegistered: { id: string }[]
}

describe('discovering hand-built farms on a real Minecraft server', () => {
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

  const discover = async (args: Record<string, unknown> = {}): Promise<Discovery> =>
    dataOf<Discovery>(await session.bot.call('discover_farm', { radius: 30, ...args }))

  /** RCON changes reach the bot a moment later: ask again until the discovery matches what was built. */
  const untilDiscovered = (kinds: string[], args: Record<string, unknown> = {}): Promise<Discovery> =>
    waitUntil(
      async () => {
        const found = await discover(args)
        const seen = found.proposals.map((p) => p.kind).sort()
        return JSON.stringify(seen) === JSON.stringify([...kinds].sort()) ? found : undefined
      },
      { description: `discover_farm to propose ${kinds.join(' and ')}` },
    )

  async function buildFarm(): Promise<void> {
    // A wheat field (farmland, ripe wheat, a water channel down the middle) and a fenced pen with three cows.
    await world.fill(floor(2, -14), floor(8, -9), 'farmland')
    await world.fill(floor(5, -14), floor(5, -9), 'water')
    await world.fill(walk(2, -14), walk(4, -9), 'wheat[age=7]')
    await world.fill(walk(6, -14), walk(8, -9), 'wheat[age=7]')
    await world.fill(walk(10, -8), walk(16, -8), 'oak_fence')
    await world.fill(walk(10, -2), walk(16, -2), 'oak_fence')
    await world.fill(walk(10, -7), walk(10, -3), 'oak_fence')
    await world.fill(walk(16, -7), walk(16, -3), 'oak_fence')
    await world.setBlock(walk(13, -2), 'oak_fence_gate')
    for (const [x, z] of [[12, -6], [13, -5], [14, -6]] as const) await world.summon('cow', walk(x, z))
  }

  it('proposes the field and the pen with the crop and species, changing nothing, and registering them works', async () => {
    await buildFarm()

    const found = await untilDiscovered(['field', 'pen'], { group: 'home' })

    const field = found.proposals.find((p) => p.kind === 'field')
    const pen = found.proposals.find((p) => p.kind === 'pen')
    expect(field).toMatchObject({ confidence: 'high', register: { crop: 'wheat', group: 'home' } })
    expect(pen).toMatchObject({ confidence: 'high', register: { species: 'cow', herd_target: 3, group: 'home' } })
    expect(dataOf<{ count: number }>(await session.bot.call('list_farms')).count).toBe(0)
    expect(await world.isBlock(floor(2, -14), 'farmland')).toBe(true)

    for (const proposal of found.proposals) {
      const registered = await session.bot.call('register_farm', proposal.register)
      if (registered.isError) throw new Error(`register_farm failed: ${registered.text}`)
    }

    const after = await discover({ group: 'home' })
    expect(after.proposals).toEqual([])
    expect(after.alreadyRegistered).toHaveLength(2)
    const inspected = dataOf<{ components: { kind: string; ripe: number; adults: number }[] }>(
      await session.bot.call('inspect_farm', { farm: 'home' }),
    )
    expect(inspected.components.find((c) => c.kind === 'field')?.ripe).toBeGreaterThanOrEqual(30)
    expect(inspected.components.find((c) => c.kind === 'pen')?.adults).toBe(3)
  })

  it('finds nothing in an empty arena', async () => {
    const found = await discover()

    expect(found.proposals).toEqual([])
  })
})
