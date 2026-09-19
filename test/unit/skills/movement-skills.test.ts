import { describe, expect, it } from '@jest/globals'
import type { SkillContext } from '../../../src/core/skill.types.js'
import { BlockFinder } from '../../../src/perception/block-finder.js'
import { FollowPlayerSkill } from '../../../src/skills/movement/follow-player-skill.js'
import { GoToSkill } from '../../../src/skills/movement/goto-skill.js'
import { FakeBlockScanner, FakeNavigator } from '../../fakes/fake-ports.js'

function context(controller = new AbortController()) {
  const progress: string[] = []
  const ctx: SkillContext = { signal: controller.signal, progress: (m) => progress.push(m) }
  return { ctx, progress, controller }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('GoToSkill', () => {
  function setup() {
    const navigator = new FakeNavigator()
    const scanner = new FakeBlockScanner()
    return { navigator, scanner, skill: new GoToSkill(navigator, new BlockFinder(scanner)) }
  }

  it('walks to a position and reports where it arrived (rounded)', async () => {
    const { skill, navigator } = setup()
    const { ctx } = context()

    const running = skill.run(
      { target: { kind: 'position', position: { x: 10, y: 64, z: 5 } }, within: 2 },
      ctx,
    )
    await flush()
    navigator.arrive({ x: 9.26, y: 64, z: 5 })

    expect(await running).toEqual({ ok: true, value: { arrivedAt: { x: 9.3, y: 64, z: 5 } } })
    expect(navigator.calls).toEqual([
      { kind: 'position', target: { x: 10, y: 64, z: 5 }, within: 2 },
    ])
  })

  it('walks to a player', async () => {
    const { skill, navigator } = setup()

    const running = skill.run(
      { target: { kind: 'player', name: 'Andrey_Knight' }, within: 3 },
      context().ctx,
    )
    await flush()
    navigator.arrive({ x: 1, y: 64, z: 1 })

    expect((await running).ok).toBe(true)
    expect(navigator.calls[0]).toEqual({ kind: 'player', target: 'Andrey_Knight', within: 3 })
  })

  it('finds the nearest block and walks to it', async () => {
    const { skill, navigator, scanner } = setup()
    scanner.blocks = [{ name: 'oak_log', position: { x: 4, y: 64, z: 4 }, distance: 5.7 }]
    const { ctx, progress } = context()

    const running = skill.run(
      { target: { kind: 'block', name: 'oak_log', maxDistance: 32 }, within: 2 },
      ctx,
    )
    await flush()
    navigator.arrive({ x: 3, y: 64, z: 3 })

    expect(await running).toEqual({
      ok: true,
      value: { arrivedAt: { x: 3, y: 64, z: 3 }, targetPosition: { x: 4, y: 64, z: 4 } },
    })
    expect(progress).toEqual(['Found oak_log 6 blocks away'])
  })

  it('fails when no such block is nearby', async () => {
    const { skill } = setup()

    const result = await skill.run(
      { target: { kind: 'block', name: 'iron_ore', maxDistance: 16 }, within: 2 },
      context().ctx,
    )

    expect(result).toEqual({
      ok: false,
      error: {
        reason: 'block_not_found',
        message: 'No iron_ore within 16 blocks in the loaded area.',
      },
    })
  })

  it('fails with the suggestions for an unknown block name', async () => {
    const { skill, scanner } = setup()
    scanner.names = ['oak_log']

    const result = await skill.run(
      { target: { kind: 'block', name: 'log', maxDistance: 16 }, within: 2 },
      context().ctx,
    )

    expect(!result.ok && result.error.reason).toBe('unknown_block')
    expect(!result.ok && result.error.message).toContain('oak_log')
  })

  it('passes navigation failures through', async () => {
    const { skill, navigator } = setup()

    const running = skill.run(
      { target: { kind: 'position', position: { x: 1, y: 1, z: 1 } }, within: 2 },
      context().ctx,
    )
    await flush()
    navigator.fail({ reason: 'unreachable', message: 'No path.' })

    expect(await running).toEqual({
      ok: false,
      error: { reason: 'unreachable', message: 'No path.' },
    })
  })

  it('stops when aborted', async () => {
    const { skill } = setup()
    const { ctx, controller } = context()

    const running = skill.run(
      { target: { kind: 'position', position: { x: 1, y: 1, z: 1 } }, within: 2 },
      ctx,
    )
    controller.abort()

    expect((await running).ok).toBe(false)
  })

  it('reports how far it still has to go', async () => {
    const { skill, navigator } = setup()
    const { ctx, progress } = context()
    const original = navigator.goToPosition.bind(navigator)
    navigator.goToPosition = (target, within, options) => {
      options.onProgress?.({ position: { x: 0, y: 0, z: 0 }, distanceRemaining: 41.6 })
      options.onProgress?.({ position: { x: 0, y: 0, z: 0 }, distanceRemaining: undefined })
      return original(target, within, options)
    }

    void skill.run({ target: { kind: 'position', position: { x: 1, y: 1, z: 1 } }, within: 2 }, ctx)
    await flush()

    expect(progress).toEqual(['42 blocks to go'])
  })
})

describe('FollowPlayerSkill', () => {
  it('follows until cancelled', async () => {
    const navigator = new FakeNavigator()
    const skill = new FollowPlayerSkill(navigator)
    const { ctx, progress, controller } = context()

    const running = skill.run({ player: 'Andrey_Knight', distance: 3 }, ctx)
    controller.abort()

    expect(await running).toEqual({ ok: true, value: { stoppedFollowing: 'Andrey_Knight' } })
    expect(progress).toEqual(['Following Andrey_Knight'])
    expect(navigator.calls).toEqual([{ kind: 'follow', target: 'Andrey_Knight', within: 3 }])
  })

  it('passes a failure through', async () => {
    const skill = new FollowPlayerSkill({
      goToPosition: () => Promise.reject(new Error('unused')),
      goToPlayer: () => Promise.reject(new Error('unused')),
      follow: () =>
        Promise.resolve({
          ok: false,
          error: { reason: 'target_not_found', message: 'Lost them.' },
        }),
    })

    expect(await skill.run({ player: 'A', distance: 3 }, context().ctx)).toEqual({
      ok: false,
      error: { reason: 'target_not_found', message: 'Lost them.' },
    })
  })
})
