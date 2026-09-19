import { EYE_HEIGHT, REACH } from '../core/reach.js'
import type { DigAssessment, DigFailure, Digger } from '../core/digger.port.js'
import { distanceBetween } from '../core/position.js'
import type { Position } from '../core/position.types.js'
import { err, ok, type Result } from '../core/result.js'
import type { BotHolder, BotLike } from './bot-like.types.js'
import { chooseTool } from './tool-choice.js'
import { toVec3 } from './vec3.js'

const UNBREAKABLE = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'bedrock'])

/** Read through a function: the signal changes while the dig is awaited, which control-flow analysis cannot see. */
const wasAborted = (signal: AbortSignal): boolean => signal.aborted

const fail = (reason: DigFailure['reason'], message: string): Result<never, DigFailure> =>
  err({ reason, message })

export class MineflayerDigger implements Digger {
  constructor(private readonly holder: BotHolder) {}

  assess(position: Position): DigAssessment | undefined {
    const bot = this.holder.current()
    const block = bot?.blockAt(toVec3(position))
    if (bot === undefined || block === undefined || block === null) return undefined

    const data = bot.registry.blocksByName[block.name]
    const diggable = data?.diggable !== false && !UNBREAKABLE.has(block.name)
    const requiredTools = Object.keys(data?.harvestTools ?? {})
      .map((id) => bot.registry.items[Number(id)]?.name)
      .filter((name): name is string => name !== undefined)
    const choice = chooseTool({
      harvestTools: requiredTools,
      material: data?.material,
      carried: bot.inventory.items().map((item) => item.name),
    })
    return {
      blockName: block.name,
      diggable,
      requiredTools,
      canHarvest: choice.canHarvest,
      tool: choice.tool,
    }
  }

  async dig(position: Position, signal: AbortSignal): Promise<Result<void, DigFailure>> {
    const bot = this.holder.current()
    const origin = bot?.entity?.position
    if (bot === undefined || origin === undefined)
      return fail('not_connected', 'Not connected to a Minecraft world.')
    if (signal.aborted) return fail('aborted', 'Cancelled.')

    const assessment = this.assess(position)
    const block = bot.blockAt(toVec3(position))
    if (assessment === undefined || block === null)
      return fail('failed', 'That block is not loaded.')
    if (!assessment.diggable) return fail('not_diggable', `${assessment.blockName} cannot be dug.`)

    const eyes = { x: origin.x, y: origin.y + EYE_HEIGHT, z: origin.z }
    const center = { x: position.x + 0.5, y: position.y + 0.5, z: position.z + 0.5 }
    if (distanceBetween(eyes, center) > REACH)
      return fail('out_of_reach', `${assessment.blockName} is too far away to dig.`)

    const equipped = await this.equipTool(bot, assessment.tool)
    if (equipped !== undefined) return fail('failed', equipped)

    const stop = (): void => {
      bot.stopDigging()
    }
    signal.addEventListener('abort', stop, { once: true })
    try {
      await bot.dig(block)
      return ok(undefined)
    } catch (error) {
      if (wasAborted(signal)) return fail('aborted', 'Cancelled.')
      return fail('failed', error instanceof Error ? error.message : String(error))
    } finally {
      signal.removeEventListener('abort', stop)
    }
  }

  /** Returns an error message, or undefined when the tool is in hand (or none is needed). */
  private async equipTool(bot: BotLike, tool: string | undefined): Promise<string | undefined> {
    const id = tool === undefined ? undefined : bot.registry.itemsByName[tool]?.id
    if (id === undefined || bot.heldItem?.name === tool) return undefined
    try {
      await bot.equip(id, 'hand')
      return undefined
    } catch (error) {
      return `Could not take the ${tool ?? 'tool'} in hand: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}
