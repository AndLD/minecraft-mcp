import { describe, expect, it } from '@jest/globals'
import type { SkillResult } from '../../../../src/core/skill.types.js'
import { ok } from '../../../../src/core/result.js'
import { penGateSetup } from '../../../fakes/pen-gate-fakes.js'

const bounds = { from: { x: 0, y: 64, z: 0 }, to: { x: 5, y: 66, z: 5 } }
const gate = { x: 2, y: 65, z: 6 }
const done = (): SkillResult<{ done: number; gateLeftOpen?: string }> => ok({ done: 1 })
const signal = () => new AbortController().signal

describe('PenGateGuard', () => {
  it('closes a gate left open in the fence ring', async () => {
    const s = penGateSetup()
    s.doors.add(gate, true, s.blocks)

    const problem = await s.guard.ensureShut(bounds, signal())

    expect(problem).toBeUndefined()
    expect(s.doors.stateAt(gate)?.open).toBe(false)
  })

  it('leaves a gate that is already shut alone', async () => {
    const s = penGateSetup()
    s.doors.add(gate, false, s.blocks)

    expect(await s.guard.ensureShut(bounds, signal())).toBeUndefined()
    expect(s.doors.toggled).toEqual([])
  })

  it('ignores gates that are far from the pen', async () => {
    const s = penGateSetup()
    s.doors.add({ x: 40, y: 65, z: 40 }, true, s.blocks)

    expect(await s.guard.ensureShut(bounds, signal())).toBeUndefined()
    expect(s.doors.toggled).toEqual([])
  })

  it('walks up to a gate it cannot close from where it stands', async () => {
    const s = penGateSetup()
    s.doors.add(gate, true, s.blocks)
    s.doors.farFrom.add('2,65,6')

    const problem = await s.guard.ensureShut(bounds, signal())

    expect(problem).toBeUndefined()
    expect(s.navigator.walked).toEqual([gate])
    expect(s.doors.stateAt(gate)?.open).toBe(false)
  })

  it('does not walk after a stop, and says the gate is still open', async () => {
    const s = penGateSetup()
    s.doors.add(gate, true, s.blocks)
    s.doors.farFrom.add('2,65,6')
    const stopped = new AbortController()
    stopped.abort()

    const problem = await s.guard.ensureShut(bounds, stopped.signal)

    expect(problem).toContain('2, 65, 6')
    expect(problem).toContain('still open')
    expect(s.navigator.walked).toEqual([])
    expect(s.logger.entries.some((e) => e.level === 'warn')).toBe(true)
  })

  it('closes a gate even when the task was stopped, if it is in reach', async () => {
    const s = penGateSetup()
    s.doors.add(gate, true, s.blocks)
    const stopped = new AbortController()
    stopped.abort()

    expect(await s.guard.ensureShut(bounds, stopped.signal)).toBeUndefined()
    expect(s.doors.stateAt(gate)?.open).toBe(false)
  })

  describe('finish', () => {
    it('adds the note to a successful result when a gate stays open', async () => {
      const s = penGateSetup()
      s.doors.add(gate, true, s.blocks)
      s.doors.farFrom.add('2,65,6')
      const stopped = new AbortController()
      stopped.abort()

      const result = await s.guard.finish(bounds, done(), stopped.signal)

      expect(result).toMatchObject({ ok: true, value: { done: 1, gateLeftOpen: expect.any(String) } })
    })

    it('still closes the gate when the task failed, and returns the failure as it was', async () => {
      const s = penGateSetup()
      s.doors.add(gate, true, s.blocks)
      const failure = { ok: false as const, error: { reason: 'aborted', message: 'Cancelled.' } }

      const result = await s.guard.finish(bounds, failure, signal())

      expect(result).toBe(failure)
      expect(s.doors.stateAt(gate)?.open).toBe(false)
    })

    it('does nothing without bounds', async () => {
      const s = penGateSetup()
      const result = done()

      expect(await s.guard.finish(undefined, result, signal())).toBe(result)
    })
  })
})
