import type { AreaGuard } from '../../core/area-guard.port.js'
import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Digger } from '../../core/digger.port.js'
import { countItems, gained } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Position } from '../../core/position.types.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import { isContainerBlock } from '../../state/container-index.js'
import type { HazardRule } from '../construction/hazard-rule.js'
import type { StandingSpotChooser } from '../construction/standing-spot.js'
import { isOpenAir } from '../construction/block-match.js'
import type { DropCollector } from '../gathering/drop-collector.js'

const CLOSE_RANGE = 1.5
const LIQUIDS = new Set(['water', 'lava'])
/** Blocks that hold items besides the ones the bot can open: breaking one drops or loses what is inside. */
const HOLDS_ITEMS = new Set([
  'furnace',
  'blast_furnace',
  'smoker',
  'hopper',
  'dispenser',
  'dropper',
  'brewing_stand',
  'decorated_pot',
  'chiseled_bookshelf',
  'crafter',
  'lectern',
  'jukebox',
])

const holdsItems = (name: string): boolean => isContainerBlock(name) || HOLDS_ITEMS.has(name)

export interface BreakBlockInput {
  /** The one block to break. */
  readonly at: Position
  /** Pick up what drops (default true). */
  readonly collect: boolean
  /** Break a chest, furnace, or the like anyway: what is inside drops or is lost. */
  readonly allowContainers: boolean
  /** Break a block inside a protected area. Only when the player's own words asked for exactly that block. */
  readonly overrideProtection: boolean
}

export interface BreakBlockOutput {
  /** False when the cell was already empty: nothing was done. */
  readonly broken: boolean
  /** What was there (or `air`). */
  readonly block: string
  readonly at: Position
  /** What the inventory gained meanwhile. */
  readonly gained: readonly ItemCount[]
  /** Set when the block lay inside a protected area and the override was used: the area's label. */
  readonly overrodeProtection: string | undefined
  readonly message: string
}

export interface BreakBlockDeps {
  readonly vitals: VitalsReader
  readonly blocks: BlockScanner
  readonly digger: Digger
  readonly navigator: Navigator
  readonly inventory: InventoryReader
  readonly guard: AreaGuard
  readonly hazards: HazardRule
  readonly spots: StandingSpotChooser
  readonly drops: DropCollector
}

const where = (position: Position): string =>
  `${String(position.x)}, ${String(position.y)}, ${String(position.z)}`

/**
 * Breaks exactly one block at the given coordinates. `collect_block` always takes the nearest block of a name, so it
 * cannot remove one particular block; this can, which is what fits the rule of never breaking a player's build:
 * the player points at exactly what may go. Every refusal is a value that says why.
 */
export class BreakBlockSkill implements Skill<BreakBlockInput, BreakBlockOutput> {
  readonly name = 'break_block'

  constructor(private readonly deps: BreakBlockDeps) {}

  async run(input: BreakBlockInput, context: SkillContext): Promise<SkillResult<BreakBlockOutput>> {
    const { deps } = this
    const at = {
      x: Math.floor(input.at.x),
      y: Math.floor(input.at.y),
      z: Math.floor(input.at.z),
    }
    const here = deps.vitals.read()?.position
    if (here === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })

    const refused = this.refusal(at, input)
    if (!refused.ok) return refused
    const { name, protectedBy } = refused.value
    if (isOpenAir(name))
      return ok({
        broken: false,
        block: name,
        at,
        gained: [],
        overrodeProtection: undefined,
        message: `There is nothing to break at ${where(at)}: it is already ${name}.`,
      })

    const before = countItems(deps.inventory.snapshot())
    const ready = await this.approach(at, here, context)
    if (!ready.ok) return ready

    let dug = await deps.digger.dig(at, context.signal)
    if (!dug.ok && dug.error.reason === 'out_of_reach') {
      const closer = await deps.navigator.goToPosition(at, CLOSE_RANGE, { signal: context.signal })
      if (closer.ok) dug = await deps.digger.dig(at, context.signal)
    }
    if (!dug.ok) {
      if (dug.error.reason === 'aborted') return err({ reason: 'aborted', message: 'Cancelled.' })
      return err({
        reason: dug.error.reason === 'not_diggable' ? 'unbreakable' : dug.error.reason,
        message: dug.error.message,
      })
    }
    // Read the cell back: a dig that reported success but left the block standing is not a success.
    const after = deps.blocks.blockAt(at)
    if (after === name)
      return err({
        reason: 'not_broken',
        message: `The ${name} at ${where(at)} is still there after digging.`,
      })

