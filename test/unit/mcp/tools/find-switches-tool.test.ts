import { describe, expect, it } from '@jest/globals'
import type { LookTarget } from '../../../../src/core/container.port.js'
import { FindSwitchesTool } from '../../../../src/mcp/tools/find-switches-tool.js'
import { SWITCH_SEARCH_RADIUS, SwitchFinder } from '../../../../src/skills/movement/switch-finder.js'
import { FakeBlockScanner } from '../../../fakes/fake-ports.js'

function setup() {
  const blocks = new FakeBlockScanner()
  blocks.names = ['lever', 'stone_button']
  const finder = new SwitchFinder(blocks)
  const look: { hit: { name: string; position: { x: number; y: number; z: number } } | undefined } = {
    hit: undefined,
  }
  const lookTarget: LookTarget = {
    blockLookedAt: () => (look.hit === undefined ? undefined : { ...look.hit, face: 'north' }),
  }
  return { blocks, finder, look, lookTarget }
}

describe('FindSwitchesTool', () => {
  it('lists switches around a given position, nearest first', () => {
    const s = setup()
    s.blocks.blocks = [
      { name: 'lever', position: { x: 1, y: 64, z: 0 }, distance: 1 },
      { name: 'stone_button', position: { x: 2, y: 64, z: 0 }, distance: 2 },
    ]
    const tool = new FindSwitchesTool(s.finder, s.lookTarget, 'Andrey_Knight')

    const result = tool.execute(tool.inputSchema.parse({ at: { x: 0, y: 64, z: 0 } }))

    expect(result).toMatchObject({
      ok: true,
      data: { switches: [{ kind: 'lever' }, { kind: 'button' }] },
    })
  })

  it("resolves the position from the player's look when at is omitted", () => {
    const s = setup()
    s.look.hit = { name: 'oak_door', position: { x: 5, y: 64, z: 5 } }
    s.blocks.blocks = [{ name: 'lever', position: { x: 5, y: 64, z: 6 }, distance: 1 }]
    const tool = new FindSwitchesTool(s.finder, s.lookTarget, 'Andrey_Knight')

    const result = tool.execute(tool.inputSchema.parse({}))

    expect(result).toMatchObject({ ok: true, data: { switches: [{ kind: 'lever' }] } })
  })

  it('defaults the radius and accepts an override', () => {
    const s = setup()
    const tool = new FindSwitchesTool(s.finder, s.lookTarget, 'Andrey_Knight')

    expect(tool.inputSchema.parse({ at: { x: 0, y: 0, z: 0 } }).radius).toBe(SWITCH_SEARCH_RADIUS)
    expect(tool.inputSchema.safeParse({ at: { x: 0, y: 0, z: 0 }, radius: 0 }).success).toBe(false)
  })

  it('fails when no player is configured and no position is given', () => {
    const s = setup()
    const tool = new FindSwitchesTool(s.finder, s.lookTarget, undefined)

    const result = tool.execute(tool.inputSchema.parse({}))

    expect(result).toEqual({
      ok: false,
      error: 'Say which player: no owner is configured, and none was given as for_player.',
    })
  })

  it('never presses anything: it only reads', () => {
    const s = setup()
    s.blocks.blocks = [{ name: 'lever', position: { x: 1, y: 64, z: 0 }, distance: 1 }]
    const tool = new FindSwitchesTool(s.finder, s.lookTarget, 'Andrey_Knight')

    tool.execute(tool.inputSchema.parse({ at: { x: 0, y: 64, z: 0 } }))

    expect(s.blocks.queries).toHaveLength(1) // one findBlocks read, nothing else
  })
})
