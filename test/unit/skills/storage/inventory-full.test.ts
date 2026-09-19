import { describe, expect, it } from '@jest/globals'
import { err, ok } from '../../../../src/core/result.js'
import type { SkillContext, SkillResult } from '../../../../src/core/skill.types.js'
import type {
  DepositInput,
  DepositOutput,
} from '../../../../src/skills/storage/deposit-items-skill.js'
import { InventoryFullHandler } from '../../../../src/skills/storage/inventory-full-handler.js'
import type { InventoryFullKind, StoragePolicyValue } from '../../../../src/state/storage-policy.js'
import { FakeInventory, FakeVitals, buildVitals } from '../../../fakes/fake-ports.js'
import { InstantNavigator } from '../../../fakes/gathering-fakes.js'

function setup(kind: InventoryFullKind, extra: Partial<StoragePolicyValue> = {}) {
  const policy: StoragePolicyValue = { kind, maxTrips: 3, maxDistance: 50, ...extra }
  const inventory = new FakeInventory()
  inventory.value = { stacks: [], emptySlots: 0, heldItem: undefined }
  const vitals = new FakeVitals()
  vitals.vitals = buildVitals({ position: { x: 7, y: 64, z: 9 } })
  const navigator = new InstantNavigator()
  const deposits: DepositInput[] = []
  const results: { next: (input: DepositInput) => SkillResult<DepositOutput> } = {
    next: () => {
      inventory.value = { stacks: [], emptySlots: 10, heldItem: undefined } // it made room
      return ok({ deposited: [], leftover: [] })
    },
  }
  const handler = new InventoryFullHandler({
    policy: { get: () => policy },
    depositor: {
      run: (input) => {
        deposits.push(input)
        return Promise.resolve(results.next(input))
      },
    },
    navigator,
    vitals,
    inventory,
  })
  const asked: { message: string; options: readonly string[] }[] = []
  const answers: (string | undefined)[] = []
  const controller = new AbortController()
  const progress: string[] = []
  const context = (canAsk = true): SkillContext => ({
    signal: controller.signal,
    progress: (m) => {
      progress.push(m)
    },
    ...(canAsk
      ? {
          ask: (prompt) => {
            asked.push(prompt)
            return Promise.resolve(answers.shift())
          },
        }
      : {}),
  })
  return {
    handler,
    inventory,
    navigator,
    deposits,
    results,
    asked,
    answers,
    context,
    progress,
    controller,
  }
}

