import { beforeEach, describe, expect, it } from '@jest/globals'
import { ok } from '../../../../src/core/result.js'
import { TaskLauncher } from '../../../../src/mcp/task-launcher.js'
import {
  EditSignTool,
  PlaceSignTool,
  ReadSignsTool,
  RemoveSignTool,
} from '../../../../src/mcp/tools/sign-tools.js'
import type { EditSignSkill } from '../../../../src/skills/signs/edit-sign-skill.js'
import type { PlaceSignSkill } from '../../../../src/skills/signs/place-sign-skill.js'
import type { RemoveSignSkill } from '../../../../src/skills/signs/remove-sign-skill.js'
import { SignReader } from '../../../../src/skills/signs/sign-reader.js'
import { SignTargeter } from '../../../../src/skills/signs/sign-target.js'
import { ContainerIndex } from '../../../../src/state/container-index.js'
import { SignRegistry } from '../../../../src/state/sign-registry.js'
import { TaskManager } from '../../../../src/tasks/task-manager.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeLogger } from '../../../fakes/fake-logger.js'
import { FakeEntityScanner } from '../../../fakes/fake-ports.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'
import { FLOOR, FakeLookTarget, FakeSignAccess, SignWorld } from '../../../fakes/sign-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const context = { signal: new AbortController().signal }
const at = (x: number, y: number, z: number) => ({ x, y, z })

/** A skill that records what it was asked to do. */
const recording = (name: string, runs: unknown[]) => ({
  name,
  run: (input: unknown) => {
    runs.push(input)
    return Promise.resolve(ok({ done: true }))
  },
})

async function setup() {
  const clock = new FakeClock(0)
  const tasks = new TaskManager({
    clock,
    scheduler: new FakeScheduler(clock),
    logger: new FakeLogger(),
  })
  const launcher = new TaskLauncher(tasks, clock)
  const world = new SignWorld()
  const registry = new SignRegistry(clock)
  await registry.attach(new InMemoryStateStore())
  const reader = new SignReader(world, new FakeSignAccess(world), registry)
  const look = new FakeLookTarget()
  const targeter = new SignTargeter(world, look, reader)
  const index = new ContainerIndex(clock)
  await index.attach(new InMemoryStateStore())
  const entities = new FakeEntityScanner()
  return { launcher, world, reader, look, targeter, index, entities }
}

