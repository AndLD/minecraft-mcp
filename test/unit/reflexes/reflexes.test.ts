import { describe, expect, it } from '@jest/globals'
import { err, type Result } from '../../../src/core/result.js'
import { AutoEat, EAT_AT_OR_BELOW } from '../../../src/reflexes/auto-eat.js'
import { AvoidLava } from '../../../src/reflexes/avoid-lava.js'
import { Drowning, SURFACE_BELOW } from '../../../src/reflexes/drowning.js'
import { SafeSpotFinder } from '../../../src/reflexes/safe-spot.js'
import { ThreatResponse } from '../../../src/reflexes/threat-response.js'
import {
  buildVitals,
  FakeBlockScanner,
  FakeEntityScanner,
  FakeInventory,
} from '../../fakes/fake-ports.js'
import {
  entity,
  FakeCombatant,
  FakeEater,
  FakeFoodCatalog,
  FakeLocomotion,
  FakeReflexContext,
  InstantNavigator,
  reflexState,
} from '../../fakes/reflex-fakes.js'

/** A flat world: solid floor at y=63, air above, for the given square around the origin. */
function flatWorld(
  radius = 10,
  lava: readonly { x: number; y: number; z: number }[] = [],
): FakeBlockScanner {
  const blocks = new FakeBlockScanner()
  for (let x = -radius; x <= radius; x += 1) {
    for (let z = -radius; z <= radius; z += 1) {
      blocks.solid.set(`${String(x)},63,${String(z)}`, true)
      for (const y of [64, 65]) blocks.solid.set(`${String(x)},${String(y)},${String(z)}`, false)
    }
  }
  for (const spot of lava)
    blocks.blockNames.set(`${String(spot.x)},${String(spot.y)},${String(spot.z)}`, 'lava')
  return blocks
}

describe('SafeSpotFinder', () => {
  it('finds the nearest standable spot, at the middle of the block', () => {
    const spot = new SafeSpotFinder(flatWorld()).find({ x: 0.5, y: 64, z: 0.5 }, ['lava'])

    // the first free spot on the ring one block out, at the middle of its block
    expect(spot).toEqual({ x: -0.5, y: 64, z: -0.5 })
  })

  it('skips spots next to lava and finds one beyond', () => {
    const blocks = flatWorld(10, [{ x: 1, y: 64, z: 0 }])

    const spot = new SafeSpotFinder(blocks).find({ x: 0.5, y: 64, z: 0.5 }, ['lava'])

    expect(spot).toBeDefined()
    // never within one block of the lava at (1, 64, 0)
    expect(
      Math.max(Math.abs(Math.floor(spot?.x ?? 0) - 1), Math.abs(Math.floor(spot?.z ?? 0) - 0)),
    ).toBeGreaterThan(1)
  })

  it('needs a solid floor and two free blocks above', () => {
    const blocks = flatWorld(3)
    for (let x = -3; x <= 3; x += 1)
      for (let z = -3; z <= 3; z += 1) blocks.solid.set(`${String(x)},65,${String(z)}`, true) // a low ceiling

    expect(new SafeSpotFinder(blocks).find({ x: 0.5, y: 64, z: 0.5 }, ['lava'])).toBeUndefined()
  })

  it('does not stand on unloaded ground', () => {
    expect(
      new SafeSpotFinder(new FakeBlockScanner()).find({ x: 0.5, y: 64, z: 0.5 }, ['lava']),
    ).toBeUndefined()
  })

  it('can avoid water as well (for surfacing)', () => {
    const blocks = flatWorld(10)
    blocks.blockNames.set('1,64,0', 'water')
    blocks.blockNames.set('1,64,-1', 'water')

    const spot = new SafeSpotFinder(blocks).find({ x: 0.5, y: 64, z: 0.5 }, ['water', 'lava'])

    expect(spot).toBeDefined()
    expect(
      blocks.blockNames.get(
        `${String(Math.floor(spot?.x ?? 0))},64,${String(Math.floor(spot?.z ?? 0))}`,
      ),
    ).toBeUndefined()
  })
})

