import { describe, expect, it } from '@jest/globals'
import { err, ok } from '../../../../src/core/result.js'
import type { SkillResult } from '../../../../src/core/skill.types.js'
import { TaskLauncher } from '../../../../src/mcp/task-launcher.js'
import {
  BreedAnimalsTool,
  BuildFarmTool,
  CollectEggsTool,
  CollectSaplingsTool,
  DiscoverFarmTool,
  HarvestCropsTool,
  HarvestTreesTool,
  InspectFarmTool,
  ListFarmsTool,
  LureAnimalsTool,
  PlantCropsTool,
  PlantTreesTool,
  RegisterFarmTool,
  SetEggPolicyTool,
  TendFarmTool,
} from '../../../../src/mcp/tools/farming-tools.js'
import type {
  BreedAnimalsInput,
  BreedAnimalsOutput,
  BreedAnimalsSkill,
} from '../../../../src/skills/farming/breed-animals-skill.js'
import type {
  BuildFarmInput,
  BuildFarmOutput,
  BuildFarmSkill,
} from '../../../../src/skills/farming/build-farm-skill.js'
import type {
  HarvestCropsInput,
  HarvestCropsOutput,
  HarvestCropsSkill,
} from '../../../../src/skills/farming/harvest-crops-skill.js'
import type { InspectFarmSkill } from '../../../../src/skills/farming/inspect-farm-skill.js'
import type {
  LureAnimalsInput,
  LureAnimalsOutput,
  LureAnimalsSkill,
} from '../../../../src/skills/farming/lure-animals-skill.js'
import type {
  PlantCropsInput,
  PlantCropsOutput,
  PlantCropsSkill,
} from '../../../../src/skills/farming/plant-crops-skill.js'
import type {
  HarvestTreesInput,
  HarvestTreesSkill,
} from '../../../../src/skills/farming/harvest-trees-skill.js'
import type { DiscoverFarmSkill } from '../../../../src/skills/farming/discover-farm-skill.js'
import type {
  CollectSaplingsInput,
  CollectSaplingsSkill,
} from '../../../../src/skills/farming/collect-saplings-skill.js'
import type {
  PlantTreesInput,
  PlantTreesSkill,
} from '../../../../src/skills/farming/plant-trees-skill.js'
import type { TendFarmSkill } from '../../../../src/skills/farming/tend-farm-skill.js'
import type {
  CollectEggsInput,
  CollectEggsOutput,
  CollectEggsSkill,
} from '../../../../src/skills/farming/collect-eggs-skill.js'
import { EggPolicy } from '../../../../src/state/egg-policy.js'
import { FarmRegistry } from '../../../../src/state/farm-registry.js'
import { StandingInstructions } from '../../../../src/state/standing-instructions.js'
import { TaskManager } from '../../../../src/tasks/task-manager.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeLogger } from '../../../fakes/fake-logger.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const context = { signal: new AbortController().signal }

function launching() {
  const clock = new FakeClock(Date.UTC(2026, 8, 19, 12, 0, 0))
  const tasks = new TaskManager({
    clock,
    scheduler: new FakeScheduler(clock),
    logger: new FakeLogger(),
  })
  return { tasks, launcher: new TaskLauncher(tasks, clock) }
}

async function registry() {
  const farms = new FarmRegistry(new FakeClock(0))
  await farms.attach(new InMemoryStateStore())
  return farms
}

