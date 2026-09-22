import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { DoorAccess } from '../../core/door.port.js'
import type { Logger } from '../../core/logger.js'
import type {
  NavigationFailure,
  NavigationOptions,
  Navigator,
} from '../../core/navigator.port.js'
import type { Position } from '../../core/position.types.js'
import { err, type Result } from '../../core/result.js'
import { classifyDoor, type DoorKind } from './door-table.js'

const cellKey = (position: Position): string =>
  `${String(Math.floor(position.x))},${String(Math.floor(position.y))},${String(Math.floor(position.z))}`

const SEARCH_RADIUS = 16
/** Right-clicks before giving up on one door. */
const MAX_TRIES_PER_DOOR = 2
/** Doors tried in one trip before giving up (a genuinely unreachable target should not loop forever). */
const MAX_DOORS_PER_TRIP = 3
const RETRYABLE = new Set<NavigationFailure['reason']>(['unreachable', 'stuck'])

const where = (position: Position): string =>
  `${String(position.x)}, ${String(position.y)}, ${String(position.z)}`

interface FoundDoor {
  readonly position: Position
  readonly name: string
  readonly kind: DoorKind
}

export interface DoorOpeningNavigatorDeps {
  readonly inner: Navigator
  readonly blocks: BlockScanner
  readonly doors: DoorAccess
  readonly logger: Logger
}

/**
 * Wraps a `Navigator`: when a trip is unreachable or stuck, looks for a closed door, gate, or trapdoor near the
 * bot, opens it, and tries again — up to a few doors, so a genuinely blocked trip still ends the same way it
 * would have. An iron one is reported as `needs_switch` instead of tried (a later phase presses buttons and
 * levers). Once a trip succeeds, every door it opened is closed again, unless `closeDoors` is false.
 */
export class DoorOpeningNavigator implements Navigator {
  constructor(private readonly deps: DoorOpeningNavigatorDeps) {}

  goToPosition(
    target: Position,
    within: number,
    options: NavigationOptions,
  ): ReturnType<Navigator['goToPosition']> {
    return this.withDoors(() => this.deps.inner.goToPosition(target, within, options), options)
  }

  goToPlayer(
    player: string,
    within: number,
    options: NavigationOptions,
  ): ReturnType<Navigator['goToPlayer']> {
    return this.withDoors(() => this.deps.inner.goToPlayer(player, within, options), options)
  }

  follow(
    player: string,
    distance: number,
    options: NavigationOptions,
  ): ReturnType<Navigator['follow']> {
    // A held-open door would need supervising the whole trip, not a single retry; see AGENTS.md's write-up on
    // this phase's scope. Following passes straight through to the real navigator.
    return this.deps.inner.follow(player, distance, options)
  }

  private async withDoors<T>(
    attempt: () => Promise<Result<T, NavigationFailure>>,
    options: NavigationOptions,
  ): Promise<Result<T, NavigationFailure>> {
    const opened: Position[] = []
    const tried = new Set<string>()
    let result = await attempt()
    while (!result.ok && RETRYABLE.has(result.error.reason) && tried.size < MAX_DOORS_PER_TRIP) {
      if (options.signal.aborted) break
      const found = this.nearestClosedDoor(tried)
      if (found === undefined) break
      tried.add(cellKey(found.position))
      if (found.kind === 'iron') {
        result = err({
          reason: 'needs_switch',
          message: `An iron ${found.name} at ${where(found.position)} blocks the way; it needs a switch to open (not handled yet).`,
        })
        break
      }
      const didOpen = await this.tryToggle(found.position, options.signal, true)
      if (!didOpen) {
        result = err({
          reason: 'door_stuck',
          message: `The ${found.name} at ${where(found.position)} would not open.`,
        })
        break
      }
      opened.push(found.position)
      result = await attempt()
    }
    if (result.ok && options.closeDoors !== false) await this.closeBehind(opened, options.signal)
    return result
  }

  /** The nearest closed door-like block within reach, skipping positions already tried this trip. */
  private nearestClosedDoor(tried: ReadonlySet<string>): FoundDoor | undefined {
    const names = this.deps.blocks.knownBlockNames().filter((name) => classifyDoor(name) !== undefined)
    if (names.length === 0) return undefined
    const candidates = this.deps.blocks.findBlocks({
      names,
      maxDistance: SEARCH_RADIUS,
      count: MAX_DOORS_PER_TRIP + tried.size + 4,
    })
    for (const candidate of candidates) {
      if (tried.has(cellKey(candidate.position))) continue
      const state = this.deps.doors.stateAt(candidate.position)
      if (state === undefined || state.open) continue
      const kind = classifyDoor(state.name)
      if (kind === undefined) continue
      return { position: candidate.position, name: state.name, kind }
    }
    return undefined
  }

  /** Right-clicks a door up to `MAX_TRIES_PER_DOOR` times until it reads the wanted state. */
  private async tryToggle(position: Position, signal: AbortSignal, wantOpen: boolean): Promise<boolean> {
    for (let tries = 0; tries < MAX_TRIES_PER_DOOR; tries += 1) {
      if (signal.aborted) return false
      await this.deps.doors.toggle(position, signal)
      if (this.deps.doors.stateAt(position)?.open === wantOpen) return true
    }
    return false
  }

  private async closeBehind(opened: readonly Position[], signal: AbortSignal): Promise<void> {
    for (const position of opened) {
      if (signal.aborted) return
      const state = this.deps.doors.stateAt(position)
      if (state === undefined || !state.open) continue
      const closed = await this.tryToggle(position, signal, false)
      if (!closed)
        this.deps.logger.warn(`Could not close the ${state.name} behind the bot.`, { position })
    }
  }
}
