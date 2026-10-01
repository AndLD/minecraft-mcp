import { z } from 'zod'
import { splitChatMessage } from '../../chat/split-message.js'
import type { ChatPort } from '../../core/chat.port.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolDefinition } from '../tool.types.js'
import { MAX_CHAT_LINES } from './say-tool.js'

const schema = z.object({
  player: z.string().min(1).describe('Exact in-game name of the player.'),
  text: z.string().min(1).describe('The private message. Long text is split into several lines.'),
})

export class WhisperTool implements ToolDefinition<typeof schema> {
  readonly name = 'whisper'
  readonly description =
    'Sends a private in-game message to one player, visible only to them. Long text is split into lines of at most ' +
    `240 characters, and only the first ${String(MAX_CHAT_LINES)} lines are sent. Fails when the bot is not connected.`
  readonly inputSchema = schema

  constructor(private readonly chat: ChatPort) {}

  execute(input: z.output<typeof schema>) {
    const sending = splitChatMessage(input.text).slice(0, MAX_CHAT_LINES)
    if (sending.length === 0) return toolFail('Nothing to say: the text is empty.')
    for (const line of sending) {
      const sent = this.chat.whisper(input.player, line)
      if (!sent.ok) return toolFail(sent.error)
    }
    return toolOk({ sent: sending.length, player: input.player })
  }
}
