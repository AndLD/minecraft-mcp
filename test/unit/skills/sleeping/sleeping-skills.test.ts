import { describe, expect, it } from '@jest/globals'
import type { EntityInfo } from '../../../../src/core/entity-scanner.port.js'
import type { Position } from '../../../../src/core/position.types.js'
import { PlaceBedSkill } from '../../../../src/skills/sleeping/place-bed-skill.js'
import { BedFinder } from '../../../../src/skills/sleeping/bed-finder.js'
import { NightResponder } from '../../../../src/skills/sleeping/night-responder.js'
import { SetRespawnPointSkill } from '../../../../src/skills/sleeping/set-respawn-point-skill.js'
import { SleepSkill } from '../../../../src/skills/sleeping/sleep-skill.js'
import { BedRegistry } from '../../../../src/state/bed-registry.js'
import type { SleepPolicyKind } from '../../../../src/state/sleep-policy.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import {
  FakeEntityScanner,
  FakeInventory,
  FakeVitals,
  buildVitals,
} from '../../../fakes/fake-ports.js'
import { AutoScheduler, InstantNavigator, skillContext } from '../../../fakes/gathering-fakes.js'
import { GroveWorld } from '../../../fakes/grove-fakes.js'
import {
  BedPlacer,
  FakeBedAccess,
  FakeSleeper,
  RecordingGaze,
} from '../../../fakes/sleeping-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const Y = 64
const at = (x: number, z = 0): Position => ({ x, y: Y, z })
const NIGHT = 14_000
const MORNING = 100

async function setup(timeOfDay = NIGHT) {
  const clock = new FakeClock(0)
  const world = new GroveWorld({ x0: -40, x1: 60, z0: -40, z1: 40, y0: 50, y1: 90 })
  world.ground(-40, -40, 60, 40, Y - 1)
  const vitals = new FakeVitals()
  vitals.vitals = buildVitals({ timeOfDay, position: at(0) })
  const entities = new FakeEntityScanner()
  const navigator = new InstantNavigator()
  const sleeper = new FakeSleeper()
  const registry = new BedRegistry(clock)
  await registry.attach(new InMemoryStateStore())
  const scheduler = new AutoScheduler(clock)
  const finder = new BedFinder(world, registry)
  return { clock, world, vitals, entities, navigator, sleeper, registry, scheduler, finder }
}

const mob = (name: string, position: Position, category = 'hostile'): EntityInfo => ({
  id: 1,
  category,
  name,
  position,
  distance: Math.hypot(position.x, position.z),
})