describe('place_sign', () => {
  let s: Awaited<ReturnType<typeof setup>>
  let runs: unknown[]
  let tool: PlaceSignTool

  beforeEach(async () => {
    s = await setup()
    runs = []
    tool = new PlaceSignTool(
      recording('place_sign', runs) as unknown as PlaceSignSkill,
      s.launcher,
      s.look,
      s.index,
      s.entities,
      'Steve',
    )
  })
  const run = (input: Record<string, unknown>) =>
    tool.execute(tool.inputSchema.parse(input), context)

  it('puts the sign on the face the owner looks at, turned towards where they stand', async () => {
    s.look.hits.set('Steve', { name: 'stone', position: at(5, FLOOR, 5), face: 'top' })
    s.entities.players.set('steve', {
      name: 'Steve',
      online: true,
      position: at(5, FLOOR, 20),
      distance: 20,
    })

    const result = await run({ text: 'Iron' })

    expect(result).toMatchObject({ ok: true, data: { status: 'succeeded' } })
    expect(runs).toEqual([
      {
        reference: at(5, FLOOR, 5),
        face: 'top',
        lines: ['Iron', '', '', ''],
        side: 'front',
        wood: undefined,
        facing: undefined,
        towards: at(5, FLOOR, 20),
        replaceBlock: false,
      },
    ])
  })

  it('passes replace_block on to the skill', async () => {
    s.look.hits.set('Steve', { name: 'oak_fence', position: at(5, FLOOR, 5), face: 'top' })

    await run({ text: 'Iron', replace_block: true })

    expect(runs[0]).toMatchObject({ replaceBlock: true })
  })

  it('hangs the sign on a side when the owner looks at the top of a chest', async () => {
    s.look.hits.set('Steve', { name: 'chest', position: at(5, FLOOR, 5), face: 'top' })

    await run({ text: 'Iron' })
    s.look.hits.set('Steve', { name: 'barrel', position: at(5, FLOOR, 5), face: 'bottom' })
    await run({ text: 'Iron' })
    s.look.hits.set('Steve', { name: 'stone', position: at(5, FLOOR, 5), face: 'top' })
    await run({ text: 'Iron' })

    expect(runs).toMatchObject([
      { reference: at(5, FLOOR, 5), face: undefined },
      { reference: at(5, FLOOR, 5), face: undefined },
      { reference: at(5, FLOOR, 5), face: 'top' },
    ])
  })

  it('uses the block and face it is given, and the wood, side, and facing', async () => {
    await run({
      text: 'Farm',
      at: at(1, 2, 3),
      face: 'north',
      wood: 'spruce',
      side: 'back',
      facing: 'east',
    })

    expect(runs[0]).toMatchObject({
      reference: at(1, 2, 3),
      face: 'north',
      wood: 'spruce',
      side: 'back',
      facing: 'east',
    })
  })

  it('hangs a sign beside a registered container, with its label as the text', async () => {
    const chest = s.index.register(at(4, FLOOR, 4), 'chest', { label: 'Iron' })
    if (!chest.ok) throw new Error(chest.error)

    await run({ beside: 'Iron' })
    await run({ beside: chest.value.id, text: 'Ores' })

    expect(runs[0]).toMatchObject({
      reference: at(4, FLOOR, 4),
      face: undefined,
      lines: ['Iron', '', '', ''],
    })
    expect(runs[1]).toMatchObject({ lines: ['Ores', '', '', ''] })
  })

  it('fails for a container it does not know, and for one with no label and no text', async () => {
    expect(await run({ beside: 'nowhere', text: 'x' })).toMatchObject({ ok: false })
    const chest = s.index.register(at(4, FLOOR, 4), 'chest')
    if (!chest.ok) throw new Error(chest.error)

    const result = await run({ beside: chest.value.id })

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('no_text') })
    expect(runs).toEqual([])
  })

  it('says how to split text that is too long, and starts nothing', async () => {
    s.look.hits.set('Steve', { name: 'stone', position: at(5, FLOOR, 5), face: 'south' })

    const result = await run({
      text: 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo',
    })

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('text_too_long') })
    expect(runs).toEqual([])
  })

  it('needs a target: nobody is looking, or no player is known', async () => {
    expect(await run({ text: 'x' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('not looking'),
    })

    const nobody = new PlaceSignTool(
      recording('place_sign', runs) as unknown as PlaceSignSkill,
      s.launcher,
      s.look,
      s.index,
      s.entities,
      undefined,
    )
    expect(nobody.execute(nobody.inputSchema.parse({ text: 'x' }), context)).toMatchObject({
      ok: false,
      error: expect.stringContaining('Say where'),
    })
  })

  it('checks its input at the boundary', () => {
    const parse = (input: Record<string, unknown>) => tool.inputSchema.safeParse(input).success
    expect(parse({ text: 'x', at: at(1, 2, 3) })).toBe(false)
    expect(parse({ text: 'x', face: 'top' })).toBe(false)
    expect(parse({ text: 'x', lines: ['y'] })).toBe(false)
    expect(parse({ text: 'x', beside: 'a', at: at(1, 2, 3), face: 'top' })).toBe(false)
    expect(parse({ text: 'x', face: 'bottom', at: at(1, 2, 3) })).toBe(false)
    expect(parse({ text: 'x', wood: 'plastic' })).toBe(false)
    expect(parse({ text: 'x', at: at(1, 2, 3), face: 'top', wood: 'birch' })).toBe(true)
  })
})

