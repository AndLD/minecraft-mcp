import { err, ok, type Result } from '../../core/result.js'

export const SIGN_LINES = 4
export const SIGN_LINE_LENGTH = 15

export interface SignTextProblem {
  readonly reason: 'text_too_long' | 'bad_text' | 'no_text'
  readonly message: string
}

const HOW_TO_SPLIT =
  `A sign holds ${String(SIGN_LINES)} lines of ${String(SIGN_LINE_LENGTH)} characters. ` +
  'Shorten the text, or put it on several signs (one call each).'

/** Only what a plain sign can show: no control characters and no `§` colour codes (colour and glow are not supported). */
const isBad = (line: string): boolean => {
  for (let index = 0; index < line.length; index += 1) {
    const code = line.charCodeAt(index)
    if (code < 0x20 || code === 0x7f || code === 0xa7) return true
  }
  return false
}

/** Wraps one paragraph into lines that fit; a single word longer than a line cannot be wrapped. */
function wrap(paragraph: string): Result<string[], SignTextProblem> {
  const lines: string[] = []
  let current = ''
  for (const word of paragraph.split(/\s+/).filter((part) => part !== '')) {
    if (word.length > SIGN_LINE_LENGTH)
      return err({
        reason: 'text_too_long',
        message: `The word "${word}" has ${String(word.length)} characters and does not fit on a line (${String(SIGN_LINE_LENGTH)} at most). ${HOW_TO_SPLIT}`,
      })
    if (current === '') current = word
    else if (current.length + 1 + word.length <= SIGN_LINE_LENGTH) current = `${current} ${word}`
    else {
      lines.push(current)
      current = word
    }
  }
  if (current !== '' || lines.length === 0) lines.push(current)
  return ok(lines)
}

const trimTrailingBlank = (lines: readonly string[]): string[] => {
  const kept = [...lines]
  while (kept.length > 0 && kept[kept.length - 1]?.trim() === '') kept.pop()
  return kept
}

/**
 * Turns what the agent gave into the lines of a sign. `lines` are taken as they are (each must fit); `text` is wrapped
 * on spaces, and its own line breaks are kept. Fails with `text_too_long` and how to split it. With `allowEmpty` a sign
 * may be cleared (every line blank).
 */
export function signLines(
  input: { readonly text?: string | undefined; readonly lines?: readonly string[] | undefined },
  allowEmpty = false,
): Result<string[], SignTextProblem> {
  let lines: string[]
  if (input.lines !== undefined) {
    if (input.lines.length > SIGN_LINES)
      return err({
        reason: 'text_too_long',
        message: `${String(input.lines.length)} lines were given. ${HOW_TO_SPLIT}`,
      })
    const tooLong = input.lines.find((line) => line.length > SIGN_LINE_LENGTH)
    if (tooLong !== undefined)
      return err({
        reason: 'text_too_long',
        message: `The line "${tooLong}" has ${String(tooLong.length)} characters (${String(SIGN_LINE_LENGTH)} at most). ${HOW_TO_SPLIT}`,
      })
    lines = [...input.lines]
  } else if (input.text !== undefined) {
    lines = []
    for (const paragraph of input.text.split('\n')) {
      const wrapped = wrap(paragraph)
      if (!wrapped.ok) return wrapped
      lines.push(...wrapped.value)
    }
    lines = trimTrailingBlank(lines)
    if (lines.length > SIGN_LINES)
      return err({
        reason: 'text_too_long',
        message: `The text needs ${String(lines.length)} lines once wrapped. ${HOW_TO_SPLIT}`,
      })
  } else return err({ reason: 'no_text', message: 'Give text or lines for the sign.' })

  if (lines.some(isBad))
    return err({
      reason: 'bad_text',
      message: 'Sign text may not contain control characters or "§" colour codes.',
    })
  lines = trimTrailingBlank(lines)
  if (lines.length === 0 && !allowEmpty)
    return err({ reason: 'no_text', message: 'The sign text is empty.' })
  while (lines.length < SIGN_LINES) lines.push('')
  return ok(lines)
}

/** Trailing blank lines do not count when comparing what was asked with what the sign shows. */
export const sameSignText = (a: readonly string[], b: readonly string[]): boolean =>
  trimTrailingBlank(a).join('\n') === trimTrailingBlank(b).join('\n')

/** The text as one string, for messages and matching. */
export const joinSignText = (lines: readonly string[]): string => trimTrailingBlank(lines).join(' ')
