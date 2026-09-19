import { describe, expect, it } from '@jest/globals'
import { z } from 'zod'
import { ToolRegistry } from '../../../src/mcp/tool-registry.js'
import { toolOk } from '../../../src/mcp/tool-result.js'
import type { ToolContext, ToolDefinition } from '../../../src/mcp/tool.types.js'
import { FakeLogger } from '../../fakes/fake-logger.js'

const context: ToolContext = { signal: new AbortController().signal }

const echoSchema = z.object({ text: z.string(), times: z.number().int().default(1) })

const echoTool: ToolDefinition<typeof echoSchema> = {
  name: 'echo',
  description: 'Echoes text.',
  inputSchema: echoSchema,
  execute: (input) => toolOk(input.text.repeat(input.times)),
}

describe('ToolRegistry', () => {
  it('lists registered tools', () => {
    const registry = new ToolRegistry(new FakeLogger()).register(echoTool)

    expect(registry.list().map((t) => t.name)).toEqual(['echo'])
  })

  it('rejects a duplicate name', () => {
    const registry = new ToolRegistry(new FakeLogger()).register(echoTool)

    expect(() => registry.register(echoTool)).toThrow('Tool already registered: echo')
  })

  it('validates arguments, applies defaults, and runs the tool', async () => {
    const registry = new ToolRegistry(new FakeLogger()).register(echoTool)

    expect(await registry.call('echo', { text: 'ab', times: 2 }, context)).toEqual({
      ok: true,
      data: 'abab',
    })
    expect(await registry.call('echo', { text: 'ab' }, context)).toEqual({ ok: true, data: 'ab' })
  })

  it('treats missing arguments as an empty object', async () => {
    const registry = new ToolRegistry(new FakeLogger()).register({
      name: 'ping',
      description: 'Pings.',
      inputSchema: z.object({}),
      execute: () => toolOk('pong'),
    })

    expect(await registry.call('ping', undefined, context)).toEqual({ ok: true, data: 'pong' })
  })

  it('returns a readable error for invalid arguments without running the tool', async () => {
    const registry = new ToolRegistry(new FakeLogger()).register(echoTool)

    const result = await registry.call('echo', { text: 5 }, context)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/^Invalid arguments for echo: text:/)
  })

  it('labels a problem with the whole input', async () => {
    const registry = new ToolRegistry(new FakeLogger()).register(echoTool)

    const result = await registry.call('echo', 'nonsense', context)

    expect(!result.ok && result.error).toMatch(/^Invalid arguments for echo: input:/)
  })

  it('returns an error for an unknown tool', async () => {
    const registry = new ToolRegistry(new FakeLogger())

    expect(await registry.call('nope', {}, context)).toEqual({
      ok: false,
      error: 'Unknown tool: nope',
    })
  })

  it('turns a crashing tool into an error result and logs it', async () => {
    const logger = new FakeLogger()
    const registry = new ToolRegistry(logger).register({
      name: 'crash',
      description: 'Crashes.',
      inputSchema: z.object({}),
      execute: () => {
        throw new Error('bug')
      },
    })

    const result = await registry.call('crash', {}, context)

    expect(result).toEqual({ ok: false, error: 'Internal error in crash: bug' })
    expect(logger.entries.map((e) => e.level)).toEqual(['error'])
  })

  it('reports non-Error throws too', async () => {
    const registry = new ToolRegistry(new FakeLogger()).register({
      name: 'weird',
      description: 'Throws a string.',
      inputSchema: z.object({}),
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection is the case under test
      execute: () => Promise.reject('just a string'),
    })

    expect(await registry.call('weird', {}, context)).toEqual({
      ok: false,
      error: 'Internal error in weird: just a string',
    })
  })
})
