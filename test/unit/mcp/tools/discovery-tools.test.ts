import { beforeEach, describe, expect, it } from '@jest/globals'
import { ok } from '../../../../src/core/result.js'
import { WorldKnowledgeStore } from '../../../../src/knowledge/world-knowledge-store.js'
import { TaskLauncher } from '../../../../src/mcp/task-launcher.js'
import {
  ExploreForStructureTool,
  ListKnownStructuresTool,
  ListLandmarksTool,
  RemoveLandmarkTool,
  SetLandmarkTool,
} from '../../../../src/mcp/tools/discovery-tools.js'
import type { ExploreForStructureSkill } from '../../../../src/skills/discovery/explore-for-structure-skill.js'
import { TaskManager } from '../../../../src/tasks/task-manager.js'
import { DiscoveryWorld } from '../../../fakes/discovery-fakes.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeLogger } from '../../../fakes/fake-logger.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const context = { signal: new AbortController().signal }
const at = (x: number, y: number, z: number) => ({ x, y, z })

describe('explore_for_structure', () => {
  let inputs: unknown[]
  let tasks: TaskManager
  let tool: ExploreForStructureTool

  beforeEach(() => {
    const clock = new FakeClock(0)
    tasks = new TaskManager({
      clock,
      scheduler: new FakeScheduler(clock),
      logger: new FakeLogger(),
    })
    inputs = []
    const skill = {
      name: 'explore_for_structure',
      run: (input: unknown) => {
        inputs.push(input)
        return Promise.resolve(ok({ found: 'a village' }))
      },
    } as unknown as ExploreForStructureSkill
    tool = new ExploreForStructureTool(skill, new TaskLauncher(tasks, clock))
  })

  const run = (input: Record<string, unknown>) =>
    tool.execute(tool.inputSchema.parse(input), context)

  it('starts the search with the defaults, and can be resumed with what it was given', async () => {
    const result = await run({ kind: 'village' })

    expect(result).toMatchObject({ ok: true, data: { status: 'succeeded' } })
    expect(inputs).toEqual([
      {
        kind: 'village',
        maxDistance: 500,
        maxMinutes: 10,
        strategy: 'frontier',
        useLocate: false,
        onlyNew: false,
        returnTo: undefined,
      },
    ])
    expect(tasks.get('task-1')?.resume).toEqual({
      tool: 'explore_for_structure',
      arguments: {
        kind: 'village',
        max_distance: 500,
        max_minutes: 10,
        strategy: 'frontier',
        use_locate: false,
        only_new: false,
      },
    })
  })

  it('passes the limits, strategy, and landmark on', async () => {
    await run({
      kind: 'desert_temple',
      max_distance: 1200,
      max_minutes: 30,
      strategy: 'spiral',
      use_locate: false,
      only_new: true,
      return_to: 'home',
    })

    expect(inputs[0]).toEqual({
      kind: 'desert_temple',
      maxDistance: 1200,
      maxMinutes: 30,
      strategy: 'spiral',
      useLocate: false,
      onlyNew: true,
      returnTo: 'home',
    })
  })

  it('takes a biome or a mob instead of a structure', async () => {
    await run({ biome: 'desert' })
    await run({ mob: 'fox' })

    expect(inputs).toMatchObject([
      { kind: undefined, biome: 'desert' },
      { kind: undefined, mob: 'fox' },
    ])
    expect(tasks.get('task-1')?.description).toBe('Explore for a desert')
  })

  it('needs exactly one of kind, biome, and mob', () => {
    const parse = (input: Record<string, unknown>) => tool.inputSchema.safeParse(input).success

    expect(parse({})).toBe(false)
    expect(parse({ kind: 'village', biome: 'desert' })).toBe(false)
    expect(parse({ biome: 'desert', mob: 'fox' })).toBe(false)
    expect(parse({ biome: '  ' })).toBe(false)
    expect(parse({ mob: 'polar bear' })).toBe(true)
  })

  it('checks its input at the boundary', () => {
    const parse = (input: Record<string, unknown>) => tool.inputSchema.safeParse(input).success

    expect(parse({ kind: 'castle' })).toBe(false)
    expect(parse({ kind: 'village', max_distance: 10 })).toBe(false)
    expect(parse({ kind: 'village', max_distance: 5000 })).toBe(false)
    expect(parse({ kind: 'village', max_minutes: 0 })).toBe(false)
    expect(parse({ kind: 'village', strategy: 'random' })).toBe(false)
    expect(parse({ kind: 'stronghold', max_distance: 3000 })).toBe(true)
  })

  it('tells the agent what it can find and why it may fail', () => {
    expect(tool.description).toContain('desert_temple')
    expect(tool.description).toContain('not_found')
    expect(tool.description).toContain('/locate')
  })
})

