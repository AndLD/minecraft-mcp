import { describe, expect, it } from '@jest/globals'
import { err, ok } from '../../../../src/core/result.js'
import type { SkillResult } from '../../../../src/core/skill.types.js'
import { DropCollector } from '../../../../src/skills/gathering/drop-collector.js'
import { AttackEntitySkill } from '../../../../src/skills/hunting/attack-entity-skill.js'
import { MAX_CHASE_MS } from '../../../../src/skills/hunting/animal-killer.js'
import {
  HuntAnimalsSkill,
  type HuntInput,
} from '../../../../src/skills/hunting/hunt-animals-skill.js'
import { PenDetector } from '../../../../src/skills/hunting/pen-detector.js'
import type { SmeltOutput } from '../../../../src/skills/smelting/smelt-items-skill.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeBlockScanner, FakeInventory } from '../../../fakes/fake-ports.js'
import {
  AutoScheduler,
  FakeDroppedItems,
  InstantNavigator,
  skillContext,
} from '../../../fakes/gathering-fakes.js'
import { animal, FakeAnimalScanner } from '../../../fakes/hunting-fakes.js'
import { FakeCombatant } from '../../../fakes/reflex-fakes.js'

const DROPS: Record<string, string> = { cow: 'beef', pig: 'porkchop', sheep: 'mutton' }

function setup() {
  const clock = new FakeClock()
  const scanner = new FakeAnimalScanner()
  const combatant = new FakeCombatant()
  const drops = new FakeDroppedItems()
  const navigator = new InstantNavigator()
  const inventory = new FakeInventory()
  inventory.value = { stacks: [], emptySlots: 30, heldItem: undefined }
  const blocks = new FakeBlockScanner()
  const smelted: { item: string; count: number | undefined }[] = []
  const smelterResult: { value: (item: string, count: number) => SkillResult<SmeltOutput> } = {
    value: (item, count) =>
      ok({ item, produced: `cooked_${item}`, smelted: count, requested: count, fuel: 'coal' }),
  }
  const skill = new HuntAnimalsSkill({
    animals: scanner,
    combatant,
    drops: new DropCollector({ drops, navigator, scheduler: new AutoScheduler(clock) }),
    inventory,
    smelter: {
      run: (input) => {
        smelted.push({ item: input.item, count: input.count })
        return Promise.resolve(smelterResult.value(input.item, input.count ?? 0))
      },
    },
    pens: new PenDetector(blocks),
    clock,
  })
  const attack = new AttackEntitySkill({
    animals: scanner,
    combatant,
    drops: new DropCollector({ drops, navigator, scheduler: new AutoScheduler(clock) }),
    clock,
  })

  const give = (name: string, count: number): void => {
    const stacks = inventory.value?.stacks ?? []
    inventory.value = {
      stacks: [...stacks, { name, count }],
      emptySlots: inventory.value?.emptySlots ?? 0,
      heldItem: undefined,
    }
  }
  /** One hit kills; the animal drops two of its meat where it stood; walking onto a drop picks it up. */
  combatant.onAttack = (id) => {
    const victim = scanner.find(id)
    if (victim === undefined) return
    scanner.kill(id)
    drops.drop(DROPS[victim.species] ?? 'leather', victim.position, victim.distance, 2)
  }
  navigator.onArrive = (target) => {
    for (const item of drops.items) {
      if (Math.hypot(item.position.x - target.x, item.position.z - target.z) > 1) continue
      give(item.name, item.count)
      drops.remove(item.entityId)
    }
  }
  return {
    clock,
    scanner,
    combatant,
    drops,
    navigator,
    inventory,
    skill,
    attack,
    smelted,
    smelterResult,
    give,
  }
}

const hunt = (over: Partial<HuntInput> = {}): HuntInput => ({
  species: ['cow'],
  goal: { kind: 'animals', count: 1 },
  radius: 24,
  keepBreeders: true,
  allowBabies: false,
  includePens: false,
  cook: false,
  timeLimitMs: 300_000,
  ...over,
})

