import mineflayer from 'mineflayer'
import pathfinderPlugin from 'mineflayer-pathfinder'
import type { ConnectTarget } from '../core/connection.port.js'
import type { BotFactory, BotLike } from './bot-like.types.js'
import { commandNamesFrom } from './command-tree.js'
import { formatHashedSeed } from './hashed-seed.js'
import { installContainerWindows } from './install-container-windows.js'
import { installWindowCrafter } from './install-window-crafter.js'

type EventMethods = 'on' | 'once' | 'removeListener'
/** Takes entities from `bot.entities`, which are always real ones; TypeScript cannot relate our narrow entity type to Mineflayer's. */
/** `world.raycast` exists at runtime but is missing from Mineflayer's typings. */
type LooselyTyped = EventMethods | 'attack' | 'openContainerWindow' | 'inventoryWindow' | 'world'

/** The only place that creates a real Mineflayer bot. */
export const createMineflayerBot: BotFactory = (target: ConnectTarget): BotLike => {
  const bot = mineflayer.createBot({
    host: target.host,
    port: target.port,
    username: target.username,
    version: target.version,
    auth: target.auth,
  })
  bot.loadPlugin(pathfinderPlugin.pathfinder)
  // Mineflayer does not expose the hashed world seed, which identifies the world across sessions.
  bot._client.on(
    'login',
    (packet: { worldState?: { hashedSeed?: unknown }; hashedSeed?: unknown }) => {
      const worldSeed = formatHashedSeed(packet.worldState?.hashedSeed ?? packet.hashedSeed)
      if (worldSeed !== undefined) Object.assign(bot, { worldSeed })
    },
  )
  // The server lists the commands this player may use, and sends the list again when operator rights change.
  bot._client.on('declare_commands', (packet: unknown) => {
    const commandNames = commandNamesFrom(packet)
    if (commandNames !== undefined) Object.assign(bot, { commandNames })
  })
  // Mineflayer announces a death but leaves the entity as it was until it is removed a moment later.
  bot.on('entityDead', (entity) => {
    Object.assign(entity, { isDead: true })
  })
  bot.once('spawn', () => {
    // Safe movement profile: never dig or build to reach a goal (that could break player builds).
    // The pathfinder already avoids lava, fire, and deep drops.
    const movements = new pathfinderPlugin.Movements(bot)
    movements.canDig = false
    movements.allow1by1towers = false
    // Caves are full of edges: never plan a fall longer than 3 blocks (the pathfinder's own default is 4, which hurts).
    movements.maxDropDown = 3
    movements.scafoldingBlocks = []
    // The plugin's own door option (canOpenDoors) was spiked and dropped: in a Docker e2e test it never
    // found a path through a closed door at all (4/4 runs, "no_path"), matching its own source comment
    // ("Causes issues. Probably due to none paper servers."). Doors are handled in NavigationRunner instead.
    bot.pathfinder.setMovements(movements)
    // Only now: Mineflayer's own crafting is injected as the bot joins and would overwrite ours.
    installWindowCrafter(bot)
    installContainerWindows(bot)
  })

  // Compile-time guard: every member except the event methods must match exactly.
  const _members: Omit<BotLike, LooselyTyped> = bot
  // The event methods are generic over Mineflayer's much larger event map, which TypeScript cannot
  // relate to our narrow one. At runtime they behave identically for the events we subscribe to.
  return bot as unknown as BotLike
}
