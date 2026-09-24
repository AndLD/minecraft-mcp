import { beforeEach, describe, expect, it } from '@jest/globals'
import { DropCollector } from '../../../../src/skills/gathering/drop-collector.js'
import { EditSignSkill } from '../../../../src/skills/signs/edit-sign-skill.js'
import { RemoveSignSkill } from '../../../../src/skills/signs/remove-sign-skill.js'
import { SignRegistry } from '../../../../src/state/sign-registry.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeInventory } from '../../../fakes/fake-ports.js'
import {
  AutoScheduler,
  FakeAreaGuard,
  FakeDigger,
  FakeDroppedItems,
  InstantNavigator,
  skillContext,
} from '../../../fakes/gathering-fakes.js'
import { FLOOR, FakeSignAccess, SignWorld } from '../../../fakes/sign-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const at = (x: number, y: number, z: number) => ({ x, y, z })
const SIGN = at(5, FLOOR, 6)
const NEW_TEXT = ['Ores', '', '', '']

async function setup() {
  const clock = new FakeClock(0)
  const world = new SignWorld()
  world.addSign(SIGN, { front: ['Iron'] })
  const signs = new FakeSignAccess(world)
  const navigator = new InstantNavigator()
  const guard = new FakeAreaGuard()
  const registry = new SignRegistry(clock)
  await registry.attach(new InMemoryStateStore())
  registry.note(SIGN, { lines: ['Iron'], side: 'front', wood: 'oak' })
  const scheduler = new AutoScheduler(clock)
  const digger = new FakeDigger()
  const droppedItems = new FakeDroppedItems()
  const inventory = new FakeInventory()
  inventory.value = { stacks: [], emptySlots: 10, heldItem: undefined }
  // Breaking the sign takes it out of the world and leaves its item on the ground; walking there picks it up.
  digger.onDug = (position) => {
    world.removeSign(position)
    droppedItems.drop('oak_sign', position, 1)
  }
  navigator.onArrive = () => {
    if (droppedItems.items.length === 0) return
    droppedItems.items = []
    inventory.value = {
      stacks: [{ name: 'oak_sign', count: 1 }],
      emptySlots: 9,
      heldItem: undefined,
    }
  }
  const edit = new EditSignSkill({ signs, navigator, guard, registry, scheduler })
  const remove = new RemoveSignSkill({
    blocks: world,
    signs,
    navigator,
    digger,
    drops: new DropCollector({ drops: droppedItems, navigator, scheduler }),
    inventory,
    guard,
    registry,
  })
  return { world, signs, navigator, guard, registry, digger, inventory, edit, remove }
}