describe('SleepSkill', () => {
  async function skill(timeOfDay = NIGHT) {
    const s = await setup(timeOfDay)
    s.world.set(10, Y, 0, 'red_bed')
    const instance = new SleepSkill({
      vitals: s.vitals,
      blocks: s.world,
      entities: s.entities,
      navigator: s.navigator,
      sleeper: s.sleeper,
      finder: s.finder,
      registry: s.registry,
      clock: s.clock,
      scheduler: s.scheduler,
    })
    return { ...s, instance }
  }
  const input = { bed: undefined, staySeconds: undefined }

  it('walks to the nearest bed, lies down, and reports the night skipped once it is morning', async () => {
    const s = await skill()
    let polls = 0
    s.sleeper.onPoll = () => {
      polls += 1
      if (polls === 4) {
        s.vitals.vitals = buildVitals({ timeOfDay: MORNING, position: at(10) })
        s.sleeper.sleeping = false
      }
    }

    const result = await s.instance.run(input, skillContext().context)

    expect(result.ok && result.value).toMatchObject({
      bed: at(10),
      colour: 'red',
      nightSkipped: true,
      wokeEarly: false,
    })
    expect(s.navigator.trips).toEqual([{ target: at(10), within: 2 }])
    expect(s.sleeper.slept).toEqual([at(10)])
    expect(s.registry.respawn()).toMatchObject({ x: 10, colour: 'red' })
  })

  it('says the night was not skipped when the wait runs out with somebody awake, and gets up', async () => {
    const s = await skill()

    const result = await s.instance.run({ bed: undefined, staySeconds: 5 }, skillContext().context)

    expect(result.ok && result.value.nightSkipped).toBe(false)
    expect(result.ok && result.value.wokeEarly).toBe(false)
    expect(result.ok && result.value.message).toContain('sleepingPercentage')
    expect(s.sleeper.wakes).toBeGreaterThan(0)
    expect(s.sleeper.sleeping).toBe(false)
  })

  it('waits for the server’s next time update before judging a night that just ended', async () => {
    const s = await skill()
    let reads = 0
    const read = s.vitals.read.bind(s.vitals)
    s.vitals.read = () => {
      reads += 1
      // The time packet arrives a few looks after the bot woke up.
      if (reads >= 6) s.vitals.vitals = buildVitals({ timeOfDay: MORNING })
      return read()
    }
    let polls = 0
    s.sleeper.onPoll = () => {
      polls += 1
      if (polls === 2) s.sleeper.sleeping = false
    }

    const result = await s.instance.run(input, skillContext().context)

    expect(result.ok && result.value).toMatchObject({ nightSkipped: true, wokeEarly: false })
  })

  it('reports being woken before morning', async () => {
    const s = await skill()
    let polls = 0
    s.sleeper.onPoll = () => {
      polls += 1
      if (polls === 2) s.sleeper.sleeping = false
    }

    const result = await s.instance.run(input, skillContext().context)

    expect(result.ok && result.value).toMatchObject({ nightSkipped: false, wokeEarly: true })
  })

  it('never sleeps in the Nether or the End', async () => {
    const s = await skill()
    s.vitals.vitals = buildVitals({ dimension: 'the_nether', timeOfDay: NIGHT })

    const result = await s.instance.run(input, skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'wrong_dimension' } })
    expect(s.sleeper.slept).toEqual([])
    expect(s.navigator.trips).toEqual([])
  })

  it('fails when not connected, or already in bed', async () => {
    const s = await skill()
    s.vitals.vitals = undefined
    expect(await s.instance.run(input, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'not_connected' },
    })
    s.vitals.vitals = buildVitals({ timeOfDay: NIGHT })
    s.sleeper.sleeping = true
    expect(await s.instance.run(input, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'already_sleeping' },
    })
  })

  it('asks for a bed when none is known, and checks a given position is a bed', async () => {
    const s = await skill()
    s.world.set(10, Y, 0, 'stone')

    expect(await s.instance.run(input, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'no_bed', message: expect.stringContaining('place_bed') },
    })
    expect(
      await s.instance.run({ bed: at(10), staySeconds: 5 }, skillContext().context),
    ).toMatchObject({
      ok: false,
      error: { reason: 'not_a_bed' },
    })
  })

  it('uses the bed it is given', async () => {
    const s = await skill()
    s.world.set(3, Y, 3, 'blue_bed')

    const result = await s.instance.run({ bed: at(3, 3), staySeconds: 5 }, skillContext().context)

    expect(result.ok && result.value).toMatchObject({ bed: at(3, 3), colour: 'blue' })
  })

  it('refuses before walking when hostile mobs are within the game’s range of the bed', async () => {
    const s = await skill()
    s.entities.entities = [
      mob('zombie', at(14, 2)),
      mob('cow', at(11), 'animal'),
      mob('zombie', at(30)),
      mob('skeleton', { x: 10, y: Y + 9, z: 0 }),
    ]

    const result = await s.instance.run(input, skillContext().context)

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'monsters_nearby', detail: { monsters: ['zombie'] } },
    })
    expect(s.navigator.trips).toEqual([])
  })

  it('fails when the walk fails or is cancelled', async () => {
    const s = await skill()
    s.navigator.failures = [{ reason: 'unreachable', message: 'no path' }]
    expect(await s.instance.run(input, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'unreachable' },
    })
    s.navigator.failures = [{ reason: 'aborted', message: 'stopped' }]
    expect(await s.instance.run(input, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'aborted' },
    })
  })

  it.each([
    ['not_night', 'set_respawn_point'],
    ['monsters_nearby', 'hostile mobs'],
    ['occupied', 'occupied'],
  ] as const)('passes the game’s refusal %s on with an explanation', async (reason, text) => {
    const s = await skill()
    s.sleeper.failure = { reason, message: 'server said no' }

    const result = await s.instance.run(input, skillContext().context)

    expect(result).toMatchObject({
      ok: false,
      error: { reason, message: expect.stringContaining(text) },
    })
    expect(s.registry.respawn()).toBeUndefined()
  })

  it('gets up when cancelled in bed', async () => {
    const s = await skill()
    const ctx = skillContext()
    s.sleeper.onPoll = () => {
      ctx.controller.abort()
    }

    const result = await s.instance.run(input, ctx.context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    expect(s.sleeper.sleeping).toBe(false)
  })
})

