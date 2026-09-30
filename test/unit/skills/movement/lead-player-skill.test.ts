import { beforeEach, describe, expect, it } from '@jest/globals'
import { distanceBetween } from '../../../../src/core/position.js'
import {
  CALL_MS,
  LeadPlayerSkill,
  LOST_MS,
  NOT_FOLLOWING_MS,
  resumeDistance,
  type LeadPlayerInput,
} from '../../../../src/skills/movement/lead-player-skill.js'
import { FakeChatPort } from '../../../fakes/fake-ports.js'
import { LeadWorld } from '../../../fakes/lead-fakes.js'

const at = (x: number, y: number, z: number) => ({ x, y, z })

describe('resumeDistance', () => {
  it('is 60% of the lead distance, never under 3', () => {
    expect(resumeDistance(8)).toBe(5)
    expect(resumeDistance(16)).toBe(10)
    expect(resumeDistance(5)).toBe(3)
    expect(resumeDistance(4)).toBe(3)
  })
})

describe('LeadPlayerSkill', () => {
  let world: LeadWorld
  let chat: FakeChatPort
  let controller: AbortController
  let progress: string[]
  let skill: LeadPlayerSkill

  const input = (patch: Partial<LeadPlayerInput> = {}): LeadPlayerInput => ({
    player: 'Steve',
    destination: { label: 'the village', position: at(60, 64, 0) },
    leadDistance: 8,
    arriveWithin: 6,
    ...patch,
  })

  beforeEach(() => {
    world = new LeadWorld()
    chat = new FakeChatPort()
    controller = new AbortController()
    progress = []
    skill = new LeadPlayerSkill({
      navigator: world,
      entities: world,
      vitals: world,
      gaze: world,
      chat,
      scheduler: world.scheduler,
      clock: world.clock,
    })
  })

  const run = (patch: Partial<LeadPlayerInput> = {}) =>
    skill.run(input(patch), {
      signal: controller.signal,
      progress: (message) => progress.push(message),
    })

  it('leads a player who follows to the destination, and says they have arrived', async () => {
    world.behaviour = { kind: 'follow', speed: 4 }

    const result = await run()

    expect(result).toMatchObject({ ok: true, value: { destination: 'the village', calls: 0 } })
    expect(distanceBetween(world.bot, at(60, 64, 0))).toBeLessThanOrEqual(6)
    expect(chat.said.at(-1)).toMatch(/^We are at the village: \d+, 64, -?\d+$/)
    expect(world.maxSeparation).toBeLessThanOrEqual(8 + 6)
  })

  it('first comes to a player who is far away', async () => {
    world.playerAt = at(30, 64, 30)
    world.behaviour = { kind: 'follow', speed: 4 }

    const result = await run({ destination: { label: 'home', position: at(30, 64, 90) } })

    expect(result).toMatchObject({ ok: true })
    expect(world.toPlayerTrips[0]).toEqual({ within: 5 })
  })

  it('leads in short legs towards the destination', async () => {
    world.behaviour = { kind: 'follow', speed: 4 }

    await run()

    expect(world.legs.length).toBeGreaterThan(5)
    for (const [index, leg] of world.legs.entries()) {
      const before = index === 0 ? at(0, 64, 0) : (world.legs[index - 1] ?? at(0, 64, 0))
      expect(distanceBetween(before, leg)).toBeLessThanOrEqual(6.5)
    }
  })

  it('waits, faces the player, and calls when the player lags, then goes on when they are close', async () => {
    world.behaviour = { kind: 'follow', speed: 1 }

    const result = await run()

    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.value.waits).toBeGreaterThan(0)
    expect(result.ok && result.value.calls).toBeGreaterThan(0)
    expect(chat.said).toContain('Follow me to the village')
    expect(world.looks.length).toBeGreaterThan(0)
    expect(world.maxSeparation).toBeLessThanOrEqual(8 + 6)
  })

  it('does not call more often than every 10 seconds', async () => {
    world.behaviour = { kind: 'follow', speed: 1 }
    const times: number[] = []
    const say = chat.say.bind(chat)
    chat.say = (text) => {
      if (text.startsWith('Follow me')) times.push(world.clock.now())
      return say(text)
    }

    await run()

    expect(times.length).toBeGreaterThan(1)
    for (let i = 1; i < times.length; i += 1)
      expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(CALL_MS)
  })

  it('stays waiting while the player is between the resume and lead distances', async () => {
    world.playerAt = at(0, 64, 0)
    world.behaviour = { kind: 'idle' }
    let moved = false
    world.onTime = (w) => {
      // Once the bot has stopped to wait, the player steps up to 7 blocks away and stands still.
      if (w.looks.length > 0 && !moved) {
        moved = true
        w.playerAt = at(w.bot.x - 7, 64, 0)
      }
    }

    const legsBefore = () => world.legs.length
    const result = await run()

    // 7 blocks is inside the lead distance (8) but not close (5): the bot does not go on.
    expect(result).toMatchObject({ ok: false, error: { reason: 'player_not_following' } })
    expect(legsBefore()).toBeLessThan(6)
  })

  it('ends with player_not_following after ten minutes of waiting, having called all the while', async () => {
    world.behaviour = { kind: 'idle' }

    const result = await run()

    expect(result).toMatchObject({ ok: false, error: { reason: 'player_not_following' } })
    const calls = chat.said.filter((line) => line.startsWith('Follow me')).length
    expect(calls).toBeGreaterThanOrEqual(50)
    expect(calls).toBeLessThanOrEqual(NOT_FOLLOWING_MS / CALL_MS + 2)
  })

  it('goes back to a player who walks off, and never leaves them far behind', async () => {
    world.behaviour = { kind: 'follow', speed: 4 }
    let walkedOff = false
    world.onTime = (w) => {
      // After the bot has led for a while, the player wanders away sideways.
      if (!walkedOff && w.bot.x > 20) {
        walkedOff = true
        w.behaviour = { kind: 'walk', dx: 0, dz: 1, speed: 3 }
      }
      if (walkedOff && w.playerAt !== undefined && w.playerAt.z > 40 && w.behaviour.kind === 'walk')
        w.behaviour = { kind: 'follow', speed: 4 }
    }

    const result = await run({ arriveWithin: 6 })

    expect(result).toMatchObject({ ok: true })
    expect(world.toPlayerTrips.length).toBeGreaterThan(0)
    expect(world.maxSeparation).toBeLessThan(8 * 3)
  })

  it('goes to a player who is more than twice the lead distance away at once', async () => {
    world.behaviour = { kind: 'idle' }
    world.onTime = (w) => {
      if (w.bot.x > 12 && w.playerAt !== undefined && w.playerAt.z === 3) w.playerAt = at(0, 64, 40)
    }
    world.behaviour = { kind: 'follow', speed: 5 }

    const result = await run()

    expect(result).toMatchObject({ ok: true })
  })

  it('stops with player_lost when the player is out of view for a minute, and goes on if they come back', async () => {
    world.behaviour = { kind: 'idle' }
    world.playerAt = undefined

    const lost = await run()

    expect(lost).toMatchObject({ ok: false, error: { reason: 'player_lost' } })
    expect(world.clock.now()).toBeGreaterThanOrEqual(LOST_MS)
    expect(chat.said.at(-1)).toContain('where did you go')

    world.clock.advance(0)
    world.playerAt = undefined
    world.behaviour = { kind: 'follow', speed: 4 }
    world.onTime = (w) => {
      if (w.clock.now() > LOST_MS + 20_000) w.playerAt ??= at(w.bot.x, 64, w.bot.z + 3)
    }
    const back = await run()
    expect(back).toMatchObject({ ok: true })
  })

  it('fails when the player is not online, or the bot is not in a world', async () => {
    world.online = false
    expect(await run()).toMatchObject({ ok: false, error: { reason: 'player_offline' } })

    world.online = true
    const detached = new LeadPlayerSkill({
      navigator: world,
      entities: world,
      vitals: { read: () => undefined },
      gaze: world,
      chat,
      scheduler: world.scheduler,
      clock: world.clock,
    })
    expect(
      await detached.run(input(), { signal: controller.signal, progress: () => undefined }),
    ).toMatchObject({ ok: false, error: { reason: 'not_connected' } })
  })

  it('arrives at once when already there', async () => {
    const result = await run({ destination: { label: 'home', position: at(2, 64, 2) } })

    expect(result).toMatchObject({ ok: true })
    expect(world.legs).toEqual([])
    expect(chat.said).toEqual(['We are at home: 0, 64, 0'])
  })

  it('gives up when the way is blocked three times in a row', async () => {
    world.behaviour = { kind: 'follow', speed: 4 }
    world.navFailures = Array.from({ length: 3 }, () => ({
      reason: 'unreachable' as const,
      message: 'no path',
    }))

    const result = await run()

    expect(result).toMatchObject({ ok: false, error: { reason: 'unreachable' } })
  })

  it('carries on after one blocked leg', async () => {
    world.behaviour = { kind: 'follow', speed: 4 }
    world.navFailures = [{ reason: 'unreachable', message: 'no path' }]

    expect(await run()).toMatchObject({ ok: true })
  })

  it('stops when cancelled, before moving and while leading', async () => {
    controller.abort()
    expect(await run()).toMatchObject({ ok: false, error: { reason: 'aborted' } })

    controller = new AbortController()
    world.behaviour = { kind: 'follow', speed: 4 }
    world.onTime = () => {
      if (world.legs.length >= 2) controller.abort()
    }
    expect(await run()).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    expect(world.legs.length).toBeLessThanOrEqual(3)
  })

  it('reports where the leading stands in its progress', async () => {
    world.behaviour = { kind: 'follow', speed: 1 }

    await run()

    expect(progress.some((line) => line.startsWith('Leading to the village'))).toBe(true)
    expect(progress.some((line) => line.startsWith('Waiting for Steve'))).toBe(true)
    expect(progress.some((line) => line.includes('caught up'))).toBe(true)
  })
})
