import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { dataOf } from '../support/app-under-test.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { startSession, type E2ESession } from '../support/session.js'
import { pause, waitUntil } from '../support/wait.js'

const cell = (x: number, dy: number, z: number): Position => ({ x, y: GROUND_Y + dy, z })

interface TaskView {
  status: string
  result: {
    found: { kind: string; name?: string; x: number; y: number; z: number; source: string }
    reached: boolean
    hops: number
    searched: string
    discovered: { kind: string }[]
    returned?: boolean
  } | null
}

describe('world discovery on a real Minecraft server', () => {
  let info: ServerInfo
  let world: E2EWorld
  let session: E2ESession
  let sessionOpen = false
  /** Blocks a test built outside the arena, cleared afterwards so the next test starts on bare ground. */
  const built: [Position, Position][] = []
  /** Biome areas a test painted, set back to plains afterwards. */
  const painted: [Position, Position][] = []

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
    if (sessionOpen) {
      sessionOpen = false
      await session.close()
    }
    for (const [from, to] of built.splice(0)) await world.fill(from, to, 'air')
    for (const [from, to] of painted.splice(0))
      await world.command(
        `fillbiome ${String(from.x)} ${String(from.y)} ${String(from.z)} ${String(to.x)} ${String(to.y)} ${String(to.z)} minecraft:plains`,
        true,
      )
  })

  afterAll(async () => {
    await world.close()
  })

  const put = async (position: Position, block: string): Promise<void> => {
    await world.setBlock(position, block)
    built.push([position, position])
  }

  /** Waits until the bot's own view shows the block (RCON changes arrive late). */
  const untilBotSees = (name: string): Promise<true> =>
    waitUntil(
      async () => {
        const seen = await session.bot.call('find_blocks', { names: [name], max_distance: 64 })
        return !seen.isError && (seen.data as { count: number }).count > 0 ? true : undefined
      },
      { description: `the bot to see ${name}` },
    )

  async function explore(args: Record<string, unknown>) {
    const first = await session.bot.call('explore_for_structure', { wait_seconds: 40, ...args })
    if (first.isError) return { failed: true as const, text: first.text, task: undefined }
    let task = first.data as TaskView
    if (task.status === 'running') {
      task = await waitUntil(
        async () => {
          const status = dataOf<{ task: TaskView }>(await session.bot.call('get_task_status')).task
          return status.status === 'running' ? undefined : status
        },
        { timeoutMs: 240_000, description: 'the search to finish' },
      )
    }
    return { failed: task.status !== 'succeeded', text: JSON.stringify(task), task }
  }

  it('finds a desert temple set 60 blocks away, and lists it afterwards', async () => {
    const temple = cell(55, 0, 0)
    await put(temple, 'chiseled_sandstone')
    await put(cell(56, 0, 0), 'tnt')
    await untilBotSees('chiseled_sandstone')

    const run = await explore({ kind: 'desert_temple', max_distance: 200, use_locate: false })

    if (run.failed) throw new Error(`The search did not succeed: ${run.text}`)
    expect(run.task.result?.found).toMatchObject({
      kind: 'desert_temple',
      x: 55,
      z: 0,
      source: 'scan',
    })
    const listed = dataOf<{ count: number; structures: { kind: string; x: number }[] }>(
      await session.bot.call('list_known_structures'),
    )
    expect(listed.structures).toMatchObject([{ kind: 'desert_temple', x: 55 }])
  }, 300_000)

  it('records other structures on the way, and saves them so a restart still lists them', async () => {
    const frame = cell(50, 0, -20)
    await put(frame, 'end_portal_frame')
    const bell = cell(-30, 0, 50)
    await put(bell, 'bell')
    await put(cell(-27, 0, 50), 'hay_block')
    await untilBotSees('bell')

    const run = await explore({ kind: 'village', max_distance: 200, use_locate: false })

    if (run.failed) throw new Error(`The search did not succeed: ${run.text}`)
    expect(run.task.result?.found).toMatchObject({ kind: 'village', x: -30, z: 50 })

    await session.bot.call('disconnect')
    const profile = readdirSync(session.bot.dataDir, { withFileTypes: true }).find((entry) =>
      entry.isDirectory(),
    )
    if (profile === undefined) throw new Error('No world profile was saved.')
    // The state is written after the disconnect event, a moment later: wait for the file instead of reading it at once.
    const kinds = await waitUntil(
      () => {
        try {
          const saved = JSON.parse(
            readFileSync(path.join(session.bot.dataDir, profile.name, 'knowledge.json'), 'utf8'),
          ) as { data: { structures: { kind: string }[] } }
          const found = saved.data.structures.map((entry) => entry.kind)
          return found.includes('village') ? found : undefined
        } catch {
          return undefined // not written yet
        }
      },
      { description: 'the village to be saved' },
    )
    expect(kinds).toContain('village')
  }, 300_000)

  it('walks back to a landmark when the search ends', async () => {
    const home = dataOf<{ landmark: Position }>(
      await session.bot.call('set_landmark', { name: 'home' }),
    ).landmark
    const bell = cell(40, 0, 30)
    await put(bell, 'bell')
    await put(cell(42, 0, 30), 'hay_block')
    await untilBotSees('bell')

    const run = await explore({
      kind: 'village',
      max_distance: 200,
      use_locate: false,
      return_to: 'home',
    })

    if (run.failed) throw new Error(`The search did not succeed: ${run.text}`)
    expect(run.task.result?.returned).toBe(true)
    const back = await waitUntil(
      async () => {
        const position = await world.playerPosition(session.bot.username)
        return Math.hypot(position.x - home.x, position.z - home.z) < 6 ? position : undefined
      },
      { description: 'the bot to be back at home' },
    )
    expect(back).toBeDefined()
  }, 300_000)

  it('fails with not_found, saying how far it looked, when nothing is in range', async () => {
    const run = await explore({
      kind: 'jungle_temple',
      max_distance: 60,
      max_minutes: 3,
      use_locate: false,
    })

    expect(run.failed).toBe(true)
    expect(run.text).toContain('not_found')
  }, 300_000)

  it('finds a desert biome painted 60 blocks away and stands in it', async () => {
    // Kept thin: the command refuses areas over 32768 blocks, and the bot samples at its own height.
    const from = cell(60, 0, -20)
    const to = cell(110, 8, 20)
    painted.push([from, to])
    await world.command(
      `fillbiome ${String(from.x)} ${String(from.y)} ${String(from.z)} ${String(to.x)} ${String(to.y)} ${String(to.z)} minecraft:desert`,
    )
    await pause(3_000) // the server resends the chunks; the bot reads the new biome from them

    const run = await explore({ biome: 'desert', max_distance: 200, use_locate: false })

    if (run.failed) throw new Error(`The search did not succeed: ${run.text}`)
    expect(run.task.result?.found).toMatchObject({ kind: 'biome', name: 'desert', source: 'scan' })
    expect(run.task.result?.found.x).toBeGreaterThanOrEqual(60)
    const listed = dataOf<{ biomes: { name: string }[] }>(
      await session.bot.call('list_known_structures'),
    )
    expect(listed.biomes).toMatchObject([{ name: 'desert' }])
  }, 300_000)

  it('finds a desert temple by walking to the desert, not by circling: a guided search takes few hops', async () => {
    const from = cell(90, -4, -25)
    const to = cell(150, 4, 25)
    painted.push([from, to])
    await world.command(
      `fillbiome ${String(from.x)} ${String(from.y)} ${String(from.z)} ${String(to.x)} ${String(to.y)} ${String(to.z)} minecraft:desert`,
    )
    await put(cell(125, 0, 0), 'chiseled_sandstone')
    await put(cell(126, 0, 0), 'tnt')
    await pause(3_000) // the server resends the chunks; the bot reads the new biome from them

    const run = await explore({ kind: 'desert_temple', max_distance: 300, use_locate: false })

    if (run.failed) throw new Error(`The search did not succeed: ${run.text}`)
    expect(run.task.result).toMatchObject({
      found: { kind: 'desert_temple', x: 125, z: 0, source: 'scan' },
      searched: 'guided',
    })
    // The blob search needs a dozen hops or more to cover ground out to 125 blocks; the guided one walks there.
    expect((run.task.result as { hops: number }).hops).toBeLessThanOrEqual(8)
  }, 300_000)

  it('finds a wolf standing 55 blocks away and walks up to it', async () => {
    await world.summonWith('wolf', cell(45, 0, 30), '{NoAI:1b,Silent:1b}')

    const run = await explore({ mob: 'wolf', max_distance: 200, use_locate: false })

    if (run.failed) throw new Error(`The search did not succeed: ${run.text}`)
    expect(run.task.result?.found).toMatchObject({ kind: 'mob', name: 'wolf' })
    const at = await world.playerPosition(session.bot.username)
    expect(Math.hypot(at.x - 45, at.z - 30)).toBeLessThan(12)
  }, 300_000)

  it('names the biomes and mobs that exist when the name is wrong', async () => {
    const wrongBiome = await session.bot.call('explore_for_structure', { biome: 'deserts' })
    const wrongMob = await session.bot.call('explore_for_structure', { mob: 'foxx' })

    expect(wrongBiome.text).toContain('unknown_biome')
    expect(wrongBiome.text).toContain('desert')
    expect(wrongMob.text).toContain('unknown_mob')
  }, 60_000)
})
