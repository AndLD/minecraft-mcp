import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Digger } from '../../core/digger.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Placer } from '../../core/placer.port.js'
import type { Position } from '../../core/position.types.js'
import type { RailAccess } from '../../core/rail.port.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import type { SkillContext } from '../../core/skill.types.js'
import { sleep } from '../../core/sleep.js'
import { expectedShape } from './rail-orientation.js'
import { isRailName, POWER_TORCH, POWERED_RAIL, RAIL } from './rail-table.js'

/** A wait for the game to settle after placing (a torch's power reaches the rail a tick or two later). */
const SETTLE_MS = 1000
const REACH = 3

export type RailProblemKind = 'missing' | 'wrong_block' | 'wrong_shape' | 'unpowered' | 'unverified'

export interface RailProblem {
  readonly at: Position
  readonly kind: RailProblemKind
  readonly expected: string
  readonly found: string | undefined
}

export interface Verification {
  /** Rails looked at. */
  readonly checked: number
  /** What is still wrong after the repairs. */
  readonly problems: readonly RailProblem[]
  /** Problems that a repair put right. */
  readonly repaired: number
}

export interface RailLine {
  readonly cells: readonly Position[]
  readonly powered: readonly Position[]
  readonly torches: readonly Position[]
}

export interface RailVerifierDeps {
  readonly rails: RailAccess
  readonly blocks: BlockScanner
  readonly navigator: Navigator
  readonly digger: Digger
  readonly placer: Placer
  readonly scheduler: Scheduler
}

const key = (p: Position): string => `${String(p.x)},${String(p.y)},${String(p.z)}`

/**
 * Checks a laid line rail by rail: the right kind of rail is there, it has the shape its neighbours give it, and every
 * powered rail is powered. What is wrong is put right once (a missing rail is placed again, a wrongly bent one is
 * broken and placed again, a torch that is gone is set again), then the line is checked once more and what is still
 * wrong is reported. A rail out of the bot's view is walked up to first.
 */
export class RailVerifier {
  constructor(private readonly deps: RailVerifierDeps) {}

  async verify(line: RailLine, context: SkillContext): Promise<Verification> {
    await sleep(this.deps.scheduler, SETTLE_MS, context.signal)
    const first = await this.check(line, context)
    if (first.length === 0 || context.signal.aborted)
      return { checked: line.cells.length, problems: first, repaired: 0 }

    const fixable = first.filter((problem) => problem.kind !== 'unverified')
    const cancelled = (): boolean => context.signal.aborted
    for (const problem of fixable) {
      if (cancelled()) break
      await this.repair(problem, line, context)
    }
    if (fixable.length > 0) await sleep(this.deps.scheduler, SETTLE_MS, context.signal)
    const second = await this.check(line, context)
    return {
      checked: line.cells.length,
      problems: second,
      repaired: Math.max(0, fixable.length - second.filter((p) => p.kind !== 'unverified').length),
    }
  }

  private async check(line: RailLine, context: SkillContext): Promise<RailProblem[]> {
    const powered = new Set(line.powered.map(key))
    const problems: RailProblem[] = []
    for (const [index, cell] of line.cells.entries()) {
      if (context.signal.aborted) break
      const expected = powered.has(key(cell)) ? POWERED_RAIL : RAIL
      let state = this.deps.rails.stateAt(cell)
      if (state === undefined && this.deps.blocks.blockAt(cell) === undefined) {
        await this.deps.navigator.goToPosition(cell, REACH * 2, { signal: context.signal })
        state = this.deps.rails.stateAt(cell)
      }
      if (state === undefined) {
        const found = this.deps.blocks.blockAt(cell)
        problems.push({
          at: cell,
          kind: found === undefined ? 'unverified' : 'missing',
          expected,
          found,
        })
        continue
      }
      if (state.name !== expected) {
        problems.push({ at: cell, kind: 'wrong_block', expected, found: state.name })
        continue
      }
      const shape = expectedShape(line.cells, index)
      if (shape !== undefined && state.shape !== undefined && state.shape !== shape) {
        problems.push({ at: cell, kind: 'wrong_shape', expected: shape, found: state.shape })
        continue
      }
      if (expected === POWERED_RAIL && state.powered === false)
        problems.push({ at: cell, kind: 'unpowered', expected: 'powered', found: 'unpowered' })
    }
    return problems
  }

  private async repair(problem: RailProblem, line: RailLine, context: SkillContext): Promise<void> {
    const { deps } = this
    await deps.navigator.goToPosition(problem.at, REACH, { signal: context.signal })
    if (problem.kind === 'unpowered') {
      const torch = line.torches.find(
        (spot) =>
          Math.abs(spot.x - problem.at.x) + Math.abs(spot.z - problem.at.z) <= 1 &&
          spot.y === problem.at.y,
      )
      const there = torch === undefined ? undefined : deps.blocks.blockAt(torch)
      if (torch !== undefined && there !== POWER_TORCH && there !== 'redstone_wall_torch')
        await deps.placer.placeAt(POWER_TORCH, torch)
      return
    }
    const name = deps.blocks.blockAt(problem.at)
    if (name !== undefined && isRailName(name)) await deps.digger.dig(problem.at, context.signal)
    const rail =
      problem.kind === 'wrong_shape' ? this.railNameAt(problem.at, line) : problem.expected
    await deps.placer.placeAt(rail, problem.at)
  }

  private railNameAt(at: Position, line: RailLine): string {
    return line.powered.some((cell) => key(cell) === key(at)) ? POWERED_RAIL : RAIL
  }
}
