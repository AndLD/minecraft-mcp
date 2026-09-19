/**
 * The login packet carries the hashed world seed as two 32-bit halves (or, in other protocol versions, one 64-bit number).
 * Returns it as one hex string, stable for a world, or undefined when the packet has no usable value.
 */
export function formatHashedSeed(raw: unknown): string | undefined {
  try {
    if (Array.isArray(raw) && raw.length === 2 && raw.every((part) => typeof part === 'number')) {
      const [high, low] = raw as [number, number]
      return BigInt.asUintN(64, (BigInt(high) << 32n) | BigInt.asUintN(32, BigInt(low))).toString(
        16,
      )
    }
    if (typeof raw === 'bigint') return BigInt.asUintN(64, raw).toString(16)
    if (typeof raw === 'number' && Number.isInteger(raw))
      return BigInt.asUintN(64, BigInt(raw)).toString(16)
    if (typeof raw === 'string' && /^-?\d+$/.test(raw))
      return BigInt.asUintN(64, BigInt(raw)).toString(16)
  } catch {
    return undefined
  }
  return undefined
}
