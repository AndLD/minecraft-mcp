import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { EntityScanner } from '../../core/entity-scanner.port.js'
import type { StructureKind } from '../../core/structure-kinds.js'
import type { StructureHit, StructureSignature } from './structure-signature.types.js'

export const DEFAULT_SCAN_RADIUS = 48

/** Runs every signature over what the bot can see right now. */
export class StructureScanner {
  constructor(
    private readonly blocks: BlockScanner,
    private readonly entities: EntityScanner,
    private readonly signatures: readonly StructureSignature[],
  ) {}

  scan(radius = DEFAULT_SCAN_RADIUS, only?: readonly StructureKind[]): readonly StructureHit[] {
    const context = { blocks: this.blocks, entities: this.entities, radius }
    const hits: StructureHit[] = []
    for (const signature of this.signatures) {
      if (only !== undefined && !only.includes(signature.kind)) continue
      const found = signature.detect(context)
      if (found !== null) hits.push(found)
    }
    return hits
  }
}
