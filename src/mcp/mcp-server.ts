import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SERVER_NAME, SERVER_VERSION } from './server-info.js'
import type { ToolRegistry } from './tool-registry.js'

/** Exposes every tool in the registry over MCP. */
export function createMcpServer(registry: ToolRegistry): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })

  for (const tool of registry.list()) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args, extra) => {
        const result = await registry.call(tool.name, args, { signal: extra.signal })
        if (result.ok) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
          }
        }
        return { isError: true, content: [{ type: 'text' as const, text: result.error }] }
      },
    )
  }

  return server
}
