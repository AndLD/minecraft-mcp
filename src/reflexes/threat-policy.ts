import type { EntityInfo } from '../core/entity-scanner.port.js'
import type { ReflexState } from './reflex.types.js'

export type MobAction = 'flee' | 'fight' | 'ignore'

export interface MobRule {
  readonly action: MobAction
  /** How close (in blocks) the mob must be before the rule applies. */
  readonly radius: number
}

/**
 * The threat policy as data (see docs/features/survival/threat-policy.md): change behavior by editing this table, not the reflex.
 * Hostile mobs that are not listed use `DEFAULT_HOSTILE_RULE`.
 */
export const MOB_RULES: Readonly<Record<string, MobRule>> = {
  // Shooters and exploders: always run.
  skeleton: { action: 'flee', radius: 16 },
  stray: { action: 'flee', radius: 16 },
  bogged: { action: 'flee', radius: 16 },
  creeper: { action: 'flee', radius: 10 },
  // Bosses and extreme threats: run (safety default).
  warden: { action: 'flee', radius: 24 },
  wither: { action: 'flee', radius: 24 },
  ender_dragon: { action: 'flee', radius: 40 },
  elder_guardian: { action: 'flee', radius: 16 },
  // Never provoke.
  enderman: { action: 'ignore', radius: 0 },
}

/** Every other hostile mob (zombie, spider, husk, drowned, witch, ...) is fought. */
export const DEFAULT_HOSTILE_RULE: MobRule = { action: 'fight', radius: 8 }

/** At or below the low-health threshold, every nearby hostile mob is fled from. */
export const LOW_HEALTH_FLEE_RADIUS = 16

/** Once fleeing, keep going until the threat is this much farther than its rule radius. */
export const FLEE_HYSTERESIS = 8

export type Assessment =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'flee'
      readonly reason: 'low_health' | 'dangerous_mob'
      readonly threats: readonly EntityInfo[]
    }
  | { readonly kind: 'fight'; readonly target: EntityInfo }

export interface AssessOptions {
  readonly lowHealthThreshold: number
  /** Already running away: use larger radii so it does not stop at the edge of the danger zone. */
  readonly fleeing?: boolean
}

/** A bee only stings when it is angry: then it is fought like other hostile mobs; a calm one is left alone. */
const ANGRY_BEE_RULE: MobRule = { action: 'fight', radius: 6 }

function ruleFor(entity: EntityInfo): MobRule | undefined {
  if (entity.name === 'bee') return entity.angry === true ? ANGRY_BEE_RULE : undefined
  const listed = MOB_RULES[entity.name]
  if (listed !== undefined) return listed
  return entity.category === 'hostile' ? DEFAULT_HOSTILE_RULE : undefined
}

/** Decides between fleeing, fighting, and doing nothing. Pure: same state, same answer. */
export function assess(state: ReflexState, options: AssessOptions): Assessment {
  const extra = options.fleeing === true ? FLEE_HYSTERESIS : 0
  const candidates = state.entities.filter((entity) => {
    const rule = ruleFor(entity)
    return rule !== undefined && rule.action !== 'ignore'
  })

  if (state.vitals.health <= options.lowHealthThreshold) {
    const threats = candidates.filter((entity) => entity.distance <= LOW_HEALTH_FLEE_RADIUS + extra)
    if (threats.length > 0) return { kind: 'flee', reason: 'low_health', threats }
  }

  const dangerous = candidates.filter((entity) => {
    const rule = ruleFor(entity)
    return rule?.action === 'flee' && entity.distance <= rule.radius + extra
  })
  if (dangerous.length > 0) return { kind: 'flee', reason: 'dangerous_mob', threats: dangerous }

  const target = candidates.find((entity) => {
    const rule = ruleFor(entity)
    return rule?.action === 'fight' && entity.distance <= rule.radius
  })
  return target === undefined ? { kind: 'none' } : { kind: 'fight', target }
}
