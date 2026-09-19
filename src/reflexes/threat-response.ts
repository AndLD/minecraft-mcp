import type { Combatant } from '../core/combatant.port.js'
import type { EntityScanner } from '../core/entity-scanner.port.js'
import type { Navigator } from '../core/navigator.port.js'
import { rankFleeDestinations } from './flee-planner.js'
import type { Reflex, ReflexContext, ReflexOutcome, ReflexState } from './reflex.types.js'
import { assess, type Assessment } from './threat-policy.js'

export interface ThreatResponseOptions {
  readonly combatant: Combatant
  readonly navigator: Navigator
  readonly entities: EntityScanner
  readonly lowHealthThreshold: number
  /** The player to run towards when fleeing (help is there). */
  readonly owner: string | undefined
}

const FIGHT_SLICE_MS = 1_000
const FLEE_STEP_MS = 4_000
const FLEE_ARRIVAL_RANGE = 4
const PAUSE_BETWEEN_STEPS_MS = 100

/** Flees from skeletons, creepers, and (at low health) everything; fights other hostile mobs; ignores endermen. */
export class ThreatResponse implements Reflex {
  readonly name = 'threat_response'
  readonly priority = 80
  readonly preemptsTask = true
  private fleeing = false

  constructor(private readonly options: ThreatResponseOptions) {}

  wants(state: ReflexState): boolean {
    return this.assessNow(state).kind !== 'none'
  }

  async run(context: ReflexContext, initial: ReflexState): Promise<ReflexOutcome> {
    let resumeTask = true
    let geared = false
    let announced: string | undefined
    let fleeAttempt = 0
    let state: ReflexState | undefined = initial

    try {
      while (state !== undefined && !context.signal.aborted) {
        const assessment = this.assessNow(state)
        if (assessment.kind === 'none') break

        if (assessment.kind === 'flee') {
          resumeTask = false // running back towards the danger would be a bad idea
          this.fleeing = true
          const key = `flee:${assessment.reason}`
          if (announced !== key) {
            announced = key
            context.emit(describeFlee(assessment, state))
          }
          await this.fleeStep(context, state, assessment, fleeAttempt)
          fleeAttempt += 1
          await context.sleep(PAUSE_BETWEEN_STEPS_MS) // never spin if a step ends at once
        } else {
          this.fleeing = false
          if (!geared) {
            geared = true
            const gear = await this.options.combatant.equipBestGear()
            if (gear.armor.length > 0) context.emit(`Put on ${gear.armor.join(', ')}.`)
          }
          const key = `fight:${String(assessment.target.id)}`
          if (announced !== key) {
            announced = key
            context.emit(
              `Fighting a ${assessment.target.name} (health ${String(Math.round(state.vitals.health))}/20).`,
            )
          }
          const result = await this.options.combatant.attack(assessment.target.id, {
            signal: context.signal,
            maxMs: FIGHT_SLICE_MS,
          })
          if (result.ok && result.value === 'target_gone')
            context.emit(`The ${assessment.target.name} is gone.`)
          await context.sleep(PAUSE_BETWEEN_STEPS_MS)
        }
        state = context.state()
      }
    } finally {
      this.fleeing = false
      // Say so when the danger is over, whether the reflex finished or the engine ended it because the threat left.
      const latest = context.state()
      if (
        announced?.startsWith('flee') === true &&
        latest !== undefined &&
        this.assessNow(latest).kind !== 'flee'
      ) {
        context.emit('Safe again: no threat nearby.')
      }
    }
    return { resumeTask }
  }

  private assessNow(state: ReflexState): Assessment {
    return assess(state, {
      lowHealthThreshold: this.options.lowHealthThreshold,
      fleeing: this.fleeing,
    })
  }

  private async fleeStep(
    context: ReflexContext,
    state: ReflexState,
    assessment: Extract<Assessment, { kind: 'flee' }>,
    attempt: number,
  ): Promise<void> {
    const owner =
      this.options.owner === undefined
        ? undefined
        : this.options.entities.player(this.options.owner)?.position
    const destinations = rankFleeDestinations(
      state.vitals.position,
      assessment.threats.map((threat) => threat.position),
      owner,
    )
    const destination = destinations[attempt % destinations.length]
    if (destination === undefined) return
    const step = context.withTimeout(FLEE_STEP_MS)
    try {
      await this.options.navigator.goToPosition(destination, FLEE_ARRIVAL_RANGE, {
        signal: step.signal,
      })
    } finally {
      step.dispose()
    }
  }
}

function describeFlee(
  assessment: Extract<Assessment, { kind: 'flee' }>,
  state: ReflexState,
): string {
  const names = [...new Set(assessment.threats.map((threat) => threat.name))].join(', ')
  return assessment.reason === 'low_health'
    ? `Low health (${String(Math.round(state.vitals.health))}/20): running away from ${names}.`
    : `Running away from ${names}.`
}
