import type { Clock } from '../../core/clock.port.js'
import type { ItemFacts } from '../../core/item-facts.port.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { ContainerEntry, ContainerIndex } from '../../state/container-index.js'
import type { ContainerSelector } from './container-selector.js'
import type { ContainerVisitor } from './container-visitor.js'

/** Slots of the bot's own inventory that a job leaves free, so it can still pick something up. */
const KEEP_FREE_SLOTS = 2
/** Planning goes over the leftovers again after room was freed, this many times at most. */
const PLAN_PASSES = 3

export interface OrganizeInput {
  /** Containers (ids or labels) whose contents are sorted; every known one when undefined. */
  readonly containers: readonly string[] | undefined
  /** List the moves and change nothing. */
  readonly dryRun: boolean
  readonly maxMinutes: number
}

interface Named {
  readonly id: string
  readonly label: string | null
}

export interface OrganizeMove {
  readonly item: string
  readonly count: number
  readonly from: Named
  readonly to: Named
}

export interface OrganizeOutput {
  readonly dryRun: boolean
  /** The moves planned (a dry run) or made (with the counts that really went). */
  readonly moves: readonly OrganizeMove[]
  /** Items that really changed container. */
  readonly moved: number
  /** Stacks that stay: already in the right container, or no rule names one. */
  readonly unchanged: number
  /** Items that should move but could not, and why. */
  readonly left: readonly {
    readonly item: string
    readonly count: number
    readonly container: string
    readonly reason: string
  }[]
  /** Containers that were not looked at or used, and why. */
  readonly skipped: readonly { readonly container: string; readonly reason: string }[]
  /** Items the bot still carries from the job (a container it could not put them back into). */
  readonly carried: readonly ItemCount[]
}

export interface OrganizeStorageDeps {
  readonly inventory: InventoryReader
  readonly index: ContainerIndex
  readonly selector: ContainerSelector
  readonly visitor: ContainerVisitor
  readonly facts: ItemFacts
  readonly clock: Clock
}

interface Plan {
  readonly moves: PlannedMove[]
  readonly left: { item: string; count: number; container: string; reason: string }[]
  readonly unchanged: number
}

interface PlannedMove {
  readonly item: string
  count: number
  readonly from: string
  readonly to: string
}

/**
 * Sorts what is already in the chests by the storage rules: every stack that a rule sends to another container is
 * carried there. It looks into the containers first (so the plan is made from what is really inside), plans every
 * move against the room each container will have, and only then walks: one trip per source, taking what fits in the
 * inventory and delivering it, and putting back what a full container would not take. Items with no rule stay where
 * they are; protected containers are never opened for this. `dryRun` stops after the plan.
 */
export class OrganizeStorageSkill implements Skill<OrganizeInput, OrganizeOutput> {
  readonly name = 'organize_storage'

  constructor(private readonly deps: OrganizeStorageDeps) {}

  async run(input: OrganizeInput, context: SkillContext): Promise<SkillResult<OrganizeOutput>> {
    const { deps } = this
    if (deps.inventory.snapshot() === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })

    const skipped: { container: string; reason: string }[] = []
    const chosen: ContainerEntry[] = []
    for (const name of input.containers ?? deps.index.all().map((entry) => entry.id)) {
      const entry = deps.index.resolve(name)
      if (entry === undefined)
        return err({
          reason: 'unknown_container',
          message: `There is no container "${name}". See list_containers.`,
        })
      if (entry.protected)
        skipped.push({ container: deps.visitor.describe(entry), reason: 'protected' })
      else if (!chosen.some((other) => other.id === entry.id)) chosen.push(entry)
    }
    if (chosen.length === 0)
      return err({
        reason: 'no_containers',
        message:
          'There are no unprotected containers to organize. Register some (register_container) first.',
      })

    const looked = await this.lookInto(chosen, skipped, context)
    if (looked !== undefined) return looked
    const sources = chosen.filter((entry) => deps.index.get(entry.id) !== undefined)
    const plan = this.plan(sources)
    if (input.dryRun)
      return ok(
        this.output(
          true,
          plan.moves.map((m) => this.asMove(m)),
          plan,
          skipped,
          [],
        ),
      )

