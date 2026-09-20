import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../src/core/position.types.js'
import { err, ok } from '../../../src/core/result.js'
import { SafeSpotFinder } from '../../../src/reflexes/safe-spot.js'
import { TeleportSkill, type TeleportInput } from '../../../src/skills/commands/teleport-skill.js'
import { FakeServerCommands } from '../../fakes/command-fakes.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import {
  buildVitals,
  FakeBlockScanner,
  FakeEntityScanner,
  FakeVitals,
} from '../../fakes/fake-ports.js'
import { AutoScheduler, InstantNavigator, skillContext } from '../../fakes/gathering-fakes.js'

const START: Position = { x: 100, y: 64, z: 100 }
const PLAYER: Position = { x: 10, y: 70, z: 20 }
const key = (p: Position): string => `${String(p.x)},${String(p.y)},${String(p.z)}`

/** Flat stone around the player, so a standing spot next to them exists. */
function ground(blocks: FakeBlockScanner, around: Position): void {
  for (let dx = -3; dx <= 3; dx += 1)
    for (let dz = -3; dz <= 3; dz += 1) {
      const x = Math.floor(around.x) + dx
      const z = Math.floor(around.z) + dz
      const y = Math.floor(around.y)
      blocks.solid.set(key({ x, y: y - 1, z }), true)
      blocks.solid.set(key({ x, y, z }), false)
      blocks.solid.set(key({ x, y: y + 1, z }), false)
    }
}

function setup() {
  const clock = new FakeClock(0)
  const scheduler = new AutoScheduler(clock)
  const commands = new FakeServerCommands()
  const vitals = new FakeVitals()
  vitals.vitals = buildVitals({ position: START })
  const navigator = new InstantNavigator()
  navigator.onArrive = (target) => {
    vitals.vitals = { ...(vitals.vitals ?? buildVitals()), position: target }
  }
  const entities = new FakeEntityScanner()
  entities.players.set('andrey_knight', {
    name: 'Andrey_Knight',
    online: true,
    position: PLAYER,
    distance: 120,
  })
  const blocks = new FakeBlockScanner()
  ground(blocks, PLAYER)
  const skill = new TeleportSkill({
    commands,
    vitals,
    navigator,
    entities,
    spots: new SafeSpotFinder(blocks),
    scheduler,
    botName: () => 'ClaudeBot',
  })
  /** The server obeys: the bot appears where the command says. */
  commands.onRun = (command) => {
    const parts = command.split(' ')
    const at =
      parts[2] === 'Andrey_Knight'
        ? PLAYER
        : { x: Number(parts[2]), y: Number(parts[3]), z: Number(parts[4]) }
    vitals.vitals = { ...(vitals.vitals ?? buildVitals()), position: at }
  }
  return { clock, commands, vitals, navigator, entities, blocks, skill }
}

const toPlayer: TeleportInput = { target: { kind: 'player', name: 'Andrey_Knight' } }
const toSpot = (x: number, y: number, z: number): TeleportInput => ({
  target: { kind: 'position', position: { x, y, z } },
})

describe('TeleportSkill: to a player', () => {
  it('teleports next to the player and steps to a safe spot beside them', async () => {
    const s = setup()

    const result = await s.skill.run(toPlayer, skillContext().context)

    expect(s.commands.sent).toEqual(['tp @s Andrey_Knight'])
    expect(result).toMatchObject({ ok: true, value: { from: START, reply: 'Teleported' } })
    const arrived = result.ok ? result.value.arrivedAt : START
    expect(Math.hypot(arrived.x - PLAYER.x, arrived.z - PLAYER.z)).toBeGreaterThan(0.5)
    expect(Math.hypot(arrived.x - PLAYER.x, arrived.z - PLAYER.z)).toBeLessThan(3)
    expect(arrived.y).toBe(70)
    expect(s.navigator.trips).toHaveLength(1)
  })

  it('stays where it landed when there is no safe spot to step to, and says where that is', async () => {
    const s = setup()
    s.blocks.solid.clear() // nothing known around the player

    const result = await s.skill.run(toPlayer, skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { arrivedAt: PLAYER } })
    expect(s.navigator.trips).toEqual([])
  })

  it('waits for the chunks around the player to arrive before looking for a spot', async () => {
    const s = setup()
    const known = [...s.blocks.solid]
    s.blocks.solid.clear()
    let looks = 0
    const original = s.blocks.isSolid.bind(s.blocks)
    s.blocks.isSolid = (position) => {
      looks += 1
      if (looks === 200) for (const [k, v] of known) s.blocks.solid.set(k, v) // the terrain arrives later
      return original(position)
    }

    const result = await s.skill.run(toPlayer, skillContext().context)

    expect(result.ok && s.navigator.trips.length).toBe(1)
  })

  it('does not step aside into lava or water', async () => {
    const s = setup()
    s.blocks.blockNames.set(key({ x: 11, y: 70, z: 20 }), 'lava')

    const result = await s.skill.run(toPlayer, skillContext().context)

    const arrived = result.ok ? result.value.arrivedAt : START
    expect(Math.abs(arrived.x - 11)).toBeGreaterThan(1) // not the neighbours of the lava
  })

  it('says the player is not online', async () => {
    const s = setup()
    s.entities.players.clear()

    expect(await s.skill.run(toPlayer, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'player_not_online' },
    })
    expect(s.commands.sent).toEqual([])
  })

  it('goes to a player who is online but out of view, since the server knows where they are', async () => {
    const s = setup()
    s.entities.players.set('andrey_knight', {
      name: 'Andrey_Knight',
      online: true,
      position: undefined,
      distance: undefined,
    })

    expect(await s.skill.run(toPlayer, skillContext().context)).toMatchObject({ ok: true })
    expect(s.commands.sent).toEqual(['tp @s Andrey_Knight'])
  })
})

