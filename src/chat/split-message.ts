/** Minecraft rejects chat lines longer than 256 characters; stay safely below. */
export const MAX_CHAT_LENGTH = 240

/**
 * Splits text into chat-sized lines, preferring to break at spaces.
 * Empty lines are dropped and surrounding whitespace is trimmed.
 */
export function splitChatMessage(text: string, maxLength: number = MAX_CHAT_LENGTH): string[] {
  const lines: string[] = []
  for (const paragraph of text.split(/\r?\n/)) {
    let rest = paragraph.trim()
    while (rest.length > maxLength) {
      const breakAt = rest.lastIndexOf(' ', maxLength)
      const cut = breakAt > 0 ? breakAt : maxLength
      lines.push(rest.slice(0, cut).trimEnd())
      rest = rest.slice(cut).trimStart()
    }
    if (rest.length > 0) lines.push(rest)
  }
  return lines
}
