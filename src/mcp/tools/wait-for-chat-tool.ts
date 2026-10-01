import { z } from 'zod'
import type { AgentInbox } from '../../chat/agent-inbox.js'
import type { Connection } from '../../core/connection.port.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'

export const MAX_WAIT_SECONDS = 55
export const DEFAULT_WAIT_SECONDS = 30

const schema = z.object({
  timeout_seconds: z
    .number()
    .min(1)
    .max(MAX_WAIT_SECONDS)
    .default(DEFAULT_WAIT_SECONDS)
    .describe(`How long to wait for something new, in seconds (1-${String(MAX_WAIT_SECONDS)}).`),
})

export class WaitForChatTool implements ToolDefinition<typeof schema> {
  readonly name = 'wait_for_chat'
  readonly description =
    'Waits until the player says something in game chat or something notable happens (connection lost, kicked, ..), ' +
    'then returns everything new: messages (sender, text, whisper flag) and events. Returns immediately if something is ' +
    'already waiting; otherwise returns after the timeout with timedOut=true, and you should simply call it again. ' +
    'This is how you listen to the player: call it in a loop. While the bot is trying to rejoin after a lost connection it keeps ' +
    'waiting (you get reconnecting, then reconnected or reconnect_failed). Fails when the bot is not connected, is not ' +
    'reconnecting, and nothing is pending.'
  readonly inputSchema = schema

  constructor(
    private readonly connection: Connection,
    private readonly inbox: AgentInbox,
    /** True while the bot is trying to rejoin after a lost connection: keep waiting, the news is coming. */
    private readonly reconnecting: () => boolean = () => false,
  ) {}

  async execute(input: z.output<typeof schema>, context: ToolContext) {
    if (
      this.connection.state === 'disconnected' &&
      this.inbox.pendingCount === 0 &&
      !this.reconnecting()
    ) {
      return toolFail('Not connected to a Minecraft world. Call connect first.')
    }
    const result = await this.inbox.wait(input.timeout_seconds * 1000, context.signal)
    return toolOk({
      timedOut: result.timedOut,
      messages: result.messages.map((m) => ({
        sender: m.sender,
        text: m.text,
        whisper: m.whisper,
        at: new Date(m.receivedAt).toISOString(),
      })),
      events: result.events.map((e) => ({
        type: e.type,
        message: e.message,
        at: new Date(e.at).toISOString(),
      })),
      dropped: result.dropped,
    })
  }
}
