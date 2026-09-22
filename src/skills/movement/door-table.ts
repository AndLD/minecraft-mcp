/** What a door-like block is, from its name alone. Iron ones need a switch (a later phase); not handled here. */
export type DoorKind = 'door' | 'gate' | 'trapdoor' | 'iron'

const IRON = new Set(['iron_door', 'iron_trapdoor'])

/** Classifies a block name as a door, fence gate, or trapdoor, wooden or iron; undefined for anything else. */
export function classifyDoor(name: string): DoorKind | undefined {
  if (IRON.has(name)) return 'iron'
  if (name.endsWith('_door')) return 'door'
  if (name.endsWith('_fence_gate')) return 'gate'
  if (name.endsWith('_trapdoor')) return 'trapdoor'
  return undefined
}

/** A wooden door, fence gate, or trapdoor: openable by hand (a right click), unlike an iron one. */
export function isOpenableByHand(name: string): boolean {
  const kind = classifyDoor(name)
  return kind !== undefined && kind !== 'iron'
}
