import type { Unsubscribe } from '../../src/core/connection.port.js'
import type { DeathEvent, DeathWatcher } from '../../src/core/death-watcher.port.js'
import type { DroppedItem, DroppedItemScanner } from '../../src/core/dropped-items.port.js'
import type { DecisionPrompt, SkillContext } from '../../src/core/skill.types.js'
import { distanceBetween } from '../../src/core/position.js'
import type { Position } from '../../src/core/position.types.js'
import type { ItemCount } from '../../src/core/recipes.port.js'
import type { UnclaimedDrop, UnclaimedSink } from '../../src/skills/recovery/unclaimed-drops.js'
import type { FakeInventory } from './fake-ports.js'

export class RecordingUnclaimedSink implements UnclaimedSink {
  readonly tracked: UnclaimedDrop[] = []

  track(drop: UnclaimedDrop): void {
    this.tracked.push(drop)
  }
}

/** A watcher the test fires by hand; `carriedNow` is what the bot holds after the respawn. */
export class FakeDeathWatcher implements DeathWatcher {
  carriedNow: ItemCount[] = []
  private readonly listeners = new Set<(event: DeathEvent) => void>()

  onDeath(listener: (event: DeathEvent) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  carried(): readonly ItemCount[] {
    return this.carriedNow
  }

  get listening(): number {
    return this.listeners.size
  }

  die(event: Partial<DeathEvent> = {}): void {
    for (const listener of this.listeners)
      listener({
        position: { x: 100.4, y: 64, z: -20.6 },
        dimension: 'overworld',
        carried: [],
        cause: undefined,
        ...event,
      })
  }
}

/** A skill context that can answer questions: each answer is used once, in order. */
export function askingContext(...answers: (string | undefined)[]): {
  context: SkillContext
  controller: AbortController
  prompts: DecisionPrompt[]
  progress: string[]
} {
  const controller = new AbortController()
  const prompts: DecisionPrompt[] = []
  const progress: string[] = []
  const queue = [...answers]
  return {
    context: {
      signal: controller.signal,
      progress: (message) => {
        progress.push(message)
      },
      ask: (prompt) => {
        prompts.push(prompt)
        return Promise.resolve(queue.shift())
      },
    },
    controller,
    prompts,
    progress,
  }
}

/** Items on the ground at fixed places; distances are worked out from where the bot stands. */
export class GroundItems implements DroppedItemScanner {
  items: { entityId: number; name: string; count: number; position: Position }[] = []
  botAt: Position = { x: 0, y: 64, z: 0 }
  /** How many items the inventory can take in total; more stay on the ground. */
  capacity = Infinity
  private nextId = 900

  drop(name: string, position: Position, count = 1): void {
    this.nextId += 1
    this.items.push({ entityId: this.nextId, name, count, position })
  }

  nearby(maxDistance: number): readonly DroppedItem[] {
    return this.items
      .map((item) => ({ ...item, distance: distanceBetween(this.botAt, item.position) }))
      .filter((item) => item.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance)
  }

  /** The bot is at `target`: it picks up every item within half a block into `inventory`. */
  arriveAt(target: Position, inventory: FakeInventory): void {
    this.botAt = target
    const taken = this.items.filter((item) => distanceBetween(item.position, target) <= 0.5)
    for (const item of taken) {
      const stacks = inventory.value?.stacks ?? []
      const held = stacks.reduce((sum, stack) => sum + stack.count, 0)
      if (held + item.count > this.capacity) continue
      const existing = stacks.find((stack) => stack.name === item.name)
      inventory.value = {
        stacks:
          existing === undefined
            ? [...stacks, { name: item.name, count: item.count }]
            : stacks.map((stack) =>
                stack === existing ? { ...stack, count: stack.count + item.count } : stack,
              ),
        emptySlots: Math.max(0, (inventory.value?.emptySlots ?? 30) - 1),
        heldItem: undefined,
      }
      this.items = this.items.filter((candidate) => candidate !== item)
    }
  }
}
