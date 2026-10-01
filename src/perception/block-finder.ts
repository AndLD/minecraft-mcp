import type { BlockInfo, BlockQuery, BlockScanner } from '../core/block-scanner.port.js'
import { err, ok, type Result } from '../core/result.js'

const MAX_SUGGESTIONS = 8

/** Finds blocks by name, with helpful errors for names the game does not know. */
export class BlockFinder {
  constructor(private readonly scanner: BlockScanner) {}

  find(query: BlockQuery): Result<readonly BlockInfo[]> {
    const known = new Set(this.scanner.knownBlockNames())
    if (known.size === 0) return err('Not connected to a Minecraft world.')

    const unknown = query.names.filter((name) => !known.has(name))
    if (unknown.length > 0) {
      const hints = unknown.map((name) => {
        const similar = [...known].filter(
          (candidate) => candidate.includes(name) || name.includes(candidate),
        )
        return similar.length === 0
          ? `"${name}" is not a block name`
          : `"${name}" is not a block name; did you mean: ${similar.slice(0, MAX_SUGGESTIONS).join(', ')}?`
      })
      return err(hints.join('. '))
    }
    return ok(this.scanner.findBlocks(query))
  }
}