const herd = (world: ReturnType<typeof setup>, count: number, species = 'cow'): void => {
  for (let i = 0; i < count; i += 1) world.scanner.animals.push(animal(species, 4 + i * 2))
}

describe('HuntAnimalsSkill', () => {
  it('kills the nearest animals until enough of the item is in the inventory', async () => {
    const world = setup()
    herd(world, 5)
    const { context, progress } = skillContext()

    const result = await world.skill.run(
      hunt({ goal: { kind: 'items', item: 'beef', count: 3 } }),
      context,
    )

    expect(result).toMatchObject({
      ok: true,
      value: {
        killed: 2,
        gained: [{ name: 'beef', count: 4 }],
        speciesBefore: { cow: 5 },
        speciesAfter: { cow: 3 },
        cooked: [],
      },
    })
    expect(world.combatant.attacks).toEqual([
      world.scanner.animals[0]?.id,
      world.scanner.animals[1]?.id,
    ])
    expect(world.combatant.gearCalls).toBe(1)
    expect(progress).toContain('Killed 2; 4 of 3 done')
  })

  it('kills a number of animals when the goal is animals', async () => {
    const world = setup()
    herd(world, 6)

    const result = await world.skill.run(
      hunt({ goal: { kind: 'animals', count: 3 } }),
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { killed: 3 } })
  })

  it('tells the caller how far it got, so a resumed hunt only does the rest', async () => {
    const world = setup()
    herd(world, 5)
    const seen: number[] = []

    await world.skill.run(
      hunt({ goal: { kind: 'animals', count: 2 }, onProgress: (n) => seen.push(n) }),
      skillContext().context,
    )

    expect(seen).toEqual([1, 2])
  })

  it('counts any colour of wool toward a wool goal', async () => {
    const world = setup()
    herd(world, 4, 'sheep')
    world.combatant.onAttack = (id) => {
      world.scanner.kill(id)
      world.give('red_wool', 1)
    }

    const result = await world.skill.run(
      hunt({ species: ['sheep'], goal: { kind: 'items', item: 'wool', count: 2 } }),
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { killed: 2 } })
  })

  describe('protection', () => {
    it('stops at the last breeding pair and says so', async () => {
      const world = setup()
      herd(world, 3)

      const result = await world.skill.run(
        hunt({ goal: { kind: 'animals', count: 5 } }),
        skillContext().context,
      )

      expect(result).toMatchObject({
        ok: false,
        error: { reason: 'breeding_floor', detail: { killed: 1, remaining: 4 } },
      })
      expect(!result.ok && result.error.message).toContain('last breeding pair')
      expect(world.combatant.attacks).toHaveLength(1)
    })

    it('hunts them all when told not to keep breeders', async () => {
      const world = setup()
      herd(world, 2)

      const result = await world.skill.run(
        hunt({ goal: { kind: 'animals', count: 2 }, keepBreeders: false }),
        skillContext().context,
      )

      expect(result).toMatchObject({ ok: true, value: { killed: 2 } })
    })

    it('never touches named, tamed, saddled, ridden, or baby animals, and reports them', async () => {
      const world = setup()
      world.scanner.animals = [
        animal('cow', 3, { named: true }),
        animal('cow', 4, { owned: true }),
        animal('cow', 5, { saddled: true }),
        animal('cow', 6, { ridden: true }),
        animal('cow', 7, { baby: true }),
      ]

      const result = await world.skill.run(hunt(), skillContext().context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'protected' } })
      expect(!result.ok && result.error.message).toContain('has a name tag')
      expect(!result.ok && result.error.message).toContain('is a baby')
      expect(world.combatant.attacks).toEqual([])
    })

    it('leaves animals in a pen alone', async () => {
      const world = setup()
      herd(world, 4)
      const fenced = new PenDetector({ blockAt: () => 'oak_fence' } as never)
      // Rebuild the skill with a pen detector that sees fences everywhere.
      const skill = new HuntAnimalsSkill({
        animals: world.scanner,
        combatant: world.combatant,
        drops: new DropCollector({
          drops: world.drops,
          navigator: world.navigator,
          scheduler: new AutoScheduler(world.clock),
        }),
        inventory: world.inventory,
        smelter: { run: () => Promise.resolve(err({ reason: 'x', message: 'x' })) },
        pens: fenced,
        clock: world.clock,
      })

      const result = await skill.run(hunt(), skillContext().context)
      const overridden = await skill.run(hunt({ includePens: true }), skillContext().context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'protected' } })
      expect(!result.ok && result.error.message).toContain('is in a pen')
      expect(overridden.ok).toBe(true)
    })

    it('refuses species that are not livestock', async () => {
      const world = setup()

      const result = await world.skill.run(
        hunt({ species: ['wolf', 'cow', 'villager'] }),
        skillContext().context,
      )

      expect(result).toMatchObject({ ok: false, error: { reason: 'not_huntable' } })
      expect(!result.ok && result.error.message).toContain('wolf, villager')
    })
  })

  it('reports when there is nothing to hunt', async () => {
    const world = setup()
    world.scanner.animals = [animal('pig', 3)]

    const result = await world.skill.run(hunt(), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_animals' } })
  })

  describe('when animals get away', () => {
    it('gives up on one that cannot be caught and hunts the next', async () => {
      const world = setup()
      herd(world, 4)
      const runner = world.scanner.animals[0]?.id ?? 0
      const original = world.combatant.onAttack
      world.combatant.onAttack = (id) => {
        if (id === runner) {
          world.clock.advance(MAX_CHASE_MS / 2) // a long chase, no kill
          world.combatant.results = [ok('still_fighting')]
          return
        }
        original(id)
      }

      const result = await world.skill.run(hunt(), skillContext().context)

      expect(result).toMatchObject({ ok: true, value: { killed: 1 } })
      expect(world.combatant.attacks.filter((id) => id === runner).length).toBeGreaterThan(1)
      expect(world.combatant.attacks.at(-1)).not.toBe(runner)
    })

    it('moves on when the animal runs out of view', async () => {
      const world = setup()
      herd(world, 4)
      const first = world.scanner.animals[0]?.id ?? 0
      const original = world.combatant.onAttack
      world.combatant.onAttack = (id) => {
        if (id === first) world.scanner.vanish(id)
        else original(id)
      }

      const result = await world.skill.run(hunt(), skillContext().context)

      expect(result).toMatchObject({ ok: true, value: { killed: 1 } })
    })

    it('gives up altogether after too many animals could not be caught', async () => {
      const world = setup()
      for (let i = 0; i < 35; i += 1) world.scanner.animals.push(animal('cow', 3 + i * 0.1))
      world.combatant.onAttack = (id) => {
        world.scanner.vanish(id)
      }

      const result = await world.skill.run(hunt(), skillContext().context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'unreachable' } })
    })
  })

  describe('stopping early', () => {
    it('stops when cancelled, keeping what it has', async () => {
      const world = setup()
      herd(world, 6)
      const { context, controller } = skillContext()
      const original = world.combatant.onAttack
      world.combatant.onAttack = (id) => {
        original(id)
        controller.abort()
      }

      const result = await world.skill.run(hunt({ goal: { kind: 'animals', count: 4 } }), context)

      expect(result).toMatchObject({
        ok: false,
        error: { reason: 'aborted', detail: { killed: 1 } },
      })
    })

    it('stops when the attack itself is cancelled', async () => {
      const world = setup()
      herd(world, 4)
      world.combatant.results = [err({ reason: 'aborted', message: 'Cancelled.' })]

      const result = await world.skill.run(hunt(), skillContext().context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    })

    it('stops when the connection is lost', async () => {
      const world = setup()
      herd(world, 4)
      world.combatant.results = [err({ reason: 'not_connected', message: 'gone' })]

      const result = await world.skill.run(hunt(), skillContext().context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'not_connected' } })
    })

    it('stops at the time limit', async () => {
      const world = setup()
      herd(world, 8)
      world.combatant.onAttack = (id) => {
        world.clock.advance(40_000)
        world.scanner.kill(id)
      }

      const result = await world.skill.run(
        hunt({ goal: { kind: 'animals', count: 5 }, timeLimitMs: 100_000 }),
        skillContext().context,
      )

      expect(result).toMatchObject({ ok: false, error: { reason: 'time_limit' } })
      expect(world.combatant.attacks).toHaveLength(3)
    })

    it('stops when the inventory is full, and when it cannot be read', async () => {
      const world = setup()
      herd(world, 4)
      world.inventory.value = { stacks: [], emptySlots: 0, heldItem: undefined }

      const full = await world.skill.run(hunt(), skillContext().context)
      world.inventory.value = undefined
      const disconnected = await world.skill.run(hunt(), skillContext().context)

      expect(full).toMatchObject({ ok: false, error: { reason: 'inventory_full' } })
      expect(disconnected).toMatchObject({ ok: false, error: { reason: 'not_connected' } })
    })
  })

  describe('cooking', () => {
    it('cooks the raw meat it brought in', async () => {
      const world = setup()
      herd(world, 5)
      const { progress, context } = skillContext()

      const result = await world.skill.run(
        hunt({ goal: { kind: 'animals', count: 2 }, cook: true }),
        context,
      )

      expect(world.smelted).toEqual([{ item: 'beef', count: 4 }])
      expect(result).toMatchObject({
        ok: true,
        value: { cooked: [{ name: 'cooked_beef', count: 4 }] },
      })
      expect(progress).toContain('Cooking 4 beef')
    })

    it('does not cook leather or feathers, or anything when not asked', async () => {
      const world = setup()
      herd(world, 5)

      await world.skill.run(hunt({ goal: { kind: 'animals', count: 2 } }), skillContext().context)
      world.combatant.onAttack = (id) => {
        world.scanner.kill(id)
        world.give('leather', 1)
      }
      await world.skill.run(hunt({ cook: true }), skillContext().context)

      expect(world.smelted).toEqual([])
    })

    it('reports a cooking problem without failing the hunt', async () => {
      const world = setup()
      herd(world, 5)
      world.smelterResult.value = () => err({ reason: 'no_fuel', message: 'The bot has no fuel.' })

      const result = await world.skill.run(hunt({ cook: true }), skillContext().context)

      expect(result).toMatchObject({
        ok: true,
        value: { killed: 1, cooked: [], cookProblem: 'beef: The bot has no fuel.' },
      })
    })

    it('does not start cooking once cancelled', async () => {
      const world = setup()
      herd(world, 5)
      const { context, controller } = skillContext()
      world.smelterResult.value = () => {
        controller.abort()
        return ok({ item: 'beef', produced: 'cooked_beef', smelted: 2, requested: 2, fuel: 'coal' })
      }

      const result = await world.skill.run(
        hunt({ goal: { kind: 'animals', count: 2 }, cook: true }),
        context,
      )

      expect(result.ok).toBe(true)
    })
  })
})

