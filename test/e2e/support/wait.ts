export interface WaitOptions {
  readonly timeoutMs?: number
  readonly intervalMs?: number
  /** Shown in the failure message. */
  readonly description?: string
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Polls until `check` returns something other than undefined/false, or fails after the timeout. */
export async function waitUntil<T>(
  check: () => T | undefined | false | Promise<T | undefined | false>,
  options: WaitOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const intervalMs = options.intervalMs ?? 200
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value !== undefined && value !== false) return value
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${String(timeoutMs)} ms waiting for ${options.description ?? 'a condition'}`,
      )
    }
    await pause(intervalMs)
  }
}

export { pause }
