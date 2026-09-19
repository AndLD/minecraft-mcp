import { describe, expect, it } from '@jest/globals'
import {
  BREEDING_FLOOR,
  assessAnimals,
  goalForItem,
  individualProtection,
  itemMatches,
  selectTarget,
  type SelectionOptions,
} from '../../../../src/skills/hunting/animal-catalog.js'
import { animal } from '../../../fakes/hunting-fakes.js'

const options = (over: Partial<SelectionOptions> = {}): SelectionOptions => ({
  species: ['cow'],
  keepBreeders: true,
  allowBabies: false,
  includePens: false,
  skip: new Set(),
  isPenned: () => false,
  ...over,
})

describe('goalForItem', () => {
  it('finds the animals that drop a raw item', () => {
    expect(goalForItem('beef')).toEqual({
      raw: 'beef',
      cooked: undefined,
      species: ['cow', 'mooshroom'],
    })
    expect(goalForItem('porkchop')?.species).toEqual(['pig'])
    expect(goalForItem('feather')?.species).toEqual(['chicken'])
    expect(goalForItem('wool')?.species).toEqual(['sheep'])
  })

  it('treats a cooked meat as its raw meat, cooked', () => {
    expect(goalForItem('cooked_beef')).toEqual({
      raw: 'beef',
      cooked: 'cooked_beef',
      species: ['cow', 'mooshroom'],
    })
    expect(goalForItem('cooked_rabbit')?.raw).toBe('rabbit')
  })

  it('knows nothing about items no livestock drops', () => {
    expect(goalForItem('diamond')).toBeUndefined()
  })
})

describe('itemMatches', () => {
  it('matches names exactly, and wool of any colour', () => {
    expect(itemMatches('beef', 'beef')).toBe(true)
    expect(itemMatches('beef', 'cooked_beef')).toBe(false)
    expect(itemMatches('wool', 'red_wool')).toBe(true)
    expect(itemMatches('wool', 'wool_carpet')).toBe(false)
  })
})

describe('individualProtection', () => {
  it.each([
    [{ species: 'villager' }, 'not_huntable'],
    [{ species: 'wolf' }, 'not_huntable'],
    [{ species: 'horse' }, 'not_huntable'],
    [{ named: true }, 'named'],
    [{ owned: true }, 'tamed'],
    [{ saddled: true }, 'saddled'],
    [{ ridden: true }, 'ridden'],
    [{ baby: true }, 'baby'],
  ])('protects %j as %s', (override, reason) => {
    expect(individualProtection(animal('cow', 5, override), false)).toBe(reason)
  })

  it('allows a plain adult, and a baby when babies are allowed', () => {
    expect(individualProtection(animal('cow'), false)).toBeUndefined()
    expect(individualProtection(animal('cow', 5, { baby: true }), true)).toBeUndefined()
  })

  it('checks the name before anything else about a named baby pet', () => {
    expect(individualProtection(animal('cow', 5, { named: true, baby: true }), false)).toBe('named')
  })
})

describe('selecting a target', () => {
  it('takes the nearest huntable animal of the wanted species', () => {
    const near = animal('cow', 3)
    const herd = [near, animal('cow', 6), animal('cow', 9), animal('pig', 1)]

    expect(selectTarget(herd, options()).target).toBe(near)
  })

  it('ignores other species and animals to skip', () => {
    const skipped = animal('cow', 3)
    const next = animal('cow', 6)
    const herd = [skipped, next, animal('cow', 9), animal('sheep', 1)]

    expect(selectTarget(herd, options({ skip: new Set([skipped.id]) })).target).toBe(next)
  })

  it('leaves the last breeding pair alone and says so', () => {
    const pair = [animal('cow', 3), animal('cow', 6)]

    const result = selectTarget(pair, options())

    expect(result.target).toBeUndefined()
    expect(result.passedOver).toEqual({ breeding_pair: 2 })
  })

  it('hunts once there are more adults than the floor', () => {
    const herd = Array.from({ length: BREEDING_FLOOR + 1 }, (_, i) => animal('cow', 3 + i))

    expect(selectTarget(herd, options()).target).toBe(herd[0])
  })

  it('counts protected adults toward the floor, but not babies', () => {
    const named = animal('cow', 8, { named: true })
    const herd = [animal('cow', 3), animal('cow', 6), named]
    const withBaby = [animal('cow', 3), animal('cow', 6), animal('cow', 8, { baby: true })]

    expect(selectTarget(herd, options()).target).toBe(herd[0])
    expect(selectTarget(withBaby, options()).target).toBeUndefined()
  })

  it('can ignore the floor when asked', () => {
    const pair = [animal('cow', 3), animal('cow', 6)]

    expect(selectTarget(pair, options({ keepBreeders: false })).target).toBe(pair[0])
  })

  it('takes babies only when allowed, and they do not break the floor', () => {
    const baby = animal('cow', 3, { baby: true })
    const pair = [baby, animal('cow', 6), animal('cow', 9)]

    expect(selectTarget(pair, options()).target).toBeUndefined()
    expect(selectTarget(pair, options({ allowBabies: true })).target).toBe(baby)
  })

  it('leaves penned animals alone unless pens are included', () => {
    const inPen = animal('cow', 3)
    const free = animal('cow', 6)
    const herd = [inPen, free, animal('cow', 9)]
    const penned = (p: { x: number }): boolean => p.x === 3

    expect(selectTarget(herd, options({ isPenned: penned })).target).toBe(free)
    expect(selectTarget(herd, options({ isPenned: penned, includePens: true })).target).toBe(inPen)
  })

  it('counts why animals were passed over', () => {
    const plain = animal('cow', 6)
    const herd = [
      animal('cow', 3, { named: true }),
      animal('cow', 4, { owned: true }),
      animal('cow', 5, { baby: true }),
      plain,
      animal('cow', 7),
    ]

    const { target, passedOver } = selectTarget(herd, options())

    expect(target).toBe(plain)
    expect(passedOver).toEqual({ named: 1, tamed: 1, baby: 1 })
  })

  it('assesses every animal of the wanted species for listing', () => {
    const assessed = assessAnimals(
      [animal('cow', 3), animal('cow', 4), animal('cow', 5), animal('pig', 2)],
      options({ species: ['cow', 'pig'] }),
    )

    expect(assessed.map((entry) => [entry.animal.species, entry.protection])).toEqual([
      ['cow', undefined],
      ['cow', undefined],
      ['cow', undefined],
      ['pig', 'breeding_pair'],
    ])
  })
})
