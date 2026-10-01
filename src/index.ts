import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createApp } from './app.js'
import { loadConfig } from './config/env.js'

function loadDotEnv(): void {
  try {
    process.loadEnvFile('.env')
  } catch {
    // No .env file: rely on the process environment and defaults.
  }
}

async function main(): Promise<void> {
  loadDotEnv()
  const config = loadConfig(process.env)
  if (!config.ok) {
    process.stderr.write(
      `Invalid configuration:\n${config.error.issues.map((i) => `  ${i}`).join('\n')}\n`,
    )
    process.exit(1)
  }

  const app = createApp(config.value)
  const shutdown = (): void => {
    void app.shutdown().finally(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  await app.serve(new StdioServerTransport())
  app.logger.info('minecraft-mcp is serving over stdio', { tools: app.registry.list().length })

  if (config.value.autoConnect) {
    const result = await app.session.connect()
    if (result.ok) app.logger.info('Auto-connected', { ...result.value })
    else app.logger.warn('Auto-connect failed', { reason: result.error })
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exit(1)
})
