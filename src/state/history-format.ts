import type { ToolCall } from '../mcp/tool-registry.js'

/** Read-only tools: calling them changes nothing, so they would only clutter the history. */
export const HISTORY_IGNORED_TOOLS: ReadonlySet<string> = new Set([
  'wait_for_chat',
  'get_status',
  'get_task_status',
  'get_session_briefing',
  'get_recent_history',
  'list_worlds',
  'recall',
  'look_around',
  'find_blocks',
  'get_nearby_entities',
  'get_player_position',
  'get_inventory',
])

/** One line for the history log, or undefined when the call is not worth recording. */
export function describeToolCall(call: ToolCall): string | undefined {
  if (HISTORY_IGNORED_TOOLS.has(call.name)) return undefined
  const args = JSON.stringify(call.args ?? {})
  const outcome = call.result.ok ? 'ok' : `failed: ${call.result.error}`
  return `${call.name}(${args === '{}' ? '' : args}) → ${outcome}`
}
