import type { BlockScanner } from '../../../core/block-scanner.port.js'
import type { Position } from '../../../core/position.types.js'
import { matchName, normalizeName } from '../name-match.js'

/** What a cave search reports when nothing is named: the ores worth a trip, in the stone and deepslate kinds. */
export const VALUABLE_BLOCKS = [
  'diamond_ore',
  'deepslate_diamond_ore',
  'gold_ore',
  'deepslate_gold_ore',
  'redstone_ore',
  'deepslate_redstone_ore',
  'lapis_ore',
  'deepslate_lapis_ore',
  'emerald_ore',
  'deepslate_emerald_ore',
  'ancient_debris',
] as const

export type FindKind = 'ore' | 'spawner' | 'geode'

export type FindWish =
  | { readonly ok: true; readonly blocks: readonly string[]; readonly label: string }
  | { readonly ok: false; readonly message: string }

/** Turns `find` (block names, `ores`, or nothing) into the block names to look for. */
export function resolveFind(
  names: readonly string[] | undefined,
  known: readonly string[],
): FindWish {
  if (names === undefined || names.length === 0) {
    const blocks = VALUABLE_BLOCKS.filter((name) => known.includes(name))
    return { ok: true, blocks, label: 'the valuable ores' }
  }
  const blocks = new Set<string>()
  for (const raw of names) {
    const name = normalizeName(raw)
    if (name === 'ores') {
      for (const block of known)
        if (block.endsWith('_ore') || block === 'ancient_debris') blocks.add(block)
      continue
    }
    if (name === 'valuables') {
      for (const block of VALUABLE_BLOCKS) if (known.includes(block)) blocks.add(block)
      continue
    }
    const matched = matchName(name, known)
    if (!matched.ok)
      return {
        ok: false,
        message: `The game has no block called "${raw}".${matched.suggestions.length === 0 ? '' : ` Did you mean: ${matched.suggestions.join(', ')}?`}`,
      }
    for (const block of matched.names) {
      blocks.add(block)
      // Below y 0 the same ore is generated in deepslate, under another name.
      const deep = `deepslate_${block}`
      if (block.endsWith('_ore') && known.includes(deep)) blocks.add(deep)
    }
  }
  return { ok: true, blocks: [...blocks], label: names.join(', ') }
}

export interface SeenFind {
  readonly kind: FindKind
  readonly name: string
  /** The block of the vein nearest to the bot. */
  readonly position: Position
  /** How many blocks of the vein are in view. */
  readonly count: number
  /** Every block of the vein that was seen. */
  readonly cells: readonly Position[]
}

const OPEN_FACES = new Set(['air', 'cave_air', 'water', 'lava'])
const NEIGHBOURS = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
]

const near = (a: Position, b: Position): boolean =>
  Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.z - b.z) <= 1

/**
 * Finds what is worth reporting in the caves around the bot: the named blocks, spawners, and geodes. Only blocks with an
 * open face count, because a player sees an ore in a cave wall but not one buried in solid rock.
 */
export class FindDetector {
  constructor(private readonly blocks: BlockScanner) {}

  private exposed(at: Position): boolean {
    return NEIGHBOURS.some((offset) => {
      const name = this.blocks.blockAt({
        x: at.x + offset.x,
        y: at.y + offset.y,
        z: at.z + offset.z,
      })
      return name !== undefined && OPEN_FACES.has(name)
    })
  }

  detect(radius: number, wanted: readonly string[]): readonly SeenFind[] {
    const found: SeenFind[] = []
    const named = wanted.length === 0 ? [] : this.group(wanted, radius, 'ore')
    found.push(...named, ...this.group(['spawner'], radius, 'spawner'))
    found.push(...this.group(['budding_amethyst'], radius, 'geode'))
    return found
  }

  private group(names: readonly string[], radius: number, kind: FindKind): SeenFind[] {
    const hits = this.blocks
      .findBlocks({ names, maxDistance: radius, count: 64 })
      .filter((block) => this.exposed(block.position))
    const veins: { name: string; cells: Position[] }[] = []
    for (const hit of hits) {
      const vein = veins.find(
        (candidate) =>
          candidate.name === hit.name && candidate.cells.some((cell) => near(cell, hit.position)),
      )
      if (vein === undefined) veins.push({ name: hit.name, cells: [hit.position] })
      else vein.cells.push(hit.position)
    }
    return veins.map((vein) => ({
      kind,
      name: vein.name,
      position: vein.cells[0] ?? { x: 0, y: 0, z: 0 },
      count: vein.cells.length,
      cells: vein.cells,
    }))
  }
}
