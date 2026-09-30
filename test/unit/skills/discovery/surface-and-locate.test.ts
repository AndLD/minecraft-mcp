import { describe, expect, it } from '@jest/globals'
import { parseLocateReply, withHeight } from '../../../../src/skills/discovery/locate-reply.js'
import { findSurface } from '../../../../src/skills/discovery/surface-finder.js'
import { DiscoveryWorld, GROUND } from '../../../fakes/discovery-fakes.js'

describe('findSurface', () => {
  it('finds the ground of a plain column', () => {
    expect(findSurface(new DiscoveryWorld(), 30, 30, 64)).toEqual({
      kind: 'ground',
      position: { x: 30, y: GROUND + 1, z: 30 },
    })
  })

  it('finds the ground of a hill above the bot and a hollow below it', () => {
    const world = new DiscoveryWorld()
    for (let y = GROUND + 1; y <= GROUND + 10; y += 1) world.put(5, y, 5, 'stone')
    for (let y = GROUND - 8; y <= GROUND; y += 1) world.put(6, y, 6, 'air')

    expect(findSurface(world, 5, 5, 64)).toMatchObject({ position: { y: GROUND + 11 } })
    expect(findSurface(world, 6, 6, 64)).toMatchObject({ position: { y: GROUND - 8 } })
  })

  it('reports water and lava as liquid, so the explorer goes round them', () => {
    const world = new DiscoveryWorld().lake(10, 10, 12, 12).put(20, GROUND, 20, 'lava')

    expect(findSurface(world, 11, 11, 64)).toEqual({ kind: 'liquid' })
    expect(findSurface(world, 20, 20, 64)).toEqual({ kind: 'liquid' })
  })

  it('walks past a treetop to the ground under it', () => {
    const world = new DiscoveryWorld()
    world.put(7, GROUND + 5, 7, 'oak_leaves').put(7, GROUND + 4, 7, 'oak_leaves')

    expect(findSurface(world, 7, 7, 64)).toMatchObject({
      kind: 'ground',
      position: { y: GROUND + 1 },
    })
  })

  it('will not stand where the head would be inside a block', () => {
    const world = new DiscoveryWorld()
      .put(8, GROUND + 1, 8, 'stone')
      .put(8, GROUND + 2, 8, 'stone')
      .put(8, GROUND + 3, 8, 'stone')

    // The three-block pillar is ground, at its top.
    expect(findSurface(world, 8, 8, 64)).toMatchObject({ position: { y: GROUND + 4 } })
  })

  it('says unknown for a column that is not loaded', () => {
    const world = new DiscoveryWorld()
    world.loaded = 50

    expect(findSurface(world, 300, 0, 64)).toEqual({ kind: 'unknown' })
  })

  it('says unknown when there is no ground within the height range', () => {
    const world = new DiscoveryWorld()

    expect(findSurface(world, 0, 0, 300)).toEqual({ kind: 'unknown' })
  })
})

describe('parseLocateReply', () => {
  it('reads the coordinates of the reply', () => {
    expect(
      parseLocateReply(
        'The nearest minecraft:village_plains is at [-224, ~, 96] (123 blocks away)',
      ),
    ).toEqual({ x: -224, z: 96 })
  })

  it('accepts a known height too', () => {
    expect(parseLocateReply('The nearest minecraft:stronghold is at [12, -30, 40]')).toEqual({
      x: 12,
      z: 40,
    })
  })

  it('returns nothing for a reply without a place', () => {
    expect(parseLocateReply('Could not find a structure of that type nearby')).toBeUndefined()
  })

  it('puts a height on the place', () => {
    expect(withHeight({ x: 1, z: 2 }, 70)).toEqual({ x: 1, y: 70, z: 2 })
  })
})
