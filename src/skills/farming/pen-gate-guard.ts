import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { DoorAccess } from '../../core/door.port.js'
import type { Logger } from '../../core/logger.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Position } from '../../core/position.types.js'
import { ok } from '../../core/result.js'
import type { SkillResult } from '../../core/skill.types.js'
import type { Bounds } from './farm-area.types.js'

const CLOSE_WITHIN = 2
/** A close is never cancelled by a stop: an open gate lets the herd out. */
const NEVER_ABORTED = new AbortController().signal

export interface PenGateGuardDeps {
  readonly blocks: BlockScanner
  readonly doors: DoorAccess
  readonly navigator: Navigator
  readonly logger: Logger
}

/**
 * Makes sure a pen's gate is shut when a task in it ends, however it ended. The navigator closes the doors it opens
 * itself; this covers a gate that was already open when the bot arrived (left open by a player, or by an earlier run)
 * and one the navigator could not close. Looks for fence gates in and around the bounds, closes each open one (walking
 * to it when the bot ended out of reach, unless the task was stopped, when the bot stays where it is), and returns a
 * sentence about the gates still open, or undefined when they are all shut.
 */
export class PenGateGuard {
  constructor(private readonly deps: PenGateGuardDeps) {}

  async ensureShut(bounds: Bounds, signal: AbortSignal): Promise<string | undefined> {
    const stillOpen: Position[] = []
    for (const gate of this.openGates(bounds)) {
      if (await this.close(gate, signal)) continue
      stillOpen.push(gate)
      this.deps.logger.warn('A pen gate could not be closed.', { position: gate })
    }
    if (stillOpen.length === 0) return undefined
    const where = stillOpen.map((p) => `${String(p.x)}, ${String(p.y)}, ${String(p.z)}`).join('; ')
    return `The pen's gate at ${where} is still open: the animals can walk out. Close it by hand or call the task again.`
  }

  /**
   * Checks the gate after a task and puts a note on a successful result when one stayed open. Runs whether or not the
   * task succeeded; a failed result comes back as it was.
   */
  async finish<T extends { readonly gateLeftOpen?: string }>(
    bounds: Bounds | undefined,
    result: SkillResult<T>,
    signal: AbortSignal,
  ): Promise<SkillResult<T>> {
    if (bounds === undefined) return result
    const problem = await this.ensureShut(bounds, signal)
    if (!result.ok || problem === undefined) return result
    return ok({ ...result.value, gateLeftOpen: problem })
  }

  private openGates(bounds: Bounds): Position[] {
    const gates: Position[] = []
    for (let x = bounds.from.x - 1; x <= bounds.to.x + 1; x += 1)
      for (let z = bounds.from.z - 1; z <= bounds.to.z + 1; z += 1)
        for (let y = bounds.from.y - 1; y <= bounds.to.y + 1; y += 1) {
          const position = { x, y, z }
          const name = this.deps.blocks.blockAt(position)
          if (name === undefined || !name.endsWith('_fence_gate')) continue
          if (this.deps.doors.stateAt(position)?.open === true) gates.push(position)
        }
    return gates
  }

  private async close(gate: Position, signal: AbortSignal): Promise<boolean> {
    if (await this.toggleShut(gate)) return true
    if (signal.aborted) return false
    const walked = await this.deps.navigator.goToPosition(gate, CLOSE_WITHIN, { signal })
    return walked.ok && (await this.toggleShut(gate))
  }

  private async toggleShut(gate: Position): Promise<boolean> {
    await this.deps.doors.toggle(gate, NEVER_ABORTED)
    return this.deps.doors.stateAt(gate)?.open !== true
  }
}
