# Phase 21: Signs

_Estimate: ½ session._

Place a sign with text where the player says, and take one down again. Signs are how a player labels a chest, marks a farm, or names a room, and the bot only ever labels things in its own memory (`label_container`, `set_landmark`) with nothing visible in the world.

- Branch: `feature/signs`. Standing-sign and wall-sign placement is a client of `Placer.placeAgainst`; the target uses the `LookTarget` port with the hit face added in Phase 16 (dug rooms).
- **Tools:**
  - `place_sign`: `text` (a string that is wrapped into lines, or `lines` with up to 4) and a target: **the block the player is looking at** (the default, on the face they look at), or `at` and `face`, or `beside` a registered container by its label (the sign goes on a free side of the chest with the label as the default text). Options: `wood` (default: the sign type the bot carries, else oak), `side` (`front`, `back`), and `facing` for a standing sign (default: towards the player).
  - `edit_sign`: replace the text of a sign that is not waxed (target as above); a waxed sign is refused with the reason.
  - `remove_sign`: take down the sign the player looks at, or at `at`, or the one whose text matches within a radius; the sign is broken and picked up. It never removes a sign that was not named: there is no "remove all signs".
  - `read_signs`: the text of the signs within a radius (front and back), nearest first, so the agent can read what players wrote.
- **Rules.**
  - **Text:** up to 4 lines of 15 characters, checked at the boundary (`text_too_long` says how to split it); no colour or glow in this phase.
  - **Placement:** a wall sign on a horizontal face, a standing sign on the top face of a block (rotation from `facing`); the reference block must be solid, and never in water or lava, in a protected area, or over a spot where the bot would trample farmland. A sign is one block: `blocked` when the cell is taken.
  - **Sign items:** any `*_sign` (oak, spruce, and so on) from the inventory or storage, or crafted from planks and sticks (3 signs per craft, `CraftingSupplies`); hanging signs are left out of this phase.
  - **Editing is a separate step in 1.21:** the server opens the editor when the sign is placed, so the text is sent with the sign-update packet right after placing and read back to confirm it took; a failed write leaves the sign and reports it.
  - **Whose signs:** `SignRegistry` (persisted per world, like the container index) remembers the signs the bot placed (position, text, when). The bot removes or edits its own signs on the player's request; it removes **a player's sign only when the player points at it or names its position** (or a matching text) in that request, never on its own or in bulk, and a protected area's signs are left alone.
- **Tests:**
  - unit: text validation and wrapping (line and length limits, blank lines, an over-long word), sign item choice and crafting, wall versus standing placement from the face, rotation from `facing`, refusals (taken cell, water, lava, protected area, non-solid reference), edit refusals (waxed), removal only of a named target and never in bulk, `SignRegistry`, and `beside` a labelled container
  - integration: `place_sign`, `edit_sign`, `remove_sign`, and `read_signs` through the tool layer on a stateful fake world with a fake look target; text read back; an interrupted craft
  - e2e: a sign placed on a wall and a sign on the ground (blocks and text checked through RCON `data get block`), `edit_sign` changes the text, `remove_sign` removes the sign and the item ends in the inventory, a waxed sign (made over RCON) refuses editing but can be removed on request, a protected area refuses, and `read_signs` returns what the owner bot wrote
- **Exit criteria:** "put a sign 'Iron' on this chest" (looking at the chest) hangs a wall sign with that text; "change it to 'Ores'" edits it; "take that sign down" removes exactly that sign and picks it up; "what do the signs here say?" lists their text.

[Back to the development plan](../DEVELOPMENT-PLAN.md)