describe('BuildFarmTool', () => {
  it('translates input and runs the skill through the task launcher', async () => {
    const { launcher } = launching()
    const runs: BuildFarmInput[] = []
    const outcome: SkillResult<BuildFarmOutput> = ok({
      steps: 1,
      placed: 1,
      broken: 0,
      lights: 0,
      alreadyDone: 0,
      used: [],
      ended: [],
      missingOptional: [],
      kind: 'wheat field 3x3',
      origin: { x: 0, y: 64, z: 0 },
      bounds: { from: { x: 0, y: 64, z: 0 }, to: { x: 2, y: 66, z: 2 } },
      farm: {
        id: 'farm-1',
        kind: 'field',
        crop: 'wheat',
        species: null,
        herdTarget: null,
        gateSide: 'south',
        spots: null,
        bounds: { from: { x: 0, y: 64, z: 0 }, to: { x: 2, y: 66, z: 2 } },
        label: null,
        group: null,
        builtByBot: true,
        registeredAt: '2026-09-19T12:00:00.000Z',
      },
      protectedArea: true,
      fetched: [],
      planted: 8,
    })
    const skill = {
      name: 'build_farm',
      run: (input: BuildFarmInput) => {
        runs.push(input)
        return Promise.resolve(outcome)
      },
    } as unknown as BuildFarmSkill
    const tool = new BuildFarmTool(skill, launcher)

    const result = await tool.execute(
      tool.inputSchema.parse({ kind: 'field', params: { width: 3, length: 3, crop: 'wheat' } }),
      context,
    )

    expect(runs[0]).toMatchObject({ kind: 'field', fetchFromStorage: true })
    expect(result).toMatchObject({ ok: true, data: { result: { kind: 'wheat field 3x3' } } })
  })
})

describe('PlantCropsTool', () => {
  it('passes the farm, area, crop, and max_plants through', async () => {
    const { launcher } = launching()
    const runs: PlantCropsInput[] = []
    const outcome: SkillResult<PlantCropsOutput> = ok({
      planted: 2,
      tilled: 1,
      skipped: 0,
      repaired: 0,
      stillBare: 0,
    })
    const skill = {
      name: 'plant_crops',
      run: (input: PlantCropsInput) => {
        runs.push(input)
        return Promise.resolve(outcome)
      },
    } as unknown as PlantCropsSkill
    const tool = new PlantCropsTool(skill, launcher)

    const result = await tool.execute(
      tool.inputSchema.parse({ farm: 'wheat field', crop: 'wheat', max_plants: 5 }),
      context,
    )

    expect(runs[0]).toEqual({ farm: 'wheat field', area: undefined, crop: 'wheat', maxPlants: 5 })
    expect(result).toMatchObject({ ok: true, data: { result: { planted: 2 } } })
  })
})

describe('HarvestCropsTool', () => {
  it('defaults replant to true', async () => {
    const { launcher } = launching()
    const runs: HarvestCropsInput[] = []
    const outcome: SkillResult<HarvestCropsOutput> = ok({ harvested: 3, replanted: 2 })
    const skill = {
      name: 'harvest_crops',
      run: (input: HarvestCropsInput) => {
        runs.push(input)
        return Promise.resolve(outcome)
      },
    } as unknown as HarvestCropsSkill
    const tool = new HarvestCropsTool(skill, launcher)

    const result = await tool.execute(tool.inputSchema.parse({ farm: 'wheat field' }), context)

    expect(runs[0]).toEqual({ farm: 'wheat field', area: undefined, replant: true })
    expect(result).toMatchObject({ ok: true, data: { result: { harvested: 3 } } })
  })
})

describe('LureAnimalsTool', () => {
  it('translates input and runs the skill through the task launcher', async () => {
    const { launcher } = launching()
    const runs: LureAnimalsInput[] = []
    const outcome: SkillResult<LureAnimalsOutput> = ok({
      led: 1,
      requested: 2,
      room: 2,
      shortfall: 1,
      abandoned: [],
      penFull: false,
    })
    const skill = {
      name: 'lure_animals',
      run: (input: LureAnimalsInput) => {
        runs.push(input)
        return Promise.resolve(outcome)
      },
    } as unknown as LureAnimalsSkill
    const tool = new LureAnimalsTool(skill, launcher)

    const result = await tool.execute(
      tool.inputSchema.parse({ species: 'cow', count: 2, farm: 'cow pen' }),
      context,
    )

    expect(runs[0]).toEqual({
      species: 'cow',
      count: 2,
      farm: 'cow pen',
      destination: undefined,
      maxDistance: 32,
    })
    expect(result).toMatchObject({ ok: true, data: { result: { led: 1 } } })
  })
})

