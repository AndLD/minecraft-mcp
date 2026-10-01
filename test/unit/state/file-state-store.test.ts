import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals'
import { z } from 'zod'
import { defineDocument } from '../../../src/state/define-document.js'
import { FileStateStore } from '../../../src/state/file-state-store.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { FakeLogger } from '../../fakes/fake-logger.js'
import { FakeScheduler } from '../../fakes/fake-scheduler.js'

const counter = defineDocument({
  key: 'counter',
  version: 1,
  schema: z.object({ count: z.number() }),
  initial: () => ({ count: 0 }),
})

let directory: string

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'minecraft-mcp-store-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function setup(dir = directory) {
  const scheduler = new FakeScheduler(new FakeClock(0))
  const logger = new FakeLogger()
  const store = new FileStateStore({ directory: dir, scheduler, logger, debounceMs: 500 })
  return { store, scheduler, logger }
}

const file = (name: string): string => path.join(directory, name)
const read = (name: string): string => readFileSync(file(name), 'utf8')
const dataOf = (name: string): unknown => (JSON.parse(read(name)) as { data: unknown }).data

describe('FileStateStore', () => {
  describe('loading', () => {
    it('gives the defaults, without a warning, when nothing was saved', async () => {
      const loaded = await setup().store.load(counter)

      expect(loaded).toEqual({ value: { count: 0 }, source: 'initial', warning: undefined })
    })

    it('reads what was saved, in a versioned envelope', async () => {
      const { store } = setup()
      store.save(counter, { count: 7 })
      await store.flush()

      expect(JSON.parse(read('counter.json'))).toEqual({ version: 1, data: { count: 7 } })
      expect(await setup().store.load(counter)).toEqual({
        value: { count: 7 },
        source: 'file',
        warning: undefined,
      })
    })

    it('migrates older versions', async () => {
      writeFileSync(file('counter.json'), JSON.stringify({ version: 1, data: { count: 3 } }))
      const v2 = defineDocument({
        key: 'counter',
        version: 2,
        schema: z.object({ total: z.number() }),
        initial: () => ({ total: 0 }),
        migrations: { 1: (data) => ({ total: (data as { count: number }).count }) },
      })

      expect((await setup().store.load(v2)).value).toEqual({ total: 3 })
    })

    it('restores the backup when the file is corrupt, and keeps the bad file aside', async () => {
      const { store } = setup()
      store.save(counter, { count: 1 })
      await store.flush()
      store.save(counter, { count: 2 })
      await store.flush() // the previous content (1) is now the backup
      writeFileSync(file('counter.json'), '{ not json')

      const loaded = await setup().store.load(counter)

      expect(loaded.value).toEqual({ count: 1 })
      expect(loaded.source).toBe('backup')
      expect(loaded.warning).toContain('previous copy was restored')
      expect(read('counter.json.corrupt')).toBe('{ not json')
    })

    it('starts empty, with a warning, when the file is corrupt and there is no backup', async () => {
      writeFileSync(file('counter.json'), '[]')

      const loaded = await setup().store.load(counter)

      expect(loaded).toMatchObject({ value: { count: 0 }, source: 'initial' })
      expect(loaded.warning).toContain('no usable backup')
      expect(readdirSync(directory)).toContain('counter.json.corrupt')
    })

    it('treats data written by a newer version as unusable instead of overwriting it silently', async () => {
      writeFileSync(file('counter.json'), JSON.stringify({ version: 9, data: { count: 5 } }))

      const loaded = await setup().store.load(counter)

      expect(loaded.value).toEqual({ count: 0 })
      expect(loaded.warning).toBeDefined()
      expect(read('counter.json.corrupt')).toContain('"version":9')
    })

    it('treats data of the wrong shape as corrupt', async () => {
      writeFileSync(file('counter.json'), JSON.stringify({ version: 1, data: { count: 'many' } }))

      expect((await setup().store.load(counter)).warning).toBeDefined()
    })

    it('logs and treats an unreadable path as corrupt', async () => {
      mkdirSync(file('counter.json')) // a directory where the file should be
      const { store, logger } = setup()

      const loaded = await store.load(counter)

      expect(loaded.value).toEqual({ count: 0 })
      expect(logger.entries.map((e) => e.level)).toContain('warn')
    })

    it('still loads when the corrupt file cannot be set aside', async () => {
      writeFileSync(file('counter.json'), 'junk')
      mkdirSync(file('counter.json.corrupt')) // a non-empty target that rename cannot replace
      writeFileSync(path.join(file('counter.json.corrupt'), 'keep'), 'x')
      const { store, logger } = setup()

      const loaded = await store.load(counter)

      expect(loaded.value).toEqual({ count: 0 })
      expect(logger.entries.some((e) => e.message.includes('set a corrupt state file aside'))).toBe(
        true,
      )
    })
  })

  describe('saving', () => {
    it('writes after the debounce delay, not at once', async () => {
      const { store, scheduler } = setup()

      store.save(counter, { count: 1 })
      expect(readdirSync(directory)).toEqual([])
      scheduler.advance(500)
      await store.flush()

      expect(read('counter.json')).toContain('"count": 1')
    })

    it('batches a burst of saves into one write of the latest value', async () => {
      const { store, scheduler } = setup()

      store.save(counter, { count: 1 })
      store.save(counter, { count: 2 })
      store.save(counter, { count: 3 })
      scheduler.advance(500)
      await store.flush()

      expect(dataOf('counter.json')).toEqual({ count: 3 })
      expect(readdirSync(directory)).toEqual(['counter.json'])
    })

    it('flushes immediately on request and cancels the pending timer', async () => {
      const { store, scheduler } = setup()
      store.save(counter, { count: 4 })

      await store.flush()

      expect(scheduler.pendingCount).toBe(0)
      expect(dataOf('counter.json')).toEqual({ count: 4 })
    })

    it('keeps the previous content as a backup and leaves no temp file', async () => {
      const { store } = setup()
      store.save(counter, { count: 1 })
      await store.flush()
      store.save(counter, { count: 2 })
      await store.flush()

      expect(dataOf('counter.json.bak')).toEqual({ count: 1 })
      expect(readdirSync(directory).sort()).toEqual(['counter.json', 'counter.json.bak'])
    })

    it('creates the directory when it does not exist', async () => {
      const nested = path.join(directory, 'a', 'b')
      const { store } = setup(nested)
      store.save(counter, { count: 1 })

      await store.flush()

      expect(readFileSync(path.join(nested, 'counter.json'), 'utf8')).toContain('"count": 1')
    })

    it('writes several documents in one flush', async () => {
      const other = defineDocument({
        key: 'other',
        version: 1,
        schema: z.object({ ok: z.boolean() }),
        initial: () => ({ ok: false }),
      })
      const { store } = setup()

      store.save(counter, { count: 1 })
      store.save(other, { ok: true })
      await store.flush()

      expect(readdirSync(directory).sort()).toEqual(['counter.json', 'other.json'])
    })

    it('logs a failed write instead of throwing, and keeps working afterwards', async () => {
      const blocked = path.join(directory, 'file-not-directory')
      writeFileSync(blocked, 'x')
      const { store, logger } = setup(blocked)

      store.save(counter, { count: 1 })
      await store.flush()

      expect(logger.entries.map((e) => e.level)).toEqual(['error'])
      const healthy = setup()
      healthy.store.save(counter, { count: 2 })
      await healthy.store.flush()
      expect(dataOf('counter.json')).toEqual({ count: 2 })
    })

    it('flushing with nothing pending is harmless', async () => {
      await expect(setup().store.flush()).resolves.toBeUndefined()
    })
  })
})
