/** Direct body controls, for moments when pathfinding is not the right tool (swimming up, for example). */
export interface Locomotion {
  setJump(active: boolean): void
}
