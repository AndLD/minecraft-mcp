import { z } from 'zod'
import type { Position } from '../../../core/position.types.js'
import type { DecisionPrompt } from '../../../core/skill.types.js'
import type { WorkPlan, WorkStep } from '../../construction/work-plan.types.js'
import type { ExcavationContext, ExcavationProvider } from '../excavation.types.js'
import {
  add,
  directionParam,
  feetCell,
  HEADINGS,
  negate,
  probeAllBut,
  type Direction,
} from './geometry.js'

const MAX_SIDE = 24
const UP: Position = { x: 0, y: 1, z: 0 }
const DEFAULT_DOOR = 'oak_door'

const lightParams = {
  torch_spacing: z
    .number()
    .int()
    .min(0)
    .max(16)
    .default(6)
    .describe(
      'A torch about every this many blocks along the side walls (default 6; 0 means no torches). The dig stops ' +
        'with no_torches when they run out.',
    ),
  min_light: z
    .number()
    .int()
    .min(1)
    .max(15)
    .default(7)
    .describe('Torches go where the light is below this (default 7); an already-lit room gets none.'),
}

const sealParams = {
  seal_caves: z
    .boolean()
    .default(true)
    .describe(
      'Seal a cave the dig meets with a placed block instead of leaving it open (default true), so the room stays ' +
        'fully enclosed. Set to false to break into a found cave on purpose and leave it open.',
    ),
  seal_block: z
    .string()
    .default('cobblestone')
    .describe(
      'The block placed to close a cave, falling back to dirt when none of it is carried. Only used when seal_caves is true.',
    ),
}

const sealFor = (p: {
  readonly seal_caves: boolean
  readonly seal_block: string
}): { readonly block: string; readonly fallback: string } | undefined =>
  p.seal_caves ? { block: p.seal_block, fallback: 'dirt' } : undefined

const roomParams = z
  .object({
    width: z
      .number()
      .int()
      .min(2)
      .max(MAX_SIDE)
      .describe('Across the room, as seen entering it (2 to 24).'),
    length: z.number().int().min(2).max(MAX_SIDE).describe('Deep into the wall (2 to 24).'),
    height: z
      .number()
      .int()
      .min(2)
      .max(8)
      .default(4)
      .describe('Room height in blocks (2 to 8, default 4). Example: "5x5x4" is width 5, length 5, height 4.'),
    entrance: z
      .enum(['dig', 'player', 'none'])
      .default('dig')
      .describe(
        '"dig" (default): the bot cuts the entrance itself. "player": the bot digs only the room, and first asks ' +
          'and waits for the entrance to be opened by hand. "none": no entrance is dug; the room starts at the ' +
          'first open cell (a hole already there).',
      ),
    entrance_length: z
      .number()
      .int()
      .min(1)
      .max(8)
      .default(1)
      .describe('How many blocks of wall the entrance goes through before the room begins (default 1).'),
    entrance_height: z
      .number()
      .int()
      .min(2)
      .max(8)
      .default(2)
      .describe('Entrance height in blocks (default 2, matching a door).'),
    entrance_width: z
      .number()
      .int()
      .min(1)
      .max(3)
      .default(1)
      .describe('Entrance width in blocks (1 to 3, default 1). One door is placed per cell of width.'),
    entrance_at: z
      .enum(['center', 'left', 'right'])
      .default('center')
      .describe(
        'Where the entrance sits along the room\'s front wall, as seen entering: "center" (default), or against ' +
          'the "left" or "right" edge (its outer cell becomes the first or last cell of the front row).',
      ),
    door: z
      .union([z.string().min(1), z.literal(true)])
      .optional()
      .describe(
        'An item name (for example oak_door) placed in each entrance cell once everything else is done, or true ' +
          `for a plain ${DEFAULT_DOOR}. Omit for no door. Fetched from the inventory or storage, or crafted from ` +
          'planks; a door that cannot be had is reported, and the room is still finished.',
      ),
    at: z
      .object({ x: z.number().int(), y: z.number().int(), z: z.number().int() })
      .optional()
      .describe(
        'The wall block to dig into, instead of the block the player is looking at. Give this and direction ' +
          'together, or neither.',
      ),
    direction: directionParam
      .optional()
      .describe('The way to dig into the wall, instead of reading it from the face looked at.'),
    for_player: z
      .string()
      .min(1)
      .optional()
      .describe('Whose look (and standing level) to use for "this wall". Defaults to the configured owner.'),
    ...lightParams,
    ...sealParams,
  })
  .refine((p) => p.entrance_width <= p.width, {
    message: 'entrance_width cannot be wider than width.',
    path: ['entrance_width'],
  })
  .refine((p) => p.entrance_height <= p.height, {
    message: 'entrance_height cannot be taller than height.',
    path: ['entrance_height'],
  })

