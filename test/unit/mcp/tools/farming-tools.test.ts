import { describe, expect, it } from '@jest/globals'
import { err, ok } from '../../../../src/core/result.js'
import type { SkillResult } from '../../../../src/core/skill.types.js'
import { TaskLauncher } from '../../../../src/mcp/task-launcher.js'
import {
  BuildFarmTool,
  HarvestCropsTool,
  InspectFarmTool,
  ListFarmsTool,
  PlantCropsTool,
  RegisterFarmTool,
  TendFarmTool,
} from '../../../../src/mcp/tools/farming-tools.js'
import type { BuildFarmInput, BuildFarmOutput, BuildFarmSkill } from '../../../../src/skills/farming/build-farm-skill.js'
import type {
  HarvestCropsInput,
  HarvestCropsOutput,
  HarvestCropsSkill,
} from '../../../../src/skills/farming/harvest-crops-skill.js'
import type { InspectFarmSkill } from '../../../../src/skills/farming/inspect-farm-skill.js'
import type { PlantCropsInput, PlantCropsOutput, PlantCropsSkill } from '../../../../src/skills/farming/plant-crops-skill.js'
import type { TendFarmSkill } from '../../../../src/skills/farming/tend-farm-skill.js'
import { FarmRegistry } from '../../../../src/state/farm-registry.js'
import { TaskManager } from '../../../../src/tasks/task-manager.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeLogger } from '../../../fakes/fake-logger.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

const context = { signal: new AbortController().signal }

function launching() {
  const clock = new FakeClock(Date.UTC(2026, 8, 19, 12, 0, 0))
  const tasks = new TaskManager({ clock, scheduler: new FakeScheduler(clock), logger: new FakeLogger() })
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
    const outcome: SkillResult<PlantCropsOutput> = ok({ planted: 2, tilled: 1, skipped: 0 })
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

    expect(result).toMatchObject({ ok: true, data: { farm: { label: 'wheat field', crop: 'wheat' } } })
    expect(farms.all()).toHaveLength(1)
  })

  it('reports a registry failure', async () => {
    const farms = await registry()
    farms.register({ kind: 'field', bounds: { from: { x: 0, y: 64, z: 0 }, to: { x: 0, y: 64, z: 0 } }, label: 'a' })
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
    farms.register({ kind: 'field', crop: 'wheat', bounds: { from: { x: 0, y: 64, z: 0 }, to: { x: 1, y: 64, z: 1 } } })
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
