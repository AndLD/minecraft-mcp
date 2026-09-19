import type { Config } from './config/config.types.js'
import type { Clock } from './core/clock.port.js'
import type { Logger } from './core/logger.js'
import type { Random } from './core/random.port.js'
import { StderrLogger } from './infra/stderr-logger.js'
import { SystemClock } from './infra/system-clock.js'
import { SystemRandom } from './infra/system-random.js'

export interface AppDeps {
  readonly logger: Logger
  readonly clock: Clock
  readonly random: Random
}

export interface App extends AppDeps {
  readonly config: Config
}

/**
 * Composition root: the only place that wires concrete classes together.
 * Creating the app has no side effects (no I/O, no timers), so tests can build it with fakes.
 */
export function createApp(config: Config, overrides: Partial<AppDeps> = {}): App {
  const clock = overrides.clock ?? new SystemClock()
  const random = overrides.random ?? new SystemRandom()
  const logger = overrides.logger ?? new StderrLogger({ level: config.logLevel, clock })
  return { config, logger, clock, random }
}