describe('BreedAnimalsTool', () => {
  it('translates input and runs the skill through the task launcher', async () => {
    const { launcher } = launching()
    const runs: BreedAnimalsInput[] = []
    const outcome: SkillResult<BreedAnimalsOutput> = ok({
      bred: 1,
      pairsFed: 1,
      herdSize: 5,
      targetCount: 6,
    })
    const skill = {
      name: 'breed_animals',
      run: (input: BreedAnimalsInput) => {
        runs.push(input)
        return Promise.resolve(outcome)
      },
    } as unknown as BreedAnimalsSkill
    const tool = new BreedAnimalsTool(skill, launcher)

    const result = await tool.execute(
      tool.inputSchema.parse({ species: 'cow', target_count: 6, farm: 'cow pen' }),
      context,
    )

    expect(runs[0]).toEqual({ species: 'cow', farm: 'cow pen', area: undefined, targetCount: 6 })
    expect(result).toMatchObject({ ok: true, data: { result: { bred: 1 } } })
  })
})

describe('CollectEggsTool', () => {
  it('translates input and runs the skill through the task launcher', async () => {
    const { launcher } = launching()
    const runs: CollectEggsInput[] = []
    const outcome: SkillResult<CollectEggsOutput> = ok({
      pickedUp: 10,
      stored: 1,
      released: 9,
      penFull: false,
    })
    const skill = {
      name: 'collect_eggs',
      run: (input: CollectEggsInput) => {
        runs.push(input)
        return Promise.resolve(outcome)
      },
    } as unknown as CollectEggsSkill
    const tool = new CollectEggsTool(skill, launcher)

    const result = await tool.execute(
      tool.inputSchema.parse({
        farm: 'coop',
        store_fraction: 0.2,
        release: 'store',
        max_chickens: 12,
      }),
      context,
    )

    expect(runs[0]).toEqual({
      farm: 'coop',
      area: undefined,
      storeFraction: 0.2,
      release: 'store',
      maxChickens: 12,
    })
    expect(result).toMatchObject({
      ok: true,
      data: { result: { pickedUp: 10, stored: 1, released: 9 } },
    })
  })
})

describe('SetEggPolicyTool', () => {
  async function tool() {
    const store = new InMemoryStateStore()
    const policy = new EggPolicy()
    const standing = new StandingInstructions()
    await policy.attach(store)
    await standing.attach(store)
    return { policy, standing, tool: new SetEggPolicyTool(policy, standing) }
  }

  it('saves the policy and mirrors it as a standing instruction the briefing shows', async () => {
    const { policy, standing, tool: t } = await tool()

    const result = t.execute(t.inputSchema.parse({ store_fraction: 0.5, release: 'store' }))

    expect(result).toEqual({ ok: true, data: { storeFraction: 0.5, release: 'store' } })
    expect(policy.get()).toEqual({ storeFraction: 0.5, release: 'store' })
    expect(standing.all().egg_policy).toContain('store')
  })

  it('removes the standing instruction when set back to the default', async () => {
    const { policy, standing, tool: t } = await tool()
    t.execute(t.inputSchema.parse({ store_fraction: 0.5, release: 'store' }))
    expect(standing.all().egg_policy).toBeDefined()

    t.execute(t.inputSchema.parse({ store_fraction: 0.1, release: 'hatch' }))

    expect(policy.get()).toEqual({ storeFraction: 0.1, release: 'hatch' })
    expect(standing.all().egg_policy).toBeUndefined()
  })

  it('fails when no world is active', () => {
    const policy = new EggPolicy()
    const standing = new StandingInstructions()
    const t = new SetEggPolicyTool(policy, standing)

    const result = t.execute(t.inputSchema.parse({ store_fraction: 0.1, release: 'hatch' }))

    expect(result).toMatchObject({ ok: false })
  })
})

