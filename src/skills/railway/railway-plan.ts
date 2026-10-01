import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Position } from '../../core/position.types.js'
import { isOpenAir, isReplaceable } from '../construction/block-match.js'
import type { WorkPlan, WorkStep } from '../construction/work-plan.types.js'
import { isNaturalTerrain } from '../site-leveling/natural-terrain.js'
import { assignPower, type Variant } from './rail-layout.js'
import { headingOf, OPPOSITE, STEP, type Heading } from './rail-orientation.js'
import type { RailRoute } from './rail-route-planner.js'
import { POWER_TORCH, POWERED_RAIL, RAIL } from './rail-table.js'
import { isPassThrough } from './terrain.js'

const LINE = 'line'
/** A torch on a tunnel wall every this many rails. */
const LIGHT_EVERY = 6
const DOWN: Position = { x: 0, y: -1, z: 0 }

export interface RailwayOptions {
  readonly variant: Variant
  readonly spacing: number
  /** The block laid under a rail where the ground is missing, and behind the first rail. */
  readonly supportBlock: string
}

export interface RailwayBuild {
  readonly plan: WorkPlan
  /** Rail cells that are powered rails, and where each one's torch stands. */
  readonly powered: readonly Position[]
  readonly torches: readonly Position[]
  /** Where a buffer block behind the first rail makes a cart resting on it start by itself; undefined when the way behind is solid already. */
  readonly buffer: Position | undefined
  /** Things worth telling the player about the layout. */
  readonly notes: readonly string[]
}

interface TorchSpot {
  readonly cell: Position
  /** A support block to lay under the torch first. */
  readonly deck: Position | undefined
  /** A cell to dig out for it first (a niche in a tunnel wall). */
  readonly dig: Position | undefined
}

const key = (position: Position): string =>
  `${String(position.x)},${String(position.y)},${String(position.z)}`

type Kind = 'free' | 'cut' | 'other'

/** What a block in a cell means for laying something there: open, clearable natural material, or anything else. */
function kindOf(name: string | undefined): Kind {
  if (name === undefined) return 'other'
  if (isOpenAir(name) || isReplaceable(name)) return name === 'water' ? 'other' : 'free'
  if (isNaturalTerrain(name) || isPassThrough(name)) return 'cut'
  return 'other'
}

/**
 * Turns a route into the steps that lay it: cut what is in the way (each cut waits for the rail before it, so nothing
 * is dug from a distance), lay a support block where the ground is missing, set the rail, and set a redstone torch
 * beside each powered rail. Rails go in as `rail` or `powered_rail`; the game bends them into curves and slopes as
 * neighbours arrive, and `rail-orientation.ts` says what they should come to.
 */
export function buildRailwayPlan(
  route: RailRoute,
  blocks: BlockScanner,
  options: RailwayOptions,
): RailwayBuild {
  const { cells } = route
  const power = assignPower(cells, options.variant, options.spacing)
  const onRoute = new Set(cells.map(key))
  const notes: string[] = []
  const steps: WorkStep[] = []
  const powered = new Set(power.powered)
  const torchSpots = new Map<number, TorchSpot>()

  const torchIndices = [...power.torches].sort((a, b) => a - b)
  const torchIndexSet = new Set(torchIndices)
  /** The powered rails that share this rail's power: the unbroken run around it. */
  const runFrom = (index: number): number[] => {
    const run: number[] = []
    for (let i = index; powered.has(i) && (i === index || !torchIndexSet.has(i)); i += 1)
      run.push(i)
    return run
  }
  torchIndices.forEach((index) => {
    const cell = cells[index]
    if (cell === undefined) return
    const run = runFrom(index)
    // One torch feeds a whole run, so any rail of it close to the first will do.
    for (const at of run.slice(0, 6)) {
      const spot = torchSpotFor(cells, at, blocks, onRoute, options.supportBlock)
      if (spot === undefined) continue
      torchSpots.set(at, spot)
      if (spot.deck !== undefined)
        steps.push({ kind: 'place', at: spot.deck, block: options.supportBlock, branch: LINE })
      return
    }
    // No torch could go anywhere near: the rails it would have fed are laid as plain rails.
    for (const at of run) powered.delete(at)
    notes.push(
      `No room for a torch beside the rail at ${key(cell)}: ${
        run.length === 1
          ? 'a plain rail is used there'
          : `${String(run.length)} plain rails are used there`
      } instead (a powered rail with no power would brake the cart).`,
    )
  })

  cells.forEach((cell, index) => {
    const previous = cells[index - 1]
    const rail = { x: cell.x, y: cell.y, z: cell.z }
    const head = { x: cell.x, y: cell.y + 1, z: cell.z }
    for (const at of [rail, head]) {
      if (kindOf(blocks.blockAt(at)) === 'cut')
        steps.push({
          kind: 'break',
          at,
          branch: LINE,
          ...(previous === undefined ? {} : { needs: previous }),
        })
    }
    const support = { x: cell.x, y: cell.y - 1, z: cell.z }
    const under = blocks.blockAt(support)
    if (under !== undefined && (isOpenAir(under) || isReplaceable(under) || isPassThrough(under)))
      steps.push({ kind: 'place', at: support, block: options.supportBlock, branch: LINE })
    steps.push({
      kind: 'place',
      at: rail,
      block: powered.has(index) ? POWERED_RAIL : RAIL,
      against: DOWN,
      passable: true,
      clearedFirst: true,
      branch: LINE,
    })
    const torch = torchSpots.get(index)
    if (torch !== undefined) {
      if (torch.dig !== undefined)
        steps.push({ kind: 'break', at: torch.dig, branch: LINE, needs: rail })
      steps.push({
        kind: 'place',
        at: torch.cell,
        block: POWER_TORCH,
        against: DOWN,
        passable: true,
        clearedFirst: true,
        branch: LINE,
      })
    }
    if ((route.cover[index] ?? 0) > 0 && index % LIGHT_EVERY === 0)
      steps.push({ kind: 'light', at: head, minLight: 8, spacing: LIGHT_EVERY, branch: LINE })
  })

  const buffer = bufferBehind(cells, blocks)
  if (buffer !== undefined)
    steps.unshift({ kind: 'place', at: buffer, block: options.supportBlock, branch: LINE })

  const label = `railway ${String(cells.length)} rails (${options.variant}, ${route.layout})`
  return {
    // The bot works along the line, in its tunnel or cut, not from beside it: climbing out of a trench to stand
    // outside the plan's volume is what stalled a first tunnel build.
    plan: { name: label, steps, standing: 'inside', hazards: 'end_branch', warnings: notes },
    powered: [...powered].flatMap((i) => {
      const cell = cells[i]
      return cell === undefined ? [] : [cell]
    }),
    torches: [...torchSpots.values()].map((spot) => spot.cell),
    buffer,
    notes,
  }
}