describe('EditSignSkill', () => {
  let s: Awaited<ReturnType<typeof setup>>
  beforeEach(async () => {
    s = await setup()
  })
  const input = { position: SIGN, lines: NEW_TEXT, side: 'front' as const }

  it('walks up, reopens the editor, replaces the text, and reads it back', async () => {
    const result = await s.edit.run(input, skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: { position: SIGN, side: 'front', lines: NEW_TEXT, previous: ['Iron', '', '', ''] },
    })
    expect(s.navigator.trips).toEqual([{ target: SIGN, within: 3 }])
    expect(s.signs.writes).toEqual([
      { position: SIGN, side: 'front', lines: NEW_TEXT, reopen: true },
    ])
    expect(s.registry.at(SIGN)?.lines).toEqual(NEW_TEXT)
  })

  it('refuses a waxed sign and says it can still be removed', async () => {
    s.world.addSign(SIGN, { front: ['Iron'], waxed: true })

    const result = await s.edit.run(input, skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'waxed' } })
    expect(result.ok ? '' : result.error.message).toContain('remove_sign')
    expect(s.signs.writes).toEqual([])
    expect(s.navigator.trips).toEqual([])
  })

  it('refuses a block that is not a sign, and a sign in a protected area', async () => {
    const other = await s.edit.run({ ...input, position: at(1, FLOOR, 1) }, skillContext().context)
    expect(other).toMatchObject({ ok: false, error: { reason: 'not_a_sign' } })

    s.guard.protect('house', () => true)
    const guarded = await s.edit.run(input, skillContext().context)
    expect(guarded).toMatchObject({ ok: false, error: { reason: 'protected_area' } })
    expect(s.signs.writes).toEqual([])
  })

  it('reports an editor that did not open, a text that did not take, and a failed walk', async () => {
    s.signs.failure = { reason: 'not_editable', message: 'no editor' }
    expect(await s.edit.run(input, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'not_editable' },
    })

    s.signs.failure = undefined
    s.signs.ignoreText = true
    expect(await s.edit.run(input, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'text_not_confirmed' },
    })

    s.navigator.failures = [{ reason: 'unreachable', message: 'no path' }]
    expect(await s.edit.run(input, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'unreachable' },
    })
  })

  it('edits the back side on request', async () => {
    const result = await s.edit.run({ ...input, side: 'back' }, skillContext().context)

    expect(result.ok && result.value.previous).toEqual(['', '', '', ''])
    expect(s.world.signs.get('5,64,6')?.back).toEqual(NEW_TEXT)
  })
})

describe('RemoveSignSkill', () => {
  let s: Awaited<ReturnType<typeof setup>>
  beforeEach(async () => {
    s = await setup()
  })

  it('breaks exactly that sign, picks the item up, and forgets it', async () => {
    const result = await s.remove.run({ position: SIGN }, skillContext().context)

    expect(result).toMatchObject({
      ok: true,
      value: { position: SIGN, text: ['Iron'], pickedUp: true, item: 'oak_sign' },
    })
    expect(s.digger.dug).toEqual([SIGN])
    expect(s.world.blockAt(SIGN)).toBe('air')
    expect(s.registry.all()).toEqual([])
  })

  it('breaks a waxed sign too: waxing only stops editing', async () => {
    s.world.addSign(SIGN, { front: ['Keep'], waxed: true })

    const result = await s.remove.run({ position: SIGN }, skillContext().context)

    expect(result.ok && result.value.text).toEqual(['Keep'])
  })

  it('reads out both sides of what it took down', async () => {
    s.world.addSign(SIGN, { front: ['Iron'], back: ['Ores'] })

    const result = await s.remove.run({ position: SIGN }, skillContext().context)

    expect(result.ok && result.value.text).toEqual(['Iron', 'Ores'])
  })

  it('leaves signs in protected areas and blocks that are not signs alone', async () => {
    s.guard.protect('house', () => true)
    expect(await s.remove.run({ position: SIGN }, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'protected_area' },
    })
    expect(await s.remove.run({ position: at(1, FLOOR, 1) }, skillContext().context)).toMatchObject(
      {
        ok: false,
        error: { reason: 'not_a_sign' },
      },
    )
    expect(s.digger.dug).toEqual([])
  })

  it('reports a sign that would not break, and a walk that failed', async () => {
    s.digger.failures = [{ reason: 'failed', message: 'stuck' }]
    expect(await s.remove.run({ position: SIGN }, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'not_removed' },
    })

    s.navigator.failures = [{ reason: 'unreachable', message: 'no path' }]
    expect(await s.remove.run({ position: SIGN }, skillContext().context)).toMatchObject({
      ok: false,
      error: { reason: 'unreachable' },
    })
  })

  it('says when the item was not picked up', async () => {
    s.navigator.onArrive = () => undefined

    const result = await s.remove.run({ position: SIGN }, skillContext().context)

    expect(result.ok && result.value.pickedUp).toBe(false)
  })

  it('reports a cancelled dig', async () => {
    const run = skillContext()
    run.controller.abort()

    const result = await s.remove.run({ position: SIGN }, run.context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
  })
})