describe('AutoEat', () => {
  function setup(stacks: { name: string; count: number }[], eaterResult?: Result<void>) {
    const inventory = new FakeInventory()
    inventory.value = { stacks, emptySlots: 30, heldItem: undefined }
    const eater = new FakeEater()
    if (eaterResult !== undefined) eater.result = eaterResult
    return { eater, reflex: new AutoEat({ inventory, catalog: new FakeFoodCatalog(), eater }) }
  }

  it('is a background reflex that does not stop the current task', () => {
    const { reflex } = setup([])

    expect(reflex.preemptsTask).toBe(false)
    expect(reflex.priority).toBeLessThan(
      new ThreatResponse({
        combatant: new FakeCombatant(),
        navigator: new InstantNavigator(),
        entities: new FakeEntityScanner(),
        lowHealthThreshold: 8,
        owner: undefined,
      }).priority,
    )
  })

  it('wants to eat at or below the hunger level, when there is food', () => {
    const { reflex } = setup([{ name: 'bread', count: 3 }])

    expect(reflex.wants(reflexState({ food: EAT_AT_OR_BELOW }))).toBe(true)
    expect(reflex.wants(reflexState({ food: EAT_AT_OR_BELOW + 1 }))).toBe(false)
  })

  it('also eats when hurt and not quite full, so health can regenerate', () => {
    const { reflex } = setup([{ name: 'bread', count: 1 }])

    expect(reflex.wants(reflexState({ health: 12, food: 17 }))).toBe(true)
    expect(reflex.wants(reflexState({ health: 12, food: 18 }))).toBe(false)
    expect(reflex.wants(reflexState({ health: 15, food: 17 }))).toBe(false)
  })

  it('eats the best food and says so', async () => {
    const { reflex, eater } = setup([
      { name: 'apple', count: 2 },
      { name: 'cooked_beef', count: 4 },
    ])
    const state = reflexState({ food: 10 })
    const context = new FakeReflexContext([reflexState({ food: 18 })])

    const outcome = await reflex.run(context, state)

    expect(eater.eaten).toEqual(['cooked_beef'])
    expect(context.emitted).toEqual(['Ate cooked_beef (food 10 → 18).'])
    expect(outcome).toEqual({ resumeTask: true })
  })

  it('says the new food level is unknown when the bot left the world', async () => {
    const { reflex } = setup([{ name: 'bread', count: 1 }])
    const context = new FakeReflexContext([undefined])

    await reflex.run(context, reflexState({ food: 10 }))

    expect(context.emitted[0]).toContain('→ ?')
  })

  it('warns once, and then only every few minutes, when there is nothing safe to eat', async () => {
    const { reflex } = setup([
      { name: 'rotten_flesh', count: 5 },
      { name: 'golden_apple', count: 1 },
    ])
    const hungry = reflexState({ food: 6, now: 0 })
    const context = new FakeReflexContext()

    expect(reflex.wants(hungry)).toBe(true)
    await reflex.run(context, hungry)
    expect(context.emitted).toEqual(['Hungry (food 6/20) but there is nothing safe to eat.'])

    expect(reflex.wants(reflexState({ food: 6, now: 60_000 }))).toBe(false)
    expect(reflex.wants(reflexState({ food: 6, now: 5 * 60_000 }))).toBe(true)
  })

  it('tells its owner of the reflex when it is hungry with nothing to eat, but not when it can eat', async () => {
    const calls: string[] = []
    const inventory = new FakeInventory()
    inventory.value = { stacks: [], emptySlots: 30, heldItem: undefined }
    const reflex = new AutoEat({
      inventory,
      catalog: new FakeFoodCatalog(),
      eater: new FakeEater(),
      onNoFood: () => {
        calls.push('no food')
      },
    })
    const state = reflexState({ food: 6, now: 0 })

    await reflex.run(new FakeReflexContext(), state)
    inventory.value = { stacks: [{ name: 'bread', count: 1 }], emptySlots: 30, heldItem: undefined }
    await reflex.run(new FakeReflexContext(), state)

    expect(calls).toEqual(['no food'])
  })

  it('does not want to act while not connected to a world (no inventory)', () => {
    const reflex = new AutoEat({
      inventory: new FakeInventory(),
      catalog: new FakeFoodCatalog(),
      eater: new FakeEater(),
    })

    expect(reflex.wants(reflexState({ food: 6, now: 0 }))).toBe(true) // it can still warn once
  })

  it('pauses after a failed attempt instead of retrying every tick', async () => {
    const { reflex, eater } = setup([{ name: 'bread', count: 1 }], err('Could not eat bread: nope'))
    const state = reflexState({ food: 8, now: 1000 })
    const context = new FakeReflexContext()

    await reflex.run(context, state)

    expect(eater.eaten).toEqual(['bread'])
    expect(context.emitted).toEqual(['Could not eat bread: nope'])
    expect(reflex.wants(reflexState({ food: 8, now: 5000 }))).toBe(false)
    expect(reflex.wants(reflexState({ food: 8, now: 12_000 }))).toBe(true)
  })
})

