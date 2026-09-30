import type { BlockInfo } from '../../core/block-scanner.port.js'
import type { StructureKind } from '../../core/structure-kinds.js'
import type {
  DetectContext,
  StructureHit,
  StructureSignature,
} from './structure-signature.types.js'

/** Enough to count evidence without pulling in every block of a big area. */
const SAMPLE = 16

const blocksOf = (context: DetectContext, names: readonly string[], count = SAMPLE) =>
  context.blocks.findBlocks({ names, maxDistance: context.radius, count })

const entitiesNamed = (context: DetectContext, name: string) =>
  context.entities.nearby(context.radius).filter((entity) => entity.name === name)

const hit = (kind: StructureKind, at: BlockInfo['position'], detail: string): StructureHit => ({
  kind,
  position: { x: at.x, y: at.y, z: at.z },
  detail,
})

const DOORS = [
  'oak_door',
  'spruce_door',
  'birch_door',
  'jungle_door',
  'acacia_door',
  'dark_oak_door',
]

/**
 * A bell with villagers or road and hay around it, or villagers with two more signs of houses. A lone bell or a
 * villager trading hall a player built does not count: it takes the layout of a village.
 */
export class VillageSignature implements StructureSignature {
  readonly kind = 'village'

  detect(context: DetectContext): StructureHit | null {
    const bell = blocksOf(context, ['bell'], 1)[0]
    const villagers = entitiesNamed(context, 'villager')
    const paths = blocksOf(context, ['dirt_path']).length
    const hay = blocksOf(context, ['hay_block']).length
    const doors = blocksOf(context, DOORS).length
    const evidence = `${String(villagers.length)} villagers, ${String(paths)} path blocks, ${String(hay)} hay bales`

    if (bell !== undefined && (villagers.length >= 1 || paths >= 3 || hay >= 1))
      return hit(this.kind, bell.position, `a bell with ${evidence}`)
    const villager = villagers[0]
    if (villager !== undefined && villagers.length >= 2 && (paths >= 3 || hay >= 1 || doors >= 2))
      return hit(this.kind, villager.position, `${evidence}, ${String(doors)} doors`)
    return null
  }
}

/** Chiseled sandstone with the hidden TNT chamber, or with the temple's orange and blue floor. */
export class DesertTempleSignature implements StructureSignature {
  readonly kind = 'desert_temple'

  detect(context: DetectContext): StructureHit | null {
    const chiseled = blocksOf(context, ['chiseled_sandstone'], 1)[0]
    if (chiseled === undefined) return null
    if (blocksOf(context, ['tnt'], 1).length > 0)
      return hit(this.kind, chiseled.position, 'chiseled sandstone above a TNT chamber')
    if (
      blocksOf(context, ['orange_terracotta'], 1).length > 0 &&
      blocksOf(context, ['blue_terracotta'], 1).length > 0
    )
      return hit(this.kind, chiseled.position, 'chiseled sandstone with orange and blue terracotta')
    return null
  }
}

/** A cluster of mossy cobblestone with the temple's tripwire, dispenser, or piston trap. */
export class JungleTempleSignature implements StructureSignature {
  readonly kind = 'jungle_temple'

  detect(context: DetectContext): StructureHit | null {
    const moss = blocksOf(context, ['mossy_cobblestone'])
    const nearest = moss[0]
    if (nearest === undefined || moss.length < 8) return null
    const trap = blocksOf(context, ['tripwire_hook', 'dispenser', 'sticky_piston'], 1)[0]
    return trap === undefined
      ? null
      : hit(this.kind, nearest.position, `mossy cobblestone with a ${trap.name.replace('_', ' ')}`)
  }
}

/** Pillagers around the dark oak towers. */
export class PillagerOutpostSignature implements StructureSignature {
  readonly kind = 'pillager_outpost'

  detect(context: DetectContext): StructureHit | null {
    const pillager = entitiesNamed(context, 'pillager')[0]
    if (pillager === undefined) return null
    const logs = blocksOf(context, ['dark_oak_log'])
    const tower = logs[0]
    return tower === undefined || logs.length < 4
      ? null
      : hit(this.kind, tower.position, 'pillagers by dark oak towers')
  }
}

/** Fences and planks, with cobwebs, rails, or a chest minecart. */
export class MineshaftSignature implements StructureSignature {
  readonly kind = 'mineshaft'

  detect(context: DetectContext): StructureHit | null {
    const fences = blocksOf(context, ['oak_fence'])
    const fence = fences[0]
    if (fence === undefined || fences.length < 2) return null
    if (blocksOf(context, ['oak_planks'], 3).length < 3) return null
    const webs = blocksOf(context, ['cobweb'], 1).length
    const rails = blocksOf(context, ['rail'], 2).length
    const cart = entitiesNamed(context, 'chest_minecart').length
    return webs > 0 || rails >= 2 || cart > 0
      ? hit(
          this.kind,
          fence.position,
          'oak fences and planks with cobwebs, rails, or a chest minecart',
        )
      : null
  }
}

/** Crying obsidian only generates in ruined portals; netherrack, magma, or gold around it confirms it. */
export class RuinedPortalSignature implements StructureSignature {
  readonly kind = 'ruined_portal'

  detect(context: DetectContext): StructureHit | null {
    const crying = blocksOf(context, ['crying_obsidian'], 1)[0]
    if (crying === undefined) return null
    if (blocksOf(context, ['nether_portal'], 1).length > 0) return null
    return blocksOf(context, ['netherrack', 'magma_block', 'gold_block'], 1).length > 0
      ? hit(this.kind, crying.position, 'crying obsidian among netherrack and magma')
      : null
  }
}

/** A monster spawner in a room of mossy cobblestone. */
export class DungeonSignature implements StructureSignature {
  readonly kind = 'dungeon'

  detect(context: DetectContext): StructureHit | null {
    const spawner = blocksOf(context, ['spawner'], 1)[0]
    if (spawner === undefined) return null
    return blocksOf(context, ['mossy_cobblestone'], 4).length >= 4
      ? hit(this.kind, spawner.position, 'a spawner in a mossy cobblestone room')
      : null
  }
}

/** The end portal frame, which nothing else generates. */
export class StrongholdSignature implements StructureSignature {
  readonly kind = 'stronghold'

  detect(context: DetectContext): StructureHit | null {
    const frame = blocksOf(context, ['end_portal_frame'], 1)[0]
    return frame === undefined ? null : hit(this.kind, frame.position, 'an end portal frame')
  }
}

export const defaultSignatures = (): readonly StructureSignature[] => [
  new VillageSignature(),
  new DesertTempleSignature(),
  new JungleTempleSignature(),
  new PillagerOutpostSignature(),
  new MineshaftSignature(),
  new RuinedPortalSignature(),
  new DungeonSignature(),
  new StrongholdSignature(),
]