describe('SetRespawnPointSkill', () => {
  async function skill() {
    const s = await setup(6000)
    s.world.set(10, Y, 0, 'blue_bed')
    const beds = new FakeBedAccess()
    const instance = new SetRespawnPointSkill({
      vitals: s.vitals,
      blocks: s.world,
      navigator: s.navigator,
      beds,
      sleeper: s.sleeper,
      finder: s.finder,
      registry: s.registry,
    })
    return { ...s, beds, instance }
  }
  const input = { bed: undefined }

  it('uses the bed and records it only once the game says the respawn point is set', async () => {
    const s = await skill()

    const result = await s.instance.run(input, skillContext().context)

    expect(result.ok && result.value).toMatchObject({ bed: at(10), colour: 'blue' })
    expect(s.beds.used).toEqual([at(10)])
    expect(s.navigator.trips).toEqual([{ target: at(10), within: 2 }])
    expect(s.registry.respawn()).toMatchObject({ x: 10, colour: 'blue' })
  })

  it('gets the bot up again when using the bed at night lay it down', async () => {
    const s = await skill()
    s.sleeper.sleeping = true

    await s.instance.run(input, skillContext().context)

    expect(s.sleeper.sleeping).toBe(false)
  })

  it('fails as not confirmed, changing nothing, when the game does not say so', async () => {
    const s = await skill()
    s.beds.lines = ['You can sleep only at night or during thunderstorms']

    const result = await s.instance.run(input, skillContext().context)

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'not_confirmed', message: expect.stringContaining('only at night') },
    })
    expect(s.registry.respawn()).toBeUndefined()
    s.beds.lines = []
    expect(await s.instance.run(input, skillContext().context)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('nothing') },
    })
  })

  it('passes a failed click on', async () => {
    const s = await skill()
    s.beds.failure = { reason: 'out_of_reach', message: 'too far' }
    expect(await s.instance.run(input, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'out_of_reach' },
    })
  })

  it('checks the dimension, the connection, the bed, and the walk', async () => {
    const s = await skill()
    s.vitals.vitals = buildVitals({ dimension: 'the_end' })
    expect(await s.instance.run(input, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'wrong_dimension' },
    })
    s.vitals.vitals = undefined
    expect(await s.instance.run(input, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'not_connected' },
    })
    s.vitals.vitals = buildVitals({ position: at(0) })
    expect(await s.instance.run({ bed: at(4) }, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'not_a_bed' },
    })
    s.navigator.failures = [{ reason: 'stuck', message: 'stuck' }]
    expect(await s.instance.run(input, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'unreachable' },
    })
    s.navigator.failures = [{ reason: 'aborted', message: 'x' }]
    expect(await s.instance.run(input, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'aborted' },
    })
    s.world.set(10, Y, 0, 'air')
    expect(await s.instance.run(input, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'no_bed' },
    })
  })

  it('takes an explicit bed, and honours a cancel during the click', async () => {
    const s = await skill()
    s.world.set(5, Y, 5, 'red_bed')
    const ok = await s.instance.run({ bed: at(5, 5) }, skillContext().context)
    expect(ok.ok && ok.value.colour).toBe('red')

    const ctx = skillContext()
    ctx.controller.abort()
    expect(await s.instance.run(input, ctx.context)).toMatchObject({
      ok: false,
      error: { reason: 'aborted' },
    })
  })
})

