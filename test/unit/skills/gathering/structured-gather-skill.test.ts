import { describe, expect, it } from '@jest/globals'
import { err, ok } from '../../../../src/core/result.js'
import type { SkillContext, SkillResult } from '../../../../src/core/skill.types.js'
import type {
  ExcavateInput,
  ExcavateOutput,
} from '../../../../src/skills/excavation/excavate-skill.js'
import {
  isSiteUnsuitable,
  StructuredGatherSkill,
} from '../../../../src/skills/gathering/structured-gather-skill.js'
import {
  FakeBlockScanner,
  FakeInventory,
  FakeVitals,
  buildVitals,
} from '../../../fakes/fake-ports.js'

const context: SkillContext = { signal: new AbortController().signal, progress: () => undefined }

function excavateOutput(overrides: Partial<ExcavateOutput> = {}): ExcavateOutput {
  return {
    steps: 0,
    placed: 0,
    broken: 40,
    lights: 0,
    alreadyDone: 0,
    used: [],
    ended: [],
    shape: 'quarry 4x4 to y=61',
    origin: { x: 12, y: 63, z: 5 },
    bounds: { from: { x: 12, y: 61, z: 5 }, to: { x: 15, y: 63, z: 8 } },
    fetched: [],
    ...overrides,
  }
}

function setup() {
  const blocks = new FakeBlockScanner()
  const vitals = new FakeVitals()
  vitals.vitals = buildVitals({ position: { x: 10, y: 63, z: 5 } })
  const inventory = new FakeInventory()
  inventory.value = { stacks: [], emptySlots: 30, heldItem: undefined }
  const calls: { input: ExcavateInput }[] = []
  let result: SkillResult<ExcavateOutput> = ok(excavateOutput())
  const excavate = {
    run: (input: ExcavateInput) => {
      calls.push({ input })
      return Promise.resolve(result)
    },
  }
  const skill = new StructuredGatherSkill({ blocks, vitals, inventory, excavate })
  return { blocks, vitals, inventory, calls, skill, setResult: (r: typeof result) => (result = r) }
}

describe('StructuredGatherSkill', () => {
  it('digs a quarry sized to the count, with a stair exit and no material fetching', async () => {
    const s = setup()

    const result = await s.skill.run({ block: 'dirt', count: 32 }, context)

    expect(result.ok).toBe(true)
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]?.input).toMatchObject({
      shape: 'quarry',
      fetchFromStorage: false,
      params: { exit: 'stairs', water_landing: false },
    })
    const params = s.calls[0]?.input.params as { width: number; length: number; to_y: number }
    expect(params.width * params.length).toBeGreaterThan(0)
  })

  it('reports what the inventory gained, not just what was targeted', async () => {
    const blocks = new FakeBlockScanner()
    const vitals = new FakeVitals()
    vitals.vitals = buildVitals({ position: { x: 10, y: 63, z: 5 } })
    const inventory = new FakeInventory()
    inventory.value = { stacks: [{ name: 'dirt', count: 5 }], emptySlots: 30, heldItem: undefined }
    const excavate = {
      run: () => {
        // The dig itself is what changes the inventory; the skill reads it again once this resolves.
        inventory.value = {
          stacks: [{ name: 'dirt', count: 45 }],
          emptySlots: 28,
          heldItem: undefined,
        }
        return Promise.resolve(
          ok(
            excavateOutput({
              broken: 40,
              shape: 'quarry 4x4 to y=61',
              origin: { x: 12, y: 63, z: 5 },
            }),
          ),
        )
      },
    }
    const skill = new StructuredGatherSkill({ blocks, vitals, inventory, excavate })

    const result = await skill.run({ block: 'dirt', count: 32 }, context)

    expect(result).toMatchObject({
      ok: true,
      value: {
        mined: 40,
        requested: 32,
        gained: [{ name: 'dirt', count: 40 }],
        shape: 'quarry 4x4 to y=61',
        origin: { x: 12, y: 63, z: 5 },
      },
    })
  })

  it('reports not_connected without excavating when the bot has no position', async () => {
    const s = setup()
    s.vitals.vitals = undefined

    const result = await s.skill.run({ block: 'dirt', count: 32 }, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'not_connected' } })
    expect(s.calls).toHaveLength(0)
  })

  it('passes an excavate failure straight through', async () => {
    const s = setup()
    s.setResult(err({ reason: 'protected_area', message: 'The plan reaches into "base".' }))

    const result = await s.skill.run({ block: 'dirt', count: 32 }, context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'protected_area' } })
  })
})

describe('isSiteUnsuitable', () => {
  it('is true for anything except not_connected and aborted', () => {
    expect(isSiteUnsuitable({ reason: 'protected_area', message: '' })).toBe(true)
    expect(isSiteUnsuitable({ reason: 'unsafe_site', message: '' })).toBe(true)
    expect(isSiteUnsuitable({ reason: 'blocked_cells', message: '' })).toBe(true)
    expect(isSiteUnsuitable({ reason: 'not_connected', message: '' })).toBe(false)
    expect(isSiteUnsuitable({ reason: 'aborted', message: '' })).toBe(false)
  })
})
