import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { StderrLogger } from '../../../src/infra/stderr-logger.js'
import { FakeClock } from '../../fakes/fake-clock.js'

const EPOCH_2026 = Date.UTC(2026, 8, 19, 12, 0, 0)

function setup(level: 'debug' | 'info' | 'warn' | 'error' = 'info') {
  const lines: string[] = []
  const logger = new StderrLogger({
    level,
    clock: new FakeClock(EPOCH_2026),
    write: (line) => lines.push(line),
  })
  return { logger, lines }
}

describe('StderrLogger', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('formats timestamp, level, and message on one line', () => {
    const { logger, lines } = setup()
    logger.info('hello')
    expect(lines).toEqual(['2026-09-19T12:00:00.000Z INFO hello\n'])
  })

  it('appends the context as JSON', () => {
    const { logger, lines } = setup()
    logger.warn('careful', { port: 34231 })
    expect(lines).toEqual(['2026-09-19T12:00:00.000Z WARN careful {"port":34231}\n'])
  })

  it('serializes errors and bigints inside the context', () => {
    const { logger, lines } = setup()
    logger.error('failed', { cause: new Error('boom'), big: 10n })
    const line = lines[0] ?? ''
    expect(line).toContain('"message":"boom"')
    expect(line).toContain('"name":"Error"')
    expect(line).toContain('"big":"10"')
  })

  it.each([
    ['debug', ['debug', 'info', 'warn', 'error']],
    ['info', ['info', 'warn', 'error']],
    ['warn', ['warn', 'error']],
    ['error', ['error']],
  ] as const)('with level %s emits %j', (level, expected) => {
    const { logger, lines } = setup(level)
    logger.debug('m')
    logger.info('m')
    logger.warn('m')
    logger.error('m')
    const emitted = lines.map((line) => line.split(' ')[1]?.toLowerCase())
    expect(emitted).toEqual(expected)
  })

  it('writes to stderr and never to stdout by default', () => {
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
    const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
    const logger = new StderrLogger({ level: 'debug', clock: new FakeClock(EPOCH_2026) })
    logger.debug('a')
    logger.info('b')
    logger.warn('c')
    logger.error('d')
    expect(stderr).toHaveBeenCalledTimes(4)
    expect(stdout).not.toHaveBeenCalled()
  })
})
