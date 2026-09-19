export interface ChatMessage {
  readonly sender: string
  readonly text: string
  readonly whisper: boolean
  /** Epoch milliseconds when the bot received it. */
  readonly receivedAt: number
}

/** Something that happened while the agent was not looking (connection changes, reflexes, tasks). */
export interface BotEvent {
  readonly type: string
  readonly message: string
  /** Epoch milliseconds. */
  readonly at: number
}

export interface InboxBatch {
  readonly messages: readonly ChatMessage[]
  readonly events: readonly BotEvent[]
  /** How many older items were discarded because the agent was not reading fast enough. */
  readonly dropped: number
}
