import { describe, expect, it } from '@jest/globals'
import { WindowDropper } from '../../../src/bot/window-dropper.js'
import { FakeContainerWindow } from '../../fakes/container-window-fake.js'

function setup(player: { name: string; count: number }[]) {
  const state = { player, thrown: [] as { name: string; count: number }[] }
  const window = new FakeContainerWindow(
    [],
    player,
    (_c, p) => {
      state.player = p
    },
    (name, count) => {
      state.thrown.push({ name, count })
    },
  )
  return { state, window, dropper: new WindowDropper(window) }
}

const thrownOf = (state: ReturnType<typeof setup>['state'], name: string): number =>
  state.thrown.filter((t) => t.name === name).reduce((sum, t) => sum + t.count, 0)
const carried = (state: ReturnType<typeof setup>['state'], name: string): number =>
  state.player.filter((p) => p.name === name).reduce((sum, p) => sum + p.count, 0)

describe('WindowDropper', () => {
  it('throws whole stacks with one click each', async () => {
    const { dropper, state, window } = setup([{ name: 'cobblestone', count: 150 }])

    const thrown = await dropper.toss('cobblestone', 150)

    expect(thrown).toBe(150)
    expect(thrownOf(state, 'cobblestone')).toBe(150)
    expect(carried(state, 'cobblestone')).toBe(0)
    expect(window.log.filter((l) => l.endsWith('b1 m4'))).toHaveLength(3) // 64 + 64 + 22
    expect(window.log[0]).toBe('sync')
  })

  it('throws a few items of a bigger stack one at a time', async () => {
    const { dropper, state, window } = setup([{ name: 'iron_ingot', count: 40 }])

    expect(await dropper.toss('iron_ingot', 3)).toBe(3)

    expect(carried(state, 'iron_ingot')).toBe(37)
    expect(window.log.filter((l) => l.endsWith('b0 m4'))).toHaveLength(3)
  })

  it('throws most of a stack by picking it up and putting the part to keep back', async () => {
    const { dropper, state, window } = setup([{ name: 'iron_ingot', count: 40 }])

    expect(await dropper.toss('iron_ingot', 38)).toBe(38)

    expect(carried(state, 'iron_ingot')).toBe(2)
    expect(thrownOf(state, 'iron_ingot')).toBe(38)
    expect(window.selectedItem).toBeNull()
    expect(window.log).toContain('click -999 b0 m0')
  })

  it('throws whole stacks and then the rest of the amount', async () => {
    const { dropper, state } = setup([{ name: 'dirt', count: 150 }])

    expect(await dropper.toss('dirt', 100)).toBe(100)

    expect(carried(state, 'dirt')).toBe(50)
  })

  it('throws at most what it carries, and nothing it does not carry', async () => {
    const { dropper, state } = setup([{ name: 'coal', count: 5 }])

    expect(await dropper.toss('coal', 50)).toBe(5)
    expect(await dropper.toss('coal', 5)).toBe(0)
    expect(await dropper.toss('diamond', 1)).toBe(0)
    expect(state.thrown).toEqual([{ name: 'coal', count: 5 }])
  })

  it('reports only what really left when the server ignores a click', async () => {
    const { dropper, window, state } = setup([{ name: 'dirt', count: 10 }])
    window.ignoreClicks = 1

    expect(await dropper.toss('dirt', 10)).toBe(0)
    expect(carried(state, 'dirt')).toBe(10)
  })

  it('does not mistake a late answer for a failed throw', async () => {
    const { dropper, window, state } = setup([{ name: 'dirt', count: 100 }])
    window.lateSyncs = 2

    expect(await dropper.toss('dirt', 100)).toBe(100)
    expect(carried(state, 'dirt')).toBe(0)
  })
})
