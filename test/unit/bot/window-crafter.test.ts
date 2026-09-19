import { describe, expect, it } from '@jest/globals'
import { WindowCrafter } from '../../../src/bot/window-crafter.js'
import { FakeCraftServer, shaped, shapeless } from '../../fakes/craft-window-fake.js'

const planks = shapeless('oak_planks', 4, ['oak_log'])
const stick = shaped('stick', 4, [['oak_planks'], ['oak_planks']], false)
const table = shaped(
  'crafting_table',
  1,
  [
    ['oak_planks', 'oak_planks'],
    ['oak_planks', 'oak_planks'],
  ],
  false,
)
const pickaxe = shaped(
  'wooden_pickaxe',
  1,
  [
    ['oak_planks', 'oak_planks', 'oak_planks'],
    [null, 'stick', null],
    [null, 'stick', null],
  ],
  true,
)

function setup(recipe: typeof planks, items: Record<string, number>) {
  const server = new FakeCraftServer(recipe)
  for (const [name, count] of Object.entries(items)) {
    server.inventoryWindow.put(name, count)
    server.tableWindow.put(name, count)
  }
  return { server, crafter: new WindowCrafter(server) }
}

describe('WindowCrafter', () => {
  it('crafts a shapeless recipe in the inventory grid, one click at a time, and lets the server produce the result', async () => {
    const { server, crafter } = setup(planks, { oak_log: 4 })

    await crafter.craft(planks, 1, false)

    expect(server.inventoryWindow.count('oak_log')).toBe(3)
    expect(server.inventoryWindow.count('oak_planks')).toBe(4)
    expect(server.inventoryWindow.selectedItem).toBeNull()
    // pick up the stack, put one log in the grid, wait for the server's update, put the rest back, then shift-click the result
    expect(server.log.filter((entry) => entry.startsWith('click'))).toEqual([
      'click 9 b0 m0',
      'click 1 b1 m0',
      'click 9 b0 m0',
      'click 0 b0 m1',
    ])
  })

  it('waits for the server after every click and syncs before taking the result', async () => {
    const { server, crafter } = setup(planks, { oak_log: 1 })

    await crafter.craft(planks, 1, false)

    expect(server.log).toEqual([
      'sync', // the true state first
      'click 9 b0 m0',
      'settle',
      'click 1 b1 m0',
      'settle',
      'sync', // the server answers a grid change with the new result
      // the only log was placed, so there is no rest to put back
      'sync', // the result is on offer
      'click 0 b0 m1',
      'settle',
      'sync',
      'sync', // and finally the whole inventory
    ])
  })

  it('places a 2x2 shape in the top-left corner of the inventory grid', async () => {
    const { server, crafter } = setup(table, { oak_planks: 8 })

    await crafter.craft(table, 1, false)

    expect(server.inventoryWindow.count('crafting_table')).toBe(1)
    expect(server.inventoryWindow.count('oak_planks')).toBe(4)
    const placed = server.log.filter((entry) => /^click [1-4] b1/.test(entry))
    expect(placed).toEqual(['click 1 b1 m0', 'click 2 b1 m0', 'click 3 b1 m0', 'click 4 b1 m0'])
  })

  it('lays out a 3x3 recipe on the crafting table window, then closes it', async () => {
    const { server, crafter } = setup(pickaxe, { oak_planks: 5, stick: 4 })

    await crafter.craft(pickaxe, 1, true)

    expect(server.tableWindow.count('wooden_pickaxe')).toBe(1)
    expect(server.tableWindow.count('oak_planks')).toBe(2)
    expect(server.tableWindow.count('stick')).toBe(2)
    const placed = server.log.filter((entry) => /b1 m0$/.test(entry))
    expect(placed).toEqual([
      'click 1 b1 m0',
      'click 2 b1 m0',
      'click 3 b1 m0',
      'click 5 b1 m0',
      'click 8 b1 m0',
    ])
    expect(server.log[0]).toBe('open table')
    expect(server.log).toContain('close table')
  })

  it('crafts several times over, each round on its own', async () => {
    const { server, crafter } = setup(planks, { oak_log: 4 })

    await crafter.craft(planks, 3, false)

    expect(server.inventoryWindow.count('oak_planks')).toBe(12)
    expect(server.inventoryWindow.count('oak_log')).toBe(1)
    expect(server.log.filter((entry) => entry === 'click 0 b0 m1')).toHaveLength(3)
  })

  it('uses an ingredient stack again for the next cell of the shape', async () => {
    const { server, crafter } = setup(stick, { oak_planks: 10 })

    await crafter.craft(stick, 1, false)

    expect(server.inventoryWindow.count('stick')).toBe(4)
    expect(server.inventoryWindow.count('oak_planks')).toBe(8)
  })

  it('crafts a shapeless recipe with several different ingredients', async () => {
    const dye = shapeless('coal', 2, ['oak_log', 'stick'])
    const { server, crafter } = setup(dye, { oak_log: 3, stick: 3 })

    await crafter.craft(dye, 1, false)

    expect(server.inventoryWindow.count('coal')).toBe(2)
    expect(server.log.filter((entry) => /b1 m0$/.test(entry))).toEqual([
      'click 1 b1 m0',
      'click 2 b1 m0',
    ])
  })

  it('puts a stack left on the cursor away before it starts', async () => {
    const { server, crafter } = setup(planks, { oak_log: 2 })
    server.inventoryWindow.selectedItem = { name: 'oak_log', count: 5 }

    await crafter.craft(planks, 1, false)

    expect(server.inventoryWindow.selectedItem).toBeNull()
    expect(server.inventoryWindow.count('oak_log')).toBe(6) // 2 + 5 - 1
    expect(server.log[1]).toBe('click 10 b0 m0') // the first empty slot after the logs
  })

  it('drops a cursor stack when the inventory has no room', async () => {
    const { server, crafter } = setup(planks, { oak_log: 1 })
    for (let slot = 10; slot < 45; slot += 1)
      server.inventoryWindow.slots[slot] = { name: 'stick', count: 64 }
    server.inventoryWindow.selectedItem = { name: 'stick', count: 5 }

    await crafter.craft(planks, 1, false)

    expect(server.log).toContain('click -999 b0 m0')
  })

  it('fails with the missing ingredient, closing the table and syncing anyway', async () => {
    const { server, crafter } = setup(pickaxe, { oak_planks: 5 })

    await expect(crafter.craft(pickaxe, 1, true)).rejects.toThrow('missing ingredient stick')

    expect(server.log).toContain('close table')
    expect(server.log.at(-1)).toBe('sync')
  })

  it('fails when the server does not offer the expected result, and says what it offered', async () => {
    const wrong = shaped('stick', 4, [['oak_planks'], ['oak_planks']], false)
    const { server } = setup(wrong, { oak_planks: 10 })
    const crafter = new WindowCrafter(server)
    // The crafter is told to craft sticks, but the server's recipe expects another arrangement.
    const misplaced = shaped('stick', 4, [['oak_planks', 'oak_planks']], false)

    await expect(crafter.craft(misplaced, 1, false)).rejects.toThrow(
      'The game did not offer stick for these ingredients (it offered nothing).',
    )
    expect(server.clicksIgnored).toBe(0) // it never tried to take a result that was not there
  })

  it('turns anything that is not an Error into one', async () => {
    const { server, crafter } = setup(planks, { oak_log: 1 })
    server.failClicksWith = 'connection lost'

    await expect(crafter.craft(planks, 1, false)).rejects.toThrow('connection lost')
  })

  it('does not fail because a cleanup step fails', async () => {
    const { server, crafter } = setup(pickaxe, { oak_planks: 5, stick: 4 })
    server.closeWindow = () => Promise.reject(new Error('window gone'))

    await expect(crafter.craft(pickaxe, 1, true)).resolves.toBeUndefined()
  })
})
