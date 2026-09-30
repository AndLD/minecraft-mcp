import { describe, expect, it } from '@jest/globals'
import { MineflayerItemFacts } from '../../../../src/bot/mineflayer-item-facts.js'
import { ContainerSelector } from '../../../../src/skills/storage/container-selector.js'
import { ContainerVisitor } from '../../../../src/skills/storage/container-visitor.js'
import {
  OrganizeStorageSkill,
  type OrganizeInput,
} from '../../../../src/skills/storage/organize-storage-skill.js'
import { ContainerIndex } from '../../../../src/state/container-index.js'
import { StorageRules } from '../../../../src/state/storage-rules.js'
import { FakeBot } from '../../../fakes/fake-bot.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { skillContext } from '../../../fakes/gathering-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'
import { FakeStorageWorld } from '../../../fakes/storage-fakes.js'

const facts = new MineflayerItemFacts({
  current: () => new FakeBot().useGameData(),
  onChange: () => () => undefined,
})
const at = (x: number) => ({ x, y: 64, z: 0 })

async function setup() {
  const world = new FakeStorageWorld()
  const clock = new FakeClock()
  const index = new ContainerIndex(clock)
  const rules = new StorageRules()
  const store = new InMemoryStateStore()
  await index.attach(store)
  await rules.attach(store)
  const visitor = new ContainerVisitor({
    blocks: world.scanner,
    navigator: world.navigator,
    containers: world,
    index,
  })
  const skill = new OrganizeStorageSkill({
    inventory: world.inventory,
    index,
    selector: new ContainerSelector(index, rules, facts),
    visitor,
    facts,
    clock,
  })
  /** A chest at x with a label; its id is container-N in the order they are made. */
  const chest = (x: number, label: string, slots = 27, guarded = false): string => {
    world.addContainer(at(x), 'chest', slots)
    const entry = index.register(at(x), 'chest', { label, protected: guarded })
    if (!entry.ok) throw new Error(entry.error)
    return entry.value.id
  }
  return { world, clock, index, rules, skill, chest }
}

const input = (over: Partial<OrganizeInput> = {}): OrganizeInput => ({
  containers: undefined,
  dryRun: false,
  maxMinutes: 10,
  ...over,
})

