import type { Scheduler } from './scheduler.port.js'

/** Waits `ms`, or less when the signal aborts (also when it is already aborted). */
export function sleep(scheduler: Scheduler, ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = (): void => {
      cancel()
      signal.removeEventListener('abort', done)
      resolve()
    }
    const cancel = scheduler.after(ms, done)
    signal.addEventListener('abort', done, { once: true })
  })
}
