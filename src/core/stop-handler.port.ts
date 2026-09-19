/** Cancels whatever the bot is doing. Implemented by the task manager once tasks exist. */
export interface StopHandler {
  stopAll(): void
}