describe('PlantTreesTool', () => {
  function stub() {
    const runs: PlantTreesInput[] = []
    const skill = {
      name: 'plant_trees',
      run: (input: PlantTreesInput) => {
        runs.push(input)
        return Promise.resolve(ok({ mode: 'plant', planted: 3 }))
      },
    } as unknown as PlantTreesSkill
    return { runs, skill }
  }

  it('translates a rectangle request and runs the skill through the task launcher', async () => {
    const { launcher } = launching()
    const { runs, skill } = stub()
    const tool = new PlantTreesTool(skill, launcher)
    const area = { from: { x: 0, y: 64, z: 0 }, to: { x: 9, y: 64, z: 9 } }

    const result = await tool.execute(
      tool.inputSchema.parse({ species: 'oak', count: 3, area, label: 'oak wood', big: false }),
      context,
    )

    expect(runs[0]).toEqual({
      species: 'oak',
      count: 3,
      farm: undefined,
      area,
      around: undefined,
      spacing: undefined,
      big: false,
      preview: false,
      label: 'oak wood',
      group: undefined,
    })
    expect(result).toMatchObject({ ok: true, data: { result: { planted: 3 } } })
  })

  it('translates a ring around a house, and a refill of a grove', async () => {
    const { launcher } = launching()
    const { runs, skill } = stub()
    const tool = new PlantTreesTool(skill, launcher)

    await tool.execute(
      tool.inputSchema.parse({
        species: 'birch',
        count: 6,
        around: { from: { x: 1, y: 64, z: 1 }, to: { x: 5, y: 64, z: 5 }, distance: 3 },
        preview: true,
      }),
      context,
    )
    await tool.execute(tool.inputSchema.parse({ farm: 'wood' }), {
      signal: new AbortController().signal,
      ...{},
    })

    expect(runs[0]).toMatchObject({
      species: 'birch',
      around: {
        from: { x: 1, y: 64, z: 1 },
        to: { x: 5, y: 64, z: 5 },
        distance: 3,
        depth: undefined,
      },
      preview: true,
    })
    expect(runs[1]).toMatchObject({ farm: 'wood', count: undefined, species: undefined })
  })

  it('rejects an unknown species and a zero count', () => {
    const { skill } = stub()
    const tool = new PlantTreesTool(skill, launching().launcher)

    expect(tool.inputSchema.safeParse({ species: 'mangrove', count: 1 }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ species: 'oak', count: 0 }).success).toBe(false)
  })
})

describe('CollectSaplingsTool', () => {
  function stub() {
    const runs: CollectSaplingsInput[] = []
    const skill = {
      name: 'collect_saplings',
      run: (input: CollectSaplingsInput) => {
        runs.push(input)
        return Promise.resolve(ok({ saplings: 3, requested: 3, leaves: 50, gained: [] }))
      },
    } as unknown as CollectSaplingsSkill
    return { runs, skill }
  }

  it('translates input and runs the skill through the task launcher', async () => {
    const { launcher, tasks } = launching()
    const { runs, skill } = stub()
    const tool = new CollectSaplingsTool(skill, launcher)

    const result = await tool.execute(
      tool.inputSchema.parse({
        species: 'birch',
        count: 3,
        max_leaves: 90,
        on_inventory_full: 'stop',
      }),
      context,
    )

    expect(runs[0]).toEqual({
      species: 'birch',
      count: 3,
      maxLeaves: 90,
      maxDistance: 32,
      onInventoryFull: 'stop',
    })
    expect(result).toMatchObject({
      ok: true,
      data: { description: 'Collect 3 birch saplings', result: { saplings: 3, leaves: 50 } },
    })
    expect(tasks.latest()?.resume?.tool).toBe('collect_saplings')
  })

  it('names any species plainly, and asks for a count', async () => {
    const { launcher } = launching()
    const { skill } = stub()
    const tool = new CollectSaplingsTool(skill, launcher)

    const result = await tool.execute(tool.inputSchema.parse({ count: 2 }), context)

    expect(result).toMatchObject({ ok: true, data: { description: 'Collect 2 saplings' } })
    expect(tool.inputSchema.safeParse({}).success).toBe(false)
    expect(tool.inputSchema.safeParse({ count: 0 }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ count: 2, species: 'mangrove' }).success).toBe(false)
  })
})

