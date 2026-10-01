import { describe, expect, it } from '@jest/globals'
import { err, ok } from '../../../src/core/result.js'
import { InstructionLog, MAX_HISTORY_ENTRIES } from '../../../src/state/instruction-log.js'
import { MAX_NOTES, MAX_NOTE_LENGTH, NotesStore } from '../../../src/state/notes-store.js'
import {
  MAX_INSTRUCTION_LENGTH,
  StandingInstructions,
} from '../../../src/state/standing-instructions.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { InMemoryStateStore } from '../../fakes/state-fakes.js'

const NOT_ACTIVE = expect.stringContaining('No world is active')

const foundCount = (result: { ok: boolean; value?: readonly unknown[] }): number =>
  result.value?.length ?? -1

describe('NotesStore', () => {
  async function attached(store = new InMemoryStateStore()) {
    const clock = new FakeClock(Date.UTC(2026, 8, 19, 12, 0, 0))
    const notes = new NotesStore(clock)
    await notes.attach(store)
    return { notes, store, clock }
  }

  it('refuses everything while no world is active', () => {
    const notes = new NotesStore(new FakeClock(0))

    expect(notes.remember('x')).toEqual(err(NOT_ACTIVE))
    expect(notes.recall()).toEqual(err(NOT_ACTIVE))
    expect(notes.forget('note-1')).toEqual(err(NOT_ACTIVE))
    expect(notes.latest(5)).toEqual([])
  })

  it('remembers a note with an id, timestamps, and normalized tags', async () => {
    const { notes } = await attached()

    const saved = notes.remember('  Build the house near the river  ', [
      ' House ',
      'PLAN',
      'house',
      '',
    ])

    expect(saved).toEqual(
      ok({
        id: 'note-1',
        text: 'Build the house near the river',
        tags: ['house', 'plan'],
        createdAt: '2026-09-19T12:00:00.000Z',
        updatedAt: '2026-09-19T12:00:00.000Z',
      }),
    )
  })

  it('saves after every change, and a new store instance sees the notes', async () => {
    const { notes, store } = await attached()
    notes.remember('one')
    notes.remember('two')

    const reloaded = (await attached(store)).notes

    expect(reloaded.latest(10).map((n) => n.text)).toEqual(['two', 'one'])
    expect(reloaded.remember('three')).toMatchObject({ ok: true, value: { id: 'note-3' } })
  })

  it('never reuses an id after a note was forgotten', async () => {
    const { notes } = await attached()
    notes.remember('a')
    notes.forget('note-1')

    expect(notes.remember('b')).toMatchObject({ value: { id: 'note-2' } })
  })

  it('rejects empty, too long, and too many notes', async () => {
    const { notes } = await attached()

    expect(notes.remember('   ')).toEqual(err('The note is empty.'))
    expect(notes.remember('x'.repeat(MAX_NOTE_LENGTH + 1)).ok).toBe(false)
    for (let i = 0; i < MAX_NOTES; i += 1) notes.remember(`n${String(i)}`)
    expect(notes.remember('one too many')).toEqual(err(expect.stringContaining('Forget some')))
  })

  it('limits the tags', async () => {
    const { notes } = await attached()

    const saved = notes.remember(
      't',
      Array.from({ length: 15 }, (_, i) => `tag${String(i)}`),
    )

    expect(saved.ok && saved.value.tags).toHaveLength(10)
  })

  describe('recall', () => {
    async function withNotes() {
      const context = await attached()
      context.notes.remember('The base is at 100, 64, -20', ['base'])
      context.notes.remember('Player prefers oak wood', ['preference'])
      context.notes.remember('House plan: 9x9 with a porch', ['house', 'plan'])
      return context.notes
    }

    it('returns everything, newest first', async () => {
      const found = (await withNotes()).recall()

      expect(found.ok && found.value.map((n) => n.id)).toEqual(['note-3', 'note-2', 'note-1'])
    })

    it('filters by text or tag, ignoring case', async () => {
      const notes = await withNotes()

      expect(foundCount(notes.recall({ query: 'OAK' }))).toBe(1)
      expect(foundCount(notes.recall({ query: 'plan' }))).toBe(1)
      expect(foundCount(notes.recall({ tag: 'BASE' }))).toBe(1)
      expect(foundCount(notes.recall({ query: 'nothing' }))).toBe(0)
      expect(foundCount(notes.recall({ query: '   ' }))).toBe(3)
    })

    it('limits the number of notes', async () => {
      const found = (await withNotes()).recall({ limit: 2 })

      expect(found.ok && found.value.map((n) => n.id)).toEqual(['note-3', 'note-2'])
    })
  })

  it('forgets a note by id, and reports unknown ids', async () => {
    const { notes } = await attached()
    notes.remember('a')

    expect(notes.forget('note-9')).toEqual(err('There is no note note-9.'))
    expect(notes.forget('note-1')).toMatchObject({ ok: true, value: { text: 'a' } })
    expect(notes.latest(5)).toEqual([])
  })

  it('reports a warning from the store and forgets notes when detached', async () => {
    const store = new InMemoryStateStore()
    store.warnOnLoad = 'notes.json was corrupt'
    const notes = new NotesStore(new FakeClock(0))

    expect(await notes.attach(store)).toEqual(['notes.json was corrupt'])
    notes.remember('x')
    notes.detach()
    expect(notes.latest(5)).toEqual([])
  })
})