describe('AvoidLava', () => {
  function setup(blocks = flatWorld()) {
    const navigator = new InstantNavigator()
    const locomotion = new FakeLocomotion()
    const reflex = new AvoidLava({
      blocks,
      navigator,
      locomotion,
      safeSpots: new SafeSpotFinder(blocks),
    })
    return { blocks, navigator, locomotion, reflex }
  }

  it('is the most important reflex and takes over movement', () => {
    const { reflex } = setup()

    expect(reflex.priority).toBe(100)
    expect(reflex.preemptsTask).toBe(true)
  })

  it('wants to act when in lava', () => {
    const { reflex } = setup()

    expect(reflex.wants(reflexState({ vitals: buildVitals({ inLava: true }) }))).toBe(true)
  })

  it('wants to act when lava is next to the bot, at feet, head, or below level, but not two blocks away', () => {
    const at = { x: 0.5, y: 64, z: 0.5 }
    for (const lava of [
      { x: 1, y: 64, z: 0 },
      { x: 0, y: 65, z: -1 },
      { x: 0, y: 63, z: 0 },
      { x: -1, y: 63, z: 1 },
    ]) {
      const { reflex } = setup(flatWorld(10, [lava]))
      expect(reflex.wants(reflexState({ vitals: buildVitals({ position: at }) }))).toBe(true)
    }
    const { reflex } = setup(flatWorld(10, [{ x: 2, y: 64, z: 0 }]))
    expect(reflex.wants(reflexState({ vitals: buildVitals({ position: at }) }))).toBe(false)
  })

  it('does nothing about a bot on dry land with no lava around', () => {
    const { reflex } = setup()

    expect(reflex.wants(reflexState())).toBe(false)
  })

  it('walks to a safe spot and says so; a bot that is in lava also swims up', async () => {
    const lava = [{ x: 0, y: 64, z: 0 }]
    const { reflex, navigator, locomotion } = setup(flatWorld(10, lava))
    const inLava = reflexState({
      vitals: buildVitals({ inLava: true, position: { x: 0.5, y: 64, z: 0.5 } }),
    })
    const context = new FakeReflexContext([
      reflexState({ vitals: buildVitals({ position: { x: 5.5, y: 64, z: 0.5 } }) }),
    ])

    const outcome = await reflex.run(context, inLava)

    expect(context.emitted[0]).toBe('In lava! Getting out.')
    expect(navigator.goTos).toHaveLength(1)
    expect(locomotion.jumps).toEqual([true, false]) // jump while in lava, released at the end
    expect(outcome).toEqual({ resumeTask: true })
  })

  it('tells the difference between being in lava and standing next to it', async () => {
    const { reflex } = setup(flatWorld(10, [{ x: 1, y: 64, z: 0 }]))
    const context = new FakeReflexContext([
      reflexState({ vitals: buildVitals({ position: { x: 6.5, y: 64, z: 6.5 } }) }),
    ])

    await reflex.run(
      context,
      reflexState({ vitals: buildVitals({ position: { x: 0.5, y: 64, z: 0.5 } }) }),
    )

    expect(context.emitted[0]).toBe('Lava next to me: moving away.')
  })

  it('gives up and says so when there is nowhere safe to go', async () => {
    const { reflex, navigator } = setup(new FakeBlockScanner())
    const context = new FakeReflexContext()
    const state = reflexState({ vitals: buildVitals({ inLava: true }) })

    await reflex.run(context, state)

    expect(context.emitted).toEqual([
      'In lava! Getting out.',
      'No safe spot away from the lava was found.',
    ])
    expect(navigator.goTos).toEqual([])
  })

  it('stops when told to, and always releases the jump key', async () => {
    const { reflex, locomotion } = setup(flatWorld(10, [{ x: 0, y: 64, z: 0 }]))
    const context = new FakeReflexContext([reflexState({ vitals: buildVitals({ inLava: true }) })])
    context.controller.abort()

    await reflex.run(context, reflexState({ vitals: buildVitals({ inLava: true }) }))

    expect(locomotion.jumps.at(-1)).toBe(false)
  })
})

