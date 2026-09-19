import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from '@jest/globals'
import { FakeBot } from '../fakes/fake-bot.js'
import { createHarness, type Harness } from './support/app-harness.js'

const opened: Harness[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const harness of opened.splice(0)) await harness.close().catch(() => undefined)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Starts an app (a "server run") on a state directory and connects it to a world. */
async function session(
  options: { dataDir?: string; seed?: string | undefined; motd?: string; connect?: boolean } = {},
): Promise<Harness> {
  const bot = new FakeBot()
  if ('seed' in options) bot.worldSeed = options.seed
  const harness = await createHarness(
    {},
    { bot, ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }) },
  )
  opened.push(harness)
  if (!dirs.includes(harness.dataDir)) dirs.push(harness.dataDir)
  if (options.motd !== undefined) harness.statusProbe.status = { motd: options.motd }
  if (options.connect !== false) {
    const connected = await harness.call('connect', { port: 34231 })
    if (connected.isError) throw new Error(connected.text)
  }
  return harness
}

interface Briefing {
  world: { profile: string | null; status: string }
  previousSession: { at: string; minutesAgo: number } | null
  interruptedTasks: { id: string; description: string; resumable: boolean }[]
  standingInstructions: Record<string, string>
  notes: { id: string; text: string }[]
  recentHistory: { kind: string; text: string }[]
  warnings: string[]
  nextSteps: string[]
}

const briefingOf = async (h: Harness): Promise<Briefing> =>
  h.call('get_session_briefing').then((r) => r.data) as Promise<Briefing>

/** "Restarts the server": a clean shutdown of the current run, then a fresh app on the same state directory. */
async function restart(h: Harness, options: Parameters<typeof session>[0] = {}): Promise<Harness> {
  await h.close()
  h.scheduler.advance(0)
  return session({ dataDir: h.dataDir, ...options })
}

describe('remembering across restarts', () => {
  it('recognizes the same world, without a name, and brings back notes, instructions, and history', async () => {
    const first = await session({ motd: 'Andrey_Knight - AI bot test world' })
    expect(
      (await first.call('remember', { text: 'The base is at 100, 64, -20', tags: ['base'] }))
        .isError,
    ).toBe(false)
    await first.call('set_standing_instruction', {
      key: 'inventory_full',
      text: 'bring resources to the home chest',
    })
    first.bot.emit('chat', 'Andrey_Knight', 'build a house near the base')
    first.clock.advance(2 * 60 * 60_000)

    const second = await restart(first, { motd: 'Andrey_Knight - AI bot test world' })
    const briefing = await briefingOf(second)

    expect(briefing.world.profile).toBe('ai-bot-test-world')
    expect(briefing.world.status).toContain('recognized')
    expect(briefing.previousSession).not.toBeNull()
    expect(briefing.notes).toMatchObject([{ id: 'note-1', text: 'The base is at 100, 64, -20' }])
    expect(briefing.standingInstructions).toEqual({
      inventory_full: 'bring resources to the home chest',
    })
    expect(briefing.recentHistory.map((e) => e.text)).toEqual(
      expect.arrayContaining([
        'Andrey_Knight: build a house near the base',
        expect.stringContaining('remember('),
      ]),
    )
  })

  it('the connect reply carries the briefing, so the agent sees it right away', async () => {
    const first = await session()
    await first.call('remember', { text: 'plan: a tower' })

    const second = await restart(first, { connect: false })
    const reply = await second.call('connect', { port: 34231 })

    expect(reply.data).toMatchObject({
      briefing: { world: { profile: 'world-a1b2c3' }, notes: [{ text: 'plan: a tower' }] },
    })
  })

  it('does not show one world’s data in another world', async () => {
    const survival = await session({ seed: 'aaaa1111' })
    await survival.call('remember', { text: 'only in survival' })

    const creative = await restart(survival, { seed: 'bbbb2222' })

    const briefing = await briefingOf(creative)
    expect(briefing.world.profile).toBe('world-bbbb22')
    expect(briefing.notes).toEqual([])
    const worlds = await creative.call('list_worlds')
    expect(worlds.data).toMatchObject({
      active: 'world-bbbb22',
      worlds: [{ profile: 'world-aaaa11' }, { profile: 'world-bbbb22' }],
    })
  })

  it('returns to the first world’s data when that world is joined again', async () => {
    const survival = await session({ seed: 'aaaa1111' })
    await survival.call('remember', { text: 'only in survival' })
    const creative = await restart(survival, { seed: 'bbbb2222' })

    const again = await restart(creative, { seed: 'aaaa1111' })

    expect((await briefingOf(again)).notes).toMatchObject([{ text: 'only in survival' }])
  })

  it('records what the agent did, not what it only looked at', async () => {
    const h = await session()
    await h.call('get_status')
    await h.call('get_inventory')
    await h.call('remember', { text: 'a note' })

    const history = await h.call('get_recent_history', { kind: 'tool' })

    const texts = (history.data as { entries: { text: string }[] }).entries.map((e) => e.text)
    expect(texts.some((t) => t.startsWith('remember('))).toBe(true)
    expect(texts.some((t) => t.startsWith('get_status') || t.startsWith('get_inventory'))).toBe(
      false,
    )
  })
})