describe('OrganizeStorageSkill', () => {
  it('lists the moves and changes nothing on a dry run', async () => {
    const s = await setup()
    const junk = s.chest(10, 'junk')
    const stone = s.chest(20, 'stone')
    s.rules.add(stone, ['cobblestone'])
    s.world.stock(at(10), 'cobblestone', 100)

    const result = await s.skill.run(input({ dryRun: true }), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: {
        dryRun: true,
        moved: 0,
        moves: [{ item: 'cobblestone', count: 100, from: { id: junk }, to: { id: stone } }],
      },
    })
    expect(s.world.inside(at(10), 'cobblestone')).toBe(100)
    expect(s.world.inside(at(20), 'cobblestone')).toBe(0)
    expect(s.world.have('cobblestone')).toBe(0)
  })

  it('moves every stack to the container its rule names, and leaves the rest alone', async () => {
    const s = await setup()
    s.chest(10, 'junk')
    const stone = s.chest(20, 'stone')
    const metal = s.chest(30, 'metal')
    s.rules.add(stone, ['cobblestone', 'dirt'])
    s.rules.add(metal, ['ingots', 'ores'])
    s.world.stock(at(10), 'cobblestone', 100)
    s.world.stock(at(10), 'iron_ingot', 7)
    s.world.stock(at(10), 'raw_iron', 12)
    s.world.stock(at(10), 'feather', 5) // no rule: stays
    s.world.stock(at(20), 'iron_ingot', 3) // in the wrong place too

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: { dryRun: false, moved: 122, left: [], carried: [] },
    })
    expect(s.world.inside(at(20), 'cobblestone')).toBe(100)
    expect(s.world.inside(at(30), 'iron_ingot')).toBe(10)
    expect(s.world.inside(at(30), 'raw_iron')).toBe(12)
    expect(s.world.inside(at(10), 'feather')).toBe(5)
    expect(s.world.inside(at(10), 'cobblestone')).toBe(0)
    expect(s.world.have('cobblestone')).toBe(0)
    expect(s.index.get(stone)?.contents).toContainEqual({ name: 'cobblestone', count: 100 })
    expect(s.index.get(metal)?.contents).toContainEqual({ name: 'iron_ingot', count: 10 })
  })

  it('counts stacks that are already in place, or that no rule names, as unchanged', async () => {
    const s = await setup()
    const stone = s.chest(10, 'stone')
    s.chest(20, 'misc')
    s.rules.add(stone, ['cobblestone'])
    s.world.stock(at(10), 'cobblestone', 50)
    s.world.stock(at(20), 'feather', 5)

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { moved: 0, unchanged: 2, moves: [] } })
    expect(s.world.carried.size).toBe(0)
  })

  it('follows the rule with the higher priority when two match', async () => {
    const s = await setup()
    s.chest(10, 'junk')
    const general = s.chest(20, 'general')
    const special = s.chest(30, 'special')
    s.rules.add(general, ['*'], -10)
    s.rules.add(special, ['cobblestone'], 5)
    s.world.stock(at(10), 'cobblestone', 10)

    await s.skill.run(input(), skillContext().context)

    expect(s.world.inside(at(30), 'cobblestone')).toBe(10)
    expect(s.world.inside(at(20), 'cobblestone')).toBe(0)
  })

  it('moves only what fits when the destination is nearly full, and says what is left', async () => {
    const s = await setup()
    s.chest(10, 'junk')
    const small = s.chest(20, 'small', 1)
    s.rules.add(small, ['cobblestone'])
    s.world.stock(at(10), 'cobblestone', 100)

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: {
        moved: 64,
        left: [{ item: 'cobblestone', count: 36 }],
      },
    })
    expect(s.world.inside(at(20), 'cobblestone')).toBe(64)
    expect(s.world.inside(at(10), 'cobblestone')).toBe(36)
    expect(s.world.have('cobblestone')).toBe(0)
  })

  it('uses room that an earlier move frees', async () => {
    const s = await setup()
    const a = s.chest(10, 'a', 3)
    const b = s.chest(20, 'b', 1)
    s.rules.add(b, ['cobblestone'])
    s.rules.add(a, ['dirt'])
    s.world.stock(at(10), 'cobblestone', 64)
    s.world.stock(at(10), 'gravel', 64)
    s.world.stock(at(20), 'dirt', 64)

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { moved: 128, left: [] } })
    expect(s.world.inside(at(20), 'cobblestone')).toBe(64)
    expect(s.world.inside(at(10), 'dirt')).toBe(64)
  })

  it('never opens a protected container, as a source or a destination', async () => {
    const s = await setup()
    const guarded = s.chest(10, 'guarded', 27, true)
    s.chest(20, 'junk')
    const target = s.chest(30, 'safe')
    s.rules.add(target, ['cobblestone'])
    s.rules.add(guarded, ['dirt'])
    s.world.stock(at(10), 'cobblestone', 10)
    s.world.stock(at(20), 'dirt', 10)

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: { moved: 0, skipped: [{ reason: 'protected' }] },
    })
    expect(s.world.inside(at(10), 'cobblestone')).toBe(10)
    expect(s.world.inside(at(20), 'dirt')).toBe(10)
    expect(s.world.opened).not.toContain('10,64,0')
  })

  it('sorts only the containers it is told to, but delivers to any rule target', async () => {
    const s = await setup()
    const first = s.chest(10, 'first')
    s.chest(20, 'second')
    const stone = s.chest(30, 'stone')
    s.rules.add(stone, ['cobblestone'])
    s.world.stock(at(10), 'cobblestone', 5)
    s.world.stock(at(20), 'cobblestone', 7)

    await s.skill.run(input({ containers: [first] }), skillContext().context)

    expect(s.world.inside(at(30), 'cobblestone')).toBe(5)
    expect(s.world.inside(at(20), 'cobblestone')).toBe(7)
  })

  it('refuses an unknown container and an empty index', async () => {
    const s = await setup()
    const none = await s.skill.run(input(), skillContext().context)
    s.chest(10, 'junk')
    const unknown = await s.skill.run(input({ containers: ['attic'] }), skillContext().context)

    expect(none).toMatchObject({ ok: false, error: { reason: 'no_containers' } })
    expect(unknown).toMatchObject({ ok: false, error: { reason: 'unknown_container' } })
  })

  it('skips a container that is gone and forgets it', async () => {
    const s = await setup()
    s.chest(10, 'junk')
    const stone = s.chest(20, 'stone')
    s.rules.add(stone, ['cobblestone'])
    s.world.stock(at(10), 'cobblestone', 5)
    s.world.breakContainer(at(20))

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { moved: 0 } })
    expect(result.ok && result.value.skipped.length).toBeGreaterThan(0)
    expect(s.index.get(stone)).toBeUndefined()
  })

  it('makes several trips when the bot cannot carry a whole batch', async () => {
    const s = await setup()
    s.world.playerSlots = 3 // one free slot after the two it keeps
    s.world.sync()
    s.chest(10, 'junk')
    const stone = s.chest(20, 'stone')
    s.rules.add(stone, ['cobblestone'])
    s.world.stock(at(10), 'cobblestone', 192)

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { moved: 192, left: [] } })
    expect(s.world.inside(at(20), 'cobblestone')).toBe(192)
  })

  it('says so when the inventory has no room to carry anything', async () => {
    const s = await setup()
    s.world.playerSlots = 2
    s.world.sync()
    s.chest(10, 'junk')
    const stone = s.chest(20, 'stone')
    s.rules.add(stone, ['cobblestone'])
    s.world.stock(at(10), 'cobblestone', 10)

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: { moved: 0, left: [{ item: 'cobblestone', reason: 'the inventory is full' }] },
    })
    expect(s.world.inside(at(10), 'cobblestone')).toBe(10)
  })

  it('puts the items back where they came from when the destination cannot be used', async () => {
    const s = await setup()
    s.chest(10, 'junk')
    const stone = s.chest(20, 'stone')
    s.rules.add(stone, ['cobblestone'])
    s.world.stock(at(10), 'cobblestone', 30)
    const open = s.world.open.bind(s.world)
    s.world.open = ((original) => (position: { x: number; y: number; z: number }) => {
      if (position.x === 20 && s.world.have('cobblestone') > 0)
        return Promise.resolve({ ok: false as const, error: 'locked' })
      return original(position)
    })(open)

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: true, value: { moved: 0, carried: [] } })
    expect(s.world.inside(at(10), 'cobblestone')).toBe(30)
    expect(s.world.have('cobblestone')).toBe(0)
  })

  it('reports what it still carries when it cannot put it back either', async () => {
    const s = await setup()
    s.chest(10, 'junk')
    const stone = s.chest(20, 'stone')
    s.rules.add(stone, ['cobblestone'])
    s.world.stock(at(10), 'cobblestone', 30)
    const open = s.world.open.bind(s.world)
    s.world.open = (position) => {
      if (s.world.have('cobblestone') > 0)
        return Promise.resolve({ ok: false as const, error: 'locked' })
      return open(position)
    }

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: { carried: [{ name: 'cobblestone', count: 30 }] },
    })
  })

  it('puts what it carries back when cancelled halfway', async () => {
    const s = await setup()
    s.chest(10, 'junk')
    const stone = s.chest(20, 'stone')
    s.rules.add(stone, ['cobblestone'])
    s.world.stock(at(10), 'cobblestone', 30)
    const { context, controller } = skillContext()
    // The player says stop on the way to the destination, and the destination cannot be opened any more.
    s.world.navigator.onArrive = (target) => {
      if (target.x === 20 && s.world.have('cobblestone') > 0) controller.abort()
    }
    const open = s.world.open.bind(s.world)
    s.world.open = (position) =>
      position.x === 20 && s.world.have('cobblestone') > 0
        ? Promise.resolve({ ok: false as const, error: 'locked' })
        : open(position)

    const result = await s.skill.run(input(), context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    expect(s.world.have('cobblestone')).toBe(0)
    expect(s.world.inside(at(10), 'cobblestone')).toBe(30)
  })

  it('stops when the time is up and says what was left', async () => {
    const s = await setup()
    s.chest(10, 'a')
    s.chest(20, 'b')
    const stone = s.chest(30, 'stone')
    const dirt = s.chest(40, 'dirt')
    s.rules.add(stone, ['cobblestone'])
    s.rules.add(dirt, ['dirt'])
    s.world.stock(at(10), 'cobblestone', 5)
    s.world.stock(at(20), 'dirt', 5)
    const open = s.world.open.bind(s.world)
    s.world.open = (position) => {
      if (position.x === 30) s.clock.advance(120_000) // delivering the first batch takes a while
      return open(position)
    }

    const result = await s.skill.run(input({ maxMinutes: 1 }), skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: { left: [{ item: expect.any(String) as unknown as string, reason: 'time is up' }] },
    })
  })

  it('refuses when the bot is not connected', async () => {
    const s = await setup()
    s.chest(10, 'junk')
    s.world.inventory.value = undefined

    const result = await s.skill.run(input(), skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'not_connected' } })
  })
})
