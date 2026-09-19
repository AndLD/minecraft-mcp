import { z } from 'zod'
import { LOG_LEVELS } from '../core/logger.js'
import { err, ok, type Result } from '../core/result.js'
import type { Config } from './config.types.js'

const envBoolean = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1')

const envSchema = z.object({
  MC_HOST: z.string().default('localhost'),
  MC_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  MC_VERSION: z.string().default('1.21.1'),
  MC_USERNAME: z.string().min(1).max(16).default('ClaudeBot'),
  MC_AUTH: z.enum(['offline', 'microsoft']).default('offline'),
  MC_OWNER: z.string().optional(),
  MC_AUTO_CONNECT: envBoolean.default(false),
  DATA_DIR: z.string().default('./data'),
  WORLD_PROFILE: z.string().optional(),
  LOW_HEALTH_THRESHOLD: z.coerce.number().int().min(1).max(20).default(8),
  REFLEXES_ENABLED: envBoolean.default(true),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
})

export interface ConfigError {
  /** One human-readable line per problem, for example `MC_PORT: Too big`. */
  readonly issues: readonly string[]
}

/** An empty value in `.env` (`MC_OWNER=`) means "not set". */
function withoutEmptyValues(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== '') result[key] = value.trim()
  }
  return result
}

export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
): Result<Config, ConfigError> {
  const parsed = envSchema.safeParse(withoutEmptyValues(env))
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    return err({ issues })
  }
  const e = parsed.data
  return ok({
    host: e.MC_HOST,
    port: e.MC_PORT,
    version: e.MC_VERSION,
    username: e.MC_USERNAME,
    auth: e.MC_AUTH,
    owner: e.MC_OWNER,
    autoConnect: e.MC_AUTO_CONNECT,
    dataDir: e.DATA_DIR,
    worldProfile: e.WORLD_PROFILE,
    lowHealthThreshold: e.LOW_HEALTH_THRESHOLD,
    reflexesEnabled: e.REFLEXES_ENABLED,
    logLevel: e.LOG_LEVEL,
  })
}
