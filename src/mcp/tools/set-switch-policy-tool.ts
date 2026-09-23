import { z } from 'zod'
import { SWITCH_OPEN_POLICIES, type SwitchPolicy } from '../../state/switch-policy.js'
import type { StandingInstructions } from '../../state/standing-instructions.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolDefinition } from '../tool.types.js'

const schema = z.object({
  policy: z
    .enum(SWITCH_OPEN_POLICIES)
    .describe(
      '"auto" (default): the bot finds and presses a nearby switch itself. "ask": report the switches found near ' +
        'an iron door and wait for the player before trying them. "never": always report the door as needing a ' +
        'switch, untried.',
    ),
})

const STANDING_TEXT: Record<'ask' | 'never', string> = {
  ask: 'When a walk meets an iron door, the bot reports the switches found and waits before trying them.',
  never: 'When a walk meets an iron door, the bot never tries a switch; it reports the door and waits.',
}

export class SetSwitchPolicyTool implements ToolDefinition<typeof schema> {
  readonly name = 'set_switch_policy'
  readonly description =
    'Saves what the bot does when a walk (goto, and anything else that navigates) meets a closed iron door, as a ' +
    'standing rule for this world: "auto" (default), "ask", or "never". Set it when the player says something like ' +
    '"ask me before going through iron doors" or "never press switches without asking me first". It survives ' +
    'restarts and appears in the session briefing. Fails when no world is active.'
  readonly inputSchema = schema

  constructor(
    private readonly policy: SwitchPolicy,
    private readonly standing: StandingInstructions,
  ) {}

  execute(input: z.output<typeof schema>) {
    const saved = this.policy.set(input.policy)
    if (!saved.ok) return toolFail(saved.error)
    // Mirrored as a standing instruction so the session briefing shows it.
    if (input.policy === 'auto') this.standing.remove('switch_policy')
    else this.standing.set('switch_policy', STANDING_TEXT[input.policy])
    return toolOk({ policy: input.policy })
  }
}
