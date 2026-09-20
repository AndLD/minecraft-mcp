import type { CommandOutcome } from '../core/server-commands.port.js'

/**
 * Sorts the server's reply to a command. The reply is plain text (the colours are gone), so this goes by wording:
 * vanilla and Paper use a small set of phrases for refusals and errors, and anything else counts as success. The
 * caller verifies the effect anyway, so a misjudged reply costs a clearer message, not a wrong action.
 */
export function classifyReply(
  reply: string,
  commandAvailable: boolean | undefined,
): Exclude<CommandOutcome, { kind: 'sent' }> {
  const text = reply.trim()
  if (/permission/i.test(text)) return { kind: 'no_permission', reply: text }
  if (/unknown or incomplete command|unknown command/i.test(text)) {
    // A command the player may not use is unknown to a vanilla client, so the list decides which it was.
    return commandAvailable === false
      ? { kind: 'no_permission', reply: text }
      : { kind: 'unknown_command', reply: text }
  }
  if (
    /^(no (entity|player|targets?)|invalid|incorrect|expected|could not|cannot|can't|unable|that .* (is|are) (not|outside)|<--)/i.test(
      text,
    ) ||
    /outside (of )?the world|not (loaded|found)|world border/i.test(text)
  )
    return { kind: 'error', reply: text }
  return { kind: 'ok', reply: text }
}
