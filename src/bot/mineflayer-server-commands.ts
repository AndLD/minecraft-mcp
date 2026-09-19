import type { Result } from '../core/result.js'
import { err, ok } from '../core/result.js'
import type { Scheduler } from '../core/scheduler.port.js'
import type {
  CommandFailure,
  CommandOptions,
  CommandOutcome,
  ServerCommands,
} from '../core/server-commands.port.js'
import type { BotHolder } from './bot-like.types.js'
import { classifyReply } from './command-reply.js'

const DEFAULT_REPLY_WAIT_MS = 1_500

export class MineflayerServerCommands implements ServerCommands {
  constructor(
    private readonly holder: BotHolder,
    private readonly scheduler: Scheduler,
  ) {}

  available(command: string): boolean | undefined {
    const names = this.holder.current()?.commandNames
    return names === undefined ? undefined : names.includes(command)
  }

  run(command: string, options: CommandOptions): Promise<Result<CommandOutcome, CommandFailure>> {
    const bot = this.holder.current()
    if (bot === undefined)
      return Promise.resolve(
        err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' }),
      )
    if (options.signal.aborted)
      return Promise.resolve(err({ reason: 'aborted', message: 'Cancelled.' }))

    const name = command.split(' ')[0] ?? command
    return new Promise((resolve) => {
      let cancelTimer = (): void => undefined
      const finish = (result: Result<CommandOutcome, CommandFailure>): void => {
        cancelTimer()
        bot.removeListener('messagestr', onMessage)
        options.signal.removeEventListener('abort', onAbort)
        resolve(result)
      }
      // Other players' chat lines look like "<name> text"; the server's answer to a command does not.
      const onMessage = (message: string): void => {
        if (message.startsWith('<')) return
        finish(ok(classifyReply(message, this.available(name))))
      }
      const onAbort = (): void => {
        finish(err({ reason: 'aborted', message: 'Cancelled.' }))
      }
      bot.on('messagestr', onMessage)
      options.signal.addEventListener('abort', onAbort, { once: true })
      cancelTimer = this.scheduler.after(options.timeoutMs ?? DEFAULT_REPLY_WAIT_MS, () => {
        finish(ok({ kind: 'sent' }))
      })
      bot.chat(`/${command}`)
    })
  }
}
