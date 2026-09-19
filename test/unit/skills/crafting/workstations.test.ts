import { describe, expect, it } from '@jest/globals'
import type { BlockInfo } from '../../../../src/core/block-scanner.port.js'
import type { Position } from '../../../../src/core/position.types.js'
import { PlacementSpotFinder } from '../../../../src/skills/crafting/placement-spot.js'
import { Workstations } from '../../../../src/skills/crafting/workstations.js'
import {
  FakeBlockScanner,
  FakeInventory,
  FakeVitals,
  buildVitals,
} from '../../../fakes/fake-ports.js'
import { FakePlacer, InstantNavigator, skillContext } from '../../../fakes/gathering-fakes.js'

const key = (p: Position): string => `${String(p.x)},${String(p.y)},${String(p.z)}`

/** Flat ground at y=63 around the origin, with the bot standing at (0, 64, 0). */
function flatGround(scanner: FakeBlockScanner, radius = 4): void {
  for (let x = -radius; x <= radius; x += 1) {
    for (let z = -radius; z <= radius; z += 1) {
      scanner.solid.set(key({ x, y: 63, z }), true)
      scanner.blockNames.set(key({ x, y: 64, z }), 'air')
      scanner.blockNames.set(key({ x, y: 65, z }), 'air')
    }
  }
}

function setup() {
  const scanner = new FakeBlockScanner()
  flatGround(scanner)
  const navigator = new InstantNavigator()
  const placer = new FakePlacer()
  const inventory = new FakeInventory()
  inventory.value = { stacks: [], emptySlots: 30, heldItem: undefined }
  const vitals = new FakeVitals()
  vitals.vitals = buildVitals({ position: { x: 0.5, y: 64, z: 0.5 } })
  const spots = new PlacementSpotFinder(scanner)
  const workstations = new Workstations({
    blocks: scanner,
    navigator,
    placer,
    inventory,
    vitals,
    spots,
  })
  const carry = (name: string): void => {
    inventory.value = { stacks: [{ name, count: 1 }], emptySlots: 30, heldItem: undefined }
  }
  const stand = (name: string, position: Position): void => {
    const info: BlockInfo = { name, position, distance: 5 }
    scanner.blocks = [info]
  }
  return { scanner, navigator, placer, inventory, spots, workstations, carry, stand }
}

describe('PlacementSpotFinder', () => {
  it('picks the free cell closest to the bot, never its own cell', () => {
    const { spots } = setup()

    const spot = spots.find({ x: 0.5, y: 64, z: 0.5 })

    expect(spot).toBeDefined()
    expect(spot).not.toEqual({ x: 0, y: 64, z: 0 })
    expect(Math.hypot((spot?.x ?? 99) - 0, (spot?.z ?? 99) - 0)).toBe(1)
  })

  it('skips cells without a floor, without headroom, or that are occupied', () => {
    const { scanner, spots } = setup()
    // Take away every cell except (2, 64, 1): floor missing, blocked head, or a block in it.
    for (let x = -2; x <= 2; x += 1) {
      for (let z = -2; z <= 2; z += 1) {
        if (x === 2 && z === 1) continue
        if ((x + z) % 3 === 0) scanner.solid.set(key({ x, y: 63, z }), false)
        else if ((x + z) % 3 === 1) scanner.blockNames.set(key({ x, y: 65, z }), 'stone')
        else scanner.blockNames.set(key({ x, y: 64, z }), 'stone')
      }
    }

    expect(spots.find({ x: 0.5, y: 64, z: 0.5 })).toEqual({ x: 2, y: 64, z: 1 })
  })

  it('finds nothing in a cramped spot', () => {
    const scanner = new FakeBlockScanner()
    expect(new PlacementSpotFinder(scanner).find({ x: 0, y: 64, z: 0 })).toBeUndefined()
  })
})

describe('Workstations', () => {
  it('walks to a crafting table that stands nearby', async () => {
    const { workstations, navigator, stand, placer } = setup()
    stand('crafting_table', { x: 6, y: 64, z: 0 })

    const result = await workstations.ensure('crafting_table', skillContext().context)

    expect(result).toEqual({ ok: true, value: { x: 6, y: 64, z: 0 } })
    expect(navigator.trips).toEqual([{ target: { x: 6, y: 64, z: 0 }, within: 2.5 }])
    expect(placer.placed).toEqual([])
    expect(workstations.standsNearby('crafting_table')).toBe(true)
  })

  it('places one from the inventory when none stands nearby', async () => {
    const { workstations, placer, carry } = setup()
    carry('crafting_table')

    const result = await workstations.ensure('crafting_table', skillContext().context)

    expect(result.ok).toBe(true)
    expect(placer.placed).toHaveLength(1)
    expect(placer.placed[0]?.item).toBe('crafting_table')
    expect(workstations.standsNearby('crafting_table')).toBe(false)
    expect(workstations.available('crafting_table')).toBe(true)
  })

  it('reports that there is none to use', async () => {
    const { workstations } = setup()

    const result = await workstations.ensure('furnace', skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_furnace' } })
    expect(workstations.available('furnace')).toBe(false)
  })

  it('reports that there is no room to place it', async () => {
    const { workstations, scanner, carry } = setup()
    carry('furnace')
    scanner.solid.clear()

    const result = await workstations.ensure('furnace', skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'no_room' } })
  })

  it('reports a failed placement', async () => {
    const { workstations, placer, carry } = setup()
    carry('crafting_table')
    placer.failure = { reason: 'failed', message: 'blocked' }

    const result = await workstations.ensure('crafting_table', skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'place_failed' } })
    expect(!result.ok && result.error.message).toContain('blocked')
  })

  it('reports a table it cannot walk to', async () => {
    const { workstations, navigator, stand } = setup()
    stand('crafting_table', { x: 6, y: 64, z: 0 })
    navigator.failures = [{ reason: 'unreachable', message: 'No path' }]

    const result = await workstations.ensure('crafting_table', skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'unreachable' } })
  })

  it('passes on an aborted walk', async () => {
    const { workstations, navigator, stand } = setup()
    stand('crafting_table', { x: 6, y: 64, z: 0 })
    navigator.failures = [{ reason: 'aborted', message: 'Cancelled.' }]

    const result = await workstations.ensure('crafting_table', skillContext().context)

    expect(result).toMatchObject({ ok: false, error: { reason: 'aborted' } })
  })
})
