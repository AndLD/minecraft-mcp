import { describe, expect, it } from '@jest/globals'
import { WindowTransfer } from '../../../src/bot/window-transfer.js'
import { FakeContainerWindow, stackSizeOf } from '../../fakes/container-window-fake.js'

interface State {
  container: ({ name: string; count: number } | null)[]
  player: { name: string; count: number }[]
}

function setup(container: State['container'], player: State['player']) {
  const state: State = { container, player }
  const window = new FakeContainerWindow(container, player, (c, p) => {
    state.container = c
    state.player = p
  })
  return { window, state, transfer: new WindowTransfer(window, stackSizeOf) }
}

const empty = (n: number): null[] => Array.from({ length: n }, () => null)
const count = (state: State, name: string): number =>
  state.container.filter((s) => s?.name === name).reduce((sum, s) => sum + (s?.count ?? 0), 0)
const carried = (state: State, name: string): number =>
  state.player.filter((s) => s.name === name).reduce((sum, s) => sum + s.count, 0)

describe('WindowTransfer', () => {
  it('reads the container side only, with free slots', () => {
    const { transfer } = setup(
      [{ name: 'cobblestone', count: 64 }, { name: 'dirt', count: 3 }, ...empty(25)],
      [{ name: 'stick', count: 9 }],
    )

    expect(transfer.contents()).toEqual({
      stacks: [
        { name: 'cobblestone', count: 64 },
        { name: 'dirt', count: 3 },
      ],
      totalSlots: 27,
      emptySlots: 25,
    })
  })

  it('deposits everything of an item with shift-clicks, one stack at a time', async () => {
    const { transfer, state, window } = setup(empty(27), [{ name: 'cobblestone', count: 150 }])

    const moved = await transfer.deposit('cobblestone', undefined)

    expect(moved).toBe(150)
    expect(count(state, 'cobblestone')).toBe(150)
    expect(carried(state, 'cobblestone')).toBe(0)
    expect(window.log.filter((l) => l.endsWith('m1'))).toHaveLength(3) // 64 + 64 + 22
    expect(window.log[0]).toBe('sync') // starts from the server's picture
  })

  it('merges into a partial stack first', async () => {
    const { transfer, state } = setup(
      [{ name: 'dirt', count: 60 }, ...empty(26)],
      [{ name: 'dirt', count: 10 }],
    )

    await transfer.deposit('dirt', undefined)

    expect(state.container.filter((s) => s?.name === 'dirt').map((s) => s?.count)).toEqual([64, 6])
  })

  it('deposits only what fits when the container is nearly full, and says how many went in', async () => {
    const full = Array.from({ length: 27 }, () => ({ name: 'dirt', count: 64 }))
    full[26] = { name: 'dirt', count: 60 }
    const { transfer, state } = setup(full, [{ name: 'dirt', count: 30 }])

    const moved = await transfer.deposit('dirt', undefined)

    expect(moved).toBe(4)
    expect(carried(state, 'dirt')).toBe(26)
  })

  it('moves nothing when the container is completely full', async () => {
    const full = Array.from({ length: 27 }, () => ({ name: 'dirt', count: 64 }))
    const { transfer, state } = setup(full, [{ name: 'stick', count: 5 }])

    expect(await transfer.deposit('stick', undefined)).toBe(0)
    expect(carried(state, 'stick')).toBe(5)
  })

  it('moves nothing of an item it does not carry', async () => {
    const { transfer } = setup(empty(27), [{ name: 'stick', count: 5 }])

    expect(await transfer.deposit('coal', undefined)).toBe(0)
    expect(await transfer.withdraw('coal', 3)).toBe(0)
  })

  it('deposits a part of a stack with right-clicks (the wanted part is smaller)', async () => {
    const { transfer, state, window } = setup(empty(27), [{ name: 'cobblestone', count: 64 }])

    const moved = await transfer.deposit('cobblestone', 3)

    expect(moved).toBe(3)
    expect(count(state, 'cobblestone')).toBe(3)
    expect(carried(state, 'cobblestone')).toBe(61)
    expect(window.selectedItem).toBeNull()
    expect(window.log.filter((l) => l.endsWith('b1 m0'))).toHaveLength(3)
  })

  it('deposits a part of a stack when the wanted part is the larger one, putting the rest back one by one', async () => {
    const { transfer, state, window } = setup(empty(27), [{ name: 'cobblestone', count: 64 }])

    const moved = await transfer.deposit('cobblestone', 62)

    expect(moved).toBe(62)
    expect(carried(state, 'cobblestone')).toBe(2)
    expect(window.selectedItem).toBeNull()
    expect(window.log.filter((l) => l.endsWith('b1 m0'))).toHaveLength(2)
  })

  it('deposits whole stacks and then the remaining part', async () => {
    const { transfer, state } = setup(empty(27), [{ name: 'dirt', count: 150 }])

    const moved = await transfer.deposit('dirt', 100)

    expect(moved).toBe(100)
    expect(count(state, 'dirt')).toBe(100)
    expect(carried(state, 'dirt')).toBe(50)
  })

  it('withdraws everything, or a number, back into the inventory', async () => {
    const { transfer, state } = setup(
      [{ name: 'iron_ingot', count: 40 }, { name: 'iron_ingot', count: 20 }, ...empty(25)],
      [],
    )

    expect(await transfer.withdraw('iron_ingot', 45)).toBe(45)
    expect(carried(state, 'iron_ingot')).toBe(45)
    expect(count(state, 'iron_ingot')).toBe(15)

    expect(await transfer.withdraw('iron_ingot', undefined)).toBe(15)
    expect(count(state, 'iron_ingot')).toBe(0)
  })

  it('cannot take more than there is, or more than the inventory holds', async () => {
    const { transfer, state } = setup([{ name: 'coal', count: 8 }, ...empty(26)], [])

    expect(await transfer.withdraw('coal', 100)).toBe(8)

    const stuffed = Array.from({ length: 36 }, (_, i) => ({ name: `item_${String(i)}`, count: 64 }))
    const second = setup([{ name: 'coal', count: 8 }, ...empty(26)], stuffed)
    expect(await second.transfer.withdraw('coal', 8)).toBe(0)
    expect(count(second.state, 'coal')).toBe(8)
    expect(state.player[0]?.name).toBe('coal')
  })

  it('reports only what really moved when the server ignores a click', async () => {
    const { transfer, window, state } = setup(empty(27), [{ name: 'dirt', count: 10 }])
    window.ignoreClicks = 1

    const moved = await transfer.deposit('dirt', undefined)

    expect(moved).toBe(0)
    expect(carried(state, 'dirt')).toBe(10)
  })

  it('does not mistake a late answer from the server for a full container', async () => {
    const { transfer, state, window } = setup(empty(27), [{ name: 'cobblestone', count: 100 }])
    window.lateSyncs = 2 // the first two looks still show the old slot

    const moved = await transfer.deposit('cobblestone', undefined)

    expect(moved).toBe(100)
    expect(count(state, 'cobblestone')).toBe(100)
    expect(carried(state, 'cobblestone')).toBe(0)
  })

  it('closes the window', async () => {
    const { transfer, window } = setup(empty(27), [])

    await transfer.close()

    expect(window.closed).toBe(true)
  })

  it('handles a double chest (54 slots)', async () => {
    const { transfer, state } = setup(empty(54), [{ name: 'dirt', count: 640 }])

    expect(transfer.contents().totalSlots).toBe(54)
    expect(await transfer.deposit('dirt', undefined)).toBe(640)
    expect(count(state, 'dirt')).toBe(640)
  })
})
