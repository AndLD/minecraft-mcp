const MAX_LENGTH = 40

/**
 * Turns free text into a safe profile name (lowercase letters, digits, dashes), or undefined when nothing is left.
 * The name becomes a directory name, so it must never contain path characters.
 */
export function toProfileName(text: string): string | undefined {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LENGTH)
    .replace(/-+$/g, '')
  return slug === '' ? undefined : slug
}
