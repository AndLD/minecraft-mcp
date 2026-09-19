import type { AnimalInfo, AnimalScanner } from '../../src/core/animal-scanner.port.js'
import type { Position } from '../../src/core/position.types.js'

let nextId = 700

/** An adult, unnamed, wild animal `distance` blocks east of the bot, unless overridden. */
export function animal(
  species: string,
  distance = 5,
  overrides: Partial<AnimalInfo> = {},
): AnimalInfo {
  nextId += 1
  return {
    id: nextId,
    species,
    position: { x: distance, y: 64, z: 0 },
    distance,
    baby: false,
    named: false,
    owned: false,
    saddled: false,
    ridden: false,
    dead: false,
    ...overrides,
  }
}

/** Animals in view; killing one marks it dead (it still answers `find`) and takes it out of `nearby`. */
export class FakeAnimalScanner implements AnimalScanner {
  animals: AnimalInfo[] = []

  nearby(maxDistance: number): readonly AnimalInfo[] {
    return this.animals
      .filter((a) => !a.dead && a.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance)
  }

  find(id: number): AnimalInfo | undefined {
    return this.animals.find((a) => a.id === id)
  }

  kill(id: number): void {
    this.animals = this.animals.map((a) => (a.id === id ? { ...a, dead: true } : a))
  }

  /** The animal ran out of view. */
  vanish(id: number): void {
    this.animals = this.animals.filter((a) => a.id !== id)
  }
}

export const at = (x: number): Position => ({ x, y: 64, z: 0 })
