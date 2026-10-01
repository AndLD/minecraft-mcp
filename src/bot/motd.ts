/** Turns a server status `description` (plain text or a Minecraft chat component) into plain text. */
export function flattenMotd(description: unknown): string {
  return stripFormatting(flatten(description)).trim()
}

function flatten(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(flatten).join('')
  if (typeof node === 'object' && node !== null) {
    const component = node as { text?: unknown; extra?: unknown }
    return `${typeof component.text === 'string' ? component.text : ''}${flatten(component.extra)}`
  }
  return ''
}

/** Removes `§x` color and style codes. */
function stripFormatting(text: string): string {
  return text.replace(/§./g, '')
}

export interface SplitMotd {
  /** The player who opened the world to LAN, for a LAN message of the day (`<player> - <world name>`). */
  readonly hostPlayer: string | undefined
  readonly worldName: string
}

/** A LAN world announces `<player> - <world name>`; any other server's message of the day is the name as it is. */
export function splitMotd(motd: string): SplitMotd {
  const separator = motd.indexOf(' - ')
  if (separator < 0) return { hostPlayer: undefined, worldName: motd.trim() }
  return {
    hostPlayer: motd.slice(0, separator).trim(),
    worldName: motd.slice(separator + 3).trim(),
  }
}
