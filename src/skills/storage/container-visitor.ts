import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { ContainerAccess, ContainerSession } from '../../core/container.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { SkillContext, SkillResult } from '../../core/skill.types.js'
import {
  isContainerBlock,
  type ContainerEntry,
  type ContainerIndex,
} from '../../state/container-index.js'

/** Chest and barrel windows open from about this close. */
const USE_RANGE = 2.5
const CONTAINER_NAMES = ['chest', 'trapped_chest', 'barrel']

export interface ContainerVisitorDeps {
  readonly blocks: BlockScanner
  readonly navigator: Navigator
  readonly containers: ContainerAccess
  readonly index: ContainerIndex
}

/**
 * Walks to a known container, checks it is still there, opens it, lets the caller work with it, and remembers what
 * it held afterwards. A container that has vanished is forgotten.
 */
export class ContainerVisitor {
  constructor(private readonly deps: ContainerVisitorDeps) {}

  /** Containers standing near a position that the index does not know yet. */
  unknownNear(maxDistance: number): { position: Position; blockName: string }[] {
    const names = [...CONTAINER_NAMES, ...this.shulkerNames()]
    return this.deps.blocks
      .findBlocks({ names, maxDistance, count: 24 })
      .filter((block) => this.deps.index.at(block.position) === undefined)
      .map((block) => ({ position: block.position, blockName: block.name }))
  }

  async visit<T>(
    entry: ContainerEntry,
    context: SkillContext,
    work: (session: ContainerSession, entry: ContainerEntry) => Promise<T>,
  ): Promise<SkillResult<T>> {
    const { navigator, blocks, containers, index } = this.deps
    const walked = await navigator.goToPosition(entry.position, USE_RANGE, {
      signal: context.signal,
    })
    if (!walked.ok)
      return err({
        reason: walked.error.reason === 'aborted' ? 'aborted' : 'unreachable',
        message: `Could not get to ${this.describe(entry)}: ${walked.error.message}`,
      })

    const name = blocks.blockAt(entry.position)
    if (name === undefined || !isContainerBlock(name)) {
      index.remove(entry.id) // it was broken or moved: the memory is wrong
      return err({
        reason: 'container_missing',
        message: `${this.describe(entry)} is gone (there is ${name ?? 'nothing loaded'} at ${this.at(entry.position)}). It was removed from the index.`,
      })
    }

    const opened = await containers.open(entry.position)
    if (!opened.ok)
      return err({
        reason: 'open_failed',
        message: `Could not open ${this.describe(entry)}: ${opened.error}`,
      })
    const session = opened.value
    try {
      const first = session.contents()
      index.recordContents(entry.id, first.stacks, first)
      const result = await work(session, entry)
      const last = session.contents()
      index.recordContents(entry.id, last.stacks, last)
      return ok(result)
    } catch (error) {
      return err({
        reason: 'container_failed',
        message: `Working with ${this.describe(entry)} failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    } finally {
      await session.close().catch(() => undefined)
    }
  }

  describe(entry: ContainerEntry): string {
    return entry.label === null
      ? `${entry.id} (${entry.blockName} at ${this.at(entry.position)})`
      : `"${entry.label}" (${entry.blockName} at ${this.at(entry.position)})`
  }

  private at(position: Position): string {
    return `${String(position.x)}, ${String(position.y)}, ${String(position.z)}`
  }

  private shulkerNames(): string[] {
    return this.deps.blocks.knownBlockNames().filter((name) => name.endsWith('shulker_box'))
  }
}
