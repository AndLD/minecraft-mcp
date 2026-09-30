export type NameMatch =
  | { readonly ok: true; readonly names: readonly string[] }
  | { readonly ok: false; readonly suggestions: readonly string[] }

/** "Minecraft:Polar Bear" → "polar_bear". */
export const normalizeName = (input: string): string =>
  input
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .replace(/[\s-]+/g, '_')

/**
 * Turns the player's word into game names: an exact name if there is one ("desert"), otherwise every name that
 * contains the word ("jungle" is also bamboo_jungle and sparse_jungle, "bear" is polar_bear).
 */
export function matchName(input: string, known: readonly string[]): NameMatch {
  const wanted = normalizeName(input)
  if (wanted === '') return { ok: false, suggestions: [] }
  if (known.includes(wanted)) return { ok: true, names: [wanted] }
  const containing = known.filter((name) => name.includes(wanted))
  if (containing.length > 0) return { ok: true, names: containing }
  const shares = known.filter(
    (name) => wanted.includes(name) || name.startsWith(wanted.slice(0, 3)),
  )
  return { ok: false, suggestions: shares.slice(0, 8) }
}
