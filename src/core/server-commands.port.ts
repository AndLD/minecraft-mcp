import type { Result } from './result.js'

/**
 * What the server answered to a command. `sent`: no reply came in time (the server may have commands feedback turned
 * off), so the caller has to check the effect itself.
 */
export type CommandOutcome =
  | { readonly kind: 'ok'; readonly reply: string }
  | { readonly kind: 'no_permission'; readonly reply: string }
  | { readonly kind: 'unknown_command'; readonly reply: string }
  | { readonly kind: 'error'; readonly reply: string }
  | { readonly kind: 'sent' }

export interface CommandFailure {
  readonly reason: 'aborted' | 'not_connected'
  readonly message: string
}

export interface CommandOptions {
  readonly signal: AbortSignal
  /** How long to wait for the server's reply. */
  readonly timeoutMs?: number
}

/** Server commands typed by the bot itself (`/tp`, ...). They only work when the server lets the bot use them. */
export interface ServerCommands {
  /**
   * Whether the server offers the bot this command. The server sends the commands a player may use when it joins (and
   * again when operator rights change), so a command that is missing is one the bot may not run. Undefined while the
   * list has not arrived.
   */
  available(command: string): boolean | undefined
  /** Sends the command (without the leading slash) and waits, bounded, for the server's reply. */
  run(command: string, options: CommandOptions): Promise<Result<CommandOutcome, CommandFailure>>
}
