import { z } from 'zod'
import type { SessionBriefingBuilder } from '../../state/session-briefing.js'
import type { WorldStateManager } from '../../state/world-state-manager.js'
import type { SessionService } from '../../session/session-service.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolDefinition } from '../tool.types.js'

const emptySchema = z.object({})

export class GetSessionBriefingTool implements ToolDefinition<typeof emptySchema> {
  readonly name = 'get_session_briefing'
  readonly description =
    'Summarizes what the bot remembers about the current world: which world profile is active and how it was recognized, ' +
    'when it was last joined, tasks that were interrupted, standing instructions, notes from earlier sessions, recent ' +
    'history, warnings, and what to do first (nextSteps). connect already returns it; call this again to refresh.'
  readonly inputSchema = emptySchema

  constructor(private readonly briefing: SessionBriefingBuilder) {}

  execute() {
    return toolOk(this.briefing.build())
  }
}

export class ListWorldsTool implements ToolDefinition<typeof emptySchema> {
  readonly name = 'list_worlds'
  readonly description =
    'Lists the Minecraft worlds the bot remembers (profiles), with when each was last joined, and which one is active.'
  readonly inputSchema = emptySchema

  constructor(private readonly worldState: WorldStateManager) {}

  async execute() {
    const worlds = await this.worldState.listWorlds()
    return toolOk({
      active: this.worldState.activeProfile ?? null,
      worlds: worlds.map((world) => ({
        profile: world.name,
        worldName: world.fingerprint.worldName,
        createdAt: world.createdAt,
        lastConnectedAt: world.lastConnectedAt,
      })),
    })
  }
}

const setSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe(
      'Name for this world, for example "survival1". It becomes a folder name: letters and digits are kept.',
    ),
})

export class SetWorldProfileTool implements ToolDefinition<typeof setSchema> {
  readonly name = 'set_world_profile'
  readonly description =
    'Tells the bot which saved world the connected world is (or names a new one). Use it when the briefing says the world ' +
    'could not be identified (ask the player for a name first), when several remembered worlds fit, or to rename. It ' +
    'binds the connected world to that profile and loads its notes, journal, and history. Fails when not connected.'
  readonly inputSchema = setSchema

  constructor(
    private readonly session: SessionService,
    private readonly briefing: SessionBriefingBuilder,
  ) {}

  async execute(input: z.output<typeof setSchema>) {
    const opened = await this.session.nameWorld(input.name)
    if (!opened.ok) return toolFail(opened.error)
    return toolOk({ profile: opened.value.profile, briefing: this.briefing.build() })
  }
}
