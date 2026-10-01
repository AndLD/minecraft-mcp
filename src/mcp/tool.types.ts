import type { z } from 'zod'

export interface ToolContext {
  /** Aborted when the client cancels the request. */
  readonly signal: AbortSignal
}

/** Expected failures are values; exceptions are for bugs. */
export type ToolResult =
  { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly error: string }

export interface ToolDefinition<Schema extends z.ZodType = z.ZodType> {
  /** snake_case, verb first. */
  readonly name: string
  /** Written for an LLM reader: what it does, units, failure modes. */
  readonly description: string
  readonly inputSchema: Schema
  execute(input: z.output<Schema>, context: ToolContext): Promise<ToolResult> | ToolResult
}
