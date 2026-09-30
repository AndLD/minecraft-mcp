import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { EntityScanner } from '../../core/entity-scanner.port.js'
import type { Position } from '../../core/position.types.js'
import type { StructureKind } from '../../core/structure-kinds.js'

export interface DetectContext {
  readonly blocks: BlockScanner
  readonly entities: EntityScanner
  /** How far around the bot to look, in blocks. */
  readonly radius: number
}

export interface StructureHit {
  readonly kind: StructureKind
  /** A block that belongs to the structure (the nearest key block), not its centre. */
  readonly position: Position
  /** What gave it away, for the agent to relay. */
  readonly detail: string
}

/** Recognizes one kind of structure from the loaded blocks and entities around the bot. */
export interface StructureSignature {
  readonly kind: StructureKind
  detect(context: DetectContext): StructureHit | null
}
