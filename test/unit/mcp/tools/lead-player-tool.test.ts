import { beforeEach, describe, expect, it } from '@jest/globals'
import { ok } from '../../../../src/core/result.js'
import { WorldKnowledgeStore } from '../../../../src/knowledge/world-knowledge-store.js'
import { TaskLauncher } from '../../../../src/mcp/task-launcher.js'
import { LeadPlayerTool } from '../../../../src/mcp/tools/lead-player-tool.js'
import type { LeadPlayerSkill } from '../../../../src/skills/movement/lead-player-skill.js'
import { LeadTargetResolver } from '../../../../src/skills/movement/lead-target.js'
import { ContainerIndex } from '../../../../src/state/container-index.js'
import { FarmRegistry } from '../../../../src/state/farm-registry.js'
import { TaskManager } from '../../../../src/tasks/task-manager.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeLogger } from '../../../fakes/fake-logger.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'
import { LeadWorld } from '../../../fakes/lead-fakes.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const context = { signal: new AbortController().signal }
const at = (x: number, y: number, z: number) => ({ x, y, z })

describe('lead_player', () => {
  let inputs: unknown[]
  let tasks: TaskManager
  let knowledge: WorldKnowledgeStore
  let world: LeadWorld
  let tool: LeadPlayerTool

  const build = (owner: string | null = 'Steve') =>
    new LeadPlayerTool(
      {
        name: 'lead_player',
        run: (input: unknown) => {
          inputs.push(input)
          return Promise.resolve(ok({ destination: 'x' }))
        },
      } as unknown as LeadPlayerSkill,
      new TaskLauncher(tasks, clockOf),
      new LeadTargetResolver({ knowledge, containers, farms, vitals: world }),
      world,
      owner ?? undefined,
    )
  let clockOf: FakeClock
  let containers: ContainerIndex
  let farms: FarmRegistry

  beforeEach(async () => {
    clockOf = new FakeClock(0)
    tasks = new TaskManager({
      clock: clockOf,
      scheduler: new FakeScheduler(clockOf),
      logger: new FakeLogger(),
    })
    inputs = []
    world = new LeadWorld()
    const store = new InMemoryStateStore()
    knowledge = new WorldKnowledgeStore(clockOf)
    containers = new ContainerIndex(clockOf)
    farms = new FarmRegistry(clockOf)
    await knowledge.attach(store)
    await containers.attach(store)
    await farms.attach(store)
    tool = build()
  })

  const run = (input: Record<string, unknown>) =>
    tool.execute(tool.inputSchema.parse(input), context)

  it('leads the owner to a landmark, with the defaults', async () => {
    knowledge.setLandmark('home', at(10, 64, 20))

    const result = await run({ target: 'home' })

    expect(result).toMatchObject({ ok: true, data: { status: 'succeeded' } })
    expect(inputs[0]).toEqual({
      player: 'Steve',
      destination: { label: 'home', position: expect.objectContaining({ x: 10, z: 20 }) },
      leadDistance: 8,
      arriveWithin: 8,
    })
    expect(tasks.get('task-1')?.description).toBe('Lead Steve to home')
    expect(tasks.get('task-1')?.resume).toMatchObject({
      tool: 'lead_player',
      arguments: { target: 'home', lead_distance: 8, arrive_within: 8 },
    })
  })

  it('leads to coordinates and to a found structure, for the player named', async () => {
    knowledge.record('village', at(100, 64, 50), { source: 'scan' })

    await run({ x: 5, y: 70, z: -3, lead_distance: 12, arrive_within: 4, for_player: 'Alex' })
    await run({ target: 'the village' })

    expect(inputs[0]).toEqual({
      player: 'Alex',
      destination: { label: '5, 70, -3', position: at(5, 70, -3) },
      leadDistance: 12,
      arriveWithin: 4,
    })
    expect(inputs[1]).toMatchObject({ destination: { label: 'the village' } })
  })

  it('fails for an unknown target with what is known, and starts nothing', async () => {
    knowledge.setLandmark('home', at(0, 64, 0))

    const result = await run({ target: 'castle' })

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('unknown target') })
    expect(inputs).toEqual([])
  })

  it('refuses a structure of the Overworld when the bot is in the Nether', async () => {
    knowledge.record('village', at(100, 64, 50), { source: 'scan' })
    world.dimension = 'minecraft:the_nether'

    const result = await run({ target: 'village' })

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('wrong_dimension') })
    expect(await run({ x: 1, y: 2, z: 3 })).toMatchObject({ ok: true })
  })

  it('needs a player: no owner and none given', async () => {
    tool = build(null)

    expect(await run({ target: 'home' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('Say which player'),
    })
  })

  it('checks its input at the boundary', () => {
    const parse = (input: Record<string, unknown>) => tool.inputSchema.safeParse(input).success

    expect(parse({})).toBe(false)
    expect(parse({ target: 'home', x: 1, y: 2, z: 3 })).toBe(false)
    expect(parse({ x: 1, y: 2 })).toBe(false)
    expect(parse({ target: 'home', lead_distance: 4 })).toBe(false)
    expect(parse({ target: 'home', lead_distance: 17 })).toBe(false)
    expect(parse({ target: 'home', lead_distance: 7.5 })).toBe(false)
    expect(parse({ target: 'home', arrive_within: 1 })).toBe(false)
    expect(parse({ target: '  ' })).toBe(false)
    expect(parse({ target: 'home', lead_distance: 16, arrive_within: 30 })).toBe(true)
  })

  it('tells the agent the rule and the failures', () => {
    expect(tool.description).toContain('never gets farther')
    expect(tool.description).toContain('player_lost')
    expect(tool.description).toContain('player_not_following')
  })
})
