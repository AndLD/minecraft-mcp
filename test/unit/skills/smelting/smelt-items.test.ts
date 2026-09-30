import { describe, expect, it } from '@jest/globals'
import { SmeltItemsSkill } from '../../../../src/skills/smelting/smelt-items-skill.js'
import { SMELTABLE_ITEMS, SMELTING_TABLE } from '../../../../src/skills/smelting/smelting-table.js'
import { PlacementSpotFinder } from '../../../../src/skills/crafting/placement-spot.js'
import { Workstations } from '../../../../src/skills/crafting/workstations.js'
import { err, ok } from '../../../../src/core/result.js'
import type { FuelFetcher } from '../../../../src/skills/smelting/fuel-supply.js'
import { SmeltJobs } from '../../../../src/state/smelt-jobs.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import {
  FakeBlockScanner,
  FakeInventory,
  FakeVitals,
  buildVitals,
} from '../../../fakes/fake-ports.js'
import {
  AutoScheduler,
  FakeFurnaceAccess,
  FakePlacer,
  InstantNavigator,
  skillContext,
} from '../../../fakes/gathering-fakes.js'
import type { CraftOutput, ItemCrafter } from '../../../../src/skills/crafting/craft-item-skill.js'
import type { SkillResult } from '../../../../src/core/skill.types.js'

function setup(
  items: Record<string, number>,
  options: { furnaceStands?: boolean } = {},
  fetcher?: FuelFetcher,
) {
  const clock = new FakeClock()
  const scanner = new FakeBlockScanner()
  for (let x = -3; x <= 3; x += 1) {
    for (let z = -3; z <= 3; z += 1) {
      scanner.solid.set(`${String(x)},63,${String(z)}`, true)
      scanner.blockNames.set(`${String(x)},64,${String(z)}`, 'air')
      scanner.blockNames.set(`${String(x)},65,${String(z)}`, 'air')
    }
  }
  if (options.furnaceStands !== false)
    scanner.blocks = [{ name: 'furnace', position: { x: 3, y: 64, z: 0 }, distance: 3 }]
  const inventory = new FakeInventory()
  inventory.value = {
    stacks: Object.entries(items).map(([name, count]) => ({ name, count })),
    emptySlots: 30,
    heldItem: undefined,
  }
  const furnaces = new FakeFurnaceAccess()
  const placer = new FakePlacer()
  const vitals = new FakeVitals()
  vitals.vitals = buildVitals({ position: { x: 0.5, y: 64, z: 0.5 } })
  const navigator = new InstantNavigator()
  const workstations = new Workstations({
    blocks: scanner,
    navigator,
    placer,
    inventory,
    vitals,
    spots: new PlacementSpotFinder(scanner),
  })
  const jobs = new SmeltJobs()
  const crafted: string[] = []
  const crafterResult: { value: SkillResult<CraftOutput> } = {
    value: ok({ item: 'furnace', produced: 1, steps: [], placedTable: false }),
  }
  const crafter: ItemCrafter = {
    run: (input) => {
      crafted.push(input.item)
      if (crafterResult.value.ok) {
        scanner.blocks = [{ name: 'furnace', position: { x: 3, y: 64, z: 0 }, distance: 3 }]
      }
      return Promise.resolve(crafterResult.value)
    },
  }
  const skill = new SmeltItemsSkill({
    inventory,
    furnaces,
    workstations,
    crafter,
    clock,
    scheduler: new AutoScheduler(clock),
    navigator,
    jobs,
    vitals,
    ...(fetcher === undefined ? {} : { fuelSupply: fetcher }),
  })
  /** Smelting completes the moment the furnace is looked at. */
  furnaces.session.onLook = () => {
    const session = furnaces.session
    if (session.input === undefined) return
    const made = SMELTING_TABLE[session.input.name] ?? 'unknown'
    session.output = { name: made, count: (session.output?.count ?? 0) + session.input.count }
    session.input = undefined
  }
  return {
    clock,
    scanner,
    inventory,
    furnaces,
    placer,
    navigator,
    skill,
    crafted,
    crafterResult,
    jobs,
    vitals,
  }
}

const smelt = (item: string, count?: number, fuel?: string) => ({ item, count, fuel })

