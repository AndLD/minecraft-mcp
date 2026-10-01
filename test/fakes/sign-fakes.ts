import type { LookFace, LookTarget } from '../../src/core/container.port.js'
import type { PlaceFailure, PlaceOptions, Placer } from '../../src/core/placer.port.js'
import type { Position } from '../../src/core/position.types.js'
import { err, ok, type Result } from '../../src/core/result.js'
import type {
  SignAccess,
  SignFacing,
  SignFailure,
  SignSide,
  SignState,
} from '../../src/core/sign.port.js'
import type { SkillContext } from '../../src/core/skill.types.js'
import type { SignSupplier } from '../../src/skills/signs/sign-supplies.js'
import { GroveWorld } from './grove-fakes.js'

const keyOf = (p: Position): string => `${String(p.x)},${String(p.y)},${String(p.z)}`

export const GROUND = 63
export const FLOOR = GROUND + 1

interface StoredSign {
  name: string
  front: string[]
  back: string[]
  waxed: boolean
  facing: SignFacing | undefined
}

const pad = (lines: readonly string[]): string[] => [...lines, '', '', '', ''].slice(0, 4)

/** A flat grass world (ground at y 63, air above) that also knows the text on its signs. */
export class SignWorld extends GroveWorld {
  readonly signs = new Map<string, StoredSign>()

  constructor() {
    super({ x0: -30, x1: 30, z0: -30, z1: 30, y0: 50, y1: 80 })
    this.ground(-30, -30, 30, 30, GROUND)
    this.names.push('oak_sign', 'oak_wall_sign', 'spruce_sign', 'spruce_wall_sign', 'chest')
  }

  addSign(
    position: Position,
    options: {
      name?: string
      front?: readonly string[]
      back?: readonly string[]
      waxed?: boolean
      facing?: SignFacing
    } = {},
  ): void {
    const name = options.name ?? 'oak_wall_sign'
    this.set(position.x, position.y, position.z, name)
    this.signs.set(keyOf(position), {
      name,
      front: pad(options.front ?? []),
      back: pad(options.back ?? []),
      waxed: options.waxed ?? false,
      facing: options.facing ?? 'north',
    })
  }

  removeSign(position: Position): void {
    this.set(position.x, position.y, position.z, 'air')
    this.signs.delete(keyOf(position))
  }
}

/** Reads and writes the text of the signs in a `SignWorld`. */
export class FakeSignAccess implements SignAccess {
  readonly writes: {
    position: Position
    side: SignSide
    lines: readonly string[]
    reopen: boolean
  }[] = []
  /** The next write fails with this. */
  failure: SignFailure | undefined
  /** The write succeeds but the text never shows up, like a server that ignored it. */
  ignoreText = false

  constructor(private readonly world: SignWorld) {}

  stateAt(position: Position): SignState | undefined {
    const sign = this.world.signs.get(keyOf(position))
    if (sign === undefined) return undefined
    return {
      name: sign.name,
      front: sign.front,
      back: sign.back,
      waxed: sign.waxed,
      facing: sign.facing,
    }
  }

  write(
    position: Position,
    side: SignSide,
    lines: readonly string[],
    reopen: boolean,
  ): Promise<Result<void, SignFailure>> {
    this.writes.push({ position, side, lines, reopen })
    if (this.failure !== undefined) return Promise.resolve(err(this.failure))
    const sign = this.world.signs.get(keyOf(position))
    if (sign !== undefined && !this.ignoreText) sign[side] = pad(lines)
    return Promise.resolve(ok(undefined))
  }
}

/** Puts a sign into the `SignWorld` when asked, standing on a top face and on the wall otherwise. */
export class SignPlacer implements Placer {
  readonly placed: { item: string; reference: Position; face: Position; options?: PlaceOptions }[] =
    []
  failure: PlaceFailure | undefined
  /** Places nothing, though it reports success. */
  silent = false

  constructor(private readonly world: SignWorld) {}

  placeAt(): Promise<Result<void, PlaceFailure>> {
    return Promise.resolve(ok(undefined))
  }

  placeAgainst(
    item: string,
    reference: Position,
    face: Position,
    options?: PlaceOptions,
  ): Promise<Result<void, PlaceFailure>> {
    this.placed.push(
      options === undefined ? { item, reference, face } : { item, reference, face, options },
    )
    if (this.failure !== undefined) return Promise.resolve(err(this.failure))
    if (this.silent) return Promise.resolve(ok(undefined))
    const cell = { x: reference.x + face.x, y: reference.y + face.y, z: reference.z + face.z }
    const standing = face.y === 1
    const facing: SignFacing =
      face.x === 1 ? 'east' : face.x === -1 ? 'west' : face.z === 1 ? 'south' : 'north'
    this.world.addSign(cell, {
      name: standing ? item : item.replace(/_sign$/, '_wall_sign'),
      facing: standing ? 'south' : facing,
    })
    return Promise.resolve(ok(undefined))
  }
}

/** Answers `ensure` with a fixed sign item, and remembers what was asked. */
export class FakeSignSupplier implements SignSupplier {
  item: string | undefined = 'oak_sign'
  readonly asked: (string | undefined)[] = []

  ensure(wood: string | undefined, _context: SkillContext): Promise<string | undefined> {
    this.asked.push(wood)
    return Promise.resolve(this.item)
  }
}

/** Where a player looks, by player name. */
export class FakeLookTarget implements LookTarget {
  readonly hits = new Map<string, { name: string; position: Position; face: LookFace }>()

  blockLookedAt(player: string) {
    return this.hits.get(player)
  }
}
