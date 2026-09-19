import { describe, expect, it } from '@jest/globals'
import { err, ok } from '../../../src/core/result.js'
import { SEED_A, SEED_B, buildStateStack } from '../../fakes/state-fakes.js'

describe('SessionBriefingBuilder', () => {
  it('says to connect first when no world was ever joined', () => {
    const stack = buildStateStack()

    expect(stack.briefing.build()).toEqual({
      world: { profile: null, status: 'not_connected' },
      previousSession: null,
      interruptedTasks: [],
      pendingDrops: [],
      standingInstructions: {},
      notes: [],
      recentHistory: [],
      warnings: [],
      nextSteps: ['Connect to the world first.'],
    })
  })

  it('describes a new world', async () => {
    const stack = buildStateStack()
    await stack.worldState.open(SEED_A)

    const briefing = stack.briefing.build()

    expect(briefing.world).toEqual({
      profile: 'survival',
      status: 'new world: a profile was created for it',
    })
    expect(briefing.previousSession).toBeNull()
    expect(briefing.nextSteps).toEqual([])
  })

  it('describes a recognized world with the time since the last visit, notes, instructions, and history', async () => {
    const stack = buildStateStack()
    await stack.worldState.open(SEED_A)
    stack.notes.remember('Base at 100, 64, -20', ['base'])
    stack.standing.set('inventory_full', 'bring resources to the home chest')
    stack.history.record('chat', 'Andrey: build a house')
    await stack.worldState.close()
    stack.clock.advance(125 * 60_000)
    await stack.worldState.open(SEED_A)

    const briefing = stack.briefing.build()

    expect(briefing.world.profile).toBe('survival')
    expect(briefing.world.status).toContain('recognized')
    expect(briefing.previousSession).toEqual({ at: '2026-09-19T12:00:00.000Z', minutesAgo: 125 })
    expect(briefing.notes).toEqual([{ id: 'note-1', text: 'Base at 100, 64, -20', tags: ['base'] }])
    expect(briefing.standingInstructions).toEqual({
      inventory_full: 'bring resources to the home chest',
    })
    expect(briefing.recentHistory.map((e) => e.text)).toEqual(['Andrey: build a house'])
    expect(briefing.nextSteps).toEqual([
      'Read the notes: they hold plans and preferences from earlier sessions.',
    ])
  })

  it('lists interrupted tasks and tells the agent to ask before resuming', async () => {
    const stack = buildStateStack()
    await stack.worldState.open(SEED_A)
    stack.tasks.start({
      name: 'goto',
      description: 'Go to 10, 64, 5',
      resume: { tool: 'goto', arguments: { x: 10, y: 64, z: 5 } },
      run: (ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            resolve(err({ reason: 'aborted', message: '' }))
          })
        }),
    })
    await stack.tasks.cancel(undefined, 'disconnected')

    const briefing = stack.briefing.build()

    expect(briefing.interruptedTasks).toEqual([
      {
        id: 'job-1',
        description: 'Go to 10, 64, 5',
        progress: null,
        resumable: true,
        startedAt: '2026-09-19T12:00:00.000Z',
      },
    ])
    expect(briefing.nextSteps.join(' ')).toContain('ask before resuming')
  })

  it('explains what to do when the world could not be identified', async () => {
    const stack = buildStateStack()
    await stack.worldState.open({ seed: null, worldName: null, spawn: null })

    const briefing = stack.briefing.build()

    expect(briefing.world.profile).toBeNull()
    expect(briefing.world.status).toContain('not identified')
    expect(briefing.nextSteps.join(' ')).toContain('set_world_profile')
  })

  it('lists the candidates when several remembered worlds fit', async () => {
    const stack = buildStateStack()
    const twin = { seed: null, worldName: 'Home', spawn: { x: 5, y: 70, z: 5 } }
    await stack.worldState.bind('first', twin)
    await stack.worldState.bind('second', twin)
    await stack.worldState.open(twin)

    const briefing = stack.briefing.build()

    expect(briefing.world).toMatchObject({ profile: null, candidates: ['first', 'second'] })
    expect(briefing.nextSteps.join(' ')).toContain('first, second')
  })

  it('says when a name was chosen for a world that looks different, and passes warnings on', async () => {
    const stack = buildStateStack()
    await stack.worldState.open(SEED_A)
    await stack.worldState.bind('survival', SEED_B)

    const briefing = stack.briefing.build()

    expect(briefing.world.status).toContain('looks different')
    expect(briefing.warnings.join(' ')).toContain('different seed')
  })

  it('describes a profile chosen by name and a named new profile', async () => {
    const stack = buildStateStack()
    await stack.worldState.bind('mine', SEED_A)
    expect(stack.briefing.build().world.status).toBe('new profile created with the given name')

    await stack.worldState.bind('mine', SEED_A)
    expect(stack.briefing.build().world.status).toBe('profile chosen by name')
  })

  it('flags an unusable profile name', async () => {
    const stack = buildStateStack()
    await stack.worldState.bind('///', SEED_A)

    const briefing = stack.briefing.build()

    expect(briefing.world.status).toContain('not usable')
    expect(briefing.nextSteps.join(' ')).toContain('set_world_profile')
  })

  it('is an ok result type sanity check for ok/err helpers used above', () => {
    expect(ok(1).ok).toBe(true)
    expect(err('x').ok).toBe(false)
  })
})

describe('SessionBriefingBuilder: dropped items', () => {
  it('lists what can still be fetched and tells the agent to ask the player', async () => {
    const stack = buildStateStack()
    await stack.worldState.open(SEED_A)
    stack.drops.add({
      kind: 'death',
      position: { x: 5, y: 64, z: -7 },
      dimension: 'overworld',
      at: stack.clock.now() - 100_000,
      cause: null,
      lost: [{ name: 'iron_ingot', count: 3 }],
      note: null,
    })
    stack.drops.add({
      kind: 'death',
      position: { x: 0, y: 64, z: 0 },
      dimension: 'overworld',
      at: stack.clock.now() - 400_000,
      cause: null,
      lost: [{ name: 'stick', count: 3 }],
      note: null,
    })

    const briefing = stack.briefing.build()

    expect(briefing.pendingDrops).toEqual([
      {
        id: 'drop-1',
        kind: 'death',
        status: 'pending',
        position: { x: 5, y: 64, z: -7 },
        dimension: 'overworld',
        secondsLeft: 200,
      },
    ])
    expect(briefing.nextSteps.join(' ')).toContain('recover_drops')
  })
})
