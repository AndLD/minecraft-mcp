# Sleeping and respawn point

**Depends on:** [Survival reflexes](survival-reflexes.md), [Tasks](../core/tasks.md), [Persistent state](../core/persistent-state.md), [Drop recovery](../storage/drop-recovery.md) (optional), [Server commands and teleporting](../world/server-commands-and-teleporting.md) (optional).  
**Used by:** no other feature directly.

Branch `feature/sleeping`. A bed sets the bot's respawn point (after a death it wakes up at home, which makes [drop recovery](../storage/drop-recovery.md) quicker and safer) and skips the night when the server rules allow it. Nothing here ever forces the player to sleep or moves them.

## Rules the game imposes, which the feature respects and explains

- A bed lets a player sleep only at night (about 12,541 to 23,458 ticks) or in a thunderstorm; by day using one only sets the respawn point ("Respawn point set" in chat). `isNight` in `bed-table.ts` holds those bounds.
- **In multiplayer the night is skipped only when enough players sleep** (`playersSleepingPercentage`, default 100%, and only with `doDaylightCycle` on). `sleep` stays in bed up to `stay_seconds` (default 40, max 600) and reports `nightSkipped` true or false; on false the agent tells the player that somebody awake keeps the night going. Lowering the percentage is a server command and only on the player's request.
- The game refuses sleep with hostile mobs within about 8 blocks sideways and 5 up or down (`MONSTER_RANGE`). The skill checks visible hostile mobs first and fails `monsters_nearby` before walking; the game's own refusal (action bar) is mapped to the same reason by `classifySleepFailure`.
- **A bed explodes in the Nether and the End.** All three skills refuse there with `wrong_dimension` before doing anything (`bedsExplode`), and the night responder never acts there. This is a hard guard, not a setting; it is covered by unit and integration tests only (the e2e server has no Nether).

## Ports and adapters

- `Sleeper` (`src/core/sleeper.port.ts`, `MineflayerSleeper`): `isSleeping`, `sleep(bed)`, `wake`. Mineflayer's `bot.sleep` throws when the game refuses; sleeping refusals such as monsters arrive on the **action bar**, not as errors, so the adapter listens to `messagestr` and the new `actionBar` event while it tries and classifies error text plus lines together (`sleep-failure.ts`): `not_night`, `monsters_nearby`, `too_far`, `occupied`, `obstructed`, `not_a_bed`, `failed`.
- `BedAccess` (`src/core/bed.port.ts`, `MineflayerBedAccess`): a bed's blockstate (`part`, `occupied`) and `use(position)`, which right-clicks and returns the chat and action-bar lines that arrive within 1.2 s. "Respawn point set" is how the game confirms a respawn point.
- `BotLike` gained `isSleeping`, `sleep`, `wake`, and the `actionBar` event; `FakeBot` simulates them (`sleepRefusal`, `bedRefusesRespawn`, `bedsUsed`).

## State

- `BedRegistry` (`src/state/bed-registry.ts`, per world, `ProfileScoped`): known beds with colour, `respawn` (one at a time), `setAt`, `intact`, `seenAt`. The two halves of a bed (one cell apart on one level) are one entry. `markLost` is called when the bot did not respawn at the bed; `BedFinder` removes remembered beds whose block is gone (an unloaded place says nothing, so the bed is kept).
- `SleepPolicy` (`src/state/sleep-policy.ts`): `ask` (default), `when_idle`, `never`; `set_sleep_policy` mirrors a non-default choice into the standing instruction `sleep_policy` for the briefing.

## Skills (`src/skills/sleeping/`)

- **`SleepSkill`** (`sleep`): dimension guard, nearest known or visible bed (or the one given), monster check, walk to within 2, lie down, mark the bed as the respawn point, then poll once a second until the bot is out of bed, the stay runs out, or the task is cancelled. It **always gets up** (also on cancel). The server sends the new time only about once a second, so after waking it looks at the time up to 8 times (250 ms) before deciding the night was not skipped (found by the e2e test: the first look still read night). Result: `nightSkipped`, `wokeEarly` (woken by a threat or damage before morning), `sleptSeconds`, and a message that says what else the night needs.
- **`SetRespawnPointSkill`** (`set_respawn_point`): right-clicks the bed by day or night (at night the click lies the bot down, so it gets up again) and records it only when the game says "Respawn point set"; otherwise `not_confirmed` with what the server said.
- **`PlaceBedSkill`** (`place_bed`): a bed is two blocks and lies in the direction the bot faces, so a single-cell `Placer.placeAt` is not enough. `findBedSpot` looks within 6 blocks (or at the given foot cell) for two free cells in a row with solid ground, free air above, outside protected areas, and a free cell behind the foot to stand on; the bot walks **exactly** onto that cell (within 0: found by the e2e test, a bot left inside the bed's cells makes the server refuse the placement), looks along the bed, and places against the ground under the foot. The bed is confirmed by reading the block, then remembered. It does not craft or fetch a bed (`craft` white_bed: three wool and three planks).
- **`NightResponder`** + **`NightWatch`** (no tool; the watch runs every 5 s while connected): `ask` emits one `needs_decision` event per night, only when a bed is known; `when_idle` starts `sleep` through the tool registry (no agent round trip) when no task, reflex, or hostile mob is around, once per night when it started, retried after 90 s when it did not; `never` does nothing.

## Reflexes and death

- `ReflexEngine` takes an optional `sleeper` and **wakes the bot before any reflex that moves it acts** (`preemptsTask`), so a sleeping bot can still flee or fight; a hit wakes it anyway.
- `DeathResponder` checks after the respawn where the bot is: when it is not within 16 blocks of its respawn bed (the game silently uses the world spawn when the bed was destroyed or obstructed), it marks the bed lost and emits `respawn_point_lost`, so the agent tells the player and can place a new bed.

## Tools

`sleep`, `set_respawn_point`, `place_bed` (tasks, launched through the `TaskLauncher`), `list_beds` (read-only), `set_sleep_policy`.

## Not built

A night shelter when far from a bed (backlog), a bed inside the `house`/`shelter` blueprints, clearing monsters or lighting the area before sleeping (the skill only refuses and says so), and changing `playersSleepingPercentage` or the time.

## Tests

- unit: `classifySleepFailure`, `MineflayerSleeper`, `MineflayerBedAccess`, `BedRegistry`, `SleepPolicy`, bed table (night bounds, dimensions), `BedFinder`, `findBedSpot`, `SleepSkill` (skipped, not skipped, woken early, lagging time, every refusal, monsters, dimension, cancel), `SetRespawnPointSkill`, `PlaceBedSkill`, `NightResponder`, `NightWatch`, `ReflexEngine` waking, `DeathResponder` respawn check, the five tools.
- integration (`test/integration/sleeping-flow.test.ts`): sleeping through the night, not skipped, by-day refusal and confirmation, placing a bed, the Nether guard, the policy in the briefing, the night prompt, and going to bed by itself.
- e2e (`test/e2e/sleeping/sleeping.e2e.test.ts`, real Paper): a bed placed as two blocks; the respawn point set by day (the server's `SpawnX` checked); a night skipped with `playersSleepingPercentage` 0; not skipped with the owner awake; a refusal by day; a refusal with a zombie beside the bed; waking up at the bed after a death, then noticing a destroyed bed.

## Exit criteria

"Set your spawn at this bed" makes the bot respawn there after a death; at night "go to sleep" puts the bot to bed and it says exactly what else the night needs; it never uses a bed in the Nether or the End.

[Back to the features index](../FEATURES.md)
