import { beforeEach, describe, expect, it } from '@jest/globals'
import { LightManager } from '../../../../../src/skills/discovery/caves/light-manager.js'
import { SiteSafety } from '../../../../../src/skills/construction/site-safety.js'
import type { SupplyCrafter } from '../../../../../src/skills/construction/crafting-supplies.js'
import { CaveWorld } from '../../../../fakes/cave-fakes.js'

const at = (x: number, y: number, z: number) => ({ x, y, z })
const context = { signal: new AbortController().signal, progress: () => undefined }

describe('LightManager', () => {
  let world: CaveWorld
  let crafted: { item: string; count: number }[]
  let lights: LightManager

  const build = (supplies?: SupplyCrafter) =>
    new LightManager({
      safety: new SiteSafety(world, world),
      placer: world,
      blocks: world,
      inventory: world,
      ...(supplies === undefined ? {} : { supplies }),
    })

  beforeEach(() => {
    world = new CaveWorld().carve(at(-5, 60, -5), at(5, 61, 5))
    world.give('torch', 3)
    crafted = []
    lights = build()
  })

  const ensure = (heading = { dx: 1, dz: 0 }, minLight = 5) =>
    lights.ensure(at(0, 60, 0), heading, { minLight, spacing: 6 }, context)

  it('puts a torch on the right-hand side of the way in, in a dark spot', async () => {
    expect(await ensure()).toBe('placed')

    // Heading east (+x): right is south (+z).
    expect(world.torchCells()).toEqual([at(0, 60, 1)])
    expect(lights.torches()).toBe(2)
  })

  it('goes to the other side when the right is a wall, and to the cell it stands in as a last resort', async () => {
    world.setBlock(at(0, 60, 1), 'stone')
    expect(await ensure()).toBe('placed')
    expect(world.torchCells()).toEqual([at(0, 60, -1)])

    const narrow = new CaveWorld().carve(at(0, 60, 0), at(0, 61, 0))
    narrow.give('torch', 1)
    const alone = new LightManager({
      safety: new SiteSafety(narrow, narrow),
      placer: narrow,
      blocks: narrow,
      inventory: narrow,
    })
    expect(
      await alone.ensure(at(0, 60, 0), { dx: 1, dz: 0 }, { minLight: 5, spacing: 6 }, context),
    ).toBe('placed')
    expect(narrow.torchCells()).toEqual([at(0, 60, 0)])
  })

  it('does nothing where it is light enough, or a torch is near', async () => {
    world.setBlock(at(2, 60, 0), 'torch')
    expect(await ensure()).toBe('lit')
    expect(await ensure({ dx: 1, dz: 0 }, 0)).toBe('lit')
    expect(lights.torches()).toBe(3)
  })

  it('crafts torches when it has none, and says when it cannot', async () => {
    world.carried.set('torch', 0)
    const supplies: SupplyCrafter = {
      craft: (item, count) => {
        crafted.push({ item, count })
        world.give('torch', count)
        return Promise.resolve(true)
      },
    }
    lights = build(supplies)

    expect(await ensure()).toBe('placed')
    expect(crafted).toEqual([{ item: 'torch', count: 8 }])

    world.carried.set('torch', 0)
    world.setBlock(at(0, 60, 1), 'air')
    const cannot = build({ craft: () => Promise.resolve(false) })
    expect(
      await cannot.ensure(at(4, 60, 4), { dx: 1, dz: 0 }, { minLight: 5, spacing: 6 }, context),
    ).toBe('no_torches')
    expect(
      await build().ensure(at(4, 60, 4), { dx: 1, dz: 0 }, { minLight: 5, spacing: 6 }, context),
    ).toBe('no_torches')
  })

  it('reports failed when every cell refuses the torch', async () => {
    world.placeFailures = [
      { reason: 'failed', message: 'no' },
      { reason: 'failed', message: 'no' },
      { reason: 'failed', message: 'no' },
      { reason: 'failed', message: 'no' },
    ]

    expect(await ensure()).toBe('failed')
    expect(world.torchCells()).toEqual([])
  })
})
