import type { Scheduler } from '../core/scheduler.port.js'

export class SystemScheduler implements Scheduler {
  after(delayMs: number, callback: () => void): () => void {
    const handle = setTimeout(callback, delayMs)
    return () => {
      clearTimeout(handle)
    }
  }
}