describe('Drowning', () => {
  function setup() {
    const blocks = flatWorld()
    const navigator = new InstantNavigator()
    const locomotion = new FakeLocomotion()
    return {
      blocks,
      navigator,
      locomotion,
      reflex: new Drowning({ navigator, locomotion, safeSpots: new SafeSpotFinder(blocks) }),
    }
  }
  const underwater = (oxygen: number) =>
    reflexState({ vitals: buildVitals({ headUnderwater: true, inWater: true, oxygen }) })

  it('wants to act only when the head is under water and the air is running low', () => {
    const { reflex } = setup()

    expect(reflex.wants(underwater(SURFACE_BELOW))).toBe(true)
    expect(reflex.wants(underwater(SURFACE_BELOW + 1))).toBe(false)
    expect(
      reflex.wants(
        reflexState({ vitals: buildVitals({ inWater: true, headUnderwater: false, oxygen: 2 }) }),
      ),
    ).toBe(false)
    expect(reflex.wants(reflexState())).toBe(false)
  })

  it('swims up until the head is out of the water, then lets go of the jump key', async () => {
    const { reflex, locomotion, navigator } = setup()
    const context = new FakeReflexContext([
      reflexState({ vitals: buildVitals({ inWater: true, headUnderwater: false, oxygen: 10 }) }),
    ])

    const outcome = await reflex.run(context, underwater(4))

    expect(context.emitted).toEqual(['Running out of air (4/20): swimming to the surface.'])
    expect(locomotion.jumps).toEqual([true, false])
    expect(navigator.goTos).toHaveLength(1)
    expect(outcome).toEqual({ resumeTask: true })
  })

  it('keeps holding jump while there is no dry spot in reach, without spinning', async () => {
    const reflex = new Drowning({
      navigator: new InstantNavigator(),
      locomotion: new FakeLocomotion(),
      safeSpots: new SafeSpotFinder(new FakeBlockScanner()),
    })
    const context = new FakeReflexContext([underwater(3), underwater(3), reflexState()])

    await reflex.run(context, underwater(3))

    expect(context.sleeps.length).toBeGreaterThan(0)
  })

  it('is second in importance, below lava', () => {
    const { reflex } = setup()

    expect(reflex.priority).toBe(90)
    expect(reflex.preemptsTask).toBe(true)
  })
})

