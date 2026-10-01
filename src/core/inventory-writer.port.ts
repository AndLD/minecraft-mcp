/** Changes to what the bot carries: throwing items on the ground. */
export interface InventoryWriter {
  /**
   * Throws up to `count` of the item out in front of the bot. Returns how many really left the inventory
   * (fewer when the bot carries fewer, or when the server ignored a click).
   */
  toss(item: string, count: number): Promise<number>
}