describe('PlaceBedSkill', () => {
  async function skill(
    items: readonly { name: string; count: number }[] = [{ name: 'red_bed', count: 1 }],
  ) {
    const s = await setup(6000)
    const inventory = new FakeInventory()
    inventory.value = { stacks: items, emptySlots: 10, heldItem: undefined }
    const placer = new BedPlacer()
    const gaze = new RecordingGaze()
    placer.onPlace = (item, foot) => {
      s.world.set(foot.x, foot.y, foot.z, item)
    }
    const instance = new PlaceBedSkill({
      vitals: s.vitals,
      blocks: s.world,
      inventory,
      navigator: s.navigator,
      placer,
      gaze,
      guard: { protectedAt: () => undefined },
      registry: s.registry,
      scheduler: s.scheduler,
    })
    return { ...s, inventory, placer, gaze, instance }
  }
  const input = { at: undefined, colour: undefined }

  it('stands behind the foot, looks along the bed, places it against the ground, and remembers it', async () => {
    const s = await skill()

    const result = await s.instance.run(input, skillContext().context)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { foot, head } = result.value
    expect(s.navigator.trips).toHaveLength(1)
    expect(s.navigator.trips[0]?.within).toBe(0)
    expect(s.gaze.looked).toEqual([{ x: head.x + 0.5, y: head.y + 0.3, z: head.z + 0.5 }])
    expect(s.placer.placed).toEqual([
      {
        item: 'red_bed',
        reference: { x: foot.x, y: foot.y - 1, z: foot.z },
        face: { x: 0, y: 1, z: 0 },
      },
    ])
    expect(s.registry.all()).toHaveLength(1)
    expect(result.value.colour).toBe('red')
  })

  it('places the wanted colour at the cell it is given', async () => {
    const s = await skill([
      { name: 'red_bed', count: 1 },
      { name: 'blue_bed', count: 1 },
    ])

    const result = await s.instance.run({ at: at(7, 7), colour: 'blue' }, skillContext().context)

    expect(result.ok && result.value.foot).toEqual(at(7, 7))
    expect(s.placer.placed[0]?.item).toBe('blue_bed')
  })

  it('fails without a bed to place, or without the wanted colour', async () => {
    const s = await skill([{ name: 'oak_planks', count: 8 }])
    expect(await s.instance.run(input, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'no_bed_item', message: expect.stringContaining('craft') },
    })
    const red = await skill()
    expect(
      await red.instance.run({ at: undefined, colour: 'green' }, skillContext().context),
    ).toMatchObject({
      ok: false,
      error: { reason: 'no_bed_item' },
    })
    red.inventory.value = undefined
    expect(await red.instance.run(input, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'no_bed_item' },
    })
  })

  it('checks the connection, the dimension, and that a bed fits', async () => {
    const s = await skill()
    s.vitals.vitals = undefined
    expect(await s.instance.run(input, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'not_connected' },
    })
    s.vitals.vitals = buildVitals({ dimension: 'the_nether' })
    expect(await s.instance.run(input, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'wrong_dimension' },
    })
    s.vitals.vitals = buildVitals({ position: at(0) })
    s.world.set(7, Y, 7, 'stone')
    s.world.set(8, Y, 7, 'stone')
    s.world.set(6, Y, 7, 'stone')
    s.world.set(7, Y, 8, 'stone')
    s.world.set(7, Y, 6, 'stone')
    expect(
      await s.instance.run({ at: at(7, 7), colour: undefined }, skillContext().context),
    ).toMatchObject({
      ok: false,
      error: { reason: 'no_space', message: expect.stringContaining('does not fit') },
    })
    const bare = await skill()
    const empty = new GroveWorld({ x0: -5, x1: 5, z0: -5, z1: 5, y0: 50, y1: 90 })
    const nowhere = new PlaceBedSkill({
      vitals: bare.vitals,
      blocks: empty,
      inventory: bare.inventory,
      navigator: bare.navigator,
      placer: bare.placer,
      gaze: bare.gaze,
      guard: { protectedAt: () => undefined },
      registry: bare.registry,
      scheduler: bare.scheduler,
    })
    expect(await nowhere.run(input, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'no_space', message: expect.stringContaining('within 6 blocks') },
    })
  })

  it('reports a failed walk, a refused placement, and a bed that never appears', async () => {
    const s = await skill()
    s.navigator.failures = [{ reason: 'stuck', message: 'stuck' }]
    expect(await s.instance.run(input, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'unreachable' },
    })
    s.navigator.failures = [{ reason: 'aborted', message: 'x' }]
    expect(await s.instance.run(input, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'aborted' },
    })
    s.placer.failure = { reason: 'no_support', message: 'nothing to place against' }
    expect(await s.instance.run(input, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'no_support' },
    })
    s.placer.failure = undefined
    s.placer.onPlace = () => undefined
    expect(await s.instance.run(input, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'not_placed' },
    })
  })
})