describe('InstructionLog', () => {
  async function attached(store = new InMemoryStateStore()) {
    const clock = new FakeClock(Date.UTC(2026, 8, 19, 12, 0, 0))
    const log = new InstructionLog(clock)
    await log.attach(store)
    return { log, store, clock }
  }

  it('records nothing while no world is active', () => {
    const log = new InstructionLog(new FakeClock(0))

    log.record('chat', 'ignored')

    expect(log.recent(10)).toEqual([])
  })

  it('records entries with a timestamp and returns the latest in order', async () => {
    const { log, clock } = await attached()
    log.record('chat', 'Andrey: build a house')
    clock.advance(1000)
    log.record('tool', 'goto(...) → ok')
    log.record('event', 'connected: joined')

    expect(log.recent(10).map((e) => e.text)).toEqual([
      'Andrey: build a house',
      'goto(...) → ok',
      'connected: joined',
    ])
    expect(log.recent(2).map((e) => e.kind)).toEqual(['tool', 'event'])
    expect(log.recent(10, 'chat').map((e) => e.text)).toEqual(['Andrey: build a house'])
    expect(log.recent(10)[1]?.at).toBe('2026-09-19T12:00:01.000Z')
  })

  it('drops the oldest entries past the limit', async () => {
    const { log } = await attached()

    for (let i = 0; i < MAX_HISTORY_ENTRIES + 5; i += 1) log.record('event', `e${String(i)}`)

    const all = log.recent(MAX_HISTORY_ENTRIES + 10)
    expect(all).toHaveLength(MAX_HISTORY_ENTRIES)
    expect(all[0]?.text).toBe('e5')
  })

  it('clips very long entries', async () => {
    const { log } = await attached()

    log.record('chat', 'x'.repeat(1000))

    const text = log.recent(1)[0]?.text ?? ''
    expect(text.length).toBeLessThanOrEqual(300)
    expect(text.endsWith('…')).toBe(true)
  })

  it('persists across a new instance and forgets on detach', async () => {
    const { log, store } = await attached()
    log.record('chat', 'hello')

    const reloaded = (await attached(store)).log
    expect(reloaded.recent(5).map((e) => e.text)).toEqual(['hello'])
    reloaded.detach()
    expect(reloaded.recent(5)).toEqual([])
  })

  it('reports a warning from the store', async () => {
    const store = new InMemoryStateStore()
    store.warnOnLoad = 'history.json was corrupt'

    expect(await new InstructionLog(new FakeClock(0)).attach(store)).toEqual([
      'history.json was corrupt',
    ])
  })
})

describe('StandingInstructions', () => {
  async function attached(store = new InMemoryStateStore()) {
    const standing = new StandingInstructions()
    await standing.attach(store)
    return { standing, store }
  }

  it('refuses while no world is active', () => {
    const standing = new StandingInstructions()

    expect(standing.set('rule', 'x')).toEqual(err(NOT_ACTIVE))
    expect(standing.remove('rule')).toEqual(err(NOT_ACTIVE))
    expect(standing.all()).toEqual({})
  })

  it('sets, replaces, and removes instructions, and persists them', async () => {
    const { standing, store } = await attached()

    expect(standing.set('inventory_full', '  bring resources to the home chest  ').ok).toBe(true)
    expect(standing.set('inventory_full', 'ask me first').ok).toBe(true)
    expect(standing.set('night', 'go to bed').ok).toBe(true)
    expect((await attached(store)).standing.all()).toEqual({
      inventory_full: 'ask me first',
      night: 'go to bed',
    })

    expect(standing.remove('night').ok).toBe(true)
    expect(standing.all()).toEqual({ inventory_full: 'ask me first' })
  })

  it('rejects bad keys, empty and too long text, and unknown keys', async () => {
    const { standing } = await attached()

    expect(standing.set('Bad Key', 'x').ok).toBe(false)
    expect(standing.set('', 'x').ok).toBe(false)
    expect(standing.set('k', '   ').ok).toBe(false)
    expect(standing.set('k', 'x'.repeat(MAX_INSTRUCTION_LENGTH + 1)).ok).toBe(false)
    expect(standing.remove('missing')).toEqual(err('There is no standing instruction "missing".'))
  })

  it('returns a copy, forgets on detach, and reports store warnings', async () => {
    const store = new InMemoryStateStore()
    store.warnOnLoad = 'standing-instructions.json was corrupt'
    const standing = new StandingInstructions()
    expect(await standing.attach(store)).toEqual(['standing-instructions.json was corrupt'])
    standing.set('k', 'v')

    const copy = standing.all() as Record<string, string>
    copy['k'] = 'changed'
    expect(standing.all()).toEqual({ k: 'v' })
    standing.detach()
    expect(standing.all()).toEqual({})
  })
})
