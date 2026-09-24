import type { AreaGuard } from '../../core/area-guard.port.js'
import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { LookFace } from '../../core/container.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Placer } from '../../core/placer.port.js'
import { distanceBetween } from '../../core/position.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import type { SignAccess, SignFacing, SignSide } from '../../core/sign.port.js'
import type { Skill, SkillContext, SkillFailure, SkillResult } from '../../core/skill.types.js'
import { sleep } from '../../core/sleep.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import { isContainerBlock } from '../../state/container-index.js'
import type { SignRegistry } from '../../state/sign-registry.js'
import type { SignSupplier } from './sign-supplies.js'
import {
  FACINGS,
  faceVector,
  facingTowards,
  isAir,
  isBadGround,
  isFluid,
  isSignBlock,
  offset,
  vectorOf,
  woodOfSign,
} from './sign-table.js'
import { sameSignText } from './sign-text.js'

const CONFIRM_TRIES = 6
const CONFIRM_MS = 300
const UP: Position = { x: 0, y: 1, z: 0 }
const DOWN: Position = { x: 0, y: -1, z: 0 }

export interface PlaceSignInput {
  /** The block the sign hangs on or stands on. */
  readonly reference: Position
  /**
   * Which face of it: `top` puts a standing sign on it, a side hangs a wall sign. Undefined lets the skill choose the
   * free side nearest to the reader (a chest with a label).
   */
  readonly face: LookFace | undefined
  /** Exactly four lines (blank ones are empty strings). */
  readonly lines: readonly string[]
  readonly side: SignSide
  /** The wood of the sign; the sign type the bot carries, else oak, when undefined. */
  readonly wood: string | undefined
  /** For a standing sign, the direction its text faces. Undefined: towards `towards`, else towards the bot. */
  readonly facing: SignFacing | undefined
  /** Where the reader is (the player); a standing sign faces them by default. */
  readonly towards: Position | undefined
}

export interface PlaceSignOutput {
  readonly position: Position
  readonly kind: 'wall' | 'standing'
  readonly item: string
  readonly facing: SignFacing | undefined
  readonly side: SignSide
  readonly lines: readonly string[]
}

export interface PlaceSignDeps {
  readonly vitals: VitalsReader
  readonly blocks: BlockScanner
  readonly signs: SignAccess
  readonly navigator: Navigator
  readonly placer: Placer
  readonly guard: AreaGuard
  readonly supplies: SignSupplier
  readonly registry: SignRegistry
  readonly scheduler: Scheduler
}

interface Placement {
  readonly cell: Position
  readonly face: LookFace
  readonly standing: boolean
  /** The way the sign's text will face. */
  readonly facing: SignFacing
  readonly stand: Position
}

const fail = (reason: string, message: string, detail?: Record<string, unknown>): SkillFailure =>
  detail === undefined ? { reason, message } : { reason, message, detail }

const FACE_NAMES: Readonly<Record<string, LookFace>> = {
  north: 'north',
  south: 'south',
  east: 'east',
  west: 'west',
}

/**
 * Puts a sign up and writes its text. A wall sign hangs on a side face and a standing sign stands on a top face, and
 * both are placed by the same call: what differs is where the bot stands (a standing sign turns to face the bot, so the
 * bot stands on the side the text should face). Since 1.20 the server opens the editor when a sign is placed, so the
 * text is sent right after placing and read back to confirm it took; a sign whose text did not take stays up and the
 * failure says where it is.
 */
export class PlaceSignSkill implements Skill<PlaceSignInput, PlaceSignOutput> {
  readonly name = 'place_sign'

  constructor(private readonly deps: PlaceSignDeps) {}