describe('edit_sign and remove_sign', () => {
  let s: Awaited<ReturnType<typeof setup>>
  let runs: unknown[]

  beforeEach(async () => {
    s = await setup()
    runs = []
    s.world.addSign(at(3, FLOOR, 0), { front: ['Iron'] })
    s.world.addSign(at(9, FLOOR, 0), { front: ['Iron mine'] })
    s.world.addSign(at(0, FLOOR, 9), { front: ['Farm'] })
  })

  const editTool = () =>
    new EditSignTool(
      recording('edit_sign', runs) as unknown as EditSignSkill,
      s.launcher,
      s.targeter,
      'Steve',
    )
  const removeTool = () =>
    new RemoveSignTool(
      recording('remove_sign', runs) as unknown as RemoveSignSkill,
      s.launcher,
      s.targeter,
      'Steve',
    )

  it('edits the sign the owner looks at, with the text wrapped and clearing allowed', async () => {
    s.look.hits.set('Steve', { name: 'oak_wall_sign', position: at(0, FLOOR, 9), face: 'north' })
    const tool = editTool()

    await tool.execute(tool.inputSchema.parse({ text: 'Wheat and carrots' }), context)
    await tool.execute(tool.inputSchema.parse({ lines: [''], side: 'back' }), context)

    expect(runs).toEqual([
      { position: at(0, FLOOR, 9), lines: ['Wheat and', 'carrots', '', ''], side: 'front' },
      { position: at(0, FLOOR, 9), lines: ['', '', '', ''], side: 'back' },
    ])
  })

  it('needs new text', () => {
    expect(editTool().inputSchema.safeParse({ at: at(3, FLOOR, 0) }).success).toBe(false)
    expect(editTool().inputSchema.safeParse({ text: 'a', lines: ['b'] }).success).toBe(false)
  })

  it('edits by position or by matching text', async () => {
    const tool = editTool()

    await tool.execute(tool.inputSchema.parse({ text: 'Ores', at: at(3, FLOOR, 0) }), context)
    await tool.execute(tool.inputSchema.parse({ text: 'Crops', matching: 'farm' }), context)

    expect(runs).toMatchObject([{ position: at(3, FLOOR, 0) }, { position: at(0, FLOOR, 9) }])
  })

  it('asks which sign when the text matches several, and starts nothing', async () => {
    const tool = removeTool()

    const result = await tool.execute(tool.inputSchema.parse({ matching: 'iron' }), context)

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('ambiguous') })
    expect(runs).toEqual([])
  })

  it('removes only the one sign that was named', async () => {
    s.look.hits.set('Steve', { name: 'oak_wall_sign', position: at(9, FLOOR, 0), face: 'north' })
    const tool = removeTool()

    await tool.execute(tool.inputSchema.parse({}), context)

    expect(runs).toEqual([{ position: at(9, FLOOR, 0) }])
  })

  it('removes nothing without a target, and has no way to ask for every sign', async () => {
    const tool = removeTool()

    const result = await tool.execute(tool.inputSchema.parse({ for_player: 'Nobody' }), context)

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('not_looking') })
    expect(runs).toEqual([])
    expect(Object.keys(tool.inputSchema.shape)).not.toContain('all')
  })
})

describe('read_signs', () => {
  it('lists the signs around the bot with their text', async () => {
    const s = await setup()
    s.world.addSign(at(3, FLOOR, 0), { front: ['Iron', 'chest'] })
    s.world.addSign(at(0, FLOOR, 9), { front: ['Farm'] })
    const tool = new ReadSignsTool(s.reader)

    const all = tool.execute(tool.inputSchema.parse({}))
    const some = tool.execute(tool.inputSchema.parse({ matching: 'farm', radius: 30 }))

    expect(all).toMatchObject({ ok: true, data: { count: 2 } })
    expect(some).toMatchObject({ ok: true, data: { count: 1, signs: [{ front: ['Farm'] }] } })
    expect(tool.inputSchema.safeParse({ radius: 500 }).success).toBe(false)
  })
})
