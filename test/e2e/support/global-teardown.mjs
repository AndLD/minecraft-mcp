// Jest global teardown for the e2e project: stops the server container. The server log stays in .e2e/.
import { rmSync } from 'node:fs'
import path from 'node:path'

const SERVER_INFO_PATH = path.resolve('.e2e/server.json')

export default async function globalTeardown() {
  await globalThis.__E2E_CONTAINER__?.stop({ timeout: 10_000 })
  globalThis.__E2E_CONTAINER__ = undefined
  rmSync(SERVER_INFO_PATH, { force: true })
  process.stderr.write('[e2e] server stopped\n')
}
