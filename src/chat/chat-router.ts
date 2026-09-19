import type { IncomingChat } from '../core/chat.port.js'
import type { Logger } from '../core/logger.js'
import type { AgentInbox } from './agent-inbox.js'
import type { ChatCommand } from './chat-command.types.js'

export interface ChatRouterOptions {
  readonly inbox: AgentInbox
  readonly logger: Logger
  readonly commands: readonly ChatCommand[]
  /** When set, only this player's messages count as instructions (case-insensitive). */
  readonly owner: string | undefined
}

/** Decides what happens to an incoming chat message: ignore, run a fixed command, or hand it to the agent. */
export class ChatRouter {
  private readonly inbox: AgentInbox
  private readonly logger: Logger
  private readonly commands: readonly ChatCommand[]
  private readonly owner: string | undefined

  constructor(options: ChatRouterOptions) {
    this.inbox = options.inbox
    this.logger = options.logger
    this.commands = options.commands
    this.owner = options.owner?.toLowerCase()
  }

  handle(message: IncomingChat): void {
    if (this.owner !== undefined && message.sender.toLowerCase() !== this.owner) {
      this.logger.debug('Ignoring chat from a non-owner', { sender: message.sender })
      return
    }
    const command = this.commands.find((candidate) => candidate.matches(message))
    if (command !== undefined) {
      this.inbox.pushEvent({ type: 'command', message: command.execute() })
      return
    }
    this.inbox.pushMessage(message)
  }
}
