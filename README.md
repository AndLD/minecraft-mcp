# Minecraft MCP

An [MCP](https://modelcontextprotocol.io) server that puts a [Mineflayer](https://github.com/PrismarineJS/mineflayer) bot into your Minecraft world, so an AI agent (Claude) can play with you as a co-player: gather, craft, build, explore, and follow your in-game chat instructions.

> Status: **planning**. See [DEVELOPMENT-PLAN.md](DEVELOPMENT-PLAN.md) for the roadmap and [AGENTS.md](AGENTS.md) for architecture and coding rules.

## How it works

```
 You (Minecraft 1.21.1 client, TLauncher)
   │  type in chat: "ClaudeBot, build a house near me"
   ▼
 Your world, opened to LAN ── localhost:<port> ──┐
                                                 ▼
                                     ┌───────────────────────┐
                                     │  Mineflayer bot       │
                                     │  + static reflexes    │  ← eat, flee, avoid lava/drowning
                                     └──────────┬────────────┘
                                                │ ports (interfaces)
                                     ┌──────────▼────────────┐
                                     │  Skills + Task manager│  ← goto, gather, craft, build, explore
                                     └──────────┬────────────┘
                                                │ MCP tools (stdio)
                                                ▼
                                     Claude (Claude Code / Desktop)
                                     loops on `wait_for_chat`, decides what to do,
                                     calls high-level tools
```

Two layers of intelligence:

- **Reflexes (plain code, always on):** eating when hungry, fleeing or fighting nearby threats, escaping lava/fire/water, stopping on the word `stop`. These run inside the bot with no round trip to the AI, because the AI is too slow for real-time reactions.
- **Agent (Claude):** reads your chat, plans, and calls coarse-grained tools such as `collect_block`, `build`, or `explore_for_structure`. The bot executes them autonomously and reports progress.

## Requirements

- Node.js **22+** (Mineflayer 4.x requires it)
- Minecraft Java Edition **1.21.1**, vanilla (installed via TLauncher). No Forge/Fabric/Optifine profile.
- An MCP client, e.g. Claude Code
- Docker (only for running the e2e tests)

## Setup

```bash
npm install
cp .env.example .env      # then edit
npm run build
```

### Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `MC_HOST` | `localhost` | Host of the Minecraft server |
| `MC_PORT` | *(optional)* | Port of the server. When empty, the port is discovered from the LAN world's broadcast (your world announces it every second or so). Set it for a remote server or if multicast is blocked |
| `MC_VERSION` | `1.21.1` | Minecraft protocol version to use |
| `MC_USERNAME` | `ClaudeBot` | The bot's in-game name |
| `MC_AUTH` | `offline` | `offline` or `microsoft` |
| `MC_OWNER` | *(empty)* | Your in-game name. If set, only your chat messages are treated as instructions |
| `MC_AUTO_CONNECT` | `false` | Connect on startup. Otherwise the agent calls the `connect` tool |
| `DATA_DIR` | `./data` | Where per-world state is persisted (`DATA_DIR/<profile>/`: landmarks, structures, chests, rules, task journal, history, notes) |
| `WORLD_PROFILE` | *(empty)* | Fallback world name, used only when the world cannot be identified automatically (the bot normally recognizes your world by itself from its seed, spawn point, and name). The `connect` tool can also take a `profile` |
| `LOW_HEALTH_THRESHOLD` | `8` | Health points (of 20) at or below which the bot flees from any threat |
| `UNCLAIMED_DROP_WAIT_SECONDS` | `60` | Seconds that items thrown for a player may lie unclaimed before the bot takes them back |
| `REFLEXES_ENABLED` | `true` | Survival reflexes run by themselves (auto-eat, fight, flee, avoid lava, surface for air). Turn off only for testing |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` (logs go to stderr) |

The LAN port changes every time you re-open the world. With `MC_PORT` empty the bot finds it by itself; otherwise the `connect` tool accepts `host` and `port` overrides. Either way you do not need to edit `.env` or restart the MCP server each session.

## Playing

1. Start Minecraft 1.21.1, open your world, press `Esc` → **Open to LAN** → optionally enable cheats → **Start LAN World**. The port is printed in chat, but the bot can also discover it automatically.
2. Register the server with your MCP client. In Claude Code the project already contains a `.mcp.json` that runs it from source (no build step): open a session in this folder and approve the `minecraft` server when asked. Or register the built server yourself:
   ```bash
   npm run build
   claude mcp add minecraft -- node /absolute/path/to/minecraft-mcp/dist/index.js
   ```
3. Tell Claude to start playing, e.g. *"Connect to the Minecraft world on port 54321 and follow my in-game instructions."* Claude connects the bot and keeps listening to your chat.
4. Talk to the bot in the in-game chat. Say `stop` at any time to cancel the current task immediately (handled by code, not by the AI).

## Capabilities (target)

| Area | Examples |
|---|---|
| Communication | Listens to in-game chat, replies in chat, reports task progress |
| Movement | Go to coordinates / player / block, follow, come here |
| Perception | Nearby blocks, entities, inventory, health, time, biome |
| Gathering | Collect N blocks of a type (wood, stone, ores) with the right tool, pick up drops; never digs in areas you protect |
| Crafting | Craft items with automatic sub-recipes (logs to planks to sticks to a pickaxe), placing a crafting table when needed; smelt and cook in furnaces with automatic fuel |
| Memory across sessions | Per-world saved state: the bot recognizes your world automatically, remembers landmarks, chests, standing instructions, and notes, offers to resume interrupted tasks, and briefs the agent on connect |
| Hunting and food | Hunt cows, pigs, sheep, chickens; skip pets, named animals, and the last breeding pair; cook the meat; hunt when food runs low if you allow it |
| Drop recovery | After a death the bot tells you where and recovers its items by itself (never entering lava or void without asking); leftover handover drops are collected back; say "skip it" and it leaves them and gives you the coordinates |
| Teleport | "Teleport to me" puts the bot next to you when the server allows commands (cheats on, and the bot made an operator with `/op`); otherwise it explains exactly what to enable |
| Handover | Give you items on request (from the inventory or chests) by dropping them at your feet, or into a chest for large amounts |
| Storage | Remember chests you point at, keep item kinds in designated chests (or any chest), find items across chests, offload and return when the inventory is full |
| Building | Build floors, walls, rooms with a doorway, and solid blocks from blueprints: a material preview first, missing blocks fetched from your chests, grows walls from the ground up, refuses protected areas and lava, and continues where it stopped when run again. Houses with a real door, emergency shelters built around the bot, and any shape you describe layer by layer; it pillars up to reach high walls and roofs and takes its tower down again *(new)* |
| Excavation and mining | Dig pits, shafts, quarries (default: down to 9 above the bedrock), tunnels, branch mines, and staircases: a preview first with the dimensions it understood, torches all the way, a ladder or a stair cut around the pit to climb out, an optional water landing for quarries, ore veins mined, torches and spare pickaxes crafted when they run out, an option to throw junk away, and every tunnel or branch stops one block before lava, water, a cave, or a spawner and tells you where |
| Sleeping | Set the bot's respawn point at a bed, so it wakes up at home after a death, and sleep through the night when the server rules allow it; never uses beds in the Nether or the End *(planned)* |
| Farming | Lay out a watered, fenced, lit crop field or an animal pen, plant and harvest ripe crops with replanting, breed animals up to a herd size (keeping pets and the last breeding pair safe), collect eggs (a tenth kept in a chest, the rest thrown for chicks, unless told otherwise), and plant groves of trees around a spot with room to grow *(planned)* |
| Railways | Lay rail lines on the surface or underground, in a resource-saving or a fast variant, and place a minecart *(planned)* |
| Teleport | Teleport to you on request when the server allows commands *(planned)* |
| World discovery | Wander to find villages, temples, and other structures; explore caves and canyons with torches for ores, spawners, and structures; remember where they are *(planned)* |
| Survival reflexes | Auto-eat; flee from skeletons, creepers, and at low health; fight other hostile mobs; ignore endermen; avoid lava, drowning, and falls |

## Limitations

- The bot can only see chunks loaded around it (bounded by your render distance), so structure discovery works by physically exploring, not by querying the seed. If cheats are on and the bot is opped (`/op ClaudeBot`), an optional accelerator can use `/locate`.
- Only one bot connection at a time.
- The agent needs an open MCP client session to act; it cannot be pushed to. It polls via `wait_for_chat`.
- Building and pathfinding are best-effort. Complex terrain and large builds can fail and are retried or reported.

## Project docs

- [DEVELOPMENT-PLAN.md](DEVELOPMENT-PLAN.md): phased roadmap with acceptance criteria
- [BACKLOG.md](BACKLOG.md): ideas and deferred work that are not in the plan yet (for example voice instructions)
- [AGENTS.md](AGENTS.md): architecture, SOLID rules, testing (Jest), Git Flow, conventions, and the runtime protocol for the agent
