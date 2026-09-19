import type { InventoryReader } from '../../core/inventory.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { SkillContext } from '../../core/skill.types.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { InventoryFullKind, StoragePolicyValue } from '../../state/storage-policy.js'
import type { ItemDepositor } from './deposit-items-skill.js'

/** What `resume_task` accepts while a task waits about a full inventory. */
export const FULL_OPTIONS = ['offload', 'continue', 'stop'] as const

/** How close to where it stood the bot walks back after offloading. */
const RETURN_RANGE = 2
const MAX_ATTEMPTS = 20

export type FullOutcome =
  /** There is room again: carry on. */
  | { readonly kind: 'freed' }
  /** The task should end with what it has. */
  | { readonly kind: 'stop'; readonly message: string }

export interface InventoryFullDeps {
  readonly policy: { get(): StoragePolicyValue }
  readonly depositor: ItemDepositor
  readonly navigator: Navigator
  readonly vitals: VitalsReader
  readonly inventory: InventoryReader
}

/**
 * What a task does when the inventory is full: stop, ask the player (the task pauses until `resume_task`), or offload
 * into containers by the storage rules and walk back to where it was. The policy comes from the call
 * (`on_inventory_full`) or else from the standing one (`set_storage_policy`); the default is to ask.
 */
export class InventoryFullHandler {
  constructor(private readonly deps: InventoryFullDeps) {}

  /** One per task: it counts the offload trips. */
  begin(override: InventoryFullKind | undefined): InventoryFullSession {
    return new InventoryFullSession(this.deps, override)
  }
}

export class InventoryFullSession {
  private trips = 0

  constructor(
    private readonly deps: InventoryFullDeps,
    private readonly override: InventoryFullKind | undefined,
  ) {}

  async handle(context: SkillContext): Promise<FullOutcome> {
    let problem = ''
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (context.signal.aborted) return { kind: 'stop', message: 'Cancelled.' }
      const policy = this.deps.policy.get()
      const kind = this.override ?? policy.kind

      if (kind === 'stop')
        return { kind: 'stop', message: 'The inventory is full, and the policy is to stop.' }

      if (kind === 'offload_and_return') {
        if (this.trips >= policy.maxTrips) {
          problem = `Reached the limit of ${String(policy.maxTrips)} offload trips.`
        } else {
          const result = await this.offload(context, policy)
          if (result === undefined) return { kind: 'freed' }
          problem = result
        }
      }

      if (context.ask === undefined)
        return { kind: 'stop', message: `The inventory is full. ${problem}`.trim() }
      context.progress('The inventory is full: waiting for a decision')
      const answer = await context.ask({
        message:
          `${problem} The inventory is full. Ask the player what to do: "offload" (deposit into chests by the storage rules and come back), ` +
          '"continue" (they freed space themselves), or "stop" (end the task with what it has). Answer with resume_task.',
        options: FULL_OPTIONS,
      })
      if (answer === undefined || answer === 'stop')
        return { kind: 'stop', message: 'The inventory is full, and the player said to stop.' }
      if (answer === 'continue') {
        if ((this.deps.inventory.snapshot()?.emptySlots ?? 0) > 0) return { kind: 'freed' }
        problem = 'There are still no free slots.'
        continue
      }
      const result = await this.offload(context, policy)
      if (result === undefined) return { kind: 'freed' }
      problem = result
    }
    return { kind: 'stop', message: 'The inventory stayed full.' }
  }

  /** Deposits what may be deposited and walks back. Returns a problem description, or undefined on success. */
  private async offload(
    context: SkillContext,
    policy: StoragePolicyValue,
  ): Promise<string | undefined> {
    const { deps } = this
    const origin = deps.vitals.read()?.position
    context.progress('Inventory full: taking things to the chests')
    const deposited = await deps.depositor.run(
      {
        specs: undefined,
        includeReserved: false,
        container: undefined,
        count: undefined,
        maxDistance: policy.maxDistance,
      },
      context,
    )
    if (!deposited.ok) return `Could not offload: ${deposited.error.message}`
    this.trips += 1

    if (origin !== undefined) {
      const back = await deps.navigator.goToPosition(origin, RETURN_RANGE, {
        signal: context.signal,
      })
      if (!back.ok) return `Deposited, but could not walk back: ${back.error.message}`
    }
    return (deps.inventory.snapshot()?.emptySlots ?? 0) > 0
      ? undefined
      : 'Deposited what could be, but there are still no free slots.'
  }
}
