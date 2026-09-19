import { describe, expect, it } from '@jest/globals'
import { LowFoodResponder } from '../../../../src/skills/hunting/low-food-responder.js'
import { FoodPolicy, type LowFoodPolicy } from '../../../../src/state/food-policy.js'
import { FakeClock } from '../../../fakes/fake-clock.js'
import { FakeScheduler } from '../../../fakes/fake-scheduler.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

function setup(policy: LowFoodPolicy, startResult = { ok: true, message: '' }) {
  const clock = new FakeClock()
  const scheduler = new FakeScheduler(clock)
  const events: { type: string; message: string }[] = []
  const calls = { hunts: 0, stops: 0 }
  const responder = new LowFoodResponder({
    policy: { get: () => policy },
    emit: (type, message) => {
      events.push({ type, message })
    },
    startHunt: () => {
      calls.hunts += 1
      return Promise.resolve(startResult)
    },
    stopTask: () => {
      calls.stops += 1
      return Promise.resolve()
    },
    scheduler,
  })
  return { scheduler, events, calls, responder }
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('LowFoodResponder', () => {
  it('asks the agent to ask the player when the policy is "ask"', () => {
    const { responder, events, calls } = setup('ask')

    responder.respond()

    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('needs_decision')
    expect(events[0]?.message).toContain('set_food_policy')
    expect(calls).toEqual({ hunts: 0, stops: 0 })
  })

  it('starts a hunt by itself, after the eating reflex is done, when the policy is "hunt_and_cook"', async () => {
    const { responder, scheduler, events, calls } = setup('hunt_and_cook')

    responder.respond()
    expect(calls.hunts).toBe(0)
    scheduler.advance(2000)
    await settle()

    expect(calls.hunts).toBe(1)
    expect(events).toEqual([
      { type: 'reflex', message: expect.stringContaining('started hunting') as unknown as string },
    ])
  })

  it('says why when the hunt could not start', async () => {
    const { responder, scheduler, events } = setup('hunt_and_cook', {
      ok: false,
      message: 'A task is running.',
    })

    responder.respond()
    scheduler.advance(2000)
    await settle()

    expect(events[0]?.message).toBe('Out of food, but hunting could not start: A task is running.')
  })

  it('cancels the task and tells the agent when the policy is "stop"', async () => {
    const { responder, events, calls } = setup('stop')

    responder.respond()
    await settle()

    expect(calls.stops).toBe(1)
    expect(events[0]?.message).toContain('cancelled')
  })
})

describe('FoodPolicy', () => {
  it('defaults to asking and saves what is set', async () => {
    const store = new InMemoryStateStore()
    const policy = new FoodPolicy()
    await policy.attach(store)

    expect(policy.get()).toBe('ask')
    expect(policy.set('hunt_and_cook')).toEqual({ ok: true, value: undefined })
    expect(store.data('food-policy')).toEqual({ policy: 'hunt_and_cook' })

    const reloaded = new FoodPolicy()
    await reloaded.attach(store)
    expect(reloaded.get()).toBe('hunt_and_cook')
  })

  it('cannot be set without a world, and falls back to asking', async () => {
    const policy = new FoodPolicy()
    expect(policy.set('stop').ok).toBe(false)

    await policy.attach(new InMemoryStateStore())
    policy.set('stop')
    policy.detach()

    expect(policy.get()).toBe('ask')
  })

  it('passes on a warning from loading', async () => {
    const store = new InMemoryStateStore()
    store.warnOnLoad = 'recovered'

    expect(await new FoodPolicy().attach(store)).toEqual(['recovered'])
  })
})
