import { z } from 'zod'
import type { Connection } from '../../core/connection.port.js'
import { toolOk } from '../tool-result.js'
import type { ToolDefinition } from '../tool.types.js'

const schema = z.object({})

export class DisconnectTool implements ToolDefinition<typeof schema> {
  readonly name = 'disconnect'
  readonly description =
    'Disconnects the bot from the Minecraft world. Safe to call when not connected.'
  readonly inputSchema = schema

  constructor(private readonly connection: Connection) {}

  async execute() {
    const wasConnected = this.connection.state !== 'disconnected'
    await this.connection.disconnect()
    return toolOk({ disconnected: true, wasConnected })
  }
}
