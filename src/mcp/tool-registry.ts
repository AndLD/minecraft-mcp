import type { Logger } from '../core/logger.js'
import { toolFail } from './tool-result.js'
import type { ToolContext, ToolDefinition, ToolResult } from './tool.types.js'

export interface ToolCall {
  readonly name: string
  readonly args: unknown
  readonly result: ToolResult
}

export interface ToolRegistryOptions {
  /** Called after every tool call finishes (used for the history log). */
  readonly onCall?: (call: ToolCall) => void
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()

  constructor(
    private readonly logger: Logger,
    private readonly options: ToolRegistryOptions = {},
  ) {}

  /** Registering the same name twice is a programming error. */
  register(tool: ToolDefinition): this {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`)
    this.tools.set(tool.name, tool)
    return this
  }

  list(): readonly ToolDefinition[] {
    return [...this.tools.values()]
  }

  async call(name: string, args: unknown, context: ToolContext): Promise<ToolResult> {
    const result = await this.run(name, args, context)
    this.options.onCall?.({ name, args, result })
    return result
  }

  private async run(name: string, args: unknown, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (tool === undefined) return toolFail(`Unknown tool: ${name}`)

    const parsed = tool.inputSchema.safeParse(args ?? {})
    if (!parsed.success) {
      const problems = parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`,
      )
      return toolFail(`Invalid arguments for ${name}: ${problems.join('; ')}`)
    }
    try {
      return await tool.execute(parsed.data, context)
    } catch (error) {
      this.logger.error('Tool crashed', { tool: name, error })
      return toolFail(
        `Internal error in ${name}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