describe('SmeltItemsSkill', () => {
  it('smelts everything carried with the best default fuel and takes the output', async () => {
    const { skill, furnaces } = setup({ raw_iron: 5, coal: 3, oak_log: 4 })
    const { context, progress } = skillContext()

    const result = await skill.run(smelt('raw_iron'), context)

    expect(result).toEqual({
      ok: true,
      value: {
        item: 'raw_iron',
        produced: 'iron_ingot',
        smelted: 5,
        requested: 5,
        fuel: 'coal',
        station: 'furnace',
        fuelUsed: [], // the fake furnace never burns what it is given, so all of it comes back
        pending: 0,
        furnace: { x: 3, y: 64, z: 0 },
      },
    })
    expect(furnaces.session.log).toEqual([
      'fuel coal 1',
      'input raw_iron 5',
      'took output iron_ingot 5',
      'took fuel coal 1',
    ])
    expect(furnaces.session.closed).toBe(true)
    expect(progress.at(-1)).toContain('Smelted')
  })

  it('walks up to the furnace first', async () => {
    const { skill, navigator } = setup({ raw_iron: 1, coal: 1 })

    await skill.run(smelt('raw_iron', 1), skillContext().context)

    expect(navigator.trips).toEqual([{ target: { x: 3, y: 64, z: 0 }, within: 2.5 }])
  })

  it('loads big jobs one stack at a time', async () => {
    const { skill, furnaces } = setup({ raw_iron: 100, coal: 13 })

    const result = await skill.run(smelt('raw_iron', 100), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { smelted: 100 } })
    expect(furnaces.session.log.filter((l) => l.startsWith('input'))).toEqual([
      'input raw_iron 64',
      'input raw_iron 36',
    ])
  })

  it('smelts only as much as the fuel allows', async () => {
    const { skill } = setup({ sand: 20, coal: 1 })

    const result = await skill.run(smelt('sand'), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: { smelted: 8, requested: 20, produced: 'glass' },
    })
  })

  it('burns the fuel it is told to', async () => {
    const { skill, furnaces } = setup({ raw_iron: 2, coal: 4, oak_planks: 8 })

    await skill.run(smelt('raw_iron', 2, 'oak_planks'), skillContext().context)

    expect(furnaces.session.log[0]).toBe('fuel oak_planks 2')
  })

  it('refuses items that cannot be smelted', async () => {
    const { skill, furnaces } = setup({ dirt: 4, coal: 2 })

    const result = await skill.run(smelt('dirt'), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'not_smeltable' } })
    expect(furnaces.opened).toEqual([])
  })

  it('refuses when the bot does not carry enough', async () => {
    const { skill } = setup({ raw_iron: 2, coal: 2 })

    const short = await skill.run(smelt('raw_iron', 5), skillContext().context)
    const none = await skill.run(smelt('raw_gold'), skillContext().context)

    expect(short).toMatchObject({ ok: false, error: { reason: 'missing_items' } })
    expect(!short.ok && short.error.message).toBe('Cannot smelt 5 raw_iron: the bot has 2.')
    expect(none).toMatchObject({ ok: false, error: { reason: 'missing_items' } })
  })

  it('refuses when there is nothing to burn', async () => {
    const { skill } = setup({ raw_iron: 2 })

    const result = await skill.run(smelt('raw_iron'), skillContext().context)
    const named = await skill.run(smelt('raw_iron', 2, 'coal'), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_fuel' } })
    expect(!named.ok && named.error.message).toBe('The bot has no usable coal to burn.')
  })

  describe('when there is no furnace', () => {
    it('crafts one and uses it', async () => {
      const { skill, crafted, furnaces } = setup({ raw_iron: 1, coal: 1 }, { furnaceStands: false })

      const result = await skill.run(smelt('raw_iron'), skillContext().context)

      expect(crafted).toEqual(['furnace'])
      expect(result.ok).toBe(true)
      expect(furnaces.opened.length).toBeGreaterThanOrEqual(1)
    })

    it('explains when one cannot be crafted', async () => {
      const { skill, crafterResult } = setup({ raw_iron: 1, coal: 1 }, { furnaceStands: false })
      crafterResult.value = err({ reason: 'missing_materials', message: 'missing 8 cobblestone' })

      const result = await skill.run(smelt('raw_iron'), skillContext().context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'no_furnace' } })
      expect(!result.ok && result.error.message).toContain('missing 8 cobblestone')
    })

    it('passes on a cancelled craft', async () => {
      const { skill, crafterResult } = setup({ raw_iron: 1, coal: 1 }, { furnaceStands: false })
      crafterResult.value = err({ reason: 'aborted', message: 'Cancelled.' })

      const result = await skill.run(smelt('raw_iron'), skillContext().context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    })

    it('places a furnace it carries instead of crafting one', async () => {
      const { skill, placer, crafted } = setup(
        { raw_iron: 1, coal: 1, furnace: 1 },
        { furnaceStands: false },
      )
      placer.onPlace = () => undefined

      await skill.run(smelt('raw_iron'), skillContext().context)

      expect(crafted).toEqual([])
      expect(placer.placed.map((p) => p.item)).toEqual(['furnace'])
    })
  })

  describe('when things go wrong', () => {
    it('gives up after the time it should take, returning the items', async () => {
      const { skill, furnaces, clock } = setup({ raw_iron: 3, coal: 1 })
      furnaces.session.onLook = () => undefined // never smelts

      const result = await skill.run(smelt('raw_iron'), skillContext().context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'timeout' } })
      expect(!result.ok && result.error.message).toContain('Smelted 0 of 3 iron_ingot.')
      expect(furnaces.session.log).toContain('took input raw_iron 3')
      expect(furnaces.session.closed).toBe(true)
      expect(clock.now()).toBeGreaterThan(3 * 10_000 + 30_000)
    })

    it('stops when cancelled but leaves the loaded furnace burning, and remembers the job', async () => {
      const { skill, furnaces, jobs } = setup({ raw_iron: 3, coal: 1 })
      const { context, controller } = skillContext()
      furnaces.session.onLook = () => {
        if (furnaces.session.input !== undefined) controller.abort() // once the items are loaded
      }

      const result = await skill.run(smelt('raw_iron'), context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
      expect(!result.ok && result.error.message).toContain('call smelt again')
      expect(furnaces.session.log).not.toContain('took input raw_iron 3')
      expect(furnaces.session.log).not.toContain('took fuel coal 1')
      expect(furnaces.session.closed).toBe(true)
      expect(jobs.all()).toMatchObject([{ item: 'raw_iron', count: 3, loaded: 3, collected: 0 }])
    })

    it('reports fuel running out', async () => {
      const { skill, furnaces } = setup({ raw_iron: 3, coal: 1 })
      furnaces.session.onLook = () => {
        furnaces.session.burning = false
        furnaces.session.fuel = undefined
      }

      const result = await skill.run(smelt('raw_iron'), skillContext().context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'out_of_fuel' } })
    })

    it('does not mistake fuel that has just started burning for out_of_fuel (regression)', async () => {
      // The furnace consumes a fuel item into its burn queue the instant it starts burning, which can empty the
      // fuel slot a moment before the "burning" flag catches up. A single starved reading right after the input
      // is loaded must not be believed, or a log that has just started burning is declared missing and lost.
      const { skill, furnaces } = setup({ raw_iron: 1, coal: 1 })
      const smeltsOnceLooked = furnaces.session.onLook
      let starvedOnce = false
      furnaces.session.onLook = () => {
        if (!starvedOnce && furnaces.session.input !== undefined) {
          starvedOnce = true
          furnaces.session.fuel = undefined
          furnaces.session.burning = false
          return
        }
        furnaces.session.burning = true
        smeltsOnceLooked()
      }

      const result = await skill.run(smelt('raw_iron', 1), skillContext().context)

      expect(result).toMatchObject({ ok: true, value: { smelted: 1 } })
    })

    it('does not use a furnace that is busy with something else', async () => {
      const { skill, furnaces } = setup({ raw_iron: 3, coal: 1 })
      furnaces.session.input = { name: 'sand', count: 4 }
      furnaces.session.onLook = () => undefined

      const result = await skill.run(smelt('raw_iron'), skillContext().context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'furnace_busy' } })
      expect(furnaces.session.log).not.toContain('fuel coal 1')
    })

    it('reports a furnace that cannot be opened', async () => {
      const { skill, furnaces } = setup({ raw_iron: 3, coal: 1 })
      furnaces.failure = 'There is no furnace there.'

      const result = await skill.run(smelt('raw_iron'), skillContext().context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'furnace_failed' } })
    })

    it('reports a server error while loading, and closes the furnace', async () => {
      const { skill, furnaces } = setup({ raw_iron: 3, coal: 1 })
      furnaces.session.failPutFuel = new Error('window closed')

      const result = await skill.run(smelt('raw_iron'), skillContext().context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'furnace_failed' } })
      expect(!result.ok && result.error.message).toContain('window closed')
      expect(furnaces.session.closed).toBe(true)
    })
  })
})

