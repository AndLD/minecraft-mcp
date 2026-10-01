import { readFileSync } from 'node:fs'
import { describe, expect, it } from '@jest/globals'
import { SERVER_NAME, SERVER_VERSION } from '../../../src/mcp/server-info.js'

describe('server info', () => {
  it('has the same version as package.json', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      version: string
      name: string
    }

    expect(SERVER_VERSION).toBe(pkg.version)
    expect(SERVER_NAME).toBe(pkg.name)
  })
})
