import { z } from 'zod'
import type { TaskJournal } from '../../state/task-journal.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolContext, ToolDefinition, ToolResult } from '../tool.types.js'
import { MAX_TASK_WAIT_SECONDS } from './task-schema.js'

/** Runs a tool by name (used to start a task again the way it was first started). */
export type ToolInvoker = (name: string, args: unknown, context: ToolContext) => Promise<ToolResult>

const resumeSchema = z.object({
  id: z.string().min(1).describe('The job id from the briefing, for example "job-3".'),
  wait_seconds: z
    .number()
    .min(0)
    .max(MAX_TASK_WAIT_SECONDS)
    .optional()
    .describe('How long to wait, as for the original tool.'),
})

export class ResumeInterruptedTaskTool implements ToolDefinition<typeof resumeSchema> {
  readonly name = 'resume_interrupted_task'
  readonly description =
    'Starts an interrupted task again with the same tool and arguments, and marks the old job as resumed. Only do this ' +
    'after asking the player: the world may have changed since. Fails when the job is not interrupted, cannot be resumed ' +
    '(no way to restart it), or another task is running.'
  readonly inputSchema = resumeSchema

  constructor(
    private readonly journal: TaskJournal,
    private readonly invoke: ToolInvoker,
  ) {}

  async execute(input: z.output<typeof resumeSchema>, context: ToolContext) {
    const job = this.journal.get(input.id)
    if (job === undefined) return toolFail(`There is no job ${input.id}.`)
    if (job.status !== 'interrupted')
      return toolFail(`Job ${input.id} is ${job.status}, not interrupted.`)
    if (job.resume === null)
      return toolFail(
        `Job ${input.id} (${job.description}) cannot be resumed automatically: start it again by hand.`,
      )

    const args = {
      ...job.resume.arguments,
      ...(input.wait_seconds === undefined ? {} : { wait_seconds: input.wait_seconds }),
    }
    const result = await this.invoke(job.resume.tool, args, context)
    if (!result.ok) return result
    this.journal.markResumed(input.id)
    return toolOk({ resumed: input.id, task: result.data })
  }
}

const discardSchema = z.object({
  id: z.string().min(1).describe('The job id from the briefing, for example "job-3".'),
})

export class DiscardInterruptedTaskTool implements ToolDefinition<typeof discardSchema> {
  readonly name = 'discard_interrupted_task'
  readonly description =
    'Drops an interrupted task the player does not want to resume, so it stops appearing in the briefing.'
  readonly inputSchema = discardSchema

  constructor(private readonly journal: TaskJournal) {}

  execute(input: z.output<typeof discardSchema>) {
    const discarded = this.journal.discard(input.id)
    return discarded.ok ? toolOk({ discarded: input.id }) : toolFail(discarded.error)
  }
}