type RoomParams = z.output<typeof roomParams>

/**
 * The room's own coordinate frame: `i` runs from the wall face into the rock (the dig direction), `a` runs across
 * the width (0 = left, as seen entering), `b` is height above the floor. The entrance is `entrance_width` cells
 * wide, placed within the room's width by `entrance_at`; the room itself is the full width, starting right after
 * the entrance (or at i = 0 when there is none to dig).
 */
function roomSteps(p: RoomParams, origin: Position, direction: Direction): WorkStep[] {
  const { forward, right } = HEADINGS[direction]
  const centerIndex = Math.floor((p.width - 1) / 2)
  const aStart =
    p.entrance_at === 'left'
      ? 0
      : p.entrance_at === 'right'
        ? p.width - p.entrance_width
        : Math.floor((p.width - p.entrance_width) / 2)
  const aEnd = aStart + p.entrance_width - 1
  // The dig root: the looked-at column (the room's centre) when it falls within the entrance band, otherwise the
  // nearest edge of the band, so every cell can still trace a chain back to a cell that is actually part of it.
  const rootA = Math.min(Math.max(centerIndex, aStart), aEnd)
  const hasEntrance = p.entrance !== 'none'
  const entranceLength = hasEntrance ? p.entrance_length : 0
  const roomStart = entranceLength
  const roomEnd = roomStart + p.length - 1

  const cellAt = (i: number, a: number, b: number): Position =>
    add(add(add(origin, forward, i), right, a - centerIndex), UP, b)
  const inEntrance = (i: number, a: number, b: number): boolean =>
    hasEntrance && i >= 0 && i < entranceLength && a >= aStart && a <= aEnd && b >= 0 && b < p.entrance_height
  const inRoom = (i: number, a: number, b: number): boolean =>
    i >= roomStart && i <= roomEnd && a >= 0 && a < p.width && b >= 0 && b < p.height
  const inFootprint = (i: number, a: number, b: number): boolean =>
    inEntrance(i, a, b) || inRoom(i, a, b)
  const before = (i: number, a: number, b: number): Position | undefined => {
    if (inFootprint(i - 1, a, b)) return cellAt(i - 1, a, b)
    if (b > 0 && inFootprint(i, a, b - 1)) return cellAt(i, a, b - 1)
    if (a < rootA && inFootprint(i, a + 1, b)) return cellAt(i, a + 1, b)
    if (a > rootA && inFootprint(i, a - 1, b)) return cellAt(i, a - 1, b)
    return undefined
  }
  const branchOf = (a: number, b: number): string => `col-${String(a)}-${String(b)}`
  const probe = probeAllBut(negate(forward))

  const steps: WorkStep[] = []
  if (p.entrance === 'dig')
    for (let i = 0; i < entranceLength; i += 1)
      for (let b = 0; b < p.entrance_height; b += 1)
        for (let a = aStart; a <= aEnd; a += 1) {
          const needs = before(i, a, b)
          steps.push({
            kind: 'break',
            at: cellAt(i, a, b),
            branch: branchOf(a, b),
            probe,
            ...(needs === undefined ? {} : { needs }),
          })
        }
  for (let i = roomStart; i <= roomEnd; i += 1)
    for (let b = 0; b < p.height; b += 1)
      for (let a = 0; a < p.width; a += 1) {
        const needs = before(i, a, b)
        steps.push({
          kind: 'break',
          at: cellAt(i, a, b),
          branch: branchOf(a, b),
          probe,
          ...(needs === undefined ? {} : { needs }),
        })
      }

  if (p.torch_spacing > 0)
    for (const a of new Set([0, p.width - 1]))
      for (let k = 0; k < p.length; k += p.torch_spacing)
        steps.push({
          kind: 'light',
          at: cellAt(roomStart + k, a, 0),
          minLight: p.min_light,
          // How close an existing torch must be to skip this one: capped at the distance between the two side
          // walls, so a narrow room's opposite wall never suppresses its own torch just because torch_spacing
          // (the along-the-wall cadence) is wider than the room.
          spacing: Math.min(p.torch_spacing, p.width - 1),
          required: true,
          branch: branchOf(a, 0),
        })

  if (p.door !== undefined) {
    const block = p.door === true ? DEFAULT_DOOR : p.door
    const alignAxis: 'x' | 'z' = forward.x !== 0 ? 'x' : 'z'
    for (let a = aStart; a <= aEnd; a += 1)
      steps.push({
        kind: 'place',
        at: cellAt(0, a, 0),
        block,
        alignAxis,
        optional: true,
        branch: branchOf(a, 0),
      })
  }
  return steps
}

