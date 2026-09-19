import type { StopHandler } from '../core/stop-handler.port.js'
import type { ChatCommand } from './chat-command.types.js'

const STOP_PATTERN = /^!?stop[.!]*$/i

export class StopCommand implements ChatCommand {
  constructor(private readonly handler: StopHandler) {}

  matches(message: { readonly text: string }): boolean {
    return STOP_PATTERN.test(message.text.trim())
  }

  execute(): string {
    this.handler.stopAll()
    return 'The owner said "stop": everything was cancelled.'
  }
}
