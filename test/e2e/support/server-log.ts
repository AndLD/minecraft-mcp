import { readFileSync } from 'node:fs'
import { SERVER_LOG_PATH } from './server-config.js'
import { waitUntil } from './wait.js'

/** Reads the Minecraft server log that the global setup streams to `.e2e/server.log`. */
export const serverLog = {
  text(): string {
    try {
      return readFileSync(SERVER_LOG_PATH, 'utf8')
    } catch {
      return ''
    }
  },

  /** A marker for "now": pass it to `waitFor` to ignore everything logged before. */
  mark(): number {
    return this.text().length
  },

  /** Waits for a log line matching the pattern, appearing after `since`. */
  async waitFor(pattern: RegExp, since = 0, timeoutMs = 10_000): Promise<string> {
    return waitUntil(() => pattern.exec(this.text().slice(since))?.[0], {
      timeoutMs,
      description: `server log line ${String(pattern)}`,
    })
  },
}
