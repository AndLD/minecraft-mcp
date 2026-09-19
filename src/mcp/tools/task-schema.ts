import { z } from 'zod'

export const MAX_TASK_WAIT_SECONDS = 55

/** Options shared by every tool that starts a long task. */
export const taskOptionsShape = {
  wait_seconds: z
    .number()
    .min(0)
    .max(MAX_TASK_WAIT_SECONDS)
    .optional()
    .describe(
      `How long to wait for the task to finish, in seconds (0-${String(MAX_TASK_WAIT_SECONDS)}). If it is not done by then the reply has status "running": poll get_task_status.`,
    ),
  replace: z
    .boolean()
    .default(false)
    .describe(
      'Cancel the task that is currently running and start this one instead. Without it, a running task blocks new ones.',
    ),
}