describe('SmeltItemsSkill, the wait', () => {
  /** Smelting needs `ready` of the fake's looks before the output appears, so a wait has to be taken. */
  function slow(setupItems: Record<string, number>, looksNeeded: number) {
    const s = setup(setupItems)
    let looks = 0
    s.furnaces.session.onLook = () => {
      const session = s.furnaces.session
      if (session.input === undefined) return
      looks += 1
      if (looks < looksNeeded) return
      const made = SMELTING_TABLE[session.input.name] ?? 'unknown'
      session.output = { name: made, count: (session.output?.count ?? 0) + session.input.count }
      session.input = undefined
    }
    return s
  }

  it('closes the window while the items cook, and never reads a closed furnace', async () => {
    const { skill, furnaces } = slow({ raw_iron: 3, coal: 1 }, 4)

    const result = await skill.run(smelt('raw_iron'), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { smelted: 3 } })
    expect(furnaces.session.closes).toBeGreaterThan(1)
    expect(furnaces.opened.length).toBe(furnaces.session.closes)
    expect(furnaces.session.readsWhileClosed).toBe(0)
  })

  it('waits longer between looks for a big job than for a small one, up to a minute', async () => {
    const big = slow({ raw_iron: 64, coal: 8 }, 3)
    const bigStart = big.clock.now()
    await big.skill.run(smelt('raw_iron', 64), skillContext().context)
    const bigFirst = big.clock.now() - bigStart

    const small = slow({ raw_iron: 1, coal: 1 }, 2)
    const smallStart = small.clock.now()
    await small.skill.run(smelt('raw_iron', 1), skillContext().context)
    const smallFirst = small.clock.now() - smallStart

    expect(smallFirst).toBe(5_000)
    expect(bigFirst).toBeGreaterThan(smallFirst)
    expect(bigFirst).toBeLessThanOrEqual(2 * 60_000)
  })

  it('forgets the job when everything is collected', async () => {
    const { skill, jobs } = setup({ raw_iron: 3, coal: 1 })

    await skill.run(smelt('raw_iron'), skillContext().context)

    expect(jobs.all()).toEqual([])
  })

  it('loads the furnace and returns at once with start_only, keeping the job', async () => {
    const { skill, furnaces, jobs } = slow({ raw_iron: 5, coal: 1 }, 99)

    const result = await skill.run(
      { ...smelt('raw_iron'), wait: 'start_only' },
      skillContext().context,
    )

    expect(result).toMatchObject({
      ok: true,
      value: { smelted: 0, pending: 5, furnace: { x: 3, y: 64, z: 0 } },
    })
    expect(furnaces.session.input).toEqual({ name: 'raw_iron', count: 5 })
    expect(furnaces.session.closed).toBe(true)
    expect(jobs.all()).toMatchObject([{ item: 'raw_iron', count: 5, collected: 0 }])
  })

  it('collects a job left for later and ends it when everything is done', async () => {
    const { skill, furnaces, jobs, navigator } = slow({ raw_iron: 4, coal: 1 }, 99)
    await skill.run({ ...smelt('raw_iron'), wait: 'start_only' }, skillContext().context)
    furnaces.session.onLook = () => {
      furnaces.session.output = { name: 'iron_ingot', count: 4 }
      furnaces.session.input = undefined
    }
    navigator.trips.length = 0

    const result = await skill.run(
      { item: '', count: undefined, fuel: undefined, collect: true },
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { item: 'raw_iron', smelted: 4, pending: 0 } })
    expect(navigator.trips).toEqual([{ target: { x: 3, y: 64, z: 0 }, within: 2.5 }])
    expect(jobs.all()).toEqual([])
  })

  it('collect takes what is done so far and leaves the rest cooking', async () => {
    const { skill, furnaces, jobs } = slow({ raw_iron: 4, coal: 1 }, 99)
    await skill.run({ ...smelt('raw_iron'), wait: 'start_only' }, skillContext().context)
    furnaces.session.onLook = () => {
      furnaces.session.output = { name: 'iron_ingot', count: 1 }
      furnaces.session.input = { name: 'raw_iron', count: 3 }
    }

    const result = await skill.run(
      { item: 'raw_iron', count: undefined, fuel: undefined, collect: true },
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { smelted: 1, pending: 3 } })
    expect(jobs.all()).toMatchObject([{ collected: 1 }])
    expect(furnaces.session.input).toEqual({ name: 'raw_iron', count: 3 })
  })

  it('says so when there is no job to collect', async () => {
    const { skill } = setup({ raw_iron: 1, coal: 1 })

    const any = await skill.run(
      { item: '', count: undefined, fuel: undefined, collect: true },
      skillContext().context,
    )
    const named = await skill.run(
      { item: 'sand', count: undefined, fuel: undefined, collect: true },
      skillContext().context,
    )

    expect(any).toMatchObject({ ok: false, error: { reason: 'no_pending_job' } })
    expect(named).toMatchObject({ ok: false, error: { reason: 'no_pending_job' } })
  })

  it('a second smelt of the same item goes back to the job instead of loading again', async () => {
    const { skill, furnaces } = slow({ raw_iron: 3, coal: 2 }, 99)
    const { context, controller } = skillContext()
    furnaces.session.onLook = () => {
      if (furnaces.session.input !== undefined) controller.abort()
    }
    await skill.run(smelt('raw_iron'), context)
    furnaces.session.onLook = () => {
      furnaces.session.output = { name: 'iron_ingot', count: 3 }
      furnaces.session.input = undefined
    }
    furnaces.session.log.length = 0

    const again = await skill.run(smelt('raw_iron'), skillContext().context)

    expect(again).toMatchObject({ ok: true, value: { smelted: 3, pending: 0 } })
    expect(furnaces.session.log.some((line) => line.startsWith('fuel'))).toBe(false)
  })

  it('drops a job whose furnace cannot be opened any more', async () => {
    const { skill, furnaces, jobs } = slow({ raw_iron: 2, coal: 1 }, 99)
    await skill.run({ ...smelt('raw_iron'), wait: 'start_only' }, skillContext().context)
    furnaces.failure = 'There is no furnace there.'

    const result = await skill.run(
      { item: '', count: undefined, fuel: undefined, collect: true },
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'furnace_failed' } })
    expect(jobs.all()).toEqual([])
  })

  it('reports a walk back to the furnace that failed, keeping the job', async () => {
    const { skill, jobs, navigator } = slow({ raw_iron: 2, coal: 1 }, 99)
    await skill.run({ ...smelt('raw_iron'), wait: 'start_only' }, skillContext().context)
    navigator.failures = [{ reason: 'unreachable', message: 'blocked' }]

    const result = await skill.run(
      { item: '', count: undefined, fuel: undefined, collect: true },
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'furnace_failed' } })
    expect(jobs.all()).toHaveLength(1)
  })

  it('passes on a cancelled walk back to the furnace', async () => {
    const { skill, navigator } = slow({ raw_iron: 2, coal: 1 }, 99)
    await skill.run({ ...smelt('raw_iron'), wait: 'start_only' }, skillContext().context)
    navigator.failures = [{ reason: 'aborted', message: 'Cancelled.' }]

    const result = await skill.run(
      { item: '', count: undefined, fuel: undefined, collect: true },
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
  })

  it('keeps the job when the furnace cannot be opened again in the middle of a wait', async () => {
    const { skill, furnaces, jobs } = slow({ raw_iron: 3, coal: 1 }, 99)
    furnaces.session.close = () => {
      furnaces.session.closed = true
      furnaces.failure = 'Chunk unloaded.'
      return Promise.resolve()
    }

    const result = await skill.run(smelt('raw_iron'), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'furnace_failed' } })
    expect(jobs.all()).toHaveLength(1)
  })

  it('drops the job and takes everything back when the server fails while loading', async () => {
    const { skill, furnaces, jobs } = setup({ raw_iron: 3, coal: 1 })
    furnaces.session.failPutFuel = new Error('window closed')

    await skill.run(smelt('raw_iron'), skillContext().context)

    expect(jobs.all()).toEqual([])
  })

  it('does not believe an empty fuel slot and a flame that reads out while the items are still cooking (regression)', async () => {
    // Found by the e2e run: once the window was closed and opened again, the fuel slot read empty and the flame
    // out although the last fuel item was burning, and the skill gave up with out_of_fuel and nothing smelted.
    const { skill, furnaces } = slow({ raw_iron: 3, coal: 1 }, 4)
    const session = furnaces.session
    const base = session.onLook
    session.onLook = () => {
      if (session.input !== undefined) {
        session.burning = false
        session.fuel = undefined
      }
      base()
    }

    const result = await skill.run(smelt('raw_iron'), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { smelted: 3 } })
  })

  it('gives up on a furnace that has not moved for half a minute with an empty fuel slot', async () => {
    const { skill, furnaces, clock } = setup({ raw_iron: 3, coal: 1 })
    furnaces.session.onLook = () => {
      furnaces.session.burning = false
      furnaces.session.fuel = undefined
    }
    const start = clock.now()

    const result = await skill.run(smelt('raw_iron'), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'out_of_fuel' } })
    expect(clock.now() - start).toBeGreaterThanOrEqual(30_000)
  })

  it('takes everything back and forgets the job when the fuel runs out', async () => {
    const { skill, furnaces, jobs } = setup({ raw_iron: 3, coal: 1 })
    furnaces.session.onLook = () => {
      furnaces.session.burning = false
      furnaces.session.fuel = undefined
    }

    await skill.run(smelt('raw_iron'), skillContext().context)

    expect(furnaces.session.log).toContain('took input raw_iron 3')
    expect(jobs.all()).toEqual([])
  })
})

