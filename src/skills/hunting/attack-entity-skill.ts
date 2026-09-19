import type { AnimalScanner } from '../../core/animal-scanner.port.js'
import type { Clock } from '../../core/clock.port.js'
import type { Combatant } from '../../core/combatant.port.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { DropCollector } from '../gathering/drop-collector.js'
import { AnimalKiller } from './animal-killer.js'
import { PROTECTION_TEXT, individualProtection } from './animal-catalog.js'

export interface AttackInput {
  readonly target:
    | { readonly kind: 'id'; readonly id: number }
    | { readonly kind: 'nearest'; readonly species: string }
  /** Attack even a pet, a named animal, a baby, or a species that is not livestock. */
  readonly force: boolean
  readonly radius: number
}

export interface AttackOutput {
  readonly species: string
  readonly killed: boolean
}

export interface AttackEntityDeps {
  readonly animals: AnimalScanner
  readonly combatant: Combatant
  readonly drops: DropCollector
  readonly clock: Clock
}

/** Kills one explicit animal ("kill that cow"). Refuses protected animals unless forced. */
export class AttackEntitySkill implements Skill<AttackInput, AttackOutput> {
  readonly name = 'attack_entity'
  private readonly killer: AnimalKiller

  constructor(private readonly deps: AttackEntityDeps) {
    this.killer = new AnimalKiller(deps)
  }

  async run(input: AttackInput, context: SkillContext): Promise<SkillResult<AttackOutput>> {
    const { animals } = this.deps
    const wanted = input.target
    const target =
      wanted.kind === 'id'
        ? animals.find(wanted.id)
        : animals.nearby(input.radius).find((animal) => animal.species === wanted.species)
    if (target === undefined || target.dead)
      return err({
        reason: 'target_not_found',
        message:
          wanted.kind === 'id'
            ? `There is no animal with id ${String(wanted.id)} in view.`
            : `No ${wanted.species} within ${String(input.radius)} blocks.`,
      })

    // Babies are only protected by default; a direct order for "that cow" counts as allowing them.
    const protection = individualProtection(target, true)
    if (protection !== undefined && !input.force)
      return err({
        reason: 'protected',
        message: `That ${target.species} ${PROTECTION_TEXT[protection]}, so it was not attacked. Set force to attack it anyway.`,
      })

    await this.deps.combatant.equipBestGear()
    context.progress(`Attacking a ${target.species}`)
    const outcome = await this.killer.kill(target, context.signal)
    switch (outcome) {
      case 'killed':
        return ok({ species: target.species, killed: true })
      case 'aborted':
        return err({ reason: 'aborted', message: 'Cancelled.' })
      case 'not_connected':
        return err({ reason: 'not_connected', message: 'Lost the connection.' })
      case 'lost':
      case 'gave_up':
        return err({
          reason: 'target_lost',
          message: `The ${target.species} got away.`,
        })
    }
  }
}
