import type { ChatPort } from '../../core/chat.port.js'
import type { Clock } from '../../core/clock.port.js'
import type { Combatant, GearReport } from '../../core/combatant.port.js'
import type { DroppedItem, DroppedItemScanner } from '../../core/dropped-items.port.js'
import type { EntityScanner } from '../../core/entity-scanner.port.js'
import type { Gaze } from '../../core/gaze.port.js'
import { countItems } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { ItemFacts } from '../../core/item-facts.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import { distanceBetween } from '../../core/position.js'
import type { Position } from '../../core/position.types.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { err, ok } from '../../core/result.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import { sleep } from '../../core/sleep.js'
import type { DropCollector } from '../gathering/drop-collector.js'
import { isGroup, matchesSpec } from '../storage/item-matcher.js'

/** Closer than this and the bot stays where it is; farther and it walks up. */
const NEAR_PLAYER = 3
/** How close it stands, so a throw lands in reach. */
const APPROACH_RANGE = 1.5
const POLL_MS = 500
/** A thrown item lands within this many blocks of where the player stood. */
const THROW_RADIUS = 6
/** The bot's view of dropped items. */
const SCAN_RADIUS = 24
/** With no count given, how long to wait for a second item of the same throw after the first one is picked up. */
const GRACE_MS = 2_000
/** A player out of view for this long ends the wait. */
const LOST_AFTER_MS = 10_000

export interface ReceiveItemInput {
  /** Whose throw counts. */
  readonly player: string
  /** What to expect: an item name, a group (`tools`), a word such as `pickaxe`; anything when undefined. */
  readonly item: string | undefined
  /** How many to take; whatever comes (one throw) when undefined. */
  readonly count: number | undefined
  /** Equip the best gear afterwards (a sword, armor). */
  readonly useIt: boolean
  /** How long to wait for a throw. */
  readonly timeoutMs: number
}

export interface ReceiveItemOutput {
  readonly received: readonly ItemCount[]
  /** What `equipBestGear` changed, when `useIt` was set. */
  readonly equipped?: GearReport
}

export interface ReceiveItemDeps {
  readonly entities: EntityScanner
  readonly navigator: Navigator
  readonly gaze: Gaze
  readonly drops: DroppedItemScanner
  readonly collector: Pick<DropCollector, 'collect'>
  readonly inventory: InventoryReader
  readonly facts: ItemFacts
  readonly chat: ChatPort
  readonly combatant: Pick<Combatant, 'equipBestGear'>
  readonly scheduler: Scheduler
  readonly clock: Clock
}

/**
 * The reverse of `give_items`: stands by a player who is about to throw something, and takes it. Only an item that
 * lands on the ground near the player after the wait began counts (what lay there before is ignored), it is picked up
 * with the ordinary drop collector, and what arrived is said in chat. It never takes anything from a player's hands or
 * from a chest.
 */
export class ReceiveItemSkill implements Skill<ReceiveItemInput, ReceiveItemOutput> {
  readonly name = 'receive_item'

  constructor(private readonly deps: ReceiveItemDeps) {}

  async run(
    input: ReceiveItemInput,
    context: SkillContext,
  ): Promise<SkillResult<ReceiveItemOutput>> {
    const { deps } = this
    const first = deps.entities.player(input.player)
    if (first === undefined || !first.online)
      return err({ reason: 'player_offline', message: `${input.player} is not online.` })
    if (first.position === undefined)
      return err({
        reason: 'player_lost',
        message: `${input.player} is out of the bot's view. Ask them to come closer.`,
      })

    const matches = this.matcher(input.item)
    const baseline = new Set(deps.drops.nearby(SCAN_RADIUS).map((item) => item.entityId))
    let lastSeen = first.position
    let lastSeenAt = deps.clock.now()

    if ((first.distance ?? 0) > NEAR_PLAYER) {
      context.progress(`Walking to ${input.player}`)
      const walked = await deps.navigator.goToPlayer(input.player, APPROACH_RANGE, {
        signal: context.signal,
      })
      if (!walked.ok)
        return err({
          reason: walked.error.reason === 'aborted' ? 'aborted' : 'player_lost',
          message: `Could not get to ${input.player}: ${walked.error.message}`,
        })
    }
    await deps.gaze.lookAt(deps.entities.player(input.player)?.position ?? lastSeen)
    deps.chat.say(
      `Ready: throw me ${input.item === undefined ? 'the item' : `the ${input.item.replace(/_/g, ' ')}`}.`,
    )

    context.progress(`Waiting for ${input.player} to throw something`)
    const before = countItems(deps.inventory.snapshot())
    const deadline = deps.clock.now() + input.timeoutMs
    let firstPickupAt: number | undefined

    for (;;) {
      if (context.signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })
      const player = deps.entities.player(input.player)
      if (player === undefined || !player.online)
        return this.ended('player_offline', `${input.player} went offline.`, before, input, matches)
      if (player.position !== undefined) {
        lastSeen = player.position
        lastSeenAt = deps.clock.now()
      } else if (deps.clock.now() - lastSeenAt > LOST_AFTER_MS)
        return this.ended('player_lost', `${input.player} is out of view.`, before, input, matches)

      const thrown = this.newDrops(baseline, matches, lastSeen)
      if (thrown.length > 0) {
        await deps.collector.collect(
          {
            maxDistance: SCAN_RADIUS,
            accept: (item) => !baseline.has(item.entityId) && matches(item.name),
          },
          context.signal,
        )
        firstPickupAt ??= deps.clock.now()
        const stillThere = this.newDrops(baseline, matches, lastSeen)
        if (stillThere.length > 0 && this.full())
          return this.leftOnGround(stillThere, before, input, matches)
        for (const item of thrown) baseline.add(item.entityId)
      }
      const got = this.gained(before, matches)
      const total = got.reduce((sum, entry) => sum + entry.count, 0)
      if (input.count !== undefined && total >= input.count) break
      if (
        input.count === undefined &&
        firstPickupAt !== undefined &&
        total > 0 &&
        deps.clock.now() - firstPickupAt >= GRACE_MS
      )
        break
      if (deps.clock.now() >= deadline) break
      await sleep(deps.scheduler, POLL_MS, context.signal)
    }

