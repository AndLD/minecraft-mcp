import type { Scheduler } from '../../core/scheduler.port.js'
import type { LowFoodPolicy } from '../../state/food-policy.js'

/** Time to let the eating reflex finish before a hunt starts (a task cannot start while a reflex acts). */
const START_DELAY_MS = 2_000

export interface LowFoodDeps {
  readonly policy: { get(): LowFoodPolicy }
  /** Puts an event into the agent's inbox. */
  emit(type: string, message: string): void
  /** Starts the standing hunt. Resolves with what happened. */
  startHunt(): Promise<{ readonly ok: boolean; readonly message: string }>
  /** Cancels the running task. */
  stopTask(): Promise<void>
  readonly scheduler: Scheduler
}

/**
 * Applies the player's low-food policy when the bot is hungry with nothing to eat. It runs as plain code (no agent
 * round trip) for the policies that allow it, and asks the agent, through an event, when the player has not decided.
 */
export class LowFoodResponder {
  constructor(private readonly deps: LowFoodDeps) {}

  respond(): void {
    const { deps } = this
    switch (deps.policy.get()) {
      case 'ask':
        deps.emit(
          'needs_decision',
          'The bot is hungry and has nothing to eat. Ask the player: hunt animals and cook the meat (hunt_animals with cook), ' +
            'or stop? If they say to always hunt when food runs out, call set_food_policy with hunt_and_cook.',
        )
        return
      case 'stop':
        void deps.stopTask().then(() => {
          deps.emit(
            'reflex',
            'Out of food, and the food policy is "stop": the current task was cancelled. Tell the player.',
          )
        })
        return
      case 'hunt_and_cook':
        deps.scheduler.after(START_DELAY_MS, () => {
          void deps.startHunt().then((started) => {
            deps.emit(
              'reflex',
              started.ok
                ? 'Out of food: started hunting animals and cooking the meat, as the food policy says.'
                : `Out of food, but hunting could not start: ${started.message}`,
            )
          })
        })
    }
  }
}