describe('SmeltItemsSkill, fuel top-up', () => {
  /** A furnace that burns what it is given: the fuel slot is empty at every look, and smelting takes one look. */
  function burning(items: Record<string, number>) {
    const s = setup(items)
    const session = s.furnaces.session
    const smelts = session.onLook
    session.onLook = () => {
      session.fuel = undefined
      smelts()
    }
    // What goes into the furnace leaves the bag, as it does in the game.
    const spend = (item: string, count: number): void => {
      const value = s.inventory.value
      if (value === undefined) return
      s.inventory.value = {
        ...value,
        stacks: value.stacks
          .map((stack) => (stack.name === item ? { ...stack, count: stack.count - count } : stack))
          .filter((stack) => stack.count > 0),
      }
    }
    const putFuel = session.putFuel.bind(session)
    session.putFuel = (item, count) => {
      spend(item, count)
      return putFuel(item, count)
    }
    return s
  }

  it('runs a job that the first kind of fuel does not cover, putting in the next kind at a look', async () => {
    const s = burning({ raw_iron: 20, coal: 1, oak_planks: 10 })

    const result = await s.skill.run(smelt('raw_iron'), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { smelted: 20, requested: 20, pending: 0 } })
    const fuelLines = s.furnaces.session.log.filter((line) => line.startsWith('fuel'))
    // The planks cover more items than the one coal, so they go in first; the coal is put in at a later look.
    expect(fuelLines[0]).toMatch(/^fuel oak_planks/)
    expect(fuelLines[1]).toBe('fuel coal 1')
    expect(result.ok && result.value.fuelUsed).toEqual([
      { name: 'oak_planks', count: 10 },
      { name: 'coal', count: 1 },
    ])
  })

  it('counts all the fuel in the bag, not just the first kind, when it picks how many to smelt', async () => {
    const some = await burning({ raw_iron: 40, coal: 1, oak_planks: 4 }).skill.run(
      smelt('raw_iron', 14),
      skillContext().context,
    ) // 8 + 6 = 14 items of fuel
    const all = await burning({ raw_iron: 40, coal: 1, oak_planks: 4 }).skill.run(
      smelt('raw_iron'),
      skillContext().context,
    )

    expect(some).toMatchObject({ ok: true, value: { smelted: 14, requested: 14 } })
    expect(all).toMatchObject({ ok: true, value: { smelted: 14, requested: 40 } })
  })

  it('puts back in the kind of fuel the job started with while the bag has some', async () => {
    const s = burning({ raw_iron: 30, coal: 6, oak_planks: 10 })

    await s.skill.run(smelt('raw_iron'), skillContext().context)

    const fuelLines = s.furnaces.session.log.filter((line) => line.startsWith('fuel'))
    expect(fuelLines.length).toBeGreaterThan(0)
    expect(fuelLines.every((line) => line.startsWith('fuel coal'))).toBe(true)
  })

  it('does not put more in while the fuel slot still holds fuel', async () => {
    const s = setup({ raw_iron: 3, coal: 5 })

    await s.skill.run(smelt('raw_iron'), skillContext().context)

    expect(s.furnaces.session.log.filter((line) => line.startsWith('fuel'))).toEqual([
      'fuel coal 1',
    ])
  })

  it('puts nothing in when the bag has no fuel left', async () => {
    const s = burning({ raw_iron: 3, coal: 1 })
    const looks = s.furnaces.session.onLook
    s.furnaces.session.onLook = () => {
      // The bag is empty once the first fuel is in the furnace.
      s.inventory.value = { stacks: [], emptySlots: 30, heldItem: undefined }
      looks()
    }

    await s.skill.run(smelt('raw_iron'), skillContext().context)

    expect(s.furnaces.session.log.filter((line) => line.startsWith('fuel'))).toEqual([
      'fuel coal 1',
    ])
  })

  it('reports only the fuel that was really burned when the rest comes back', async () => {
    const s = setup({ raw_iron: 3, coal: 4 })

    const result = await s.skill.run(smelt('raw_iron'), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { fuelUsed: [] } }) // the fake burns none of it
  })
})