  async run(input: PlaceSignInput, context: SkillContext): Promise<SkillResult<PlaceSignOutput>> {
    const { deps } = this
    const vitals = deps.vitals.read()
    if (vitals === undefined)
      return err(fail('not_connected', 'Not connected to a Minecraft world.'))
    const bot = vitals.position

    const planned = this.choose(input, bot)
    if (!planned.ok) return err(planned.error)
    const placement = planned.value

    const item = await deps.supplies.ensure(input.wood, context)
    if (item === undefined) {
      if (context.signal.aborted) return err(fail('aborted', 'Cancelled.'))
      return err(
        fail(
          'no_sign_item',
          `The bot has no ${input.wood === undefined ? '' : `${input.wood} `}sign and could not get or craft one (a craft makes 3 from 6 planks and 1 stick).`,
        ),
      )
    }

    const walked = await deps.navigator.goToPosition(placement.stand, placement.standing ? 0 : 1, {
      signal: context.signal,
    })
    if (!walked.ok) {
      if (walked.error.reason === 'aborted') return err(fail('aborted', 'Cancelled.'))
      return err(fail('unreachable', `Could not walk to the spot: ${walked.error.message}`))
    }

    // Sneaking: a click on a chest or a door would use it, and a sign on a chest is the usual request.
    const placed = await deps.placer.placeAgainst(
      item,
      input.reference,
      faceVector(placement.face),
      { sneak: true },
    )
    if (!placed.ok) return err(fail(placed.error.reason, placed.error.message))

    if (!(await this.appears(placement.cell, context.signal)))
      return err(
        fail(
          'not_placed',
          'The sign was not there after placing it; the game may have refused the spot.',
        ),
      )
    const wood = woodOfSign(item)
    deps.registry.note(placement.cell, { lines: input.lines, side: input.side, wood })

    const written = await deps.signs.write(
      placement.cell,
      input.side,
      input.lines,
      false,
      context.signal,
    )
    if (!written.ok)
      return err(
        fail(
          'text_not_written',
          `The sign is up at ${describe(placement.cell)} but its text was not written: ${written.error.message}`,
          { position: placement.cell },
        ),
      )
    if (!(await this.confirmed(placement.cell, input.side, input.lines, context.signal)))
      return err(
        fail(
          'text_not_confirmed',
          `The sign is up at ${describe(placement.cell)} but the server does not show the text on it (yet). Read it with read_signs, and use edit_sign if it is wrong.`,
          { position: placement.cell },
        ),
      )

    const state = deps.signs.stateAt(placement.cell)
    return ok({
      position: placement.cell,
      kind: placement.standing ? 'standing' : 'wall',
      item,
      facing: state?.facing ?? placement.facing,
      side: input.side,
      lines: input.lines,
    })
  }

  /** Checks the target and finds where to stand; without a face, the best free side of the block. */
  private choose(
    input: PlaceSignInput,
    bot: Position,
  ): { ok: true; value: Placement } | { ok: false; error: SkillFailure } {
    if (input.face !== undefined) return this.plan(input, input.face, bot)

    let first: SkillFailure | undefined
    const options: Placement[] = []
    for (const facing of FACINGS) {
      const planned = this.plan(input, FACE_NAMES[facing] ?? 'north', bot)
      if (planned.ok) options.push(planned.value)
      else first ??= planned.error
    }
    // The side the reader (the player, else the bot) is nearest to, so the text can be read from where they stand.
    const reader = input.towards ?? bot
    const best = options.sort(
      (a, b) =>
        distanceBetween(a.cell, reader) - distanceBetween(b.cell, reader) ||
        distanceBetween(a.stand, bot) - distanceBetween(b.stand, bot),
    )[0]
    if (best !== undefined) return { ok: true, value: best }
    return {
      ok: false,
      error: first ?? fail('blocked', 'There is no free side to hang a sign on.'),
    }
  }

