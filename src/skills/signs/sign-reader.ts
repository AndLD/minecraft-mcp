import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Position } from '../../core/position.types.js'
import type { SignAccess, SignFacing } from '../../core/sign.port.js'
import type { SignRegistry } from '../../state/sign-registry.js'
import { isSignBlock, isWallSign, woodOfSign } from './sign-table.js'
import { joinSignText } from './sign-text.js'

export interface SignView {
  readonly position: Position
  readonly kind: 'wall' | 'standing'
  readonly wood: string
  /** The non-blank lines of each side. */
  readonly front: readonly string[]
  readonly back: readonly string[]
  readonly waxed: boolean
  readonly facing: SignFacing | undefined
  readonly distance: number
  /** True when the bot itself put this sign up (from its own record). */
  readonly placedByBot: boolean
}

const MAX_SIGNS = 60

const nonBlank = (lines: readonly string[]): string[] => {
  const kept = [...lines]
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
  return kept
}

/** Reads the signs in the loaded world around the bot: front and back, nearest first. */
export class SignReader {
  constructor(
    private readonly blocks: BlockScanner,
    private readonly signs: SignAccess,
    private readonly registry: SignRegistry,
  ) {}

  /** Signs within `radius` of the bot; `matching` keeps those whose text (either side) contains it, ignoring case. */
  read(radius: number, matching?: string): readonly SignView[] {
    const names = this.blocks.knownBlockNames().filter(isSignBlock)
    const found = this.blocks.findBlocks({ names, maxDistance: radius, count: MAX_SIGNS })
    const wanted = matching?.trim().toLowerCase()
    const views: SignView[] = []
    for (const block of found) {
      const state = this.signs.stateAt(block.position)
      if (state === undefined) continue
      const view: SignView = {
        position: block.position,
        kind: isWallSign(state.name) ? 'wall' : 'standing',
        wood: woodOfSign(state.name),
        front: nonBlank(state.front),
        back: nonBlank(state.back),
        waxed: state.waxed,
        facing: state.facing,
        distance: Math.round(block.distance * 10) / 10,
        placedByBot: this.registry.at(block.position) !== undefined,
      }
      if (wanted !== undefined && wanted !== '' && !this.mentions(view, wanted)) continue
      views.push(view)
    }
    return views
  }

  /** Whether either side's text contains the (lower-case) words. */
  mentions(view: SignView, wanted: string): boolean {
    return [view.front, view.back].some((side) => joinSignText(side).toLowerCase().includes(wanted))
  }
}
