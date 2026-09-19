import type { FoodCatalog, FoodInfo } from '../core/food.port.js'
import type { BotHolder } from './bot-like.types.js'

export class MineflayerFoodCatalog implements FoodCatalog {
  constructor(private readonly holder: BotHolder) {}

  info(item: string): FoodInfo | undefined {
    const food = this.holder.current()?.registry.foodsByName[item]
    return food === undefined
      ? undefined
      : { name: item, foodPoints: food.foodPoints, saturation: food.saturation }
  }
}