describe('HarvestTreesTool', () => {
  it('translates input and runs the skill through the task launcher', async () => {
    const { launcher } = launching()
    const runs: HarvestTreesInput[] = []
    const skill = {
      name: 'harvest_trees',
      run: (input: HarvestTreesInput) => {
        runs.push(input)
        return Promise.resolve(
          ok({
            trees: 2,
            logs: 9,
            left: 0,
            replanted: 2,
            saplingsMissing: 0,
            scaffoldMissing: 0,
            gained: [],
          }),
        )
      },
    } as unknown as HarvestTreesSkill
    const tool = new HarvestTreesTool(skill, launcher)

    const result = await tool.execute(
      tool.inputSchema.parse({ farm: 'wood', replant: false, max_trees: 2 }),
      context,
    )

    expect(runs[0]).toEqual({
      farm: 'wood',
      area: undefined,
      replant: false,
      maxTrees: 2,
      reachTall: 'pillar',
    })
    expect(result).toMatchObject({ ok: true, data: { result: { trees: 2, logs: 9 } } })
  })

  it('climbs for tall trees unless told to skip them', () => {
    const tool = new HarvestTreesTool({} as unknown as HarvestTreesSkill, launching().launcher)

    expect(tool.inputSchema.parse({ farm: 'wood' }).reach_tall).toBe('pillar')
    expect(tool.inputSchema.parse({ farm: 'wood', reach_tall: 'skip' }).reach_tall).toBe('skip')
    expect(tool.inputSchema.safeParse({ farm: 'wood', reach_tall: 'sometimes' }).success).toBe(
      false,
    )
  })

  it('replants unless told not to', () => {
    const tool = new HarvestTreesTool({} as unknown as HarvestTreesSkill, launching().launcher)

    expect(tool.inputSchema.parse({ farm: 'wood' }).replant).toBe(true)
  })
})

describe('TendFarmTool', () => {
  it('runs the skill for the given farm or group', async () => {
    const { launcher } = launching()
    const runs: { farm: string }[] = []
    const skill = {
      name: 'tend_farm',
      run: (input: { farm: string }) => {
        runs.push(input)
        return Promise.resolve(ok({ components: [] }))
      },
    } as unknown as TendFarmSkill
    const tool = new TendFarmTool(skill, launcher)

    await tool.execute(tool.inputSchema.parse({ farm: 'home' }), context)

    expect(runs[0]).toEqual({ farm: 'home' })
  })
})

describe('InspectFarmTool', () => {
  it('returns the report on success', async () => {
    const skill = {
      run: () => Promise.resolve(ok({ components: [{ id: 'farm-1' }] })),
    } as unknown as InspectFarmSkill
    const tool = new InspectFarmTool(skill)

    const result = await tool.execute(tool.inputSchema.parse({ farm: 'farm-1' }), context)

    expect(result).toMatchObject({ ok: true, data: { components: [{ id: 'farm-1' }] } })
  })

  it('reports a skill failure', async () => {
    const skill = {
      run: () => Promise.resolve(err({ reason: 'unknown_farm', message: 'no such farm' })),
    } as unknown as InspectFarmSkill
    const tool = new InspectFarmTool(skill)

    const result = await tool.execute(tool.inputSchema.parse({ farm: 'nope' }), context)

    expect(result).toEqual({ ok: false, error: 'no such farm' })
  })
})

