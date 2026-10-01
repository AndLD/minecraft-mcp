/** Source of time. Inject it instead of calling Date.now() so logic stays testable. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number
}
