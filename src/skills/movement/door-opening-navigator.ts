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
import type { IronDoorHandler } from './iron-door-handler.js'

const cellKey = (position: Position): string =>
  `${String(Math.floor(position.x))},${String(Math.floor(position.y))},${String(Math.floor(position.z))}`

const SEARCH_RADIUS = 16
/** Right-clicks before giving up on one door. */
const MAX_TRIES_PER_DOOR = 2
/** Doors tried in one trip before giving up (a genuinely unreachable target should not loop forever). */
const MAX_DOORS_PER_TRIP = 3
/** How close the bot walks back to a door it could not close from where it ended. */
const CLOSE_WITHIN = 2
/** Closing is never cancelled by a stop or a reflex: a door left open is worse than a click after the stop. */
const NEVER_ABORTED = new AbortController().signal
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
  /** How to handle a closed iron door in the way. Undefined always reports it as `needs_switch`, untried. */
  readonly ironDoors?: IronDoorHandler
}

/**
 * Wraps a `Navigator`: when a trip is unreachable or stuck, looks for a closed door, gate, or trapdoor near the
 * bot, opens it, and tries again — up to a few doors, so a genuinely blocked trip still ends the same way it
 * would have. An iron one is handed to `ironDoors` (the switch policy decides whether to try pressing a nearby
 * button or lever, ask the player, or refuse). Once a trip succeeds, every wooden door it opened is closed
 * again and every lever it pressed is restored, unless `closeDoors` is false. That happens on every way a trip can
 * end (arrived, failed, cancelled, thrown), and one it could not close (the bot ended too far from it) is
 * remembered and closed at the start of the next trip, or by `closeLeftovers` at the end of a task. A door found
 * open is left alone: a player may hold one open on purpose (a pen's gate is checked by `PenGateGuard` instead).
 */
export class DoorOpeningNavigator implements Navigator {
  /** Doors this navigator opened and could not close again yet, by cell. */
  private readonly leftOpen = new Map<string, Position>()

  constructor(private readonly deps: DoorOpeningNavigatorDeps) {}

  /** Positions of doors opened by the bot that are still standing open (could not be closed yet). */
  leftovers(): readonly Position[] {
    return [...this.leftOpen.values()]
  }

  /**
   * Closes every door the bot opened and could not close before, walking back to it when it is out of reach. Returns
   * the ones that are still open.
   */
  async closeLeftovers(signal: AbortSignal): Promise<readonly Position[]> {
    await this.closeBehind([...this.leftOpen.values()], signal)
    return this.leftovers()
  }

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
    // Following never opens a door itself (see docs/features/world/opening-ordinary-doors.md); it only sees to
    // doors an earlier trip could not close, before it walks off.
    return this.closeLeftovers(options.signal).then(() =>
      this.deps.inner.follow(player, distance, options),
    )
  }

  private async withDoors<T>(
    attempt: () => Promise<Result<T, NavigationFailure>>,
    options: NavigationOptions,
  ): Promise<Result<T, NavigationFailure>> {
    const opened: Position[] = []
    const leversToRestore: Position[] = []
    try {
      if (options.closeDoors !== false && this.leftOpen.size > 0)
        await this.closeLeftovers(options.signal)
      return await this.attemptWithDoors(attempt, options, opened, leversToRestore)
    } finally {
      // On every way out: arrived, failed, cancelled, or thrown.
      if (options.closeDoors !== false) {
        await this.closeBehind(opened, options.signal)
        await this.restoreLevers(leversToRestore)
      }
    }
  }

  private async attemptWithDoors<T>(
    attempt: () => Promise<Result<T, NavigationFailure>>,
    options: NavigationOptions,
    opened: Position[],
    leversToRestore: Position[],
  ): Promise<Result<T, NavigationFailure>> {
    const tried = new Set<string>()
    let result = await attempt()
    while (!result.ok && RETRYABLE.has(result.error.reason) && tried.size < MAX_DOORS_PER_TRIP) {
      if (options.signal.aborted) break
      const found = this.nearestClosedDoor(tried)
      if (found === undefined) break
      tried.add(cellKey(found.position))
      if (found.kind === 'iron') {
        if (this.deps.ironDoors === undefined) {
          result = err({
            reason: 'needs_switch',
            message: `An iron ${found.name} at ${where(found.position)} blocks the way; it needs a switch to open.`,
          })
          break
        }
        const handled = await this.deps.ironDoors.open(found.position, found.name, options.signal)
        if (!handled.ok) {
          result = err(handled.error)
          break
        }
        if (handled.value.leverToRestore !== undefined) leversToRestore.push(handled.value.leverToRestore)
        result = await attempt()
        continue
      }
      const didOpen = await this.toggleWithApproach(found.position, true, options.signal)
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

  /**
   * Clicks the door until it reads the wanted state; when that does not work from where the bot stands (a trip that
   * ended at the far side of a pen will not reach its gate), walks up to it and tries again. A cancelled trip does not
   * walk: it clicks from where it is, and never gives up on a click because of the cancel.
   */
  private async toggleWithApproach(
    position: Position,
    wantOpen: boolean,
    signal: AbortSignal,
  ): Promise<boolean> {
    const clickSignal = wantOpen ? signal : NEVER_ABORTED
    if (await this.tryToggle(position, clickSignal, wantOpen)) return true
    if (signal.aborted) return false
    const walked = await this.deps.inner.goToPosition(position, CLOSE_WITHIN, { signal })
    return walked.ok && (await this.tryToggle(position, clickSignal, wantOpen))
  }

  /**
   * Closes each door: from where the bot stands, else (unless the trip was cancelled, when the bot must stay put) after
   * walking back to it. A door that stays open is remembered for `closeLeftovers`.
   */
  private async closeBehind(doors: readonly Position[], signal: AbortSignal): Promise<void> {
    for (const position of doors) {
      const state = this.deps.doors.stateAt(position)
      if (state === undefined || !state.open) {
        this.leftOpen.delete(cellKey(position))
        continue
      }
      const closed = await this.toggleWithApproach(position, false, signal)
      if (closed) this.leftOpen.delete(cellKey(position))
      else {
        this.leftOpen.set(cellKey(position), position)
        this.deps.logger.warn(`Could not close the ${state.name} behind the bot.`, { position })
      }
    }
  }

  private async restoreLevers(levers: readonly Position[]): Promise<void> {
    if (levers.length === 0 || this.deps.ironDoors === undefined) return
    for (const position of levers) {
      await this.deps.ironDoors.restoreLever(position, NEVER_ABORTED)
    }
  }
}
