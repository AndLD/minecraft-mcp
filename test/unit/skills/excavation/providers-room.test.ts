import { describe, expect, it } from '@jest/globals'
import type { Position } from '../../../../src/core/position.types.js'
import type { WorkPlan, WorkStep } from '../../../../src/skills/construction/work-plan.types.js'
import { RoomProvider } from '../../../../src/skills/excavation/providers/room.js'

const at = (x: number, y: number, z: number): Position => ({ x, y, z })
type Break = Extract<WorkStep, { kind: 'break' }>
type Light = Extract<WorkStep, { kind: 'light' }>
type Place = Extract<WorkStep, { kind: 'place' }>
const breaks = (plan: WorkPlan): Break[] => plan.steps.filter((s): s is Break => s.kind === 'break')
const lights = (plan: WorkPlan): Light[] => plan.steps.filter((s): s is Light => s.kind === 'light')
const places = (plan: WorkPlan): Place[] => plan.steps.filter((s): s is Place => s.kind === 'place')
const asPlan = (result: WorkPlan | { error: string }): WorkPlan => {
  if ('error' in result) throw new Error(result.error)
  return result
}
const key = (p: Position): string => `${String(p.x)},${String(p.y)},${String(p.z)}`
const context = (origin: Position, minY = -64) => ({ origin, minY })