    if (input.collect) await deps.drops.collectNear(at, context.signal)
    const items = gained(before, countItems(deps.inventory.snapshot()))
    const notes = [`Broke the ${name} at ${where(at)}.`]
    if (protectedBy !== undefined)
      notes.push(
        `It was inside the protected area "${protectedBy}" and was broken on the player's direct request; the area is still protected.`,
      )
    return ok({
      broken: true,
      block: name,
      at,
      gained: items,
      overrodeProtection: protectedBy,
      message: notes.join(' '),
    })
  }

  /** Every reason not to break the block, checked before the bot moves. Returns what stands there when it may go. */
  private refusal(
    at: Position,
    input: BreakBlockInput,
  ): SkillResult<{ name: string; protectedBy: string | undefined }> {
    const { deps } = this
    const name = deps.blocks.blockAt(at)
    if (name === undefined)
      return err({ reason: 'not_loaded', message: `The block at ${where(at)} is not loaded.` })

    const area = deps.guard.protectedAt(at)
    if (area !== undefined && !input.overrideProtection)
      return err({
        reason: 'protected_area',
        message: `The ${name} at ${where(at)} is inside the protected area "${area.label}", so it is left alone. If the player asked in their own words for exactly this block to be broken, call break_block again with override_protection true.`,
        detail: { area: area.label },
      })
    // A protected block that is already air is not touched either way; nothing more to check.
    if (isOpenAir(name)) return ok({ name, protectedBy: undefined })

    if (LIQUIDS.has(name))
      return err({
        reason: 'unbreakable',
        message: `The block at ${where(at)} is ${name}: a liquid cannot be broken.`,
      })
    const assessment = deps.digger.assess(at)
    if (assessment === undefined)
      return err({ reason: 'not_loaded', message: `The block at ${where(at)} is not loaded.` })
    if (!assessment.diggable)
      return err({
        reason: 'unbreakable',
        message: `${name} at ${where(at)} cannot be broken (bedrock, a barrier, and the like).`,
      })
    const hazard =
      deps.hazards.fluidNear(at) ??
      deps.hazards.fallingAbove(at) ??
      (name === 'spawner' ? { reason: 'spawner' as const, at } : undefined)
    if (hazard !== undefined)
      return err({
        reason: hazard.reason,
        message: this.hazardMessage(hazard.reason, hazard.at, at),
        detail: { hazardAt: hazard.at },
      })
    if (!assessment.canHarvest)
      return err({
        reason: 'no_suitable_tool',
        message: `${name} only drops its items when broken with ${assessment.requiredTools.join(', ')}. Craft or find one first.`,
        detail: { requiredTools: assessment.requiredTools },
      })
    if (holdsItems(name) && !input.allowContainers)
      return err({
        reason: 'holds_items',
        message: `The ${name} at ${where(at)} holds items: breaking it drops or loses them. If the player asked for this block to go, call break_block again with allow_containers true.`,
      })
    return ok({ name, protectedBy: area?.label })
  }

  private hazardMessage(reason: string, hazardAt: Position, at: Position): string {
    const cell = where(hazardAt)
    switch (reason) {
      case 'hit_lava':
        return `Lava at ${cell} touches the block at ${where(at)}: breaking it would let the lava flow out. Nothing was broken.`
      case 'hit_water':
        return `Water at ${cell} touches the block at ${where(at)}: breaking it would let the water flow out. Nothing was broken.`
      case 'falling_blocks':
        return `Sand or gravel at ${cell} sits on the block at ${where(at)} and would fall into the gap. Nothing was broken.`
      default:
        return `The block at ${where(at)} is a spawner and is left alone.`
    }
  }

  /** Walks to a spot within reach: not on the cell, and not on the block that would be the floor under the bot. */
  private async approach(
    at: Position,
    here: Position,
    context: SkillContext,
  ): Promise<SkillResult<void>> {
    const { deps } = this
    const spot = deps.spots.choose({ target: at, from: here, reserved: new Set(), notOn: at })
    if (spot === undefined)
      return err({
        reason: 'unreachable',
        message: `There is no spot within reach of ${where(at)} to stand on.`,
      })
    if (spot === here) return ok(undefined)
    const walked = await deps.navigator.goToPosition(spot, 1, { signal: context.signal })
    if (walked.ok) return ok(undefined)
    if (walked.error.reason === 'aborted') return err({ reason: 'aborted', message: 'Cancelled.' })
    return err({
      reason: 'unreachable',
      message: `Could not walk to a spot beside ${where(at)}: ${walked.error.message}`,
    })
  }
}