describe('tasks across restarts', () => {
  it('a crash leaves the running task offered as interrupted, and resuming restarts the trip', async () => {
    const first = await session()
    void first.call('goto', { x: 100, y: 64, z: 0, wait_seconds: 0 })
    await first.settle()
    first.scheduler.advance(600) // the debounced write reaches the disk; then the process is "killed"
    await first.app.worldState.close().catch(() => undefined)

    const second = await session({ dataDir: first.dataDir })
    const briefing = await briefingOf(second)

    expect(briefing.interruptedTasks).toMatchObject([
      { id: 'job-1', description: 'Go to 100, 64, 0', resumable: true },
    ])
    expect(briefing.nextSteps.join(' ')).toContain('ask before resuming')

    const resumed = await second.call('resume_interrupted_task', { id: 'job-1', wait_seconds: 0 })
    expect(resumed.data).toMatchObject({ resumed: 'job-1', task: { status: 'running' } })
    expect(second.bot.pathfinder.gotoGoals).toEqual([
      { kind: 'near', x: 100, y: 64, z: 0, range: 2 },
    ])
    expect((await briefingOf(second)).interruptedTasks).toEqual([])
  })

  it('a task cut short by a disconnect is offered for resuming after reconnecting', async () => {
    const h = await session()
    h.bot.players['Andrey_Knight'] = {
      username: 'Andrey_Knight',
      entity: { id: 9, type: 'player', username: 'Andrey_Knight', position: { x: 4, y: 64, z: 4 } },
    }
    void h.call('follow_player', { wait_seconds: 0 })
    await h.settle()

    const next = await restart(h)

    expect((await briefingOf(next)).interruptedTasks).toMatchObject([
      { id: 'job-1', resumable: true },
    ])
  })

  it('a task stopped on purpose is not offered again', async () => {
    const h = await session()
    void h.call('goto', { x: 100, y: 64, z: 0, wait_seconds: 0 })
    await h.settle()
    await h.call('stop')

    const next = await restart(h)

    expect((await briefingOf(next)).interruptedTasks).toEqual([])
  })

  it('an interrupted task can be discarded', async () => {
    const h = await session()
    void h.call('goto', { x: 100, y: 64, z: 0, wait_seconds: 0 })
    await h.settle()
    const next = await restart(h)

    const discarded = await next.call('discard_interrupted_task', { id: 'job-1' })

    expect(discarded.data).toEqual({ discarded: 'job-1' })
    expect((await briefingOf(next)).interruptedTasks).toEqual([])
  })
})

describe('worlds that cannot be identified', () => {
  it('asks for a name, saves nothing until one is given, and remembers the name afterwards', async () => {
    const first = await session({ seed: undefined })
    // the fake bot has a spawn point, but no seed and no MOTD: name or spawn alone is not enough for the seed rule,
    // so identification relies on the spawn only and cannot name the world
    const briefing = await briefingOf(first)
    expect(briefing.world.profile).toBeNull()
    expect(briefing.nextSteps.join(' ')).toContain('set_world_profile')
    expect((await first.call('remember', { text: 'lost' })).isError).toBe(true)

    const named = await first.call('set_world_profile', { name: 'My Survival' })
    expect(named.data).toMatchObject({ profile: 'my-survival' })
    await first.call('remember', { text: 'kept' })

    const second = await restart(first, { seed: undefined })
    expect((await briefingOf(second)).world.profile).toBeNull() // still unrecognizable by itself
    await second.call('set_world_profile', { name: 'my survival' })
    expect((await briefingOf(second)).notes).toMatchObject([{ text: 'kept' }])
  })

  it('a fallback profile name on connect names a world that cannot be recognized', async () => {
    const h = await createHarness(
      {},
      { bot: Object.assign(new FakeBot(), { worldSeed: undefined }) },
    )
    opened.push(h)
    dirs.push(h.dataDir)

    const reply = await h.call('connect', { port: 34231, profile: 'Fallback World' })

    expect(reply.data).toMatchObject({ briefing: { world: { profile: 'fallback-world' } } })
  })

  it('reports a corrupt saved file as a warning and starts that part empty', async () => {
    const first = await session()
    await first.call('remember', { text: 'will be lost' })
    await first.close()
    const { writeFileSync } = await import('node:fs')
    writeFileSync(`${first.dataDir}/world-a1b2c3/notes.json`, 'not json at all')
    rmSync(`${first.dataDir}/world-a1b2c3/notes.json.bak`, { force: true })

    const second = await session({ dataDir: first.dataDir })
    const briefing = await briefingOf(second)

    expect(briefing.notes).toEqual([])
    expect(briefing.warnings.join(' ')).toContain('notes.json')
  })
})