describe('RoomProvider', () => {
  const room = new RoomProvider()
  const ORIGIN = at(20, 64, 10)
  const plan = (params: object, origin = ORIGIN) =>
    asPlan(room.generate(room.params.parse({ direction: 'south', ...params }), context(origin)))

  it('digs a 1-wide, 2-high entrance centred on the room, then the full room behind it', () => {
    const p = plan({ width: 3, length: 3, height: 3 })

    // Entrance: a single column (a = 1, the centre of width 3) at the wall face (z = 10), 2 cells high.
    const entranceCells = breaks(p).filter((s) => s.at.z === 10)
    expect(entranceCells.map((s) => s.at)).toEqual(
      expect.arrayContaining([at(20, 64, 10), at(20, 65, 10)]),
    )
    expect(entranceCells).toHaveLength(2)
    expect(breaks(p)).toHaveLength(2 + 3 * 3 * 3) // 2 entrance cells + the 3x3x3 room
    // The room starts right behind the entrance (z = 11..13), full width (x = 19..21) and height (y = 64..66).
    const roomKeys = new Set(breaks(p).map((s) => key(s.at)))
    for (let x = 19; x <= 21; x += 1)
      for (let y = 64; y <= 66; y += 1)
        for (let z = 11; z <= 13; z += 1) expect(roomKeys.has(key(at(x, y, z)))).toBe(true)
    expect(p.name).toBe('room 3x3x3')
    expect(p.hazards).toBe('end_branch')
    expect(p.cavityCheck).toBe(true)
    expect(p.veins).toEqual({ maxSize: 64 })
  })

  it('every cell needs the one before it: nothing is dug from a distance', () => {
    const p = plan({ width: 3, length: 2, height: 2 })

    const byKey = new Map(breaks(p).map((s) => [key(s.at), s]))
    let roots = 0
    for (const step of breaks(p)) {
      if (step.needs === undefined) {
        roots += 1
        continue
      }
      // The cell it needs is itself part of the plan (so nothing is dug through unbroken rock).
      expect(byKey.has(key(step.needs))).toBe(true)
    }
    expect(roots).toBe(1) // exactly one true root: the block the player looked at
  })

  it('the probe list leaves out the direction the bot came from (outside the wall)', () => {
    const p = plan({ width: 2, length: 2, height: 2, direction: 'south' })

    for (const step of breaks(p)) expect(step.probe).not.toContainEqual(at(0, 0, -1))
  })

  it.each([
    // Facing south (the dig direction), right is -x (HEADINGS.south.right), so "left" is +x.
    ['left', at(21, 64, 10)],
    ['right', at(19, 64, 10)],
  ] as const)('entrance_at %s puts the entrance against that edge of the front row', (side, cell) => {
    const p = plan({ width: 3, length: 2, entrance_at: side })

    const entranceFloor = breaks(p).find((s) => s.at.y === 64 && s.at.z === 10)
    expect(entranceFloor?.at).toEqual(cell)
  })

  it.each([1, 2, 3])('entrance_width %s digs that many columns and places that many doors', (width) => {
    const p = plan({ width: 4, length: 2, entrance_width: width, door: 'oak_door' })

    const entranceFloor = breaks(p).filter((s) => s.at.y === 64 && s.at.z === 10)
    expect(entranceFloor).toHaveLength(width)
    expect(places(p)).toHaveLength(width)
    for (const door of places(p)) {
      expect(door.block).toBe('oak_door')
      expect(door.optional).toBe(true)
      expect(door.at.z).toBe(10) // the outermost row: right at the wall face
      expect(door.at.y).toBe(64)
    }
  })

  it('entrance: none skips the entrance corridor; the room starts at the wall face', () => {
    const p = plan({ width: 2, length: 2, height: 2, entrance: 'none' })

    expect(breaks(p)).toHaveLength(2 * 2 * 2) // only the room, nothing dug in front of it
    expect(breaks(p).some((s) => s.at.z === 10)).toBe(true) // the room's own front row is at the wall face
  })

  it('entrance: player digs no entrance cells, but the room still needs them to be open', () => {
    const p = plan({ width: 2, length: 2, height: 2, entrance: 'player' })

    // Nothing at z = 10 (the entrance) is a break step...
    expect(breaks(p).some((s) => s.at.z === 10)).toBe(false)
    // ...but the room's own front row needs a z = 10 cell to be open first.
    const needsEntrance = breaks(p).filter((s) => s.at.z === 11 && s.needs?.z === 10)
    expect(needsEntrance.length).toBeGreaterThan(0)
  })

  it('needsConfirmation asks only when entrance is "player"', () => {
    const dig = room.params.parse({ direction: 'south', width: 2, length: 2, entrance: 'dig' })
    const none = room.params.parse({ direction: 'south', width: 2, length: 2, entrance: 'none' })
    const player = room.params.parse({ direction: 'south', width: 2, length: 2, entrance: 'player' })

    expect(room.needsConfirmation(dig)).toBeUndefined()
    expect(room.needsConfirmation(none)).toBeUndefined()
    expect(room.needsConfirmation(player)).toMatchObject({ options: ['done'] })
  })

  it('torches go along the side walls on the floor, not the middle', () => {
    const p = plan({ width: 3, length: 6, height: 2, torch_spacing: 3 })

    for (const light of lights(p)) {
      expect([19, 21]).toContain(light.at.x) // the two side walls (x = 20 is the middle, never lit)
      expect(light.at.y).toBe(64) // the floor
      expect(light.required).toBe(true)
    }
    // Two side walls, torches at the start of the room and again after 3 (length 6): 2 x 2 = 4.
    expect(lights(p)).toHaveLength(4)
  })

  it('torch_spacing 0 means no torches at all', () => {
    const p = plan({ width: 3, length: 3, torch_spacing: 0 })

    expect(lights(p)).toHaveLength(0)
  })

  it('door: true uses a plain oak_door', () => {
    const p = plan({ width: 2, length: 2, door: true })

    expect(places(p)).toHaveLength(1)
    expect(places(p)[0]?.block).toBe('oak_door')
  })

  it('warns when the door leaves a gap above it', () => {
    const withGap = plan({ width: 2, length: 2, entrance_height: 3, door: 'oak_door' })
    const flush = plan({ width: 2, length: 2, entrance_height: 2, door: 'oak_door' })

    expect(withGap.warnings).toEqual([expect.stringContaining('gap above')])
    expect(flush.warnings ?? []).toEqual([])
  })

  it('refuses entrance_width wider than the room, and entrance_height taller than the room', () => {
    expect(() => room.params.parse({ direction: 'south', width: 2, length: 2, entrance_width: 3 })).toThrow()
    expect(() =>
      room.params.parse({ direction: 'south', width: 2, length: 2, height: 2, entrance_height: 3 }),
    ).toThrow()
  })

  it('fails cleanly with no resolved direction, instead of digging blind', () => {
    const parsed = room.params.parse({ width: 2, length: 2 })
    const result = room.generate(parsed, context(ORIGIN))

    expect(result).toEqual({ error: expect.stringContaining('direction') as unknown as string })
  })

  it('defaultOrigin falls back to the bot\'s own feet (never actually used: the tool always resolves one)', () => {
    expect(room.defaultOrigin(at(1.5, 64.9, 2.1))).toEqual(at(1, 64, 2))
  })
})