describe('InventoryFullHandler', () => {
  describe('with the policy "stop"', () => {
    it('ends the task without doing anything', async () => {
      const s = setup('stop')

      const outcome = await s.handler.begin(undefined).handle(s.context())

      expect(outcome).toEqual({
        kind: 'stop',
        message: 'The inventory is full, and the policy is to stop.',
      })
      expect(s.deposits).toEqual([])
      expect(s.asked).toEqual([])
    })
  })

  describe('with the policy "offload_and_return"', () => {
    it('deposits without asking and walks back to where it stood', async () => {
      const s = setup('offload_and_return')

      const outcome = await s.handler.begin(undefined).handle(s.context())

      expect(outcome).toEqual({ kind: 'freed' })
      expect(s.deposits).toEqual([
        {
          specs: undefined,
          includeReserved: false,
          container: undefined,
          count: undefined,
          maxDistance: 50,
        },
      ])
      expect(s.navigator.trips).toEqual([{ target: { x: 7, y: 64, z: 9 }, within: 2 }])
      expect(s.asked).toEqual([])
      expect(s.progress).toContain('Inventory full: taking things to the chests')
    })

    it('counts trips per task and asks once the limit is reached', async () => {
      const s = setup('offload_and_return', { maxTrips: 2 })
      const session = s.handler.begin(undefined)
      const full = () => {
        s.inventory.value = { stacks: [], emptySlots: 0, heldItem: undefined }
      }

      expect(await session.handle(s.context())).toEqual({ kind: 'freed' })
      full()
      expect(await session.handle(s.context())).toEqual({ kind: 'freed' })
      full()
      s.answers.push('stop')
      const third = await session.handle(s.context())

      expect(third).toMatchObject({ kind: 'stop' })
      expect(s.deposits).toHaveLength(2)
      expect(s.asked[0]?.message).toContain('limit of 2 offload trips')
      // a new task starts counting again
      full()
      expect(await s.handler.begin(undefined).handle(s.context())).toEqual({ kind: 'freed' })
    })

    it('falls back to asking when there is nowhere to put things', async () => {
      const s = setup('offload_and_return')
      s.results.next = () => err({ reason: 'no_storage_space', message: 'no container with room' })
      s.answers.push('stop')

      const outcome = await s.handler.begin(undefined).handle(s.context())

      expect(outcome).toMatchObject({ kind: 'stop' })
      expect(s.asked[0]?.message).toContain('Could not offload: no container with room')
      expect(s.asked[0]?.options).toEqual(['offload', 'continue', 'stop'])
    })

    it('stops instead of asking when nobody can answer', async () => {
      const s = setup('offload_and_return')
      s.results.next = () => err({ reason: 'no_storage_space', message: 'no room' })

      const outcome = await s.handler.begin(undefined).handle(s.context(false))

      expect(outcome).toMatchObject({
        kind: 'stop',
        message: expect.stringContaining('Could not offload: no room') as unknown as string,
      })
    })

    it('does not count a trip that failed, and reports still being full or not getting back', async () => {
      const s = setup('offload_and_return')
      s.results.next = () => ok({ deposited: [], leftover: [] }) // deposited, but no slot was freed
      s.answers.push('stop')

      const stillFull = await s.handler.begin(undefined).handle(s.context())
      s.results.next = () => {
        s.inventory.value = { stacks: [], emptySlots: 5, heldItem: undefined }
        return ok({ deposited: [], leftover: [] })
      }
      s.navigator.failures = [{ reason: 'unreachable', message: 'No path' }]
      s.answers.push('stop')
      const cannotReturn = await setupAndRun(s)

      expect(stillFull).toMatchObject({ kind: 'stop' })
      expect(s.asked[0]?.message).toContain('still no free slots')
      expect(cannotReturn).toMatchObject({ kind: 'stop' })
      expect(s.asked[1]?.message).toContain('could not walk back')
    })

    async function setupAndRun(s: ReturnType<typeof setup>) {
      s.inventory.value = { stacks: [], emptySlots: 0, heldItem: undefined }
      return s.handler.begin(undefined).handle(s.context())
    }
  })

  describe('with the policy "ask"', () => {
    it('pauses the task with a question the agent can relay', async () => {
      const s = setup('ask')
      s.answers.push('stop')

      const outcome = await s.handler.begin(undefined).handle(s.context())

      expect(outcome).toEqual({
        kind: 'stop',
        message: 'The inventory is full, and the player said to stop.',
      })
      expect(s.asked).toHaveLength(1)
      expect(s.asked[0]?.message).toContain('resume_task')
      expect(s.asked[0]?.options).toEqual(['offload', 'continue', 'stop'])
      expect(s.progress).toContain('The inventory is full: waiting for a decision')
    })

    it('offloads on "offload" and carries on', async () => {
      const s = setup('ask')
      s.answers.push('offload')

      const outcome = await s.handler.begin(undefined).handle(s.context())

      expect(outcome).toEqual({ kind: 'freed' })
      expect(s.deposits).toHaveLength(1)
      expect(s.navigator.trips).toHaveLength(1)
    })

    it('carries on on "continue" when the player made room, and asks again when they did not', async () => {
      const s = setup('ask')
      s.answers.push('continue', 'continue')
      const session = s.handler.begin(undefined)
      const second = session.handle({
        ...s.context(),
        ask: (prompt) => {
          s.asked.push(prompt)
          if (s.asked.length === 2)
            s.inventory.value = { stacks: [], emptySlots: 4, heldItem: undefined } // the player emptied a chest slot
          return Promise.resolve(s.answers.shift())
        },
      })

      expect(await second).toEqual({ kind: 'freed' })
      expect(s.asked).toHaveLength(2)
      expect(s.asked[1]?.message).toContain('still no free slots')
    })

    it('ends the task when the question is cancelled', async () => {
      const s = setup('ask')
      s.answers.push(undefined)

      const outcome = await s.handler.begin(undefined).handle(s.context())

      expect(outcome).toMatchObject({ kind: 'stop' })
    })

    it('stops when nobody can answer', async () => {
      const s = setup('ask')

      const outcome = await s.handler.begin(undefined).handle(s.context(false))

      expect(outcome).toEqual({ kind: 'stop', message: 'The inventory is full.' })
    })

    it('stops once cancelled, and gives up after too many unanswered rounds', async () => {
      const s = setup('ask')
      s.controller.abort()
      expect(await s.handler.begin(undefined).handle(s.context())).toEqual({
        kind: 'stop',
        message: 'Cancelled.',
      })

      const stubborn = setup('ask')
      for (let i = 0; i < 25; i += 1) stubborn.answers.push('continue')
      expect(await stubborn.handler.begin(undefined).handle(stubborn.context())).toEqual({
        kind: 'stop',
        message: 'The inventory stayed full.',
      })
    })
  })

  it('lets a call override the standing policy', async () => {
    const stopping = setup('offload_and_return')
    const offloading = setup('stop')

    const stopped = await stopping.handler.begin('stop').handle(stopping.context())
    const freed = await offloading.handler.begin('offload_and_return').handle(offloading.context())

    expect(stopped).toMatchObject({ kind: 'stop' })
    expect(stopping.deposits).toEqual([])
    expect(freed).toEqual({ kind: 'freed' })
  })
})
