import { z } from 'zod'
import type { AgentInbox } from '../../chat/agent-inbox.js'
import type { Connection } from '../../core/connection.port.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import { toolOk } from '../tool-result.js'
import type { ToolDefinition } from '../tool.types.js'

const schema = z.object({})

export class GetStatusTool implements ToolDefinition<typeof schema> {
  readonly name = 'get_status'
  readonly description =
    'Reports the connection state (disconnected, connecting, connected), the server target, and, when connected, ' +
    'the bot health (0-20), food (0-20), position (x, y, z in blocks), dimension, and time of day (ticks, 0-23999). ' +
    'Also reports how many chat messages and events are waiting for wait_for_chat, and whether the survival reflexes ' +
    '(auto-eat, fighting, fleeing, avoiding lava) are enabled and which one is acting right now.'
  readonly inputSchema = schema

  constructor(
    private readonly connection: Connection,
    private readonly vitals: VitalsReader,
    private readonly inbox: AgentInbox,
    private readonly reflexes?: { readonly enabled: boolean; activeReflex(): string | undefined },
  ) {}

  execute() {
    const target = this.connection.target
    return toolOk({
      state: this.connection.state,
      target:
        target === undefined
          ? null
          : {
              host: target.host,
              port: target.port,
              username: target.username,
              version: target.version,
            },
      vitals: this.vitals.read() ?? null,
      pendingInbox: this.inbox.pendingCount,
      reflexes:
        this.reflexes === undefined
          ? null
          : { enabled: this.reflexes.enabled, active: this.reflexes.activeReflex() ?? null },
    })
  }
}
