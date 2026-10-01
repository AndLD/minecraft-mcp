import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import { CraftItemSkill } from '../../../../src/skills/crafting/craft-item-skill.js'
import { PlacementSpotFinder } from '../../../../src/skills/crafting/placement-spot.js'
import { RecipePlanner } from '../../../../src/skills/crafting/recipe-planner.js'
import { Workstations } from '../../../../src/skills/crafting/workstations.js'
import {
  FakeBlockScanner,
  FakeInventory,
  FakeVitals,
  buildVitals,
} from '../../../fakes/fake-ports.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import {
  AutoScheduler,
  FakePlacer,
  FakeRecipeBook,
  InstantNavigator,
  recipe,
  skillContext,
} from '../../../fakes/gathering-fakes.js'

const key = (p: Position): string => `${String(p.x)},${String(p.y)},${String(p.z)}`

function setup(items: Record<string, number>) {
  const clock = new FakeClock()
  const book = new FakeRecipeBook({
    oak_planks: [recipe({ name: 'oak_planks', count: 4 }, [{ name: 'oak_log', count: 1 }])],
    stick: [recipe({ name: 'stick', count: 4 }, [{ name: 'oak_planks', count: 2 }])],
    crafting_table: [
      recipe({ name: 'crafting_table', count: 1 }, [{ name: 'oak_planks', count: 4 }]),
    ],
    axe: [
      recipe(
        { name: 'axe', count: 1 },
        [
          { name: 'oak_planks', count: 3 },
          { name: 'stick', count: 2 },
        ],
        0,
        true,
      ),
    ],
    button: [recipe({ name: 'button', count: 1 }, [{ name: 'oak_planks', count: 1 }])],
  })
  const scanner = new FakeBlockScanner()
  for (let x = -3; x <= 3; x += 1) {
    for (let z = -3; z <= 3; z += 1) {
      scanner.solid.set(key({ x, y: 63, z }), true)
      scanner.blockNames.set(key({ x, y: 64, z }), 'air')
      scanner.blockNames.set(key({ x, y: 65, z }), 'air')
    }
  }
  const inventory = new FakeInventory()
  const counts = new Map(Object.entries(items))
  const publish = (): void => {
    inventory.value = {
      stacks: [...counts].filter(([, n]) => n > 0).map(([name, count]) => ({ name, count })),
      emptySlots: 30,
      heldItem: undefined,
    }
  }
  publish()
  book.onCraft = (item, made, times) => {
    for (const ingredient of made.ingredients)
      counts.set(ingredient.name, (counts.get(ingredient.name) ?? 0) - ingredient.count * times)
    counts.set(item, (counts.get(item) ?? 0) + made.result.count * times)
    publish()
  }
  const placer = new FakePlacer()
  placer.onPlace = (item, target) => {
    counts.set(item, (counts.get(item) ?? 0) - 1)
    scanner.blocks = [{ name: item, position: target, distance: 1 }]
    publish()
  }
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
  const skill = new CraftItemSkill({
    book,
    planner: new RecipePlanner(book),
    crafter: book,
    inventory,
    workstations,
    scheduler: new AutoScheduler(clock),
  })
  return { book, scanner, inventory, placer, navigator, skill, counts }
}

