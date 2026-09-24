# Phase 20: Sleeping and respawn point

_Estimate: 1 session._

Two reasons to sleep: a bed sets the bot's respawn point (after a death it wakes up at home instead of at the far-away world spawn, which also makes drop recovery quicker and safer), and sleeping skips the night.

- Branch: `feature/sleeping`.
- **Rules the game imposes, which the feature must respect and explain:**
  - A bed only lets you sleep at night (from about 12,540 to 23,460 ticks) or during a thunderstorm; by day, using a bed only sets the respawn point ("Respawn point set", read from the chat line).
  - **In multiplayer the night is skipped only when enough players sleep** (`playersSleepingPercentage`, default 100%): the bot sleeping alone does not skip the night while you are awake, and a second player counts. The result must say so. Lowering the percentage or setting the time are server commands and only happen on your request, when the commands feature makes them available.
  - Sleeping is refused when hostile mobs are near ("monsters nearby": about 8 blocks around, 5 up and down), and the bed is the respawn point only while it exists and is not obstructed; otherwise the game silently falls back to the world spawn.
  - **A bed explodes in the Nether and the End.** The bot never sleeps or sets a respawn point there (`wrong_dimension`, a hard guard, not a setting).
- **`Sleeper` port** (`sleep(bed)`, `wake()`, `isSleeping()`; Mineflayer `sleep`, `wake`, and the `sleep` and `wake` events). Reflexes wake the bot before they act: a sleeping bot cannot flee or fight, so `ThreatResponse` and the others call `wake()` first (with a unit test for it), and a hit wakes it anyway.
- **`BedRegistry`** (persisted per world): known beds and which one is the respawn point (position, colour, when it was set, whether it was seen to be intact). After a death the bot notices when it did not respawn at the bed (destroyed or blocked) and tells the agent so the record is corrected.
- **Skills:**
  - `SleepSkill` (`sleep`): find the nearest known or visible bed (or the one named), check dimension, time or storm, and monsters (with an offer to clear the area or light it), walk there, sleep, and stay until morning or until woken, reporting whether the night was skipped or is still going because another player is awake. Aborting or a threat wakes the bot.
  - `SetRespawnPointSkill` (`set_respawn_point`): use a bed by day or night, and confirm from the "Respawn point set" line; fails typed when it is not confirmed.
  - Beds are made with the existing tools: `craft` a bed (three wool and three planks) and place it. `PlaceBedSkill` puts it down on a free 2-block spot (the bed is two blocks, so it needs the free spot, not a single-cell `Placer` call). The building phase's shelter blueprint can include a bed and torches.
- **`SleepPolicy`** (standing instruction): `ask` (default: at nightfall the agent gets a `needs_decision` event and asks whether to go to bed), `when_idle` (the bot goes to bed by itself at night when no task is running and no threat is near), `never`. Nothing in this feature ever forces you to sleep or teleports you.
- Tools: `sleep`, `set_respawn_point`, `place_bed`, `list_beds`, `set_sleep_policy`.
- Relation to the backlog: "night shelter when far from a bed" (build or dig in) stays a separate item; this feature covers having a bed. The cave exploration feature can use `place_bed` and `set_respawn_point` for camps.
- **Tests:**
  - unit: `SleepSkill` against fakes (time window, storm, monsters near, wrong dimension, no bed, walking to the bed, woken by a threat or an abort, night skipped versus another player awake), `SetRespawnPointSkill` (confirmation line, timeout), `BedRegistry` (persistence, respawn point moves when another bed is used, lost-bed correction), `SleepPolicy`, the reflex waking the bot first, `PlaceBedSkill` (free spot search)
  - integration: `sleep` and `set_respawn_point` through the tool layer on a stateful fake world; a death respawns at the bed, and a destroyed bed is noticed and reported
  - e2e: at night the bot sleeps in a bed and the night is skipped when the server's sleeping percentage lets it; by day the respawn point is set and, after the bot is killed, it wakes up at the bed (position check); a destroyed bed makes it respawn at the spawn and report it; a zombie near the bed makes sleeping fail with the reason; in the Nether-guard case the tool refuses without touching the bed (unit and integration only: the e2e server has no Nether)
- **Exit criteria:** "set your spawn at this bed" makes the bot respawn there after a death; at night "go to sleep" puts the bot to bed, and it tells you exactly what else is needed for the night to pass; it never uses a bed in the Nether or the End.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
