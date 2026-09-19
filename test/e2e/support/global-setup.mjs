// Jest global setup for the e2e project: starts ONE Minecraft server container for the whole run.
// Plain .mjs on purpose: Jest loads global setup through Node's own module loader, which cannot resolve
// this project's `.js` -> `.ts` imports. Keep the constants below in sync with server-config.ts.
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { GenericContainer, Wait } from 'testcontainers'

const IMAGE = 'itzg/minecraft-server:java21'
const MINECRAFT_PORT = 25565
const RCON_PORT = 25575
const E2E_DIR = path.resolve('.e2e')
const SERVER_INFO_PATH = path.join(E2E_DIR, 'server.json')
const SERVER_LOG_PATH = path.join(E2E_DIR, 'server.log')
const ENV_PATH = path.resolve('docker/e2e-server.env')
const CONFIG_DIR = path.resolve('docker/config')
const STARTUP_TIMEOUT_MS = 5 * 60_000

/** Parses docker/e2e-server.env (KEY=VALUE lines, `#` comments). */
function readEnvironment() {
  const environment = {}
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator > 0) environment[trimmed.slice(0, separator)] = trimmed.slice(separator + 1)
  }
  return environment
}

export default async function globalSetup() {
  mkdirSync(E2E_DIR, { recursive: true })
  const environment = readEnvironment()
  const log = createWriteStream(SERVER_LOG_PATH)

  process.stderr.write(
    `\n[e2e] starting ${IMAGE} (the first run downloads the image and Paper)...\n`,
  )
  let container
  try {
    container = await new GenericContainer(IMAGE)
      .withEnvironment(environment)
      .withExposedPorts(MINECRAFT_PORT, RCON_PORT)
      // itzg copies /config into the server directory before starting.
      .withCopyFilesToContainer([
        { source: path.join(CONFIG_DIR, 'bukkit.yml'), target: '/config/bukkit.yml' },
      ])
      .withLogConsumer((stream) => {
        stream.pipe(log)
      })
      .withWaitStrategy(Wait.forLogMessage(/Done \(\d/))
      .withStartupTimeout(STARTUP_TIMEOUT_MS)
      .start()
  } catch (error) {
    throw new Error(
      `Could not start the e2e Minecraft server. E2E tests need Docker running (${error instanceof Error ? error.message : String(error)}). Server log: ${SERVER_LOG_PATH}`,
      { cause: error },
    )
  }

  globalThis.__E2E_CONTAINER__ = container
  const info = {
    host: container.getHost(),
    minecraftPort: container.getMappedPort(MINECRAFT_PORT),
    rconPort: container.getMappedPort(RCON_PORT),
    rconPassword: environment.RCON_PASSWORD ?? '',
  }
  writeFileSync(SERVER_INFO_PATH, JSON.stringify(info))
  process.stderr.write(
    `[e2e] server ready on ${info.host}:${String(info.minecraftPort)} (log: ${SERVER_LOG_PATH})\n`,
  )
}
