import type { Position } from '../../core/position.types.js'
import { distanceBetween } from '../../core/position.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { ContainerEntry, ContainerIndex } from '../../state/container-index.js'
import type { ContainerVisitor } from './container-visitor.js'

export interface ScanInput {
  /** Also look for containers nobody registered, within this many blocks, and register them. */
  readonly radius: number
  /** Visit the containers already known (true) or only look for new ones (false). */
  readonly refreshKnown: boolean
}

export interface ScanOutput {
  readonly scanned: number
  readonly discovered: number
  /** Containers that were gone. */
  readonly missing: number
  readonly containers: readonly {
    readonly id: string
    readonly label: string | null
    readonly items: number
    readonly emptySlots: number | null
  }[]
}

export interface ItemScanner {
  run(input: ScanInput, context: SkillContext): Promise<SkillResult<ScanOutput>>
}

export interface ScanContainersDeps {
  readonly vitals: VitalsReader
  readonly index: ContainerIndex
  readonly visitor: ContainerVisitor
}

/** Opens containers to refresh what the index remembers about them, and registers ones it did not know. */
export class ScanContainersSkill implements Skill<ScanInput, ScanOutput>, ItemScanner {
  readonly name = 'scan_containers'

  constructor(private readonly deps: ScanContainersDeps) {}

  async run(input: ScanInput, context: SkillContext): Promise<SkillResult<ScanOutput>> {
    const { deps } = this
    const start = deps.vitals.read()?.position
    if (start === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })

    const queue: ContainerEntry[] = input.refreshKnown ? [...deps.index.all()] : []
    let discovered = 0
    for (const found of deps.visitor.unknownNear(input.radius)) {
      const registered = deps.index.register(found.position, found.blockName, { auto: true })
      if (registered.ok && !queue.some((entry) => entry.id === registered.value.id)) {
        queue.push(registered.value)
        discovered += 1
      }
    }

    let scanned = 0
    let missing = 0
    let here: Position = start
    while (queue.length > 0) {
      if (context.signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })
      queue.sort((a, b) => distanceBetween(here, a.position) - distanceBetween(here, b.position))
      const entry = queue.shift()
      if (entry === undefined) break
      context.progress(
        `Looking into ${deps.visitor.describe(entry)} (${String(queue.length)} more)`,
      )
      const visit = await deps.visitor.visit(entry, context, () => Promise.resolve())
      if (visit.ok) {
        scanned += 1
        here = entry.position
      } else if (visit.error.reason === 'aborted') return err(visit.error)
      else if (visit.error.reason === 'container_missing') missing += 1
    }

    return ok({
      scanned,
      discovered,
      missing,
      containers: deps.index.all().map((entry) => ({
        id: entry.id,
        label: entry.label,
        items: entry.contents.reduce((sum, stack) => sum + stack.count, 0),
        emptySlots: entry.emptySlots,
      })),
    })
  }
}