describe('the knowledge tools', () => {
  let world: DiscoveryWorld
  let knowledge: WorldKnowledgeStore

  beforeEach(async () => {
    world = new DiscoveryWorld()
    knowledge = new WorldKnowledgeStore(new FakeClock(0))
    await knowledge.attach(new InMemoryStateStore())
  })

  it('list_known_structures lists them nearest first and can filter by kind', () => {
    knowledge.record('village', at(300, 64, 0), { source: 'scan' })
    knowledge.record('village', at(-50, 64, 0), { source: 'locate' })
    knowledge.record('dungeon', at(10, 30, 0), { source: 'scan' })
    const tool = new ListKnownStructuresTool(knowledge, world)

    knowledge.recordBiome('desert', at(200, 64, 0), { source: 'scan' })
    const all = tool.execute(tool.inputSchema.parse({}))
    const villages = tool.execute(tool.inputSchema.parse({ kind: 'village' }))

    expect(all).toMatchObject({
      ok: true,
      data: {
        count: 3,
        structures: [
          { kind: 'dungeon', distance: 10 },
          { kind: 'village', x: -50, distance: 50, source: 'locate' },
          { kind: 'village', x: 300, distance: 300 },
        ],
      },
    })
    expect(villages).toMatchObject({ ok: true, data: { count: 2, biomes: [] } })
    expect(all).toMatchObject({ data: { biomes: [{ name: 'desert', x: 200 }] } })
  })

  it('list_known_structures works without the bot in a world', () => {
    knowledge.record('village', at(300, 64, 0), { source: 'scan' })
    const tool = new ListKnownStructuresTool(knowledge, { read: () => undefined })

    expect(tool.execute(tool.inputSchema.parse({}))).toMatchObject({
      ok: true,
      data: { count: 1, structures: [{ distance: undefined }] },
    })
  })

  it('set_landmark names the place given, or where the bot stands', () => {
    const tool = new SetLandmarkTool(knowledge, world)

    const given = tool.execute(
      tool.inputSchema.parse({ name: 'mine', x: 5, y: 12, z: -7, note: 'iron' }),
    )
    const here = tool.execute(tool.inputSchema.parse({ name: ' home ' }))

    expect(given).toMatchObject({
      ok: true,
      data: { landmark: { name: 'mine', x: 5, y: 12, z: -7, note: 'iron' } },
    })
    expect(here).toMatchObject({
      ok: true,
      data: { landmark: { name: 'home', x: 0, y: 64, z: 0 } },
    })
  })

  it('set_landmark needs the three coordinates together, and a place', () => {
    const tool = new SetLandmarkTool(knowledge, { read: () => undefined })

    expect(tool.inputSchema.safeParse({ name: 'a', x: 1 }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ name: '  ' }).success).toBe(false)
    expect(tool.execute(tool.inputSchema.parse({ name: 'a' }))).toMatchObject({ ok: false })
  })

  it('set_landmark fails when no world is active', () => {
    knowledge.detach()
    const tool = new SetLandmarkTool(knowledge, world)

    expect(tool.execute(tool.inputSchema.parse({ name: 'a' }))).toMatchObject({
      ok: false,
      error: expect.stringContaining('No world is active'),
    })
  })

  it('list_landmarks and remove_landmark', () => {
    knowledge.setLandmark('home', at(1, 2, 3))
    const list = new ListLandmarksTool(knowledge)
    const remove = new RemoveLandmarkTool(knowledge)

    expect(list.execute()).toMatchObject({
      ok: true,
      data: { count: 1, landmarks: [{ name: 'home' }] },
    })
    expect(remove.execute(remove.inputSchema.parse({ name: 'HOME' }))).toEqual({
      ok: true,
      data: { removed: 'HOME' },
    })
    expect(remove.execute(remove.inputSchema.parse({ name: 'home' }))).toMatchObject({ ok: false })
    expect(list.execute()).toMatchObject({ data: { count: 0 } })
  })
})
