import { err, ok, type Result } from '../../src/core/result.js'
import type {
  CommandFailure,
  CommandOptions,
  CommandOutcome,
  ServerCommands,
} from '../../src/core/server-commands.port.js'

/** Commands the server offers, and the replies it gives; what the bot sent is recorded. */
export class FakeServerCommands implements ServerCommands {
  /** Undefined: the list has not arrived. */
  offered: string[] | undefined = ['tp', 'gamemode']
  readonly sent: string[] = []
  /** Replies handed out in order; when empty, a plain success. */
  outcomes: Result<CommandOutcome, CommandFailure>[] = []
  /** Runs when a command is sent, so a test can move the bot like the server would. */
  onRun: (command: string) => void = () => undefined

  available(command: string): boolean | undefined {
    return this.offered === undefined ? undefined : this.offered.includes(command)
  }

  run(command: string, options: CommandOptions): Promise<Result<CommandOutcome, CommandFailure>> {
    this.sent.push(command)
    if (options.signal.aborted)
      return Promise.resolve(err({ reason: 'aborted', message: 'Cancelled.' }))
    this.onRun(command)
    return Promise.resolve(this.outcomes.shift() ?? ok({ kind: 'ok', reply: 'Teleported' }))
  }
}
