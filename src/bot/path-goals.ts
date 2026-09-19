import type { Entity } from 'prismarine-entity'
import pathfinderPlugin from 'mineflayer-pathfinder'
import type { GoalFactory } from './path-driver.js'

/** The pathfinder plugin's real goal objects. */
export const createPathGoals = (): GoalFactory => ({
  near: (x, y, z, range) => new pathfinderPlugin.goals.GoalNear(x, y, z, range),
  followEntity: (entity, range) =>
    new pathfinderPlugin.goals.GoalFollow(entity as unknown as Entity, range),
})