export class RoomProvider implements ExcavationProvider<RoomParams> {
  readonly name = 'room'
  readonly description =
    'A room dug into the wall the player is looking at (or an explicit at + direction): `width` (across) by ' +
    '`length` (deep) by `height`, "5x5x4" meaning width 5, length 5, height 4. By default a 1 wide, 2 high entrance ' +
    '(entrance_width/entrance_height) is cut entrance_length blocks through the wall first, centred on the room\'s ' +
    'front (entrance_at: left/right to move it to an edge); entrance: "player" waits for the player to cut it by ' +
    'hand instead, and entrance: "none" starts the room at the first already-open cell. A door item (or true for ' +
    'a plain oak_door) is placed in the entrance last, one per cell of its width. Lit along the side walls like a ' +
    'mine; the whole excavation safety set applies (lava and caves end a column early and are sealed, protected ' +
    'areas are refused, ore veins touching it are mined).'
  readonly params = roomParams

  defaultOrigin(feet: Position): Position {
    return feetCell(feet)
  }

  needsConfirmation(p: RoomParams): DecisionPrompt | undefined {
    if (p.entrance !== 'player') return undefined
    return {
      message:
        `Digging the room needs a ${String(p.entrance_width)} wide, ${String(p.entrance_height)} high entrance ` +
        `cut into the wall by hand first (${String(p.entrance_length)} block(s) deep). Say when it is open, or ` +
        'cancel_task to call it off.',
      options: ['done'],
    }
  }

  generate(p: RoomParams, context: ExcavationContext): WorkPlan | { error: string } {
    const direction = p.direction
    if (direction === undefined)
      return { error: 'No direction to dig: look at a wall, or give direction explicitly.' }
    const warnings: string[] = []
    if (p.door !== undefined && p.entrance_height > 2)
      warnings.push(
        `The entrance is ${String(p.entrance_height)} cells tall; the door only fills the bottom 2, leaving a gap above.`,
      )
    return {
      name: `room ${String(p.width)}x${String(p.length)}x${String(p.height)}`,
      steps: roomSteps(p, context.origin, direction),
      standing: 'inside',
      hazards: 'end_branch',
      cavityCheck: true,
      ownVolume: true,
      veins: { maxSize: 64 },
      seal: sealFor(p),
      warnings,
    }
  }
}
