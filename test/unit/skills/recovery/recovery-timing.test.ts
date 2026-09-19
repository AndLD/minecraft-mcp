import { describe, expect, it } from '@jest/globals'
import { checkDeadline } from '../../../../src/skills/recovery/recovery-timing.js'

describe('checkDeadline', () => {
  it('accepts a spot that can be reached well before the items vanish', () => {
    const check = checkDeadline({ at: 0, now: 30_000, distance: 100 })

    expect(check).toMatchObject({ ok: true, secondsLeft: 270 })
  })

  it('says the items are gone once five minutes have passed', () => {
    expect(checkDeadline({ at: 0, now: 300_000, distance: 5 })).toMatchObject({
      ok: false,
      reason: 'expired',
      secondsLeft: 0,
    })
  })

  it('refuses a spot the bot cannot reach in time, with the numbers', () => {
    // 700 blocks at 3.5 blocks/s is 200 s, plus 10 s at the spot; 200 s are left, and 20 s stay in reserve.
    const check = checkDeadline({ at: 0, now: 100_000, distance: 700 })

    expect(check).toMatchObject({ ok: false, reason: 'too_far', secondsLeft: 200, etaSeconds: 210 })
  })

  it('keeps a safety margin before the deadline', () => {
    // Arrival would be 5 s before despawn: inside the 20 s margin.
    const tight = checkDeadline({ at: 0, now: 200_000, distance: 3.5 * 85 })
    const roomy = checkDeadline({ at: 0, now: 200_000, distance: 3.5 * 60 })

    expect(tight.ok).toBe(false)
    expect(roomy.ok).toBe(true)
  })
})
