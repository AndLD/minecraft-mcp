import type { Clock } from '../core/clock.port.js'
import { LOG_LEVELS, type LogContext, type Logger, type LogLevel } from '../core/logger.js'

export interface StderrLoggerOptions {
  readonly level: LogLevel
  readonly clock: Clock
  /** Where lines go. Defaults to stderr; stdout is reserved for the MCP protocol. */
  readonly write?: (line: string) => void
}

/** Errors and bigints do not survive JSON.stringify by default. */
function serializeValue(_key: string, value: unknown): unknown {
  if (value instanceof Error)
    return { name: value.name, message: value.message, stack: value.stack }
  if (typeof value === 'bigint') return value.toString()
  return value
}

export class StderrLogger implements Logger {
  private readonly threshold: number
  private readonly clock: Clock
  private readonly write: (line: string) => void

  constructor(options: StderrLoggerOptions) {
    this.threshold = LOG_LEVELS.indexOf(options.level)
    this.clock = options.clock
    this.write = options.write ?? ((line) => process.stderr.write(line))
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context)
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context)
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context)
  }

  error(message: string, context?: LogContext): void {
    this.log('error', message, context)
  }

  private log(level: LogLevel, message: string, context?: LogContext): void {
    if (LOG_LEVELS.indexOf(level) < this.threshold) return
    const timestamp = new Date(this.clock.now()).toISOString()
    const suffix = context === undefined ? '' : ` ${JSON.stringify(context, serializeValue)}`
    this.write(`${timestamp} ${level.toUpperCase()} ${message}${suffix}\n`)
  }
}