describe('CraftItemSkill', () => {
  it('crafts an item that needs no table straight from the inventory', async () => {
    const { skill, book } = setup({ oak_planks: 2 })

    const result = await skill.run({ item: 'button', count: 2 }, skillContext().context)

    expect(book.crafted).toEqual([{ item: 'button', recipeIndex: 0, times: 2, table: undefined }])
    expect(result).toEqual({
      ok: true,
      value: {
        item: 'button',
        produced: 2,
        steps: [{ item: 'button', times: 2 }],
        placedTable: false,
      },
    })
  })

  it('makes the intermediate items first and reports progress', async () => {
    const { skill, book, scanner } = setup({ oak_log: 2 })
    scanner.blocks = [{ name: 'crafting_table', position: { x: 2, y: 64, z: 0 }, distance: 2 }]
    const { context, progress } = skillContext()

    const result = await skill.run({ item: 'axe', count: 1 }, context)

    expect(book.crafted.map((c) => `${c.item} x${String(c.times)}`)).toEqual([
      'oak_planks x2',
      'stick x1',
      'axe x1',
    ])
    expect(progress).toEqual(['Crafted oak_planks x2', 'Crafted stick x1', 'Crafted axe x1'])
    expect(result).toMatchObject({ ok: true, value: { produced: 1, placedTable: false } })
  })

  it('walks to a crafting table that stands nearby and crafts on it', async () => {
    const { skill, book, scanner, navigator } = setup({ oak_planks: 5, stick: 2 })
    scanner.blocks = [{ name: 'crafting_table', position: { x: 2, y: 64, z: 0 }, distance: 2 }]

    await skill.run({ item: 'axe', count: 1 }, skillContext().context)

    expect(navigator.trips).toEqual([{ target: { x: 2, y: 64, z: 0 }, within: 2.5 }])
    expect(book.crafted).toEqual([
      { item: 'axe', recipeIndex: 0, times: 1, table: { x: 2, y: 64, z: 0 } },
    ])
  })

  it('makes and places a crafting table when there is none', async () => {
    const { skill, book, placer } = setup({ oak_log: 3 })

    const result = await skill.run({ item: 'axe', count: 1 }, skillContext().context)

    const made = book.crafted.map((c) => c.item)
    expect(made.slice(0, 2)).toEqual(['oak_planks', 'crafting_table'])
    expect(made.slice(-2)).toEqual(['stick', 'axe'])
    expect(placer.placed.map((p) => p.item)).toEqual(['crafting_table'])
    expect(book.crafted.at(-1)?.table).toEqual(placer.placed[0]?.target)
    expect(result).toMatchObject({ ok: true, value: { placedTable: true } })
  })

  it('uses a crafting table it carries instead of making another', async () => {
    const { skill, book, placer } = setup({ crafting_table: 1, oak_planks: 5, stick: 2 })

    const result = await skill.run({ item: 'axe', count: 1 }, skillContext().context)

    expect(book.crafted.map((c) => c.item)).toEqual(['axe'])
    expect(placer.placed).toHaveLength(1)
    expect(result).toMatchObject({ ok: true, value: { placedTable: true } })
  })

  it('lists exactly what is missing, with a note for wood', async () => {
    const { skill, book } = setup({ oak_log: 1 })

    const result = await skill.run({ item: 'axe', count: 1 }, skillContext().context)

    expect(book.crafted).toEqual([])
    expect(result).toMatchObject({ ok: false, error: { reason: 'missing_materials' } })
    expect(!result.ok && result.error.message).toContain('Any wood type works')
  })

  it('says the table is part of what is missing', async () => {
    const { skill } = setup({ oak_planks: 5, stick: 2 })

    const result = await skill.run({ item: 'axe', count: 1 }, skillContext().context)

    // 5 planks and 2 sticks are enough for the axe, but a table needs 4 more planks.
    expect(result).toMatchObject({ ok: false, error: { reason: 'missing_materials' } })
    expect(!result.ok && result.error.message).toContain('it also needs a crafting table')
  })

  it('suggests names for an unknown item and refuses items without a recipe', async () => {
    const { skill } = setup({})

    const typo = await skill.run({ item: 'axe_', count: 1 }, skillContext().context)
    const raw = await skill.run({ item: 'oak_log', count: 1 }, skillContext().context)
    const nonsense = await skill.run({ item: 'zzz', count: 1 }, skillContext().context)

    expect(typo).toMatchObject({ ok: false, error: { reason: 'unknown_item' } })
    expect(!typo.ok && typo.error.message).toContain('did you mean: axe')
    expect(raw).toMatchObject({ ok: false, error: { reason: 'no_recipe' } })
    expect(!nonsense.ok && nonsense.error.message).toBe('"zzz" is not an item name.')
  })

  it('reports a failed craft', async () => {
    const { skill, book } = setup({ oak_planks: 1 })
    book.failure = { reason: 'failed', message: 'window closed' }

    const result = await skill.run({ item: 'button', count: 1 }, skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'craft_failed' } })
    expect(!result.ok && result.error.message).toContain('window closed')
  })

  it('tries again when the game ignores a craft, and succeeds', async () => {
    const { skill, book } = setup({ oak_planks: 1 })
    book.transientFailures = 2

    const result = await skill.run({ item: 'button', count: 1 }, skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { produced: 1 } })
    expect(book.crafted).toHaveLength(1)
  })

  it('tries again when a craft reports success but nothing arrives, without crafting twice when the result was only late', async () => {
    const { skill, book, counts, inventory } = setup({ oak_planks: 2 })
    // The first craft is ignored by the server; the second works.
    const original = book.onCraft
    let calls = 0
    book.onCraft = (item, made, times) => {
      calls += 1
      if (calls > 1) original(item, made, times)
    }
    const { context } = skillContext()

    const result = await skill.run({ item: 'button', count: 1 }, context)

    expect(result.ok).toBe(true)
    expect(book.crafted).toHaveLength(2)
    expect(counts.get('button')).toBe(1)
    expect(inventory.value?.stacks.find((s) => s.name === 'button')?.count).toBe(1)
  })

  it('gives up after three tries and says what went wrong', async () => {
    const { skill, book } = setup({ oak_planks: 2 })
    book.onCraft = () => undefined // the result never arrives

    const result = await skill.run({ item: 'button', count: 1 }, skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'craft_failed' } })
    expect(!result.ok && result.error.message).toContain('after 3 tries')
    expect(!result.ok && result.error.message).toContain('never showed up')
    expect(book.crafted).toHaveLength(3)
  })

  it('does not retry problems that trying again cannot fix', async () => {
    const { skill, book } = setup({ oak_planks: 1 })
    book.failure = { reason: 'unknown_recipe', message: 'no such recipe' }

    const result = await skill.run({ item: 'button', count: 1 }, skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'craft_failed' } })
    expect(!result.ok && result.error.message).toContain('no such recipe')
  })

  it('stops between steps when cancelled', async () => {
    const { skill, book } = setup({ oak_log: 2 })
    const { context, controller } = skillContext()
    book.onCraft = () => {
      controller.abort()
    }

    const result = await skill.run({ item: 'stick', count: 1 }, context)

    expect(book.crafted).toHaveLength(1)
    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
  })

  it('fails with the workstation error when the table cannot be reached', async () => {
    const { skill, scanner, navigator } = setup({ oak_planks: 5, stick: 2 })
    scanner.blocks = [{ name: 'crafting_table', position: { x: 2, y: 64, z: 0 }, distance: 2 }]
    navigator.failures = [{ reason: 'unreachable', message: 'No path' }]

    const result = await skill.run({ item: 'axe', count: 1 }, skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'unreachable' } })
  })
})
