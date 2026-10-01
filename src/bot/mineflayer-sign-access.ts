import type { Position } from '../core/position.types.js'
import { err, ok, type Result } from '../core/result.js'
import type { Scheduler } from '../core/scheduler.port.js'
import { sleep } from '../core/sleep.js'
import type { SignAccess, SignFacing, SignFailure, SignSide, SignState } from '../core/sign.port.js'
import type { BlockLike, BotHolder } from './bot-like.types.js'
import { toVec3 } from './vec3.js'

/** How long the server gets to open the editor after the sign was right-clicked. */
const OPEN_POLLS = 15
const OPEN_POLL_MS = 100
const LINES = 4

/** A standing sign turns in 16 steps: 0 faces south, 4 west, 8 north, 12 east. */
const ROTATION_FACING: readonly SignFacing[] = ['south', 'west', 'north', 'east']

const isSignName = (name: string): boolean =>
  /_(wall_)?sign$/.test(name) && !name.includes('hanging')

const facingOf = (properties: Readonly<Record<string, unknown>>): SignFacing | undefined => {
  const facing = properties['facing']
  if (facing === 'north' || facing === 'south' || facing === 'east' || facing === 'west')
    return facing
  const rotation = Number(properties['rotation'])
  if (!Number.isFinite(rotation)) return undefined
  return ROTATION_FACING[Math.round(rotation / 4) % 4]
}

const linesOf = (text: string | undefined): string[] => {
  const lines = (text ?? '').split('\n')
  while (lines.length < LINES) lines.push('')
  return lines.slice(0, LINES)
}

const isWaxed = (block: BlockLike): boolean => {
  const entity = block.blockEntity
  if (typeof entity !== 'object' || entity === null) return false
  const flag = (entity as { is_waxed?: unknown }).is_waxed
  return flag === 1 || flag === true
}

export class MineflayerSignAccess implements SignAccess {
  constructor(
    private readonly holder: BotHolder,
    private readonly scheduler: Scheduler,
  ) {}

  stateAt(position: Position): SignState | undefined {
    const block = this.holder.current()?.blockAt(toVec3(position))
    if (block === null || block === undefined || !isSignName(block.name)) return undefined
    const text = block.getSignText?.() ?? []
    return {
      name: block.name,
      front: linesOf(text[0]),
      back: linesOf(text[1]),
      waxed: isWaxed(block),
      facing: facingOf(block.getProperties?.() ?? {}),
    }
  }

  async write(
    position: Position,
    side: SignSide,
    lines: readonly string[],
    reopen: boolean,
    signal: AbortSignal,
  ): Promise<Result<void, SignFailure>> {
    const bot = this.holder.current()
    if (bot === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })
    const block = bot.blockAt(toVec3(position))
    if (block === null || !isSignName(block.name))
      return err({ reason: 'out_of_reach', message: 'There is no loaded sign at that place.' })

    const editor = { opened: false }
    const onOpen = (): void => {
      editor.opened = true
    }
    bot.on('signOpen', onOpen)
    try {
      if (reopen) {
        await bot.activateBlock(block)
        for (let poll = 0; poll < OPEN_POLLS && !editor.opened; poll += 1)
          await sleep(this.scheduler, OPEN_POLL_MS, signal)
        if (!editor.opened)
          return err({
            reason: 'not_editable',
            message:
              'The server did not open the sign for editing: it is waxed, or the bot is too far from it.',
          })
      }
      bot.updateSign(block, lines.join('\n'), side === 'back')
      return ok(undefined)
    } catch (error) {
      return err({
        reason: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      bot.removeListener('signOpen', onOpen)
    }
  }
}
