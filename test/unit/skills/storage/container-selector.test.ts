import { describe, expect, it } from '@jest/globals'
import { MineflayerItemFacts } from '../../../../src/bot/mineflayer-item-facts.js'
import {
  ContainerSelector,
  type SelectionContext,
} from '../../../../src/skills/storage/container-selector.js'
import { ContainerIndex } from '../../../../src/state/container-index.js'
import { StorageRules } from '../../../../src/state/storage-rules.js'
import { FakeBot } from '../../../fakes/fake-bot.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const facts = new MineflayerItemFacts({
  current: () => new FakeBot().useGameData(),
  onChange: () => () => undefined,
})
const at = (x: number) => ({ x, y: 64, z: 0 })

async function setup() {
  const index = new ContainerIndex(new FakeClock())
  const rules = new StorageRules()
  const store = new InMemoryStateStore()
  await index.attach(store)
  await rules.attach(store)
  const context = (over: Partial<SelectionContext> = {}): SelectionContext => ({
    from: at(0),
    maxDistance: 64,
    exclude: new Set(),
    unknown: [],
    ...over,
  })
  return { index, rules, selector: new ContainerSelector(index, rules, facts), context }
}

const idOf = (target: ReturnType<ContainerSelector['select']>): string | undefined =>
  target?.kind === 'known' ? target.entry.id : undefined

describe('ContainerSelector', () => {
  it('takes the container of the first rule that matches, highest priority first', async () => {
    const { index, rules, selector, context } = await setup()
    index.register(at(10), 'chest', { label: 'stone' })
    index.register(at(20), 'chest', { label: 'metal' })
    index.register(at(30), 'chest', { label: 'misc' })
    rules.add('container-1', ['stone', 'cobblestone'])
    rules.add('container-2', ['ores', 'ingots'])
    rules.add('container-3', ['*'], -10)

    expect(idOf(selector.select('cobblestone', context()))).toBe('container-1')
    expect(idOf(selector.select('raw_iron', context()))).toBe('container-2')
    expect(idOf(selector.select('iron_ingot', context()))).toBe('container-2')
    expect(idOf(selector.select('feather', context()))).toBe('container-3')
  })

  it('a higher priority beats a more specific rule', async () => {
    const { index, rules, selector, context } = await setup()
    index.register(at(10), 'chest')
    index.register(at(20), 'chest')
    rules.add('container-1', ['coal'], 0)
    rules.add('container-2', ['ores'], 5)

    expect(idOf(selector.select('coal', context()))).toBe('container-2')
  })

  it('uses a rule target wherever it is, even when it looks full or is far away', async () => {
    const { index, rules, selector, context } = await setup()
    index.register(at(500), 'chest')
    index.recordContents('container-1', [], { totalSlots: 27, emptySlots: 0 })
    rules.add('container-1', ['dirt'])

    expect(idOf(selector.select('dirt', context({ maxDistance: 10 })))).toBe('container-1')
  })

  it('skips rule targets that are protected, excluded, or forgotten, and falls to the next rule', async () => {
    const { index, rules, selector, context } = await setup()
    index.register(at(10), 'chest', { protected: true })
    index.register(at(20), 'chest')
    index.register(at(30), 'chest')
    rules.add('container-1', ['dirt'], 9)
    rules.add('container-9', ['dirt'], 8) // a container that no longer exists
    rules.add('container-2', ['dirt'], 7)
    rules.add('container-3', ['dirt'], 6)

    expect(idOf(selector.select('dirt', context()))).toBe('container-2')
    expect(idOf(selector.select('dirt', context({ exclude: new Set(['container-2']) })))).toBe(
      'container-3',
    )
  })

  it('without a matching rule takes the nearest known container with room', async () => {
    const { index, selector, context } = await setup()
    index.register(at(30), 'chest')
    index.register(at(10), 'chest')
    index.register(at(5), 'chest')
    index.recordContents('container-3', [], { totalSlots: 27, emptySlots: 0 }) // the nearest is full

    expect(idOf(selector.select('dirt', context()))).toBe('container-2')
    expect(idOf(selector.select('dirt', context({ exclude: new Set(['container-2']) })))).toBe(
      'container-1',
    )
  })

  it('treats a container never opened as having room, and never uses protected ones as a fallback', async () => {
    const { index, selector, context } = await setup()
    index.register(at(5), 'chest', { protected: true })
    index.register(at(50), 'chest')

    expect(idOf(selector.select('dirt', context()))).toBe('container-2')
  })

  it('only uses fallback containers within the maximum distance', async () => {
    const { index, selector, context } = await setup()
    index.register(at(50), 'chest')

    expect(selector.select('dirt', context({ maxDistance: 20 }))).toBeUndefined()
  })

  it('offers a chest nobody registered yet, nearest first, when no known one will do', async () => {
    const { index, selector, context } = await setup()
    index.register(at(5), 'chest', { protected: true })

    const target = selector.select(
      'dirt',
      context({
        unknown: [
          { position: at(40), blockName: 'barrel' },
          { position: at(12), blockName: 'chest' },
          { position: at(5), blockName: 'chest' }, // the protected one is known already
        ],
      }),
    )

    expect(target).toEqual({ kind: 'unknown', position: at(12), blockName: 'chest' })
  })

  it('reports that there is nowhere to put it', async () => {
    const { selector, context } = await setup()

    expect(selector.select('dirt', context())).toBeUndefined()
    expect(
      selector.select('dirt', context({ unknown: [{ position: at(500), blockName: 'chest' }] })),
    ).toBeUndefined()
  })
})
