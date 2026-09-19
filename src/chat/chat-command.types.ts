import type { ChatMessage } from './chat-message.types.js'

/**
 * A fixed instruction handled by code before the message ever reaches the agent
 * (the agent is too slow for things like "stop").
 */
export interface ChatCommand {
  matches(message: Pick<ChatMessage, 'text'>): boolean
  /** Runs the command. Returns a short note that is shown to the agent as an event. */
  execute(): string
}
