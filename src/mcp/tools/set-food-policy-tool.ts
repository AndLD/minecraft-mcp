import { z } from 'zod'
import { LOW_FOOD_POLICIES, type FoodPolicy } from '../../state/food-policy.js'
import type { StandingInstructions } from '../../state/standing-instructions.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolDefinition } from '../tool.types.js'

const schema = z.object({
  policy: z
    .enum(LOW_FOOD_POLICIES)
    .describe(
      '"ask": tell the player and wait (the default). "hunt_and_cook": hunt animals and cook the meat by itself. "fish_and_cook": fish (needs a rod) and cook the fish by itself. "stop": cancel the current task.',
    ),
})

const STANDING_TEXT: Record<'hunt_and_cook' | 'fish_and_cook' | 'stop', string> = {
  hunt_and_cook: 'When the bot is out of food, it hunts animals and cooks the meat by itself.',
  fish_and_cook: 'When the bot is out of food, it fishes and cooks the fish by itself (it needs a fishing rod).',
  stop: 'When the bot is out of food, it cancels its current task and tells the player.',
}

export class SetFoodPolicyTool implements ToolDefinition<typeof schema> {
  readonly name = 'set_food_policy'
  readonly description =
    'Saves what the bot does when it is hungry and has nothing to eat, as a standing rule for this world: "ask" (default: ' +
    'you get a needs_decision event and ask the player), "hunt_and_cook" (the bot hunts by itself, no round trip), "fish_and_cook" (it fishes and bakes the fish; it needs a ' +
    'fishing rod), or "stop" ' +
    '(cancel the current task). Set it when the player says something like "if you run out of food, go hunt". It survives ' +
    'restarts and appears in the session briefing. Fails when no world is active.'
  readonly inputSchema = schema

  constructor(
    private readonly policy: FoodPolicy,
    private readonly standing: StandingInstructions,
  ) {}

  execute(input: z.output<typeof schema>) {
    const saved = this.policy.set(input.policy)
    if (!saved.ok) return toolFail(saved.error)
    // Mirrored as a standing instruction so the session briefing shows it.
    if (input.policy === 'ask') this.standing.remove('food_policy')
    else this.standing.set('food_policy', STANDING_TEXT[input.policy])
    return toolOk({ policy: input.policy })
  }
}
