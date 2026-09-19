import { z } from 'zod'
import { splitChatMessage } from '../../chat/split-message.js'
import type { ChatPort } from '../../core/chat.port.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolDefinition } from '../tool.types.js'

export const MAX_CHAT_LINES = 5

const schema = z.object({
  text: z
    .string()
    .min(1)
    .describe('What to say in public chat. Long text is split into several lines.'),
})

export class SayTool implements ToolDefinition<typeof schema> {
  readonly name = 'say'
  readonly description =
    `Says something in public in-game chat, visible to everyone. Long text is split into lines of at most 240 characters, ` +
    `and only the first ${String(MAX_CHAT_LINES)} lines are sent. Fails when the bot is not connected.`
  readonly inputSchema = schema

  constructor(private readonly chat: ChatPort) {}

  execute(input: z.output<typeof schema>) {
    const lines = splitChatMessage(input.text)
    const sending = lines.slice(0, MAX_CHAT_LINES)
    if (sending.length === 0) return toolFail('Nothing to say: the text is empty.')
    for (const line of sending) {
      const sent = this.chat.say(line)
      if (!sent.ok) return toolFail(sent.error)
    }
    return toolOk({ sent: sending.length, truncated: lines.length > sending.length })
  }
}