    return this.carryOut(plan, skipped, input, context)
  }

  /** Opens every container the plan depends on, so it is made from what is really inside. */
  private async lookInto(
    chosen: readonly ContainerEntry[],
    skipped: { container: string; reason: string }[],
    context: SkillContext,
  ): Promise<SkillResult<never> | undefined> {
    const { deps } = this
    const wanted = new Map<string, ContainerEntry>(chosen.map((entry) => [entry.id, entry]))
    for (const entry of chosen)
      for (const stack of entry.contents) {
        const target = deps.selector.ruled(stack.name)
        if (target !== undefined) wanted.set(target.id, target)
      }
    const queue = [...wanted.values()]
    while (queue.length > 0) {
      if (context.signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })
      const entry = queue.shift()
      if (entry === undefined) break
      context.progress(
        `Looking into ${deps.visitor.describe(entry)} (${String(queue.length)} more)`,
      )
      const visit = await deps.visitor.visit(entry, context, () => Promise.resolve())
      if (visit.ok) continue
      if (visit.error.reason === 'aborted') return err(visit.error)
      skipped.push({ container: deps.visitor.describe(entry), reason: visit.error.message })
    }
    return undefined
  }

  /** What has to move where, against the room each container will have once the earlier moves are made. */
  private plan(sources: readonly ContainerEntry[]): Plan {
    const { deps } = this
    const holds = new Map<string, Map<string, number>>()
    const entryOf = (id: string): ContainerEntry | undefined => deps.index.get(id)
    const holdsOf = (id: string): Map<string, number> => {
      const known = holds.get(id)
      if (known !== undefined) return known
      const map = new Map<string, number>()
      for (const stack of entryOf(id)?.contents ?? [])
        map.set(stack.name, (map.get(stack.name) ?? 0) + stack.count)
      holds.set(id, map)
      return map
    }
    const stackOf = (item: string): number => Math.max(1, deps.facts.stackSize(item))
    const slotsUsed = (id: string): number =>
      [...holdsOf(id)].reduce((sum, [item, count]) => sum + Math.ceil(count / stackOf(item)), 0)
    /** How many of an item the container can still take: free slots plus the room in a partly full stack. */
    const capacity = (id: string, item: string): number => {
      const total = entryOf(id)?.totalSlots
      if (total === null || total === undefined) return Number.POSITIVE_INFINITY
      const size = stackOf(item)
      const inside = holdsOf(id).get(item) ?? 0
      return Math.max(0, total - slotsUsed(id)) * size + ((size - (inside % size)) % size)
    }

    const moves: PlannedMove[] = []
    const left: Plan['left'] = []
    let unchanged = 0
    const wanting: { item: string; count: number; from: string; to: string }[] = []
    for (const source of sources)
      for (const [item, count] of holdsOf(source.id)) {
        const target = deps.selector.ruled(item)
        if (target === undefined || target.id === source.id) unchanged += 1
        else wanting.push({ item, count, from: source.id, to: target.id })
      }

    let pending = wanting
    for (let pass = 0; pass < PLAN_PASSES && pending.length > 0; pass += 1) {
      const again: typeof pending = []
      let progressed = false
      for (const want of pending) {
        const room = capacity(want.to, want.item)
        const count = Math.min(want.count, room)
        if (count > 0) {
          moves.push({ item: want.item, count, from: want.from, to: want.to })
          const from = holdsOf(want.from)
          const rest = (from.get(want.item) ?? 0) - count
          if (rest > 0) from.set(want.item, rest)
          else from.delete(want.item)
          holdsOf(want.to).set(want.item, (holdsOf(want.to).get(want.item) ?? 0) + count)
          progressed = true
        }
        if (count < want.count) again.push({ ...want, count: want.count - count })
      }
      pending = again
      if (!progressed) break
    }
    for (const want of pending) {
      const from = entryOf(want.from)
      const to = entryOf(want.to)
      left.push({
        item: want.item,
        count: want.count,
        container: from === undefined ? want.from : deps.visitor.describe(from),
        reason: `no room in ${to === undefined ? want.to : deps.visitor.describe(to)}`,
      })
    }
    return { moves, left, unchanged }
  }

  private async carryOut(
    plan: Plan,
    skipped: { container: string; reason: string }[],
    input: OrganizeInput,
    context: SkillContext,
  ): Promise<SkillResult<OrganizeOutput>> {
    const { deps } = this
    const deadline = deps.clock.now() + input.maxMinutes * 60_000
    const done: OrganizeMove[] = []
    const left = [...plan.left]
    const carried = new Map<string, number>()
    let pending = plan.moves.map((move) => ({ ...move }))
    const flags = { aborted: false }

    while (pending.length > 0) {
      if (context.signal.aborted) {
        flags.aborted = true
        break
      }
      if (deps.clock.now() >= deadline) {
        for (const move of pending) left.push(this.unmoved(move, 'time is up'))
        break
      }
      const sourceId = pending[0]?.from
      if (sourceId === undefined) break
      const source = deps.index.get(sourceId)
      const batch = pending.filter((move) => move.from === sourceId)
      pending = pending.filter((move) => move.from !== sourceId)
      if (source === undefined) {
        for (const move of batch) left.push(this.unmoved(move, 'the container is gone'))
        continue
      }

      const slots = Math.max(0, (deps.inventory.snapshot()?.emptySlots ?? 0) - KEEP_FREE_SLOTS)
      const taken = await this.takeFrom(source, batch, slots, carried, context)
      if (!taken.ok) {
        if (taken.error.reason === 'aborted') flags.aborted = true
        for (const move of batch) left.push(this.unmoved(move, taken.error.message))
        if (flags.aborted) break
        continue
      }
      for (const move of taken.value.notTaken) pending.push(move)
      for (const move of taken.value.short) left.push(this.unmoved(move, 'the inventory is full'))

      const byTarget = new Map<string, OrganizeMove[]>()
      for (const move of taken.value.taken) {
        const list = byTarget.get(move.to) ?? []
        list.push({
          item: move.item,
          count: move.count,
          from: named(source),
          to: { id: move.to, label: null },
        })
        byTarget.set(move.to, list)
      }
      for (const [targetId, list] of byTarget) {
        const target = deps.index.get(targetId)
        const moved =
          target === undefined ? undefined : await this.deliver(target, list, carried, context)
        if (moved === undefined || target === undefined) continue
        for (const move of moved) done.push({ ...move, to: named(target) })
      }
      flags.aborted = wasCancelled(context) // a cancel during the trip still puts the items back below
      await this.putBack(source, carried, left)
      if (flags.aborted) break
    }

    if (flags.aborted) for (const move of pending) left.push(this.unmoved(move, 'cancelled'))
    const stuck = [...carried]
      .filter(([, count]) => count > 0)
      .map(([name, count]) => ({ name, count }))
    const output = this.output(false, done, { ...plan, left }, skipped, stuck)
    if (flags.aborted)
      return err({
        reason: 'aborted',
        message: `Cancelled after moving ${String(output.moved)} item(s).`,
        detail: { ...output },
      })
    return ok(output)
  }

  /** Withdraws what a batch moves out of one source, as much as fits in the inventory. */
  private async takeFrom(
    source: ContainerEntry,
    batch: readonly PlannedMove[],
    slots: number,
    carried: Map<string, number>,
    context: SkillContext,
  ): Promise<SkillResult<{ taken: PlannedMove[]; notTaken: PlannedMove[]; short: PlannedMove[] }>> {
    const { deps } = this
    let freeSlots = slots
    const notTaken: PlannedMove[] = []
    const short: PlannedMove[] = []
    const wanted: PlannedMove[] = []
    for (const move of batch) {
      const size = Math.max(1, deps.facts.stackSize(move.item))
      const fits = Math.min(move.count, freeSlots * size)
      if (fits <= 0) {
        if (wanted.length === 0) short.push(move)
        else notTaken.push(move)
        continue
      }
      freeSlots -= Math.ceil(fits / size)
      wanted.push({ ...move, count: fits })
      if (fits < move.count) notTaken.push({ ...move, count: move.count - fits })
    }
    if (wanted.length === 0) return ok({ taken: [], notTaken, short })
    context.progress(`Taking items out of ${deps.visitor.describe(source)}`)
    const visited = await deps.visitor.visit(source, context, async (session) => {
      const got: PlannedMove[] = []
      for (const move of wanted) {
        const count = await session.withdraw(move.item, move.count)
        if (count <= 0) continue
        carried.set(move.item, (carried.get(move.item) ?? 0) + count)
        got.push({ ...move, count })
      }
      return got
    })
    if (!visited.ok) return visited
    return ok({ taken: visited.value, notTaken, short })
  }

  /** Puts carried items into the container a rule names. Returns what really went in. */
  private async deliver(
    target: ContainerEntry,
    list: readonly OrganizeMove[],
    carried: Map<string, number>,
    context: SkillContext,
  ): Promise<OrganizeMove[] | undefined> {
    const { deps } = this
    context.progress(`Putting items into ${deps.visitor.describe(target)}`)
    const visited = await deps.visitor.visit(target, context, async (session) => {
      const went: OrganizeMove[] = []
      for (const move of list) {
        const count = await session.deposit(move.item, move.count)
        if (count <= 0) continue
        carried.set(move.item, Math.max(0, (carried.get(move.item) ?? 0) - count))
        went.push({ ...move, count })
      }
      return went
    })
    return visited.ok ? visited.value : undefined
  }

  /** Whatever is still carried goes back where it came from (this ignores a cancel: it must not be left in hand). */
  private async putBack(
    source: ContainerEntry,
    carried: Map<string, number>,
    left: Plan['left'],
  ): Promise<void> {
    const { deps } = this
    const remaining = [...carried].filter(([, count]) => count > 0)
    if (remaining.length === 0) return
    const free = { signal: new AbortController().signal, progress: () => undefined }
    const visited = await deps.visitor.visit(source, free, async (session) => {
      for (const [item, count] of remaining) {
        const back = await session.deposit(item, count)
        carried.set(item, Math.max(0, (carried.get(item) ?? 0) - back))
      }
    })
    if (!visited.ok) return
    for (const [item, count] of carried)
      if (count <= 0) carried.delete(item)
      else
        left.push({
          item,
          count,
          container: deps.visitor.describe(source),
          reason: 'could not be put back',
        })
  }

  private unmoved(move: PlannedMove, reason: string): Plan['left'][number] {
    const from = this.deps.index.get(move.from)
    return {
      item: move.item,
      count: move.count,
      container: from === undefined ? move.from : this.deps.visitor.describe(from),
      reason,
    }
  }

  private asMove(move: PlannedMove): OrganizeMove {
    const describe = (id: string): Named => ({ id, label: this.deps.index.get(id)?.label ?? null })
    return { item: move.item, count: move.count, from: describe(move.from), to: describe(move.to) }
  }

  private output(
    dryRun: boolean,
    moves: readonly OrganizeMove[],
    plan: Pick<Plan, 'left' | 'unchanged'>,
    skipped: { container: string; reason: string }[],
    carried: readonly ItemCount[],
  ): OrganizeOutput {
    return {
      dryRun,
      moves,
      moved: dryRun ? 0 : moves.reduce((sum, move) => sum + move.count, 0),
      unchanged: plan.unchanged,
      left: plan.left,
      skipped,
      carried,
    }
  }
}

/** Read through a function so the compiler does not assume the signal is still as it was at the top of the loop. */
const wasCancelled = (context: SkillContext): boolean => context.signal.aborted

const named = (entry: ContainerEntry): Named => ({ id: entry.id, label: entry.label })
