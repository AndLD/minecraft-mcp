import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import { dataOf, startApp, type AppUnderTest } from '../support/app-under-test.js'
import { E2EWorld, GROUND_Y } from '../support/e2e-world.js'
import { joinAsPlayer, type PlayerBot } from '../support/player-bot.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { waitUntil } from '../support/wait.js'

interface Briefing {
  world: { profile: string | null; status: string }
  previousSession: { at: string } | null
  interruptedTasks: { id: string; description: string; resumable: boolean }[]
  notes: { text: string }[]
  standingInstructions: Record<string, string>
  warnings: string[]
}

const uniqueName = (prefix: string): string =>
  `${prefix}${String(Math.floor(Math.random() * 100_000))}`

describe('remembering a real world across server restarts', () => {
  let info: ServerInfo
  let world: E2EWorld
  let dataDir: string
  let owner: PlayerBot
  const running: AppUnderTest[] = []

  beforeAll(async () => {
    info = readServerInfo()
    world = await E2EWorld.connect(info)
    await world.prepareArena({ x: 0, y: GROUND_Y, z: 0 })
  })

  beforeEach(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'minecraft-mcp-e2e-state-'))
    owner = await joinAsPlayer(info, uniqueName('Owner'))
  })

  afterEach(async () => {
    for (const app of running.splice(0)) await app.shutdown().catch(() => undefined)
    await owner.quit()
    rmSync(dataDir, { recursive: true, force: true })
    await waitUntil(async () => !(await world.onlinePlayers()).includes(owner.username), {
      description: 'the owner to leave',
    })
  })

  afterAll(async () => {
    await world.close()
  })

  /** A "server run": a fresh app on the shared state directory, its bot connected to the real world. */
  async function run(): Promise<{ app: AppUnderTest; connected: { briefing: Briefing } }> {
    const app = await startApp(info, {
      username: uniqueName('Bot'),
      owner: owner.username,
      dataDir,
    })
    running.push(app)
    const connected = dataOf<{ briefing: Briefing }>(await app.call('connect'))
    return { app, connected }
  }

  const stop = async (app: AppUnderTest): Promise<void> => {
    running.splice(running.indexOf(app), 1)
    await app.shutdown()
  }

  it('reads real identifying signals from the server: a seed, the spawn point, and the world name', async () => {
    const { connected } = await run()

    expect(connected.briefing.world.profile).toBe('minecraft-mcp-e2e') // from the server message of the day
    const worlds = JSON.parse(readFileSync(path.join(dataDir, 'worlds.json'), 'utf8')) as {
      data: {
        profiles: {
          name: string
          fingerprint: { seed: string | null; worldName: string | null; spawn: unknown }
        }[]
      }
    }
    const fingerprint = worlds.data.profiles[0]?.fingerprint
    expect(fingerprint?.seed).toMatch(/^[0-9a-f]{1,16}$/)
    expect(fingerprint?.worldName).toBe('minecraft-mcp e2e')
    expect(fingerprint?.spawn).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
      z: expect.any(Number),
    })
  })

  it('recognizes the world on the next run without being told, and brings back what was saved', async () => {
    const first = await run()
    dataOf(
      await first.app.call('remember', { text: 'The e2e base is at 0, -60, 0', tags: ['base'] }),
    )
    dataOf(
      await first.app.call('set_standing_instruction', {
        key: 'inventory_full',
        text: 'ask me first',
      }),
    )
    owner.chat('build me a tower')
    await waitUntil(() => chatSeen(first.app), { description: 'the chat to be recorded' })
    await stop(first.app)

    const second = await run()

    expect(second.connected.briefing.world.profile).toBe('minecraft-mcp-e2e')
    expect(second.connected.briefing.world.status).toContain('recognized')
    expect(second.connected.briefing.previousSession).not.toBeNull()
    expect(second.connected.briefing.notes).toMatchObject([
      { text: 'The e2e base is at 0, -60, 0' },
    ])
    expect(second.connected.briefing.standingInstructions).toEqual({
      inventory_full: 'ask me first',
    })
    const history = dataOf<{ entries: { text: string }[] }>(
      await second.app.call('get_recent_history', { kind: 'chat' }),
    )
    expect(history.entries.map((e) => e.text).join('\n')).toContain('build me a tower')
  })

  it('offers a trip that was cut short by the restart, and resuming it walks the bot', async () => {
    const first = await run()
    await world.teleport(first.app.username, { x: -5.5, y: GROUND_Y, z: -5.5 })
    dataOf(await first.app.call('goto', { x: 13, y: GROUND_Y, z: 13, within: 1, wait_seconds: 0 }))
    await stop(first.app)

    const second = await run()

    expect(second.connected.briefing.interruptedTasks).toMatchObject([
      { id: 'job-1', description: 'Go to 13, -60, 13', resumable: true },
    ])
    await world.teleport(second.app.username, { x: -5.5, y: GROUND_Y, z: -5.5 })
    const resumed = dataOf<{ resumed: string }>(
      await second.app.call('resume_interrupted_task', { id: 'job-1', wait_seconds: 40 }),
    )
    expect(resumed.resumed).toBe('job-1')
    const position = await world.playerPosition(second.app.username)
    expect(Math.hypot(position.x - 13, position.z - 13)).toBeLessThan(2.5)
    const after = dataOf<{ interruptedTasks: unknown[] }>(
      await second.app.call('get_session_briefing'),
    )
    expect(after.interruptedTasks).toEqual([])
  })

  async function chatSeen(app: AppUnderTest): Promise<boolean | undefined> {
    const history = dataOf<{ entries: { text: string }[] }>(
      await app.call('get_recent_history', { kind: 'chat' }),
    )
    return history.entries.some((e) => e.text.includes('build me a tower')) ? true : undefined
  }
})
