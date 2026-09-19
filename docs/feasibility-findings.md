# Phase 0 spike findings

Environment: Minecraft Java 1.21.1 (TLauncher, vanilla), world opened via "Open to LAN", Mineflayer 4.39.0, Node 22.

## Confirmed

- An offline-mode bot (`auth: 'offline'`, version `1.21.1`) joins the LAN world without any server change. The Paper fallback is **not needed**.
- Chat works both ways: the bot sees the owner's chat (`chat` event) and its own messages appear in game.
- `mineflayer-pathfinder` works: on `come` the bot walked to the player and reported `arrived`.
- No errors, kicks, or disconnects during the session.

## World-identity signals (for the persistent-state feature)

| Signal | Available | Where | Notes |
|---|---|---|---|
| Hashed seed | yes | `login` packet, `worldState.hashedSeed` (two 32-bit ints, here `[1730125407, 170662117]`) | Expected to be stable per world; **still to verify** by re-opening the same world and comparing |
| World name | yes | server status MOTD: `<host player> - <world name>` (here `Andrey_Knight - AI bot test world`) | Renaming the world changes it |
| Spawn point | yes | `spawn_position` packet (here `48, 81, 32`) | Changes only if the world spawn is moved |
| Dimension names | yes | `login` packet `worldNames` | Same for all worlds, not useful alone |
| Server brand / difficulty / view distance | yes | `bot.game` | Not identifying |

## LAN discovery

The world announces itself on UDP multicast `224.0.2.60:4445` as `[MOTD]<player> - <world name>[/MOTD][AD]<port>[/AD]` about every 1.5 s. Listening to it gives the **port and world name automatically**, so `MC_PORT` can become optional (fall back to explicit `MC_PORT` when no broadcast is heard, for example on a remote server or with a firewall blocking multicast).

## Follow-ups for the plan

- Use LAN broadcast auto-discovery in the `connect` tool (optional port).
- World fingerprint = hashed seed + world name + spawn point; verify stability across re-opening the world during the persistent-state feature.
- The spike code in this folder is throwaway and is removed once the scaffold exists.
