import { createApp } from './app.js'
import { loadConfig } from './config/env.js'

function loadDotEnv(): void {
  try {
    process.loadEnvFile('.env')
  } catch {
    // No .env file: rely on the process environment and defaults.
  }
}

loadDotEnv()
const config = loadConfig(process.env)
if (!config.ok) {
  process.stderr.write(
    `Invalid configuration:\n${config.error.issues.map((i) => `  ${i}`).join('\n')}\n`,
  )
  process.exit(1)
}

const app = createApp(config.value)
app.logger.info('minecraft-mcp scaffold ready', {
  host: config.value.host,
  port: config.value.port ?? 'auto-discover',
  version: config.value.version,
})
