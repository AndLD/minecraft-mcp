/** Source of randomness. Inject it instead of calling Math.random() so logic stays testable. */
export interface Random {
  /** A number in the range [0, 1). */
  next(): number
}