describe('TeleportSkill: to a position', () => {
  it('teleports to the coordinates and stays there', async () => {
    const s = setup()

    const result = await s.skill.run(toSpot(-40, 80, 12), skillContext().context)

    expect(s.commands.sent).toEqual(['tp @s -40 80 12'])
    expect(result).toMatchObject({ ok: true, value: { arrivedAt: { x: -40, y: 80, z: 12 } } })
    expect(s.navigator.trips).toEqual([])
  })

  it('reports the dimension it ended up in', async () => {
    const s = setup()

    const result = await s.skill.run(toSpot(0, 64, 0), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { dimension: 'overworld' } })
  })
})

describe('TeleportSkill: when the server does not allow it', () => {
  it('explains what to enable when the command is not offered, without sending anything', async () => {
    const s = setup()
    s.commands.offered = ['gamemode']

    const result = await s.skill.run(toPlayer, skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_permission' } })
    const message = !result.ok ? result.error.message : ''
    expect(message).toContain('Allow cheats')
    expect(message).toContain('/op ClaudeBot')
    expect(message).toContain('goto')
    expect(s.commands.sent).toEqual([])
  })

  it('tries anyway while the list of commands has not arrived', async () => {
    const s = setup()
    s.commands.offered = undefined

    expect(await s.skill.run(toPlayer, skillContext().context)).toMatchObject({ ok: true })
  })

  it('reports a refusal the server gave in words', async () => {
    const s = setup()
    s.commands.outcomes = [
      ok({ kind: 'no_permission', reply: 'You do not have permission to perform this command.' }),
    ]

    expect(await s.skill.run(toPlayer, skillContext().context)).toMatchObject({
      ok: false,
      error: {
        reason: 'no_permission',
        detail: { reply: 'You do not have permission to perform this command.' },
      },
    })
  })

  it("reports an unknown command and a refused teleport, with the server's text", async () => {
    const s = setup()
    s.commands.outcomes = [ok({ kind: 'unknown_command', reply: 'Unknown command.' })]
    expect(await s.skill.run(toPlayer, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'unknown_command' },
    })

    s.commands.outcomes = [
      ok({ kind: 'error', reply: 'That position is outside the world border' }),
    ]
    const refused = await s.skill.run(toSpot(9999999, 64, 0), skillContext().context)
    expect(refused).toMatchObject({ ok: false, error: { reason: 'teleport_failed' } })
    expect(!refused.ok && refused.error.message).toContain('outside the world border')
  })

  it('does not claim success when the server said nothing and the bot did not move', async () => {
    const s = setup()
    s.commands.outcomes = [ok({ kind: 'sent' })]
    s.commands.onRun = () => undefined

    const result = await s.skill.run(toPlayer, skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'teleport_failed' } })
  })

  it('accepts a silent server when the bot did move', async () => {
    const s = setup()
    s.commands.outcomes = [ok({ kind: 'sent' })]

    const result = await s.skill.run(toSpot(5, 64, 5), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { reply: undefined } })
  })

  it('trusts an "ok" reply even when the bot was already where it was sent', async () => {
    const s = setup()
    s.commands.onRun = () => undefined

    const result = await s.skill.run(toSpot(100, 64, 100), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { arrivedAt: START } })
  })
})

describe('TeleportSkill: other ways to end', () => {
  it('needs a connection', async () => {
    const s = setup()
    s.vitals.vitals = undefined

    expect(await s.skill.run(toPlayer, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'not_connected' },
    })
  })

  it('passes on a failure of the command channel', async () => {
    const s = setup()
    s.commands.outcomes = [err({ reason: 'not_connected', message: 'Not connected.' })]

    expect(await s.skill.run(toPlayer, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'not_connected' },
    })
  })

  it('stops when cancelled', async () => {
    const s = setup()
    const { context, controller } = skillContext()
    controller.abort()

    expect(await s.skill.run(toPlayer, context)).toMatchObject({
      ok: false,
      error: { reason: 'aborted' },
    })
  })

  it('is cancelled while waiting to see the teleport happen', async () => {
    const s = setup()
    const { context, controller } = skillContext()
    s.commands.onRun = () => {
      controller.abort()
    }
    s.commands.outcomes = [ok({ kind: 'sent' })]

    expect(await s.skill.run(toPlayer, context)).toMatchObject({
      ok: false,
      error: { reason: 'aborted' },
    })
  })

  it('names the bot generically when it does not know its own name', async () => {
    const s = setup()
    s.commands.offered = []
    const anonymous = new TeleportSkill({
      commands: s.commands,
      vitals: s.vitals,
      navigator: s.navigator,
      entities: s.entities,
      spots: new SafeSpotFinder(s.blocks),
      scheduler: new AutoScheduler(s.clock),
      botName: () => undefined,
    })

    const result = await anonymous.run(toPlayer, skillContext().context)

    expect(!result.ok && result.error.message).toContain('/op the bot')
  })
})
