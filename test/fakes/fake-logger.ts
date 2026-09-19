import type { LogContext, Logger, LogLevel } from '../../src/core/logger.js'

export interface LogEntry {
  readonly level: LogLevel
  readonly message: string
  readonly context: LogContext | undefined
}

export class FakeLogger implements Logger {
  readonly entries: LogEntry[] = []

  debug(message: string, context?: LogContext): void {
    this.entries.push({ level: 'debug', message, context })
  }

  info(message: string, context?: LogContext): void {
    this.entries.push({ level: 'info', message, context })
  }

  warn(message: string, context?: LogContext): void {
    this.entries.push({ level: 'warn', message, context })
  }

  error(message: string, context?: LogContext): void {
    this.entries.push({ level: 'error', message, context })
  }
}
