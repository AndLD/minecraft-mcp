/**
 * Group names an agent can use instead of listing every variant ("logs" instead of oak_log, birch_log, ...).
 * Adding a group means adding a line here.
 */
const ALIASES: Readonly<Record<string, RegExp>> = {
  logs: /^(?!stripped_).+_log$/,
  ores: /_ore$/,
  leaves: /_leaves$/,
}

/** Replaces group names with the block names they stand for; other names pass through unchanged. */
export function expandBlockNames(
  names: readonly string[],
  known: readonly string[],
): readonly string[] {
  const expanded = names.flatMap((name) => {
    const pattern = ALIASES[name]
    return pattern === undefined ? [name] : known.filter((candidate) => pattern.test(candidate))
  })
  return [...new Set(expanded)]
}

export const BLOCK_ALIAS_NAMES = Object.keys(ALIASES)