    const received = this.gained(before, matches)
    if (received.length === 0) {
      deps.chat.say('Nothing came my way.')
      return err({
        reason: 'nothing_received',
        message: `Nothing was thrown within ${String(Math.round(input.timeoutMs / 1000))} seconds (only items that land after the wait began count).`,
      })
    }
    deps.chat.say(
      `Got ${received.map((entry) => `${String(entry.count)} ${entry.name.replace(/_/g, ' ')}`).join(', ')}.`,
    )
    const equipped = input.useIt ? await deps.combatant.equipBestGear() : undefined
    if (equipped !== undefined) {
      const worn = [equipped.weapon, ...equipped.armor].filter(
        (entry): entry is string => entry !== undefined,
      )
      if (worn.length > 0) deps.chat.say(`Equipped ${worn.join(', ').replace(/_/g, ' ')}.`)
    }
    return ok({ received, ...(equipped === undefined ? {} : { equipped }) })
  }

  /** Drops that appeared after the wait began, near where the player stood, and match what was asked for. */
  private newDrops(
    baseline: ReadonlySet<number>,
    matches: (name: string) => boolean,
    around: Position,
  ): DroppedItem[] {
    return this.deps.drops
      .nearby(SCAN_RADIUS)
      .filter(
        (item) =>
          !baseline.has(item.entityId) &&
          matches(item.name) &&
          distanceBetween(item.position, around) <= THROW_RADIUS,
      )
  }

  private full(): boolean {
    return (this.deps.inventory.snapshot()?.emptySlots ?? 1) === 0
  }

  /** The inventory's gain in matching items since the wait began. */
  private gained(
    before: ReadonlyMap<string, number>,
    matches: (name: string) => boolean,
  ): ItemCount[] {
    const gained: ItemCount[] = []
    for (const [name, count] of countItems(this.deps.inventory.snapshot())) {
      const more = count - (before.get(name) ?? 0)
      if (more > 0 && matches(name)) gained.push({ name, count: more })
    }
    return gained
  }

  private ended(
    reason: string,
    message: string,
    before: ReadonlyMap<string, number>,
    input: ReceiveItemInput,
    matches: (name: string) => boolean,
  ): SkillResult<ReceiveItemOutput> {
    const got = this.gained(before, matches)
    return err({
      reason,
      message:
        got.length === 0
          ? message
          : `${message} Already taken: ${got.map((e) => `${String(e.count)} ${e.name}`).join(', ')}.`,
      detail: { received: got, player: input.player },
    })
  }

  private leftOnGround(
    items: readonly DroppedItem[],
    before: ReadonlyMap<string, number>,
    input: ReceiveItemInput,
    matches: (name: string) => boolean,
  ): SkillResult<ReceiveItemOutput> {
    const at = items[0]?.position
    const where =
      at === undefined
        ? ''
        : ` at ${String(Math.round(at.x))} ${String(Math.round(at.y))} ${String(Math.round(at.z))}`
    this.deps.chat.say('My inventory is full: I cannot take that.')
    return this.ended(
      'inventory_full',
      `The inventory is full: ${items.map((i) => i.name).join(', ')} stays on the ground${where}. Free some space and ask again.`,
      before,
      input,
      matches,
    )
  }

  /** What counts as the item asked for: a group, an exact name, or a word such as `pickaxe` (any `*_pickaxe`). */
  private matcher(spec: string | undefined): (name: string) => boolean {
    if (spec === undefined || spec.trim() === '') return () => true
    const word = spec
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_')
    const singular = word.endsWith('s') ? word.slice(0, -1) : word
    return (name) =>
      isGroup(word)
        ? matchesSpec(word, name, this.deps.facts)
        : name === word ||
          name === singular ||
          name.endsWith(`_${word}`) ||
          name.endsWith(`_${singular}`)
  }
}
