import { describe, expect, it } from '@jest/globals'
import { SmeltItemsSkill } from '../../../../src/skills/smelting/smelt-items-skill.js'
import { SMELTABLE_ITEMS, SMELTING_TABLE } from '../../../../src/skills/smelting/smelting-table.js'
import { PlacementSpotFinder } from '../../../../src/skills/crafting/placement-spot.js'
import { Workstations } from '../../../../src/skills/crafting/workstations.js'
import { err, ok } from '../../../../src/core/result.js'
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

function setup(items: Record<string, number>, options: { furnaceStands?: boolean } = {}) {
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
  })
  /** Smelting completes the moment the furnace is looked at. */
  furnaces.session.onLook = () => {
    const session = furnaces.session
    if (session.input === undefined) return
    const made = SMELTING_TABLE[session.input.name] ?? 'unknown'
    session.output = { name: made, count: (session.output?.count ?? 0) + session.input.count }
    session.input = undefined
  }
  return { clock, scanner, inventory, furnaces, placer, navigator, skill, crafted, crafterResult }
}

const smelt = (item: string, count?: number, fuel?: string) => ({ item, count, fuel })

describe('SmeltItemsSkill', () => {
  it('smelts everything carried with the best default fuel and takes the output', async () => {
    const { skill, furnaces } = setup({ raw_iron: 5, coal: 3, oak_log: 4 })
    const { context, progress } = skillContext()

    const result = await skill.run(smelt('raw_iron'), context)

    expect(result).toEqual({
      ok: true,
      value: { item: 'raw_iron', produced: 'iron_ingot', smelted: 5, requested: 5, fuel: 'coal' },
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
      expect(furnaces.opened).toHaveLength(1)
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

    it('stops when cancelled and puts everything back', async () => {
      const { skill, furnaces } = setup({ raw_iron: 3, coal: 1 })
      const { context, controller } = skillContext()
      furnaces.session.onLook = () => {
        if (furnaces.session.input !== undefined) controller.abort() // once the items are loaded
      }

      const result = await skill.run(smelt('raw_iron'), context)

      expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
      expect(furnaces.session.log).toEqual(
        expect.arrayContaining(['took input raw_iron 3', 'took fuel coal 1']),
      )
      expect(furnaces.session.closed).toBe(true)
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

describe('the smelting table', () => {
  it('maps ores, raw metals, food, and sand', () => {
    expect(SMELTING_TABLE['raw_iron']).toBe('iron_ingot')
    expect(SMELTING_TABLE['beef']).toBe('cooked_beef')
    expect(SMELTING_TABLE['sand']).toBe('glass')
    expect(SMELTING_TABLE['cobblestone']).toBe('stone')
    expect(SMELTABLE_ITEMS).toContain('deepslate_iron_ore')
  })
})
