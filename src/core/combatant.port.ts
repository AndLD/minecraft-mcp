import type { Result } from './result.js'

export interface GearReport {
  /** The weapon now in hand, when one was found. */
  readonly weapon: string | undefined
  /** Armor pieces put on. */
  readonly armor: readonly string[]
}

/** `target_gone`: it died or left. `still_fighting`: the time slice ended and the fight goes on. */
export type AttackOutcome = 'target_gone' | 'still_fighting'

export interface CombatFailure {
  readonly reason: 'aborted' | 'not_connected'
  readonly message: string
}

/** Melee combat. Shared by the threat reflex and, later, hunting. */
export interface Combatant {
  /** Puts on the best armor and takes the best weapon in hand. */
  equipBestGear(): Promise<GearReport>
  /**
   * Chases and hits the entity, swinging in time with the attack cooldown, for at most `maxMs`.
   * Call again to keep fighting; the caller decides between slices whether to go on.
   */
  attack(
    entityId: number,
    options: { signal: AbortSignal; maxMs: number },
  ): Promise<Result<AttackOutcome, CombatFailure>>
}
