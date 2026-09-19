import type { ToolResult } from './tool.types.js'

export const toolOk = (data: unknown): ToolResult => ({ ok: true, data })

export const toolFail = (error: string): ToolResult => ({ ok: false, error })
