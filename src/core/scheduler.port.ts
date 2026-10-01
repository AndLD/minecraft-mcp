/** Source of delayed callbacks. Inject it instead of calling setTimeout() so logic stays testable. */
export interface Scheduler {
  /** Runs `callback` once after `delayMs`. Returns a function that cancels it. */
  after(delayMs: number, callback: () => void): () => void
}
