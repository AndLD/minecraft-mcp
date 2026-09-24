import type { SleepFailureReason } from '../core/sleeper.port.js'

/** Sorts what Mineflayer threw and what the server said (chat and action bar lines) into a reason. */
export function classifySleepFailure(text: string): SleepFailureReason {
  if (/monster/i.test(text)) return 'monsters_nearby'
  if (/only at night|not night|thunderstorm/i.test(text)) return 'not_night'
  if (/too far/i.test(text)) return 'too_far'
  if (/occupied/i.test(text)) return 'occupied'
  if (/obstructed/i.test(text)) return 'obstructed'
  if (/not a bed/i.test(text)) return 'not_a_bed'
  return 'failed'
}
