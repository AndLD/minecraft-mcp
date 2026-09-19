import type { AnimalInfo, AnimalScanner } from '../../core/animal-scanner.port.js'
import type { Clock } from '../../core/clock.port.js'
import type { Combatant } from '../../core/combatant.port.js'
import type { DropCollector } from '../gathering/drop-collector.js'

/** One fight slice; between slices the abort signal and the time cap are checked. */
const SLICE_MS = 1_000
/** Animals wander and run; after this long chasing one, give up on it. */
export const MAX_CHASE_MS = 20_000

export type KillOutcome = 'killed' | 'lost' | 'gave_up' | 'aborted' | 'not_connected'

export interface AnimalKillerDeps {
  readonly combatant: Combatant
  readonly animals: AnimalScanner
  readonly drops: DropCollector
  readonly clock: Clock
}

/** Chases and kills one animal, then picks up what it dropped. Shared by hunting and `attack_entity`. */
export class AnimalKiller {
  constructor(private readonly deps: AnimalKillerDeps) {}

  async kill(animal: AnimalInfo, signal: AbortSignal): Promise<KillOutcome> {
    const { combatant, animals, drops, clock } = this.deps
    const startedAt = clock.now()
    while (clock.now() - startedAt < MAX_CHASE_MS) {
      const round = await combatant.attack(animal.id, { signal, maxMs: SLICE_MS })
      if (!round.ok) return round.error.reason === 'aborted' ? 'aborted' : 'not_connected'
      if (round.value === 'still_fighting') continue

      // The target is gone: it died (it lingers a moment) or it ran out of view.
      const last = animals.find(animal.id)
      if (last?.dead !== true) return 'lost'
      await drops.collectNear(last.position, signal)
      return 'killed'
    }
    return 'gave_up'
  }
}