describe('AttackEntitySkill', () => {
  const byId = (id: number, force = false) => ({
    target: { kind: 'id' as const, id },
    force,
    radius: 16,
  })

  it('kills the animal it is told to and picks up the drops', async () => {
    const world = setup()
    world.scanner.animals = [animal('cow', 4)]
    const id = world.scanner.animals[0]?.id ?? 0

    const result = await world.attack.run(byId(id), skillContext().context)

    expect(result).toEqual({ ok: true, value: { species: 'cow', killed: true } })
    expect(world.combatant.attacks).toEqual([id])
    expect(world.inventory.value?.stacks).toEqual([{ name: 'beef', count: 2 }])
  })

  it('finds the nearest animal of a species', async () => {
    const world = setup()
    world.scanner.animals = [animal('pig', 2), animal('cow', 9), animal('cow', 5)]
    const nearest = world.scanner.animals[2]?.id ?? 0

    const result = await world.attack.run(
      { target: { kind: 'nearest', species: 'cow' }, force: false, radius: 16 },
      skillContext().context,
    )

    expect(result.ok).toBe(true)
    expect(world.combatant.attacks).toEqual([nearest])
  })

  it('reports an animal that is not there', async () => {
    const world = setup()

    const byNumber = await world.attack.run(byId(999), skillContext().context)
    const bySpecies = await world.attack.run(
      { target: { kind: 'nearest', species: 'cow' }, force: false, radius: 16 },
      skillContext().context,
    )

    expect(byNumber).toMatchObject({ ok: false, error: { reason: 'target_not_found' } })
    expect(bySpecies).toMatchObject({ ok: false, error: { reason: 'target_not_found' } })
    expect(!bySpecies.ok && bySpecies.error.message).toBe('No cow within 16 blocks.')
  })

  it.each([
    ['named', { named: true }],
    ['tamed', { species: 'wolf', owned: true }],
    ['saddled', { species: 'pig', saddled: true }],
  ])('refuses a %s animal unless forced', async (_name, over) => {
    const world = setup()
    world.scanner.animals = [animal('cow', 4, over)]
    const id = world.scanner.animals[0]?.id ?? 0

    const refused = await world.attack.run(byId(id), skillContext().context)
    const forced = await world.attack.run(byId(id, true), skillContext().context)

    expect(refused).toMatchObject({ ok: false, error: { reason: 'protected' } })
    expect(forced.ok).toBe(true)
  })

  it('refuses a species that is not livestock unless forced', async () => {
    const world = setup()
    world.scanner.animals = [animal('villager', 4)]
    const id = world.scanner.animals[0]?.id ?? 0

    const result = await world.attack.run(byId(id), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'protected' } })
    expect(!result.ok && result.error.message).toContain('not livestock')
  })

  it('attacks a baby when told to by name (the order is explicit)', async () => {
    const world = setup()
    world.scanner.animals = [animal('cow', 4, { baby: true })]

    const result = await world.attack.run(
      byId(world.scanner.animals[0]?.id ?? 0),
      skillContext().context,
    )

    expect(result.ok).toBe(true)
  })

  it('says when the animal got away, is cancelled, or the connection drops', async () => {
    const world = setup()
    world.scanner.animals = [animal('cow', 4)]
    const id = world.scanner.animals[0]?.id ?? 0
    world.combatant.onAttack = () => {
      world.scanner.vanish(id)
    }
    const away = await world.attack.run(byId(id), skillContext().context)

    world.scanner.animals = [animal('cow', 4)]
    const next = world.scanner.animals[0]?.id ?? 0
    world.combatant.onAttack = () => undefined
    world.combatant.results = [err({ reason: 'aborted', message: 'Cancelled.' })]
    const cancelled = await world.attack.run(byId(next), skillContext().context)

    world.combatant.results = [err({ reason: 'not_connected', message: 'gone' })]
    const lost = await world.attack.run(byId(next), skillContext().context)

    expect(away).toMatchObject({ ok: false, error: { reason: 'target_lost' } })
    expect(cancelled).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    expect(lost).toMatchObject({ ok: false, error: { reason: 'not_connected' } })
  })

  it('gives up on an animal it cannot catch', async () => {
    const world = setup()
    world.scanner.animals = [animal('cow', 4)]
    const id = world.scanner.animals[0]?.id ?? 0
    world.combatant.onAttack = () => {
      world.clock.advance(MAX_CHASE_MS)
      world.combatant.results = [ok('still_fighting')]
    }

    const result = await world.attack.run(byId(id), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'target_lost' } })
  })
})