describe('SmeltItemsSkill, jobs left in a furnace', () => {
  it('marks a job left with start_only as detached, for the ready signal', async () => {
    const s = setup({ raw_iron: 4, coal: 1 })
    s.furnaces.session.onLook = () => undefined

    await s.skill.run({ ...smelt('raw_iron'), wait: 'start_only' }, skillContext().context)

    expect(s.jobs.all()).toMatchObject([
      { item: 'raw_iron', detached: true, readyNotified: false, dimension: 'overworld' },
    ])
  })

  it('a job that a task is waiting for is not detached, and is gone when done', async () => {
    const s = setup({ raw_iron: 3, coal: 1 })
    const seen: (boolean | undefined)[] = []
    const base = s.furnaces.session.onLook
    s.furnaces.session.onLook = () => {
      seen.push(s.jobs.forItem('raw_iron')?.detached)
      base()
    }

    await s.skill.run(smelt('raw_iron'), skillContext().context)

    expect(seen.every((detached) => detached !== true)).toBe(true)
    expect(s.jobs.all()).toEqual([])
  })

  it('detaches a job whose wait was cut short', async () => {
    const s = setup({ raw_iron: 3, coal: 1 })
    const { context, controller } = skillContext()
    s.furnaces.session.onLook = () => {
      if (s.furnaces.session.input !== undefined) controller.abort()
    }

    await s.skill.run(smelt('raw_iron'), context)

    expect(s.jobs.all()).toMatchObject([{ detached: true }])
  })

  it('does not ask for the ready signal again after a collect that leaves items once the estimate has passed', async () => {
    const s = setup({ raw_iron: 4, coal: 1 })
    s.furnaces.session.onLook = () => undefined
    await s.skill.run({ ...smelt('raw_iron'), wait: 'start_only' }, skillContext().context)
    s.clock.advance(60_000) // well past 4 items
    s.furnaces.session.onLook = () => {
      s.furnaces.session.output = { name: 'iron_ingot', count: 1 }
    }

    await s.skill.run(
      { item: '', count: undefined, fuel: undefined, collect: true },
      skillContext().context,
    )

    expect(s.jobs.all()).toMatchObject([{ detached: true, readyNotified: true }])
  })

  it('leaves a job in another dimension alone, and says where it is', async () => {
    const s = setup({ raw_iron: 4, coal: 1 })
    s.furnaces.session.onLook = () => undefined
    await s.skill.run({ ...smelt('raw_iron'), wait: 'start_only' }, skillContext().context)
    s.vitals.vitals = buildVitals({ dimension: 'minecraft:the_nether' })

    const result = await s.skill.run(
      { item: '', count: undefined, fuel: undefined, collect: true },
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'furnace_far' } })
    expect(!result.ok && result.error.message).toContain('the_nether')
    expect(s.jobs.all()).toHaveLength(1)
  })
})

