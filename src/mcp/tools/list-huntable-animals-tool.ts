import { z } from 'zod'
import type { AnimalScanner } from '../../core/animal-scanner.port.js'
import { roundPosition } from '../../core/position.js'
import {
  HUNTABLE_SPECIES,
  HUNTABLE_SPECIES_NAMES,
  PROTECTION_TEXT,
  assessAnimals,
} from '../../skills/hunting/animal-catalog.js'
import type { PenDetector } from '../../skills/hunting/pen-detector.js'
import { toolOk } from '../tool-result.js'
import type { ToolDefinition } from '../tool.types.js'

const MAX_LISTED = 40

const schema = z.object({
  radius: z.number().min(4).max(64).default(24).describe('How far to look, in blocks.'),
  keep_breeders: z
    .boolean()
    .default(true)
    .describe('Count the last breeding pair of a species as protected.'),
  allow_babies: z.boolean().default(false).describe('Treat baby animals as huntable.'),
  include_pens: z.boolean().default(false).describe('Treat animals in fenced pens as huntable.'),
})

export class ListHuntableAnimalsTool implements ToolDefinition<typeof schema> {
  readonly name = 'list_huntable_animals'
  readonly description =
    'Shows the animals around the bot and which of them hunt_animals would take: per species how many adults, babies, and ' +
    'huntable ones, and a list (nearest first, at most 40) with each animal\'s id, position, and status: "huntable" or why it ' +
    'is protected (pet, name tag, baby, pen, last breeding pair, not livestock). Read-only. Use before large hunts and to ' +
    'find an id for attack_entity.'
  readonly inputSchema = schema

  constructor(
    private readonly animals: AnimalScanner,
    private readonly pens: PenDetector,
  ) {}

  execute(input: z.output<typeof schema>) {
    const nearby = this.animals.nearby(input.radius)
    const assessed = assessAnimals(nearby, {
      species: [...new Set(nearby.map((animal) => animal.species))],
      keepBreeders: input.keep_breeders,
      allowBabies: input.allow_babies,
      includePens: input.include_pens,
      skip: new Set(),
      isPenned: (position) => this.pens.isPenned(position),
    })

    const species = [...new Set(assessed.map((entry) => entry.animal.species))]
      .sort()
      .map((name) => {
        const ofKind = assessed.filter((entry) => entry.animal.species === name)
        return {
          species: name,
          livestock: name in HUNTABLE_SPECIES,
          adults: ofKind.filter((entry) => !entry.animal.baby).length,
          babies: ofKind.filter((entry) => entry.animal.baby).length,
          huntable: ofKind.filter((entry) => entry.protection === undefined).length,
        }
      })
    return toolOk({
      radius: input.radius,
      livestockSpecies: HUNTABLE_SPECIES_NAMES,
      species,
      animals: assessed.slice(0, MAX_LISTED).map(({ animal, protection }) => ({
        id: animal.id,
        species: animal.species,
        distance: Math.round(animal.distance * 10) / 10,
        position: roundPosition(animal.position),
        status: protection === undefined ? 'huntable' : PROTECTION_TEXT[protection],
      })),
      truncated: assessed.length > MAX_LISTED,
    })
  }
}
