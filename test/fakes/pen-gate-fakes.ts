import type { DoorAccess, DoorState } from '../../src/core/door.port.js'
import type { NavigationFailure, Navigator } from '../../src/core/navigator.port.js'
import type { Position } from '../../src/core/position.types.js'
import { ok, type Result } from '../../src/core/result.js'
import { PenGateGuard } from '../../src/skills/farming/pen-gate-guard.js'
import { FakeLogger } from './fake-logger.js'
import { FakeBlockScanner } from './fake-ports.js'

const key = (p: Position): string => `${String(p.x)},${String(p.y)},${String(p.z)}`

/** Gates that flip when clicked; one can be made to refuse to close (out of reach) until the bot walks up to it. */
export class FakeGates implements DoorAccess {
  readonly states = new Map<string, DoorState>()
  readonly toggled: Position[] = []
  /** Cells whose gate does not close from where the bot stands. */
  farFrom = new Set<string>()
  /** Cells whose gate never closes, however close the bot is. */
  readonly stuck = new Set<string>()

  add(position: Position, open: boolean, blocks: FakeBlockScanner): void {
    this.states.set(key(position), { name: 'oak_fence_gate', open })
    blocks.blockNames.set(key(position), 'oak_fence_gate')
  }

  stateAt(position: Position): DoorState | undefined {
    return this.states.get(key(position))
  }

  toggle(position: Position): Promise<Result<void, never>> {
    this.toggled.push(position)
    const state = this.states.get(key(position))
    if (
      state !== undefined &&
      !(state.open && (this.farFrom.has(key(position)) || this.stuck.has(key(position))))
    )
      this.states.set(key(position), { ...state, open: !state.open })
    return Promise.resolve(ok(undefined))
  }
}

class WalkingNavigator implements Navigator {
  readonly walked: Position[] = []
  constructor(private readonly gates: FakeGates) {}
  goToPosition(target: Position): Promise<Result<Position, NavigationFailure>> {
    this.walked.push(target)
    this.gates.farFrom.delete(key(target))
    return Promise.resolve(ok(target))
  }
  goToPlayer(): Promise<Result<Position, NavigationFailure>> {
    return Promise.resolve(ok({ x: 0, y: 0, z: 0 }))
  }
  follow(): Promise<Result<void, NavigationFailure>> {
    return Promise.resolve(ok(undefined))
  }
}

/** A real `PenGateGuard` over fake gates, for tests of the skills that use it. */
export function penGateSetup() {
  const blocks = new FakeBlockScanner()
  const doors = new FakeGates()
  const navigator = new WalkingNavigator(doors)
  const logger = new FakeLogger()
  const guard = new PenGateGuard({ blocks, doors, navigator, logger })
  return { blocks, doors, navigator, logger, guard }
}