describe('SmeltItemsSkill, fuel from storage', () => {
  /** A fetcher that hands over what a test scripts, and notes what it was asked for. */
  function fetching(give: Record<string, number>) {
    const asked: { items: number; preferred: string | undefined }[] = []
    let inventory: ReturnType<typeof setup>['inventory'] | undefined
    const fetcher: FuelFetcher = {
      fetch: (items, preferred) => {
        asked.push({ items, preferred })
        const value = inventory?.value
        if (value !== undefined && inventory !== undefined) {
          const stacks = [...value.stacks]
          for (const [name, count] of Object.entries(give)) stacks.push({ name, count })
          inventory.value = { ...value, stacks }
        }
        return Promise.resolve(Object.entries(give).map(([name, count]) => ({ name, count })))
      },
    }
    return {
      asked,
      fetcher,
      attach: (target: ReturnType<typeof setup>['inventory']): void => {
        inventory = target
      },
    }
  }

  it('takes the fuel the bag lacks out of storage first, and says what it took', async () => {
    const f = fetching({ coal: 2 })
    const s = setup({ raw_iron: 16 }, {}, f.fetcher)
    f.attach(s.inventory)

    const result = await s.skill.run(
      { ...smelt('raw_iron'), fuelFromStorage: true },
      skillContext().context,
    )

    expect(f.asked).toEqual([{ items: 16, preferred: undefined }])
    expect(result).toMatchObject({
      ok: true,
      value: { smelted: 16, fuelFetched: [{ name: 'coal', count: 2 }] },
    })
  })

  it('asks only for what the bag does not cover', async () => {
    const f = fetching({ coal: 1 })
    const s = setup({ raw_iron: 16, coal: 1 }, {}, f.fetcher)
    f.attach(s.inventory)

    await s.skill.run({ ...smelt('raw_iron'), fuelFromStorage: true }, skillContext().context)

    expect(f.asked).toEqual([{ items: 8, preferred: undefined }])
  })

  it('does not go to storage when the bag already has enough fuel', async () => {
    const f = fetching({ coal: 2 })
    const s = setup({ raw_iron: 8, coal: 1 }, {}, f.fetcher)

    const result = await s.skill.run(
      { ...smelt('raw_iron'), fuelFromStorage: true },
      skillContext().context,
    )

    expect(f.asked).toEqual([])
    expect(result.ok && result.value.fuelFetched).toBeUndefined()
  })

  it('does not go to storage unless asked to', async () => {
    const f = fetching({ coal: 2 })
    const s = setup({ raw_iron: 8 }, {}, f.fetcher)

    const result = await s.skill.run(smelt('raw_iron'), skillContext().context)

    expect(f.asked).toEqual([])
    expect(result).toMatchObject({ ok: false, error: { reason: 'no_fuel' } })
  })

  it('passes on the fuel that was named, and still says no_fuel when storage has none', async () => {
    const f = fetching({})
    const s = setup({ raw_iron: 4 }, {}, f.fetcher)

    const result = await s.skill.run(
      { ...smelt('raw_iron', undefined, 'oak_planks'), fuelFromStorage: true },
      skillContext().context,
    )

    expect(f.asked).toEqual([{ items: 4, preferred: 'oak_planks' }])
    expect(result).toMatchObject({ ok: false, error: { reason: 'no_fuel' } })
  })

  it('does nothing extra when no supply is wired in', async () => {
    const s = setup({ raw_iron: 4 })

    const result = await s.skill.run(
      { ...smelt('raw_iron'), fuelFromStorage: true },
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_fuel' } })
  })
})

describe('SmeltItemsSkill, blast furnace and smoker', () => {
  /** A world with a station beside the furnace: the blast furnace or smoker stands at x = 3, z = 2. */
  function withStation(
    items: Record<string, number>,
    station: 'blast_furnace' | 'smoker' | undefined,
    options: { furnaceStands?: boolean } = {},
  ) {
    const s = setup(items, options)
    if (station !== undefined)
      s.scanner.blocks = [
        ...s.scanner.blocks,
        { name: station, position: { x: 3, y: 64, z: 2 }, distance: 3.6 },
      ]
    return s
  }

  it('uses a blast furnace that stands nearby for ore, without being told', async () => {
    const s = withStation({ raw_iron: 3, coal: 1 }, 'blast_furnace')

    const result = await s.skill.run(smelt('raw_iron'), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { smelted: 3, station: 'blast_furnace' } })
    expect(s.furnaces.opened[0]).toEqual({ x: 3, y: 64, z: 2 })
  })

  it('uses a smoker that stands nearby for food', async () => {
    const s = withStation({ beef: 4, coal: 1 }, 'smoker')

    const result = await s.skill.run(smelt('beef'), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { smelted: 4, station: 'smoker' } })
    expect(s.furnaces.opened[0]).toEqual({ x: 3, y: 64, z: 2 })
  })

  it('uses the furnace for what a blast furnace or a smoker cannot smelt', async () => {
    const stone = withStation({ cobblestone: 3, coal: 1 }, 'blast_furnace')
    const iron = withStation({ raw_iron: 3, coal: 1 }, 'smoker')

    const a = await stone.skill.run(smelt('cobblestone'), skillContext().context)
    const b = await iron.skill.run(smelt('raw_iron'), skillContext().context)

    expect(a).toMatchObject({ ok: true, value: { station: 'furnace' } })
    expect(b).toMatchObject({ ok: true, value: { station: 'furnace' } })
    expect(stone.furnaces.opened[0]).toEqual({ x: 3, y: 64, z: 0 })
  })

  it('places a blast furnace it carries, and does not craft a furnace it does not need', async () => {
    const s = withStation({ raw_iron: 3, coal: 1, blast_furnace: 1 }, undefined, {
      furnaceStands: false,
    })
    s.placer.onPlace = () => undefined

    const result = await s.skill.run(smelt('raw_iron'), skillContext().context)

    expect(s.placer.placed.map((p) => p.item)).toEqual(['blast_furnace'])
    expect(s.crafted).toEqual([])
    expect(result).toMatchObject({ ok: true, value: { station: 'blast_furnace' } })
  })

  it('crafts a furnace, as before, when there is no station at all', async () => {
    const s = withStation({ raw_iron: 3, coal: 1 }, undefined, { furnaceStands: false })

    const result = await s.skill.run(smelt('raw_iron'), skillContext().context)

    expect(s.crafted).toEqual(['furnace'])
    expect(result).toMatchObject({ ok: true, value: { station: 'furnace' } })
  })

  it('uses the furnace when told to, even with a blast furnace beside it', async () => {
    const s = withStation({ raw_iron: 3, coal: 1 }, 'blast_furnace')

    const result = await s.skill.run(
      { ...smelt('raw_iron'), station: 'furnace' },
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { station: 'furnace' } })
    expect(s.furnaces.opened[0]).toEqual({ x: 3, y: 64, z: 0 })
  })

  it('uses the station that is named when it can smelt the item', async () => {
    const s = withStation({ raw_iron: 3, coal: 1 }, 'blast_furnace')

    const result = await s.skill.run(
      { ...smelt('raw_iron'), station: 'blast_furnace' },
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { station: 'blast_furnace' } })
  })

  it('refuses a station that cannot smelt the item', async () => {
    const s = withStation({ beef: 3, coal: 1 }, 'blast_furnace')

    const result = await s.skill.run(
      { ...smelt('beef'), station: 'blast_furnace' },
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'wrong_station' } })
    expect(!result.ok && result.error.message).toContain('only smelts ores')
    expect(s.furnaces.opened).toEqual([])
  })

  it('refuses iron in a smoker, and says what a smoker is for', async () => {
    const s = withStation({ raw_iron: 3, coal: 1 }, 'smoker')

    const result = await s.skill.run(
      { ...smelt('raw_iron'), station: 'smoker' },
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: false, error: { reason: 'wrong_station' } })
    expect(!result.ok && result.error.message).toContain('only cooks food')
  })

  it('does not craft a station that was asked for by name and is not there', async () => {
    const blast = withStation({ raw_iron: 3, coal: 1 }, undefined)
    const smoke = withStation({ beef: 3, coal: 1 }, undefined)

    const a = await blast.skill.run(
      { ...smelt('raw_iron'), station: 'blast_furnace' },
      skillContext().context,
    )
    const b = await smoke.skill.run({ ...smelt('beef'), station: 'smoker' }, skillContext().context)

    expect(a).toMatchObject({ ok: false, error: { reason: 'no_blast_furnace' } })
    expect(!a.ok && a.error.message).toContain('5 iron ingots')
    expect(b).toMatchObject({ ok: false, error: { reason: 'no_smoker' } })
    expect(!b.ok && b.error.message).toContain('4 logs')
    expect(blast.crafted).toEqual([])
    expect(smoke.crafted).toEqual([])
  })

  it('smelts twice as much on the same fuel', async () => {
    const plain = setup({ raw_iron: 16, coal: 1 })
    const fast = withStation({ raw_iron: 16, coal: 1 }, 'blast_furnace')

    const slow = await plain.skill.run(smelt('raw_iron'), skillContext().context)
    const quick = await fast.skill.run(smelt('raw_iron'), skillContext().context)

    expect(slow).toMatchObject({ ok: true, value: { smelted: 8, requested: 16 } })
    expect(quick).toMatchObject({ ok: true, value: { smelted: 16, requested: 16 } })
  })

  it('gives up sooner on a station that should be twice as fast', async () => {
    const furnace = setup({ raw_iron: 3, coal: 1 })
    furnace.furnaces.session.onLook = () => undefined
    const blast = withStation({ raw_iron: 3, coal: 1 }, 'blast_furnace')
    blast.furnaces.session.onLook = () => undefined

    await furnace.skill.run(smelt('raw_iron'), skillContext().context)
    await blast.skill.run(smelt('raw_iron'), skillContext().context)

    // 3 items: 30 s + 30 s slack for a furnace, 15 s + 30 s for a blast furnace.
    expect(blast.clock.now()).toBeLessThan(furnace.clock.now())
    expect(blast.clock.now()).toBeGreaterThan(45_000)
  })

  it('writes the station into the job, so the ready estimate uses its speed', async () => {
    const s = withStation({ raw_iron: 4, coal: 1 }, 'blast_furnace')
    s.furnaces.session.onLook = () => undefined

    const result = await s.skill.run(
      { ...smelt('raw_iron'), wait: 'start_only' },
      skillContext().context,
    )

    expect(result).toMatchObject({ ok: true, value: { station: 'blast_furnace', pending: 4 } })
    expect(s.jobs.all()).toMatchObject([{ station: 'blast_furnace' }])
  })

  it('names the block in a refusal when it is busy with something else', async () => {
    const s = withStation({ beef: 2, coal: 1 }, 'smoker')
    s.furnaces.session.input = { name: 'potato', count: 3 }
    s.furnaces.session.onLook = () => undefined

    const result = await s.skill.run(smelt('beef'), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'furnace_busy' } })
    expect(!result.ok && result.error.message).toContain('smoker')
  })
})

describe('the smelting table', () => {
  it('maps ores, raw metals, food, and sand', () => {
    expect(SMELTING_TABLE['raw_iron']).toBe('iron_ingot')
    expect(SMELTING_TABLE['beef']).toBe('cooked_beef')
    expect(SMELTING_TABLE['sand']).toBe('glass')
    expect(SMELTING_TABLE['cobblestone']).toBe('stone')
    expect(SMELTABLE_ITEMS).toContain('deepslate_iron_ore')
  })
})
