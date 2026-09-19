import type { StopHandler } from '../core/stop-handler.port.js'

/** Placeholder until the task manager exists: there is nothing to cancel yet. */
export class NoopStopHandler implements StopHandler {
  stopAll(): void {
    // Nothing is running.
  }
}