describe('NightResponder', () => {
  async function responder(policy: SleepPolicyKind) {
    const s = await setup()
    s.registry.note(at(10), 'red')
    const events: { type: string; message: string }[] = []
    const started: number[] = []
    let busy = false
    let startResult: { ok: boolean; message: string } = { ok: true, message: '' }
    const instance = new NightResponder({
      policy: { get: () => policy },
      vitals: s.vitals,
      registry: s.registry,
      busy: () => busy,
      emit: (type, message) => events.push({ type, message }),
      startSleep: () => {
        started.push(s.clock.now())
        return Promise.resolve(startResult)
      },
      clock: s.clock,
    })
    return {
      ...s,
      instance,
      events,
      started,
      setBusy: (value: boolean) => {
        busy = value
      },
      setStart: (value: { ok: boolean; message: string }) => {
        startResult = value
      },
    }
  }

  it('asks the agent once per night, and again the next night', async () => {
    const s = await responder('ask')

    await s.instance.tick()
    await s.instance.tick()
    expect(s.events).toHaveLength(1)
    expect(s.events[0]?.type).toBe('needs_decision')
    expect(s.events[0]?.message).toContain('set_sleep_policy')

    s.vitals.vitals = buildVitals({ timeOfDay: 6000 })
    await s.instance.tick()
    s.vitals.vitals = buildVitals({ timeOfDay: NIGHT })
    await s.instance.tick()
    expect(s.events).toHaveLength(2)
    expect(s.started).toEqual([])
  })

  it('goes to bed by itself when idle, once per night', async () => {
    const s = await responder('when_idle')

    await s.instance.tick()
    await s.instance.tick()

    expect(s.started).toHaveLength(1)
    expect(s.events).toEqual([{ type: 'reflex', message: expect.stringContaining('going to bed') }])
  })

  it('waits while busy, and retries a refused start after a while', async () => {
    const s = await responder('when_idle')
    s.setBusy(true)
    await s.instance.tick()
    expect(s.started).toEqual([])

    s.setBusy(false)
    s.setStart({ ok: false, message: 'monsters nearby' })
    await s.instance.tick()
    await s.instance.tick()
    expect(s.started).toHaveLength(1)
    expect(s.events[0]?.message).toContain('monsters nearby')

    s.clock.advance(120_000)
    s.setStart({ ok: true, message: '' })
    await s.instance.tick()
    expect(s.started).toHaveLength(2)
  })

  it('does nothing by day, with policy never, in the Nether, without a known bed, or when disconnected', async () => {
    const day = await responder('when_idle')
    day.vitals.vitals = buildVitals({ timeOfDay: 6000 })
    await day.instance.tick()

    const never = await responder('never')
    await never.instance.tick()

    const nether = await responder('when_idle')
    nether.vitals.vitals = buildVitals({ timeOfDay: NIGHT, dimension: 'the_nether' })
    await nether.instance.tick()

    const noBed = await responder('when_idle')
    for (const bed of noBed.registry.all()) noBed.registry.remove(bed.id)
    await noBed.instance.tick()

    const away = await responder('ask')
    away.vitals.vitals = undefined
    await away.instance.tick()

    for (const r of [day, never, nether, noBed, away]) {
      expect(r.events).toEqual([])
      expect(r.started).toEqual([])
    }
  })
})
