import { z } from 'zod'
import type { SessionService } from '../../session/session-service.js'
import type { SessionBriefingBuilder } from '../../state/session-briefing.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolDefinition } from '../tool.types.js'

const schema = z.object({
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .describe('Server port. Omit to use MC_PORT or discover the LAN world.'),
  host: z
    .string()
    .min(1)
    .optional()
    .describe('Server host. Omit to use MC_HOST (default localhost).'),
  profile: z
    .string()
    .min(1)
    .optional()
    .describe(
      'A name for the world, used only when it cannot be recognized automatically (worlds are normally recognized by themselves).',
    ),
})

export class ConnectTool implements ToolDefinition<typeof schema> {
  readonly name = 'connect'
  readonly description =
    'Connects the bot to the Minecraft world and resolves when it has spawned. Without a port it uses MC_PORT, ' +
    'or listens for the LAN world announcement (the world must be opened to LAN). Fails with a reason if the world ' +
    'is unreachable, the version mismatches, or the bot is already connected. The reply includes the session briefing: ' +
    'which saved world this is, interrupted tasks, standing instructions, notes, and what to do first (nextSteps). ' +
    'Read it and tell the player what you found.'
  readonly inputSchema = schema

  constructor(
    private readonly session: SessionService,
    private readonly briefing: SessionBriefingBuilder,
  ) {}

  async execute(input: z.output<typeof schema>) {
    const result = await this.session.connect(input)
    if (!result.ok) return toolFail(result.error)
    const { world: _world, ...session } = result.value
    return toolOk({ connected: true, ...session, briefing: this.briefing.build() })
  }
}
