import { afterEach, describe, expect, it } from '@jest/globals'
import type { EntityLike } from '../../src/bot/bot-like.types.js'
import { ANIMAL_KEYS, FakeBot } from '../fakes/fake-bot.js'
import { createHarness, type Harness } from './support/app-harness.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.close().catch(() => undefined)
  harness = undefined
})

const at = (x: number, y: number, z: number) => ({ x, y, z })
const GROUND = 63

function flatFloor(bot: FakeBot): void {
  for (let x = -10; x <= 40; x += 1) {
    for (let z = -30; z <= 30; z += 1) {
      bot.setBlock(at(x, GROUND, z), 'dirt')
      for (let y = GROUND + 1; y <= GROUND + 6; y += 1) bot.setBlock(at(x, y, z), 'air')
    }
  }
}

/** A 5 by 4 wheat field, ripe on one plot, with a water channel down the middle. */
function wheatField(bot: FakeBot): void {
  for (let x = 14; x <= 18; x += 1) {
    for (let z = -12; z <= -9; z += 1) {
      if (x === 16) {
        bot.setBlock(at(x, GROUND, z), 'water')
        continue
      }
      bot.setBlock(at(x, GROUND, z), 'farmland')
      bot.setBlock(at(x, GROUND + 1, z), 'wheat')
    }
  }
  bot.setCropAge(at(14, GROUND + 1, -12), 7)
}

/** A fenced pen for cows: inside 22..26 by -6..-3, fence one cell outside, a gate in the south middle. */
function cowPen(bot: FakeBot): void {
  for (let x = 21; x <= 27; x += 1) {
    for (let z = -7; z <= -2; z += 1) {
      if (x !== 21 && x !== 27 && z !== -7 && z !== -2) continue
      bot.setBlock(at(x, GROUND + 1, z), z === -2 && x === 24 ? 'oak_fence_gate' : 'oak_fence')
    }
  }
}

let nextId = 300
function cow(x: number, z: number): EntityLike {
  nextId += 1
  return { id: nextId, type: 'animal', name: 'cow', position: at(x + 0.5, GROUND + 1, z + 0.5), metadata: ANIMAL_KEYS.map(() => undefined) }
}

async function start(setup: (bot: FakeBot) => void): Promise<Harness> {
  const bot = new FakeBot().useGameData()
  flatFloor(bot)
  bot.entity = { position: at(10.5, GROUND + 1, -5.5) }
  bot.physics = true
  setup(bot)
  const h = await createHarness({}, { bot })
  harness = h
  bot.now = () => h.clock.now()
  const connected = await h.call('connect', { port: 34231 })
  if (connected.isError) throw new Error(connected.text)
  await h.call('wait_for_chat', { timeout_seconds: 1 })
  return h
}

const data = (result: { data: unknown }): Record<string, unknown> => result.data as Record<string, unknown>

describe('discover_farm through the MCP server', () => {
  it('proposes a field and a pen built by hand, and registering the proposals makes them known farms', async () => {
    const h = await start((bot) => {
      wheatField(bot)
      cowPen(bot)
      for (const [x, z] of [[23, -5], [24, -4], [25, -5]] as const) bot.entities[String(nextId + 1)] = cow(x, z)
    })

    const found = data(await h.call('discover_farm', { group: 'home' }))

    const proposals = found.proposals as { kind: string; confidence: string; register: Record<string, unknown> }[]
    expect(proposals.map((p) => p.kind).sort()).toEqual(['field', 'pen'])
    const field = proposals.find((p) => p.kind === 'field')
    const pen = proposals.find((p) => p.kind === 'pen')
    expect(field).toMatchObject({ confidence: 'high', register: { crop: 'wheat', label: 'wheat field', group: 'home' } })
    expect(pen).toMatchObject({ confidence: 'high', register: { species: 'cow', herd_target: 3, label: 'cow pen', group: 'home' } })
    expect((await h.call('list_farms')).data).toMatchObject({ count: 0 })

    for (const proposal of proposals) {
      const registered = await h.call('register_farm', proposal.register)
      expect(registered.isError).toBe(false)
    }

    const again = data(await h.call('discover_farm', {}))
    expect(again.proposals).toEqual([])
    expect((again.alreadyRegistered as unknown[]).length).toBe(2)
    const inspected = data(await h.call('inspect_farm', { farm: 'home' }))
    expect(inspected.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'field', crop: 'wheat', ripe: 1, growing: 15 }),
        expect.objectContaining({ kind: 'pen', species: 'cow', adults: 3, herdTarget: 3 }),
      ]),
    )
  })

  it('finds nothing where nobody has built anything, and changes nothing', async () => {
    const h = await start(() => undefined)

    const found = data(await h.call('discover_farm', { radius: 30 }))

    expect(found).toMatchObject({ proposals: [], alreadyRegistered: [], truncated: false, radius: 30 })
    expect((await h.call('list_farms')).data).toMatchObject({ count: 0 })
  })

  it('fails before the bot is connected', async () => {
    const bot = new FakeBot().useGameData()
    const h = await createHarness({}, { bot })
    harness = h

    const result = await h.call('discover_farm', {})

    expect(result.isError).toBe(true)
    expect(result.text).toContain('Not connected')
  })
})