/** The cell behind the first rail, when a block there is still to be placed. */
function bufferBehind(cells: readonly Position[], blocks: BlockScanner): Position | undefined {
  const first = cells[0]
  const second = cells[1]
  if (first === undefined || second === undefined) return undefined
  const heading = headingOf(first, { x: second.x, y: first.y, z: second.z })
  if (heading === undefined) return undefined
  const back = STEP[OPPOSITE[heading]]
  const behind = { x: first.x + back.x, y: first.y, z: first.z + back.z }
  return kindOf(blocks.blockAt(behind)) === 'free' ? behind : undefined
}

/**
 * Where the redstone torch of a powered rail stands: a free cell beside it, level with it, with solid ground under
 * it or, failing that, a support block to put there. A cell that another rail of the line uses is never taken.
 */
function torchSpotFor(
  cells: readonly Position[],
  index: number,
  blocks: BlockScanner,
  onRoute: ReadonlySet<string>,
  supportBlock: string,
): TorchSpot | undefined {
  const cell = cells[index]
  if (cell === undefined) return undefined
  const other = cells[index + 1] ?? cells[index - 1]
  if (other === undefined) return undefined
  const along = headingOf(cell, { x: other.x, y: cell.y, z: other.z })
  const sideways: Heading[] =
    along === 'east' || along === 'west' ? ['north', 'south'] : ['east', 'west']
  const candidates = sideways.map((heading) => {
    const step = STEP[heading]
    const beside = { x: cell.x + step.x, y: cell.y, z: cell.z + step.z }
    const below = { x: beside.x, y: beside.y - 1, z: beside.z }
    const underName = blocks.blockAt(below)
    const beforeName = blocks.blockAt(beside)
    return {
      beside,
      below,
      free: kindOf(beforeName) === 'free' && !onRoute.has(key(beside)),
      niche: kindOf(beforeName) === 'cut' && !onRoute.has(key(beside)),
      solidBelow:
        underName !== undefined &&
        !isOpenAir(underName) &&
        !isReplaceable(underName) &&
        !isPassThrough(underName),
      canDeck: underName !== undefined && !onRoute.has(key(below)),
    }
  })
  const solid = candidates.find((c) => c.free && c.solidBelow)
  if (solid !== undefined) return { cell: solid.beside, deck: undefined, dig: undefined }
  const niche = candidates.find((c) => c.niche && c.solidBelow)
  if (niche !== undefined) return { cell: niche.beside, deck: undefined, dig: niche.beside }
  const bridged = candidates.find((c) => c.free && c.canDeck)
  if (bridged !== undefined && supportBlock !== '')
    return { cell: bridged.beside, deck: bridged.below, dig: undefined }
  return undefined
}
