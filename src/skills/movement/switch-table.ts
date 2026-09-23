/** What a switch-like block is, from its name alone. */
export type SwitchKind = 'button' | 'lever' | 'plate'

/** Classifies a block name as a button, lever, or pressure plate; undefined for anything else. */
export function classifySwitch(name: string): SwitchKind | undefined {
  if (name === 'lever') return 'lever'
  if (name.endsWith('_button')) return 'button'
  if (name.endsWith('_pressure_plate')) return 'plate'
  return undefined
}