  private plan(
    input: PlaceSignInput,
    face: LookFace,
    bot: Position,
  ): { ok: true; value: Placement } | { ok: false; error: SkillFailure } {
    const { blocks, guard } = this.deps
    const refuse = (reason: string, message: string) => ({
      ok: false as const,
      error: fail(reason, message),
    })
    if (face === 'bottom')
      return refuse(
        'bad_face',
        'A sign cannot hang from the underside of a block: use a side or the top.',
      )

    const reference = input.reference
    const referenceName = blocks.blockAt(reference)
    if (referenceName === undefined)
      return refuse(
        'not_loaded',
        `The block at ${describe(reference)} is not loaded, so the bot cannot see it.`,
      )
    if (isFluid(referenceName))
      return refuse('fluid', `${referenceName} is a liquid: a sign cannot be attached to it.`)
    if (face === 'top' && isContainerBlock(referenceName))
      return refuse(
        'not_solid',
        `A standing sign cannot stand on a ${referenceName}. Hang it on a side of it instead (leave face out).`,
      )
    if (blocks.isSolid(reference) !== true)
      return refuse('not_solid', `${referenceName} is not a solid block a sign can be attached to.`)

    const cell = offset(reference, faceVector(face))
    const cellName = blocks.blockAt(cell)
    if (cellName === undefined)
      return refuse(
        'not_loaded',
        `The cell at ${describe(cell)} is not loaded, so the bot cannot see it.`,
      )
    if (isFluid(cellName))
      return refuse(
        'fluid',
        `The cell at ${describe(cell)} holds ${cellName}: no sign goes in water or lava.`,
      )
    if (!isAir(cellName))
      return refuse(
        'blocked',
        `The cell at ${describe(cell)} is taken by ${cellName}; a sign is one block and needs a free cell.`,
      )
    const guarded = guard.protectedAt(cell) ?? guard.protectedAt(reference)
    if (guarded !== undefined)
      return refuse(
        'protected_area',
        `That place is inside the protected area "${guarded.label}", so the bot does not put a sign there.`,
      )

    const standing = face === 'top'
    const facing: SignFacing = standing
      ? (input.facing ?? facingTowards(cell, input.towards ?? bot))
      : face
    const stand = this.standingSpot(cell, facing, standing)
    if (stand === undefined)
      return refuse(
        'no_stand',
        `There is no free, solid, dry spot in front of ${describe(cell)} to stand on while placing the sign (farmland is never trampled).`,
      )
    return { ok: true, value: { cell, face, standing, facing, stand } }
  }

  /**
   * Where the bot stands. A standing sign turns to face the player who places it, so the bot stands on the side the text
   * should face (exactly on the line through the cell); a wall sign takes its direction from the wall, so any free spot
   * in front will do.
   */
  private standingSpot(
    cell: Position,
    facing: SignFacing,
    standing: boolean,
  ): Position | undefined {
    const direction = vectorOf(facing)
    const spots: Position[] = []
    for (const distance of standing ? [2, 1] : [1, 2])
      for (const dy of [0, -1]) {
        const along = offset(cell, direction, distance)
        spots.push({ x: along.x, y: along.y + dy, z: along.z })
      }
    return spots.find((spot) => this.canStand(spot))
  }

  private canStand(spot: Position): boolean {
    const { blocks } = this.deps
    const feet = blocks.blockAt(spot)
    const head = blocks.blockAt(offset(spot, UP))
    const ground = blocks.blockAt(offset(spot, DOWN))
    return (
      feet !== undefined &&
      head !== undefined &&
      blocks.isSolid(spot) === false &&
      blocks.isSolid(offset(spot, UP)) === false &&
      !isFluid(feet) &&
      !isFluid(head) &&
      blocks.isSolid(offset(spot, DOWN)) === true &&
      !isBadGround(ground)
    )
  }

  private async appears(cell: Position, signal: AbortSignal): Promise<boolean> {
    for (let attempt = 0; attempt < CONFIRM_TRIES; attempt += 1) {
      if (isSignBlock(this.deps.blocks.blockAt(cell) ?? '')) return true
      await sleep(this.deps.scheduler, CONFIRM_MS, signal)
    }
    return false
  }

  private async confirmed(
    cell: Position,
    side: SignSide,
    lines: readonly string[],
    signal: AbortSignal,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < CONFIRM_TRIES; attempt += 1) {
      const state = this.deps.signs.stateAt(cell)
      if (state !== undefined && sameSignText(side === 'front' ? state.front : state.back, lines))
        return true
      await sleep(this.deps.scheduler, CONFIRM_MS, signal)
    }
    return false
  }
}

const describe = (position: Position): string =>
  `(${String(position.x)}, ${String(position.y)}, ${String(position.z)})`