describe('ThreatResponse', () => {
  function setup(options: { owner?: string; lowHealthThreshold?: number } = {}) {
    const combatant = new FakeCombatant()
    const navigator = new InstantNavigator()
    const entities = new FakeEntityScanner()
    const reflex = new ThreatResponse({
      combatant,
      navigator,
      entities,
      lowHealthThreshold: options.lowHealthThreshold ?? 8,
      owner: options.owner,
    })
    return { combatant, navigator, entities, reflex }
  }

  it('wants to act exactly when the policy says to fight or flee', () => {
    const { reflex } = setup()

    expect(reflex.wants(reflexState({ entities: [entity('zombie', 5)] }))).toBe(true)
    expect(reflex.wants(reflexState({ entities: [entity('creeper', 5)] }))).toBe(true)
    expect(reflex.wants(reflexState({ entities: [entity('enderman', 2)] }))).toBe(false)
    expect(reflex.wants(reflexState())).toBe(false)
  })

  describe('fighting', () => {
    it('gears up, fights, and reports it, then hands control back for the task to resume', async () => {
      const { reflex, combatant } = setup()
      combatant.gear = { weapon: 'iron_sword', armor: ['iron_helmet'] }
      const zombie = entity('zombie', 4)
      const context = new FakeReflexContext([reflexState()])

      const outcome = await reflex.run(context, reflexState({ health: 18, entities: [zombie] }))

      expect(combatant.gearCalls).toBe(1)
      expect(combatant.attacks).toEqual([zombie.id])
      expect(context.emitted).toEqual([
        'Put on iron_helmet.',
        'Fighting a zombie (health 18/20).',
        'The zombie is gone.',
      ])
      expect(outcome).toEqual({ resumeTask: true })
    })

    it('keeps fighting slices until the target is gone', async () => {
      const { reflex, combatant } = setup()
      const zombie = entity('zombie', 4)
      combatant.results = [
        { ok: true, value: 'still_fighting' },
        { ok: true, value: 'still_fighting' },
        { ok: true, value: 'target_gone' },
      ]
      const busy = reflexState({ entities: [zombie] })
      const context = new FakeReflexContext([busy, busy, reflexState()])

      await reflex.run(context, busy)

      expect(combatant.attacks).toHaveLength(3)
      expect(combatant.gearCalls).toBe(1) // gears up once per fight
      expect(context.emitted.filter((m) => m.startsWith('Fighting'))).toHaveLength(1)
    })

    it('moves on to the next mob and announces each new target', async () => {
      const { reflex, combatant } = setup()
      const first = entity('zombie', 3)
      const second = entity('spider', 4)
      const context = new FakeReflexContext([reflexState({ entities: [second] }), reflexState()])

      await reflex.run(context, reflexState({ entities: [first, second] }))

      expect(combatant.attacks).toEqual([first.id, second.id])
      expect(
        context.emitted.filter((m) => m.startsWith('Fighting')).map((m) => m.split(' ')[2]),
      ).toEqual(['zombie', 'spider'])
    })

    it('does not say the mob is gone when the fight was only paused', async () => {
      const { reflex, combatant } = setup()
      combatant.results = [{ ok: true, value: 'still_fighting' }]
      const busy = reflexState({ entities: [entity('zombie', 4)] })
      const context = new FakeReflexContext([reflexState()])

      await reflex.run(context, busy)

      expect(context.emitted.some((m) => m.includes('is gone'))).toBe(false)
    })

    it('stops when aborted', async () => {
      const { reflex, combatant } = setup()
      const zombie = entity('zombie', 4)
      const context = new FakeReflexContext([reflexState({ entities: [zombie] })])
      combatant.onAttack = () => {
        context.controller.abort()
      }

      await reflex.run(context, reflexState({ entities: [zombie] }))

      expect(combatant.attacks).toHaveLength(1)
    })
  })

  describe('fleeing', () => {
    it('runs away from a creeper, does not resume the task, and says when it is safe again', async () => {
      const { reflex, navigator, combatant } = setup()
      const creeper = entity('creeper', 6)
      const context = new FakeReflexContext([reflexState()])

      const outcome = await reflex.run(context, reflexState({ entities: [creeper] }))

      expect(navigator.goTos).toHaveLength(1)
      expect(combatant.attacks).toEqual([])
      expect(context.emitted).toEqual([
        'Running away from creeper.',
        'Safe again: no threat nearby.',
      ])
      expect(outcome).toEqual({ resumeTask: false })
    })

    it('runs away from a skeleton at any health, with the same rule', async () => {
      const { reflex } = setup()
      const context = new FakeReflexContext([reflexState()])

      const outcome = await reflex.run(context, reflexState({ entities: [entity('skeleton', 12)] }))

      expect(context.emitted[0]).toBe('Running away from skeleton.')
      expect(outcome.resumeTask).toBe(false)
    })

    it('flees from a mob it would otherwise fight when health is low, naming the reason', async () => {
      const { reflex, combatant } = setup()
      const context = new FakeReflexContext([reflexState()])

      await reflex.run(context, reflexState({ health: 5, entities: [entity('zombie', 3)] }))

      expect(context.emitted[0]).toBe('Low health (5/20): running away from zombie.')
      expect(combatant.attacks).toEqual([])
    })

    it('switches from fighting to fleeing as soon as health drops to the threshold', async () => {
      const { reflex, combatant, navigator } = setup()
      const zombie = entity('zombie', 3)
      const context = new FakeReflexContext([
        reflexState({ health: 8, entities: [zombie] }),
        reflexState(),
      ])
      combatant.results = [{ ok: true, value: 'still_fighting' }]

      const outcome = await reflex.run(context, reflexState({ health: 12, entities: [zombie] }))

      expect(combatant.attacks).toHaveLength(1)
      expect(navigator.goTos).toHaveLength(1)
      expect(outcome.resumeTask).toBe(false)
    })

    it('keeps running until the threat is beyond its radius plus the margin', async () => {
      const { reflex, navigator } = setup()
      const context = new FakeReflexContext([
        reflexState({ entities: [entity('creeper', 14)] }), // beyond 10, inside 10 + 8: still running
        reflexState({ entities: [entity('creeper', 20)] }),
      ])

      await reflex.run(context, reflexState({ entities: [entity('creeper', 6)] }))

      expect(navigator.goTos).toHaveLength(2)
    })

    it('tries a different direction when the first is blocked', async () => {
      const { reflex, navigator } = setup()
      navigator.result = err({ reason: 'unreachable', message: 'No path.' })
      const creeper = entity('creeper', 6)
      const busy = reflexState({ entities: [creeper] })
      const context = new FakeReflexContext([busy, busy, reflexState()])

      await reflex.run(context, busy)

      const targets = navigator.goTos.map(
        (g) => `${g.target.x.toFixed(1)},${g.target.z.toFixed(1)}`,
      )
      expect(new Set(targets).size).toBe(targets.length)
      expect(targets.length).toBeGreaterThanOrEqual(3)
    })

    it('prefers running towards the owner', async () => {
      const { reflex, navigator, entities } = setup({ owner: 'Andrey_Knight' })
      entities.players.set('andrey_knight', {
        name: 'Andrey_Knight',
        online: true,
        position: { x: 0, y: 64, z: 40 },
        distance: 40,
      })
      const creeper = entity('creeper', 6, { position: { x: 0, y: 64, z: -6 } })
      const context = new FakeReflexContext([reflexState()])

      await reflex.run(context, reflexState({ entities: [creeper] }))

      expect(navigator.goTos[0]?.target.z).toBeGreaterThan(10)
    })

    it('says it is safe again when the engine ended the reflex because the threat left', async () => {
      const { reflex, navigator } = setup()
      const context = new FakeReflexContext([
        reflexState({ entities: [entity('creeper', 6)] }),
        reflexState(),
      ])
      navigator.onGoTo = () => {
        context.controller.abort() // the engine aborts it: nothing wants to act any more
      }

      await reflex.run(context, reflexState({ entities: [entity('creeper', 6)] }))

      expect(context.emitted).toEqual([
        'Running away from creeper.',
        'Safe again: no threat nearby.',
      ])
    })

    it('does not announce being safe when it was interrupted by something else and the threat is still there', async () => {
      const { reflex, navigator } = setup()
      const context = new FakeReflexContext([reflexState({ entities: [entity('creeper', 6)] })])
      navigator.onGoTo = () => {
        context.controller.abort()
      }

      await reflex.run(context, reflexState({ entities: [entity('creeper', 6)] }))

      expect(context.emitted).not.toContain('Safe again: no threat nearby.')
    })
  })

  it('ends when the bot leaves the world', async () => {
    const { reflex } = setup()
    const context = new FakeReflexContext([undefined])

    await expect(
      reflex.run(context, reflexState({ entities: [entity('creeper', 6)] })),
    ).resolves.toEqual({ resumeTask: false })
  })
})