describe('DiscoverFarmTool', () => {
  it('passes the place, radius, and group through and returns the proposals', async () => {
    const runs: unknown[] = []
    const skill = {
      run: (input: unknown) => {
        runs.push(input)
        return Promise.resolve(ok({ proposals: [{ kind: 'field' }], alreadyRegistered: [] }))
      },
    } as unknown as DiscoverFarmSkill
    const tool = new DiscoverFarmTool(skill)

    const result = await tool.execute(
      tool.inputSchema.parse({ around: { x: 1, y: 64, z: 2 }, radius: 30, group: 'home' }),
      context,
    )

    expect(runs[0]).toEqual({ around: { x: 1, y: 64, z: 2 }, radius: 30, group: 'home' })
    expect(result).toMatchObject({ ok: true, data: { proposals: [{ kind: 'field' }] } })
  })

  it('looks around the bot within 24 blocks by default, and limits the radius', async () => {
    const runs: unknown[] = []
    const skill = {
      run: (input: unknown) => {
        runs.push(input)
        return Promise.resolve(ok({ proposals: [] }))
      },
    } as unknown as DiscoverFarmSkill
    const tool = new DiscoverFarmTool(skill)

    await tool.execute(tool.inputSchema.parse({}), context)

    expect(runs[0]).toEqual({ around: undefined, radius: 24, group: undefined })
    expect(tool.inputSchema.safeParse({ radius: 3 }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ radius: 49 }).success).toBe(false)
  })

  it('reports a failure', async () => {
    const skill = {
      run: () =>
        Promise.resolve(
          err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' }),
        ),
    } as unknown as DiscoverFarmSkill
    const tool = new DiscoverFarmTool(skill)

    const result = await tool.execute(tool.inputSchema.parse({}), context)

    expect(result).toEqual({ ok: false, error: 'Not connected to a Minecraft world.' })
  })
})

describe('RegisterFarmTool', () => {
  it('registers a farm by its two corners', async () => {
    const farms = await registry()
    const tool = new RegisterFarmTool(farms)

    const result = tool.execute(
      tool.inputSchema.parse({
        kind: 'field',
        crop: 'wheat',
        from: { x: 0, y: 64, z: 0 },
        to: { x: 2, y: 66, z: 2 },
        label: 'wheat field',
      }),
    )

    expect(result).toMatchObject({
      ok: true,
      data: { farm: { label: 'wheat field', crop: 'wheat' } },
    })
    expect(farms.all()).toHaveLength(1)
  })

  it('reports a registry failure', async () => {
    const farms = await registry()
    farms.register({
      kind: 'field',
      bounds: { from: { x: 0, y: 64, z: 0 }, to: { x: 0, y: 64, z: 0 } },
      label: 'a',
    })
    const tool = new RegisterFarmTool(farms)

    const result = tool.execute(
      tool.inputSchema.parse({
        kind: 'field',
        from: { x: 0, y: 64, z: 0 },
        to: { x: 1, y: 64, z: 1 },
        label: 'a',
      }),
    )

    expect(result).toMatchObject({ ok: false })
  })
})

describe('ListFarmsTool', () => {
  it('lists what is registered', async () => {
    const farms = await registry()
    farms.register({
      kind: 'field',
      crop: 'wheat',
      bounds: { from: { x: 0, y: 64, z: 0 }, to: { x: 1, y: 64, z: 1 } },
    })
    const tool = new ListFarmsTool(farms)

    const result = tool.execute()

    expect(result).toMatchObject({ ok: true, data: { count: 1 } })
  })

  it('fails when no world is active', () => {
    const farms = new FarmRegistry(new FakeClock(0))
    const tool = new ListFarmsTool(farms)

    const result = tool.execute()

    expect(result).toMatchObject({ ok: false })
  })
})
